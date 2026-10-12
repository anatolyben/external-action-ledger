import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lostResponseAfterApply,
  timeoutWithoutEffect,
  intentWriteFailure,
  intentAcknowledgmentLost,
  settlementWriteFailure,
  settlementAcknowledgmentLost,
  expiredClaimReclaimed,
  lateEffectAfterLeaseExpiry,
  definiteRejectionThenSuccess,
  confirmedSuccessReconciliation,
} from '../examples/failure-simulator.js';

function observed(result, calls, effects, state) {
  assert.equal(result.providerCalls, calls, 'logical provider requests');
  assert.equal(result.effects, effects, 'externally applied effects');
  assert.equal(result.finalState, state);
}

test('a lost response after application never causes a replay after restart', async () => {
  const result = await lostResponseAfterApply();
  observed(result, 1, 1, 'uncertain');
  assert.equal(result.restartClaimAllowed, false);
});

test('a timeout with no effect is still uncertain and is not retried', async () => {
  const result = await timeoutWithoutEffect();
  observed(result, 1, 0, 'uncertain');
  assert.equal(result.restartClaimAllowed, false);
});

test('a dispatch-intent write failure calls no provider and permits later safe recovery', async () => {
  const result = await intentWriteFailure();
  observed(result, 1, 1, 'succeeded');
  assert.equal(result.callsBeforeRecovery, 0);
  assert.equal(result.stateAfterFault, 'claimed');
  assert.equal(result.storageErrors, 1);
  assert.equal(result.restartClaimAllowed, true);
});

test('a dispatch-intent commit with lost acknowledgment calls no provider and becomes uncertain', async () => {
  const result = await intentAcknowledgmentLost();
  observed(result, 0, 0, 'uncertain');
  assert.equal(result.stateAfterFault, 'executing');
  assert.equal(result.storageErrors, 1);
  assert.equal(result.restartClaimAllowed, false);
});

test('a failed settlement write cannot replay an already applied effect', async () => {
  const result = await settlementWriteFailure();
  observed(result, 1, 1, 'uncertain');
  assert.equal(result.stateAfterFault, 'executing');
  assert.equal(result.storageErrors, 1);
  assert.equal(result.restartClaimAllowed, false);
});

test('lost acknowledgment of a successful settlement preserves durable success', async () => {
  const result = await settlementAcknowledgmentLost();
  observed(result, 1, 1, 'succeeded');
  assert.equal(result.storageErrors, 1);
  assert.equal(result.restartClaimAllowed, false);
});

test('an expired claim is replaced safely before any dispatch intent', async () => {
  const result = await expiredClaimReclaimed();
  observed(result, 1, 1, 'succeeded');
  assert.equal(result.staleDispatchAccepted, false);
  assert.equal(result.replacementClaimAllowed, true);
});

test('lease expiry stops replay but cannot prevent a paused worker from causing a late effect', async () => {
  const result = await lateEffectAfterLeaseExpiry();
  observed(result, 1, 1, 'uncertain');
  assert.equal(result.callsAtExpiry, 0);
  assert.equal(result.effectsAtExpiry, 0);
  assert.equal(result.stateAtExpiry, 'uncertain');
  assert.equal(result.restartClaimAllowed, false);
  assert.equal(result.staleCompletionAccepted, false);
});

test('an explicit definitive rejection permits a delayed retry that applies once', async () => {
  const result = await definiteRejectionThenSuccess();
  observed(result, 2, 1, 'succeeded');
  assert.equal(result.claimBeforeDelayAllowed, false);
  assert.equal(result.claimAfterDelayAllowed, true);
});

test('independent provider evidence resolves uncertainty without sending again', async () => {
  const result = await confirmedSuccessReconciliation();
  observed(result, 1, 1, 'succeeded');
  assert.equal(result.stateBeforeResolution, 'uncertain');
  assert.equal(result.resolutionAccepted, true);
  assert.equal(result.restartClaimAllowed, false);
});
