import { createActionLedger, createMemoryStore, type Adapter, type Store } from 'external-action-ledger';
import { createPostgresStore } from 'external-action-ledger/postgres';
import pgDriver from 'pg';

const store: Store = createMemoryStore();
const ledger = createActionLedger({ store });
const ref = { namespace: 'tenant:1', key: 'publish:1' };
await ledger.enqueue({ ...ref, kind: 'publish', payload: { text: 'hello' } });
const adapter: Adapter = async ctx => ({ outcome: 'applied', receipt: { key: ctx.effectKey } });
const claim = await ledger.claim(ref, { workerId: 'worker-1', leaseMs: 30_000 });
if (claim) {
  const result = await ledger.dispatch(claim, adapter);
  if (result.action?.state === 'uncertain') {
    await ledger.resolve(ref, { expectedRevision: result.action.revision, actor: 'operator', evidence: { providerId: 'x' }, receipt: { providerId: 'x' } });
  }
}
const pg = createPostgresStore({
  async connect() { return { async query() { return { rows: [] }; }, release() {} }; },
});
await pg.initialize();
createActionLedger({ store: pg });
const realPgPool = new pgDriver.Pool();
createActionLedger({ store: createPostgresStore(realPgPool) });

// @ts-expect-error unknown outcomes cannot silently become retries
const invalid: Adapter = async () => ({ outcome: 'retry' });
// @ts-expect-error dispatch requires a claim, not merely a reference
await ledger.dispatch(ref, adapter);
// @ts-expect-error reconciliation never reopens an uncertain action
await ledger.resolve(ref, { expectedRevision: 1, actor: 'operator', evidence: {}, receipt: null, outcome: 'not_applied' });
// @ts-expect-error asynchronous store mutators are not supported
await store.transact(ref, async record => ({ record, result: null }));
void invalid;
