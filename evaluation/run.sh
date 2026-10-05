#!/usr/bin/env bash
# Evaluation for thesis chapter 5 (method in section 3.1.3). Needs only Docker
# with Compose v2: load comes from the grafana/k6 image, and every other step
# runs in containers built from this repository. Run from anywhere; it works
# in the repository root. See evaluation/README.md.
#
#   evaluation/run.sh setup             once: evaluation secrets and credentials
#   evaluation/run.sh latency           NFR1: measurements A and B, and the capacity step run
#   evaluation/run.sh segregation       NFR2
#   evaluation/run.sh irreversibility   NFR6
#   evaluation/run.sh breach            NFR3
#   evaluation/run.sh all               the four parts, in that order, into one results folder
#   evaluation/run.sh smoke             all four with tiny durations (local check, not for the thesis)
#
# Each run writes evaluation/results/<UTC timestamp>/, starting with
# environment.json. Settings are environment variables (EVAL_*), listed in the README.

set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
# shellcheck source=lib/common.sh
. evaluation/lib/common.sh

EVAL_COMMAND=${1:-}
EVAL_MODE=full
if [ "$EVAL_COMMAND" = "smoke" ]; then
  EVAL_MODE=smoke
  : "${EVAL_RATES:=10}" "${EVAL_WARMUP_SECONDS:=2}" "${EVAL_DURATION_SECONDS:=5}" "${EVAL_REPEATS:=1}" "${EVAL_IDLE_SECONDS:=2}"
  : "${EVAL_CAPACITY_STEPS:=5 10}" "${EVAL_CAPACITY_STEP_SECONDS:=4}" "${EVAL_SEGREGATION_N:=30}" "${EVAL_BREACH_SEGREGATION_N:=10}"
fi
: "${EVAL_RATE_LIMIT:=1000000}"
: "${EVAL_RATES:=10 50}"
: "${EVAL_WARMUP_SECONDS:=15}"
: "${EVAL_DURATION_SECONDS:=60}"
: "${EVAL_REPEATS:=3}"
: "${EVAL_IDLE_SECONDS:=180}"
: "${EVAL_LATENCY_PARTS:=app middleware capacity}"
: "${EVAL_CAPACITY_OPERATION:=tokenize}"
: "${EVAL_CAPACITY_STEPS:=25 50 100 200 400 800}"
: "${EVAL_CAPACITY_STEP_SECONDS:=30}"
: "${EVAL_SEGREGATION_N:=1000}"
: "${EVAL_BREACH_SEGREGATION_N:=100}"
: "${EVAL_BREACH_RATE_LIMIT:=20}"
: "${EVAL_APP_PREFIX:=evaluation}"

# ---------------------------------------------------------------------------
# setup: evaluation-only secrets, never overwriting an existing file

RUNTIME_UID=1000 # the images' non-root `node` user, as in middleware/docker/setup.sh

# Under sudo, hand new secret files to the runtime user, as the stack's own setup does.
own() { if [ "$(id -u)" = 0 ]; then chown "$RUNTIME_UID:$RUNTIME_UID" "$1"; fi; }

cli() { compose exec -T middleware node dist/cli/main.js "$@"; }

create_credential() { # <app id> <scopes> -> "credentialId apiKey"
  local out
  out=$(cli cred:create --app "$1" --scopes "$2" 2>/dev/null) || die "cred:create failed"
  printf '%s %s\n' "$(printf '%s\n' "$out" | sed -n 's/^CREDENTIAL_ID=//p')" "$(printf '%s\n' "$out" | sed -n 's/^API_KEY=//p')"
}

create_app() { # <name> -> app id
  local id
  id=$(cli app:create --name "$1" 2>/dev/null | sed -n 's/^APP_ID=//p')
  [ -n "$id" ] || die "could not create application \"$1\" (it may already exist). Set EVAL_APP_PREFIX to a new prefix and run setup again."
  printf '%s\n' "$id"
}

setup_part() {
  local name file
  umask 077
  for name in baseline-db-password scratch-db-password; do
    file="$SECRETS_DIR/$name"
    if [ -f "$file" ]; then
      log "$name: keeping existing"
    else
      head -c 48 /dev/urandom | base64 | tr -d '/+=\n' >"$file"
      own "$file"
      log "$name: generated"
    fi
  done

  file="$SECRETS_DIR/evaluation-credentials.json"
  if [ -f "$file" ]; then
    log "evaluation credentials: keeping existing"
    return
  fi
  compose up -d middleware >/dev/null
  wait_healthy middleware
  local app_a app_b a_id a_key b_id b_key i_id i_key v
  app_a=$(create_app "$EVAL_APP_PREFIX-a")
  app_b=$(create_app "$EVAL_APP_PREFIX-b")
  read -r a_id a_key <<<"$(create_credential "$app_a" TOKENIZE,DETOKENIZE,ERASE)"
  read -r b_id b_key <<<"$(create_credential "$app_b" TOKENIZE,DETOKENIZE,ERASE)"
  read -r i_id i_key <<<"$(create_credential "$app_a" INSPECT)"
  for v in "$a_id" "$a_key" "$b_id" "$b_key" "$i_id" "$i_key"; do
    [ -n "$v" ] || die "credential creation returned nothing"
  done
  cat >"$file" <<EOF
{
  "appA": { "name": "$EVAL_APP_PREFIX-a", "appId": "$app_a", "credentialId": "$a_id", "apiKey": "$a_key", "scopes": ["TOKENIZE", "DETOKENIZE", "ERASE"] },
  "appB": { "name": "$EVAL_APP_PREFIX-b", "appId": "$app_b", "credentialId": "$b_id", "apiKey": "$b_key", "scopes": ["TOKENIZE", "DETOKENIZE", "ERASE"] },
  "inspectOnly": { "name": "$EVAL_APP_PREFIX-a", "appId": "$app_a", "credentialId": "$i_id", "apiKey": "$i_key", "scopes": ["INSPECT"] }
}
EOF
  own "$file"
  log "evaluation credentials: applications $app_a (A) and $app_b (B); credentials $a_id, $b_id, $i_id (INSPECT only)"
  log "saved to $file. Next: evaluation/run.sh smoke, then the parts (see evaluation/README.md)"
}

# ---------------------------------------------------------------------------
# 1. Latency (NFR1)

latency_part() {
  local dir="$RESULTS_ABS/latency" targets="" rep rate target first=1 total=0 name start end code
  mkdir -p "$dir/k6"
  case " $EVAL_LATENCY_PARTS " in *" app "*) targets="baseline-write treatment-write baseline-read treatment-read" ;; esac
  case " $EVAL_LATENCY_PARTS " in *" middleware "*) targets="$targets mw-tokenize mw-detokenize mw-erase" ;; esac
  for rep in $(seq 1 "$EVAL_REPEATS"); do for rate in $EVAL_RATES; do for target in $targets; do total=$((total + 1)); done; done; done
  log "latency: $total runs of ${EVAL_WARMUP_SECONDS}s warm-up + ${EVAL_DURATION_SECONDS}s measured, ${EVAL_IDLE_SECONDS}s idle between runs"
  log "latency: expect roughly $(((total * (EVAL_WARMUP_SECONDS + EVAL_DURATION_SECONDS + EVAL_IDLE_SECONDS + 15)) / 60)) minutes"

  # Repetition outermost, baseline and treatment adjacent, so drift over the
  # session affects both sides alike.
  for rep in $(seq 1 "$EVAL_REPEATS"); do
    for rate in $EVAL_RATES; do
      for target in $targets; do
        [ "$first" = 1 ] || idle "$EVAL_IDLE_SECONDS"
        first=0
        name="$target-r$rate-rep$rep"
        log "latency: $name"
        start=$(utc_now)
        set +e
        k6_run latency.js "TARGET=$target" "RATE=$rate" "WARMUP_SECONDS=$EVAL_WARMUP_SECONDS" \
          "DURATION_SECONDS=$EVAL_DURATION_SECONDS" "SUMMARY_FILE=/results/latency/k6/$name.json"
        code=$?
        set -e
        end=$(utc_now)
        printf '{"kind":"latency","target":"%s","rate":%s,"rep":%s,"start":"%s","end":"%s","exitCode":%s,"summary":"k6/%s.json"}\n' \
          "$target" "$rate" "$rep" "$start" "$end" "$code" "$name" >>"$dir/runs.jsonl"
      done
    done
  done

  case " $EVAL_LATENCY_PARTS " in
    *" capacity "*)
      [ "$first" = 1 ] || idle "$EVAL_IDLE_SECONDS"
      log "capacity: /v1/$EVAL_CAPACITY_OPERATION at $EVAL_CAPACITY_STEPS requests/s, ${EVAL_CAPACITY_STEP_SECONDS}s each"
      start=$(utc_now)
      set +e
      k6_run capacity.js "OPERATION=$EVAL_CAPACITY_OPERATION" "STEPS=$EVAL_CAPACITY_STEPS" \
        "STEP_SECONDS=$EVAL_CAPACITY_STEP_SECONDS" "SUMMARY_FILE=/results/latency/k6/capacity.json"
      code=$?
      set -e
      end=$(utc_now)
      printf '{"kind":"capacity","operation":"%s","start":"%s","end":"%s","exitCode":%s,"summary":"k6/capacity.json"}\n' \
        "$EVAL_CAPACITY_OPERATION" "$start" "$end" "$code" >>"$dir/runs.jsonl"
      ;;
  esac
  evaluator latency-report.js /results/latency
}

# ---------------------------------------------------------------------------
# 2. Segregation (NFR2)

segregation_in() { # <results subfolder> <n>
  mkdir -p "$RESULTS_ABS/$1"
  log "segregation: creating $2 customers through POST /customers"
  evaluator segregation.js create "/results/$1" "$2"
  log "segregation: pg_dump of reference-db"
  pg_dump_service reference-db reference reference "$RESULTS_ABS/$1/reference-db.sql"
  evaluator segregation.js analyze "/results/$1"
}

segregation_part() { segregation_in segregation "$EVAL_SEGREGATION_N"; }

# ---------------------------------------------------------------------------
# 3. Irreversibility (NFR6)

irreversibility_part() {
  local d=irreversibility dir="$RESULTS_ABS/irreversibility"
  mkdir -p "$dir"
  log "irreversibility 1: tokenize"
  evaluator irreversibility.js tokenize "/results/$d"
  log "irreversibility 2: pg_dump backup of vault-db"
  pg_dump_service vault-db vault vault "$dir/2-vault-backup-pre-erase.dump" custom
  log "irreversibility 3: erase"
  evaluator irreversibility.js erase "/results/$d"
  log "irreversibility 4: tombstone"
  pg_dump_service vault-db vault vault "$dir/4-vault-post-erase.sql"
  evaluator irreversibility.js tombstone "/results/$d"
  log "irreversibility 5: recovery from the live system"
  evaluator irreversibility.js recover-live "/results/$d"
  log "irreversibility 6: restore the pre-erase backup into scratch-db"
  restore_into_scratch "$dir/2-vault-backup-pre-erase.dump"
  evaluator irreversibility.js recover-backup "/results/$d"
  remove_scratch
  evaluator irreversibility.js report "/results/$d"
}

# ---------------------------------------------------------------------------
# 4. Breach resilience (NFR3)

breach_part() {
  local d=breach dir="$RESULTS_ABS/breach"
  mkdir -p "$dir/2-vault-db" "$dir/3-key-file" "$dir/4-credential" "$dir/5-all-three"
  evaluator breach.js prepare "/results/$d"

  log "breach 1: primary database alone"
  segregation_in "$d/1-primary-db" "$EVAL_BREACH_SEGREGATION_N" || true

  log "breach 2: vault database alone"
  pg_dump_service vault-db vault vault "$dir/2-vault-db/vault-db.sql"
  evaluator breach.js vault-db "/results/$d"

  log "breach 3: key file alone"
  evaluator breach.js key-file "/results/$d"

  log "breach 4: application with a valid credential"
  evaluator breach.js credential "/results/$d"

  log "breach 5: vault database, key file and KEK together, in an isolated copy"
  pg_dump_service vault-db vault vault "$dir/5-all-three/vault-db.dump" custom
  restore_into_scratch "$dir/5-all-three/vault-db.dump"
  evaluator breach.js isolated "/results/$d"
  remove_scratch

  log "breach 4: rate limit (middleware restarted with RATE_LIMIT_PER_MINUTE=$EVAL_BREACH_RATE_LIMIT)"
  set_rate_limit "$EVAL_BREACH_RATE_LIMIT"
  evaluator breach.js rate-limit "/results/$d" "$EVAL_BREACH_RATE_LIMIT"
  set_rate_limit "$EVAL_RATE_LIMIT"

  evaluator breach.js report "/results/$d"
}

# ---------------------------------------------------------------------------

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

case "$EVAL_COMMAND" in
  setup)
    preflight setup
    setup_part
    exit 0
    ;;
  latency | segregation | irreversibility | breach) PARTS=$EVAL_COMMAND ;;
  all | smoke) PARTS="latency segregation irreversibility breach" ;;
  *) usage ;;
esac

preflight
ORIGINAL_RATE_LIMIT=$(current_rate_limit)
export RATE_LIMIT_PER_MINUTE="${ORIGINAL_RATE_LIMIT:-600}"
RESULTS="evaluation/results/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RESULTS"
RESULTS_ABS="$ROOT/$RESULTS"
trap restore_stack EXIT

log "results: $RESULTS ($EVAL_MODE)"
prepare_stack "$EVAL_RATE_LIMIT"
record_environment

SUMMARY=""
FAILED=0
for part in $PARTS; do
  log "=== $part ==="
  set +e
  (
    set -e
    "${part}_part"
  )
  code=$?
  set -e
  case $code in
    0) result=PASS ;;
    3) result=FAIL ;;
    *) result="ERROR (exit $code)" ;;
  esac
  [ "$part" = latency ] && [ "$code" = 0 ] && result=DONE
  [ "$code" = 0 ] || FAILED=1
  SUMMARY="$SUMMARY$part: $result"$'\n'
done

# Last: the evaluator held the KEK and master keys, so prove that none of them,
# nor any API key or password, reached the results folder.
log "=== secret scan ==="
SECRETS_ABS=$(cd "$SECRETS_DIR" && pwd)
set +e
compose run --rm --no-deps -T --user "$RUN_AS" -v "$RESULTS_ABS:/results" -v "$SECRETS_ABS:/scan-secrets:ro" \
  evaluator /evaluation/tools/secret-scan.js /results /scan-secrets
code=$?
set -e
case $code in
  0) result=PASS ;;
  3) result=FAIL ;;
  *) result="ERROR (exit $code)" ;;
esac
[ "$code" = 0 ] || FAILED=1
SUMMARY="${SUMMARY}secret scan: $result"$'\n'
if [ "$FAILED" != 0 ]; then
  SUMMARY="${SUMMARY}run: FAIL"$'\n'
else
  SUMMARY="${SUMMARY}run: PASS"$'\n'
fi

printf '%s' "$SUMMARY" >"$RESULTS_ABS/result.txt"
log "=== results in $RESULTS ==="
printf '%s' "$SUMMARY" >&2
exit "$FAILED"
