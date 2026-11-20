#!/usr/bin/env bash
# Full local gate sweep.
#
# Prints one line per gate with the counts from THAT gate only. An earlier
# version grepped the shared accumulated log, so gates that print no counts
# echoed the previous gate's numbers — a reporter that lies is worse than no
# reporter at all.
#
# Exits non-zero if any gate failed. Usage: ./scripts/gate-sweep.sh [--fast]
#   --fast  skip the DB codegen gates (db:migrate, db:seed)
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
export DATABASE_URL="${DATABASE_URL:-postgres://aqar:aqar@127.0.0.1:5433/aqar}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6380}"
LOG=/tmp/aqar-gates.log
SUMMARY=/tmp/aqar-gate-summary.txt
DIR=$(mktemp -d)
: > "$LOG"; : > "$SUMMARY"
FAST=0; [ "${1:-}" = "--fast" ] && FAST=1
failures=0
run() {
  local name="$1"; shift
  local out="$DIR/$name.out"
  echo "=== $name ===" >> "$LOG"
  "$@" >"$out" 2>&1
  local rc=$?
  cat "$out" >> "$LOG"
  local stats
  stats=$(grep -hoE "Tests +[0-9]+ (passed|failed)( \| [0-9]+ skipped)?( \([0-9]+\))?" "$out" | tail -1)
  [ -z "$stats" ] && stats=$(grep -hoE "Test Files +[0-9]+ (passed|failed)( \| [0-9]+ skipped)?( \([0-9]+\))?" "$out" | tail -1)
  [ -z "$stats" ] && stats=$(grep -hoE "recall [0-9.]+|applied [0-9]+ migration\(s\)|^ok$|PASS" "$out" | tail -1)
  [ "$rc" -ne 0 ] && failures=$((failures + 1))
  printf 'GATE %-14s exit=%s  %s\n' "$name" "$rc" "$stats" | tee -a "$SUMMARY"
}
echo "services: $(docker inspect -f '{{.State.Health.Status}}' aqar-postgres-1 2>/dev/null || echo '?') postgres / $(docker exec aqar-redis-1 redis-cli ping 2>/dev/null || echo '?') redis"

run core-deps node scripts/check-core-deps.mjs
run lint pnpm lint
run typecheck pnpm typecheck
run core-unit     pnpm --filter @aqar/core exec vitest run --exclude '**/*.property.test.ts'
run core-property pnpm --filter @aqar/core exec vitest run property
run ui pnpm --filter @aqar/ui test
run web pnpm --filter @aqar/web test
run agents pnpm --filter @aqar/agents test
if [ "$FAST" -eq 0 ]; then
  run db-migrate pnpm db:migrate
  run db pnpm --filter @aqar/db test
  run db-seed pnpm db:seed
fi
run worker pnpm --filter @aqar/worker test
run channels pnpm --filter @aqar/channels test
run evals pnpm --filter @aqar/evals evals
rm -rf "$DIR"
if [ "$failures" -eq 0 ]; then
  echo "ALL_GATES_GREEN" | tee -a "$SUMMARY"
  exit 0
fi
echo "GATES_FAILED=$failures" | tee -a "$SUMMARY"
exit 1

