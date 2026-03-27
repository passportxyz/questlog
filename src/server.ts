import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { getPool, shutdown } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { extractActorId } from './auth.js';
import { AuthError } from './types.js';

// Tool handlers
import { createTask } from './tools/tasks.js';
import { listTasks } from './tools/tasks.js';
import { getTask } from './tools/tasks.js';
import { appendEvent } from './tools/events.js';
import { claimTask } from './tools/events.js';
import { registerUser, getUser, adminPending, adminApprove, authenticate } from './tools/users.js';
import { registerWebhook } from './tools/webhooks.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getActorIdFromEnv(): string {
  const token = process.env.CV_TOKEN;
  if (!token) throw new AuthError('CV_TOKEN environment variable is required', 'missing_token');
  return extractActorId(token);
}

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: 'clairvoyant', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// ── create_task ──────────────────────────────────────────────────

server.tool(
  'create_task',
  'Create a new task with title, body, and optional metadata',
  {
    title: z.string(),
    body: z.string(),
    owner_id: z.string().optional(),
    parent_task_id: z.string().optional(),
    priority: z.number().optional(),
    due_date: z.string().optional().describe('ISO 8601 date string'),
    tags: z.array(z.string()).optional(),
    on_behalf_of: z.string().optional(),
    idempotency_key: z.string(),
  },
  async (params) => {
    try {
      const actorId = getActorIdFromEnv();
      const pool = getPool();
      const client = await pool.connect();
      try {
        const input = {
          ...params,
          due_date: params.due_date ? new Date(params.due_date) : undefined,
        };
        const result = await createTask(client, actorId, input);
        return textResult(result);
      } finally {
        client.release();
      }
    } catch (err) {
      return errorResult(err);
    }
  },
);

// ── list_tasks ───────────────────────────────────────────────────

server.tool(
  'list_tasks',
  'List tasks with optional filters for status, owner, tags, parent, creator',
  {
    status: z.enum(['open', 'done', 'cancelled']).optional(),
    owner_id: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    parent_task_id: z.string().optional(),
    creator_id: z.string().optional(),
    cursor: z.string().optional(),
  },
  async (params) => {
    try {
      const actorId = getActorIdFromEnv();
      const pool = getPool();
      const client = await pool.connect();
      try {
        const result = await listTasks(client, actorId, params);
        return textResult(result);
      } finally {
        client.release();
      }
    } catch (err) {
      return errorResult(err);
    }
  },
);

// ── get_task ─────────────────────────────────────────────────────

server.tool(
  'get_task',
  'Get a task by ID, including its full event history',
  {
    task_id: z.string(),
  },
  async (params) => {
    try {
      const actorId = getActorIdFromEnv();
      const pool = getPool();
      const client = await pool.connect();
      try {
        const result = await getTask(client, actorId, params);
        return textResult(result);
      } finally {
        client.release();
      }
    } catch (err) {
      return errorResult(err);
    }
  },
);

// ── append_event ─────────────────────────────────────────────────

server.tool(
  'append_event',
  'Append an event to a task (note, progress, handoff, field_changed, completed, cancelled, etc.)',
  {
    task_id: z.string(),
    event_type: z.enum([
      'created', 'note', 'progress', 'handoff', 'claimed',
      'blocked', 'unblocked', 'field_changed', 'completed', 'cancelled',
    ]),
    body: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    idempotency_key: z.string(),
  },
  async (params) => {
    try {
      const actorId = getActorIdFromEnv();
      const pool = getPool();
      const client = await pool.connect();
      try {
        const result = await appendEvent(client, actorId, params);
        return textResult(result);
      } finally {
        client.release();
      }
    } catch (err) {
      return errorResult(err);
    }
  },
);

// ── claim_task ───────────────────────────────────────────────────

server.tool(
  'claim_task',
  'Claim an unowned task — sets the caller as the owner',
  {
    task_id: z.string(),
    idempotency_key: z.string(),
  },
  async (params) => {
    try {
      const actorId = getActorIdFromEnv();
      const pool = getPool();
      const client = await pool.connect();
      try {
        const result = await claimTask(client, actorId, params);
        return textResult(result);
      } finally {
        client.release();
      }
    } catch (err) {
      return errorResult(err);
    }
  },
);

// ── register_user (no auth) ──────────────────────────────────────

server.tool(
  'register_user',
  'Register a new user (human or agent). No authentication required.',
  {
    name: z.string(),
    type: z.enum(['human', 'agent']),
    public_key: z.string(),
    parent_id: z.string().optional(),
  },
  async (params) => {
    try {
      const pool = getPool();
      const client = await pool.connect();
      try {
        const result = await registerUser(client, params);
        return textResult(result);
      } finally {
        client.release();
      }
    } catch (err) {
      return errorResult(err);
    }
  },
);

// ── get_user ─────────────────────────────────────────────────────

server.tool(
  'get_user',
  'Get a user by ID, including their agent count',
  {
    user_id: z.string(),
  },
  async (params) => {
    try {
      const actorId = getActorIdFromEnv();
      const pool = getPool();
      const client = await pool.connect();
      try {
        const result = await getUser(client, actorId, params);
        return textResult(result);
      } finally {
        client.release();
      }
    } catch (err) {
      return errorResult(err);
    }
  },
);

// ── admin_pending ────────────────────────────────────────────────

server.tool(
  'admin_pending',
  'List all users pending approval (admin only)',
  {},
  async () => {
    try {
      const actorId = getActorIdFromEnv();
      const pool = getPool();
      const client = await pool.connect();
      try {
        const result = await adminPending(client, actorId);
        return textResult(result);
      } finally {
        client.release();
      }
    } catch (err) {
      return errorResult(err);
    }
  },
);

// ── admin_approve ────────────────────────────────────────────────

server.tool(
  'admin_approve',
  'Approve a pending user (admin only)',
  {
    user_id: z.string(),
  },
  async (params) => {
    try {
      const actorId = getActorIdFromEnv();
      const pool = getPool();
      const client = await pool.connect();
      try {
        const result = await adminApprove(client, actorId, params);
        return textResult(result);
      } finally {
        client.release();
      }
    } catch (err) {
      return errorResult(err);
    }
  },
);

// ── authenticate (no auth) ───────────────────────────────────────

server.tool(
  'authenticate',
  'Authenticate: request a challenge nonce, or verify a signature to get a JWT. No authentication required.',
  {
    user_id: z.string(),
    action: z.enum(['request_challenge', 'verify']),
    nonce: z.string().optional(),
    signature: z.string().optional(),
  },
  async (params) => {
    try {
      const pool = getPool();
      const client = await pool.connect();
      try {
        const result = await authenticate(client, params);
        return textResult(result);
      } finally {
        client.release();
      }
    } catch (err) {
      return errorResult(err);
    }
  },
);

// ── register_webhook ─────────────────────────────────────────────

server.tool(
  'register_webhook',
  'Register a webhook URL to receive event notifications',
  {
    url: z.string().url(),
    events: z.array(z.string()),
  },
  async (params) => {
    try {
      const actorId = getActorIdFromEnv();
      const pool = getPool();
      const client = await pool.connect();
      try {
        const result = await registerWebhook(client, actorId, params);
        return textResult(result);
      } finally {
        client.release();
      }
    } catch (err) {
      return errorResult(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Transport & startup
// ---------------------------------------------------------------------------

async function main() {
  const pool = getPool();

  // Run migrations on startup
  console.error('[clairvoyant] Running migrations...');
  await runMigrations(pool);
  console.error('[clairvoyant] Migrations complete.');

  // Start staleness checker (may not exist yet)
  try {
    const { startStalenessChecker } = await import('./staleness.js');
    startStalenessChecker(pool);
    console.error('[clairvoyant] Staleness checker started.');
  } catch {
    console.error('[clairvoyant] Staleness checker not available, skipping.');
  }

  const transportType = process.env.CV_TRANSPORT ?? 'stdio';

  if (transportType === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[clairvoyant] MCP server running on stdio.');
  } else if (transportType === 'http') {
    const { StreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/streamableHttp.js'
    );
    const port = parseInt(process.env.CV_PORT ?? '3100', 10);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    console.error(`[clairvoyant] MCP server running on HTTP port ${port}.`);
  } else {
    console.error(`[clairvoyant] Unknown transport: ${transportType}`);
    process.exit(1);
  }

  // Graceful shutdown
  const cleanup = async () => {
    console.error('[clairvoyant] Shutting down...');
    await server.close();
    await shutdown();
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

main().catch((err) => {
  console.error('[clairvoyant] Fatal error:', err);
  process.exit(1);
});
