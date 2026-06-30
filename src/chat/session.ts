import { isRecord } from "../shared/guards";

export const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;

type SessionEnv = {
  SESSION_TTL_MS?: string;
};

export type SessionConfigResult =
  | { ok: true; ttlMs: number }
  | { ok: false; error: string };

export type SessionIdResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: string };

const MAX_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSION_ID_LENGTH = 512;

export function loadSessionTtlMs(env: SessionEnv): SessionConfigResult {
  const raw = env.SESSION_TTL_MS?.trim();
  if (!raw) {
    return { ok: true, ttlMs: DEFAULT_SESSION_TTL_MS };
  }

  const ttlMs = Number(raw);
  if (!Number.isInteger(ttlMs) || ttlMs < 1) {
    return { ok: false, error: "SESSION_TTL_MS must be a positive integer" };
  }
  if (ttlMs > MAX_SESSION_TTL_MS) {
    return { ok: false, error: `SESSION_TTL_MS must be <= ${MAX_SESSION_TTL_MS}` };
  }

  return { ok: true, ttlMs };
}

export function extractSessionIdFromBody(body: unknown): SessionIdResult {
  if (!isRecord(body) || typeof body.session_id !== "string") {
    return { ok: false, error: "session_id is required" };
  }

  const sessionId = body.session_id.trim();
  if (sessionId.length === 0) {
    return { ok: false, error: "session_id must not be empty" };
  }
  if (sessionId.length > MAX_SESSION_ID_LENGTH) {
    return { ok: false, error: `session_id must be <= ${MAX_SESSION_ID_LENGTH} characters` };
  }

  return { ok: true, sessionId };
}

export async function durableObjectNameForSession(sessionId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionId));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `session:${hex}`;
}
