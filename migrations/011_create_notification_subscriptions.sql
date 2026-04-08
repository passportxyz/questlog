CREATE TABLE notification_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  topic       text NOT NULL UNIQUE,
  events      text[] NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notification_subscriptions_user_id ON notification_subscriptions(user_id);
