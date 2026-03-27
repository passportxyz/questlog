import pg from 'pg';
import crypto from 'node:crypto';
import { insertWebhook } from '../db/queries.js';
import type { Webhook } from '../types.js';

export async function registerWebhook(
  client: pg.PoolClient,
  actorId: string,
  input: { url: string; events: string[] },
): Promise<{ webhook: Webhook; secret: string }> {
  // Generate a random HMAC secret
  const secret = crypto.randomBytes(32).toString('hex');

  const webhook = await insertWebhook(client, {
    url: input.url,
    events: input.events,
    secret,
    owner_id: actorId,
  });

  return { webhook, secret };
}
