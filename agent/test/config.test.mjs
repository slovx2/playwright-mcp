import assert from 'node:assert/strict';
import test from 'node:test';

import { validateConfig } from '../lib/config.mjs';

const identity = {
  host: 'tyrs-ubuntu',
  port: 2222,
  user: 'developer',
  identityFile: '/Users/test/.ssh/id_ed25519',
  knownHostsFile: '/Users/test/.ssh/known_hosts',
};

function base(extra = {}) {
  return {
    extensionId: 'a'.repeat(32),
    extensionToken: 'a'.repeat(64),
    extensionCrxPath: '/Applications/Tyrs Browser.crx',
    instanceId: '00000000-0000-4000-8000-000000000000',
    ...extra,
  };
}

test('validates multiple independent worker SSH configurations', () => {
  const config = validateConfig(base({ workers: [
    { id: 'song-ubuntu', ssh: identity },
    { id: 'song-debain', ssh: { ...identity, host: 'tyrs-debain' } },
  ] }));
  assert.deepEqual(config.workers.map(worker => worker.id), ['song-ubuntu', 'song-debain']);
  assert.equal(config.workers[0].ssh.port, 2222);
});

test('migrates the old single ssh field to the default worker', () => {
  const config = validateConfig(base({ ssh: identity }));
  assert.deepEqual(config.workers, [{ id: 'default', ssh: identity }]);
});

test('rejects duplicate worker IDs and an empty worker list', () => {
  assert.throws(() => validateConfig(base({ workers: [
    { id: 'same', ssh: identity }, { id: 'same', ssh: identity },
  ] })), /duplicated/);
  assert.throws(() => validateConfig(base({ workers: [] })), /at least one worker/);
});

test('rejects incomplete or unsafe SSH worker settings', () => {
  assert.throws(() => validateConfig(base({ workers: [{ id: 'worker', ssh: {
    ...identity, host: '100.127.0.1;bad',
  } }] })), /SSH target/);
  assert.throws(() => validateConfig(base({ workers: [{ id: 'worker', ssh: {
    ...identity, identityFile: 'relative-key',
  } }] })), /SSH target/);
});
