import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createActionLedger, createMemoryStore } from '../src/index.js';
import { createPostgresStore } from '../src/postgres.js';

let database;
let stores;
before(async () => {
  database = new PGlite();
  const postgres = createPostgresStore({
    async connect() {
      return { query: (...args) => database.query(...args), release() {} };
    },
  });
  await postgres.initialize();
  stores = [
    ['memory', createMemoryStore()],
    ['postgres-sql', postgres],
  ];
});
after(async () => { await database?.close(); });

const ref = key => ({ namespace: 'json-parity', key });
const input = key => ({ ...ref(key), kind: 'publish', payload: { text: 'hello' } });
const worker = { workerId: 'json-worker', leaseMs: 10_000 };

function nested(depth) {
  let value = 'leaf';
  for (let index = 0; index < depth; index++) value = { child: value };
  return value;
}

function invalidValues() {
  const cycle = {}; cycle.self = cycle;
  const symbol = { [Symbol('unsupported')]: 1 };
  const getter = Object.defineProperty({}, 'value', {
    enumerable: true, get() { assert.fail('JSON accessors must never be invoked'); },
  });
  const arrayGetter = Object.defineProperty([1], '0', {
    enumerable: true, get() { assert.fail('array accessors must never be invoked'); },
  });
  const hidden = Object.defineProperty({}, 'value', { value: 1 });
  const arrayExtra = Object.defineProperty([1], 'extra', { value: 2 });
  const arrayHiddenIndex = Object.defineProperty([1], '0', { enumerable: false });
  return [
    undefined, { value: undefined }, NaN, Infinity, 1n, () => {},
    new Date(), new Map(), Object.create({ inherited: true }), cycle, symbol,
    [, 1], getter, arrayGetter, hidden, arrayExtra, arrayHiddenIndex,
    { text: '\0' }, { text: '\ud800' }, { text: '\udfff' },
    { ['\0']: 'key' }, { ['\ud800']: 'key' }, { ['\udfff']: 'key' },
  ];
}

test('both stores reject unsupported enqueue JSON before writing an action', async () => {
  for (const [name, store] of stores) {
    const ledger = createActionLedger({ store });
    for (const [index, payload] of invalidValues().entries()) {
      const action = input(`invalid-${name}-${index}`);
      await assert.rejects(ledger.enqueue({ ...action, payload }), TypeError);
      assert.equal(await ledger.get(action), null);
    }
  }
});

test('invalid Unicode in references and kind is rejected consistently', async () => {
  for (const [, store] of stores) {
    const ledger = createActionLedger({ store });
    for (const field of ['namespace', 'key', 'kind']) {
      for (const text of ['with\0nul', '\ud800', '\udfff']) {
        await assert.rejects(ledger.enqueue({ ...input('invalid-field'), [field]: text }), TypeError);
      }
    }
  }
});

test('invalid receipts become durable uncertainty in memory and PostgreSQL', async () => {
  for (const [name, store] of stores) {
    const ledger = createActionLedger({ store });
    for (const [index, receipt] of invalidValues().entries()) {
      const action = input(`invalid-receipt-${name}-${index}`);
      await ledger.enqueue(action);
      const result = await ledger.dispatch(await ledger.claim(action, worker), async () => ({ outcome: 'applied', receipt }));
      assert.equal(result.accepted, true);
      assert.equal(result.action.state, 'uncertain');
      assert.equal((await ledger.get(action)).attempts[0].outcome, 'unknown');
      assert.equal(await ledger.claim(action, worker), null);
    }
  }
});

test('raw store mutations reject the same unsupported JSON and roll back record and result together', async () => {
  for (const [name, store] of stores) {
    const actionRef = ref(`raw-json-${name}`);
    await store.transact(actionRef, () => ({ record: { count: 1 }, result: null }));
    for (const invalid of invalidValues()) {
      await assert.rejects(store.transact(actionRef, () => ({ record: { invalid }, result: null })), TypeError);
      await assert.rejects(store.transact(actionRef, record => {
        record.count = 2;
        return { record, result: invalid };
      }), TypeError);
      assert.deepEqual(await store.read(actionRef), { count: 1 });
    }
  }
});

test('valid Unicode, shared references, null prototypes and special keys are copied without mutation', async () => {
  for (const [name, store] of stores) {
    const ledger = createActionLedger({ store });
    const shared = { text: 'Привет 🌍' };
    const payload = Object.assign(Object.create(null), { first: shared, second: shared, zero: -0 });
    payload.__proto__ = { safe: true };
    const action = await ledger.enqueue({ ...input(`valid-json-${name}`), payload });
    shared.text = 'changed';
    assert.equal(action.payload.first.text, 'Привет 🌍');
    assert.deepEqual(action.payload.__proto__, { safe: true });
    assert.equal(Object.getPrototypeOf(action.payload), Object.prototype);
    assert.equal(Object.is(action.payload.zero, -0), false);
    action.payload.first.text = 'returned value changed';
    assert.equal((await ledger.get(action)).payload.second.text, 'Привет 🌍');
    assert.equal((await ledger.get(action)).payload.first.text, 'Привет 🌍');
  }
});

test('record and result wrappers preserve the core depth limit without imposing the per-value byte cap', async () => {
  for (const [name, store] of stores) {
    const ledger = createActionLedger({ store });
    const deep = { ...input(`deep-json-${name}`), payload: nested(64) };
    await ledger.enqueue(deep);
    const deepResult = await ledger.dispatch(await ledger.claim(deep, worker), async () => ({ outcome: 'applied', receipt: nested(64) }));
    assert.equal(deepResult.action.state, 'succeeded');
    await assert.rejects(ledger.enqueue({ ...input(`too-deep-${name}`), payload: nested(65) }), /64/);

    const large = { ...input(`large-json-${name}`), payload: 'x'.repeat(200_000) };
    await ledger.enqueue(large);
    const largeResult = await ledger.dispatch(await ledger.claim(large, worker), async () => ({ outcome: 'applied', receipt: 'y'.repeat(200_000) }));
    assert.equal(largeResult.action.state, 'succeeded');
    assert.ok(Buffer.byteLength(JSON.stringify(largeResult.action)) > 262_144);
    await assert.rejects(ledger.enqueue({ ...input(`too-large-${name}`), payload: 'x'.repeat(262_144) }), /262144/);

    const rawRef = ref(`raw-deep-${name}`);
    await store.transact(rawRef, () => ({ record: nested(128), result: nested(128) }));
    await assert.rejects(store.transact(rawRef, () => ({ record: nested(129), result: null })), /128/);
  }
});

test('throwing async storage mutators are rejected without unhandled rejections or committed records', async () => {
  // node:test also fails the suite if an unhandled rejection escapes afterward.
  const unhandled = [];
  const onUnhandled = error => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const [name, store] of stores) {
      const actionRef = ref(`async-throw-${name}`);
      await assert.rejects(store.transact(actionRef, async () => { throw Error('async callback failure'); }), /synchronous/i);
      assert.equal(await store.read(actionRef), null);
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
