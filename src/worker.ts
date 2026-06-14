/**
 * Txtshell Worker — encrypted blob storage + inbox.
 * Spec: worker-spec.md v0.1. Single-user, self-hosted. E2EE preserved:
 * the Worker only ever sees ciphertext and never decrypts or logs bodies.
 */

export interface Env {
  STORAGE: R2Bucket;
  AUTH_SECRET: string;
}

// TODO: replace with auth-derived userId for multi-user
const USER_ID = "kavan";

const BLOCKS_KEY = `users/${USER_ID}/blocks.encrypted`;
const INBOX_KEY = `users/${USER_ID}/inbox.json`;

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB
const INBOX_CAP = 1000;

const ALLOWED_ORIGINS = [
  "https://txtshell.com",
  "https://www.txtshell.com",
  "http://localhost:8080",
];

const ALLOWED_METHODS = ["GET", "PUT", "POST", "DELETE", "OPTIONS"];

interface InboxEntry {
  id: string;
  ciphertext: string;
  iv: string;
  createdAt: string;
}

// ---------- helpers ----------

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/** Base headers applied to EVERY response: no-store + reflected CORS origin. */
function baseHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
  };
  // Reflect the request origin only if it's allow-listed (handles >1 allowed origin).
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Vary"] = "Origin";
  }
  return h;
}

function jsonResponse(
  status: number,
  body: unknown,
  origin: string | null,
  extra: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...baseHeaders(origin),
      ...extra,
    },
  });
}

function errorResponse(
  status: number,
  error: string,
  message: string,
  origin: string | null
): Response {
  return jsonResponse(status, { error, message }, origin);
}

// ---------- entry point ----------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);

    // (1) HTTPS check
    if (url.protocol !== "https:") {
      return errorResponse(400, "https-required", "HTTPS is required", origin);
    }

    // (2) CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...baseHeaders(origin),
          "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // (3) Method check
    if (!ALLOWED_METHODS.includes(request.method)) {
      return errorResponse(405, "method-not-allowed", "Method not supported on this endpoint", origin);
    }

    // (4) CORS origin check (no Origin header => curl/native app => pass)
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return errorResponse(403, "forbidden-origin", "Origin not allowed", origin);
    }

    // (5) Constant-time auth check
    const authHeader = request.headers.get("Authorization") || "";
    const prefix = "Bearer ";
    const presented = authHeader.startsWith(prefix) ? authHeader.slice(prefix.length) : "";
    if (presented === "" || !constantTimeEqual(presented, env.AUTH_SECRET)) {
      return errorResponse(401, "unauthorized", "Missing or invalid auth token", origin);
    }

    // (6) Content-Length cap for bodied methods
    if (request.method === "PUT" || request.method === "POST") {
      const len = request.headers.get("Content-Length");
      if (len !== null && Number(len) > MAX_BODY_BYTES) {
        return errorResponse(413, "payload-too-large", "Request body exceeds 5MB limit", origin);
      }
    }

    // (7) baseHeaders() injects Cache-Control on every response below.

    // ---------- routing ----------
    const path = url.pathname;
    try {
      if (path === "/v1/blocks") {
        if (request.method === "PUT") return await putBlocks(request, env, origin);
        if (request.method === "GET") return await getBlocks(env, origin);
        return errorResponse(405, "method-not-allowed", "Method not supported on this endpoint", origin);
      }
      if (path === "/v1/inbox") {
        if (request.method === "POST") return await postInbox(request, env, origin);
        if (request.method === "GET") return await getInbox(env, origin);
        if (request.method === "DELETE") return await deleteInbox(request, env, origin);
        return errorResponse(405, "method-not-allowed", "Method not supported on this endpoint", origin);
      }
      return errorResponse(404, "not-found", "No such endpoint", origin);
    } catch {
      // Fail closed; do NOT echo internals or request bodies.
      return errorResponse(500, "internal-error", "Unexpected error", origin);
    }
  },
};

// ---------- handlers ----------

async function putBlocks(request: Request, env: Env, origin: string | null): Promise<Response> {
  const body = await request.arrayBuffer();
  // Second, authoritative size guard: Content-Length can be absent or lie (chunked).
  if (body.byteLength > MAX_BODY_BYTES) {
    return errorResponse(413, "payload-too-large", "Request body exceeds 5MB limit", origin);
  }
  await env.STORAGE.put(BLOCKS_KEY, body);
  return jsonResponse(200, { ok: true }, origin);
}

async function getBlocks(env: Env, origin: string | null): Promise<Response> {
  const obj = await env.STORAGE.get(BLOCKS_KEY);
  if (obj === null) {
    return errorResponse(404, "no-blob", "No blocks blob exists for this user", origin);
  }
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      ...baseHeaders(origin),
    },
  });
}

async function readInbox(env: Env): Promise<InboxEntry[]> {
  const obj = await env.STORAGE.get(INBOX_KEY);
  if (obj === null) return [];
  const parsed = JSON.parse(await obj.text());
  if (!Array.isArray(parsed)) throw new Error("inbox-corrupt"); // fail closed -> 500
  return parsed as InboxEntry[];
}

async function postInbox(request: Request, env: Env, origin: string | null): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, "bad-request", "Body must be valid JSON", origin);
  }
  if (!isInboxEntry(payload)) {
    return errorResponse(400, "bad-request", "Entry requires string id, ciphertext, iv, createdAt", origin);
  }
  const inbox = await readInbox(env);
  if (inbox.length >= INBOX_CAP) {
    return errorResponse(413, "inbox-full", "Inbox is at capacity; triage existing entries first", origin);
  }
  const entry: InboxEntry = {
    id: payload.id,
    ciphertext: payload.ciphertext,
    iv: payload.iv,
    createdAt: payload.createdAt,
  };
  inbox.push(entry);
  await env.STORAGE.put(INBOX_KEY, JSON.stringify(inbox));
  return jsonResponse(200, { id: entry.id, accepted: true }, origin);
}

async function getInbox(env: Env, origin: string | null): Promise<Response> {
  const inbox = await readInbox(env);
  return jsonResponse(200, inbox, origin);
}

async function deleteInbox(request: Request, env: Env, origin: string | null): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, "bad-request", "Body must be valid JSON", origin);
  }
  if (
    typeof payload !== "object" || payload === null ||
    !Array.isArray((payload as { ids?: unknown }).ids) ||
    !(payload as { ids: unknown[] }).ids.every((x) => typeof x === "string")
  ) {
    return errorResponse(400, "bad-request", "Body must have ids: string[]", origin);
  }
  const ids = new Set<string>((payload as { ids: string[] }).ids);
  const inbox = await readInbox(env);
  const remaining = inbox.filter((e) => !ids.has(e.id));
  const removed = inbox.length - remaining.length;
  await env.STORAGE.put(INBOX_KEY, JSON.stringify(remaining));
  return jsonResponse(200, { removed, remaining: remaining.length }, origin);
}

function isInboxEntry(v: unknown): v is InboxEntry {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as InboxEntry).id === "string" &&
    typeof (v as InboxEntry).ciphertext === "string" &&
    typeof (v as InboxEntry).iv === "string" &&
    typeof (v as InboxEntry).createdAt === "string"
  );
}
