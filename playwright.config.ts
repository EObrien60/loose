import { defineConfig, devices } from "@playwright/test";

/**
 * UI end-to-end tests (real browser). Complements the protocol-level suite in
 * tests/e2e/ — this drives the actual React client through Chromium, so it catches
 * client-only regressions the protocol suite can't (e.g. render-loop WS floods).
 *
 * Boots both the API server and the Vite web client; reuses them if already running.
 */
export default defineConfig({
  testDir: "./tests/ui",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm dev:server",
      url: "http://localhost:8787/healthz",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "pnpm dev:web",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
