import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb, withTransaction, createTestUser } from '../setup.js';
import { registerWebhook } from '../../src/tools/webhooks.js';

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

describe('registerWebhook', () => {
  it('creates a webhook with generated secret', () => withTransaction(async (client) => {
    const user = await createTestUser(client);
    const result = await registerWebhook(client, user.id, {
      url: 'https://example.com/webhook',
      events: ['completed', 'handoff'],
    });

    expect(result.webhook.url).toBe('https://example.com/webhook');
    expect(result.webhook.events).toEqual(['completed', 'handoff']);
    expect(result.webhook.owner_id).toBe(user.id);
    expect(result.webhook.active).toBe(true);
    expect(result.secret).toHaveLength(64); // 32 bytes hex
    expect(result.webhook.secret).toBe(result.secret);
  }));

  it('each webhook gets a unique secret', () => withTransaction(async (client) => {
    const user = await createTestUser(client);
    const r1 = await registerWebhook(client, user.id, {
      url: 'https://example.com/a',
      events: ['completed'],
    });
    const r2 = await registerWebhook(client, user.id, {
      url: 'https://example.com/b',
      events: ['completed'],
    });
    expect(r1.secret).not.toBe(r2.secret);
  }));
});
