# Shared helpers for evaluation/run.sh. Sourced, not executed. Bash 3.2+.
#
# Every container here runs as the invoking user (RUN_AS), so the results
# folder stays owned by that user. On the server that user must be able to
# read secrets/ and keys/ (setup makes them owned by uid 1000, the default
# Azure admin user).

SECRETS_DIR=${SECRETS_DIR:-./secrets}
KEYS_DIR=${KEYS_DIR:-./keys}
RUN_AS="$(id -u):$(id -g)"
K6_IMAGE=grafana/k6:1.3.0

log() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() {
  log "ERROR: $*"
  exit 1
}
utc_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

compose() { docker compose --profile evaluation "$@"; }

container_id() { compose ps -q "$1" 2>/dev/null | head -n 1; }

# Wait until each service is healthy (or running, if it has no healthcheck).
wait_healthy() {
  local svc id status i
  for svc in "$@"; do
    for i in $(seq 1 90); do
      id=$(container_id "$svc")
      status=""
      if [ -n "$id" ]; then
        status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)
      fi
      if [ "$status" = "healthy" ] || [ "$status" = "running" ]; then
        break
      fi
      if [ "$i" = 90 ]; then
        die "$svc did not become healthy (status: ${status:-missing}). See: docker compose logs $svc"
      fi
      sleep 2
    done
  done
}

# RATE_LIMIT_PER_MINUTE of the running middleware, or nothing if it is not running.
current_rate_limit() {
  local id
  id=$(container_id middleware)
  [ -n "$id" ] || return 0
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$id" | sed -n 's/^RATE_LIMIT_PER_MINUTE=//p'
}

# (Re)start the middleware with the given limit. Compose recreates it only if
# the value changed. Exported so every later compose call sees the same value
# and does not recreate the middleware behind our back.
set_rate_limit() {
  export RATE_LIMIT_PER_MINUTE="$1"
  log "middleware: RATE_LIMIT_PER_MINUTE=$1"
  compose up -d middleware >/dev/null
  wait_healthy middleware
}

# The evaluation stack: the normal services plus baseline-db and evaluation-app.
# evaluation-app is recreated so it never holds connections to an old middleware.
prepare_stack() {
  set_rate_limit "$1"
  log "starting the evaluation services (baseline-db, evaluation-app)"
  compose up -d evaluation-app >/dev/null
  compose up -d --no-deps --force-recreate evaluation-app >/dev/null
  wait_healthy middleware evaluation-app
}

# Put the middleware back to the limit it had before, and remove the
# evaluation containers. Volumes (and so the baseline data) are kept.
restore_stack() {
  log "restoring: removing evaluation containers"
  compose rm -sf evaluation-app scratch-db baseline-db baseline-migrate >/dev/null 2>&1 || true
  if [ -n "${ORIGINAL_RATE_LIMIT:-}" ]; then
    export RATE_LIMIT_PER_MINUTE="$ORIGINAL_RATE_LIMIT"
    log "restoring: middleware RATE_LIMIT_PER_MINUTE=$ORIGINAL_RATE_LIMIT"
    compose up -d --no-deps middleware >/dev/null 2>&1 || log "could not restore the middleware; run: docker compose up -d"
  fi
}

# node /evaluation/tools/<script> [args...] in the evaluator container, with
# the results folder mounted at /results.
evaluator() {
  local script="$1"
  shift
  compose run --rm --no-deps -T --user "$RUN_AS" -v "$RESULTS_ABS:/results" evaluator "/evaluation/tools/$script" "$@"
}

# k6 run /scripts/<script> with -e NAME=value pairs.
k6_run() {
  local script="$1"
  shift
  local args=()
  local kv
  for kv in "$@"; do args+=(-e "$kv"); done
  compose run --rm --no-deps -T --user "$RUN_AS" -v "$RESULTS_ABS:/results" "${args[@]}" k6 run --quiet "/scripts/$script"
}

# pg_dump of a database service, inside its own container (local socket).
# Format: plain (default) or custom.
pg_dump_service() {
  local svc="$1" user="$2" db="$3" out="$4" format="${5:-plain}"
  compose exec -T "$svc" pg_dump -U "$user" -d "$db" --format="$format" --no-owner >"$out"
}

# A fresh, empty scratch-db with the given custom-format dump restored into it.
restore_into_scratch() {
  compose rm -sf scratch-db >/dev/null 2>&1 || true
  compose up -d scratch-db >/dev/null
  wait_healthy scratch-db
  compose exec -T scratch-db pg_restore -U scratch -d scratch --no-owner --no-privileges --exit-on-error <"$1"
}

remove_scratch() { compose rm -sf scratch-db >/dev/null 2>&1 || true; }

idle() {
  [ "$1" -gt 0 ] || return 0
  log "idle ${1}s (burstable CPU credits recover)"
  sleep "$1"
}

need_file() {
  [ -f "$1" ] || die "$1 is missing. $2"
  [ -r "$1" ] || die "$1 is not readable by $(id -un) (uid $(id -u)). Run as the user that owns secrets/ and keys/ (uid 1000 after setup), or with sudo."
}

preflight() {
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"
  local base="Run the stack setup first: docker compose run --rm setup && docker compose run --rm setup-vault"
  need_file "$SECRETS_DIR/tls-cert.pem" "$base"
  need_file "$SECRETS_DIR/master-kek" "$base"
  need_file "$SECRETS_DIR/vault-db-password" "$base"
  need_file "$SECRETS_DIR/reference-db-password" "$base"
  need_file "$SECRETS_DIR/reference-api-key" "$base"
  need_file "$KEYS_DIR/master-keys.json" "$base"
  if [ "${1:-}" != "setup" ]; then
    local eval_setup="Run: evaluation/run.sh setup"
    need_file "$SECRETS_DIR/baseline-db-password" "$eval_setup"
    need_file "$SECRETS_DIR/scratch-db-password" "$eval_setup"
    need_file "$SECRETS_DIR/evaluation-credentials.json" "$eval_setup"
  fi
}

# environment.json: VM size (Azure IMDS), CPUs, memory, OS, kernel, Docker
# version, image digests, git commit, and the rate limit in use.
record_environment() {
  local raw="$RESULTS_ABS/environment-raw" img svc id
  mkdir -p "$raw"
  utc_now >"$raw/recorded-at.txt"
  docker info --format '{{json .}}' >"$raw/docker-info.json" 2>/dev/null || true
  docker version --format '{{json .}}' >"$raw/docker-version.json" 2>/dev/null || true
  docker compose version --short >"$raw/compose-version.txt" 2>/dev/null || true
  uname -a >"$raw/uname.txt"
  { cat /etc/os-release 2>/dev/null || sw_vers 2>/dev/null || true; } >"$raw/os-release.txt"
  if command -v curl >/dev/null 2>&1; then
    curl -s -m 3 -H Metadata:true "http://169.254.169.254/metadata/instance?api-version=2021-02-01" >"$raw/azure-imds.json" 2>/dev/null || rm -f "$raw/azure-imds.json"
  fi
  for img in tokenization-middleware:latest tokenization-middleware-migrate:latest tokenization-reference-app:latest \
    tokenization-reference-migrate:latest postgres:16-alpine "$K6_IMAGE"; do
    docker image inspect --format "{\"image\":\"$img\",\"id\":\"{{.Id}}\",\"repoDigests\":{{json .RepoDigests}},\"created\":\"{{.Created}}\"}" "$img" 2>/dev/null ||
      printf '{"image":"%s","missing":true}\n' "$img"
  done >"$raw/images.jsonl"
  for svc in middleware evaluation-app vault-db reference-db baseline-db; do
    id=$(container_id "$svc")
    if [ -n "$id" ]; then
      docker inspect --format "{\"service\":\"$svc\",\"image\":\"{{.Image}}\",\"started\":\"{{.State.StartedAt}}\"}" "$id"
    fi
  done >"$raw/containers.jsonl"
  if command -v git >/dev/null 2>&1 && git rev-parse HEAD >/dev/null 2>&1; then
    git rev-parse HEAD >"$raw/git-commit.txt"
    git status --porcelain | wc -l | tr -d ' ' >"$raw/git-dirty.txt"
  fi
  current_rate_limit >"$raw/rate-limit.txt"
  {
    echo "EVAL_MODE=$EVAL_MODE"
    echo "EVAL_COMMAND=$EVAL_COMMAND"
    echo "COMPOSE_FILE=${COMPOSE_FILE:-}"
    echo "EVAL_RATE_LIMIT=$EVAL_RATE_LIMIT"
    echo "EVAL_RATES=$EVAL_RATES"
    echo "EVAL_WARMUP_SECONDS=$EVAL_WARMUP_SECONDS"
    echo "EVAL_DURATION_SECONDS=$EVAL_DURATION_SECONDS"
    echo "EVAL_REPEATS=$EVAL_REPEATS"
    echo "EVAL_IDLE_SECONDS=$EVAL_IDLE_SECONDS"
    echo "EVAL_LATENCY_PARTS=$EVAL_LATENCY_PARTS"
    echo "EVAL_CAPACITY_OPERATION=$EVAL_CAPACITY_OPERATION"
    echo "EVAL_CAPACITY_STEPS=$EVAL_CAPACITY_STEPS"
    echo "EVAL_CAPACITY_STEP_SECONDS=$EVAL_CAPACITY_STEP_SECONDS"
    echo "EVAL_SEGREGATION_N=$EVAL_SEGREGATION_N"
    echo "EVAL_BREACH_SEGREGATION_N=$EVAL_BREACH_SEGREGATION_N"
    echo "EVAL_BREACH_RATE_LIMIT=$EVAL_BREACH_RATE_LIMIT"
    echo "MIDDLEWARE_PORT=${MIDDLEWARE_PORT:-3000}"
    echo "EVALUATION_APP_PORT=${EVALUATION_APP_PORT:-8081}"
  } >"$raw/settings.env"
  evaluator environment.js /results
}
