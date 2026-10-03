-- CreateEnum
CREATE TYPE "operation" AS ENUM ('TOKENIZE', 'DETOKENIZE', 'ERASE');

-- CreateEnum
CREATE TYPE "outcome" AS ENUM ('SUCCESS', 'UNAUTHENTICATED', 'FORBIDDEN_SCOPE', 'NOT_FOUND', 'NOT_OWNER', 'ERASED', 'ERROR');

-- CreateTable
CREATE TABLE "application" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_credential" (
    "id" UUID NOT NULL,
    "app_id" UUID NOT NULL,
    "key_hash" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "api_credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credential_scope" (
    "credential_id" UUID NOT NULL,
    "operation" "operation" NOT NULL,

    CONSTRAINT "credential_scope_pkey" PRIMARY KEY ("credential_id","operation")
);

-- CreateTable
CREATE TABLE "vault_record" (
    "token" CHAR(32) NOT NULL,
    "app_id" UUID NOT NULL,
    "data_type" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "iv" BYTEA NOT NULL,
    "auth_tag" BYTEA NOT NULL,
    "wrapped_data_key" BYTEA,
    "master_key_version" SMALLINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erased_at" TIMESTAMPTZ(6),

    CONSTRAINT "vault_record_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "credential_id" UUID,
    "operation" "operation" NOT NULL,
    "token" TEXT,
    "outcome" "outcome" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "application_name_key" ON "application"("name");

-- CreateIndex
CREATE UNIQUE INDEX "api_credential_key_hash_key" ON "api_credential"("key_hash");

-- CreateIndex
CREATE INDEX "api_credential_app_id_idx" ON "api_credential"("app_id");

-- CreateIndex
CREATE INDEX "vault_record_app_id_idx" ON "vault_record"("app_id");

-- CreateIndex
CREATE INDEX "audit_log_credential_id_idx" ON "audit_log"("credential_id");

-- AddForeignKey
ALTER TABLE "api_credential" ADD CONSTRAINT "api_credential_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credential_scope" ADD CONSTRAINT "credential_scope_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "api_credential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_record" ADD CONSTRAINT "vault_record_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "application"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "api_credential"("id") ON DELETE SET NULL ON UPDATE CASCADE;
