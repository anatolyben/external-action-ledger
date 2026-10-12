import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionLedger, createMemoryStore, ConflictError } from '../src/index.js';

function fixture() {
  let now = 1000;
  const store = createMemoryStore({ clock: () => now });
  const ledger = createActionLedger({ store });
  return { ledger, store, advance: ms => { now += ms; } };
}
const ref = { namespace: 'tenant:1', key: 'publish:1' };
const input = { ...ref, kind: 'publish', payload: { text: 'hello' }, maxAttempts: 2 };
const worker = { workerId: 'worker-1', leaseMs: 100 };
const applied = { outcome: 'applied', receipt: { providerId: 'post-1' } };

test('enqueue is immutable, canonical, scoped and conflict detecting', async () => {
  const { ledger } = fixture();
  const payload = { b: 2, a: { value: 1 } };
  const action = await ledger.enqueue({ ...input, payload });
  payload.a.value = 9;
  action.payload.a.value = 8;
  const duplicate = await ledger.enqueue({ ...input, payload: { a: { value: 1 }, b: 2 } });
  assert.equal(duplicate.id, action.id);
  assert.equal(duplicate.payload.a.value, 1);
  await assert.rejects(ledger.enqueue({ ...input, payload }), ConflictError);
  await assert.rejects(ledger.enqueue({ ...input, payload: duplicate.payload, maxAttempts: 3 }), ConflictError);
  const scoped = await ledger.enqueue({ ...input, namespace: 'tenant:2' });
  assert.notEqual(scoped.id, action.id);
  assert.equal(await ledger.get({ ...ref, key: 'missing' }), null);
});

test('unsupported JSON and unsafe timing values fail before creating records', async () => {
  const { ledger } = fixture();
  const cycle = {}; cycle.self = cycle;
  for (const payload of [undefined, { x: undefined }, NaN, 1n, new Date(), cycle, [, 1]]) {
    await assert.rejects(ledger.enqueue({ ...input, payload }));
  }
  await ledger.enqueue(input);
  for (const leaseMs of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(ledger.claim(ref, { ...worker, leaseMs }));
  }
  assert.equal((await ledger.get(ref)).state, 'ready');
});

test('concurrent claims and dispatches have one winner', async () => {
  const { ledger } = fixture();
  await ledger.enqueue(input);
  const claims = await Promise.all(Array.from({ length: 20 }, (_, i) => ledger.claim(ref, { ...worker, workerId: `w-${i}` })));
  const winners = claims.filter(Boolean);
  assert.equal(winners.length, 1);
  let calls = 0;
  const results = await Promise.all(Array.from({ length: 10 }, () => ledger.dispatch(winners[0], async ctx => {
    calls++;
    assert.equal(ctx.effectKey, (await ledger.get(ref)).id);
    return applied;
  })));
  assert.equal(calls, 1);
  assert.equal(results.filter(x => x.accepted).length, 1);
  const action = await ledger.get(ref);
  assert.equal(action.state, 'succeeded');
  assert.equal(action.attempts.length, 1);
  assert.deepEqual(action.attempts[0].receipt, applied.receipt);
});

test('expired pre-dispatch claim is reclaimable but the old worker cannot send', async () => {
  const { ledger, advance } = fixture();
  await ledger.enqueue(input);
  const old = await ledger.claim(ref, worker);
  advance(100);
  const fresh = await ledger.claim(ref, { ...worker, workerId: 'worker-2' });
  assert.ok(fresh);
  assert.notEqual(old.token, fresh.token);
  const stale = await ledger.dispatch(old, () => assert.fail('stale worker must not send'));
  assert.equal(stale.accepted, false);
  await ledger.dispatch(fresh, async () => applied);
  assert.equal((await ledger.get(ref)).attempts.length, 1);
});

test('definite no-effect rejection permits bounded delayed retries', async () => {
  const { ledger, advance } = fixture();
  await ledger.enqueue(input);
  let claim = await ledger.claim(ref, worker);
  let result = await ledger.dispatch(claim, async () => ({ outcome: 'not_applied', reason: 'Definitively rejected before enqueue', retryable: true, retryAfterMs: 50 }));
  assert.equal(result.action.state, 'ready');
  assert.equal(await ledger.claim(ref, worker), null);
  advance(50);
  claim = await ledger.claim(ref, worker);
  result = await ledger.dispatch(claim, async () => ({ outcome: 'not_applied', reason: 'Definitively rejected again', retryable: true }));
  assert.equal(result.action.state, 'failed');
  assert.equal(result.action.attempts.length, 2);
  assert.equal(await ledger.claim(ref, worker), null);
});

test('permanent rejection is terminal, thrown or invalid responses are uncertain', async () => {
  for (const adapter of [
    async () => { throw new Error('connection lost'); },
    async () => ({ outcome: 'retry' }),
    async () => ({ outcome: 'applied', receipt: undefined }),
    async () => ({ outcome: 'not_applied', reason: 'rate limited', retryable: true, retryAfterMs: Infinity }),
  ]) {
    const { ledger } = fixture();
    await ledger.enqueue(input);
    const result = await ledger.dispatch(await ledger.claim(ref, worker), adapter);
    assert.equal(result.action.state, 'uncertain');
    assert.equal(await ledger.claim(ref, worker), null);
  }
  const { ledger } = fixture();
  await ledger.enqueue(input);
  const result = await ledger.dispatch(await ledger.claim(ref, worker), async () => ({ outcome: 'not_applied', reason: 'rejected permanently', retryable: false }));
  assert.equal(result.action.state, 'failed');
});

test('expiry after dispatch never allows another worker; stale completion cannot overwrite resolution', async () => {
  const { ledger, advance } = fixture();
  await ledger.enqueue(input);
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const pending = ledger.dispatch(await ledger.claim(ref, worker), async () => {
    started();
    return new Promise(resolve => { release = resolve; });
  });
  await entered;
  advance(100);
  assert.equal(await ledger.claim(ref, { ...worker, workerId: 'worker-2' }), null);
  const uncertain = await ledger.get(ref);
  assert.equal(uncertain.state, 'uncertain');
  const resolution = { expectedRevision: uncertain.revision, actor: 'operator:1', evidence: { providerId: 'verified' }, receipt: { providerId: 'verified' } };
  const resolved = await ledger.resolve(ref, resolution);
  assert.equal(resolved.accepted, true);
  release(applied);
  const late = await pending;
  assert.equal(late.accepted, false);
  assert.deepEqual((await ledger.get(ref)).resolution.receipt, resolution.receipt);
});

test('resolve can atomically normalize expiry; concurrent reconciliation allows one winner', async () => {
  const { ledger, advance } = fixture();
  await ledger.enqueue(input);
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const pending = ledger.dispatch(await ledger.claim(ref, worker), async () => {
    started(); return new Promise(resolve => { release = resolve; });
  });
  await entered;
  const observed = await ledger.get(ref);
  const decision = { expectedRevision: observed.revision, actor: 'operator', evidence: { verified: true }, receipt: { providerId: 'post-1' } };
  assert.equal((await ledger.resolve(ref, decision)).accepted, false, 'live execution must not be resolved');
  advance(101);
  const results = await Promise.all([ledger.resolve(ref, decision), ledger.resolve(ref, decision)]);
  assert.equal(results.filter(x => x.accepted).length, 1);
  release(applied); await pending;
});

test('resolve cannot reopen uncertainty, fabricate success without evidence, or resolve ready actions', async () => {
  const { ledger } = fixture();
  const ready = await ledger.enqueue(input);
  const decision = { expectedRevision: ready.revision, actor: 'operator', evidence: { providerId: 'x' }, receipt: { providerId: 'x' } };
  assert.equal((await ledger.resolve(ref, decision)).accepted, false);
  await ledger.dispatch(await ledger.claim(ref, worker), async () => { throw Error('timeout'); });
  const uncertain = await ledger.get(ref);
  await assert.rejects(ledger.resolve(ref, { ...decision, expectedRevision: uncertain.revision, evidence: {} }));
  await assert.rejects(ledger.resolve(ref, { ...decision, expectedRevision: uncertain.revision, outcome: 'not_applied' }));
  assert.equal((await ledger.get(ref)).state, 'uncertain');
});

test('memory store rolls back errors, rejects async mutation and isolates result objects', async () => {
  const { ledger, store } = fixture();
  await ledger.enqueue(input);
  await assert.rejects(store.transact(ref, record => { record.state = 'failed'; throw Error('rollback'); }));
  await assert.rejects(store.transact(ref, async record => ({ record, result: null })));
  assert.equal((await ledger.get(ref)).state, 'ready');
});
