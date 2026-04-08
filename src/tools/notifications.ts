import pg from 'pg';
import crypto from 'node:crypto';
import {
  insertNotificationSubscription,
  getNotificationSubscriptionsByUserId,
  deleteNotificationSubscription,
  updateNotificationSubscription,
} from '../db/queries.js';
import { NOTIFICATION_EVENTS } from '../ntfy.js';
import type { NotificationSubscription } from '../types.js';

/**
 * Generate a unique, unguessable topic name for a user.
 */
function generateTopic(userId: string): string {
  const prefix = userId.slice(0, 8);
  const random = crypto.randomBytes(9).toString('base64url'); // 12 chars
  return `ql-${prefix}-${random}`;
}

export async function subscribeNotifications(
  client: pg.PoolClient,
  actorId: string,
  input: { events: string[] },
): Promise<{ subscription: NotificationSubscription; ntfy_topic: string; setup_instructions: string }> {
  // Validate events
  for (const evt of input.events) {
    if (!NOTIFICATION_EVENTS.includes(evt as any)) {
      throw new Error(`Invalid notification event: ${evt}. Valid events: ${NOTIFICATION_EVENTS.join(', ')}`);
    }
  }

  // Check if user already has a subscription — update it instead of creating duplicate
  const existing = await getNotificationSubscriptionsByUserId(client, actorId);
  if (existing.length > 0) {
    const sub = await updateNotificationSubscription(client, existing[0].id, actorId, {
      events: input.events,
      active: true,
    });
    const ntfyUrl = process.env.NTFY_URL || 'http://ntfy:80';
    return {
      subscription: sub,
      ntfy_topic: sub.topic,
      setup_instructions: `Subscribe to notifications in the ntfy app:\n1. Open ntfy app\n2. Add subscription to: ${ntfyUrl}/${sub.topic}\n3. You'll receive push notifications for: ${input.events.join(', ')}`,
    };
  }

  const topic = generateTopic(actorId);
  const subscription = await insertNotificationSubscription(client, {
    user_id: actorId,
    topic,
    events: input.events,
  });

  const ntfyUrl = process.env.NTFY_URL || 'http://ntfy:80';
  return {
    subscription,
    ntfy_topic: topic,
    setup_instructions: `Subscribe to notifications in the ntfy app:\n1. Open ntfy app\n2. Add subscription to: ${ntfyUrl}/${topic}\n3. You'll receive push notifications for: ${input.events.join(', ')}`,
  };
}

export async function listNotificationSubscriptions(
  client: pg.PoolClient,
  actorId: string,
): Promise<{ subscriptions: NotificationSubscription[] }> {
  const subscriptions = await getNotificationSubscriptionsByUserId(client, actorId);
  return { subscriptions };
}

export async function unsubscribeNotifications(
  client: pg.PoolClient,
  actorId: string,
  input: { subscription_id: string },
): Promise<{ deleted: true }> {
  await deleteNotificationSubscription(client, input.subscription_id, actorId);
  return { deleted: true };
}
