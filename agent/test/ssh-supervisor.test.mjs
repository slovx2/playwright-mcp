import assert from 'node:assert/strict';
import test from 'node:test';

import { sshArguments } from '../lib/ssh-supervisor.mjs';
import { serviceForwardArguments } from '../lib/service-tunnels.mjs';

test('SSH uses an independent stdio session with strict host identity and no forwarding', () => {
  const args = sshArguments({ ssh: {
    host: 'worker.example.test', port: 2222, user: 'dev', identityFile: '/keys/id_ed25519',
    knownHostsFile: '/keys/known_hosts',
  } });
  assert.deepEqual(args.slice(-4), ['worker.example.test', 'tyrs-hand-worker', 'browser', 'proxy']);
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('IdentitiesOnly=yes'));
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('ClearAllForwardings=yes'));
  assert.ok(args.includes('ServerAliveInterval=15'));
  assert.equal(args.includes('-R'), false);
  assert.equal(args.includes('-L'), false);
  assert.equal(args.includes('-D'), false);
});

test('service forwarding binds loopback and targets only development loopback', () => {
  const config = { ssh: {
    host: 'worker.example.test', port: 2222, user: 'dev', identityFile: '/keys/id_ed25519',
    knownHostsFile: '/keys/known_hosts',
  } };
  const args = serviceForwardArguments(config, 49152, 8000);
  assert.deepEqual(args.slice(0, 4), ['-N', '-T', '-F', '/dev/null']);
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.ok(args.includes('GatewayPorts=no'));
  assert.equal(args.includes('ClearAllForwardings=yes'), false);
  assert.deepEqual(args.slice(-3), [
    '-L', '127.0.0.1:49152:127.0.0.1:8000', 'worker.example.test',
  ]);
  assert.equal(args.includes('-R'), false);
  assert.equal(args.includes('-D'), false);
});
