#!/bin/sh
# One-shot setup for the Docker deployment. Runs in the `setup` service:
#   docker compose run --rm setup          create whatever is missing
#   docker compose run --rm setup rotate   rotate the master key (stop the middleware first)
#
# Writes to /secrets (Compose secrets source) and /keys (key file). Never
# overwrites an existing file and never prints a secret.
set -eu
umask 077

SECRETS=/secrets
KEYS=/keys
RUNTIME_UID=1000 # the image's non-root `node` user, which reads these files
cli() { node dist/cli/main.js "$@"; }

export MASTER_KEK_FILE="$SECRETS/master-kek"
export MASTER_KEY_FILE="$KEYS/master-keys.json"

own() {
  chown "$RUNTIME_UID:$RUNTIME_UID" "$@"
  chmod 600 "$@"
}

if [ "${1:-}" = "rotate" ]; then
  cli key:rotate
  own "$MASTER_KEY_FILE"
  exit 0
fi
if [ -n "${1:-}" ]; then
  echo "usage: setup [rotate]" >&2
  exit 2
fi

mkdir -p "$SECRETS" "$KEYS"

if [ -f "$SECRETS/tls-cert.pem" ] && [ -f "$SECRETS/tls-key.pem" ]; then
  echo "TLS certificate: keeping existing"
else
  tmp=$(mktemp -d)
  node scripts/dev-certs.js "$tmp" > /dev/null
  mv "$tmp/dev-cert.pem" "$SECRETS/tls-cert.pem"
  mv "$tmp/dev-key.pem" "$SECRETS/tls-key.pem"
  rmdir "$tmp"
  own "$SECRETS/tls-key.pem"
  chown "$RUNTIME_UID:$RUNTIME_UID" "$SECRETS/tls-cert.pem"
  chmod 644 "$SECRETS/tls-cert.pem"
  echo "TLS certificate: created self-signed (localhost, middleware)"
fi

if [ -f "$MASTER_KEK_FILE" ]; then
  echo "KEK: keeping existing"
else
  cli key:generate-kek 2> /dev/null | sed -n 's/^MASTER_KEK=//p' > "$MASTER_KEK_FILE"
  own "$MASTER_KEK_FILE"
  echo "KEK: created in secrets/master-kek. Back it up separately from keys/."
fi

if [ -f "$MASTER_KEY_FILE" ]; then
  echo "Master key file: keeping existing"
else
  cli key:init > /dev/null
  own "$MASTER_KEY_FILE"
  echo "Master key file: created keys/master-keys.json (version 1)"
fi

if [ -f "$SECRETS/reference-api-key" ]; then
  echo "Reference app credential: keeping existing"
else
  name="${REFERENCE_APP_NAME:-reference-app}"
  app_id=$(cli app:create --name "$name" | sed -n 's/^APP_ID=//p')
  if [ -z "$app_id" ]; then
    echo "Could not create application \"$name\". If it already exists, issue a key with" >&2
    echo "cred:create and save it to secrets/reference-api-key." >&2
    exit 1
  fi
  out=$(cli cred:create --app "$app_id" --scopes TOKENIZE,DETOKENIZE,ERASE 2> /dev/null)
  printf '%s\n' "$out" | sed -n 's/^API_KEY=//p' > "$SECRETS/reference-api-key"
  own "$SECRETS/reference-api-key"
  cred_id=$(printf '%s\n' "$out" | sed -n 's/^CREDENTIAL_ID=//p')
  echo "Reference app credential: application $app_id, credential $cred_id"
fi

echo "Setup complete. Start the stack with: docker compose up -d"
