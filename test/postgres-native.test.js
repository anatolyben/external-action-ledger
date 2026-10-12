import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { createActionLedger } from '../src/index.js';
import { createPostgresStore } from '../src/postgres.js';

const connectionString = process.env.ACTION_LEDGER_TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('Native tests require ACTION_LEDGER_TEST_DATABASE_URL pointing to an explicitly disposable PostgreSQL database. No default database is used.');
}
const schema = `action_ledger_test_${Date.now()}_${randomBytes(5).toString('hex')}`;
const table = `"${schema}"."external_action_ledger_v1"`;
const pool = new pg.Pool({ connectionString, max: 12, connectionTimeoutMillis: 3000, query_timeout: 5000 });
const store = createPostgresStore(pool, { schema });
const ledger = createActionLedger({ store });
const reference = key => ({ namespace: 'native', key });
let schemaCreated = false;

before(async () => {
  await pool.query(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  await store.initialize();
});
after(async () => {
  try {
    if (schemaCreated) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await pool.end();
  }
});

test('native concurrent first inserts serialize all mutators without lost updates', { timeout: 10000 }, async () => {
  const ref = reference('initial-insert-race');
  let calls = 0;
  const results = await Promise.all(Array.from({ length: 24 }, () => store.transact(ref, record => {
    calls++;
    const count = (record?.count ?? 0) + 1;
    return { record: { count }, result: count };
  })));
  assert.equal(calls, 24);
  assert.deepEqual(results.sort((a, b) => a - b), Array.from({ length: 24 }, (_, i) => i + 1));
  assert.deepEqual(await store.read(ref), { count: 24 });
  const rows = await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE namespace = $1 AND key = $2`, [ref.namespace, ref.key]);
  assert.equal(rows.rows[0].count, 1);
});

test('native rollback removes new placeholders and preserves existing records', { timeout: 10000 }, async () => {
  const ref = reference('rollback');
  await assert.rejects(store.transact(ref, () => { throw Error('abort new'); }), /abort new/);
  const rows = await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE namespace = $1 AND key = $2`, [ref.namespace, ref.key]);
  assert.equal(rows.rows[0].count, 0);
  await store.transact(ref, () => ({ record: { value: 1 }, result: null }));
  await assert.rejects(store.transact(ref, record => {
    record.value = 2;
    throw Error('abort existing');
  }), /abort existing/);
  assert.deepEqual(await store.read(ref), { value: 1 });
});

test('native lock wait samples the authoritative clock after acquiring the lock', { timeout: 10000 }, async () => {
  const ref = reference('lock-clock');
  await store.transact(ref, () => ({ record: { value: 1 }, result: null }));
  const blocker = await pool.connect();
  let pending;
  let announceWait;
  const attemptingLock = new Promise(resolve => { announceWait = resolve; });
  const watched = createPostgresStore({
    async connect() {
      const client = await pool.connect();
      return {
        query(sql, values) {
          // The insert may itself wait for the existing locked row, depending
          // on the PostgreSQL version. Announce before the first row operation.
          if (sql.startsWith('INSERT INTO')) announceWait();
          return client.query(sql, values);
        },
        release(error) { client.release(error); },
      };
    },
  }, { schema });
  try {
    await blocker.query('BEGIN');
    await blocker.query(`SELECT record FROM ${table} WHERE namespace = $1 AND key = $2 FOR UPDATE`, [ref.namespace, ref.key]);
    pending = watched.transact(ref, (record, now) => ({ record, result: now }));
    // Attach a rejection handler immediately, while preserving assertion below.
    pending.catch(() => {});
    await attemptingLock;
    await blocker.query('SELECT pg_sleep(0.15)');
    const clock = await blocker.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::double precision AS now_ms');
    await blocker.query('COMMIT');
    const observed = await pending;
    assert.ok(observed >= clock.rows[0].now_ms, 'mutator must receive time after the lock wait, not transaction start time');
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
    await pending?.catch(() => {});
  }
});

test('native concurrent enqueue, claim and dispatch produce one provider invocation', { timeout: 10000 }, async () => {
  const ref = reference('core-race');
  const input = { ...ref, kind: 'publish', payload: { text: 'one post' }, maxAttempts: 2 };
  const enqueued = await Promise.all(Array.from({ length: 12 }, () => ledger.enqueue(input)));
  assert.equal(new Set(enqueued.map(action => action.id)).size, 1);
  const claims = await Promise.all(Array.from({ length: 24 }, (_, index) => ledger.claim(ref, { workerId: `worker-${index}`, leaseMs: 10000 })));
  const winners = claims.filter(Boolean);
  assert.equal(winners.length, 1);
  let providerCalls = 0;
  const results = await Promise.all(Array.from({ length: 12 }, () => ledger.dispatch(winners[0], async () => {
    providerCalls++;
    return { outcome: 'applied', receipt: { providerId: 'post-1' } };
  })));
  assert.equal(providerCalls, 1);
  assert.equal(results.filter(result => result.accepted).length, 1);
  const action = await ledger.get(ref);
  assert.equal(action.state, 'succeeded');
  assert.equal(action.attempts.length, 1);
});

test('native uncertain outcomes cannot be reclaimed and resolution is fenced', { timeout: 10000 }, async () => {
  const ref = reference('core-uncertain');
  await ledger.enqueue({ ...ref, kind: 'publish', payload: {}, maxAttempts: 3 });
  const claim = await ledger.claim(ref, { workerId: 'first', leaseMs: 10000 });
  await ledger.dispatch(claim, async () => { throw Error('response lost after provider accepted'); });
  assert.equal(await ledger.claim(ref, { workerId: 'retry', leaseMs: 10000 }), null);
  const action = await ledger.get(ref);
  assert.equal(action.state, 'uncertain');
  const decision = { expectedRevision: action.revision, actor: 'operator', evidence: { providerId: 'confirmed-post' }, receipt: { providerId: 'confirmed-post' } };
  const resolutions = await Promise.all(Array.from({ length: 12 }, () => ledger.resolve(ref, decision)));
  assert.equal(resolutions.filter(result => result.accepted).length, 1);
  assert.equal((await ledger.get(ref)).state, 'succeeded');
});
