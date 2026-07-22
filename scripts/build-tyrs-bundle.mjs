import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const [coreArgument, outputArgument] = process.argv.slice(2);
if (!coreArgument || !outputArgument)
  throw new Error('usage: npm run build-tyrs-bundle -- <playwright-core.tgz> <output-dir>');

const repositoryRoot = resolve(import.meta.dirname, '..');
const coreArtifact = resolve(coreArgument);
const outputRoot = resolve(outputArgument);
const temporary = await mkdtemp(join(tmpdir(), 'tyrs-browser-bridge-'));
const stageRoot = join(temporary, 'tyrs-browser-bridge');
const revision = run('git', ['rev-parse', 'HEAD'], repositoryRoot).trim();
const dirty = Boolean(run('git', ['status', '--porcelain'], repositoryRoot).trim());

try {
  await mkdir(stageRoot, { recursive: true });
  for (const entry of ['bridge', 'cli.js', 'index.js', 'index.d.ts', 'config.d.ts', 'LICENSE'])
    await cp(join(repositoryRoot, entry), join(stageRoot, entry), { recursive: true });
  const coreName = basename(coreArtifact);
  await cp(coreArtifact, join(stageRoot, coreName));
  const sourcePackage = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'));
  const runtimePackage = {
    name: sourcePackage.name,
    version: sourcePackage.version,
    private: true,
    type: 'commonjs',
    engines: sourcePackage.engines,
    scripts: { start: 'node bridge/src/server.mjs' },
    dependencies: { 'playwright-core': `file:./${coreName}` },
  };
  await writeFile(join(stageRoot, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`);
  run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stageRoot);

  await mkdir(outputRoot, { recursive: true });
  const bundlePath = join(outputRoot, 'tyrs-browser-bridge-bundle.tgz');
  run('tar', ['-czf', bundlePath, '-C', temporary, 'tyrs-browser-bridge'], repositoryRoot);
  await writeFile(join(outputRoot, 'bridge-artifact.json'), `${JSON.stringify({
    repository: 'https://github.com/slovx2/playwright-mcp',
    revision,
    dirty,
    bridgeVersion: sourcePackage.version,
    artifact: basename(bundlePath),
    sha256: createHash('sha256').update(await readFile(bundlePath)).digest('hex'),
  }, null, 2)}\n`);
  console.log(bundlePath);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}
