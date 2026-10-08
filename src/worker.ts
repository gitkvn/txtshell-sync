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

// Conditional PUT (generation CAS). The blob's generation lives in R2 customMetadata and is
// returned as ETag "g<N>" (+ X-Blob-Generation: N). A client that sends If-Match: "g<N>" gets
// 412 if the cloud has moved on; a client that sends no If-Match overwrites unconditionally,
// exactly as before — so neither an older app nor an older Worker breaks whichever updates first.
const GENERATION_META = "generation";
const CORS_ALLOW_HEADERS = "Authorization, Content-Type, If-Match, If-None-Match";
const CORS_EXPOSE_HEADERS = "ETag, X-Blob-Generation";

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
    h["Access-Control-Expose-Headers"] = CORS_EXPOSE_HEADERS; // the browser hides ETag cross-origin otherwise
    h["Vary"] = "Origin";
  }
  return h;
}

/** The generation headers for a blob at generation N. */
function generationHeaders(generation: number): Record<string, string> {
  return { ETag: `"g${generation}"`, "X-Blob-Generation": String(generation) };
}

/** Parses If-Match / If-None-Match of the form "g<N>" (quotes optional, weak prefix tolerated). */
function parseGeneration(header: string | null): number | null {
  if (header === null) return null;
  const m = header.trim().match(/^(?:W\/)?"?g(\d+)"?$/);
  return m ? Number(m[1]) : null;
}

/** The generation an existing object carries; an object written before this Worker knew about
 *  generations counts as generation 1. */
function generationOf(obj: R2Object): number {
  const raw = obj.customMetadata?.[GENERATION_META];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : 1;
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
          "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
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
        if (request.method === "GET") return await getBlocks(request, env, origin);
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
  const ifMatch = request.headers.get("If-Match");
  const expected = parseGeneration(ifMatch);
  if (ifMatch !== null && expected === null) {
    return errorResponse(400, "bad-if-match", 'If-Match must be "g<generation>"', origin);
  }

  if (expected === null) {
    // Legacy / unconditional: overwrite, as this Worker always has. The new generation is
    // still recorded and returned so a client that understands it can start from here.
    const current = await env.STORAGE.head(BLOCKS_KEY);
    const next = current === null ? 1 : generationOf(current) + 1;
    await env.STORAGE.put(BLOCKS_KEY, body, { customMetadata: { [GENERATION_META]: String(next) } });
    return jsonResponse(200, { ok: true, generation: next }, origin, generationHeaders(next));
  }

  // Conditional: the client's base must be the cloud's generation. The write itself is also
  // conditional on R2's own etag so two writers with the same base cannot both win.
  const current = await env.STORAGE.head(BLOCKS_KEY);
  const currentGeneration = current === null ? 0 : generationOf(current);
  if (currentGeneration !== expected) {
    return jsonResponse(412, { error: "generation-mismatch", message: "The cloud copy has changed since this device last synced", current: currentGeneration }, origin, generationHeaders(currentGeneration));
  }
  const next = currentGeneration + 1;
  const onlyIf: R2Conditional = current === null ? { etagDoesNotMatch: "*" } : { etagMatches: current.etag };
  const written = await env.STORAGE.put(BLOCKS_KEY, body, { customMetadata: { [GENERATION_META]: String(next) }, onlyIf });
  if (written === null) {
    // Lost the race between head() and put(): report what is there now.
    const now = await env.STORAGE.head(BLOCKS_KEY);
    const nowGeneration = now === null ? 0 : generationOf(now);
    return jsonResponse(412, { error: "generation-mismatch", message: "The cloud copy has changed since this device last synced", current: nowGeneration }, origin, generationHeaders(nowGeneration));
  }
  return new Response(null, { status: 204, headers: { ...baseHeaders(origin), ...generationHeaders(next) } });
}

async function getBlocks(request: Request, env: Env, origin: string | null): Promise<Response> {
  const obj = await env.STORAGE.get(BLOCKS_KEY);
  if (obj === null) {
    return jsonResponse(404, { error: "no-blob", message: "No blocks blob exists for this user" }, origin, { "X-Blob-Generation": "0" });
  }
  const generation = generationOf(obj);
  const ifNoneMatch = parseGeneration(request.headers.get("If-None-Match"));
  if (ifNoneMatch !== null && ifNoneMatch === generation) {
    return new Response(null, { status: 304, headers: { ...baseHeaders(origin), ...generationHeaders(generation) } });
  }
  return new Response(obj.body, {
    status: 200,
    headers: {
      "Content-Type": "application/octet-stream",
      ...baseHeaders(origin),
      ...generationHeaders(generation),
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
