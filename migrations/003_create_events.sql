CREATE TABLE events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         uuid NOT NULL REFERENCES tasks(id),
  event_type      text NOT NULL CHECK (event_type IN (
    'created', 'note', 'progress', 'handoff', 'claimed',
    'blocked', 'unblocked', 'field_changed', 'completed', 'cancelled'
  )),
  actor_id        uuid NOT NULL REFERENCES users(id),
  body            text,
  metadata        jsonb NOT NULL DEFAULT '{}',
  idempotency_key uuid NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_events_task_id ON events(task_id);
CREATE INDEX idx_events_task_id_created ON events(task_id, created_at);
CREATE INDEX idx_events_actor_id ON events(actor_id);
CREATE INDEX idx_events_idempotency ON events(idempotency_key);
