-- Re-introduce user types: humans are task assignees, agents authenticate and act
ALTER TABLE users ADD COLUMN type text NOT NULL DEFAULT 'agent' CHECK (type IN ('human', 'agent'));

-- Humans don't need public keys — only agents authenticate
ALTER TABLE users ALTER COLUMN public_key DROP NOT NULL;

-- Agents must always have a public key for authentication
ALTER TABLE users ADD CONSTRAINT chk_agent_has_key
  CHECK (type = 'human' OR public_key IS NOT NULL);
