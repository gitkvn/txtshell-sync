// Gates for the self-hosted Worker's conditional PUT (Phase D stage 3, txtshell-central
// docs/phase-d-plan.md §11, G-D5 / G-D6) and the compatibility matrix: whichever side updates
// first, nothing breaks — INCLUDING the CORS preflight, which the plan's matrix had missed.
//
//   node test/gates.mjs                (CHROME=/path/to/chrome, TXTSHELL=/path/to/txtshell checkout)
//
// Real browsers, real cross-origin requests: the app is served from http://localhost:8080 (an
// origin this Worker allow-lists), the Workers run under `wrangler dev --local-protocol https`
// on other ports, so every PUT/GET is cross-origin and preflighted exactly as on txtshell.com.
//   new Worker  = src/worker.ts (this checkout)        on https://localhost:8789
//   old Worker  = src/worker.ts at 19e3a98 (shipped)   on https://localhost:8790
//   new app     = ../txtshell (this checkout)          old app = txtshell at dd76bf7 (shipped)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // the gate's own fetches to the self-signed local Workers
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TXTSHELL = process.env.TXTSHELL || path.resolve(ROOT, "../txtshell");
const OLD_WORKER_REV = "19e3a98";
const OLD_APP_REV = "dd76bf7";
const APP_PORT = 8080;
const NEW_PORT = 8789;
const OLD_PORT = 8790;
const CDP_PORT = 9351;
const APP = `http://localhost:${APP_PORT}`;
const NEW = `https://localhost:${NEW_PORT}`;
const OLD = `https://localhost:${OLD_PORT}`;
const TOKEN = "stub-token";
const PASS = "correct horse battery";

function defaultChrome() {
  if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const found = ["/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/chromium-browser"].find((p) => existsSync(p));
  if (found) return found;
  throw new Error("No Chrome binary found; set CHROME=/path/to/chrome");
}
const CHROME = process.env.CHROME || defaultChrome();

let failures = 0;
const check = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) failures++; return !!c; };
const procs = [];
process.on("exit", () => procs.forEach((p) => { try { p.kill(); } catch {} }));
async function waitFor(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(100); } return false; }

// ---------- materialise the shipped versions ----------
const scratch = mkdtempSync(path.join(tmpdir(), "txtshell-sync-gates-"));
const oldWorkerDir = path.join(scratch, "old-worker"); mkdirSync(path.join(oldWorkerDir, "src"), { recursive: true });
writeFileSync(path.join(oldWorkerDir, "src/worker.ts"), execFileSync("git", ["show", `${OLD_WORKER_REV}:src/worker.ts`], { cwd: ROOT, encoding: "utf8" }));
writeFileSync(path.join(oldWorkerDir, "wrangler.toml"), `name = "txtshell-sync-old"\nmain = "src/worker.ts"\ncompatibility_date = "2026-01-01"\n[[r2_buckets]]\nbinding = "STORAGE"\nbucket_name = "txtshell-sync-storage"\n`);
const oldAppDir = path.join(scratch, "old-app"); mkdirSync(oldAppDir);
execFileSync("sh", ["-c", `git -C "${TXTSHELL}" archive ${OLD_APP_REV} | tar -x -C "${oldAppDir}"`]);
check(existsSync(path.join(oldAppDir, "app.js")) && !existsSync(path.join(oldAppDir, "central.js")), `old app materialised from txtshell@${OLD_APP_REV} (no central.js)`);

// ---------- the two Workers ----------
async function portFree(port) { return !(await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)) && !(await fetch(`https://127.0.0.1:${port}/`).then(() => true, () => false)); }
for (const port of [NEW_PORT, OLD_PORT, CDP_PORT]) if (!(await waitFor(() => portFree(port), 30000))) { console.error(`port ${port} still in use`); process.exit(2); }
function startWorker(name, configDir, port, persist) {
  // Always run wrangler from this checkout (its node_modules); point it at the config to use.
  const args = ["wrangler", "dev", "--config", path.join(configDir, "wrangler.toml"), "--local", "--local-protocol", "https", "--port", String(port), "--inspector-port", String(port + 1000), "--var", `AUTH_SECRET:${TOKEN}`, "--persist-to", persist];
  const p = spawn("npx", args, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  procs.push(p);
  const log = []; p.stdout.on("data", (d) => log.push(String(d))); p.stderr.on("data", (d) => log.push(String(d)));
  return { name, log };
}
const newWorker = startWorker("new", ROOT, NEW_PORT, path.join(scratch, "state-new"));
const oldWorker = startWorker("old", oldWorkerDir, OLD_PORT, path.join(scratch, "state-old"));
for (const [base, w] of [[NEW, newWorker], [OLD, oldWorker]]) {
  const up = await waitFor(async () => (await fetch(`${base}/v1/blocks`)).status === 401, 90000);
  check(up, `${w.name} Worker up at ${base} (401 without a token)`);
  if (!up) { console.log(w.log.join("").slice(-2000)); process.exit(1); }
}

// ---------- static app server (root swappable: old app first, then the checkout) ----------
let appRoot = oldAppDir;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };
const server = createServer((req, res) => {
  const url = new URL(req.url, APP);
  const file = path.join(appRoot, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
  if (!file.startsWith(appRoot) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(APP_PORT, r));

// ---------- CDP ----------
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${path.join(scratch, "profile")}`, "--no-first-run", "--ignore-certificate-errors", "--disable-gpu", "about:blank"], { stdio: "ignore" });
procs.push(chrome);
let wsUrl; for (let i = 0; i < 60 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch {} if (!wsUrl) await sleep(250); }
const ws = new WebSocket(wsUrl); await new Promise((r) => (ws.onopen = r));
let nextId = 1; const pending = new Map(); const listeners = [];
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } else if (m.method) for (const fn of listeners) fn(m); };
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, sessionId })); });

async function device(name) {
  const { browserContextId } = await send("Target.createBrowserContext", {});
  const { targetId } = await send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Runtime.enable", {}, sessionId); await send("Page.enable", {}, sessionId); await send("Network.enable", {}, sessionId);
  const trace = []; const failed = [];
  listeners.push((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Network.requestWillBeSent") trace.push({ id: m.params.requestId, method: m.params.request.method, url: m.params.request.url, headers: m.params.request.headers, type: m.params.type, status: null, resHeaders: null });
    if (m.method === "Network.responseReceived") { const t = trace.find((r) => r.id === m.params.requestId); if (t) { t.status = m.params.response.status; t.resHeaders = m.params.response.headers; } }
    if (m.method === "Network.loadingFailed") { const t = trace.find((r) => r.id === m.params.requestId); failed.push({ url: t?.url, method: t?.method, error: m.params.errorText, cors: m.params.corsErrorStatus?.corsError, blocked: m.params.blockedReason }); }
  });
  const d = { name, sessionId, trace, failed };
  d.eval = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)); return r.result.value; };
  await send("Page.navigate", { url: `${APP}/` }, sessionId);
  await waitFor(() => d.eval(`document.readyState === "complete" && typeof state === "object" && state.db !== null`));
  await sleep(200);
  d.cmd = (text) => d.eval(`(setEditorValue(${JSON.stringify(text)}), submitComposer(), true)`);
  d.fill = (field, value) => d.eval(`(() => { const i = vaultOverlay.querySelector('[data-field="${field}"]'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event("input")); return true; })()`);
  d.click = (action) => d.eval(`(vaultOverlay.querySelector('[data-action="${action}"]').click(), true)`);
  d.view = () => d.eval(`state.vaultView`);
  d.unlocked = () => d.eval(`state.encryption.enabled && state.encryption.unlocked`);
  d.hint = () => d.eval(`composerHint.textContent`);
  d.toast = () => d.eval(`statusToast ? statusToast.textContent : ""`);
  d.entries = () => d.eval(`state.entries.map((e) => e.text)`);
  d.meta = (key) => d.eval(`getMeta(${JSON.stringify(key)})`);
  d.add = (text) => d.eval(`createEntryFromText(${JSON.stringify(text)}).id`);
  d.push = () => d.eval(`flushCloudSync()`);
  d.pull = () => d.eval(`beginPull().then(() => true)`);
  d.settle = () => waitFor(() => d.eval(`pullHoldDepth === 0 && cloudSyncTimer === null && !cloudSyncInFlight`), 20000);
  d.encryptSetup = async () => {
    await d.cmd("/encrypt"); await waitFor(() => d.view().then((v) => v === "setup"));
    await d.fill("pass", PASS); await d.fill("confirm", PASS); await d.click("submit");
    await waitFor(() => d.view().then((v) => v === "recovery-display")); await d.click("confirm");
    return waitFor(() => d.unlocked());
  };
  d.syncSetup = async (workerUrl) => {
    await d.cmd("/sync setup"); await waitFor(() => d.view().then((v) => v === "sync-setup"));
    await d.fill("url", workerUrl); await d.fill("token", TOKEN); await d.click("submit");
    await waitFor(() => d.view().then((v) => v === null));
    await waitFor(() => d.hint().then((h) => /^(Synced|Uploaded|Sync failed|Sync auth failed|Cloud has)/.test(h)), 15000);
    await d.settle();
    return d.hint();
  };
  d.rawKey = () => d.eval(`(async () => {
    const wk = await deriveWrappingKey(${JSON.stringify(PASS)}, base64ToBytes(await getMeta(ENC_SALT_PASS_KEY)), await readIterations(ENC_ITERATIONS_PASS_KEY));
    const m = await unwrapMasterKey(await getMeta(ENC_WRAPPED_PASS_KEY), wk, true);
    return bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("raw", m)));
  })()`);
  d.port = async (workerUrl, rawKey) => {
    await d.cmd("/port"); await waitFor(() => d.view().then((v) => v === "port-paste"));
    await d.fill("pairing", JSON.stringify({ workerUrl, authToken: TOKEN, masterKey: rawKey })); await d.click("submit");
    await waitFor(() => d.view().then((v) => v === "port-passphrase"));
    await d.fill("pass", PASS); await d.fill("confirm", PASS); await d.click("submit");
    await waitFor(() => d.unlocked());
    await waitFor(() => d.hint().then((h) => /^Paired/.test(h)), 15000);
    await d.settle();
  };
  d.blocksTrace = () => trace.filter((r) => r.url.endsWith("/v1/blocks") && r.method !== "OPTIONS").map((r) => `${r.method} ${r.status}${r.headers["If-Match"] ? ` If-Match=${r.headers["If-Match"]}` : ""}${r.headers["If-None-Match"] ? ` If-None-Match=${r.headers["If-None-Match"]}` : ""}${r.resHeaders?.etag || r.resHeaders?.ETag ? ` ETag=${r.resHeaders.etag || r.resHeaders.ETag}` : ""}`);
  d.preflights = () => trace.filter((r) => r.url.endsWith("/v1/blocks") && r.type === "Preflight").map((r) => `OPTIONS ${r.status} ${r.headers["Access-Control-Request-Headers"] || ""}`);
  d.corsFailures = () => failed.filter((f) => f.url?.includes("/v1/"));
  return d;
}

// ============================================================================
console.log(`\n--- (1) OLD app (${OLD_APP_REV}) × NEW Worker: the unconditional path, through a real preflight`);
{
  appRoot = oldAppDir;
  const A = await device("old-app-A");
  check(await A.eval(`typeof isCentral === "undefined" && typeof window.txCentral === "undefined"`), "old app has no central code");
  await A.encryptSetup(); await A.add("a1");
  const hint = await A.syncSetup(NEW);
  check(/^Synced — 1 block/.test(hint), `old app /sync setup against the new Worker: "${hint}"`);
  await A.add("a2"); await A.settle();
  const t = A.blocksTrace();
  const putsA = t.filter((x) => x.startsWith("PUT"));
  check(putsA.length >= 2 && putsA.every((x) => /^PUT 200/.test(x) && !/If-Match/.test(x)), `old app pushes carry no If-Match and get 200 (lenient): ${t.join(" | ")}`);
  // A cross-origin PUT with Authorization is always preflighted; a refused preflight surfaces as
  // Network.loadingFailed with a corsError and a null status. Success + no failure = preflight passed.
  check(A.corsFailures().length === 0 && putsA.every((x) => !/PUT null/.test(x)), `no request to the new Worker failed CORS (${JSON.stringify(A.corsFailures())})`);
  const B = await device("old-app-B");
  await B.port(NEW, await A.rawKey());
  check((await B.entries()).includes("a1") && (await B.entries()).includes("a2"), "old app device B pairs and pulls from the new Worker");
  await B.add("b1"); await B.settle();
  await A.pull();
  check(await waitFor(() => A.view().then((v) => v === "pull-conflict")), "old app A: /pull → cloud-ahead card (B's block)");
  await A.click("replace"); await waitFor(() => A.view().then((v) => v === null));
  check((await A.entries()).includes("b1") && A.corsFailures().length === 0 && B.corsFailures().length === 0, "old app round trip complete; zero CORS failures on either device");
}

// ============================================================================
console.log(`\n--- (2) NEW app × OLD Worker (${OLD_WORKER_REV}): byte-identical requests, no new header, one hint`);
{
  appRoot = TXTSHELL;
  const C = await device("new-app-C");
  check(await C.eval(`typeof isCentral === "function" && isCentral() === false`), "new app, passphrase mode");
  await C.encryptSetup(); await C.add("c1");
  const hint = await C.syncSetup(OLD);
  check(/^Synced — 1 block/.test(hint), `new app /sync setup against the OLD Worker: "${hint}"`);
  check(await waitFor(() => C.toast().then((t) => /Update your sync Worker/.test(t)), 8000), `legacy hint shown once: "${await C.toast()}"`);
  await C.add("c2"); await C.settle();
  await C.pull(); await C.settle();
  const t = C.blocksTrace();
  check(t.filter((x) => x.startsWith("PUT")).length >= 2 && t.every((x) => !/If-Match|If-None-Match/.test(x)), `no conditional header ever sent to the old Worker: ${t.join(" | ")}`);
  check((await C.meta("sync-last-synced-generation")) === "", "no generation stored (the old Worker sends no ETag)");
  check(C.corsFailures().length === 0 && !t.some((x) => /412|428|null/.test(x)), "no CORS failure, no 412/428 against the old Worker");
  check(/Already up to date/.test(await C.hint()), `pull against the old Worker: "${await C.hint()}"`);
  const shown = await C.eval(`JSON.parse(localStorage.getItem("txtshell-hints-v1") || "[]")`);
  check(shown.includes("sync-legacy-worker"), "hint recorded as shown (never repeats)");
}

// ============================================================================
console.log("\n--- (3) NEW app × NEW Worker: generations, 304, 412 → pull → card → Keep → 204 (G-D4 on the self-hosted path)");
{
  appRoot = TXTSHELL;
  const D = await device("new-app-D");
  await D.encryptSetup(); await D.add("d1");
  const hint = await D.syncSetup(NEW);
  check(/^Synced — 1 block/.test(hint), `new app /sync setup against the new Worker: "${hint}" (the read-back is a 304 against the pushed generation)`);
  // The single-user Worker's store carries over from part (1): generations are relative to what
  // the first push returned, not absolute.
  const gen = async (d) => Number(await d.meta("sync-last-synced-generation"));
  const g1 = await gen(D);
  const first = D.blocksTrace().find((x) => x.startsWith("PUT"));
  check(g1 >= 1 && /^PUT 200 ETag=/.test(first) && !/If-Match/.test(first), `first push (no generation yet) → unconditional 200 + ETag (${first}); generation now ${g1} after the setup's pushes`);
  await D.add("d2"); await D.settle();
  check(await waitFor(async () => (await gen(D)) === g1 + 1, 5000) && new RegExp(`PUT 204 If-Match="g${g1}" ETag="g${g1 + 1}"`).test(D.blocksTrace().at(-1)), `second push → If-Match "g${g1}" → 204 ETag "g${g1 + 1}": ${D.blocksTrace().at(-1)}`);
  await D.pull(); await D.settle();
  let t = D.blocksTrace();
  check(new RegExp(`GET 304 If-None-Match="g${g1 + 1}"`).test(t.at(-1)) && /Already up to date/.test(await D.hint()), `pull unchanged → If-None-Match → 304: ${t.at(-1)}`);
  check(D.corsFailures().filter((f) => f.cors || f.blocked).length === 0, `conditional headers passed the new Worker's preflight (no CORS failure; ${t.length} /v1/blocks requests; failed: ${JSON.stringify(D.corsFailures())})`);
  const E = await device("new-app-E");
  await E.port(NEW, await D.rawKey()); // pairing pulls, merges, and its saves push the same set straight back
  check((await E.entries()).length === 2 && (await gen(E)) >= g1 + 1, `device E pairs, loads 2 blocks, records the generation it pulled (${await gen(E)}) and its first push was conditional: ${E.blocksTrace().filter((x) => x.startsWith("PUT")).join(" | ")}`);
  await D.pull(); await D.settle(); // D catches up to E's re-push (identical content → generation recorded)
  const gE = await gen(E);
  check((await gen(D)) === gE, `D and E agree on the generation (${gE})`);
  await D.add("d3"); await D.settle();
  check((await gen(D)) === gE + 1, `D pushes → g${gE + 1} while E still believes g${gE}`);
  const putsBefore = E.blocksTrace().filter((x) => x.startsWith("PUT")).length;
  await E.add("e1"); // → push If-Match g<gE> → 412 → quiet pull → card
  check(await waitFor(() => E.view().then((v) => v === "pull-conflict"), 15000), `E's stale push → 412 → pull → card (${await E.view()})`);
  t = E.blocksTrace().slice(-2);
  check(new RegExp(`PUT 412 If-Match="g${gE}"`).test(t[0]) && /GET 200/.test(t[1]), `trace: ${t.join(" → ")}`);
  await sleep(1500);
  check(E.blocksTrace().filter((x) => x.startsWith("PUT")).length === putsBefore + 1, "push-hold: zero PUTs while the card is showing");
  const title = await E.eval(`vaultOverlay.querySelector(".vault-title")?.textContent || ""`);
  check(/diverged/.test(title), `card: "${title}"`);
  await E.click("keep"); await waitFor(() => E.view().then((v) => v === null)); await E.settle();
  t = E.blocksTrace().at(-1);
  check(new RegExp(`PUT 204 If-Match="g${gE + 1}" ETag="g${gE + 2}"`).test(t) && (await gen(E)) === gE + 2, `Keep local → PUT If-Match "g${gE + 1}" → 204 g${gE + 2}: ${t}`);
  await D.pull();
  check(await waitFor(() => D.view().then((v) => v === "pull-conflict")), "D /pull → card (E's overwrite)");
  await D.click("replace"); await waitFor(() => D.view().then((v) => v === null)); await D.settle();
  // Replace re-saves the adopted set, and those saves push it straight back (conditional on the
  // generation just pulled), so D ends one generation past what it pulled.
  const putsD = D.blocksTrace().filter((x) => x.startsWith("PUT"));
  check((await D.entries()).includes("e1") && (await gen(D)) >= gE + 2 && putsD.at(-1).includes(`If-Match="g${gE + 2}"`) && /PUT 204/.test(putsD.at(-1)), `D Replace → E's set; its re-push was conditional on the pulled generation ${gE + 2}: ${putsD.at(-1)} → generation ${await gen(D)}`);
}

// ============================================================================
console.log("\n--- (4) G-D5 at the API (new Worker): lenient, 304, concurrent CAS, stale replay, metadata, preflight");
{
  const put = (body, ifMatch, extra = {}) => fetch(`${NEW}/v1/blocks`, { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/octet-stream", ...(ifMatch !== undefined ? { "If-Match": ifMatch } : {}), ...extra }, body });
  const get = (ifNoneMatch) => fetch(`${NEW}/v1/blocks`, { headers: { Authorization: `Bearer ${TOKEN}`, ...(ifNoneMatch ? { "If-None-Match": ifNoneMatch } : {}) } });
  const gen = (r) => (r.headers.get("etag") || "").replace(/\D/g, "");
  let r = await put("unconditional-1");
  const g = Number(gen(r));
  check(r.status === 200 && (await r.json()).ok === true && g >= 1, `PUT without If-Match → 200 {ok} + ETag g${g} (lenient, never 428)`);
  r = await put("unconditional-2");
  check(r.status === 200 && Number(gen(r)) === g + 1, `another unconditional PUT → 200, generation increments (g${g + 1})`);
  r = await get(`"g${g + 1}"`);
  check(r.status === 304, `GET If-None-Match "g${g + 1}" → 304`);
  r = await get(`"g${g}"`);
  check(r.status === 200 && Number(gen(r)) === g + 1 && (await r.text()) === "unconditional-2", `GET If-None-Match "g${g}" → 200 body + ETag g${g + 1}`);
  r = await put("stale", `"g${g}"`);
  check(r.status === 412 && (await r.json()).current === g + 1, `stale If-Match "g${g}" → 412 {current: ${g + 1}}`);
  r = await put("conditional-ok", `"g${g + 1}"`);
  check(r.status === 204 && Number(gen(r)) === g + 2, `If-Match "g${g + 1}" → 204 ETag g${g + 2}`);
  r = await put("replay", `"g${g + 1}"`);
  check(r.status === 412, "replay of the same base → 412");
  const both = await Promise.all([put("race-a", `"g${g + 2}"`), put("race-b", `"g${g + 2}"`)]);
  const statuses = both.map((x) => x.status).sort();
  check(statuses.join(",") === "204,412", `two concurrent PUTs on the same base → one 204, one 412 (${statuses.join(",")})`);
  r = await put("bad", "g7");
  check(r.status === 204 || r.status === 412, `unquoted If-Match g7 tolerated as a generation (${r.status})`);
  r = await put("bad", "W/\"abc\"");
  check(r.status === 400 && (await r.json()).error === "bad-if-match", `malformed If-Match → 400 bad-if-match`);
  r = await get();
  check(r.status === 200 && r.headers.get("x-blob-generation") === gen(r), `GET carries X-Blob-Generation = ETag generation (${gen(r)})`);
  // First-upload race on an EMPTY store (etagDoesNotMatch: "*"): recorded, whatever local R2 does.
  const fresh = `https://localhost:${NEW_PORT}`; // same Worker; empty the key through an unconditional 0-byte PUT is not deletion — so record the behaviour via a fresh persist dir instead
  void fresh;
  const pre = await fetch(`${NEW}/v1/blocks`, { method: "OPTIONS", headers: { Origin: APP, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization,content-type,if-match" } });
  const allow = pre.headers.get("access-control-allow-headers") || "";
  check(pre.status === 204 && /If-Match/i.test(allow) && /If-None-Match/i.test(allow), `preflight allow-headers: ${allow}`);
  const exposed = (await fetch(`${NEW}/v1/blocks`, { headers: { Authorization: `Bearer ${TOKEN}`, Origin: APP } })).headers.get("access-control-expose-headers") || "";
  check(/ETag/i.test(exposed) && /X-Blob-Generation/i.test(exposed), `exposed to browsers (Origin ${APP}): ${exposed}`);
  const preOld = await fetch(`${OLD}/v1/blocks`, { method: "OPTIONS", headers: { Origin: APP, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization,content-type,if-match" } });
  check(!/If-Match/i.test(preOld.headers.get("access-control-allow-headers") || ""), `the OLD Worker's preflight does not allow If-Match (${preOld.headers.get("access-control-allow-headers")}) — why the client gates the header`);
}

// ============================================================================
console.log("\n--- (5) first-upload race on an empty store (etagDoesNotMatch \"*\"), recorded");
{
  const w = startWorker("empty", ROOT, NEW_PORT + 2, path.join(scratch, "state-empty"));
  const base = `https://localhost:${NEW_PORT + 2}`;
  check(await waitFor(async () => (await fetch(`${base}/v1/blocks`)).status === 401, 90000), "third Worker on an empty store up");
  const put = (body) => fetch(`${base}/v1/blocks`, { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/octet-stream", "If-Match": '"g0"' }, body });
  const both = await Promise.all([put("first-a"), put("first-b")]);
  const statuses = both.map((x) => x.status).sort().join(",");
  const after = await fetch(`${base}/v1/blocks`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  console.log(`      two concurrent first uploads with If-Match "g0": ${statuses}; store now at ${after.headers.get("etag")} body "${await after.text()}"`);
  check(statuses === "204,412" || statuses === "204,204", `first-upload race: ${statuses === "204,412" ? "local R2 honours etagDoesNotMatch \"*\" — exactly one wins" : "local R2 let both through (documented: the g0 race on a single-user Worker is accepted)"}`);
  void w;
}

console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILURE(S)"}`);
ws.close();
process.exit(failures ? 1 : 0);
