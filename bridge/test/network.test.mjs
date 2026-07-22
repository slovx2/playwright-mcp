import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedClient, discoverDockerHostAddresses, parseAllowedCIDRs } from '../src/network.mjs';

const interfaces = {
  lo: [{ family: 'IPv4', address: '127.0.0.1' }],
  docker0: [{ family: 'IPv4', address: '172.17.0.1' }],
  'br-managed': [{ family: 'IPv4', address: '172.20.0.1' }],
  tailscale0: [{ family: 'IPv4', address: '100.64.0.1' }],
  eth0: [{ family: 'IPv4', address: '192.168.1.10' }],
};

test('network access accepts loopback and allowed Docker bridge clients', () => {
  const cidrs = parseAllowedCIDRs('127.0.0.0/8,172.16.0.0/12');
  assert.equal(allowedClient({ remoteAddress: '::ffff:127.0.0.1', localAddress: '127.0.0.1' },
      cidrs, interfaces), true);
  assert.equal(allowedClient({ remoteAddress: '172.20.0.8', localAddress: '172.20.0.1' },
      cidrs, interfaces), true);
  assert.deepEqual([...discoverDockerHostAddresses(interfaces)].sort(), ['172.17.0.1', '172.20.0.1']);
});

test('network access rejects LAN destinations and clients outside configured CIDRs', () => {
  const cidrs = parseAllowedCIDRs('172.20.0.0/24');
  assert.equal(allowedClient({ remoteAddress: '172.20.0.8', localAddress: '192.168.1.10' },
      cidrs, interfaces), false);
  assert.equal(allowedClient({ remoteAddress: '172.21.0.8', localAddress: '172.20.0.1' },
      cidrs, interfaces), false);
  assert.equal(allowedClient({ remoteAddress: '::1:bad', localAddress: '172.20.0.1' },
      cidrs, interfaces), false);
});

test('invalid CIDR configuration fails closed at startup', () => {
  for (const value of ['172.16.0.0', '172.16.0.0/33', '172.16.0.999/24', 'not-an-ip/24'])
    assert.throws(() => parseAllowedCIDRs(value), /invalid allowed IPv4 CIDR/);
});
