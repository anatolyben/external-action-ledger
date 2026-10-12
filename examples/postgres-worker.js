import pg from 'pg';
import { createActionLedger } from '../src/index.js';
import { createPostgresStore } from '../src/postgres.js';

const connectionString = process.env.ACTION_LEDGER_EXAMPLE_DATABASE_URL;
if (!connectionString) throw new Error('Set ACTION_LEDGER_EXAMPLE_DATABASE_URL to a development PostgreSQL database. This example creates a table and stores one action.');
const pool = new pg.Pool({ connectionString });
try {
  const store = createPostgresStore(pool);
  await store.initialize();
  const actions = createActionLedger({ store });
  const ref = { namespace: 'example:development', key: 'publish:hello-v1' };
  await actions.enqueue({ ...ref, kind: 'publish', payload: { text: 'Hello' } });
  const claim = await actions.claim(ref, { workerId: 'example-worker', leaseMs: 30_000 });
  if (claim) {
    const result = await actions.dispatch(claim, async context => {
      console.log('Simulated provider invocation:', context.effectKey);
      return { outcome: 'applied', receipt: { simulated: true, providerId: `demo-${context.actionId}` } };
    });
    console.log('State:', result.action?.state, 'Transition accepted:', result.accepted);
  } else {
    console.log('No eligible claim. Existing state:', (await actions.get(ref))?.state);
  }
} finally {
  await pool.end();
}
