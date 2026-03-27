import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  getBlockedEvents,
  getUnblockedEventsForTask,
  insertEvent,
  getTaskById,
  updateTask,
} from './db/queries.js';
import { applyEvent } from './projection.js';
import type { Event, SideEffect } from './types.js';

/**
 * Check if any tasks blocked by `completedTaskId` can now be unblocked.
 * For each blocked task:
 *   1. Find all 'blocked' events referencing completedTaskId
 *   2. Check if the blocked task has other unresolved blockers
 *   3. If no remaining blockers, insert an 'unblocked' event
 *
 * Returns any side effects generated (e.g., webhook notifications for unblocks).
 */
export async function checkUnblocks(
  client: pg.PoolClient,
  completedTaskId: string,
  actorId: string,
): Promise<SideEffect[]> {
  // Find all 'blocked' events that reference the completed task
  const blockedEvents = await getBlockedEvents(client, completedTaskId);

  const allSideEffects: SideEffect[] = [];

  // Group by task_id — a task might have multiple blocked events referencing this task
  const taskIds = [...new Set(blockedEvents.map((e) => e.task_id))];

  for (const taskId of taskIds) {
    // Get all blocked events for this task (not just ones referencing completedTaskId)
    const allBlockedForTask = await getEventsByTaskIdAndType(client, taskId, 'blocked');
    const unblockedForTask = await getUnblockedEventsForTask(client, taskId);

    // A blocker is "resolved" if there's an unblocked event whose
    // metadata.resolved_by matches the blocked_by_task_id
    const resolvedBlockerIds = new Set(
      unblockedForTask.map((e) => e.metadata.resolved_by as string).filter(Boolean),
    );

    // Add the just-completed task as resolved too (we're about to create the unblock event)
    resolvedBlockerIds.add(completedTaskId);

    // Check if any blockers remain unresolved
    const unresolvedBlockers = allBlockedForTask.filter((e) => {
      const blockerTaskId = e.metadata.blocked_by_task_id as string | undefined;
      if (!blockerTaskId) return false; // capability_gap blockers don't auto-resolve
      return !resolvedBlockerIds.has(blockerTaskId);
    });

    if (unresolvedBlockers.length === 0) {
      // All blockers resolved — insert unblocked event
      const task = await getTaskById(client, taskId);
      if (!task || task.status !== 'open') continue;

      const event = await insertEvent(client, {
        task_id: taskId,
        event_type: 'unblocked',
        actor_id: actorId,
        body: `Auto-unblocked: dependency ${completedTaskId} resolved`,
        metadata: { resolved_by: completedTaskId },
        idempotency_key: randomUUID(),
      });

      const projection = applyEvent(event, task);

      if (Object.keys(projection.taskUpdates).length > 0) {
        await updateTask(client, taskId, task.version, projection.taskUpdates);
      }

      allSideEffects.push(...projection.sideEffects);
    }
  }

  return allSideEffects;
}

/**
 * Helper: get events for a task filtered by type.
 */
async function getEventsByTaskIdAndType(
  client: pg.PoolClient,
  taskId: string,
  eventType: string,
): Promise<Event[]> {
  const { rows } = await client.query<Event>(
    `SELECT * FROM events WHERE task_id = $1 AND event_type = $2 ORDER BY created_at ASC`,
    [taskId, eventType],
  );
  return rows;
}
