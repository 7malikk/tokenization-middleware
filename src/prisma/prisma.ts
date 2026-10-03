import { Prisma, PrismaClient } from '@prisma/client';
import { resolveDatabaseUrl } from '../config/database-url';

/** Thrown for any attempt to change or remove an audit row. */
export class AuditLogAppendOnlyError extends Error {
  constructor(operation: string) {
    super(`audit_log is append-only: ${operation} is not allowed`);
    this.name = 'AuditLogAppendOnlyError';
  }
}

// AuditLog allows only these. Everything else (update, updateMany,
// updateManyAndReturn, delete, deleteMany, upsert, and anything Prisma adds
// later) is refused.
const AUDIT_LOG_ALLOWED = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

const READ_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** True if a nested write anywhere in the arguments goes through the auditLogs relation. */
function touchesAuditLogs(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array || value instanceof Date) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(touchesAuditLogs);
  }
  return Object.entries(value).some(([key, inner]) => key === 'auditLogs' || touchesAuditLogs(inner));
}

/**
 * Append-only audit log. Blocks every non-append write on AuditLog, and every
 * nested write that reaches audit rows through a parent model.
 */
export const appendOnlyAuditLog = Prisma.defineExtension({
  name: 'append-only-audit-log',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (model === 'AuditLog' && !AUDIT_LOG_ALLOWED.has(operation)) {
          throw new AuditLogAppendOnlyError(operation);
        }
        if (model !== 'AuditLog' && !READ_OPERATIONS.has(operation) && touchesAuditLogs(args)) {
          throw new AuditLogAppendOnlyError(`nested write through ${model}.${operation}`);
        }
        return query(args);
      },
    },
  },
});

/**
 * The one shared client: Prisma plus the append-only audit log extension.
 * The URL comes from DATABASE_URL, or is built from DATABASE_PASSWORD_FILE.
 */
export function createPrismaClient(env: Readonly<Record<string, string | undefined>>) {
  return new PrismaClient({ datasourceUrl: resolveDatabaseUrl(env) }).$extends(appendOnlyAuditLog);
}

export type PrismaDb = ReturnType<typeof createPrismaClient>;

/** Client handed to an interactive transaction callback. */
export type PrismaTx = Parameters<Parameters<PrismaDb['$transaction']>[0]>[0];
