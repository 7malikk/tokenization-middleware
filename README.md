# Tokenization middleware

Self-hosted middleware that protects permanent identifiers (BVN as the
representative case) for Nigerian SMEs. It exposes three operations:
tokenize, detokenize, and erase. See `CLAUDE.md` for the locked design.

Current state: **increment 2**, service interface. The three endpoints run
over TLS. Caller identity and the master key are still development stand-ins
(see [Temporary stand-ins](#temporary-stand-ins)).

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
| `MASTER_KEY_DEV` | Temporary: master key as 64 hex chars |
| `DEV_APP_ID` | Temporary: the application id every request acts as |
| `NODE_ENV` | `production` makes the temporary stand-ins refuse to start |
| `POSTGRES_PORT` | Host port for the Compose postgres service (default 5432) |

## Database migrations

Migrations live in `prisma/migrations` and come only from `prisma migrate`.

```sh
npm run prisma:migrate   # development: create and apply migrations
npm run prisma:deploy    # apply existing migrations only
```

## Tests

There are two suites.

- **Unit tests** (`npm test`) cover the crypto core, input validation, the
  temporary stand-ins, and the test database guard. They need no database.
- **Integration and HTTP tests** (`npm run test:int`) need a reachable
  PostgreSQL at `TEST_DATABASE_URL`. They cover the schema, the vault service
  (including the owner check), and the HTTP interface through Fastify inject
  plus one real HTTPS request. The HTTP tests generate a throwaway certificate
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
npm run dev:app            # create a dev application, prints DEV_APP_ID=...
openssl rand -hex 32       # a value for MASTER_KEY_DEV
```

Put `TLS_CERT_PATH`, `TLS_KEY_PATH`, `DEV_APP_ID` and `MASTER_KEY_DEV` in
`.env`, then:

```sh
npm run start
```

This builds the app and starts NestJS on Fastify over HTTPS at `PORT`.

## API

All three endpoints are `POST` with a JSON body under `/v1`, so tokens and
identifiers never appear in URLs or access logs. Bodies are limited to 4 KB
and must be `application/json`. All responses carry `Cache-Control: no-store`.

| Endpoint | Request | Success |
| --- | --- | --- |
| `/v1/tokenize` | `{ "dataType": "BVN", "value": "<11 digits>" }` | 201 `{ "token": "<32 hex>" }` |
| `/v1/detokenize` | `{ "token": "<32 hex>" }` | 200 `{ "dataType", "value" }` |
| `/v1/erase` | `{ "token": "<32 hex>" }` | 200 `{ "erased": true }` |

An unknown token, another application's token, and an erased token all get
the same 404 body: `{"message":"token not found","error":"Not Found","statusCode":404}`.
Invalid input gets a 400 whose message never repeats the submitted value.

The examples use `12345678901`, a made-up BVN. Use only synthetic values.

```sh
API=https://localhost:3000/v1

# Tokenize: returns {"token":"..."}
curl -s --cacert certs/dev-cert.pem -H 'Content-Type: application/json' \
  -X POST "$API/tokenize" -d '{"dataType":"BVN","value":"12345678901"}'

# Detokenize: returns {"dataType":"BVN","value":"12345678901"}
curl -s --cacert certs/dev-cert.pem -H 'Content-Type: application/json' \
  -X POST "$API/detokenize" -d '{"token":"<token from tokenize>"}'

# Erase: returns {"erased":true}; later detokenize calls return 404
curl -s --cacert certs/dev-cert.pem -H 'Content-Type: application/json' \
  -X POST "$API/erase" -d '{"token":"<token from tokenize>"}'
```

## Temporary stand-ins

Two seams exist so later increments are swaps, not rewrites. Both stand-ins
refuse to start when `NODE_ENV=production`.

- **`DevKeyProvider`** (`src/keys/`) implements `KeyProvider` with the master
  key read in plain hex from `MASTER_KEY_DEV`. Increment 4 replaces it with
  the encrypted master key file unlocked by a KEK at startup.
- **`DevAppGuard`** (`src/auth/`) makes every request act as the application in
  `DEV_APP_ID`. It never reads identity from the request. Increment 3 replaces
  it with API key credentials and scopes.

## Layout

```
prisma/schema.prisma      vault schema (5 tables, 2 enums)
prisma/migrations/        generated by prisma migrate
src/app.factory.ts        builds the app: TLS, body limit, JSON parser, logger
src/crypto/               crypto core (plain functions) and its NestJS provider
src/keys/                 KeyProvider seam and the temporary DevKeyProvider
src/auth/                 caller identity seam and the temporary DevAppGuard
src/vault/                endpoints, validation pipes, and the vault service
scripts/                  dev:certs and dev:app helpers
test/helpers/             syntheticBvn() and the test database guard
test/integration/         schema and service tests (need PostgreSQL)
test/http/                HTTP tests (need PostgreSQL and openssl)
```

## Data and logging rules

- Tests and seeds use only synthetic BVNs: random 11-digit strings from
  `syntheticBvn()`.
- Test assertions compare buffers as booleans, so a failing test never prints
  an identifier.
