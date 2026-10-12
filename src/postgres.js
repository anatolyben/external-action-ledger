import { copyJson } from './json.js';

/** PostgreSQL persistence. The caller owns the pool and its lifecycle. */
export function createPostgresStore(pool, { schema = 'public' } = {}) {
  if (typeof schema !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) {
    throw new TypeError('schema must be a PostgreSQL identifier of 1–63 ASCII letters, digits, or underscores, beginning with a letter or underscore');
  }
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool.connect must be a function');
  const table = `"${schema}"."external_action_ledger_v1"`;

  return {
    async initialize() {
      const client = await pool.connect();
      try {
        await client.query(`CREATE TABLE IF NOT EXISTS ${table} (
          namespace text NOT NULL,
          key text NOT NULL,
          record jsonb,
          PRIMARY KEY (namespace, key),
          CHECK (record IS NULL OR jsonb_typeof(record) = 'object')
        )`);
      } finally {
        client.release();
      }
    },

    async read(ref) {
      const client = await pool.connect();
      try {
        const response = await client.query(`SELECT record FROM ${table} WHERE namespace = $1 AND key = $2`, [ref.namespace, ref.key]);
        return response.rows.length === 0 ? null : copyJson(response.rows[0].record);
      } finally {
        client.release();
      }
    },

    async transact(ref, mutate) {
      if (typeof mutate !== 'function') throw new TypeError('mutator must be a function');
      const client = await pool.connect();
      let discardClient = false;
      try {
        await client.query('BEGIN');
        const parameters = [ref.namespace, ref.key];
        // Conflicting inserts wait for the first transaction. Its committed
        // record is subsequently read under a lock, including the first insert.
        await client.query(`INSERT INTO ${table} (namespace, key, record) VALUES ($1, $2, NULL) ON CONFLICT (namespace, key) DO NOTHING`, parameters);
        const locked = await client.query(`SELECT record FROM ${table} WHERE namespace = $1 AND key = $2 FOR UPDATE`, parameters);
        if (locked.rows.length !== 1) throw new Error('Locked action row is missing');
        // Transaction start time can be stale after waiting for the row lock.
        const clock = await client.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::double precision AS now_ms');
        const now = Number(clock.rows[0]?.now_ms);
        if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid PostgreSQL authoritative clock');
        const existing = locked.rows[0].record;
        const mutation = mutate(copyJson(existing), now);
        if (mutation && typeof mutation.then === 'function') {
          // Avoid an unhandled rejection from an accidentally async callback.
          Promise.resolve(mutation).catch(() => {});
          throw new TypeError('The storage mutator must be synchronous');
        }
        if (!mutation || typeof mutation !== 'object' || !Object.hasOwn(mutation, 'record') || !Object.hasOwn(mutation, 'result')) {
          throw new TypeError('The mutator must return {record, result}');
        }
        const next = mutation.record;
        if (next !== null && (typeof next !== 'object' || Array.isArray(next))) {
          throw new TypeError('The resulting record must be an object or null');
        }
        const nextCopy = copyJson(next);
        const resultCopy = copyJson(mutation.result);
        if (nextCopy === null) {
          if (existing !== null) throw new Error('Cannot delete a durable action record');
          await client.query(`DELETE FROM ${table} WHERE namespace = $1 AND key = $2 AND record IS NULL`, parameters);
        } else {
          await client.query(`UPDATE ${table} SET record = $3::jsonb WHERE namespace = $1 AND key = $2`, [...parameters, JSON.stringify(nextCopy)]);
        }
        // Never retry COMMIT or the mutator. A rejected COMMIT may already
        // have committed, and callers must not perform a provider action then.
        await client.query('COMMIT');
        return resultCopy;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { discardClient = true; }
        throw error;
      } finally {
        client.release(discardClient ? true : undefined);
      }
    },
  };
}

