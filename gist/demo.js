import { pathToFileURL } from 'node:url';
import { createActionLedger, createMemoryStore } from 'external-action-ledger';

export async function demonstrateLostResponse() {
  // Deterministic in-memory simulation. Recreating the client below is NOT a
  // process restart or a test of PostgreSQL persistence.
  let now = 1_700_000_000_000;
  const store = createMemoryStore({ clock: () => now });
  const actions = createActionLedger({ store });
  const ref = { namespace: 'demo', key: 'publish:123' };
  const worker = { workerId: 'worker-a', leaseMs: 1_000 };
  await actions.enqueue({ ...ref, kind: 'publish', payload: { text: 'Hello' } });

  // The simulated provider deliberately DOES NOT deduplicate requests. A
  // repeated call creates another effect, making an unsafe replay observable.
  let providerCalls = 0;
  const effects = [];
  const publish = context => {
    providerCalls++;
    const receipt = { providerId: 'post-' + (effects.length + 1) };
    effects.push({ effectKey: context.effectKey, receipt });
    return { outcome: 'applied', receipt };
  };

  const firstClaim = await actions.claim(ref, worker);
  if (!firstClaim) throw new Error('Initial claim was unexpectedly rejected');
  await actions.dispatch(firstClaim, context => {
    publish(context);
    throw new Error('The provider applied the request, but its response was lost');
  });
  const stateAfterResponseLoss = (await actions.get(ref)).state;

  // Waiting out the lease does not establish whether the provider applied it.
  now += 1_000;
  const anotherClient = createActionLedger({ store });
  const retry = await anotherClient.claim(ref, { ...worker, workerId: 'worker-b' });
  // Actually execute an allowed replay, so a bug changes the provider counters.
  if (retry) await anotherClient.dispatch(retry, publish);
  const stateAfterRetryAttempt = (await anotherClient.get(ref)).state;

  // A separate lookup confirms the effect exists. A missing lookup result
  // would NOT justify retrying: an earlier request could still take effect.
  const current = await anotherClient.get(ref);
  const observed = effects.find(effect => effect.effectKey === current.id);
  if (!observed) throw new Error('No affirmative provider evidence to reconcile');
  const resolution = await anotherClient.resolve(ref, {
    expectedRevision: current.revision,
    actor: 'demo:reconciler',
    evidence: {
      source: 'simulated-provider-lookup',
      effectKey: observed.effectKey,
      providerId: observed.receipt.providerId,
    },
    receipt: observed.receipt,
  });
  const afterResolution = await anotherClient.claim(ref, worker);
  if (afterResolution) await anotherClient.dispatch(afterResolution, publish);

  return {
    stateAfterResponseLoss,
    stateAfterRetryAttempt,
    retryAllowed: Boolean(retry),
    resolutionAccepted: resolution.accepted,
    retryAllowedAfterResolution: Boolean(afterResolution),
    finalState: (await anotherClient.get(ref)).state,
    providerCalls,
    effects: effects.length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.table(await demonstrateLostResponse());
  console.log('One effect; uncertain after response loss; no replay; success after evidence.');
  console.log('This simulation does not prove database durability or exactly-once execution.');
}
