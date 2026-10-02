import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResult, shouldNotify } from './run-scheduled.mjs';

test('scheduled results exclude unknown output and notify only on changes or completed updates', () => {
  // Given: a valid checker result with an extra field that must not enter logs.
  const input = { status: 'SAME', health_http: 200, cookie_submission_attempted: false,
    model_requests: 0, notify: false, arbitrary: 'synthetic-private-value' };
  // When: parse checker output and decide whether the scheduler should notify.
  const result = parseResult('check started\n' + JSON.stringify(input) + '\n');
  // Then: log only known fields and suppress repeated or healthy notifications.
  assert.equal(result.status, 'SAME');
  assert.equal(Object.hasOwn(result, 'arbitrary'), false);
  assert.equal(shouldNotify(result, 'HEALTH_FAILED'), false);
  assert.equal(parseResult('unexpected output').status, 'CHECK_RUN_FAILED');
  assert.equal(parseResult(JSON.stringify({ ...input, status: 'UNKNOWN' })).status, 'CHECK_RUN_FAILED');
  assert.equal(shouldNotify({ status: 'HEALTH_FAILED', notify: true }, 'HEALTH_FAILED'), false);
  assert.equal(shouldNotify({ status: 'HEALTH_FAILED', notify: true }, 'SAME'), true);
  assert.equal(shouldNotify({ status: 'UPDATED', notify: true }, 'UPDATED'), true);
  assert.equal(shouldNotify({ status: 'ALREADY_RUNNING', notify: true }, 'SAME'), false);
  assert.equal(shouldNotify({ status: 'DEFERRED_BUSY', notify: true }, 'SAME'), false);
  assert.equal(parseResult(JSON.stringify({ ...input, status: 'DEFERRED_BUSY' })).status, 'DEFERRED_BUSY');
});
