import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, stopServer, waitHealth, sleep } from "./lib.mjs";
import { chatSuite, collabSuite, tenancySuite, journeysSuite, providersSuite } from "./suites.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "loose-e2e-"));

// Driver matrix — each config boots a fresh server and runs every suite, proving the app
// is vendor-neutral: the same flows pass on in-memory, on Postgres+LiveKit, and on an
// explicitly-swapped driver set with no external services.
const CONFIGS = [
  {
    label: "defaults (memory store, local files, echo llm, no media/billing)",
    env: { FILES_DIR: tmp() },
    expect: { store: "memory", pubsub: "memory", storage: "local", llm: "echo", media: "none", billing: "none", analytics: "noop" },
  },
  {
    // Uses a real Postgres when LOOSE_E2E_PG_URL is set (CI service container), else embedded PGlite.
    // Either way it's the same SQL + migrations (auto-applied on boot).
    label: process.env.LOOSE_E2E_PG_URL ? "real postgres + livekit media" : "postgres (pglite) + livekit media",
    env: {
      DATABASE_URL: process.env.LOOSE_E2E_PG_URL ?? `pglite://${tmp()}`,
      FILES_DIR: tmp(),
      LIVEKIT_URL: "wss://fake.livekit.cloud",
      LIVEKIT_API_KEY: "devkey",
      LIVEKIT_API_SECRET: "devsecretdevsecretdevsecret123456",
    },
    expect: { store: process.env.LOOSE_E2E_PG_URL ? "postgres" : "pglite", pubsub: "memory", storage: "local", llm: "echo", media: "livekit", billing: "none", analytics: "noop" },
  },
  {
    label: "fully swapped (memory storage, explicit echo/none drivers)",
    env: { STORAGE_DRIVER: "memory", LLM_DRIVER: "echo", MEDIA_DRIVER: "none", BILLING_DRIVER: "none", ANALYTICS_DRIVER: "noop" },
    expect: { store: "memory", pubsub: "memory", storage: "memory", llm: "echo", media: "none", billing: "none", analytics: "noop" },
  },
];

const COMMON = { WORKSPACE_SEAT_LIMIT: "3", SCIM_TOKEN: "scim-secret", WS_AUTH_TIMEOUT_MS: "800" };

let totalPass = 0;
let totalFail = 0;

for (const cfg of CONFIGS) {
  console.log(`\n================ CONFIG: ${cfg.label} ================`);
  const child = startServer({ ...COMMON, ...cfg.env });
  try {
    await waitHealth();
    const { Recorder } = await import("./lib.mjs");
    const rec = new Recorder();
    const seed = `${Date.now().toString(36)}`;
    await providersSuite(rec, cfg.expect);
    await chatSuite(rec, "c" + seed);
    await collabSuite(rec, "k" + seed);
    await journeysSuite(rec, "j" + seed);
    await tenancySuite(rec, "t" + seed);
    console.log(`  --> ${rec.passed} passed, ${rec.failed} failed`);
    totalPass += rec.passed;
    totalFail += rec.failed;
  } catch (e) {
    console.log(`  ❌ CONFIG FAILED: ${e.message}`);
    totalFail++;
    process.exitCode = 1;
  } finally {
    stopServer(child);
    await sleep(800); // let the port free before the next config
  }
}

console.log(`\n================ TOTAL: ${totalPass} passed, ${totalFail} failed ================`);
process.exit(totalFail === 0 ? 0 : 1);
