# Tokenization middleware

Self-hosted middleware that protects permanent identifiers (BVN as the
representative case) for Nigerian SMEs. It exposes three operations:
tokenize, detokenize, and erase. See `CLAUDE.md` for the locked design.

Current state: **increment 3**, access control and accountability. The three
endpoints run over TLS behind API keys with per-operation scopes, a rate limit,
and an append-only audit log. The master key is still a development stand-in
(see [Temporary stand-in](#temporary-stand-in)).

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
| `MASTER_KEY_DEV` | Temporary: master key as 64 hex chars |
| `NODE_ENV` | `production` makes the temporary stand-in refuse to start |
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
  handling, the rate limiter, the CLI argument handling, the temporary key
  provider, and the test database guard. They need no database.
- **Integration and HTTP tests** (`npm run test:int`) need a reachable
  PostgreSQL at `TEST_DATABASE_URL`. They cover the schema, the vault service,
  the CLI, the append-only audit log, and the HTTP interface (authentication,
  scopes, rate limiting, the owner check, one audit row per request, and
  fail-closed auditing) through Fastify inject plus one real HTTPS request. The HTTP tests generate a throwaway certificate
  with `openssl` and capture all log output to check that no BVN appears in it.

Before any file runs, `prisma migrate deploy` brings the test database up to
date. The schema test then runs `prisma migrate reset`, which **deletes
everything** in the test database and then applies every migration from
scratch. Prisma creates the database if it does not exist. The suite refuses
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
openssl rand -hex 32       # a value for MASTER_KEY_DEV
```

Put `TLS_CERT_PATH`, `TLS_KEY_PATH` and `MASTER_KEY_DEV` in `.env`, then:

```sh
npm run start
```

This builds the app and starts NestJS on Fastify over HTTPS at `PORT`.

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

## Temporary stand-in

**`DevKeyProvider`** (`src/keys/`) implements the `KeyProvider` seam with the
master key read in plain hex from `MASTER_KEY_DEV`. It refuses to start when
`NODE_ENV=production`. Increment 4 replaces it with the encrypted master key
file unlocked by a KEK at startup.

## Layout

```
prisma/schema.prisma      vault schema (5 tables, 2 enums)
prisma/migrations/        generated by prisma migrate
src/app.factory.ts        builds the app: TLS, body limit, JSON parser, logger
src/crypto/               crypto core (plain functions) and its NestJS provider
src/keys/                 KeyProvider seam and the temporary DevKeyProvider
src/auth/                 API keys, guard (auth, scope, rate limit), clock
src/audit/                audit service and the exception filter that audits failures
src/prisma/               the shared Prisma client and its append-only extension
src/cli/                  app:create, cred:create, cred:revoke
src/vault/                endpoints, validation pipes, and the vault service
scripts/                  dev:certs helper
test/helpers/             syntheticBvn() and the test database guard
test/integration/         schema, service, CLI and audit log tests (need PostgreSQL)
test/http/                HTTP tests (need PostgreSQL and openssl)
```

## Data and logging rules

- Tests and seeds use only synthetic BVNs: random 11-digit strings from
  `syntheticBvn()`.
- Test assertions compare buffers as booleans, so a failing test never prints
  an identifier.
