import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const destination = new URL('gist/', root);
const version = '0.1.0';
const demo = String.raw`import { pathToFileURL } from 'node:url';
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
`;
const tests = String.raw`import test from 'node:test';
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
`;

// This directory is entirely generated. Remove the old snapshot first so that
// copied implementations cannot accidentally survive in the launch gist.
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await writeFile(new URL('demo.js', destination), demo);
await writeFile(new URL('demo.test.js', destination), tests);
await writeFile(new URL('package.json', destination), JSON.stringify({
  name: 'external-action-ledger-demo', version, private: true,
  type: 'module', engines: { node: '>=22' },
  scripts: { start: 'node demo.js', test: 'node --test demo.test.js' },
  dependencies: { 'external-action-ledger': `https://github.com/anatolyben/external-action-ledger/releases/download/v${version}/external-action-ledger-${version}.tgz` },
  license: 'MIT',
}, null, 2) + '\n');
await copyFile(new URL('LICENSE', root), new URL('LICENSE', destination));
await writeFile(new URL('README.md', destination), await readFile(new URL('GIST_README.md', root)));
console.log('Prepared package-consuming gist/ for external-action-ledger@' + version + '. Nothing published.');

