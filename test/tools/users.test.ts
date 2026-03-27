import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import {
  setupTestDb,
  teardownTestDb,
  withTransaction,
  createTestUser,
} from '../setup.js';
import {
  registerUser,
  getUser,
  adminPending,
  adminApprove,
  authenticate,
} from '../../src/tools/users.js';

// ── Helpers ────────────────────────────────────────────────────

function generateTestKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);
  const typeBytes = Buffer.from('ssh-ed25519');
  const typeLenBuf = Buffer.alloc(4);
  typeLenBuf.writeUInt32BE(typeBytes.length);
  const keyLenBuf = Buffer.alloc(4);
  keyLenBuf.writeUInt32BE(rawPub.length);
  const blob = Buffer.concat([typeLenBuf, typeBytes, keyLenBuf, rawPub]);
  const sshPubKey = `ssh-ed25519 ${blob.toString('base64')}`;
  return { sshPubKey, privateKey };
}

function signNonce(nonce: string, privateKey: crypto.KeyObject): string {
  return crypto.sign(null, Buffer.from(nonce, 'utf8'), privateKey).toString('base64');
}

// ── Setup ──────────────────────────────────────────────────────

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

// ── registerUser ───────────────────────────────────────────────

describe('registerUser', () => {
  it('creates a pending human', async () => {
    await withTransaction(async (client) => {
      const { sshPubKey } = generateTestKeypair();
      const { user } = await registerUser(client, {
        name: 'Alice',
        type: 'human',
        public_key: sshPubKey,
      });

      expect(user.name).toBe('Alice');
      expect(user.type).toBe('human');
      expect(user.status).toBe('pending');
      expect(user.public_key).toBe(sshPubKey);
      expect(user.is_admin).toBe(false);
      expect(user.id).toBeDefined();
    });
  });

  it('creates an active agent with valid parent', async () => {
    await withTransaction(async (client) => {
      const parent = await createTestUser(client, {
        name: 'ParentHuman',
        type: 'human',
        status: 'active',
      });

      const { sshPubKey } = generateTestKeypair();
      const { user } = await registerUser(client, {
        name: 'AgentBot',
        type: 'agent',
        public_key: sshPubKey,
        parent_id: parent.id,
      });

      expect(user.name).toBe('AgentBot');
      expect(user.type).toBe('agent');
      expect(user.status).toBe('active');
      expect(user.parent_id).toBe(parent.id);
    });
  });

  it('rejects agent without parent_id', async () => {
    await withTransaction(async (client) => {
      const { sshPubKey } = generateTestKeypair();
      await expect(
        registerUser(client, {
          name: 'OrphanAgent',
          type: 'agent',
          public_key: sshPubKey,
        }),
      ).rejects.toThrow('Agents must have a parent_id');
    });
  });

  it('rejects duplicate public_key', async () => {
    await withTransaction(async (client) => {
      const { sshPubKey } = generateTestKeypair();
      await registerUser(client, {
        name: 'First',
        type: 'human',
        public_key: sshPubKey,
      });

      await expect(
        registerUser(client, {
          name: 'Second',
          type: 'human',
          public_key: sshPubKey,
        }),
      ).rejects.toThrow('A user with this public key already exists');
    });
  });
});

// ── getUser ────────────────────────────────────────────────────

describe('getUser', () => {
  it('returns user with agent count', async () => {
    await withTransaction(async (client) => {
      const parent = await createTestUser(client, {
        name: 'Parent',
        type: 'human',
        status: 'active',
      });

      // Create two agents under parent
      await createTestUser(client, {
        name: 'Agent1',
        type: 'agent',
        status: 'active',
        parent_id: parent.id,
      });
      await createTestUser(client, {
        name: 'Agent2',
        type: 'agent',
        status: 'active',
        parent_id: parent.id,
      });

      const result = await getUser(client, parent.id, { user_id: parent.id });
      expect(result.user.id).toBe(parent.id);
      expect(result.agent_count).toBe(2);
    });
  });
});

// ── adminPending ───────────────────────────────────────────────

describe('adminPending', () => {
  it('returns pending users when called by admin', async () => {
    await withTransaction(async (client) => {
      const admin = await createTestUser(client, {
        name: 'Admin',
        is_admin: true,
        status: 'active',
      });

      // Create a pending user
      const { sshPubKey } = generateTestKeypair();
      await registerUser(client, {
        name: 'PendingUser',
        type: 'human',
        public_key: sshPubKey,
      });

      const result = await adminPending(client, admin.id);
      expect(result.users.length).toBeGreaterThanOrEqual(1);
      expect(result.users.some((u) => u.name === 'PendingUser')).toBe(true);
    });
  });

  it('rejects non-admin', async () => {
    await withTransaction(async (client) => {
      const regularUser = await createTestUser(client, {
        name: 'Regular',
        is_admin: false,
        status: 'active',
      });

      await expect(adminPending(client, regularUser.id)).rejects.toThrow(
        'Only admins can view pending users',
      );
    });
  });
});

// ── adminApprove ───────────────────────────────────────────────

describe('adminApprove', () => {
  it('activates a pending user', async () => {
    await withTransaction(async (client) => {
      const admin = await createTestUser(client, {
        name: 'Admin',
        is_admin: true,
        status: 'active',
      });

      const pendingUser = await createTestUser(client, {
        name: 'Pending',
        status: 'pending',
      });

      const result = await adminApprove(client, admin.id, {
        user_id: pendingUser.id,
      });
      expect(result.user.status).toBe('active');
      expect(result.user.id).toBe(pendingUser.id);
    });
  });
});

// ── authenticate ───────────────────────────────────────────────

describe('authenticate', () => {
  it('request_challenge returns nonce', async () => {
    await withTransaction(async (client) => {
      const result = await authenticate(client, {
        user_id: 'any',
        action: 'request_challenge',
      });

      expect('nonce' in result).toBe(true);
      if ('nonce' in result) {
        expect(typeof result.nonce).toBe('string');
        expect(result.expires_at.getTime()).toBeGreaterThan(Date.now());
      }
    });
  });

  it('verify with valid signature returns token', async () => {
    await withTransaction(async (client) => {
      const { sshPubKey, privateKey } = generateTestKeypair();
      const user = await createTestUser(client, {
        name: 'AuthUser',
        status: 'active',
        public_key: sshPubKey,
      });

      // Request challenge
      const challenge = await authenticate(client, {
        user_id: user.id,
        action: 'request_challenge',
      });

      if (!('nonce' in challenge)) throw new Error('Expected nonce');

      // Sign the nonce
      const signature = signNonce(challenge.nonce, privateKey);

      // Verify
      const result = await authenticate(client, {
        user_id: user.id,
        action: 'verify',
        nonce: challenge.nonce,
        signature,
      });

      expect('token' in result).toBe(true);
      if ('token' in result) {
        expect(typeof result.token).toBe('string');
        expect(result.user.id).toBe(user.id);
        expect(result.expires_at.getTime()).toBeGreaterThan(Date.now());
      }
    });
  });

  it('verify rejects invalid signature', async () => {
    await withTransaction(async (client) => {
      const { sshPubKey } = generateTestKeypair();
      const user = await createTestUser(client, {
        name: 'AuthUser2',
        status: 'active',
        public_key: sshPubKey,
      });

      const challenge = await authenticate(client, {
        user_id: user.id,
        action: 'request_challenge',
      });

      if (!('nonce' in challenge)) throw new Error('Expected nonce');

      // Use a different key to sign (wrong signature)
      const { privateKey: wrongKey } = generateTestKeypair();
      const badSignature = signNonce(challenge.nonce, wrongKey);

      await expect(
        authenticate(client, {
          user_id: user.id,
          action: 'verify',
          nonce: challenge.nonce,
          signature: badSignature,
        }),
      ).rejects.toThrow('Invalid signature');
    });
  });

  it('verify rejects pending user', async () => {
    await withTransaction(async (client) => {
      const { sshPubKey, privateKey } = generateTestKeypair();
      const user = await createTestUser(client, {
        name: 'PendingAuth',
        status: 'pending',
        public_key: sshPubKey,
      });

      const challenge = await authenticate(client, {
        user_id: user.id,
        action: 'request_challenge',
      });

      if (!('nonce' in challenge)) throw new Error('Expected nonce');

      const signature = signNonce(challenge.nonce, privateKey);

      await expect(
        authenticate(client, {
          user_id: user.id,
          action: 'verify',
          nonce: challenge.nonce,
          signature,
        }),
      ).rejects.toThrow('User account is pending approval');
    });
  });
});
