# Tokenization middleware

Self-hosted middleware that protects permanent identifiers (BVN as the
representative case) for Nigerian SMEs. It exposes three operations:
tokenize, detokenize, and erase. See `CLAUDE.md` for the locked design.

Current state: **increment 4**, key layer and bootstrap. The three endpoints
run over TLS behind API keys with per-operation scopes, a rate limit, and an
append-only audit log. Data keys are wrapped under master keys that live in an
encrypted key file, unlocked at startup by a key-encryption key (KEK) and held
only in memory.

## Requirements

- Node.js 22 or later (`.nvmrc` pins 22)
- PostgreSQL 16, either installed natively or run through Docker Compose
- The `openssl` command-line tool, for `npm run dev:certs` and the HTTP tests

## Setup

```sh
npm install          # also runs `prisma generate`
cp .env.example .env # then edit the URLs for your database
```

All configuration comes from environment variables. Natively they are read
from `.env`. Variables already set in the environment take precedence over it.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Vault database used by the app and by `prisma migrate` |
| `TEST_DATABASE_URL` | Database the integration suite resets. Must differ from `DATABASE_URL` and its name must end in `_test` |
| `PORT` | HTTPS port for `npm run start` (default 3000) |
| `TLS_CERT_PATH`, `TLS_KEY_PATH` | TLS certificate and key (PEM). Required: the server refuses to start without them |
| `ALLOWED_DATA_TYPES` | Comma-separated data types tokenize accepts (default `BVN`) |
| `LOG_LEVEL` | Fastify log level (default `info`). Bodies are never logged |
| `RATE_LIMIT_PER_MINUTE` | Requests allowed per credential, per operation, per minute (default 600) |
| `MASTER_KEY_FILE` | Path to the master key file (from `npm run key:init`) |
| `MASTER_KEK` | The KEK as 64 hex chars. Removed from the process environment once read |
| `MASTER_KEK_FILE` | Path to a file holding the KEK (for example a Docker secret). Set this or `MASTER_KEK`, never both |
| `POSTGRES_PORT` | Host port for the Compose postgres service (default 5432) |

## Database migrations

Migrations live in `prisma/migrations` and come only from `prisma migrate`.

```sh
npm run prisma:migrate   # development: create and apply migrations
npm run prisma:deploy    # apply existing migrations only
```

## Tests

There are two suites.

- **Unit tests** (`npm test`) cover the crypto core, input validation, API key
  handling, the rate limiter, the CLI argument handling, the key file and
  key provider (including every startup refusal), and the test database guard. They need no database.
- **Integration and HTTP tests** (`npm run test:int`) need a reachable
  PostgreSQL at `TEST_DATABASE_URL`. They cover the schema, the vault service,
  the CLI, the append-only audit log, and the HTTP interface (authentication,
  scopes, rate limiting, the owner check, one audit row per request, and
  fail-closed auditing) through Fastify inject plus one real HTTPS request. The HTTP tests generate a throwaway certificate
  with `openssl` and capture all log output to check that no BVN appears in it.

Before any file runs, `prisma migrate deploy` brings the test database up to
date. The schema test and the rotation test each run `prisma migrate reset`,
which **deletes everything** in the test database and then applies every
migration from scratch. (Rotation rewraps every live record, so its test needs
a vault holding only its own records.) Prisma creates the database if it does not exist. The suite refuses
to start unless the database name in `TEST_DATABASE_URL` ends in `_test` and
the URL differs from `DATABASE_URL`. The check reads the database name from the
URL path and ignores the `?schema=` parameter, so
`.../vault?schema=vault_test` is refused. Never point it at a database you care
about.

### Natively

With a local PostgreSQL running:

```sh
# .env
DATABASE_URL="postgresql://<user>@localhost:5432/vault?schema=vault"
TEST_DATABASE_URL="postgresql://<user>@localhost:5432/vault_test?schema=vault_test"
```

```sh
npm test
npm run test:int
```

### With Docker

`docker-compose.yml` currently defines only the `postgres` service. The app
service arrives in increment 5. The tests run on the host against the
containerized database.

```sh
docker compose up -d postgres
```

The service publishes on host port `POSTGRES_PORT` (default 5432). If a native
PostgreSQL already uses 5432, pick another port:

```sh
POSTGRES_PORT=5433 docker compose up -d postgres
```

Then point the URLs at the container. The default credentials are
`vault` / `vault`. Either put these in `.env` or pass them inline:

```sh
DATABASE_URL="postgresql://vault:vault@localhost:5433/vault?schema=vault" \
TEST_DATABASE_URL="postgresql://vault:vault@localhost:5433/vault_test?schema=vault_test" \
npm run test:int
```

`npm test` needs no database, so it runs the same way in both setups.

To stop the service, run `docker compose down`. Add `-v` to also delete its
data volume.

## Running the app

The server only starts with TLS configured. For local development:

```sh
npm run dev:certs          # self-signed cert and key in certs/ (gitignored)
npm run prisma:deploy      # apply migrations to DATABASE_URL
```

Then set up the key layer (next section), put `TLS_CERT_PATH`,
`TLS_KEY_PATH` and `MASTER_KEY_FILE` in `.env`, and start the server with
one KEK source:

```sh
# KEK from a file (preferred: the KEK never enters the environment)
MASTER_KEK_FILE=keys/kek npm run start

# or KEK from the environment (removed from process.env once read)
MASTER_KEK=<64 hex chars> npm run start
```

This builds the app and starts NestJS on Fastify over HTTPS at `PORT`. At
startup it reads the KEK, unwraps every master key version into memory, and
zeroizes the KEK. It refuses to start, with a message that holds no key
material, if there is no KEK, if both KEK sources are set, if the key file is
missing or malformed, or if any version fails to unwrap (wrong KEK or a
tampered file).

## Key layer

Each record's data key is wrapped (AES-KW) under a master key. Master keys are
stored in `MASTER_KEY_FILE`, each one wrapped under the KEK with the same
AES-KW primitive, so the file never holds a master key in the clear:

```json
{ "active": 2, "keys": [{ "version": 1, "wrapped": "<80 hex>" }, { "version": 2, "wrapped": "<80 hex>" }] }
```

New records use the active version. Each record stores the version it was
wrapped under, so older versions stay in the file.

### Generate a KEK and initialise the key file

```sh
npm run -s key:generate-kek
# MASTER_KEK=<64 hex chars>   (shown once)

# Store the KEK somewhere safe, separate from the key file and the database.
# For a KEK file:
umask 077 && printf '%s\n' '<64 hex chars>' > keys/kek

MASTER_KEK_FILE=keys/kek npm run -s key:init
# KEY_FILE_VERSION=1
```

`key:init` creates `MASTER_KEY_FILE` (mode 0600) with version 1 and refuses
if the file already exists. Losing the KEK or the key file makes every token
unrecoverable, so back both up, separately.

### Rotate the master key

Stop the server first: a running server holds the master keys it loaded at
startup and would not know the new version.

```sh
MASTER_KEK_FILE=keys/kek npm run -s key:rotate
# ACTIVE_VERSION=2
# ROTATED_RECORDS=1234
# ERASED_RECORDS_SKIPPED=56
```

Rotation adds a new version to the key file and makes it active, then
rewraps the data key of every live record under it, in batches. Only
`wrapped_data_key` and `master_key_version` change; `ciphertext`, `iv` and
`auth_tag` are never touched, and erased records (which have no wrapped key)
are skipped. The new version is written to the key file before any record
changes. If rotation stops partway, run it again: when live records are still
below the active version it finishes that rotation instead of adding another
version. Then start the server again.

## Applications and credentials

Every request needs an API key. Keys belong to an application and carry
scopes: `TOKENIZE`, `DETOKENIZE` and `ERASE`. An application can only
detokenize or erase the tokens it created, whichever of its keys is used.

```sh
npm run -s app:create -- --name billing
# APP_ID=6f1c...

npm run -s cred:create -- --app <APP_ID> --scopes TOKENIZE,DETOKENIZE,ERASE
# CREDENTIAL_ID=2b9e...
# API_KEY=tkm_...

npm run -s cred:revoke -- --id <CREDENTIAL_ID>
# REVOKED_AT=2026-...
```

- The key (`tkm_` plus 32 random bytes in base64url) is printed **once**. The
  database stores only its SHA-256 hash, so a lost key cannot be recovered;
  issue a new one and revoke the old.
- Revoking sets `revoked_at`. Nothing is ever deleted: there is no delete
  command, so audit rows always point at a real credential.
- Each command builds the app first, then runs against `DATABASE_URL`.

## API

All three endpoints are `POST` with a JSON body under `/v1`, so tokens and
identifiers never appear in URLs or access logs. Bodies are limited to 4 KB
and must be `application/json`. All responses carry `Cache-Control: no-store`.

Send the key as `Authorization: Bearer <API_KEY>`. Every request is checked
in this order:

1. **Authentication.** A missing or malformed header, an unknown key, or a
   revoked key all get the same 401.
2. **Scope.** A key without the endpoint's operation gets 403.
3. **Rate limit.** Over `RATE_LIMIT_PER_MINUTE` for this credential and
   operation in the current one-minute window gets 429 with `Retry-After`.
   The limit is held in memory, so it applies per running instance.

| Endpoint | Request | Success |
| --- | --- | --- |
| `/v1/tokenize` | `{ "dataType": "BVN", "value": "<11 digits>" }` | 201 `{ "token": "<32 hex>" }` |
| `/v1/detokenize` | `{ "token": "<32 hex>" }` | 200 `{ "dataType", "value" }` |
| `/v1/erase` | `{ "token": "<32 hex>" }` | 200 `{ "erased": true }` |

An unknown token, another application's token, and an erased token all get
the same 404 body: `{"message":"token not found","error":"Not Found","statusCode":404}`.
Invalid input gets a 400 whose message never repeats the submitted value.

Every request to these endpoints writes exactly one audit row: credential,
operation, token, outcome and time. The outcome is the true one (for example
`NOT_OWNER`), even though the client only sees "not found". Audit rows never
hold an identifier value, and the client extension on the shared Prisma client
refuses every update or delete of them. Auditing fails closed: tokenize and
erase commit their audit row in the same transaction as the vault change, and
detokenize releases the value only after its audit row is written. Requests
that Fastify rejects while reading the body (malformed JSON 400, 413, 415)
never reach the guard and are not audited.

The examples use `12345678901`, a made-up BVN. Use only synthetic values.

```sh
API=https://localhost:3000/v1
KEY=tkm_...   # from cred:create

# Tokenize: returns {"token":"..."}
curl -s --cacert certs/dev-cert.pem -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $KEY" \
  -X POST "$API/tokenize" -d '{"dataType":"BVN","value":"12345678901"}'

# Detokenize: returns {"dataType":"BVN","value":"12345678901"}
curl -s --cacert certs/dev-cert.pem -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $KEY" \
  -X POST "$API/detokenize" -d '{"token":"<token from tokenize>"}'

# Erase: returns {"erased":true}; later detokenize calls return 404
curl -s --cacert certs/dev-cert.pem -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $KEY" \
  -X POST "$API/erase" -d '{"token":"<token from tokenize>"}'
```

## Layout

```
prisma/schema.prisma      vault schema (5 tables, 2 enums)
prisma/migrations/        generated by prisma migrate
src/app.factory.ts        builds the app: TLS, body limit, JSON parser, logger
src/crypto/               crypto core (plain functions) and its NestJS provider
src/keys/                 key file, FileKeyProvider, and master key rotation
src/auth/                 API keys, guard (auth, scope, rate limit), clock
src/audit/                audit service and the exception filter that audits failures
src/prisma/               the shared Prisma client and its append-only extension
src/cli/                  app, credential and key commands
src/vault/                endpoints, validation pipes, and the vault service
scripts/                  dev:certs helper
test/helpers/             syntheticBvn() and the test database guard
test/integration/         schema, service, CLI, audit log and rotation tests (need PostgreSQL)
test/http/                HTTP tests (need PostgreSQL and openssl)
```

## Data and logging rules

- Tests and seeds use only synthetic BVNs: random 11-digit strings from
  `syntheticBvn()`.
- Test assertions compare buffers as booleans, so a failing test never prints
  an identifier.
