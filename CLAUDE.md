# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Prozorro Track System — a NestJS backend that syncs Ukrainian public procurement data from the Prozorro public API into a local PostgreSQL database via BullMQ job queues, then exposes search/analytics endpoints. Written in TypeScript (strict mode, ES2023 target).

## Common Commands

```bash
# Development
npm run start:dev          # Watch mode dev server
npm run start:debug        # Debug mode with node inspector

# Build & Production
npm run build              # TypeScript → dist/
npm run start:prod         # Run compiled dist/main.js

# Database
npx prisma migrate dev     # Apply migrations (dev)
npx prisma migrate deploy  # Apply migrations (prod)
npm run studio             # Prisma Studio web UI

# Testing
npm test                   # All unit tests (Jest)
npm run test:watch         # Watch mode
npm run test:cov           # Coverage report
npm run test:e2e           # End-to-end tests (test/app.e2e-spec.ts)

# Code Quality
npm run lint               # ESLint with auto-fix
npm run format             # Prettier
```

## Infrastructure

- **PostgreSQL 15** on port 5433 (non-standard), **Redis 7** on port 6380 — both via docker-compose
- `docker-compose.yml` runs the main app; `docker-compose.worker.yml` runs a standalone worker (`APP_ROLE=WORKER`)
- Required env vars: `DATABASE_URL`, `REDIS_HOST`, `API_KEY`. See `.env.example` for all options.

## Architecture

**Role-based process model:** The `APP_ROLE` env var controls behavior:
- `MAIN` — runs the sync cron that fetches tender IDs from Prozorro API and enqueues them into BullMQ
- `WORKER` — processes queued jobs (fetch full tender/contract details, persist to DB)
- Default (`MAIN`) does both

**Module structure (`src/`):**
- `auth/` — API key guard (`X-API-KEY` header). All routes guarded by default; use `@Public()` decorator to exempt.
- `prisma/` — Prisma service wrapper
- `prozorro/` — HTTP client for Prozorro public API v2.5. Has token-bucket rate limiting (`WORKER_REQUESTS_PER_SECOND`) and RxJS retry with exponential backoff.
- `sync/` — Cron-based sync orchestrator. Tracks progress via `SyncState` table (single-row offset). Logs stats every 30s.
- `processor/` — BullMQ `WorkerHost` in `tender.processor.ts`. Fetches full tender + contracts, sanitizes data (null bytes, string-to-number coercion), batch-writes to DB with concurrency limiting (`WORKER_DB_CONCURRENCY`).
- `search/` — REST endpoints + DTOs for querying tenders, contracts, company profiles, and system stats.

**Database design (Prisma schema):**
- Core models: Company, Tender, Contract, Item, Lot, Bid, Complaint, SyncState
- Heavily denormalized — customer/supplier fields duplicated on Tender/Contract for fast reads without JOINs
- Cascade deletes from Tender → Contract/Lot/Bid/Complaint, Contract → Item
- Extensive composite indices on filter/sort columns

**API endpoints** (all require `X-API-KEY` except health):
- `GET /search/tenders` — filtered tender search
- `GET /search/contracts` — filtered contract search
- `GET /search/company/:edrpou` — company profile with stats
- `GET /search/stats` — total system stats
- `GET /queues` — Bull Board dashboard
- `GET /health` — health check
- Swagger docs at `/api` (disabled in production)

## Key Patterns

- **Two-tier rate limiting:** per-instance token bucket on Prozorro API calls + global NestJS `ThrottlerGuard` (100 req/min per IP) on incoming requests
- **Concurrency controls:** BullMQ concurrency (`WORKER_CONCURRENCY`, default 50), DB write slots (`WORKER_DB_CONCURRENCY`, default 2), lock duration tuning (`WORKER_LOCK_DURATION_MS`, default 300s)
- **ESLint 9 flat config** (`eslint.config.mjs`): `@typescript-eslint/no-explicit-any` is OFF; floating promises and unsafe arguments are warnings
- **Prettier:** single quotes, trailing commas
- UI-facing strings are in Ukrainian
