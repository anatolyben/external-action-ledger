import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createActionLedger } from '../src/index.js';
import { createPostgresStore } from '../src/postgres.js';

// SQL/lifecycle checks only: PGlite does not exercise native connection races.
let db;
let store;
const ref = key => ({ namespace: 'sql', key });
function poolFor(database, hooks = {}) {
  return {
    async connect() {
      hooks.connect?.();
      return {
        async query(sql, values) {
          hooks.beforeQuery?.(sql);
          const result = await database.query(sql, values);
          hooks.afterQuery?.(sql);
          return result;
        },
        release() { hooks.release?.(); },
      };
    },
  };
}

before(async () => {
  db = new PGlite();
  store = createPostgresStore(poolFor(db));
  await store.initialize();
});
after(async () => { await db?.close(); });

test('strict schema validation rejects interpolation and invalid identifiers', () => {
  for (const schema of ['', 'a.b', 'a";DROP TABLE x;--', ' white', 'x'.repeat(64), 4, null]) {
    assert.throws(() => createPostgresStore(poolFor(db), { schema }), /schema/i);
  }
});

test('initialize targets an existing quoted schema and can run again', async () => {
  await db.query('CREATE SCHEMA "Ledger_SQL"');
  const custom = createPostgresStore(poolFor(db), { schema: 'Ledger_SQL' });
  await custom.initialize();
  await custom.initialize();
  assert.equal(await custom.read(ref('missing')), null);
  const result = await db.query('SELECT count(*)::int AS count FROM "Ledger_SQL".external_action_ledger_v1');
  assert.equal(result.rows[0].count, 0);
});

test('missing reads and null mutations leave no placeholder', async () => {
  assert.equal(await store.read(ref('missing')), null);
  assert.equal(await store.transact(ref('missing'), (record, now) => {
    assert.equal(record, null);
    assert.ok(Number.isSafeInteger(now));
    assert.ok(now > Date.UTC(2020, 0, 1));
    return { record: null, result: null };
  }), null);
  const result = await db.query('SELECT count(*)::int AS count FROM external_action_ledger_v1 WHERE key = $1', ['missing']);
  assert.equal(result.rows[0].count, 0);
});

test('mutator runs once and snapshots/results are isolated from caller mutation', async () => {
  let calls = 0;
  const original = { nested: { value: 1 } };
  const returned = await store.transact(ref('isolation'), record => {
    calls += 1;
    assert.equal(record, null);
    return { record: original, result: original };
  });
  original.nested.value = 2;
  returned.nested.value = 3;
  const fetched = await store.read(ref('isolation'));
  assert.deepEqual(fetched, { nested: { value: 1 } });
  fetched.nested.value = 4;
  assert.deepEqual(await store.read(ref('isolation')), { nested: { value: 1 } });
  assert.equal(calls, 1);
});

test('throwing mutator rolls back changes and removes an uncommitted placeholder', async () => {
  const failure = new Error('mutator failure');
  let releases = 0;
  const instrumented = createPostgresStore(poolFor(db, { release() { releases++; } }));
  await assert.rejects(instrumented.transact(ref('rollback-new'), () => { throw failure; }), error => error === failure);
  assert.equal(releases, 1);
  assert.equal(await store.read(ref('rollback-new')), null);
  const rows = await db.query('SELECT count(*)::int AS count FROM external_action_ledger_v1 WHERE key = $1', ['rollback-new']);
  assert.equal(rows.rows[0].count, 0);
  await store.transact(ref('rollback-existing'), () => ({ record: { n: 1 }, result: null }));
  await assert.rejects(store.transact(ref('rollback-existing'), record => {
    record.n = 99;
    throw failure;
  }), error => error === failure);
  assert.deepEqual(await store.read(ref('rollback-existing')), { n: 1 });
});

test('async and malformed mutators roll back, and cannot delete durable records', async () => {
  await assert.rejects(store.transact(ref('async'), async () => ({ record: {}, result: null })), /synchronous/i);
  await assert.rejects(store.transact(ref('invalid'), () => ({ record: [], result: null })), /record/i);
  await assert.rejects(store.transact(ref('undefined'), () => ({ record: {}, result: undefined })), /JSON/i);
  await assert.rejects(store.transact(ref('invalid-number'), () => ({ record: { n: NaN }, result: null })), /JSON/i);
  assert.equal(await store.read(ref('async')), null);
  assert.equal(await store.read(ref('invalid')), null);
  await store.transact(ref('durable'), () => ({ record: { n: 1 }, result: null }));
  await assert.rejects(store.transact(ref('durable'), () => ({ record: null, result: null })), /delete/i);
  assert.deepEqual(await store.read(ref('durable')), { n: 1 });
});

test('a SQL failure rolls back once and releases the client', async () => {
  let rollbacks = 0;
  let releases = 0;
  const failure = new Error('simulated update connection failure');
  const instrumented = createPostgresStore(poolFor(db, {
    beforeQuery(sql) {
      if (sql.startsWith('UPDATE')) throw failure;
      if (sql === 'ROLLBACK') rollbacks++;
    },
    release() { releases++; },
  }));
  await assert.rejects(instrumented.transact(ref('sql-failure'), () => ({ record: {}, result: null })), error => error === failure);
  assert.equal(rollbacks, 1);
  assert.equal(releases, 1);
  assert.equal(await store.read(ref('sql-failure')), null);
});

test('lost COMMIT acknowledgement rejects without retry even though data committed', async () => {
  let commits = 0;
  let rollbacks = 0;
  let releases = 0;
  let calls = 0;
  const failure = new Error('connection lost after commit');
  const instrumented = createPostgresStore(poolFor(db, {
    beforeQuery(sql) { if (sql === 'ROLLBACK') rollbacks++; },
    afterQuery(sql) {
      if (sql === 'COMMIT') { commits++; throw failure; }
    },
    release() { releases++; },
  }));
  await assert.rejects(instrumented.transact(ref('commit-unknown'), () => {
    calls++;
    return { record: { committed: true }, result: 'success' };
  }), error => error === failure);
  assert.equal(calls, 1);
  assert.equal(commits, 1);
  assert.equal(rollbacks, 1);
  assert.equal(releases, 1);
  assert.deepEqual(await store.read(ref('commit-unknown')), { committed: true });
});

test('authoritative clock is queried after the row lock', async () => {
  const statements = [];
  const instrumented = createPostgresStore(poolFor(db, { beforeQuery(sql) { statements.push(sql); } }));
  await instrumented.transact(ref('clock-order'), () => ({ record: {}, result: null }));
  const lockIndex = statements.findIndex(sql => sql.includes('FOR UPDATE'));
  const clockIndex = statements.findIndex(sql => sql.includes('clock_timestamp()'));
  assert.ok(lockIndex >= 0 && clockIndex > lockIndex);
});

test('ledger lifecycle persists safe retry, uncertainty and manual reconciliation through SQL', async () => {
  const ledger = createActionLedger({ store });
  const actionRef = ref('ledger-lifecycle');
  const input = { ...actionRef, kind: 'publish', payload: { text: 'hello' }, maxAttempts: 3 };
  const action = await ledger.enqueue(input);
  assert.equal((await ledger.enqueue(input)).id, action.id);
  const worker = { workerId: 'sql-worker', leaseMs: 10000 };
  const first = await ledger.claim(actionRef, worker);
  await ledger.dispatch(first, async () => ({ outcome: 'not_applied', reason: 'definitely rejected before enqueue', retryable: true }));
  assert.equal((await ledger.get(actionRef)).state, 'ready');
  const second = await ledger.claim(actionRef, worker);
  await ledger.dispatch(second, async () => { throw Error('lost response'); });
  const uncertain = await ledger.get(actionRef);
  assert.equal(uncertain.state, 'uncertain');
  assert.equal(uncertain.attempts.length, 2);
  assert.equal(await ledger.claim(actionRef, worker), null);
  const decision = { expectedRevision: uncertain.revision, actor: 'operator', evidence: { providerId: 'confirmed' }, receipt: { providerId: 'confirmed' } };
  assert.equal((await ledger.resolve(actionRef, decision)).accepted, true);
  assert.equal((await ledger.resolve(actionRef, decision)).accepted, false);
  assert.equal((await ledger.get(actionRef)).state, 'succeeded');
});

test('lost SQL commit acknowledgment for dispatch intent prevents provider invocation', async () => {
  const actionRef = ref('ledger-intent-commit-unknown');
  const ledger = createActionLedger({ store });
  await ledger.enqueue({ ...actionRef, kind: 'publish', payload: {} });
  const claim = await ledger.claim(actionRef, { workerId: 'sql-worker', leaseMs: 10000 });
  const failure = new Error('intent COMMIT response lost');
  const commitFailingStore = createPostgresStore(poolFor(db, {
    afterQuery(sql) { if (sql === 'COMMIT') throw failure; },
  }));
  const dispatching = createActionLedger({ store: commitFailingStore });
  let providerCalls = 0;
  await assert.rejects(dispatching.dispatch(claim, async () => {
    providerCalls++;
    return { outcome: 'applied', receipt: { providerId: 'must-not-send' } };
  }), error => error === failure);
  assert.equal(providerCalls, 0);
  assert.equal((await ledger.get(actionRef)).state, 'executing');
});
