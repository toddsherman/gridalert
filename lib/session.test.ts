import assert from 'node:assert/strict';
import { it } from 'node:test';
import { makeSession, validSession } from './session.ts';

const NOW = Date.UTC(2026, 10, 2);
const LATER = NOW + 1_000;

it('accepts a session it issued until it expires', () => {
  const session = makeSession('token', LATER);
  assert.equal(validSession(session, 'token', NOW), true);
  assert.equal(validSession(session, 'token', LATER), false);
});

it('rejects a forged expiry, or a session from a token that has changed', () => {
  const [, mac] = makeSession('token', LATER).split('.');
  assert.equal(validSession(`${LATER + 1_000_000}.${mac}`, 'token', NOW), false);
  assert.equal(validSession(makeSession('old token', LATER), 'token', NOW), false);
});

it('rejects anything else without throwing', () => {
  for (const bad of [undefined, '', 'x', '.', '1.', '.x', 'not-hex-at-all', 'a.b.c', 'a'.repeat(500)]) {
    assert.equal(validSession(bad, 'token', NOW), false);
  }
});
