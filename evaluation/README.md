# Evaluation

Scripts that produce the evidence for thesis chapter 5, following the method
in section 3.1.3. There are four parts:

| Part | Requirement | Command | Main output |
| --- | --- | --- | --- |
| 1. Latency | NFR1 | `evaluation/run.sh latency` | `latency/summary.md` |
| 2. Segregation | NFR2 | `evaluation/run.sh segregation` | `segregation/segregation.md` |
| 3. Irreversibility | NFR6 | `evaluation/run.sh irreversibility` | `irreversibility/irreversibility.md` |
| 4. Breach resilience | NFR3 | `evaluation/run.sh breach` | `breach/breach-resilience.md` |

None of this changes how the middleware behaves. The only code added outside
this folder is the reference app's latency baseline routes, which exist only
when `EVALUATION_BASELINE=true`, and the evaluation services in
`docker-compose.yml`, which sit behind the Compose profile `evaluation`. With
the profile off (a plain `docker compose up`), the stack and the demo resolve
to exactly the same configuration as before.

## Requirements

- **Only Docker with Compose v2 on the host.** k6 runs from the `grafana/k6`
  image; everything else runs in containers built from this repository. There
  is no Node.js or k6 on the host.
- The normal stack set up as in the main README (`docker compose run --rm setup`,
  then `docker compose run --rm setup-vault`).
- Run as the user that can read `secrets/` and `keys/`. Setup makes those files
  owned by uid 1000, which is the default admin user on an Azure VM. Every
  evaluation container runs as the invoking user, so the results stay owned by
  you. Running everything with `sudo` also works; the results are then owned by root.
- `curl` on the host is used, if present, to read the VM size from Azure's
  instance metadata endpoint. Without it the evaluator container tries instead.

## On the server, in order

From the repository root:

```sh
# 0. Once, if the stack is not set up yet
docker compose run --rm setup
docker compose run --rm setup-vault

# 1. Once: evaluation secrets and credentials
evaluation/run.sh setup

# 2. Optional sanity check (about 6 minutes; tiny durations, not for the thesis)
evaluation/run.sh smoke

# 3. The four parts. Latency takes about 3 hours 15 minutes, so run it
#    detached (tmux, screen, or nohup) and leave the VM otherwise idle.
nohup evaluation/run.sh latency > latency.log 2>&1 &
evaluation/run.sh segregation
evaluation/run.sh irreversibility
evaluation/run.sh breach

# Or all four in one go, into a single results folder:
nohup evaluation/run.sh all > evaluation.log 2>&1 &
```

Each command exits 0 when every check passes. At the end it prints one line per
part (`DONE` for latency, `PASS`/`FAIL` for the others, `ERROR` if a step could
not run) and writes the same lines to `result.txt`.

To copy the results to your machine:

```sh
scp -r <user>@<server>:<repository>/evaluation/results/<timestamp> .
```

## What one run does

1. Checks the stack's secrets and the evaluation secrets exist and are readable.
2. Starts the middleware with `RATE_LIMIT_PER_MINUTE` raised to
   `EVAL_RATE_LIMIT` (default 1,000,000), so the limiter never shapes the
   measurements, then starts `baseline-db` and `evaluation-app`.
3. Records the environment to `environment.json` (see below).
4. Runs the part, writing to `evaluation/results/<UTC timestamp>/<part>/`.
5. On exit, even after an error or Ctrl-C, removes the evaluation containers
   and puts the middleware back on the rate limit it had before.

`evaluation/results/` is gitignored.

### environment.json

VM size and location from Azure's instance metadata endpoint
(169.254.169.254), CPU count, memory, OS, kernel and Docker version (from the
engine, so they describe the server even though the tools run in containers),
the ID and digest of every image used, the start time of each running
container, the git commit and whether the working tree had uncommitted
changes, the `RATE_LIMIT_PER_MINUTE` the middleware was running with, and every
`EVAL_*` setting of the run.

## The evaluation services

All behind the `evaluation` profile, none started by a plain `docker compose up`:

| Service | Networks | Role |
| --- | --- | --- |
| `baseline-db` | `baseline-net` | The latency baseline's own PostgreSQL (same image and storage type as `reference-db`) |
| `baseline-migrate` | `baseline-net` | Applies `reference_app/prisma/baseline/` migrations to it |
| `evaluation-app` | `app-net`, `baseline-net` | The reference app with `EVALUATION_BASELINE=true`, on `127.0.0.1:8081` (`EVALUATION_APP_PORT`) |
| `scratch-db` | `scratch-net` | Throwaway PostgreSQL in memory, for restoring vault backups |
| `evaluator` | `vault-net`, `app-net`, `scratch-net` | Runs `evaluation/tools/*.js` with the middleware's own compiled crypto, key file and Prisma code |
| `k6` | host | The load generator, `grafana/k6:1.3.0` |

`baseline-net` and `scratch-net` are internal. The baseline routes write only
to `baseline-db`: the reference app refuses to start if the baseline URL names
the reference database, and `baseline-db` and `reference-db` share no
network. So segregation inspects a `reference-db` that has never held a
baseline BVN.

The evaluator reads databases only through Prisma (the middleware's client,
with the append-only audit log extension). Database contents are inspected
from `pg_dump` output. No SQL is written by hand anywhere.

## 1. Latency (NFR1)

**Method.** k6 runs on the server with host networking and targets the
published ports on 127.0.0.1 (the middleware on `MIDDLEWARE_PORT`, default
3000, over HTTPS trusting only the middleware's certificate; the evaluation app
on 8081), so internet distance plays no part. Each run is a constant-arrival-rate
scenario: a 15 s warm-up, excluded from every figure, then 60 s measured. Each
combination is repeated 3 times at 10 and 50 requests per second.

- **Measurement A, app-level overhead.** Write path: baseline
  `POST /baseline/customers` (BVN stored directly) against treatment
  `POST /customers` (tokenize, then store the token). Read path: baseline
  `POST /baseline/customers/:id/read` against treatment
  `POST /customers/:id/reveal-bvn` (detokenize). Both sides run in the same
  `evaluation-app` process. Read runs first create 100 customers to read from.
- **Measurement B, the middleware alone.** `/v1/tokenize`, `/v1/detokenize`
  and `/v1/erase`, called directly with the evaluation credential. Erase runs
  first tokenize one fresh token per iteration they will make.
- **Indicative capacity.** One stepped run of `/v1/tokenize` at 25, 50, 100,
  200, 400 and 800 requests per second, 30 s each. A step holds if its error
  rate is below 1%, it achieves 95% of its target rate, and its p95 is at most
  twice the first step's. The figure reported is the highest step that holds
  before the first that does not. It aborts early if more than half the
  requests fail.

Repetition is the outermost loop and baseline and treatment run back to back,
so slow drift affects both alike.

**Burstable CPU.** There are at least 3 minutes idle (`EVAL_IDLE_SECONDS`)
between runs so CPU credits recover. Every run's start and end time (UTC) is in
`latency/runs.jsonl` and in the last table of `summary.md`. Afterwards, check
the VM's *CPU Credits Remaining* and *CPU Credits Consumed* metrics in the
Azure portal over those times: if credits ran out during a run, that run was
throttled and should be repeated.

**Output** in `latency/`:

| File | Content |
| --- | --- |
| `summary.md` | Baseline against treatment per path and rate: median, p95, p99 and mean, with overhead in ms and as a percentage; then every scenario with median, p95, p99, mean, achieved rate and error rate (mean of the repetitions, with their range); the capacity table; every repetition with its times |
| `summary.json` | The same, as data |
| `runs.jsonl` | One line per k6 run: target, rate, repetition, start, end, exit code |
| `k6/*.json` | The full k6 summary of every run |

Latency figures are k6's `http_req_duration` for the measured window: from
sending the request to the last byte of the response, on kept-alive
connections (connection and TLS setup are excluded, and happen during warm-up).

## 2. Segregation (NFR2)

Creates N = 1,000 customers through the treatment route, each with a fresh
synthetic BVN, then takes a `pg_dump` of `reference-db` and searches it.

| File | Content |
| --- | --- |
| `segregation.md` | The result: BVNs found (expected 0), 11-digit sequences found and explained, tokens found (expected N) |
| `segregation.json` | The same, as data |
| `bvns.json` | The generated synthetic BVNs |
| `customers.json`, `create.json` | The created customers (id, token) and the run's timing |
| `reference-db.sql` | The dump that was searched |

BVNs are searched for as digits and as the hex of their bytes (how a `bytea`
column would show them). Every run of 11 or more digits in the dump is
explained by where it sits. Tokens are 32 random hex characters, so about 5%
of them contain 11 decimal digits in a row by chance; those are reported as
"inside a 32-hex token". Anything standing on its own in a data column would be
reported as unexplained, by line and column only (never its value).

## 3. Irreversibility (NFR6)

| Step | Evidence |
| --- | --- |
| 1. Tokenize a synthetic BVN, record the token | `1-tokenize.json` |
| 2. `pg_dump` backup of `vault-db` | `2-vault-backup-pre-erase.dump`, `2-backup.json` (size, SHA-256) |
| 3. Erase through `/v1/erase` | `3-erase.json` |
| 4. The tombstone: the row exists, `wrappedDataKey` null, `erasedAt` set | `4-tombstone.json` (through Prisma, and the same row from `4-vault-post-erase.sql`) |
| 5. Recovery with everything in the live system: detokenize with a valid credential (expect 404, audited `ERASED`), and decrypt the remaining ciphertext with every master key version and every other live data key (expect authentication failure each time) | `5-recover-live.json` |
| 6. The stated limit: restore the pre-erase backup into `scratch-db` and show the wrapped key is there and decrypts | `6-recover-backup.json` |

`irreversibility.md` puts it together. The BVN is recorded only as its SHA-256,
and decrypted values are compared by hash.

## 4. Breach resilience (NFR3)

`breach-resilience.md` has one evidence item per scenario:

| Scenario | Folder | Evidence |
| --- | --- | --- |
| Primary database alone | `1-primary-db/` | A segregation run (100 customers): no BVN in the `reference-db` dump |
| Vault database alone | `2-vault-db/` | A plain `pg_dump`: value columns are `bytea` ciphertext, IVs, tags and wrapped keys; 1,000 random master keys fail to unwrap and 1,000 random data keys fail to decrypt this run's record |
| Key file alone | `3-key-file/` | 1,000 random KEKs and an all-zero KEK fail the AES-KW integrity check |
| Application with a valid credential | `4-credential/` | Application B gets 404 for application A's token (body identical to an unknown token's), audited `NOT_OWNER`; over the limit gets 429 with `Retry-After`, audited `RATE_LIMITED`; an INSPECT-only key gets 403 on detokenize, audited `FORBIDDEN_SCOPE` |
| Vault database, key file and KEK together | `5-all-three/` | In an isolated copy (`scratch-db`), every live record decrypts: the stated limit of the design |
| Middleware process or host | (none) | Analytical note only |

For the rate limit check the middleware is restarted with
`RATE_LIMIT_PER_MINUTE=20` (`EVAL_BREACH_RATE_LIMIT`), and set back afterwards.

## Settings

All optional. Defaults are the values in the thesis method.

| Variable | Default | Meaning |
| --- | --- | --- |
| `EVAL_RATE_LIMIT` | 1000000 | `RATE_LIMIT_PER_MINUTE` for the middleware during a run |
| `EVAL_RATES` | `10 50` | Arrival rates (requests per second) |
| `EVAL_WARMUP_SECONDS` | 15 | Warm-up per run, excluded |
| `EVAL_DURATION_SECONDS` | 60 | Measured window per run |
| `EVAL_REPEATS` | 3 | Repetitions per target and rate |
| `EVAL_IDLE_SECONDS` | 180 | Idle time between runs |
| `EVAL_LATENCY_PARTS` | `app middleware capacity` | Which of measurement A, measurement B and the capacity run to do |
| `EVAL_CAPACITY_OPERATION` | `tokenize` | `tokenize` or `detokenize` |
| `EVAL_CAPACITY_STEPS` | `25 50 100 200 400 800` | Capacity steps (requests per second) |
| `EVAL_CAPACITY_STEP_SECONDS` | 30 | Length of each step |
| `EVAL_SEGREGATION_N` | 1000 | Customers for segregation |
| `EVAL_BREACH_SEGREGATION_N` | 100 | Customers for breach scenario 1 |
| `EVAL_BREACH_RATE_LIMIT` | 20 | Limit used to show a 429 |
| `EVAL_APP_PREFIX` | `evaluation` | Name prefix of the two evaluation applications (setup only) |
| `EVALUATION_APP_PORT` | 8081 | Host port of `evaluation-app` (127.0.0.1 only) |

`smoke` uses tiny values (one repetition at 10/s, 2 s warm-up, 5 s measured,
2 s idle, a two-step capacity run, 30 and 10 customers) unless you set them.

## Credentials and secrets

`evaluation/run.sh setup` creates, without overwriting anything:

| File | Use |
| --- | --- |
| `secrets/baseline-db-password` | `baseline-db` |
| `secrets/scratch-db-password` | `scratch-db` |
| `secrets/evaluation-credentials.json` | Two applications, `evaluation-a` (A) and `evaluation-b` (B), each with a TOKENIZE, DETOKENIZE and ERASE credential, plus an INSPECT-only credential for A |

The latency and irreversibility parts use A's credential. `evaluation-app`
uses the reference app's own credential (`secrets/reference-api-key`). Results
folders never contain API keys or passwords.

When the evaluation is over, revoke the evaluation credentials (the ids are in
`secrets/evaluation-credentials.json`):

```sh
docker compose exec -T middleware node dist/cli/main.js cred:revoke --id <credentialId>
```

and, if you no longer need the baseline data, remove its volume:

```sh
docker volume rm tokenization_baseline-pgdata
```

## Local smoke run (OrbStack or Docker Desktop)

The same commands work on a laptop:

```sh
evaluation/run.sh setup
evaluation/run.sh smoke
```

The VM size is then recorded as unavailable. If the local stack runs with the
demo on, keep it on during the evaluation by exporting
`COMPOSE_FILE=docker-compose.yml:docker-compose.demo.yml` first; otherwise the
run recreates the middleware without the demo's inspect endpoint. Local numbers
are not evidence: the thesis figures come from the server only.

## Data

Synthetic BVNs only: random 11-digit strings generated by the tools and the k6
scripts. `bvns.json` keeps them because the segregation method needs them;
every other file holds only tokens, SHA-256 hashes and counts, and no tool
prints a BVN.

## Layout

```
evaluation/run.sh            the single entry point
evaluation/lib/common.sh     Compose, rate limit, pg_dump and environment helpers
evaluation/k6/latency.js     one target at one rate (warm-up and measured scenarios)
evaluation/k6/capacity.js    the stepped capacity run
evaluation/tools/            Node scripts run in the evaluator container
  lib.js                     shared helpers (middleware crypto, Prisma, dump parsing)
  environment.js             environment.json
  latency-report.js          latency/summary.md
  segregation.js             create customers; analyse the reference-db dump
  irreversibility.js         the six steps and the report
  breach.js                  the scenarios and the report
evaluation/results/          one folder per run (gitignored)
```
