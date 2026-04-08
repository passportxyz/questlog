import type { Event, Task } from './types.js';

/**
 * Virtual event types — user-facing event names derived from raw events + context.
 *
 * Raw events (what's stored in the DB): created, handoff, completed, note, etc.
 * Virtual events (what users subscribe to): assigned_to_me, task_completed, etc.
 *
 * The resolver maps raw → virtual by examining who the event targets and whether
 * the actor is different from the target (self-actions don't trigger notifications).
 */
export const VIRTUAL_EVENTS = [
  'assigned_to_me',
  'task_completed',
  'task_blocked',
  'task_unblocked',
  'comment_added',
  'field_changed',
] as const;

export type VirtualEvent = (typeof VIRTUAL_EVENTS)[number];

export interface ResolvedEvent {
  /** The user this event is relevant to */
  targetUserId: string;
  /** The virtual event type */
  virtualEvent: VirtualEvent;
  /** The raw event */
  event: Event;
  /** The task (post-projection state) */
  task: Task;
}

/**
 * Resolve a raw event into a virtual event with a target user.
 * Returns null if the event doesn't target anyone (self-action, no owner, etc.).
 *
 * Used by both the webhook and notification systems to determine
 * who should care about an event and what kind of event it is.
 */
export function resolveEvent(event: Event, task: Task): ResolvedEvent | null {
  switch (event.event_type) {
    case 'created': {
      const ownerId = event.metadata.owner_id as string | undefined;
      if (ownerId && ownerId !== event.actor_id) {
        return { targetUserId: ownerId, virtualEvent: 'assigned_to_me', event, task };
      }
      return null;
    }

    case 'handoff': {
      const toUserId = event.metadata.to_user_id as string;
      if (toUserId !== event.actor_id) {
        return { targetUserId: toUserId, virtualEvent: 'assigned_to_me', event, task };
      }
      return null;
    }

    case 'completed':
    case 'cancelled': {
      if (task.owner_id && task.owner_id !== event.actor_id) {
        return { targetUserId: task.owner_id, virtualEvent: 'task_completed', event, task };
      }
      return null;
    }

    case 'blocked': {
      if (task.owner_id && task.owner_id !== event.actor_id) {
        return { targetUserId: task.owner_id, virtualEvent: 'task_blocked', event, task };
      }
      return null;
    }

    case 'unblocked': {
      if (task.owner_id && task.owner_id !== event.actor_id) {
        return { targetUserId: task.owner_id, virtualEvent: 'task_unblocked', event, task };
      }
      return null;
    }

    case 'note': {
      if (task.owner_id && task.owner_id !== event.actor_id) {
        return { targetUserId: task.owner_id, virtualEvent: 'comment_added', event, task };
      }
      return null;
    }

    case 'field_changed': {
      if (task.owner_id && task.owner_id !== event.actor_id) {
        return { targetUserId: task.owner_id, virtualEvent: 'field_changed', event, task };
      }
      return null;
    }

    default:
      return null;
  }
}
