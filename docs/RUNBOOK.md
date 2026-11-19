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
