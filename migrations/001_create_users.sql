CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  type        text NOT NULL CHECK (type IN ('human', 'agent')),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  is_admin    boolean NOT NULL DEFAULT false,
  public_key  text NOT NULL UNIQUE,
  parent_id   uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_parent_id ON users(parent_id);
