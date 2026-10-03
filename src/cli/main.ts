import { parseArgs } from 'node:util';
import { zeroize } from '../crypto/crypto';
import { generateKekHex, initKeyFile, KeyLayerError, takeKek } from '../keys/key-file';
import { rotateMasterKey } from '../keys/rotate';
import { loadEnv } from '../load-env';
import { createPrismaClient, PrismaDb } from '../prisma/prisma';
import { AdminError, createApplication, createCredential, parseScopes, revokeCredential } from './admin';

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CliContext {
  /** Environment the command reads. A KEK from MASTER_KEK is deleted from it. */
  env: Record<string, string | undefined>;
  /** The shared Prisma client, opened only by commands that need it. */
  db: () => PrismaDb;
  io: CliIo;
}

type Command = (ctx: CliContext, args: string[]) => Promise<void>;

function noArgs(name: string, args: string[]): void {
  parseArgs({ args, options: {}, strict: true });
  if (args.length > 0) {
    throw new AdminError(`usage: ${name}`);
  }
}

/** The complete command set. There is no delete command for anything. */
export const COMMANDS: Readonly<Record<string, Command>> = {
  'app:create': async ({ db, io }, args) => {
    const { values } = parseArgs({ args, options: { name: { type: 'string' } }, strict: true });
    if (!values.name) {
      throw new AdminError('usage: app:create --name <name>');
    }
    const app = await createApplication(db(), values.name);
    io.out(`APP_ID=${app.id}`);
  },

  'cred:create': async ({ db, io }, args) => {
    const { values } = parseArgs({
      args,
      options: { app: { type: 'string' }, scopes: { type: 'string' } },
      strict: true,
    });
    if (!values.app || !values.scopes) {
      throw new AdminError('usage: cred:create --app <appId> --scopes TOKENIZE,DETOKENIZE,ERASE');
    }
    const credential = await createCredential(db(), values.app, parseScopes(values.scopes));
    io.out(`CREDENTIAL_ID=${credential.id}`);
    io.out(`API_KEY=${credential.key}`);
    io.err('Store this API key now. It is shown once and cannot be recovered.');
  },

  'cred:revoke': async ({ db, io }, args) => {
    const { values } = parseArgs({ args, options: { id: { type: 'string' } }, strict: true });
    if (!values.id) {
      throw new AdminError('usage: cred:revoke --id <credentialId>');
    }
    const { revokedAt } = await revokeCredential(db(), values.id);
    io.out(`REVOKED_AT=${revokedAt.toISOString()}`);
  },

  'key:generate-kek': async ({ io }, args) => {
    noArgs('key:generate-kek', args);
    io.out(`MASTER_KEK=${generateKekHex()}`);
    io.err(
      'Store this KEK somewhere safe and separate from the key file and database ' +
        '(a password manager or secret store). It is shown once. Without it the ' +
        'master keys, and so every token, cannot be recovered.',
    );
  },

  'key:init': async ({ env, io }, args) => {
    noArgs('key:init', args);
    const kek = takeKek(env);
    try {
      initKeyFile(env.MASTER_KEY_FILE, kek);
    } finally {
      zeroize(kek);
    }
    io.out('KEY_FILE_VERSION=1');
  },

  'key:rotate': async ({ env, db, io }, args) => {
    noArgs('key:rotate', args);
    const kek = takeKek(env);
    let result;
    try {
      result = await rotateMasterKey(db(), env.MASTER_KEY_FILE, kek);
    } finally {
      zeroize(kek);
    }
    if (result.resumed) {
      io.err(`Finished an interrupted rotation to version ${result.version}.`);
    }
    io.out(`ACTIVE_VERSION=${result.version}`);
    io.out(`ROTATED_RECORDS=${result.rotated}`);
    io.out(`ERASED_RECORDS_SKIPPED=${result.erasedSkipped}`);
    io.err('Restart the server so it loads the new active version.');
  },
};

/** Run one CLI command. Returns the process exit code. */
export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  const [name, ...args] = argv;
  const command = name !== undefined && Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!command) {
    ctx.io.err(`usage: <command> [options], where command is one of: ${Object.keys(COMMANDS).join(', ')}`);
    return 2;
  }
  try {
    await command(ctx, args);
    return 0;
  } catch (err) {
    // Admin, key layer and argument errors carry safe messages; anything else stays generic.
    const known =
      err instanceof AdminError ||
      err instanceof KeyLayerError ||
      (err as { code?: string }).code?.startsWith('ERR_PARSE_ARGS');
    ctx.io.err(known ? (err as Error).message : 'command failed');
    return 1;
  }
}

if (require.main === module) {
  loadEnv();
  let db: PrismaDb | undefined;
  const ctx: CliContext = {
    env: process.env,
    db: () => (db ??= createPrismaClient(process.env)),
    io: {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    },
  };
  runCli(process.argv.slice(2), ctx)
    .then((code) => {
      process.exitCode = code;
    })
    .finally(() => db?.$disconnect());
}
