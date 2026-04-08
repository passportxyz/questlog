import crypto from 'node:crypto';

// ── Generic Code Store ────────────────────────────────────────────
// Shared model for short-lived access codes: attachment downloads,
// board login, and any future code-gated features.

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CodeEntry {
  purpose: string;
  data: Record<string, string>;
  expiresAt: number;
}

const codes = new Map<string, CodeEntry>();

// Human-friendly charset (no 0/O/1/I/L ambiguity)
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(length: number, friendly: boolean): string {
  if (!friendly) return crypto.randomBytes(6).toString('base64url'); // 8 chars
  let result = '';
  for (let i = 0; i < length; i++) {
    const limit = 256 - (256 % CODE_CHARS.length);
    let b: number;
    do { b = crypto.randomBytes(1)[0]; } while (b >= limit);
    result += CODE_CHARS[b % CODE_CHARS.length];
  }
  return result;
}

/**
 * Generate a code for a given purpose.
 *
 * @param purpose  - identifies the code type ('attachment', 'board', etc.)
 * @param data     - arbitrary key-value data stored with the code
 * @param opts.ttlMs       - time-to-live in ms (default 1 hour)
 * @param opts.friendly    - use human-friendly charset (default false = base64url)
 * @param opts.length      - code length for friendly codes (default 8)
 * @param opts.formatted   - insert dash every N chars (e.g. 4 → XXXX-XXXX)
 */
export function generateCode(
  purpose: string,
  data: Record<string, string>,
  opts: { ttlMs?: number; friendly?: boolean; length?: number; formatted?: number } = {},
): string {
  const { ttlMs = DEFAULT_TTL_MS, friendly = false, length = 8, formatted } = opts;
  const raw = randomCode(length, friendly);
  codes.set(raw, { purpose, data, expiresAt: Date.now() + ttlMs });

  if (friendly && formatted) {
    // Insert dashes for readability: XXXX-XXXX
    const parts: string[] = [];
    for (let i = 0; i < raw.length; i += formatted) {
      parts.push(raw.slice(i, i + formatted));
    }
    return parts.join('-');
  }
  return raw;
}

/**
 * Validate a code without consuming it.
 * If matchData is provided, every key in matchData must match the stored data.
 */
export function validateCode(
  code: string,
  purpose: string,
  matchData?: Record<string, string>,
): Record<string, string> | null {
  const normalized = code.replace(/[-\s]/g, '').toUpperCase();
  // Try both normalized and original (for base64url codes which are case-sensitive)
  const entry = codes.get(normalized) || codes.get(code);
  if (!entry) return null;
  if (entry.purpose !== purpose) return null;
  if (Date.now() > entry.expiresAt) {
    codes.delete(normalized);
    codes.delete(code);
    return null;
  }
  if (matchData) {
    for (const [k, v] of Object.entries(matchData)) {
      if (entry.data[k] !== v) return null;
    }
  }
  return { ...entry.data };
}

/**
 * Validate and consume (delete) a code. Returns data on success, null on failure.
 */
export function consumeCode(
  code: string,
  purpose: string,
): Record<string, string> | null {
  const normalized = code.replace(/[-\s]/g, '').toUpperCase();
  const entry = codes.get(normalized) || codes.get(code);
  if (!entry) return null;
  if (entry.purpose !== purpose) return null;
  if (Date.now() > entry.expiresAt) {
    codes.delete(normalized);
    codes.delete(code);
    return null;
  }
  codes.delete(normalized);
  codes.delete(code);
  return { ...entry.data };
}

// ── Legacy Convenience Wrappers ──────────────────────────────────
// Keep backward compat for attachment codes

export function generateAccessCode(attachmentId: string, ttlMs = DEFAULT_TTL_MS): string {
  return generateCode('attachment', { attachmentId }, { ttlMs });
}

export function validateAccessCode(code: string, attachmentId: string): boolean {
  return validateCode(code, 'attachment', { attachmentId }) !== null;
}

// Periodic cleanup of expired codes
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of codes) {
    if (now > entry.expiresAt) codes.delete(code);
  }
}, 10 * 60 * 1000); // every 10 minutes
