import { createHmac, timingSafeEqual } from 'node:crypto';

const environmentPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function deriveScopedToken(secret, scope) {
  const normalized = normalizeScope(scope);
  const signature = createHmac('sha256', secret).update(`v1\n${normalized}`).digest('base64url');
  return `v1.${normalized}.${signature}`;
}

export function verifyScopedAuthorization(header, secret) {
  const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  const match = token.match(/^v1\.(worker|[0-9a-f-]+)\.([A-Za-z0-9_-]+)$/);
  if (!match)
    return undefined;
  let scope;
  try {
    scope = normalizeScope(match[1]);
  } catch {
    return undefined;
  }
  const expected = Buffer.from(deriveScopedToken(secret, scope).split('.')[2]);
  const actual = Buffer.from(match[2]);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? scope : undefined;
}

function normalizeScope(scope) {
  const normalized = String(scope).toLowerCase();
  if (normalized !== 'worker' && !environmentPattern.test(normalized))
    throw new Error('invalid browser scope');
  return normalized;
}
