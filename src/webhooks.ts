import crypto from 'node:crypto';
import pg from 'pg';
import { getActiveWebhooksByEventType } from './db/queries.js';
import { resolveEvent } from './event-resolver.js';
import type { Event, Task, SideEffect } from './types.js';

/**
 * Process side effects from a projection result.
 * Dispatches webhooks asynchronously (fire-and-forget).
 */
export async function processSideEffects(
  pool: pg.Pool,
  sideEffects: SideEffect[],
  event: Event,
  task: Task,
): Promise<void> {
  for (const effect of sideEffects) {
    if (effect.type === 'webhook') {
      // Fire-and-forget — don't await, just catch errors
      dispatchWebhooks(pool, effect.eventType, event, task).catch((err) => {
        console.error(`Webhook dispatch error for ${effect.eventType}:`, err);
      });
    }
    // check_unblocks and staleness_reset are handled elsewhere
  }
}

/**
 * Dispatch webhooks for a given event type.
 * Queries active webhooks for both the raw event type (e.g. "handoff") and
 * the resolved virtual event type (e.g. "assigned_to_me"), so subscribers
 * can register for either.
 */
async function dispatchWebhooks(
  pool: pg.Pool,
  eventType: string,
  event: Event,
  task: Task,
): Promise<void> {
  const client = await pool.connect();
  try {
    // Collect webhooks matching the raw event type
    const rawWebhooks = await getActiveWebhooksByEventType(client, eventType);

    // Also collect webhooks matching the virtual event type (if any)
    const resolved = resolveEvent(event, task);
    const virtualWebhooks = resolved
      ? await getActiveWebhooksByEventType(client, resolved.virtualEvent)
      : [];

    // Deduplicate by webhook ID (a webhook could match both)
    const seen = new Set<string>();
    const allWebhooks = [...rawWebhooks, ...virtualWebhooks].filter((w) => {
      if (seen.has(w.id)) return false;
      seen.add(w.id);
      return true;
    });

    if (allWebhooks.length === 0) return;

    // Include the resolved virtual event in the payload for context
    const body = JSON.stringify({
      event,
      task,
      virtual_event: resolved?.virtualEvent ?? null,
      target_user_id: resolved?.targetUserId ?? null,
    });

    const promises = allWebhooks.map(async (webhook) => {
      try {
        const signature = crypto
          .createHmac('sha256', webhook.secret)
          .update(body)
          .digest('hex');

        await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-QL-Signature': signature,
          },
          body,
          signal: AbortSignal.timeout(10_000), // 10s timeout
        });
      } catch (err) {
        console.error(`Failed to deliver webhook to ${webhook.url}:`, err);
      }
    });

    await Promise.allSettled(promises);
  } finally {
    client.release();
  }
}
