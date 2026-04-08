import express, { Router } from 'express';
import type { Request, Response } from 'express';
import type pg from 'pg';
import type { Task, User, Event, Attachment } from './types.js';
import { consumeCode, generateCode } from './access-codes.js';
import { signToken, verifyToken } from './auth.js';

const BOARD_CODE_TTL_MS = 10 * 60_000; // 10 minutes
const BOARD_TOKEN_DAYS = 30;

export function createBoardRouter(pool: pg.Pool): Router {
  const router = Router();
  router.use(express.json());

  // ── POST /board/auth — exchange code for JWT ────────────────────
  router.post('/auth', (req: Request, res: Response) => {
    const { code } = req.body as { code?: string };
    if (!code || typeof code !== 'string') {
      res.status(400).json({ error: 'code is required' });
      return;
    }

    const data = consumeCode(code, 'board');
    if (!data) {
      res.status(401).json({ error: 'Invalid or expired code' });
      return;
    }

    const token = signToken(
      { sub: data.userId, name: data.userName, scope: 'board' },
      BOARD_TOKEN_DAYS,
    );

    res.json({ token, expires_in_days: BOARD_TOKEN_DAYS });
  });

  // ── Auth check middleware for GET /board ─────────────────────────
  router.get('/', async (req: Request, res: Response) => {
    // Check for JWT in cookie or Authorization header
    const token = extractBoardToken(req);

    if (!token) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderLoginPage());
      return;
    }

    try {
      const payload = verifyToken(token);
      // Accept both board-scoped and full tokens
      if (payload.scope && payload.scope !== 'board') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(renderLoginPage('Invalid token scope'));
        return;
      }
    } catch {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderLoginPage('Session expired — enter a new code'));
      return;
    }

    // Token valid — render board
    const client = await pool.connect();
    try {
      const [openResult, doneResult, usersResult] = await Promise.all([
        client.query<Task>(
          `SELECT * FROM tasks WHERE status = 'open' ORDER BY priority ASC NULLS LAST, created_at DESC`
        ),
        client.query<Task>(
          `SELECT * FROM tasks WHERE status IN ('done', 'cancelled') ORDER BY updated_at DESC LIMIT 20`
        ),
        client.query<User>(
          `SELECT * FROM users WHERE status = 'active' ORDER BY name ASC`
        ),
      ]);

      const allTasks = [...openResult.rows, ...doneResult.rows];
      const taskIds = allTasks.map(t => t.id);

      let latestEvents: Record<string, Event> = {};
      let attachmentCounts: Record<string, number> = {};

      if (taskIds.length > 0) {
        const [eventsResult, attachResult] = await Promise.all([
          client.query<Event & { rn: number }>(
            `SELECT DISTINCT ON (task_id) * FROM events
             WHERE task_id = ANY($1)
             ORDER BY task_id, created_at DESC`,
            [taskIds]
          ),
          client.query<{ task_id: string; count: string }>(
            `SELECT task_id, count(*)::text FROM attachments
             WHERE task_id = ANY($1) GROUP BY task_id`,
            [taskIds]
          ),
        ]);
        for (const e of eventsResult.rows) latestEvents[e.task_id] = e;
        for (const a of attachResult.rows) attachmentCounts[a.task_id] = parseInt(a.count, 10);
      }

      const usersById: Record<string, User> = {};
      for (const u of usersResult.rows) usersById[u.id] = u;

      const openTasks = openResult.rows;
      const doneTasks = doneResult.rows;
      const ownedTasks = openTasks.filter(t => t.owner_id);
      const triageTasks = openTasks.filter(t => !t.owner_id);

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderBoard({
        ownedTasks,
        triageTasks,
        doneTasks,
        usersById,
        latestEvents,
        attachmentCounts,
      }));
    } finally {
      client.release();
    }
  });

  return router;
}

// ── Helper: generate a board login code ──────────────────────────

export function generateBoardCode(userId: string, userName: string): string {
  return generateCode('board', { userId, userName }, {
    ttlMs: BOARD_CODE_TTL_MS,
    friendly: true,
    length: 8,
    formatted: 4,
  });
}

// ── Token extraction ─────────────────────────────────────────────

function extractBoardToken(req: Request): string | null {
  // 1. Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);

  // 2. Cookie
  const cookies = req.headers.cookie;
  if (cookies) {
    const match = cookies.match(/(?:^|;\s*)ql_board_token=([^\s;]+)/);
    if (match) return match[1];
  }

  // 3. Query param (for bookmarkable links)
  if (req.query.token) return req.query.token as string;

  return null;
}

// ── Rendering ──────────────────────────────────────────────────────

interface BoardData {
  ownedTasks: Task[];
  triageTasks: Task[];
  doneTasks: Task[];
  usersById: Record<string, User>;
  latestEvents: Record<string, Event>;
  attachmentCounts: Record<string, number>;
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderTaskCard(task: Task, data: BoardData, index: number): string {
  const owner = task.owner_id ? data.usersById[task.owner_id] : null;
  const latestEvent = data.latestEvents[task.id];
  const attachCount = data.attachmentCounts[task.id] || 0;
  const shortId = task.id.slice(0, 8);

  const priorityClass = task.priority !== null && task.priority !== undefined
    ? `priority-${Math.min(task.priority as number, 3)}`
    : '';

  const statusClass = task.status === 'done' ? 'status-done'
    : task.status === 'cancelled' ? 'status-cancelled'
    : owner ? 'status-active' : 'status-triage';

  const tagHtml = task.tags?.length
    ? task.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')
    : '';

  const eventHtml = latestEvent
    ? `<div class="latest-event">
        <span class="event-type">${esc(latestEvent.event_type)}</span>
        <span class="event-actor">${esc(data.usersById[latestEvent.actor_id]?.name || 'unknown')}</span>
        <span class="event-time">${timeAgo(latestEvent.created_at)}</span>
       </div>`
    : '';

  const eventBody = latestEvent?.body
    ? `<div class="event-body">${esc(latestEvent.body)}</div>`
    : '';

  return `
    <div class="task-card ${statusClass} ${priorityClass}" style="--delay: ${index * 0.06}s">
      <div class="card-header">
        <span class="task-id">${shortId}</span>
        ${owner ? `<span class="owner">${esc(owner.name)}</span>` : '<span class="owner triage-label">triage</span>'}
      </div>
      <h3 class="task-title">${esc(task.title)}</h3>
      <div class="card-meta">
        ${tagHtml}
        ${attachCount > 0 ? `<span class="attachment-count">${attachCount} file${attachCount > 1 ? 's' : ''}</span>` : ''}
        <span class="created">${timeAgo(task.created_at)}</span>
      </div>
      ${eventHtml}
      ${eventBody}
    </div>`;
}

// ── Login Page ───────────────────────────────────────────────────

function renderLoginPage(error?: string): string {
  const errorHtml = error
    ? `<div class="error-msg" style="animation: fadeSlideUp 0.3s ease-out">${esc(error)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quest Log</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --surface-hover: #1a1a26;
    --border: #1e1e2e;
    --border-glow: #2a2a40;
    --text: #e0e0e8;
    --text-dim: #6a6a80;
    --text-muted: #3a3a50;
    --accent: #7c6ff0;
    --accent-dim: rgba(124, 111, 240, 0.15);
    --red: #f87171;
  }

  body {
    font-family: 'Inter', -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
  }

  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image:
      linear-gradient(var(--border) 1px, transparent 1px),
      linear-gradient(90deg, var(--border) 1px, transparent 1px);
    background-size: 60px 60px;
    opacity: 0.3;
    pointer-events: none;
  }

  .login-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 2.5rem;
    width: 100%;
    max-width: 380px;
    position: relative;
    z-index: 1;
    animation: fadeSlideUp 0.5s ease-out;
  }

  .login-card h1 {
    font-size: 1.5rem;
    font-weight: 600;
    letter-spacing: -0.03em;
    background: linear-gradient(135deg, var(--text) 0%, var(--accent) 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 0.5rem;
  }

  .login-card p {
    color: var(--text-dim);
    font-size: 0.85rem;
    margin-bottom: 1.5rem;
    line-height: 1.5;
  }

  .code-input {
    width: 100%;
    padding: 0.85rem 1rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text);
    font-family: 'JetBrains Mono', monospace;
    font-size: 1.2rem;
    letter-spacing: 0.15em;
    text-align: center;
    text-transform: uppercase;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .code-input::placeholder {
    color: var(--text-muted);
    letter-spacing: 0.05em;
    font-size: 0.9rem;
    text-transform: none;
  }

  .code-input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-dim);
  }

  .submit-btn {
    width: 100%;
    margin-top: 1rem;
    padding: 0.75rem;
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 10px;
    font-family: 'Inter', sans-serif;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.2s, transform 0.1s;
  }

  .submit-btn:hover { opacity: 0.9; }
  .submit-btn:active { transform: scale(0.98); }
  .submit-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .error-msg {
    margin-top: 1rem;
    padding: 0.6rem 0.8rem;
    background: rgba(248, 113, 113, 0.1);
    border: 1px solid rgba(248, 113, 113, 0.2);
    border-radius: 8px;
    color: var(--red);
    font-size: 0.8rem;
    text-align: center;
  }

  .hint {
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
    color: var(--text-muted);
    font-size: 0.75rem;
    text-align: center;
    line-height: 1.6;
  }

  .hint code {
    font-family: 'JetBrains Mono', monospace;
    color: var(--text-dim);
    background: var(--bg);
    padding: 0.1rem 0.3rem;
    border-radius: 4px;
    font-size: 0.7rem;
  }

  @keyframes fadeSlideUp {
    from { opacity: 0; transform: translateY(16px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
</head>
<body>
<div class="login-card">
  <h1>Quest Log</h1>
  <p>Enter your access code to view the board.</p>
  <form id="login-form">
    <input type="text" class="code-input" id="code" placeholder="XXXX-XXXX"
           maxlength="9" autocomplete="off" autofocus spellcheck="false">
    <button type="submit" class="submit-btn">Enter</button>
  </form>
  ${errorHtml}
  <div class="hint">
    Generate a code with <code>ql board-code</code><br>
    or ask your agent for a board access code
  </div>
</div>
<script>
  const form = document.getElementById('login-form');
  const input = document.getElementById('code');
  const btn = form.querySelector('button');

  // Auto-format: insert dash after 4 chars
  input.addEventListener('input', () => {
    let v = input.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (v.length > 4) v = v.slice(0, 4) + '-' + v.slice(4, 8);
    input.value = v;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = input.value.trim();
    if (!code) return;

    btn.disabled = true;
    btn.textContent = 'Verifying...';

    try {
      const res = await fetch('/board/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        showError(data.error || 'Invalid code');
        return;
      }
      // Store token and set cookie
      localStorage.setItem('ql_board_token', data.token);
      const maxAge = data.expires_in_days * 86400;
      document.cookie = 'ql_board_token=' + data.token + '; path=/board; max-age=' + maxAge + '; SameSite=Lax';
      window.location.reload();
    } catch {
      showError('Connection failed');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Enter';
    }
  });

  function showError(msg) {
    let el = document.querySelector('.error-msg');
    if (!el) {
      el = document.createElement('div');
      el.className = 'error-msg';
      el.style.animation = 'fadeSlideUp 0.3s ease-out';
      form.parentNode.insertBefore(el, form.nextSibling);
    }
    el.textContent = msg;
  }

  // On load, check if we have a stored token and set cookie if missing
  const stored = localStorage.getItem('ql_board_token');
  if (stored && !document.cookie.includes('ql_board_token')) {
    document.cookie = 'ql_board_token=' + stored + '; path=/board; max-age=' + (30 * 86400) + '; SameSite=Lax';
    window.location.reload();
  }
</script>
</body>
</html>`;
}

// ── Board Page ──────────────────────────────────────────────────

function renderBoard(data: BoardData): string {
  const { ownedTasks, triageTasks, doneTasks } = data;

  const ownedHtml = ownedTasks.map((t, i) => renderTaskCard(t, data, i)).join('');
  const triageHtml = triageTasks.map((t, i) => renderTaskCard(t, data, i)).join('');
  const doneHtml = doneTasks.map((t, i) => renderTaskCard(t, data, i)).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Quest Log</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');

  * { margin: 0; padding: 0; box-sizing: border-box; }

  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --surface-hover: #1a1a26;
    --border: #1e1e2e;
    --border-glow: #2a2a40;
    --text: #e0e0e8;
    --text-dim: #6a6a80;
    --text-muted: #3a3a50;
    --accent: #7c6ff0;
    --accent-dim: rgba(124, 111, 240, 0.15);
    --green: #4ade80;
    --green-dim: rgba(74, 222, 128, 0.12);
    --amber: #fbbf24;
    --amber-dim: rgba(251, 191, 36, 0.12);
    --red: #f87171;
    --red-dim: rgba(248, 113, 113, 0.1);
    --triage: #38bdf8;
    --triage-dim: rgba(56, 189, 248, 0.1);
  }

  body {
    font-family: 'Inter', -apple-system, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    overflow-x: hidden;
  }

  /* Subtle grid bg */
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image:
      linear-gradient(var(--border) 1px, transparent 1px),
      linear-gradient(90deg, var(--border) 1px, transparent 1px);
    background-size: 60px 60px;
    opacity: 0.3;
    pointer-events: none;
    z-index: 0;
  }

  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem 1.5rem;
    position: relative;
    z-index: 1;
  }

  /* Header */
  header {
    margin-bottom: 3rem;
    animation: fadeSlideDown 0.6s ease-out;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }

  header h1 {
    font-size: 1.75rem;
    font-weight: 600;
    letter-spacing: -0.03em;
    background: linear-gradient(135deg, var(--text) 0%, var(--accent) 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  header p {
    color: var(--text-dim);
    font-size: 0.875rem;
    margin-top: 0.25rem;
  }

  .logout-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--text-dim);
    font-family: 'Inter', sans-serif;
    font-size: 0.75rem;
    padding: 0.4rem 0.8rem;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .logout-btn:hover {
    border-color: var(--border-glow);
    color: var(--text);
  }

  /* Sections */
  .section {
    margin-bottom: 2.5rem;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--border);
  }

  .section-header h2 {
    font-size: 0.85rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-dim);
  }

  .section-header .count {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    background: var(--accent-dim);
    color: var(--accent);
  }

  .section-header .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    animation: pulse 2s ease-in-out infinite;
  }

  .section.active .dot { background: var(--green); box-shadow: 0 0 8px var(--green); }
  .section.triage .dot { background: var(--triage); box-shadow: 0 0 8px var(--triage); }
  .section.done .dot { background: var(--text-muted); }

  /* Card grid */
  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 0.75rem;
  }

  /* Cards */
  .task-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 1rem 1.15rem;
    cursor: default;
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    animation: fadeSlideUp 0.5s ease-out both;
    animation-delay: var(--delay);
    position: relative;
    overflow: hidden;
  }

  .task-card::before {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 3px;
    border-radius: 3px 0 0 3px;
    transition: opacity 0.25s;
  }

  .task-card.status-active::before { background: var(--green); }
  .task-card.status-triage::before { background: var(--triage); }
  .task-card.status-done::before { background: var(--text-muted); opacity: 0.5; }
  .task-card.status-cancelled::before { background: var(--red); opacity: 0.4; }

  .task-card:hover {
    border-color: var(--border-glow);
    background: var(--surface-hover);
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3), 0 0 0 1px var(--border-glow);
  }

  .task-card.priority-0 { border-left: 3px solid var(--red); }
  .task-card.priority-1 { border-left: 3px solid var(--amber); }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .task-id {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .owner {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--accent);
    padding: 0.1rem 0.5rem;
    background: var(--accent-dim);
    border-radius: 999px;
  }

  .owner.triage-label {
    color: var(--triage);
    background: var(--triage-dim);
  }

  .task-title {
    font-size: 0.95rem;
    font-weight: 500;
    line-height: 1.4;
    margin-bottom: 0.6rem;
    letter-spacing: -0.01em;
  }

  .card-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.7rem;
    color: var(--text-dim);
  }

  .tag {
    padding: 0.1rem 0.4rem;
    background: var(--border);
    border-radius: 4px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
  }

  .attachment-count {
    color: var(--amber);
  }

  .latest-event {
    margin-top: 0.6rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.7rem;
  }

  .event-type {
    font-family: 'JetBrains Mono', monospace;
    color: var(--accent);
    font-size: 0.65rem;
    padding: 0.1rem 0.35rem;
    background: var(--accent-dim);
    border-radius: 3px;
  }

  .event-actor { color: var(--text-dim); }
  .event-time { color: var(--text-muted); margin-left: auto; }

  .event-body {
    font-size: 0.75rem;
    color: var(--text-dim);
    margin-top: 0.4rem;
    line-height: 1.5;
    max-height: 3em;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .status-done .task-title,
  .status-cancelled .task-title {
    opacity: 0.5;
  }

  .status-cancelled .task-title {
    text-decoration: line-through;
  }

  /* Empty state */
  .empty {
    color: var(--text-muted);
    font-size: 0.85rem;
    font-style: italic;
    padding: 1rem 0;
  }

  /* Animations */
  @keyframes fadeSlideUp {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes fadeSlideDown {
    from { opacity: 0; transform: translateY(-12px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  /* Responsive */
  @media (max-width: 640px) {
    .container { padding: 1rem; }
    .card-grid { grid-template-columns: 1fr; }
    header h1 { font-size: 1.35rem; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <div>
      <h1>Quest Log</h1>
      <p>${openCount(ownedTasks, triageTasks)} open &middot; ${doneTasks.length} completed</p>
    </div>
    <button class="logout-btn" onclick="logout()">Sign out</button>
  </header>

  ${ownedTasks.length > 0 ? `
  <div class="section active">
    <div class="section-header">
      <div class="dot"></div>
      <h2>In Progress</h2>
      <span class="count">${ownedTasks.length}</span>
    </div>
    <div class="card-grid">${ownedHtml}</div>
  </div>` : ''}

  ${triageTasks.length > 0 ? `
  <div class="section triage">
    <div class="section-header">
      <div class="dot"></div>
      <h2>Triage</h2>
      <span class="count">${triageTasks.length}</span>
    </div>
    <div class="card-grid">${triageHtml}</div>
  </div>` : ''}

  ${doneTasks.length > 0 ? `
  <div class="section done">
    <div class="section-header">
      <div class="dot"></div>
      <h2>Recently Completed</h2>
      <span class="count">${doneTasks.length}</span>
    </div>
    <div class="card-grid">${doneHtml}</div>
  </div>` : ''}

  ${ownedTasks.length === 0 && triageTasks.length === 0 && doneTasks.length === 0 ? `
  <div class="empty">No tasks yet. Create one with your agent or the ql CLI.</div>` : ''}
</div>
<script>
  function logout() {
    localStorage.removeItem('ql_board_token');
    document.cookie = 'ql_board_token=; path=/board; max-age=0';
    window.location.reload();
  }
</script>
</body>
</html>`;
}

function openCount(owned: Task[], triage: Task[]): number {
  return owned.length + triage.length;
}
