import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

interface AccessCode {
  attachmentId: string;
  expiresAt: number;
}

const codes = new Map<string, AccessCode>();

export function generateAccessCode(attachmentId: string, ttlMs = DEFAULT_TTL_MS): string {
  const code = crypto.randomBytes(6).toString('base64url'); // 8 chars
  codes.set(code, { attachmentId, expiresAt: Date.now() + ttlMs });
  return code;
}

export function validateAccessCode(code: string, attachmentId: string): boolean {
  const entry = codes.get(code);
  if (!entry) return false;
  if (entry.attachmentId !== attachmentId) return false;
  if (Date.now() > entry.expiresAt) {
    codes.delete(code);
    return false;
  }
  return true;
}

// Periodic cleanup of expired codes
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of codes) {
    if (now > entry.expiresAt) codes.delete(code);
  }
}, 10 * 60 * 1000); // every 10 minutes
