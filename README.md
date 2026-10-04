# Tokenization middleware

Self-hosted middleware that protects permanent identifiers (BVN as the
representative case) for Nigerian SMEs. It exposes three operations:
tokenize, detokenize, and erase. See `CLAUDE.md` for the locked design.

Current state: **increment 5**, packaging and reference integration. The three endpoints
run over TLS behind API keys with per-operation scopes, a rate limit, and an
append-only audit log. Data keys are wrapped under master keys that live in an
encrypted key file, unlocked at startup by a key-encryption key (KEK) and held
only in memory. It ships as a Docker Compose stack alongside a reference
application that stores only tokens.

The repository holds two separate Node.js projects and the Compose files that
run them together:

```
middleware/               the tokenization middleware (its own package.json)
reference_app/            the reference application (its own package.json)
docker-compose.yml        full stack; run docker compose from the repository root
```

Unless a section says otherwise, `npm` commands for the middleware run in
`middleware/`, and `docker compose` commands run in the repository root.

## Requirements

- Node.js 22 or later (`.nvmrc` pins 22)
- PostgreSQL 16, either installed natively or run through Docker Compose
- The `openssl` command-line tool, for `npm run dev:certs` and the HTTP tests

## Setup

```sh
cd middleware
npm install          # also runs `prisma generate`
cp .env.example .env # then edit the URLs for your database
```

All configuration comes from environment variables. Natively they are read
from `.env`. Variables already set in the environment take precedence over it.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Vault database used by the app and by `prisma migrate` (native runs) |
| `DATABASE_PASSWORD_FILE` | Instead of `DATABASE_URL` (Docker): file holding the database password. Needs `DATABASE_HOST`, `DATABASE_NAME`, `DATABASE_USER`; optional `DATABASE_PORT` (5432), `DATABASE_SCHEMA` |
| `TEST_DATABASE_URL` | Database the integration suite resets. Must differ from `DATABASE_URL` and its name must end in `_test` |
| `PORT` | HTTPS port for `npm run start` (default 3000) |
| `TLS_CERT_PATH`, `TLS_KEY_PATH` | TLS certificate and key (PEM). Required: the server refuses to start without them |
| `ALLOWED_DATA_TYPES` | Comma-separated data types tokenize accepts (default `BVN`) |
| `LOG_LEVEL` | Fastify log level (default `info`). Bodies are never logged |
| `RATE_LIMIT_PER_MINUTE` | Requests allowed per credential, per operation, per minute (default 600) |
| `MASTER_KEY_FILE` | Path to the master key file (from `npm run key:init`) |
| `MASTER_KEK` | The KEK as 64 hex chars. Removed from the process environment once read |
| `MASTER_KEK_FILE` | Path to a file holding the KEK (for example a Docker secret). Set this or `MASTER_KEK`, never both |
| `VAULT_DB_PORT` | Host port for `vault-db` when using `docker-compose.db-ports.yml` (default 5433) |

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

The test suites run on the host against the Compose databases. Their ports
are not published by default, so add the debug override (from the repository
root):

```sh
docker compose -f docker-compose.yml -f docker-compose.db-ports.yml up -d vault-db
```

`vault-db` is then on `127.0.0.1:5433` (set `VAULT_DB_PORT` to change it).
Its user is `vault` and its password is the one setup generated in
`secrets/vault-db-password` (run `docker compose run --rm setup` first). Then,
from `middleware/`:

```sh
PW=$(cat ../secrets/vault-db-password)
DATABASE_URL="postgresql://vault:$PW@localhost:5433/vault?schema=vault" \
TEST_DATABASE_URL="postgresql://vault:$PW@localhost:5433/vault_test?schema=vault_test" \
npm run test:int
```

`npm test` needs no database, so it runs the same way in both setups.

The full deployment has its own end-to-end test, which builds the images and
runs a clean, isolated stack (separate Compose project, secrets and ports),
then tears it down. It runs from `middleware/`:

```sh
cd middleware
npm run e2e:docker
```

On OrbStack, the check that the reference app cannot reach `vault-db` by IP is
reported as SKIP (see below). On any other engine it must pass.

## Deploy with Docker

Needs only Docker with Compose v2. No Node.js on the host.

```sh
git clone <repository> && cd <repository>

docker compose run --rm setup          # 1. secrets
docker compose run --rm setup-vault    # 2. the reference app's credential
docker compose up -d
```

Setup creates whatever is missing and never overwrites an existing file.
Step 1 needs no database; step 2 starts `vault-db`, applies the migrations,
then registers the reference app.

| Created | Step | Used as |
| --- | --- | --- |
| `secrets/tls-cert.pem`, `secrets/tls-key.pem` | 1 | Self-signed certificate for `localhost` and `middleware` |
| `secrets/master-kek` | 1 | The KEK (Compose secret, `MASTER_KEK_FILE`) |
| `keys/master-keys.json` | 1 | The master key file, mounted read-only |
| `secrets/vault-db-password` | 1 | Random password for `vault-db` |
| `secrets/reference-db-password` | 1 | Random password for `reference-db` |
| `secrets/reference-api-key` | 2 | The reference app's credential (all three scopes) |

Each database reads its password with `POSTGRES_PASSWORD_FILE`. The services
that connect to it get the host, name and user as plain settings and the
password only as a Compose secret (`DATABASE_PASSWORD_FILE`); they build the
connection URL in memory at startup. No password appears in the Compose files,
env files, images or logs. Natively, `DATABASE_URL` from `.env` is used
unchanged.

A database takes its password when its volume is first initialised. Keep
`secrets/*-db-password` with the data: if you regenerate a password for an
existing volume, that database will refuse it. To start over, run
`docker compose down -v` (this deletes both databases) and set up again.

On Docker Desktop for Mac, if the clone sits in a privacy-protected folder
such as `~/Documents`, macOS can block Docker from mounting `secrets/` and
`keys/` ("operation not permitted"). Grant Docker Desktop access in System Settings,
Privacy & Security, Files and Folders, or clone somewhere else.

`secrets/` and `keys/` are gitignored and excluded from every image. Back up
`secrets/master-kek` and `keys/` separately: without both, no token can ever
be detokenized.

Then:

- the middleware is at `https://localhost:3000` (`MIDDLEWARE_PORT`)
- the reference app is at `http://localhost:8080` (`REFERENCE_PORT`)

Both publish on `127.0.0.1` only. Set `MIDDLEWARE_BIND` or `REFERENCE_BIND`
to expose them more widely.

```sh
curl -s localhost:8080/customers -H 'Content-Type: application/json' \
  -d '{"fullName":"Ada Obi","bvn":"12345678901"}'
# {"id":"...","fullName":"Ada Obi","bvnToken":"..."}

curl -s localhost:8080/customers/<id>
curl -s -X POST localhost:8080/customers/<id>/reveal-bvn
curl -s -X POST localhost:8080/customers/<id>/erase
```

Services:

| Service | Networks | Role |
| --- | --- | --- |
| `vault-db` | `vault-net` | Vault database |
| `migrate` | `vault-net` | One-shot `prisma migrate deploy` for the vault |
| `middleware` | `vault-net`, `app-net` | The tokenization middleware (HTTPS) |
| `reference-db` | `app-net` | The reference app's database |
| `reference-migrate` | `app-net` | One-shot migrations for the reference database |
| `reference-app` | `app-net` | The reference application |
| `setup` | none | Step 1: writes the secret files (profile `setup`, run on demand) |
| `setup-vault` | `vault-net` | Step 2 and key rotation (profile `setup`, run on demand) |

`vault-net` is internal (no outside connectivity), and the reference app is
not on it, so it has no network path to `vault-db`. This relies on the Docker
Engine isolating bridge networks from each other, which it does on Linux and
in Docker Desktop. OrbStack does not enforce that isolation: there the
reference app cannot resolve `vault-db` by name but can still reach it by IP,
and `npm run e2e:docker` (run from `middleware/`) reports that check as SKIP
there. It still fails on any other engine that lets the connection through. The middleware and
reference app run as a non-root user with a read-only root filesystem and no
Linux capabilities. Secrets reach containers only as Compose secrets under
`/run/secrets`; the reference app receives the middleware certificate and its
API key, never the TLS key or KEK.

Other operations:

```sh
docker compose logs -f middleware
docker compose stop middleware && docker compose run --rm setup-vault rotate && docker compose up -d
docker compose down          # stop; add -v to also delete both databases
```

For debugging, `docker-compose.db-ports.yml` publishes `vault-db` on
`127.0.0.1:5433` and `reference-db` on `127.0.0.1:5434`.

### Administering applications and credentials

The admin CLI ships in the middleware image. Run it inside the running
`middleware` container, from the repository directory, with the stack up. It
reaches `vault-db` with the container's own database secret, so no password
or URL is needed on the command line. Its output goes only to your terminal,
never to the container logs.

Register an application, and note its id:

```sh
docker compose exec -T middleware node dist/cli/main.js app:create --name billing-service
# APP_ID=6bbc1fb8-f9de-4df6-ad20-5be07b33f1c0
```

Issue a credential for it, with only the scopes it needs (any of `TOKENIZE`,
`DETOKENIZE`, `ERASE`):

```sh
docker compose exec -T middleware node dist/cli/main.js cred:create --app <APP_ID> --scopes TOKENIZE,DETOKENIZE
# CREDENTIAL_ID=3a6b3b04-d33f-44a8-975c-63f550af3582
# API_KEY=tkm_...
# Store this API key now. It is shown once and cannot be recovered.
```

Hand the `API_KEY` to the application's own secret store straight away: the
vault keeps only its SHA-256 hash, so it can never be shown again. Keep the
`CREDENTIAL_ID`; it is what you revoke. A key works only for its own
application's tokens, and only for its scopes (a request outside them gets 403).

Revoke a credential. It stops working on the next request (401):

```sh
docker compose exec -T middleware node dist/cli/main.js cred:revoke --id <CREDENTIAL_ID>
# REVOKED_AT=2026-10-04T11:50:05.388Z
```

To replace a key, issue a new credential for the same application, switch the
application over, then revoke the old one. Nothing is ever deleted: there is
no delete command, so every audit row keeps pointing at a real credential.
A command that fails (a duplicate application name, an unknown scope, an
unknown id) prints the reason and exits with status 1.

## Running the app natively

The server only starts with TLS configured. For local development, from
`middleware/`:

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

## Reference application

`reference_app/` is a separate service with its own Prisma schema and its own
database. Its one table, `customer`, holds `id`, `full_name` and `bvn_token`:
there is no BVN column. It talks to the middleware over HTTPS, trusting only
the middleware's certificate (`MIDDLEWARE_CA_PATH` replaces the system CAs),
and authenticates with its own API key.

| Endpoint | Does |
| --- | --- |
| `POST /customers` `{ fullName, bvn }` | Tokenizes the BVN, stores only the token, returns the customer |
| `GET /customers/:id` | Returns the customer with its token, never the BVN |
| `POST /customers/:id/reveal-bvn` | Detokenizes and returns `{ bvn }` for this one response (`no-store`) |
| `POST /customers/:id/erase` | Erases the BVN in the vault; the customer keeps its now-dead token |

After erasure, reveal returns 404. Any middleware failure becomes one fixed
502. If saving a customer fails after tokenizing, the new token is erased.

### Running the reference app natively

With the middleware running natively (see above):

```sh
cd reference_app
npm install
cp .env.example .env     # DATABASE_URL, MIDDLEWARE_URL, MIDDLEWARE_CA_PATH
npm run prisma:deploy

# From the middleware directory, issue the app a credential:
#   npm run -s app:create -- --name reference-app
#   npm run -s cred:create -- --app <APP_ID> --scopes TOKENIZE,DETOKENIZE,ERASE
REFERENCE_API_KEY=tkm_... npm run start      # or REFERENCE_API_KEY_FILE=<path>
```

Its tests run against a local database and a fake HTTPS middleware:

```sh
npm test            # unit tests
npm run test:int    # needs PostgreSQL at TEST_DATABASE_URL (name ending in _test)
```

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
# from middleware/
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
docker-compose.yml                   full stack; docker-compose.db-ports.yml for debugging
middleware/Dockerfile                middleware image (runtime, migrate and setup targets)
middleware/docker/setup.sh           the setup service's script
middleware/prisma/schema.prisma      vault schema (5 tables, 2 enums)
middleware/prisma/migrations/        generated by prisma migrate
middleware/src/app.factory.ts        builds the app: TLS, body limit, JSON parser, logger
middleware/src/crypto/               crypto core (plain functions) and its NestJS provider
middleware/src/keys/                 key file, FileKeyProvider, and master key rotation
middleware/src/auth/                 API keys, guard (auth, scope, rate limit), clock
middleware/src/audit/                audit service and the exception filter that audits failures
middleware/src/prisma/               the shared Prisma client and its append-only extension
middleware/src/cli/                  app, credential and key commands
middleware/src/vault/                endpoints, validation pipes, and the vault service
middleware/scripts/                  dev:certs helper and the Docker e2e test
middleware/test/helpers/             syntheticBvn() and the test database guard
middleware/test/integration/         schema, service, CLI, audit log and rotation tests (need PostgreSQL)
middleware/test/http/                HTTP tests (need PostgreSQL and openssl)
reference_app/                       the reference application (own schema, database, tests)
```

## Data and logging rules

- Tests and seeds use only synthetic BVNs: random 11-digit strings from
  `syntheticBvn()`.
- Test assertions compare buffers as booleans, so a failing test never prints
  an identifier.
