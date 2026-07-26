import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveScopedToken, verifyScopedAuthorization } from '../src/auth.mjs';

test('scoped browser tokens are deterministic and environment isolated', () => {
  assert.equal(deriveScopedToken('secret', 'worker'),
      'v1.worker.w3lxRQZQWESSFoA1cGQcumHLOF6yHToqOgUeybUSSiw');
  const environment = '11111111-1111-4111-8111-111111111111';
  const token = deriveScopedToken('secret', environment);
  assert.equal(verifyScopedAuthorization(`Bearer ${token}`, 'secret'), environment);
  assert.equal(verifyScopedAuthorization(`Bearer ${token}`, 'other-secret'), undefined);
  assert.equal(verifyScopedAuthorization('Bearer secret', 'secret'), undefined);
});
