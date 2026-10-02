import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, fingerprint, selectCookies } from './check.mjs';

test('compare both credentials and restart storage; never repeat an unresolved write', () => {
  // Given: synthetic local credentials and matching cloud fingerprints.
  const local = fingerprint(['synthetic-session', 'synthetic-timestamp']);
  const cloud = { cookie_fingerprint: local, persisted_cookie_fingerprint: local, active_requests: 0 };
  // When/Then: equality skips writes, either differing credential needs one update.
  assert.equal(decide(local, cloud, false), 'SAME');
  assert.equal(decide(local, cloud, true), 'SAME');
  for (const pair of [['other-session', 'synthetic-timestamp'], ['synthetic-session', 'other-timestamp']]) {
    assert.equal(decide(fingerprint(pair), cloud, false), 'DIFFERENT');
    assert.equal(decide(fingerprint(pair), cloud, true), 'PREVIOUS_UPDATE_UNRESOLVED');
  }
  assert.equal(decide(local, { ...cloud, persisted_cookie_fingerprint: fingerprint(['old', 'old']) }, false), 'DIFFERENT');
  assert.equal(decide(local, {}, false), 'CLOUD_FINGERPRINT_UNAVAILABLE');
  assert.throws(() => fingerprint(['', 'synthetic-timestamp']));
});

test('mismatched credentials wait for an idle account without bypassing unresolved submissions', () => {
  // Given: differing credentials while the account is serving a request.
  const local = fingerprint(['synthetic-new', 'synthetic-ts']);
  const old = fingerprint(['synthetic-old', 'synthetic-ts']);
  const cloud = { cookie_fingerprint: old, persisted_cookie_fingerprint: old, active_requests: 1 };
  // When/Then: busy accounts defer; unavailable counts fail closed; idle accounts may update.
  assert.equal(decide(local, cloud, false), 'DEFERRED_BUSY');
  assert.equal(decide(local, cloud, true), 'PREVIOUS_UPDATE_UNRESOLVED');
  assert.equal(decide(local, { ...cloud, active_requests: undefined }, false), 'CLOUD_STATUS_UNAVAILABLE');
  assert.equal(decide(local, { ...cloud, active_requests: 0 }, false), 'DIFFERENT');
  assert.equal(decide(local, { ...cloud, active_requests: 0, status: 'refreshing' }, false), 'DEFERRED_BUSY');
});

test('only one unexpired secure Google value for each allowed cookie is accepted', () => {
  // Given: two synthetic Google cookies, plus an unrelated cookie.
  const rows = ['__Secure-1PSID', '__Secure-1PSIDTS'].map((name, i) =>
    ({ name, value: `synthetic-${i}`, domain: '.google.com', secure: true, expires: 200 }));
  // When/Then: unrelated values are excluded and incomplete/ambiguous sources stop.
  assert.deepEqual(selectCookies([...rows, { name: 'unrelated', value: 'ignored' }], 100), ['synthetic-0', 'synthetic-1']);
  assert.throws(() => selectCookies(rows, 300));
  assert.throws(() => selectCookies(rows.slice(1), 100));
  assert.throws(() => selectCookies([...rows, { ...rows[0], value: 'conflicting' }], 100));
});
