import { parseArgs } from 'node:util';
import { loadEnv } from '../load-env';
import { createPrismaClient, PrismaDb } from '../prisma/prisma';
import { AdminError, createApplication, createCredential, parseScopes, revokeCredential } from './admin';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

type Command = (db: PrismaDb, args: string[], io: CliIo) => Promise<void>;

/** The complete command set. There is no delete command for anything. */
export const COMMANDS: Readonly<Record<string, Command>> = {
  'app:create': async (db, args, io) => {
    const { values } = parseArgs({ args, options: { name: { type: 'string' } }, strict: true });
    if (!values.name) {
      throw new AdminError('usage: app:create --name <name>');
    }
    const app = await createApplication(db, values.name);
    io.out(`APP_ID=${app.id}`);
  },

  'cred:create': async (db, args, io) => {
    const { values } = parseArgs({
      args,
      options: { app: { type: 'string' }, scopes: { type: 'string' } },
      strict: true,
    });
    if (!values.app || !values.scopes) {
      throw new AdminError('usage: cred:create --app <appId> --scopes TOKENIZE,DETOKENIZE,ERASE');
    }
    const credential = await createCredential(db, values.app, parseScopes(values.scopes));
    io.out(`CREDENTIAL_ID=${credential.id}`);
    io.out(`API_KEY=${credential.key}`);
    io.err('Store this API key now. It is shown once and cannot be recovered.');
  },

  'cred:revoke': async (db, args, io) => {
    const { values } = parseArgs({ args, options: { id: { type: 'string' } }, strict: true });
    if (!values.id) {
      throw new AdminError('usage: cred:revoke --id <credentialId>');
    }
    const { revokedAt } = await revokeCredential(db, values.id);
    io.out(`REVOKED_AT=${revokedAt.toISOString()}`);
  },
};

/** Run one CLI command. Returns the process exit code. */
export async function runCli(argv: string[], db: PrismaDb, io: CliIo): Promise<number> {
  const [name, ...args] = argv;
  const command = name === undefined ? undefined : COMMANDS[name];
  if (!command || !Object.hasOwn(COMMANDS, name)) {
    io.err(`usage: <command> [options], where command is one of: ${Object.keys(COMMANDS).join(', ')}`);
    return 2;
  }
  try {
    await command(db, args, io);
    return 0;
  } catch (err) {
    // Argument and admin errors carry safe messages; anything else stays generic.
    const known = err instanceof AdminError || (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
    io.err(known ? (err as Error).message : 'command failed');
    return 1;
  }
}

if (require.main === module) {
  loadEnv();
  const db = createPrismaClient(process.env.DATABASE_URL);
  const io: CliIo = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
  runCli(process.argv.slice(2), db, io)
    .then((code) => {
      process.exitCode = code;
    })
    .finally(() => db.$disconnect());
}
