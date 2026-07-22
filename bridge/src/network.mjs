import { networkInterfaces } from 'node:os';

export function parseAllowedCIDRs(value) {
  return value.split(',').map(entry => entry.trim()).filter(Boolean).map(entry => {
    const [address, prefixText] = entry.split('/');
    const octets = address.split('.').map(Number);
    const prefix = Number(prefixText);
    if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255) ||
        !Number.isInteger(prefix) || prefix < 0 || prefix > 32)
      throw new Error(`invalid allowed IPv4 CIDR: ${entry}`);
    const raw = octets.reduce((result, octet) => (result << 8) | octet, 0) >>> 0;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return { network: raw & mask, mask };
  });
}

export function allowedClient(socket, allowedCIDRs, interfaces = networkInterfaces()) {
  if (isLoopback(socket.remoteAddress))
    return true;
  const localAddress = normalizeAddress(socket.localAddress);
  if (!discoverDockerHostAddresses(interfaces).has(localAddress))
    return false;
  const normalized = normalizeAddress(socket.remoteAddress);
  const octets = normalized?.split('.').map(Number);
  if (!octets || octets.length !== 4 || octets.some(octet => !Number.isInteger(octet)))
    return false;
  const raw = octets.reduce((result, octet) => (result << 8) | octet, 0) >>> 0;
  return allowedCIDRs.some(({ network, mask }) => (raw & mask) === network);
}

export function discoverDockerHostAddresses(interfaces = networkInterfaces()) {
  const addresses = new Set();
  for (const [name, entries] of Object.entries(interfaces)) {
    if (name !== 'docker0' && !name.startsWith('br-'))
      continue;
    for (const entry of entries || []) {
      if (entry.family === 'IPv4')
        addresses.add(entry.address);
    }
  }
  return addresses;
}

export function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function normalizeAddress(address) {
  return address?.startsWith('::ffff:') ? address.slice(7) : address;
}
