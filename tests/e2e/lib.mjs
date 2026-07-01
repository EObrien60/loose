import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

// Node <22 has no global WebSocket; the `ws` package provides it. Expose it globally so
// every suite (and this module) can use `WebSocket` uniformly regardless of Node version.
if (!globalThis.WebSocket) globalThis.WebSocket = WebSocket;

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const HTTP = "http://localhost:8787";
export const WS = "ws://localhost:8787/ws";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── server lifecycle ──────────────────────────────────────────────
// Spawn tsx (the server) directly as a single child — no pnpm/detached wrapper, so it's
// cleanly killable in any CI/runner.
const SERVER_DIR = resolve(REPO, "apps/server");

export function startServer(env) {
  // `node --import tsx` runs the server in a SINGLE process (tsx-as-loader), so kill() actually
  // stops it — unlike the `tsx` CLI, which forks a child node that would outlive a parent kill.
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: "8787", ...env },
    stdio: ["ignore", "ignore", "inherit"],
  });
  return child;
}
export function stopServer(child) {
  try {
    child?.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}
export async function waitHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(HTTP + "/healthz");
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("server did not become healthy in time");
}

// ── HTTP helpers ──────────────────────────────────────────────────
export async function post(path, body, token) {
  const r = await fetch(HTTP + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
export async function get(path, token) {
  const r = await fetch(HTTP + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}
export const register = (email, opts = {}) => post("/auth/register", { email, password: "secret1", displayName: "U", ...opts });

// ── WS client with awaitable inbox ────────────────────────────────
export function wsClient(token) {
  const ws = new WebSocket(WS);
  const inbox = [];
  const waiters = [];
  ws.onopen = () => ws.send(JSON.stringify({ type: "auth", sessionToken: token }));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    inbox.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].pred(m)) { waiters[i].resolve(m); waiters.splice(i, 1); }
  };
  const waitFor = (pred, ms = 3000) =>
    new Promise((resolve, reject) => {
      const hit = inbox.find(pred);
      if (hit) return resolve(hit);
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error("ws timeout")), ms);
    });
  return { ws, send: (m) => ws.send(JSON.stringify(m)), waitFor, inbox };
}

// ── test recorder ─────────────────────────────────────────────────
export class Recorder {
  constructor() {
    this.passed = 0;
    this.failed = 0;
  }
  section(name) {
    console.log(`  ${name}`);
  }
  check(name, cond, detail = "") {
    if (cond) {
      this.passed++;
      console.log(`    ✅ ${name}`);
    } else {
      this.failed++;
      process.exitCode = 1;
      console.log(`    ❌ ${name} ${detail}`);
    }
  }
}
