import pg from 'pg';
import type { Event, Task } from './types.js';
import { getNotificationSubscriptionsByUserId } from './db/queries.js';
import { resolveEvent, VIRTUAL_EVENTS } from './event-resolver.js';
import type { VirtualEvent } from './event-resolver.js';

// Re-export for consumers that imported from here
export { VIRTUAL_EVENTS as NOTIFICATION_EVENTS } from './event-resolver.js';
export type { VirtualEvent as NotificationEvent } from './event-resolver.js';

// ── Configuration ──────────────────────────────────────────────────

const NTFY_URL = process.env.NTFY_URL || '';
const DEBOUNCE_MS = parseInt(process.env.NTFY_DEBOUNCE_MS || '120000', 10); // 2 min default

// ── Debounce buffer ────────────────────────────────────────────────

interface BufferedNotification {
  event: Event;
  task: Task;
  virtualEvent: VirtualEvent;
}

interface UserBuffer {
  timer: ReturnType<typeof setTimeout>;
  items: BufferedNotification[];
  topic: string;
}

const buffers = new Map<string, UserBuffer>();

// ── Priority mapping ───────────────────────────────────────────────

const PRIORITY_MAP: Record<VirtualEvent, number> = {
  assigned_to_me: 4,
  task_blocked: 4,
  task_completed: 3,
  task_unblocked: 3,
  comment_added: 2,
  field_changed: 2,
};

// ── Format notification ────────────────────────────────────────────

function formatSingle(item: BufferedNotification): { title: string; message: string; priority: number } {
  const { event, task, virtualEvent } = item;
  const priority = PRIORITY_MAP[virtualEvent];

  switch (virtualEvent) {
    case 'assigned_to_me':
      return {
        title: `Task assigned: ${task.title}`,
        message: `You were assigned "${task.title}"`,
        priority,
      };
    case 'task_completed':
      return {
        title: `Task completed: ${task.title}`,
        message: `"${task.title}" was marked as ${event.event_type}`,
        priority,
      };
    case 'task_blocked':
      return {
        title: `Task blocked: ${task.title}`,
        message: `"${task.title}" was blocked`,
        priority,
      };
    case 'task_unblocked':
      return {
        title: `Task unblocked: ${task.title}`,
        message: `"${task.title}" was unblocked`,
        priority,
      };
    case 'comment_added':
      return {
        title: `Comment on: ${task.title}`,
        message: event.body ? `"${event.body.slice(0, 200)}"` : `New comment on "${task.title}"`,
        priority,
      };
    case 'field_changed':
      return {
        title: `Updated: ${task.title}`,
        message: `${event.metadata.field} changed on "${task.title}"`,
        priority,
      };
  }
}

function formatBatch(items: BufferedNotification[]): { title: string; message: string; priority: number } {
  const counts = new Map<VirtualEvent, number>();
  let maxPriority = 1;
  for (const item of items) {
    counts.set(item.virtualEvent, (counts.get(item.virtualEvent) || 0) + 1);
    maxPriority = Math.max(maxPriority, PRIORITY_MAP[item.virtualEvent]);
  }

  const parts: string[] = [];
  for (const [evt, count] of counts) {
    const label = evt.replace(/_/g, ' ');
    parts.push(`${count} ${label}`);
  }

  return {
    title: `${items.length} Quest Log updates`,
    message: parts.join(', '),
    priority: maxPriority,
  };
}

// ── Send to ntfy ───────────────────────────────────────────────────

async function sendToNtfy(topic: string, items: BufferedNotification[]): Promise<void> {
  if (!NTFY_URL) {
    console.error('[ntfy] NTFY_URL not configured, skipping notification');
    return;
  }

  const { title, message, priority } = items.length === 1
    ? formatSingle(items[0])
    : formatBatch(items);

  const baseUrl = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  const clickUrl = items.length === 1
    ? `${baseUrl}/board#task-${items[0].task.id}`
    : `${baseUrl}/board`;

  const body = JSON.stringify({
    topic,
    title,
    message,
    priority,
    markdown: true,
    click: clickUrl || undefined,
    tags: ['clipboard'],
  });

  try {
    await fetch(NTFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    console.error(`[ntfy] Failed to send notification to topic ${topic}:`, err);
  }
}

// ── Flush a user's buffer ──────────────────────────────────────────

function flushBuffer(userId: string): void {
  const buf = buffers.get(userId);
  if (!buf || buf.items.length === 0) return;
  buffers.delete(userId);

  sendToNtfy(buf.topic, buf.items).catch((err) => {
    console.error(`[ntfy] Flush error for user ${userId}:`, err);
  });
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Process a task event for ntfy notifications.
 * Resolves the target user, checks subscriptions, and buffers the notification.
 */
export async function processNotification(
  pool: pg.Pool,
  event: Event,
  task: Task,
): Promise<void> {
  if (!NTFY_URL) return;

  const resolved = resolveEvent(event, task);
  if (!resolved) return;

  const client = await pool.connect();
  try {
    const subs = await getNotificationSubscriptionsByUserId(client, resolved.targetUserId);
    const activeSub = subs.find(
      (s) => s.active && s.events.includes(resolved.virtualEvent),
    );
    if (!activeSub) return;

    const item: BufferedNotification = {
      event,
      task,
      virtualEvent: resolved.virtualEvent,
    };

    const existing = buffers.get(resolved.targetUserId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.items.push(item);
      existing.timer = setTimeout(() => flushBuffer(resolved.targetUserId), DEBOUNCE_MS);
    } else {
      const timer = setTimeout(() => flushBuffer(resolved.targetUserId), DEBOUNCE_MS);
      buffers.set(resolved.targetUserId, {
        timer,
        items: [item],
        topic: activeSub.topic,
      });
    }
  } finally {
    client.release();
  }
}
