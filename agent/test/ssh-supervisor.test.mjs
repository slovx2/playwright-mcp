import assert from 'node:assert/strict';
import test from 'node:test';

import { sshArguments } from '../lib/ssh-supervisor.mjs';

test('SSH uses an independent stdio session with strict host identity and no forwarding', () => {
  const args = sshArguments({ ssh: {
    host: 'worker.example.test', port: 2222, user: 'dev', identityFile: '/keys/id_ed25519',
    knownHostsFile: '/keys/known_hosts',
  } });
  assert.deepEqual(args.slice(-4), ['worker.example.test', 'tyrs-hand-dev', 'browser', 'proxy']);
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('IdentitiesOnly=yes'));
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('ClearAllForwardings=yes'));
  assert.ok(args.includes('ServerAliveInterval=15'));
  assert.equal(args.includes('-R'), false);
  assert.equal(args.includes('-L'), false);
  assert.equal(args.includes('-D'), false);
});
