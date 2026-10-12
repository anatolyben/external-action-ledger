import { randomUUID } from 'node:crypto';
import { copyJson } from './json.js';

const MAX_JSON_BYTES = 262_144;
const MAX_LEASE_MS = 86_400_000;
const MAX_RETRY_MS = 2_592_000_000;

export class ConflictError extends Error {
  constructor() {
    super('The namespace/key already identifies a different action');
    this.name = 'ConflictError';
    this.code = 'ACTION_CONFLICT';
  }
}

function string(value, label, max = 255) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || value.includes('\0') || !value.isWellFormed()) {
    throw new TypeError(`${label} must be a nonempty valid Unicode string of at most ${max} characters without NUL`);
  }
  return value;
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function reference(input) {
  if (!input || typeof input !== 'object') throw new TypeError('An action reference is required');
  return { namespace: string(input.namespace, 'namespace'), key: string(input.key, 'key') };
}

// Strict JSON avoids mutable values, surprising coercions and ambiguous deduplication.
function json(value, label) {
  return copyJson(value, { label, maxDepth: 64, maxBytes: MAX_JSON_BYTES });
}

function nowValue(now) { return integer(now, 'store clock', 0, Number.MAX_SAFE_INTEGER - MAX_RETRY_MS); }
function bump(record, now) { record.revision++; record.updatedAt = now; }
function mutation(record, result) { return { record, result }; }
function decision(record, accepted) { return mutation(record, { accepted, action: record }); }

function expire(record, now) {
  if (!record?.claim || record.claim.expiresAt > now) return;
  if (record.state === 'claimed') {
    record.state = 'ready';
    record.availableAt = now;
    record.claim = null;
    bump(record, now);
  } else if (record.state === 'executing') {
    record.state = 'uncertain';
    const attempt = record.attempts.at(-1);
    attempt.finishedAt = now;
    attempt.outcome = 'unknown';
    attempt.reason = 'Dispatch lease expired; the external effect may still occur';
    record.claim = null;
    bump(record, now);
  }
}

function matches(record, claim, state, revision) {
  return record?.state === state && record.revision === revision &&
    record.claim?.token === claim.token && record.claim.attemptId === claim.attemptId &&
    record.claim.workerId === claim.workerId;
}

function adapterOutcome(value) {
  if (value?.outcome === 'applied') return { outcome: 'applied', receipt: json(value.receipt, 'receipt') };
  if (value?.outcome === 'not_applied') {
    if (typeof value.retryable !== 'boolean') throw new TypeError('retryable must be boolean');
    return {
      outcome: 'not_applied', reason: string(value.reason, 'reason', 4096), retryable: value.retryable,
      retryAfterMs: integer(value.retryAfterMs ?? 0, 'retryAfterMs', 0, MAX_RETRY_MS),
    };
  }
  throw new TypeError('Adapter returned an unsupported outcome');
}

export function createActionLedger({ store }) {
  if (!store || typeof store.read !== 'function' || typeof store.transact !== 'function') throw new TypeError('A store is required');

  return {
    async enqueue(input) {
      const ref = reference(input);
      const kind = string(input.kind, 'kind');
      const payload = json(input.payload, 'payload');
      const maxAttempts = integer(input.maxAttempts ?? 3, 'maxAttempts', 1, 100);
      return store.transact(ref, (record, clock) => {
        const now = nowValue(clock);
        if (record) {
          if (record.kind !== kind || record.maxAttempts !== maxAttempts ||
              JSON.stringify(json(record.payload, 'stored payload')) !== JSON.stringify(payload)) throw new ConflictError();
          return mutation(record, record);
        }
        record = {
          id: randomUUID(), ...ref, kind, payload, maxAttempts,
          state: 'ready', revision: 1, createdAt: now, updatedAt: now, availableAt: now,
          claim: null, attempts: [], resolution: null,
        };
        return mutation(record, record);
      });
    },

    async get(input) { return store.read(reference(input)); },

    async claim(input, options) {
      const ref = reference(input);
      const workerId = string(options?.workerId, 'workerId');
      const leaseMs = integer(options?.leaseMs, 'leaseMs', 1, MAX_LEASE_MS);
      return store.transact(ref, (record, clock) => {
        const now = nowValue(clock);
        expire(record, now);
        if (!record || record.state !== 'ready' || record.availableAt > now) return mutation(record, null);
        record.state = 'claimed';
        record.claim = { token: randomUUID(), attemptId: randomUUID(), workerId, expiresAt: now + leaseMs };
        bump(record, now);
        return mutation(record, { ...ref, ...record.claim, revision: record.revision });
      });
    },

    async dispatch(input, adapter) {
      const ref = reference(input);
      const claim = { ...ref, token: string(input.token, 'token'), attemptId: string(input.attemptId, 'attemptId'), workerId: string(input.workerId, 'workerId') };
      const revision = integer(input.revision, 'revision', 1, Number.MAX_SAFE_INTEGER);
      if (typeof adapter !== 'function') throw new TypeError('An adapter function is required');

      // Keep this transaction outside the adapter catch. A failed commit acknowledgment
      // may conceal a durable dispatch intent, but it must never trigger the provider.
      const begun = await store.transact(ref, (record, clock) => {
        const now = nowValue(clock);
        expire(record, now);
        if (!matches(record, claim, 'claimed', revision)) return decision(record, false);
        record.state = 'executing';
        record.attempts.push({
          id: claim.attemptId, number: record.attempts.length + 1, workerId: claim.workerId,
          startedAt: now, finishedAt: null, outcome: null, reason: null, receipt: null,
        });
        bump(record, now);
        return decision(record, true);
      });
      if (!begun.accepted) return begun;

      const action = begun.action;
      let outcome;
      try {
        outcome = adapterOutcome(await adapter({
          actionId: action.id, ...ref, kind: action.kind, payload: structuredClone(action.payload),
          effectKey: action.id, attemptId: claim.attemptId, attemptNumber: action.attempts.length,
          workerId: claim.workerId, leaseExpiresAt: action.claim.expiresAt,
        }));
      } catch {
        // Error messages often contain credentials or provider payloads. Keep them in
        // application-owned logs; the ledger records only the conservative conclusion.
        outcome = { outcome: 'unknown', reason: 'Adapter threw or returned an invalid result; external outcome unknown' };
      }

      // Persistence errors here propagate. Never reinterpret them as provider rejection.
      return store.transact(ref, (record, clock) => {
        const now = nowValue(clock);
        expire(record, now);
        if (!matches(record, claim, 'executing', action.revision)) return decision(record, false);
        const attempt = record.attempts.at(-1);
        attempt.finishedAt = now;
        attempt.outcome = outcome.outcome;
        if (outcome.outcome === 'applied') {
          record.state = 'succeeded';
          attempt.receipt = outcome.receipt;
        } else if (outcome.outcome === 'not_applied') {
          attempt.reason = outcome.reason;
          record.state = outcome.retryable && record.attempts.length < record.maxAttempts ? 'ready' : 'failed';
          record.availableAt = now + outcome.retryAfterMs;
        } else {
          record.state = 'uncertain';
          attempt.reason = outcome.reason;
        }
        record.claim = null;
        bump(record, now);
        return decision(record, true);
      });
    },

    async resolve(input, options) {
      const ref = reference(input);
      const expectedRevision = integer(options?.expectedRevision, 'expectedRevision', 1, Number.MAX_SAFE_INTEGER);
      const actor = string(options?.actor, 'actor');
      if (options.outcome !== undefined && options.outcome !== 'applied') throw new TypeError('v0 supports only confirmed-success resolution');
      const evidence = json(options.evidence, 'evidence');
      if (!evidence || Array.isArray(evidence) || typeof evidence !== 'object' || !Object.keys(evidence).length) throw new TypeError('evidence must be a nonempty JSON object');
      const receipt = json(options.receipt, 'receipt');
      return store.transact(ref, (record, clock) => {
        const now = nowValue(clock);
        const expected = record?.revision === expectedRevision;
        expire(record, now);
        if (!expected || record?.state !== 'uncertain') return decision(record, false);
        record.state = 'succeeded';
        record.resolution = { actor, evidence, receipt, resolvedAt: now, attemptId: record.attempts.at(-1).id };
        bump(record, now);
        return decision(record, true);
      });
    },
  };
}

/** Reference implementation for simulations, never durable storage. */
export function createMemoryStore({ clock = Date.now } = {}) {
  const records = new Map();
  const keyOf = ref => JSON.stringify([ref.namespace, ref.key]);
  return {
    async read(ref) { return copyJson(records.get(keyOf(ref)) ?? null); },
    async transact(ref, mutator) {
      // No await occurs between read and commit: synchronous mutation is atomic in
      // this process. This provides no cross-process locking or crash durability.
      const key = keyOf(ref);
      const original = records.get(key) ?? null;
      const update = mutator(copyJson(original), nowValue(clock()));
      if (update && typeof update.then === 'function') {
        Promise.resolve(update).catch(() => {});
        throw new TypeError('Store mutators must return {record, result} synchronously');
      }
      if (!update || !Object.hasOwn(update, 'record') || !Object.hasOwn(update, 'result')) throw new TypeError('Store mutators must return {record, result} synchronously');
      if (update.record === null) {
        if (original) throw new TypeError('Existing action records cannot be deleted');
      } else if (typeof update.record !== 'object' || Array.isArray(update.record)) {
        throw new TypeError('Action record must be an object or null');
      }
      // Clone everything before commit so serialization failures cannot partially commit.
      const next = copyJson(update.record);
      const result = copyJson(update.result);
      if (next !== null) records.set(key, next);
      return result;
    },
  };
}
