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
