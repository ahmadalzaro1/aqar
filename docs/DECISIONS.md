# Decisions and borrowed patterns

## D1 — Integer fils, largest remainder
All money is integer fils. Proportional splits (owner shares, shared-service
allocation) use the largest-remainder method: floor each share, then hand
leftover fils to the largest fractional remainders (ties by id). Property
tests assert outputs always sum to the input total. No floats touch money.

## D2 — Charge status precedence
paid > overdue > partial > open. A partially paid charge past its due date is
`overdue` (collections cares about age, not completeness). Derived, never stored.

## D3 — Simple (non-compounding) escalation
Escalation increments are computed on the BASE rent, not the current rent.
Predictable for tenants and owners; documented in the lease wizard.

## D4 — Negation does not clear an emergency
The deterministic pre-check is conservatively biased: "no gas smell" still
flags. False positives cost a human phone call; false negatives cost lives.
A human can resolve the ticket after inspection; the flag is sticky for the
ticket's life (LAW 2).

## D5 — Emergency fast path is not a policy bypass
Emergencies page a human immediately and open a fast dispatch task, but the
policy engine (NTE, allow-list, approvals) still applies. Safety speed comes
from human escalation, not from skipping money controls.

## D6 — MinIO image source
`minio/minio` is gone from Docker Hub and `quay.io/minio/minio` returns 401
(verified 2026-11-19). Dev compose uses the community mirror
`coollabsio/minio:latest`. Production deployments should pin a verified
S3-compatible image or use a managed S3 service.

## D7 — pnpm 11 build allowlist
pnpm 11 ignores the legacy `pnpm` field in package.json; build scripts are
allowlisted via `allowBuilds` in pnpm-workspace.yaml (esbuild: true).

## D8 — Ports
Host ports 5433 (Postgres) and 6380 (Redis) avoid collisions with any native
services. Compose binds 127.0.0.1 only.

## Borrowed patterns (per brief §10 — licences as stated in the brief;
## verify upstream licence files before copying any code verbatim)
- `luthersystems/mcp-server-buildium` (MIT): tool-surface shape — entity
  categories with opt-in gating per agent role. Pattern only, no code copied.
- `arslan-kursad/apartment-triage` (MIT): typed IAgent interface, explicit
  sequential orchestrator, two-layer emergency guarantee, cheap→strong model
  routing, ONNX+pgvector enrichment. Architecture reimplemented in our own code.
- `clawnify/OpenProperty` (MIT): reconciliation UX — idempotent charges,
  payer-based matching, suggestion-with-reason, fingerprint dedupe, undo.
- `open-condo-software/condo` (MIT): ops-core modelling reference.
- `agentic-ops/real-estate-mcp` (AGPL): IDEA only (deterministic finance as
  pure functions). No AGPL code in this MIT repo.
- `mlee1331/maintenance-coordinator` (AGPL): concept only (severity ladder,
  responsibility matrix, NTE approval, eval suites), reimplemented with a
  Jordan service-standard pack instead of US state law. No text/files copied.
- `microrealestate` (Sustainable Use License, NOT open source): not vendored,
  not copied.

Nothing has been copied verbatim from any upstream at this stage; all code is
original. Licence verification of the reference repos is a P10 task.

## D7 — Queue contract freeze (2026-11-20)
`packages/contracts/src/queues.ts` is the ONLY producer↔consumer interface:
TRIAGE_QUEUE_NAME='aqar.ticket.triage', ticketIngestJobSchema,
triageJobResultSchema. Invalid payloads are rejected (JobValidationError),
never coerced. Idempotency keys (`wa:<msg-id>`, `tg:<update-id>`, `e2e:<uuid>`)
make redelivery safe; the worker returns the recorded prior result.

## D8 — Trace persistence shape
agent_traces.steps is typed AgentTraceStep[] in the DB schema; the worker
persists extra `step`/`detail` jsonb keys for human-readable labels. Readers
parse with an extended zod schema (persistedStepSchema), never cast. A richer
contract trace type is a future additive change.

## D9 — Build allowlist + test URL
pnpm-workspace.yaml allowBuilds: esbuild + msgpackr-extract (bullmq native
msgpack, JS fallback otherwise). db vitest derives aqar_test from the real
DATABASE_URL (AQAR_TEST_DATABASE_URL override) — no literal placeholders.

## D10 — Classifier prompt aligned to the frozen enum
The prompt previously advertised `cleaning` (not in ticketCategorySchema),
causing repeated schema escalations. It now lists the exact enum. Residual
small-model drift (e.g. "noise") escalates to a human by design — measured,
recorded in evals results, not suppressed.

## D11 — Responsive console + screenshot method
Viewport meta declared in root layout; <900px the sidebar is a 56px icon
rail; Cards set min-inline-size:0 so wide tables scroll in-card; skip link
uses the clip pattern (negative offsets inflate scrollWidth); shell root
clips horizontal bleed. Screenshots at exact widths are captured through a
same-origin iframe (CDP device emulation proved unreliable for media
queries) — recipe in RUNBOOK.

## D12 — Version policy: newest that the ecosystem actually supports
Everything moves to the newest release, with two deliberate exceptions:

- **TypeScript is pinned to 6.0.3, not 7.0.2.** `typescript-eslint@8.73`
  declares `typescript >=4.8.4 <6.1.0` and `pnpm peers check` enforces it.
  A 7.x compiler under an 8.x linter is an unsupported pairing, so the
  linter's ceiling wins: a green `pnpm lint` is worth more than a version
  number. Revisit when typescript-eslint widens the peer range.
- **Next 16 stays on the webpack builder** (`next dev/build --webpack`);
  see D13.
Turbopack is otherwise the default in Next 16 and is *not* disabled
globally — the flags are explicit so a future migration is a visible diff.

## D13 — Why Next 16 builds with webpack, not Turbopack
The workspace packages (`@aqar/core`, `@aqar/contracts`, `@aqar/ui`) are
NodeNext ESM: their internal imports use `.js` specifiers that exist on disk
only as `.ts`. Turbopack resolves those as missing modules and reports the
entry as having "no exports at all" (`sumFils was not found in module
packages/core/src/index.ts`). The working workaround is `resolve.extensionAlias`,
which only webpack implements. Next 16 still supports `--webpack` explicitly.
The durable fix — emit real `.js` from `packages/*` with `tsc` and point
`exports` at `dist` — is a build-system change with its own risks (dev
watch chain, source maps, test resolution), so it is tracked as follow-up
work rather than smuggled into a dependency bump.

## D14 — PostgreSQL 18+ moves PGDATA, and the dev cluster is disposable
The `pgvector/pgvector:pg19` image refuses to boot with the volume mounted at
`/var/lib/postgresql/data`; data now lives under a major-version
subdirectory, so compose mounts `pgdata:/var/lib/postgresql`. Consequences
worth knowing:
- Recreating the volume destroys `sessions` rows — every browser session dies
  and you must log in again. Not a bug.
- The integration suite now provisions `aqar_test` itself (vitest
  `globalSetup`), because a fresh volume or a clean CI runner has no such
  database. Anything not ending in `_test` is refused, since the suite drops
  `public`/`app`.
- `DATABASE_URL` in `.env` must match compose's `POSTGRES_PASSWORD`; a
  mismatch surfaces as Postgres `28P01` (auth failed) and a 500 on every
  console page, not as a migration error.


