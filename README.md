# Aqar — عقار

Open-source **property operations ledger with an agentic maintenance layer**,
Jordan/MENA-first. A money-and-obligation ledger with an operations queue
attached — not a CRM, not a listings site.

**Three laws:** money is deterministic (pure integer-fils core, zero I/O) ·
life safety is a hard code branch (deterministic emergency pre-check a model
can never suppress) · every action is attributed and reversible (append-only
audit, one-click undo).

## Quickstart
```bash
cp .env.example .env
docker compose -f infra/docker-compose.yml up -d
pnpm install && pnpm db:migrate && pnpm db:seed
pnpm dev            # web :3000
pnpm test           # unit + property + integration
```
Dev login: `admin@aqar.example` / `aqar-dev-admin-123`. Arabic-first RTL UI
with one-click English LTR; JOD rendered with 3 decimals everywhere.

## Status
Under active construction, phase by phase (P0–P10). See `BLOCKERS.md` for the
exact resume point and `docs/` for architecture, domain invariants, decisions,
runbook and security model. Honest status: what is built is tested; what is
not built is listed, never implied.

## Licence
MIT. Reference-project pattern attributions in `docs/DECISIONS.md`.
