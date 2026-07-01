# syntax=docker/dockerfile:1
#
# Multi-stage build for the Loose monorepo. Two runnable targets:
#   - server : Fastify + WS API (auto-migrates + seeds Postgres on boot)
#   - web    : the built React client, served statically via `vite preview`
#
# Both build from the repo root so the pnpm workspace packages resolve.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY . .
# esbuild is the only dependency allowed to run its postinstall (see package.json).
RUN pnpm install --frozen-lockfile

# ── server ──────────────────────────────────────────────────────────────────
FROM base AS server
ENV PORT=8787
EXPOSE 8787
CMD ["pnpm", "--filter", "@loose/server", "start"]

# ── web (build) ───────────────────────────────────────────────────────────────
# The API/WS URLs are baked at build time (Vite inlines import.meta.env). They point
# at the browser-reachable published server port, not the compose-internal hostname.
FROM base AS web-build
ARG VITE_HTTP_URL=http://localhost:8787
ARG VITE_WS_URL=ws://localhost:8787/ws
ENV VITE_HTTP_URL=$VITE_HTTP_URL VITE_WS_URL=$VITE_WS_URL
RUN pnpm --filter @loose/web build

# ── web (serve) ───────────────────────────────────────────────────────────────
FROM web-build AS web
EXPOSE 5173
CMD ["pnpm", "--filter", "@loose/web", "preview"]
