# Loose — Build Plan

A snappy, agent-native comms surface for dev teams. Internal tool first, architected to
graduate into a micro-SaaS without a rewrite.

**Status:** scoping → Phase 0
**Last updated:** 2026-06-30

---

## 1. Thesis

Slack treats machine-generated messages (CI, deploys, PRs, alerts) as dumb text, and bots
as second-class. Loose inverts that:

> **A single timeline where human chat, structured system events, and live agent runs
> coexist — and where the workspace itself is natively readable/writable by agents over MCP.**

The moat is the **agent/MCP platform**, not the chat. Chat has to be excellent (snappy,
clean) to earn the right to be the surface; the agent layer is why a team switches.

### The three message kinds (the "single surface")
1. **Human** — normal chat, threads, reactions.
2. **System event** — connectors post rich, actionable cards (re-run CI, ack alert, rollback), not text dumps.
3. **Agent run** — invoke an agent in a thread; it streams work and calls workspace tools over MCP.

---

## 2. Decisions (locked)

| Area | Decision |
|---|---|
| Audience | Internal tool first → micro-SaaS later. Multi-tenant-ready schema, single-tenant behavior for now. |
| Hosting | Cloud-managed. |
| Language | TypeScript everywhere. |
| Auth | Pluggable `AuthProvider`; ship local DB auth (argon2id). **No Clerk.** |
| E2E encryption | Out of scope (long-term). TLS + at-rest only. |
| Pilot size | ~20 users. Single realtime instance; Redis fan-out wired from day one. |
| v1 calls | Huddles **deferred to Phase 2** (managed LiveKit). Messaging + agent platform first. |
| Connectors | GitHub, CI, Sentry, PostHog, Solar (placeholder stub). Slack = bidirectional bridge (Phase 2). |

---

## 3. Tech stack

- **Backend (realtime):** stateful TS service — Fastify + WebSockets (`ws`). NOT serverless.
- **DB:** Postgres (Neon). `workspace_id` on every row from day one.
- **Cache / pub-sub / presence:** Redis (Upstash).
- **Object storage:** Cloudflare R2 (or Vercel Blob) for file uploads.
- **Search:** Postgres full-text (v1) → Typesense/Meilisearch when it hurts.
- **Web client:** React + Vite, shared TS core.
- **Desktop:** Electron wrapping the web client.
- **Mobile:** React Native (Phase 2). Shares logic/types, not UI, with web.
- **Auth providers later:** WorkOS / OAuth — drop-in behind the interface.
- **Analytics/observability:** PostHog (also a product connector — dual use).
- **Calls (Phase 2):** LiveKit Cloud (managed SFU). No self-hosted media.

> Marketing site, webhook ingestion endpoints, and the eventual SaaS dashboard can live on
> Vercel/Next. The WebSocket service runs on a stateful host (Fly.io / Railway / container).

---

## 4. Monorepo layout

```
loose/
├─ apps/
│  ├─ web/           # React + Vite client (auth, channels/DMs, threads, files, agent streaming)
│  ├─ desktop/       # Electron shell -> loads web  ✅
│  ├─ mobile/        # Expo / React Native client  ✅
│  └─ server/        # Fastify + WS service + HTTP API
│     └─ src/        #   store{,.memory,.pg} · pubsub{,.redis} · presence · storage
│                    #   · analytics · agent · huddles (LiveKit) · slack (import+bridge)
│                    #   · mcp · http · import-slack (CLI)
├─ packages/
│  ├─ core/          # shared types + zod WS protocol (v2) + blocks/attachments
│  ├─ auth/          # AuthProvider interface + LocalAuthProvider (scrypt) ✅
│  ├─ connectors/    # framework + GitHub/CI/Sentry/PostHog + Solar stub ✅
│  └─ db/            # Drizzle schema + migrations; createDb (postgres.js | PGlite)
└─ BUILD_PLAN.md
```
*(MCP server lives in `apps/server/src/mcp.ts` for direct store access rather than a separate package.)*

Tooling: pnpm workspaces + Turborepo, Drizzle ORM, zod for shared validation, Vitest.

---

## 5. Data model (core tables)

```
workspaces        id, name, slug, created_at
users             id, workspace_id, display_name, avatar_url, kind(human|bot|agent), created_at
credentials       id, user_id, type(password|oauth|saml), secret_hash, provider_meta   # decoupled from users
sessions          token, user_id, expires_at, revoked_at
channels          id, workspace_id, name, kind(public|private|dm), source(native|bridged:slack), topic
channel_members   channel_id, user_id, role, last_read_at
messages          id, channel_id, user_id, kind(human|system|agent), body, blocks(jsonb),
                  thread_root_id, edited_at, deleted_at, external_ref(jsonb), created_at
reactions         message_id, user_id, emoji
files             id, workspace_id, message_id, storage_key, mime, size, name
connectors        id, workspace_id, type, config(jsonb), status, created_at
connector_tokens  connector_id, scope, secret_enc
agent_runs        id, channel_id, thread_root_id, agent_user_id, status, mcp_servers(jsonb), created_at
bots / tokens     id, workspace_id, name, scopes[], token_hash
```

Notes:
- `messages.blocks` holds rich/actionable card JSON (system + agent messages).
- `external_ref` carries `{slack_ts, slack_channel}` etc. for bridge dedup.
- `kind` on users unifies humans/bots/agents as principals with scoped tokens.

---

## 6. Realtime — WS event surface

Client ↔ server over a single authenticated WebSocket. Redis pub/sub fans out across instances.

**Client → server:** `message.send`, `message.edit`, `message.delete`, `reaction.add/remove`,
`typing.start`, `channel.read`, `presence.ping`, `thread.subscribe`, `agent.invoke`.

**Server → client:** `message.new`, `message.updated`, `reaction.changed`, `typing`,
`presence.changed`, `channel.read.updated`, `agent.run.delta` (streaming), `connector.event`.

**Snappy client rules:** optimistic sends with client-generated id reconciled on ack; local
message cache (SQLite/IndexedDB); virtualized lists; instant channel switch from cache.

---

## 7. HTTP API surface (non-realtime)

```
POST /auth/login | /auth/logout | /auth/session
GET/POST /workspaces/:id/channels
GET  /channels/:id/messages?before=&limit=     # history pagination
POST /channels/:id/files                        # upload -> R2, returns file id
GET  /search?q=                                 # Postgres FTS
POST /connectors/:type                          # install/configure
POST /webhooks/:connector/:token                # inbound connector events
GET  /mcp/sse  (or streamable HTTP)             # workspace MCP server endpoint
POST /bots | GET /bots                          # manage bot principals + tokens
```

---

## 8. Auth module

`packages/auth`. App depends only on the interface.

```ts
interface AuthProvider {
  authenticate(creds: unknown): Promise<AuthResult>;
  createSession(userId: string): Promise<Session>;
  verifySession(token: string): Promise<Session | null>;
  revokeSession(token: string): Promise<void>;
  onUserProvision?(profile: ExternalProfile): Promise<User>;
}
```

- **v1:** `LocalAuthProvider` — email + password, argon2id, sessions in Postgres (+ Redis cache).
- `users` ⟂ `credentials` so a user can later gain an SSO identity with no schema churn.
- Swapping providers = register impl + migration linking existing users via `onUserProvision`.

---

## 9. Connector framework

A connector is a privileged, optionally-bidirectional integration.

```ts
interface Connector {
  type: string;                                  // "github" | "sentry" | "posthog" | "solar" | "slack"
  ingest(event: RawEvent): Promise<Message[]>;   // inbound -> rendered card(s)
  actions?: Record<string, ActionHandler>;       // button callbacks (re-run, ack, rollback)
  egress?(msg: Message): Promise<void>;          // outbound (Slack bridge mirrors back)
}
```

- **GitHub / CI / Sentry / PostHog:** inbound webhooks → `blocks` cards with actions.
- **Solar:** registered stub `Connector` that no-ops `ingest` until the contract is defined.
- **Slack bridge:** see §10. `egress` mirrors native messages back to Slack.

---

## 10. Slack bridge (Phase 2, importer can land earlier)

Two independent mechanisms — the split avoids Slack's 2025 history rate-limit wall.

1. **History backfill via Slack Export (not the API).** Admin → workspace Export → JSON of
   public channels (private/DMs on Business+/Enterprise). One-time importer → Postgres.
   No rate limits. Avoids the throttled `conversations.history` (~1 req/min for unapproved apps).
2. **Live two-way bridge via a custom Slack app.**
   - **Inbound:** subscribe to `message.*`, `reaction_*` — Slack *pushes* events (no polling, no rate-limit pressure) → ingest → WS fan-out.
   - **Outbound:** native messages mirrored back via `chat.postMessage` (proxied with name/avatar).
   - Map user/channel IDs both ways; dedupe by Slack `ts`; sync edits/deletes/threads/reactions.

```
Slack export (JSON) ──one-time──▶ importer ─▶ Postgres
Slack Events API    ──live in──▶  bridge   ─▶ Postgres ─▶ WS fan-out
native message      ──live out─▶  bridge   ─▶ chat.postMessage
```

Channels carry `source = native | bridged:slack`; the timeline blends both transparently.
Caveats: blocks/emoji don't map 1:1; files need token-auth fetch + re-upload; private
channels/DMs need user-token scopes. None block v1.

---

## 11. Agent / MCP platform (the moat)

- **Bots/agents are first-class principals** with scoped tokens.
- **Inbound:** webhooks + card schema for rich actionable messages.
- **Outbound:** Events API (subscribe to message/thread/reaction events), slash commands,
  interactive components (button → callback).
- **MCP host:** workspaces register MCP servers; agent invoked in a thread uses those tools,
  streams results back via `agent.run.delta`.
- **MCP server (headline):** expose `search_messages`, `post_message`, `read_channel`,
  `list_channels`, `open_thread` as MCP tools/resources so any external agent (e.g. Claude)
  reads/writes the workspace natively.

---

## 12. Phases & milestones

### Phase 0 — Realtime spike (~1–2 wk)
- [ ] Monorepo + pnpm/Turbo + Drizzle + Postgres/Redis local (docker-compose).
- [ ] WS connect/auth handshake; `message.send` → persist → `message.new` fan-out via Redis.
- [ ] Minimal web client: one channel, send/receive, optimistic send.
- **Exit:** two browsers chat in real time, messages persist. Realtime core de-risked.

### Phase 1 — Internal MVP (dogfood)  ← shipped
- [x] Auth module + `LocalAuthProvider`, login/session (scrypt; swappable `Hasher` → argon2id).
- [x] Channels (public/private), DMs, channel membership, read state.
- [x] Threads, reactions, presence, typing indicators.
- [x] **Durable persistence** — `PgStore` (Drizzle) behind `Store`; `DATABASE_URL=postgres://…` (Neon) or `pglite://<dir>` (embedded). Same SQL + migrations both ways; full suite passes on it.
- [x] File upload + serve — pluggable `Storage` (local-disk now; R2/S3 seam), attachments on messages.
- [x] Search — substring (memory) / `ILIKE` (pg); Postgres FTS is a later upgrade.
- [x] Bot principals + tokens; incoming webhooks + card (`blocks`) schema.
- [x] Connector framework + GitHub/CI/Sentry/PostHog connectors; Solar stub.
- [x] **MCP server** (workspace-as-tools: list/read/search/post).
- [x] **Agent-run streaming** — `agent.invoke` → `agent.run.delta`/`done`; Claude (`claude-opus-4-8`) when `ANTHROPIC_API_KEY` set, grounded local-fallback agent otherwise.
- [x] Electron shell (`apps/desktop`) wrapping the web client.
- [x] PostHog analytics — server-side capture (`analytics.ts`, no-op without `POSTHOG_KEY`) + posthog-js front end.
- **Exit:** team lives in Loose daily; agents read/post over MCP; CI/Sentry cards land. ✅

**Verified end-to-end — 30/30 integration checks on BOTH the memory and the Postgres (PGlite) backends:**
register/login/session, WS auth, presence, history, optimistic send + fan-out, threads (`replyCount`),
reactions, webhook→card, bot creation, MCP `initialize`/`tools/list`/`tools/call`, search, DM creation,
**agent-run streaming** (`delta`→`done`→final `agent` message), **file upload + serve**.

**Next:** swap local-disk `Storage` for R2/S3, Postgres FTS for search, Redis-backed presence for
multi-instance, Electron packaging/auto-update, and live `channel.created`/DM-created broadcasts.

### Phase 2 — Reach + bridge  ← shipped
- [x] React Native mobile client (`apps/mobile`, Expo) — auth, channel list, channel view, send (shares `@loose/core`).
- [x] Huddles via LiveKit — `POST /huddles/:id/token` mints a LiveKit JWT (gated on `LIVEKIT_*`; reports not-configured otherwise); `huddle.join/leave` → `huddle.state` roster fan-out; web UI with participant tiles + mic/cam.
- [x] Slack importer (export → store, history timestamps preserved) + live bridge: inbound Events API (`/slack/events`, incl. url_verification) and outbound `chat.postMessage` mirror (gated on `SLACK_BOT_TOKEN`).
- [ ] Notifications (push/email), richer connector card actions. **(next)**

**Verified — 9/9 Phase 2 checks on the Postgres (PGlite) backend** (+ Phase 1 still 30/30 on memory & pg):
LiveKit token mint (JWT + room), huddle roster fan-out (join/2-party/leave), Slack url_verification,
inbound Slack event → ingested + searchable, and `import-slack` CLI (skips join/bot subtypes; correct counts).
Mobile + web-huddle clients typecheck and build. (Live A/V media and the real Slack/LiveKit network
calls need creds — gated on env; everything testable without creds is tested.)

### Phase 3 — Micro-SaaS  ← shipped
- [x] Multi-workspace orgs + onboarding — `register` resolves workspace (default | `workspaceName` create+own | `inviteCode` join); per-workspace seeded channels; strict tenant isolation enforced in the store.
- [x] Roles + admin — `memberships` (owner/admin/member); admin-gated invites, role changes, member list; first registrant of a workspace is owner.
- [x] Billing (Stripe) — plan + seat limit on the workspace; owner-only Checkout (gated on `STRIPE_*`); webhook flips plan/seats (`free/50` ↔ `pro/200`); **seat limit enforced at join**.
- [x] SCIM 2.0 provisioning (token-gated) behind the pluggable `AuthProvider` seam; SSO/SAML is a provider drop-in (login flow needs a live IdP).
- [x] Rate limiting (`@fastify/rate-limit`: global + strict on `/auth/*`) + per-tenant isolation hardening.

**Verified — 20/20 Phase 3 checks on BOTH backends** (Phase 1 30/30 + Phase 2 9/9 still green, no regression):
default-vs-named-workspace registration + roles, cross-workspace access denied, member-can't-invite (403),
owner invite → join-as-member, role promotion, seat-limit join → 403, checkout not-configured, webhook
plan upgrade (pro/200), SCIM provision (201) + reject (401), and register flood → 429.

**Beyond Phase 3:** real SSO (OIDC/SAML) IdP wiring, Stripe usage-based seats + customer portal, audit log,
per-tenant rate-limit buckets, and the multi-instance hardening (Redis presence/huddles, R2 storage, FTS).

---

## Hardening & vendor-neutrality (provider pattern)

Every external surface is a **port** (interface) with swappable **adapters** chosen by a `*_DRIVER`
env var, each with a safe default that needs no credentials — so there's no hard dependency on any
single vendor, and "not logged into R2" just means the storage driver stays `local`. The composition
root is `apps/server/src/providers.ts` (`createProviders()`), which builds the bundle, logs the active
driver matrix at boot, and exposes graceful `shutdown()`.

| Port | Interface | Adapters (`*_DRIVER`) | Default |
|---|---|---|---|
| Store | `Store` | memory · pglite · postgres (`DATABASE_URL`) | memory |
| PubSub | `PubSub` | memory · redis (`REDIS_URL`) | memory |
| Storage | `Storage` | `local` · `memory` · `s3` (S3/R2/MinIO) | local |
| LLM (agents) | `LlmProvider` | `echo` · `anthropic` | echo / anthropic-if-key |
| Media (huddles) | `MediaProvider` | `none` · `livekit` | none / livekit-if-creds |
| Billing | `BillingProvider` | `none` · `stripe` | none / stripe-if-keys |
| Analytics | `Analytics` | `noop` · `posthog` | noop / posthog-if-key |
| Auth | `AuthProvider` | `local` (OIDC/SAML drop-in) | local |
| Connectors | `Connector` | github · ci · sentry · posthog · solar · slack-bridge | registry |

Adding a vendor = a class implementing the port + one `case` in its factory. Nothing else changes.

**Other hardening:** `/healthz` (liveness) + `/readyz` (store-reachable) endpoints; graceful SIGTERM/SIGINT
drain (close server → analytics → pubsub → store); rate limiting (global + strict on `/auth/*`);
fail-fast config validation (selecting a driver without its creds throws at boot).

## Slack-parity hardening pass

Closed real gaps that would break a production launch:
- **Message edit + delete** — `message.edit`/`message.delete` → `message.updated` broadcast; author-only (enforced server-side); soft-delete tombstones; clients render "(edited)" + "This message was deleted."
- **Live channel/DM creation** — `channel.created` broadcast (public → workspace topic, private/DM → per-user topics); appears in sidebars instantly, no reload.
- **History pagination** — `channel.more`/`channel.page` (load older, `hasMore`); web infinite-scrolls up.
- **Authz fix** — reactions now verify the target message actually belongs to the claimed channel (closed a cross-channel react hole); edit/delete verify channel + authorship.
- **Reliability** — every WS dispatch wrapped (a thrown handler error returns an `error` frame, never an unhandled rejection); per-connection flood guard (`WS_MSG_RATE_PER_10S`); unauthenticated sockets dropped after `WS_AUTH_TIMEOUT_MS`; CORS allowlist via `CORS_ORIGIN`.

## End-to-end tests (`pnpm test:e2e`) + CI

Committed matrix runner at `tests/e2e/` boots a fresh server under **three driver configs** and runs
the chat / collab / **journeys** / tenancy / providers suites against each — **193 checks, all green**:
- **defaults** (memory store, local files, echo LLM, no media/billing)
- **postgres** — embedded PGlite locally, or a **real Postgres service** in CI (`LOOSE_E2E_PG_URL`) — same SQL + auto-applied migrations
- **fully swapped** (memory storage, explicit echo/none drivers) — proves vendor-neutrality

Covers: auth, channels/DMs, threads, reactions, presence, files (per storage driver), connector cards,
bot + MCP tools, agent streaming, huddle roster + token, Slack inbound, **edit/delete + author-only authz,
live channel/DM creation, pagination, cross-channel reaction block, reconnect-restores-history,
unauthenticated-socket timeout**, multi-tenancy/roles/invites/seats, billing webhook, SCIM, rate-limit 429,
and `/healthz`·`/readyz`·driver-matrix assertions.

**CI** (`.github/workflows/ci.yml`): on every push/PR — install → typecheck (all packages) → web + desktop
builds → `pnpm test:e2e` (3 configs), plus a second job running the suite against a real **Postgres 16**
service container.

## Production-readiness assessment (honest)

| Surface | State | Caveats / before-launch |
|---|---|---|
| **API/server** | Prod-shaped: vendor-neutral providers, tenant isolation, authz, rate limiting, health/ready, graceful shutdown, 193-check e2e on every push | Presence/huddle-roster are in-process → for multi-instance, back them with Redis (PubSub already is); connector webhook `:token` is unvalidated (wire per-connector secrets); add WS `Origin` check when locking CORS |
| **Web** | Prod-shaped: auth, channels/DMs, threads, reactions, presence/typing, search, files, edit/delete, live channels, pagination, agent streaming, huddles, admin/billing | Build is one chunk (code-split later); needs the usual error-toast/retry polish; verified via typecheck + build (no automated browser test yet) |
| **Mobile** | Functional: auth, channel list, channel view, send, edit/delete + live-channel handling | Typecheck-only here (no simulator); push notifications + offline cache are the next real-device work |
| **Realtime** | Messages persist + recover via history on (re)subscribe; optimistic send + dedupe; fan-out via memory/Redis | Cross-channel missed-while-offline sync relies on reopening a channel (Slack-style delta sync is a later optimization) |

External integrations (Stripe, LiveKit media, Anthropic, real Slack API, SSO IdP, S3/R2, push) are all
behind ports and **gated on credentials** — every code path testable without them is tested and green.

---

## 13. Non-functional

- **Performance:** optimistic UI, local cache, virtualized lists, sub-100ms perceived send. Snappy is a client-architecture problem first.
- **Observability:** PostHog for product analytics; structured logs + traces on the WS service.
- **Security:** argon2id passwords, scoped bot tokens, encrypted connector secrets at rest, TLS. No E2E.
- **Scaling:** single instance for pilot; Redis pub/sub already abstracts fan-out so horizontal scale is config, not rewrite.

---

## 14. Open questions

- [ ] Realtime host: Fly.io vs Railway vs container on existing infra?
- [ ] Solar connector contract — what does Solar emit/accept?
- [ ] Slack importer in Phase 1 (dogfood against real history) or Phase 2?
- [ ] Notification strategy (web push vs native vs email) — Phase 2 detail.
```
