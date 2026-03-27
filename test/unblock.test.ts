import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb, withTransaction, createTestUser, createTestTask } from './setup.js';
import { checkUnblocks } from '../src/unblock.js';
import { insertEvent } from '../src/db/queries.js';
import { randomUUID } from 'node:crypto';

beforeAll(() => setupTestDb());
afterAll(() => teardownTestDb());

describe('auto-unblock', () => {
  it('unblocks a task when its dependency completes', () => withTransaction(async (client) => {
    const user = await createTestUser(client);
    const taskA = await createTestTask(client, user.id, { title: 'Task A' });
    const taskB = await createTestTask(client, user.id, { title: 'Task B' });

    // Insert created events for both
    await insertEvent(client, {
      task_id: taskA.id,
      event_type: 'created',
      actor_id: user.id,
      body: 'Task A desc',
      metadata: {},
      idempotency_key: randomUUID(),
    });
    await insertEvent(client, {
      task_id: taskB.id,
      event_type: 'created',
      actor_id: user.id,
      body: 'Task B desc',
      metadata: {},
      idempotency_key: randomUUID(),
    });

    // Block B on A
    await insertEvent(client, {
      task_id: taskB.id,
      event_type: 'blocked',
      actor_id: user.id,
      body: 'Waiting for Task A',
      metadata: { blocked_by_task_id: taskA.id, reason: 'dependency' },
      idempotency_key: randomUUID(),
    });

    // Complete A triggers unblock check
    const sideEffects = await checkUnblocks(client, taskA.id, user.id);

    // Should have generated webhook side effects for the unblock
    expect(sideEffects.some(e => e.type === 'webhook')).toBe(true);

    // Verify unblocked event was inserted
    const { rows } = await client.query(
      `SELECT * FROM events WHERE task_id = $1 AND event_type = 'unblocked'`,
      [taskB.id]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].metadata.resolved_by).toBe(taskA.id);
  }));

  it('does not unblock when other blockers remain', () => withTransaction(async (client) => {
    const user = await createTestUser(client);
    const taskA = await createTestTask(client, user.id, { title: 'Task A' });
    const taskB = await createTestTask(client, user.id, { title: 'Task B' });
    const taskC = await createTestTask(client, user.id, { title: 'Task C' });

    // Block C on both A and B
    await insertEvent(client, {
      task_id: taskC.id,
      event_type: 'created',
      actor_id: user.id,
      body: 'Task C',
      metadata: {},
      idempotency_key: randomUUID(),
    });
    await insertEvent(client, {
      task_id: taskC.id,
      event_type: 'blocked',
      actor_id: user.id,
      body: 'Waiting for A',
      metadata: { blocked_by_task_id: taskA.id, reason: 'dep' },
      idempotency_key: randomUUID(),
    });
    await insertEvent(client, {
      task_id: taskC.id,
      event_type: 'blocked',
      actor_id: user.id,
      body: 'Waiting for B',
      metadata: { blocked_by_task_id: taskB.id, reason: 'dep' },
      idempotency_key: randomUUID(),
    });

    // Complete A — B still blocks C
    await checkUnblocks(client, taskA.id, user.id);

    const { rows } = await client.query(
      `SELECT * FROM events WHERE task_id = $1 AND event_type = 'unblocked'`,
      [taskC.id]
    );
    expect(rows.length).toBe(0);
  }));
});
