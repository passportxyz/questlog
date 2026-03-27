import pg from 'pg';
import {
  getUserById,
  getUserByPublicKey,
  getPendingUsers,
  insertUser,
  updateUserStatus,
} from '../db/queries.js';
import {
  generateNonce,
  consumeNonce,
  verifySignature,
  signToken,
} from '../auth.js';
import type { User } from '../types.js';

// ── registerUser (unauthenticated) ────────────────────────────────

export interface RegisterUserInput {
  name: string;
  type: 'human' | 'agent';
  public_key: string;
  parent_id?: string;
}

export async function registerUser(
  client: pg.PoolClient,
  input: RegisterUserInput,
): Promise<{ user: User }> {
  // public_key must be unique
  const existing = await getUserByPublicKey(client, input.public_key);
  if (existing) {
    throw new Error('A user with this public key already exists');
  }

  if (input.type === 'agent') {
    if (!input.parent_id) {
      throw new Error('Agents must have a parent_id');
    }
    const parent = await getUserById(client, input.parent_id);
    if (!parent) {
      throw new Error(`Parent user not found: ${input.parent_id}`);
    }
    if (parent.status !== 'active') {
      throw new Error(`Parent user is not active: ${input.parent_id}`);
    }
  }

  const status = input.type === 'agent' ? 'active' : 'pending';

  const user = await insertUser(client, {
    name: input.name,
    type: input.type,
    status,
    is_admin: false,
    public_key: input.public_key,
    parent_id: input.parent_id,
  });

  return { user };
}

// ── getUser ───────────────────────────────────────────────────────

export interface GetUserInput {
  user_id: string;
}

export async function getUser(
  client: pg.PoolClient,
  _actorId: string,
  input: GetUserInput,
): Promise<{ user: User; agent_count: number }> {
  const user = await getUserById(client, input.user_id);
  if (!user) throw new Error(`User not found: ${input.user_id}`);

  const { rows } = await client.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM users WHERE parent_id = $1',
    [input.user_id],
  );
  const agent_count = parseInt(rows[0].count, 10);

  return { user, agent_count };
}

// ── adminPending ──────────────────────────────────────────────────

export async function adminPending(
  client: pg.PoolClient,
  actorId: string,
): Promise<{ users: User[] }> {
  const actor = await getUserById(client, actorId);
  if (!actor || !actor.is_admin) {
    throw new Error('Only admins can view pending users');
  }

  const users = await getPendingUsers(client);
  return { users };
}

// ── adminApprove ──────────────────────────────────────────────────

export interface AdminApproveInput {
  user_id: string;
}

export async function adminApprove(
  client: pg.PoolClient,
  actorId: string,
  input: AdminApproveInput,
): Promise<{ user: User }> {
  const actor = await getUserById(client, actorId);
  if (!actor || !actor.is_admin) {
    throw new Error('Only admins can approve users');
  }

  const user = await updateUserStatus(client, input.user_id, 'active');
  return { user };
}

// ── authenticate (unauthenticated) ────────────────────────────────

export interface AuthenticateInput {
  user_id: string;
  action: 'request_challenge' | 'verify';
  nonce?: string;
  signature?: string;
}

export async function authenticate(
  client: pg.PoolClient,
  input: AuthenticateInput,
): Promise<
  | { nonce: string; expires_at: Date }
  | { token: string; expires_at: Date; user: User }
> {
  if (input.action === 'request_challenge') {
    const { nonce, expiresAt } = generateNonce();
    return { nonce, expires_at: expiresAt };
  }

  // action === 'verify'
  if (!input.nonce || !input.signature) {
    throw new Error('nonce and signature are required for verify');
  }

  const valid = consumeNonce(input.nonce);
  if (!valid) {
    throw new Error('Invalid or expired nonce');
  }

  const user = await getUserById(client, input.user_id);
  if (!user) {
    throw new Error(`User not found: ${input.user_id}`);
  }

  if (user.status === 'pending') {
    throw new Error('User account is pending approval');
  }

  const sigValid = verifySignature(user.public_key, input.nonce, input.signature);
  if (!sigValid) {
    throw new Error('Invalid signature');
  }

  const token = signToken({ sub: user.id, name: user.name, type: user.type });

  // Decode token to get expires_at
  const parts = token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
  const expires_at = new Date(payload.exp * 1000);

  return { token, expires_at, user };
}
