#!/bin/sh
# Setup for the Docker deployment. Never overwrites an existing file and never
# prints a secret.
#
#   docker compose run --rm setup               1. secrets: TLS, KEK, key file, database passwords
#   docker compose run --rm setup-vault         2. the reference app's credential (needs vault-db);
#                                                  with DEMO_INSPECT=true also its INSPECT credential
#   docker compose run --rm setup-vault rotate  rotate the master key (stop the middleware first)
#
# Step 1 needs no database: the databases cannot start until their password
# secrets exist. Step 2 runs after `migrate`, once vault-db is up.
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

secrets_phase() {
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

  for db in vault-db reference-db; do
    file="$SECRETS/$db-password"
    if [ -f "$file" ]; then
      echo "$db password: keeping existing"
    else
      node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" > "$file"
      own "$file"
      echo "$db password: generated"
    fi
  done

  # Demo login for the reference app's page. Only used when the demo is switched on.
  if [ -f "$SECRETS/demo-password" ]; then
    echo "Demo password: keeping existing"
  else
    node -e "process.stdout.write(require('crypto').randomBytes(16).toString('base64url'))" > "$SECRETS/demo-password"
    own "$SECRETS/demo-password"
    echo "Demo password: generated (secrets/demo-password, user \"demo\")"
  fi

  echo "Step 1 complete. Next: docker compose run --rm setup-vault"
}

vault_phase() {
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
    printf '%s\n' "$app_id" > "$SECRETS/reference-app-id"
    own "$SECRETS/reference-app-id"
    out=$(cli cred:create --app "$app_id" --scopes TOKENIZE,DETOKENIZE,ERASE 2> /dev/null)
    printf '%s\n' "$out" | sed -n 's/^API_KEY=//p' > "$SECRETS/reference-api-key"
    own "$SECRETS/reference-api-key"
    cred_id=$(printf '%s\n' "$out" | sed -n 's/^CREDENTIAL_ID=//p')
    echo "Reference app credential: application $app_id, credential $cred_id"
  fi

  # Demo only: a separate credential with just the INSPECT scope, for the same application.
  if [ "${DEMO_INSPECT:-false}" = "true" ]; then
    if [ -f "$SECRETS/reference-inspect-key" ]; then
      echo "Reference app INSPECT credential (demo): keeping existing"
    elif [ ! -f "$SECRETS/reference-app-id" ]; then
      echo "Cannot issue the demo INSPECT credential: secrets/reference-app-id is missing." >&2
      echo "Issue one with cred:create --scopes INSPECT and save the key to secrets/reference-inspect-key." >&2
      exit 1
    else
      app_id=$(cat "$SECRETS/reference-app-id")
      out=$(cli cred:create --app "$app_id" --scopes INSPECT 2> /dev/null)
      printf '%s\n' "$out" | sed -n 's/^API_KEY=//p' > "$SECRETS/reference-inspect-key"
      own "$SECRETS/reference-inspect-key"
      cred_id=$(printf '%s\n' "$out" | sed -n 's/^CREDENTIAL_ID=//p')
      echo "Reference app INSPECT credential (demo): credential $cred_id"
    fi
  fi
  echo "Setup complete. Start the stack with: docker compose up -d"
}

case "${1:-secrets}" in
  secrets) secrets_phase ;;
  vault) vault_phase ;;
  rotate)
    cli key:rotate
    own "$MASTER_KEY_FILE"
    ;;
  *)
    echo "usage: setup.sh [secrets|vault|rotate]" >&2
    exit 2
    ;;
esac
