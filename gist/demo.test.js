import test from 'node:test';
import assert from 'node:assert/strict';
import { demonstrateLostResponse } from './demo.js';

test('a lost response is uncertain even though the provider applied the action', async () => {
  const result = await demonstrateLostResponse();
  assert.equal(result.stateAfterResponseLoss, 'uncertain');
  assert.equal(result.effects, 1);
});

test('another client cannot replay the uncertain action after the lease expires', async () => {
  const result = await demonstrateLostResponse();
  assert.equal(result.retryAllowed, false);
  assert.equal(result.stateAfterRetryAttempt, 'uncertain');
  assert.equal(result.providerCalls, 1);
  assert.equal(result.effects, 1);
});

test('affirmative provider evidence records success without sending again', async () => {
  const result = await demonstrateLostResponse();
  assert.equal(result.resolutionAccepted, true);
  assert.equal(result.finalState, 'succeeded');
  assert.equal(result.retryAllowedAfterResolution, false);
  assert.equal(result.providerCalls, 1);
  assert.equal(result.effects, 1);
});
