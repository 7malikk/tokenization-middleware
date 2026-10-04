-- DropForeignKey
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_credential_id_fkey";

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "api_credential"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
