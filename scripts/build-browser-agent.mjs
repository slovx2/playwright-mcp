import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const [coreArgument, extensionArgument, playwrightManifestArgument, outputArgument] = process.argv.slice(2);
if (!coreArgument || !extensionArgument || !playwrightManifestArgument || !outputArgument)
  throw new Error('usage: npm run build-browser-agent -- <playwright-core.tgz> <extension.crx> <playwright-artifacts.json> <output-dir>');

const root = resolve(import.meta.dirname, '..');
const core = resolve(coreArgument);
const extension = resolve(extensionArgument);
const playwrightManifest = JSON.parse(await readFile(resolve(playwrightManifestArgument), 'utf8'));
const output = resolve(outputArgument);
const temporary = await mkdtemp(join(tmpdir(), 'tyrs-browser-agent-'));
const lock = JSON.parse(await readFile(join(root, 'agent/runtime-lock.json'), 'utf8'));
const agentPackage = JSON.parse(await readFile(join(root, 'agent/package.json'), 'utf8'));
const bridgePackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const revision = run('git', ['rev-parse', 'HEAD'], root).trim();
const dirty = Boolean(run('git', [
  'status', '--porcelain', '--', '.', ':(exclude)out', ':(exclude)agent/lib',
], root).trim());
if (!/^\d+(\.\d+){0,3}$/.test(playwrightManifest.extensionVersion))
  throw new Error('invalid extension version in Playwright artifact manifest');

try {
  run('npm', ['run', 'agent:build'], root);
  const app = join(temporary, 'app');
  await mkdir(app, { recursive: true });
  await cp(join(root, 'agent/lib'), join(app, 'src'), { recursive: true });
  await cp(extension, join(app, 'tyrs-browser-extension.crx'));
  await cp(core, join(app, basename(core)));
  await writeFile(join(app, 'browser-agent-release.json'), `${JSON.stringify({
    agentVersion: agentPackage.version,
    extensionVersion: playwrightManifest.extensionVersion,
    bridgeVersion: bridgePackage.version,
  }, null, 2)}\n`);
  await writeFile(join(app, 'package.json'), `${JSON.stringify({
    ...agentPackage,
    dependencies: { ...agentPackage.dependencies, 'playwright-core': `file:./${basename(core)}` },
  }, null, 2)}\n`);
  run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], app);
  await rm(join(app, basename(core)));
  await mkdir(output, { recursive: true });
  const artifacts = {};
  for (const architecture of ['darwin-arm64', 'darwin-x64']) {
    const runtime = lock[architecture];
    const archive = join(temporary, basename(new URL(runtime.url).pathname));
    const response = await fetch(runtime.url);
    if (!response.ok)
      throw new Error(`Node runtime download failed: ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(data).digest('hex') !== runtime.sha256)
      throw new Error(`Node runtime checksum mismatch: ${architecture}`);
    await writeFile(archive, data);
    const stage = join(temporary, `tyrs-browser-agent-${architecture}`);
    await mkdir(stage);
    await cp(app, join(stage, 'app'), { recursive: true });
    run('tar', ['-xzf', archive, '-C', stage], root);
    const extracted = join(stage, `node-v${lock.nodeVersion}-${architecture}`);
    await cp(join(extracted, 'bin/node'), join(stage, 'node'));
    await rm(extracted, { recursive: true, force: true });
    const artifact = `tyrs-browser-agent-${architecture}.tgz`;
    run('tar', ['-czf', join(output, artifact), '-C', temporary, basename(stage)], root);
    artifacts[architecture] = { artifact, sha256: createHash('sha256').update(await readFile(join(output, artifact))).digest('hex') };
  }
  await writeFile(join(output, 'browser-agent-artifact.json'), `${JSON.stringify({
    repository: 'https://github.com/slovx2/playwright-mcp', revision, dirty,
    agentVersion: agentPackage.version, extensionVersion: playwrightManifest.extensionVersion,
    nodeVersion: lock.nodeVersion, artifacts,
  }, null, 2)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}
