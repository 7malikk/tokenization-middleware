'use strict';
// Builds environment.json from the raw facts run.sh gathered on the host
// (docker info and version, image digests, git commit, OS release, settings),
// plus the VM size from Azure's instance metadata endpoint.
//
//   node environment.js <resultsDir>
// Reads <resultsDir>/environment-raw/, writes <resultsDir>/environment.json.

const { existsSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { log, writeJson } = require('./lib');

const IMDS_URL = 'http://169.254.169.254/metadata/instance?api-version=2021-02-01';

async function main() {
  const dir = process.argv[2];
  const raw = join(dir, 'environment-raw');
  const read = (name) => (existsSync(join(raw, name)) ? readFileSync(join(raw, name), 'utf8').trim() : '');
  const json = (name) => {
    try {
      return JSON.parse(read(name));
    } catch {
      return null;
    }
  };
  const lines = (name) => read(name).split('\n').filter((l) => l.length > 0);

  const info = json('docker-info.json') ?? {};
  const version = json('docker-version.json') ?? {};
  const settings = Object.fromEntries(
    lines('settings.env').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  const azure = await azureMetadata(json('azure-imds.json'));

  const environment = {
    recordedAt: read('recorded-at.txt'),
    mode: settings.EVAL_MODE,
    command: settings.EVAL_COMMAND,
    vm: azure,
    host: {
      cpus: info.NCPU ?? null,
      memoryBytes: info.MemTotal ?? null,
      memoryGiB: info.MemTotal ? Math.round((info.MemTotal / 2 ** 30) * 100) / 100 : null,
      operatingSystem: info.OperatingSystem ?? null,
      osType: info.OSType ?? null,
      architecture: info.Architecture ?? null,
      kernel: info.KernelVersion ?? null,
      uname: read('uname.txt'),
      osRelease: read('os-release.txt'),
    },
    docker: {
      serverVersion: version.Server?.Version ?? info.ServerVersion ?? null,
      clientVersion: version.Client?.Version ?? null,
      composeVersion: read('compose-version.txt'),
      storageDriver: info.Driver ?? null,
      cgroupVersion: info.CgroupVersion ?? null,
    },
    images: lines('images.jsonl').map((l) => JSON.parse(l)),
    containers: lines('containers.jsonl').map((l) => JSON.parse(l)),
    git: { commit: read('git-commit.txt'), uncommittedChanges: Number(read('git-dirty.txt') || 0) },
    rateLimitPerMinute: read('rate-limit.txt') || null,
    composeFile: settings.COMPOSE_FILE || 'docker-compose.yml',
    settings,
  };
  writeJson(join(dir, 'environment.json'), environment);
  rmSync(raw, { recursive: true, force: true });
  log(`environment.json: ${environment.vm.vmSize ?? 'not an Azure VM'}, ${environment.host.cpus} CPUs, ${environment.host.memoryGiB} GiB, rate limit ${environment.rateLimitPerMinute}`);
}

/** The VM size and identity from Azure IMDS, fetched on the host by run.sh or here as a fallback. */
async function azureMetadata(fromHost) {
  let doc = fromHost;
  let source = 'host';
  if (!doc) {
    source = 'evaluator container';
    try {
      const res = await fetch(IMDS_URL, { headers: { Metadata: 'true' }, signal: AbortSignal.timeout(3000) });
      doc = res.ok ? await res.json() : null;
    } catch {
      doc = null;
    }
  }
  const compute = doc?.compute;
  if (!compute) {
    return { vmSize: null, note: 'Azure instance metadata endpoint not reachable: not an Azure VM (for example a local smoke run)' };
  }
  return {
    source,
    vmSize: compute.vmSize,
    location: compute.location,
    offer: compute.offer,
    publisher: compute.publisher,
    sku: compute.sku,
    osType: compute.osType,
    zone: compute.zone,
    vmId: compute.vmId,
  };
}

main().catch((err) => {
  process.stderr.write(`environment: ${err.message}\n`);
  process.exit(1);
});
