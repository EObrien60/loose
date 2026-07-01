# Loose

Agent-native comms surface for dev teams. See [BUILD_PLAN.md](./BUILD_PLAN.md) for the full scope.

This repo is through **Phase 3 (micro-SaaS)**. On top of the Phase 1 MVP (auth, channels/DMs, threads,
reactions, presence/typing, search, files, bots/webhooks/connectors, MCP server, agent-run streaming)
and Phase 2 (**Expo/React Native mobile**, **LiveKit huddles**, **Slack bridge**), it adds
**multi-workspace tenancy** (roles, invites, strict isolation), **seat-limited billing** (Stripe),
**SCIM provisioning** behind the pluggable auth seam, and **rate limiting**. Runs **fully in-memory by
default** (no Docker); durable Postgres is a drop-in via `DATABASE_URL`. See [BUILD_PLAN.md](./BUILD_PLAN.md).

## Stack

- `packages/core` — shared domain types + zod WS protocol (v2): blocks, attachments, agent events
- `packages/auth` — pluggable `AuthProvider` + `LocalAuthProvider` (scrypt; argon2id drops in)
- `packages/connectors` — connector framework + GitHub/CI/Sentry/PostHog + Solar stub
- `packages/db` — Drizzle schema + migrations; `createDb` selects postgres.js (Neon) or PGlite (embedded)
- `apps/server` — Fastify + WS; `Store` (memory | **Postgres/PGlite**), `PubSub` (memory|redis), presence,
  pluggable file `Storage`, MCP server, streaming agent runner, PostHog capture
- `apps/web` — React + Vite client: auth, channels/DMs, threads, reactions, presence/typing, search,
  file upload/render, live agent-run streaming
- `apps/desktop` — Electron shell wrapping the web client

## Run (in-memory, zero infra)

```bash
pnpm install
pnpm dev:server   # terminal 1 -> :8787
pnpm dev:web      # terminal 2 -> :5173
```

Open http://localhost:5173 in two browser windows, **register two accounts**, and you get the full
app: channels (#general/#dev/#ci/#alerts/#product/#random are seeded), DMs, threads, reactions,
presence, typing, and search. State persists for the life of the server process.

**Try the agent surface:**
```bash
# post a CI card into #ci
curl -X POST localhost:8787/webhooks/ci/secret \
  -H 'content-type: application/json' \
  -d '{"pipeline":"build","status":"failed","url":"https://ci/run/1"}'

# create a bot token (use a sessionToken from the browser's localStorage, key "loose_token")
curl -X POST localhost:8787/bots -H "authorization: Bearer <sessionToken>" \
  -H 'content-type: application/json' -d '{"name":"claude"}'

# the bot can now drive the workspace over MCP (JSON-RPC at POST /mcp, Bearer <botToken>):
#   initialize · tools/list · tools/call {list_channels|read_channel|search_messages|post_message}
```

## Durable persistence (no Docker required)

The store is selected by `DATABASE_URL`:

```bash
# Embedded Postgres (PGlite) — durable, single file, zero infra:
DATABASE_URL="pglite://./.loosedb" pnpm dev:server

# Real Postgres (e.g. Neon) — same SQL, same migrations:
docker compose up -d            # or point at Neon
pnpm db:generate && pnpm db:migrate
DATABASE_URL=postgres://loose:loose@localhost:5432/loose \
REDIS_URL=redis://localhost:6379 \
  pnpm dev:server
```

The server logs the active adapters: `store=memory|pglite|postgres  pubsub=memory|redis`.
Redis fan-out lets you run multiple server instances against one workspace.

## Desktop (Electron) & Mobile (Expo)

```bash
pnpm dev:web                      # web on :5173
pnpm --filter @loose/desktop dev  # desktop window (loads the web client)
pnpm --filter @loose/mobile start # Expo — scan with Expo Go; point EXPO_PUBLIC_HTTP_URL/WS_URL at your LAN IP
```

## Huddles (voice/video)

Set LiveKit creds and the `🎧 Huddle` button connects real A/V; without them the huddle still
forms (roster/presence over WS) and the UI shows "not configured":

```bash
LIVEKIT_URL=wss://<your>.livekit.cloud LIVEKIT_API_KEY=… LIVEKIT_API_SECRET=… pnpm dev:server
```

## Slack bridge

```bash
# one-time history backfill from a Slack workspace export (JSON on disk):
DATABASE_URL="pglite://./.loosedb" pnpm --filter @loose/server import-slack ./slack-export

# live bridge: point a Slack app's Events API at  POST /slack/events
# outbound mirror (native → Slack) activates when SLACK_BOT_TOKEN is set.
```

## Multi-tenancy (Phase 3)

Registration resolves a workspace: no args → default workspace; `workspaceName` → create a new one
(you become `owner`); `inviteCode` → join as the invite's role. Owners/admins invite teammates, manage
roles, and upgrade billing; seat limits are enforced at join. Tenants are strictly isolated.

```bash
# seat cap for newly-created workspaces (default 50):
WORKSPACE_SEAT_LIMIT=25 pnpm dev:server
```

## Swappable providers (vendor-neutral)

Every external surface is a port with adapters chosen by a `*_DRIVER` env var; each has a safe
default needing no credentials. The composition root is `apps/server/src/providers.ts`.

| Port | `*_DRIVER` | adapters | default |
|---|---|---|---|
| Store | `DATABASE_URL` | memory · pglite · postgres | memory |
| PubSub | `REDIS_URL` | memory · redis | memory |
| Storage | `STORAGE_DRIVER` | local · memory · s3 (S3/R2/MinIO) | local |
| LLM | `LLM_DRIVER` | echo · anthropic | echo (anthropic if key) |
| Media | `MEDIA_DRIVER` | none · livekit | none (livekit if creds) |
| Billing | `BILLING_DRIVER` | none · stripe | none (stripe if keys) |
| Analytics | `ANALYTICS_DRIVER` | noop · posthog | noop (posthog if key) |
| Auth | `AUTH_DRIVER` | local (OIDC/SAML drop-in) | local |

Swap a vendor = add a class implementing the port + a `case` in its factory. `GET /` reports the
active driver matrix; `/healthz` + `/readyz` are the liveness/readiness probes.

## Tests & CI

```bash
pnpm test:e2e   # boots the server under 3 driver configs, runs all suites (193 checks)
pnpm typecheck  # all packages
```

`tests/e2e/` covers real user journeys end-to-end: messaging, threads, reactions, files, edit/delete
(+ author-only authz), live channel/DM creation, history pagination, cross-channel reaction blocking,
reconnect-restores-history, unauthenticated-socket timeout, agent streaming, huddles, Slack inbound,
and the full tenancy/billing/SCIM surface. `.github/workflows/ci.yml` runs typecheck + builds + the
e2e matrix on every push, plus a job against a real Postgres 16 service.

## Optional env

- `ANTHROPIC_API_KEY` — agent runs stream real Claude (`claude-opus-4-8`); else a grounded fallback agent.
- `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` — huddle media.
- `SLACK_BOT_TOKEN` — outbound Slack mirroring (inbound needs no token).
- `STRIPE_SECRET_KEY` / `STRIPE_PRICE_ID` — billing checkout; `STRIPE_WEBHOOK_SECRET` for webhook verification.
- `SCIM_TOKEN` (+ optional `SCIM_WORKSPACE_ID`) — enable SCIM 2.0 user provisioning.
- `POSTHOG_KEY` / `VITE_POSTHOG_KEY` — server + client analytics (inert without keys).
- `FILES_DIR` — upload storage dir (default `./.loose-files`); `WORKSPACE_SEAT_LIMIT` — new-workspace seat cap.
- `CORS_ORIGIN` — comma-separated allowlist (default: open, for dev).
- `WS_AUTH_TIMEOUT_MS` (default 10000) — drop sockets that don't authenticate in time.
- `WS_MSG_RATE_PER_10S` (default 300) — per-connection WS message flood guard.

## Next

Durable Postgres store (the repo shapes + schema are ready), file upload (R2), Electron shell,
PostHog product analytics, and agent-run streaming in threads. See the build plan.
