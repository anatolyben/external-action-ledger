import { pathToFileURL } from 'node:url';
import { createActionLedger, createMemoryStore } from '../src/index.js';

// These are deterministic in-process simulations. A client restart retains the
// same memory store; it does not demonstrate disk durability or database locking.
const LEASE_MS = 1000;
const worker = { workerId: 'worker-a', leaseMs: LEASE_MS };

class InjectedStorageFailure extends Error {
  constructor(phase) {
    super(`Simulated storage failure ${phase}`);
    this.name = 'InjectedStorageFailure';
  }
}

// Inject faults through the storage contract without reading or editing ledger
// records. before_commit aborts a computed mutation; after_commit loses only the
// acknowledgment, so the caller cannot know whether its write became durable.
function faultStore(base) {
  let fault = null;
  return {
    read: ref => base.read(ref),
    arm(phase, transaction = 1) {
      if (!['before_commit', 'after_commit'].includes(phase) ||
          !Number.isInteger(transaction) || transaction < 1) throw new TypeError('Invalid fault');
      if (fault) throw new Error('A fault is already armed');
      fault = { phase, remaining: transaction };
    },
    async transact(ref, mutator) {
      const active = fault && --fault.remaining === 0 ? fault : null;
      if (active) fault = null;
      if (active?.phase === 'before_commit') {
        return base.transact(ref, (record, now) => {
          mutator(record, now);
          throw new InjectedStorageFailure('before_commit');
        });
      }
      const result = await base.transact(ref, mutator);
      if (active?.phase === 'after_commit') throw new InjectedStorageFailure('after_commit');
      return result;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(name) {
  let now = 1_700_000_000_000;
  const store = faultStore(createMemoryStore({ clock: () => now }));
  const ledger = createActionLedger({ store });
  const ref = { namespace: 'simulator', key: name };
  await ledger.enqueue({ ...ref, kind: 'publish', payload: { text: 'hello' }, maxAttempts: 2 });
  // This deliberately non-idempotent provider counts actual writes. A duplicate
  // call would create another effect, rather than being hidden by deduplication.
  const provider = {
    calls: 0,
    effects: [],
    apply(context) {
      this.calls++;
      const receipt = { providerId: `post-${this.effects.length + 1}` };
      this.effects.push({ effectKey: context.effectKey, receipt });
      return { outcome: 'applied', receipt };
    },
  };
  return {
    name, ref, store, ledger, provider,
    advance: ms => { now += ms; },
    async report(observations = {}) {
      return {
        name, providerCalls: provider.calls, effects: provider.effects.length,
        finalState: (await ledger.get(ref)).state, ...observations,
      };
    },
    async restartAndTry() {
      const restarted = createActionLedger({ store });
      const claim = await restarted.claim(ref, { ...worker, workerId: 'worker-b' });
      // Actually try any allowed replay so the provider counters expose a bug.
      if (claim) await restarted.dispatch(claim, context => provider.apply(context));
      return Boolean(claim);
    },
  };
}

async function storageFailure(promise) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof InjectedStorageFailure) return 1;
    throw error;
  }
  throw new Error('The armed storage fault was not observed');
}

export async function lostResponseAfterApply() {
  const f = await fixture('response lost after apply');
  await f.ledger.dispatch(await f.ledger.claim(f.ref, worker), context => {
    f.provider.apply(context);
    throw new Error('Provider applied the request, then the connection closed');
  });
  f.advance(LEASE_MS);
  return f.report({ restartClaimAllowed: await f.restartAndTry() });
}

export async function timeoutWithoutEffect() {
  const f = await fixture('timeout without effect');
  await f.ledger.dispatch(await f.ledger.claim(f.ref, worker), () => {
    f.provider.calls++;
    // The simulator knows there was no effect. The worker only sees a timeout,
    // which is not proof of non-application or proof that a late effect is impossible.
    throw new Error('Request timed out');
  });
  f.advance(LEASE_MS);
  return f.report({ restartClaimAllowed: await f.restartAndTry() });
}

export async function intentWriteFailure() {
  const f = await fixture('intent write failed');
  const claim = await f.ledger.claim(f.ref, worker);
  f.store.arm('before_commit');
  const storageErrors = await storageFailure(f.ledger.dispatch(claim, context => f.provider.apply(context)));
  const callsBeforeRecovery = f.provider.calls;
  const stateAfterFault = (await f.ledger.get(f.ref)).state;
  f.advance(LEASE_MS);
  return f.report({ storageErrors, callsBeforeRecovery, stateAfterFault, restartClaimAllowed: await f.restartAndTry() });
}

export async function intentAcknowledgmentLost() {
  const f = await fixture('intent acknowledgment lost');
  const claim = await f.ledger.claim(f.ref, worker);
  f.store.arm('after_commit');
  const storageErrors = await storageFailure(f.ledger.dispatch(claim, context => f.provider.apply(context)));
  const stateAfterFault = (await f.ledger.get(f.ref)).state;
  f.advance(LEASE_MS);
  return f.report({ storageErrors, stateAfterFault, restartClaimAllowed: await f.restartAndTry() });
}

export async function settlementWriteFailure() {
  const f = await fixture('settlement write failed');
  const claim = await f.ledger.claim(f.ref, worker);
  // The first transaction records dispatch intent; the second records its result.
  f.store.arm('before_commit', 2);
  const storageErrors = await storageFailure(f.ledger.dispatch(claim, context => f.provider.apply(context)));
  const stateAfterFault = (await f.ledger.get(f.ref)).state;
  f.advance(LEASE_MS);
  return f.report({ storageErrors, stateAfterFault, restartClaimAllowed: await f.restartAndTry() });
}

export async function settlementAcknowledgmentLost() {
  const f = await fixture('settlement acknowledgment lost');
  const claim = await f.ledger.claim(f.ref, worker);
  f.store.arm('after_commit', 2);
  const storageErrors = await storageFailure(f.ledger.dispatch(claim, context => f.provider.apply(context)));
  f.advance(LEASE_MS);
  return f.report({ storageErrors, restartClaimAllowed: await f.restartAndTry() });
}

export async function expiredClaimReclaimed() {
  const f = await fixture('expired claim reclaimed');
  const oldClaim = await f.ledger.claim(f.ref, worker);
  f.advance(LEASE_MS);
  const freshClaim = await f.ledger.claim(f.ref, { ...worker, workerId: 'worker-b' });
  const stale = await f.ledger.dispatch(oldClaim, context => f.provider.apply(context));
  if (freshClaim) await f.ledger.dispatch(freshClaim, context => f.provider.apply(context));
  return f.report({ staleDispatchAccepted: stale.accepted, replacementClaimAllowed: Boolean(freshClaim) });
}

export async function lateEffectAfterLeaseExpiry() {
  const f = await fixture('late effect after lease expiry');
  const entered = deferred();
  const release = deferred();
  const pending = f.ledger.dispatch(await f.ledger.claim(f.ref, worker), async context => {
    // Dispatch intent is committed, but the process pauses before sending. A
    // database lease cannot prevent the old process from eventually doing this.
    entered.resolve();
    await release.promise;
    return f.provider.apply(context);
  });
  await entered.promise;
  let observations;
  try {
    f.advance(LEASE_MS);
    const restartClaimAllowed = await f.restartAndTry();
    observations = {
      restartClaimAllowed,
      stateAtExpiry: (await f.ledger.get(f.ref)).state,
      callsAtExpiry: f.provider.calls,
      effectsAtExpiry: f.provider.effects.length,
    };
  } finally {
    release.resolve();
  }
  const completion = await pending;
  return f.report({ ...observations, staleCompletionAccepted: completion.accepted });
}

export async function definiteRejectionThenSuccess() {
  const f = await fixture('definite rejection then success');
  await f.ledger.dispatch(await f.ledger.claim(f.ref, worker), () => {
    f.provider.calls++;
    // Only a provider contract ruling out any current or future effect can
    // justify this outcome. An HTTP error status alone is not sufficient proof.
    return { outcome: 'not_applied', reason: 'Rejected before accepting work; no job queued', retryable: true, retryAfterMs: 50 };
  });
  const early = await f.ledger.claim(f.ref, worker);
  if (early) await f.ledger.dispatch(early, context => f.provider.apply(context));
  f.advance(50);
  const later = await f.ledger.claim(f.ref, worker);
  if (later) await f.ledger.dispatch(later, context => f.provider.apply(context));
  return f.report({ claimBeforeDelayAllowed: Boolean(early), claimAfterDelayAllowed: Boolean(later) });
}

export async function confirmedSuccessReconciliation() {
  const f = await fixture('confirmed success reconciliation');
  await f.ledger.dispatch(await f.ledger.claim(f.ref, worker), context => {
    f.provider.apply(context);
    throw new Error('Response lost');
  });
  const action = await f.ledger.get(f.ref);
  // A separate provider lookup confirms the effect exists. Absence from a
  // lookup would not justify retrying: the first request could still arrive.
  const observed = f.provider.effects.find(effect => effect.effectKey === action.id);
  if (!observed) throw new Error('Provider evidence missing');
  const result = await f.ledger.resolve(f.ref, {
    expectedRevision: action.revision,
    actor: 'simulator:reconciler',
    evidence: { source: 'simulated-provider-lookup', effectKey: observed.effectKey, providerId: observed.receipt.providerId },
    receipt: observed.receipt,
  });
  return f.report({
    stateBeforeResolution: action.state,
    resolutionAccepted: result.accepted,
    restartClaimAllowed: await f.restartAndTry(),
  });
}

export const scenarios = [
  lostResponseAfterApply, timeoutWithoutEffect, intentWriteFailure,
  intentAcknowledgmentLost, settlementWriteFailure, settlementAcknowledgmentLost,
  expiredClaimReclaimed, lateEffectAfterLeaseExpiry,
  definiteRejectionThenSuccess, confirmedSuccessReconciliation,
];

export async function runScenarios() {
  const results = [];
  for (const scenario of scenarios) results.push(await scenario());
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await runScenarios();
  console.log('Deterministic in-memory failure simulations');
  console.table(results.map(({ name, providerCalls, effects, finalState }) => ({
    scenario: name, providerCalls, effects, finalState,
  })));
  console.log('A client restart reuses the same in-memory store. This does not prove PostgreSQL locking or crash durability.');
  console.log('In the late-effect scenario the lease expires with zero effects, then the paused worker applies one. The action remains uncertain; no replacement worker sends.');
  console.log('Run node --test test/simulations.test.js to assert the expected outcomes.');
}
