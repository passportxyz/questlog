import pg from 'pg';
import {
  getUserById,
  getUserByPublicKey,
  insertUser,
  listUsers as listUsersQuery,
} from '../db/queries.js';
import {
  generateNonce,
  consumeNonce,
  verifySignature,
  signToken,
} from '../auth.js';
import type { User, UserType } from '../types.js';

// ── registerUser (unauthenticated) ────────────────────────────────

export interface RegisterUserInput {
  name: string;
  type?: UserType;
  public_key?: string;
}

export async function registerUser(
  client: pg.PoolClient,
  input: RegisterUserInput,
): Promise<{ user: User }> {
  const type = input.type ?? 'agent';

  if (type === 'agent' && !input.public_key) {
    throw new Error('Agents must provide a public_key for authentication');
  }

  if (input.public_key) {
    const existing = await getUserByPublicKey(client, input.public_key);
    if (existing) {
      throw new Error('A user with this public key already exists');
    }
  }

  const user = await insertUser(client, {
    name: input.name,
    type,
    public_key: input.public_key,
  });

  return { user };
}

// ── getUser ───────────────────────────────────────────────────────

export async function getUser(
  client: pg.PoolClient,
  _actorId: string,
  input: { user_id: string },
): Promise<{ user: User }> {
  const user = await getUserById(client, input.user_id);
  if (!user) throw new Error(`User not found: ${input.user_id}`);
  return { user };
}

// ── listUsers ─────────────────────────────────────────────────────

export async function listUsers(
  client: pg.PoolClient,
  _actorId: string,
  input: { type?: UserType },
): Promise<{ users: User[] }> {
  const users = await listUsersQuery(client, input.type ? { type: input.type } : undefined);
  return { users };
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
    const { nonce, expiresAt } = generateNonce(input.user_id);
    return { nonce, expires_at: expiresAt };
  }

  // action === 'verify'
  if (!input.nonce || !input.signature) {
    throw new Error('nonce and signature are required for verify');
  }

  const valid = consumeNonce(input.nonce, input.user_id);
  if (!valid) {
    throw new Error('Invalid or expired nonce');
  }

  const user = await getUserById(client, input.user_id);
  if (!user) {
    throw new Error(`User not found: ${input.user_id}`);
  }

  if (!user.public_key) {
    throw new Error('This user has no public key registered');
  }

  const sigValid = verifySignature(user.public_key, input.nonce, input.signature);
  if (!sigValid) {
    throw new Error('Invalid signature');
  }

  const token = signToken({ sub: user.id, name: user.name });

  const parts = token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
  const expires_at = new Date(payload.exp * 1000);

  return { token, expires_at, user };
}
