# Runbook

## Boot the stack
```bash
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d   # pg16+pgvector :5433, redis :6380, minio :9000, mailpit :1025/:8025
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev        # web :3000 (+ worker, channels when built)
```
Dev login: admin@aqar.example / aqar-dev-admin-123 (seeded, dev-only).
Roles: manager@aqar.example (property_manager), accountant@aqar.example,
tenant@aqar.example — same dev password.

## Tests
```bash
pnpm test              # all packages
pnpm test:unit         # core unit
pnpm test:property     # core fast-check properties
pnpm test:integration  # real Postgres (RLS, guards, migrations)
node scripts/check-core-deps.mjs   # LAW 1 purity gate
```

## Backup / restore
```bash
docker exec aqar-postgres-1 pg_dump -U aqar -Fc aqar > aqar_$(date +%F).dump
docker exec -i aqar-postgres-1 pg_restore -U aqar -d aqar --clean < aqar_YYYY-MM-DD.dump
```
Verify a backup is readable (pg_restore --list) before deleting anything.

## Switch models
Edit `.env`: LOCAL_BASE_URL / LOCAL_MODEL (OpenAI-compatible, default
http://127.0.0.1:8002/v1). CLOUD_BASE_URL stays EMPTY unless a human enables
it; cloud is disabled by default. Embeddings are local ONNX only. Restart
apps/worker after changes. Every agent run records model id, tokens, latency
and estimated cost in its trace.

## Rotate keys
SESSION_SECRET rotation invalidates all sessions (users re-login). Channel
secrets (WHATSAPP_APP_SECRET, TELEGRAM_WEBHOOK_SECRET) rotate in the provider
console first, then .env, then restart apps/channels. Never commit .env.

## Incident: emergency ticket
The emergency banner is not dismissible by any agent. Verify the human page
went out, check the dispatch task, and only a human closes the emergency.

## Colima (macOS dev VM)
`colima start` / `colima stop`. The VM auto-restarts unrelated containers;
leave them alone.

## Agentic queue path (P5)
```bash
pnpm --filter @aqar/worker dev        # BullMQ consumer, concurrency 2
pnpm --filter @aqar/channels dev      # Hono ingress :8787
pnpm --filter @aqar/worker e2e        # REAL ticket→triage→proposals proof
pnpm --filter @aqar/evals evals       # deterministic LAW-2 recall gate
AQAR_LIVE_MODEL=1 pnpm --filter @aqar/evals exec tsx src/run.ts --lane model
cd apps/channels && pnpm exec tsx .mail-proof.ts   # SMTP→Mailpit round-trip
```
Local chat model: lfm3-local at http://127.0.0.1:11434/v1 (LOCAL_BASE_URL /
LOCAL_MODEL in .env). :8002 is embeddings-only — chat there 404s.
Worker E2E asserts: emergency floor, dry_run denials, 0 dispatches/work
orders, 2 bilingual safety messages, idempotent replay with identical
traceId and no duplicate rows.

## Screenshot method (exact widths)
CDP Emulation.setDeviceMetricsOverride did not reliably drive media queries
in this environment. Working recipe: log in, then inside the same-origin
console page replace the body with
`<iframe src="/dashboard" style="position:absolute;left:0;top:0;width:390px;height:1400px">`
(force outer document dir=ltr so the box aligns under RTL), poll for
#main+aside, then Page.captureScreenshot with captureBeyondViewport and a
clip at the iframe's bounding rect. Verify contentDocument scrollWidth ==
iframe width before saving. Final set: docs/screenshots/ (24 files).

