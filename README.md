# External Action Ledger

A small JavaScript/TypeScript library for tracking external actions from an application or workflow engine. It records dispatch intent, controls worker ownership, bounds safe retries, and preserves uncertain outcomes. PostgreSQL provides durable storage; an in-memory implementation powers deterministic failure simulations.

**Status: experimental 0.1.0.** GitHub releases are created only after the native PostgreSQL CI gate passes. The library has no runtime dependencies; the PostgreSQL integration accepts your `pg` pool. Node.js 22 or newer is required. Registry publication is separate; the npm publishing configuration uses the `experimental` distribution tag.

## Run it

```sh
npm ci
npm run check
npm run simulate
```

`check` runs behavioral tests, PostgreSQL SQL smoke tests using PGlite, and TypeScript API checks. It does not run a native PostgreSQL server. See [VALIDATION.md](VALIDATION.md) for precisely what has been verified.

For the companion gist, run `npm run gist`. It imports the versioned package and demonstrates lost-response handling and evidence-based recovery. The full project retains the broader failure-simulation suite. The gist does not contain a second copy of the library.

## Small API

| Operation | Purpose | Return value |
|---|---|---|
| `enqueue(input)` | Create immutable work, deduplicated by namespace/key | Action record; conflicting reuse throws `ConflictError` |
| `get(ref)` | Read a snapshot | Action record or `null` |
| `claim(ref, options)` | Claim eligible work for a bounded lease | Claim or `null` |
| `dispatch(claim, adapter)` | Persist dispatch intent, call the adapter once, record the outcome | `{accepted, action}` |
| `resolve(ref, options)` | Record verified success for an uncertain action | `{accepted, action}` |

`accepted` describes whether a ledger transition was accepted. **Only `action.state === 'succeeded'` reports success.** A dispatch can be accepted while ending in `ready`, `failed`, or `uncertain`. A rejected stale dispatch may return an action another worker already resolved. Database errors reject the promise and must not be interpreted as proof of external failure.

## Use PostgreSQL

Install the versioned package from the GitHub release:

```sh
npm install https://github.com/anatolyben/external-action-ledger/releases/download/v0.1.0/external-action-ledger-0.1.0.tgz pg
```

```js
import pg from 'pg';
import { createActionLedger } from 'external-action-ledger';
import { createPostgresStore } from 'external-action-ledger/postgres';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const store = createPostgresStore(pool);
await store.initialize(); // Explicit setup/migration step; not per task.
const actions = createActionLedger({ store });

const ref = { namespace: 'tenant:123:account:456', key: 'publish:campaign:789' };
await actions.enqueue({
  ...ref,
  kind: 'publish-post',
  payload: { text: 'Hello' },
  maxAttempts: 3,
});

// Your queue, cron, HTTP handler, or workflow invokes this with the same ref.
const claim = await actions.claim(ref, { workerId: 'worker-1', leaseMs: 30_000 });
if (claim) {
  const result = await actions.dispatch(claim, async context => {
    // provider is application-owned. Configure it for one logical operation,
    // without hidden transport retries, and with a suitable request deadline.
    const post = await provider.publish({
      ...context.payload,
      idempotencyKey: context.effectKey,
    });
    // Return applied only after the provider confirms the intended effect.
    return { outcome: 'applied', receipt: { providerId: post.id } };
  });
  if (result.action?.state === 'succeeded') {
    // Application-specific success handling.
  } else {
    // Inspect ready / uncertain / failed and retain the same action reference.
  }
}

// Close the application-owned pool during application shutdown.
await pool.end();
```

The provider key above is a stable action UUID, not the caller's namespace/key. Use it only when the provider supports compatible idempotency semantics. The library cannot extend a provider's retention window or turn a non-idempotent API into an idempotent one. Choose `namespace` to include the actual tenant and target account, and reuse the same action key for redeliveries. Changing keys creates distinct work and bypasses deduplication.

An executable PostgreSQL example is available with `ACTION_LEDGER_EXAMPLE_DATABASE_URL` set to a development database:

```sh
node examples/postgres-worker.js
```

It uses a simulated provider, creates the ledger table if needed, and persists one example action. Re-running it reuses the same action key.

## Failure behavior

| Situation | State / behavior |
|---|---|
| Duplicate immutable input | Existing action is returned |
| Same namespace/key with different kind, payload, or retry limit | Conflict; existing action remains intact |
| Worker dies before persisting dispatch intent | Expired claim can be replaced; stale worker cannot begin |
| Worker dies after persisting dispatch intent | Expired execution becomes `uncertain`; no replacement dispatch |
| Provider applies the action, but response is lost | `uncertain`; no automatic retry |
| Provider times out without applying anything | Still `uncertain`; the library cannot distinguish this from a lost success |
| Dispatch-intent commit acknowledgment is lost | Provider is not called; persisted intent may later become uncertain |
| Provider succeeds but settlement cannot be persisted | Storage error propagates; execution stays blocked or may already be settled |
| Provider definitively rejects with no current or future effect | Retry can become eligible, within the configured bound |
| Paused worker resumes after expiry | Its external call can still happen; its stale ledger settlement is rejected |

`not_applied` is a strong caller assertion, not a classification inferred from HTTP status:

```js
return {
  outcome: 'not_applied',
  reason: 'Provider definitively rejected the operation before accepting work',
  retryable: true,
  retryAfterMs: 5_000,
};
```

It must exclude partial effects, queued jobs, delayed requests, and any future effect from the old attempt. A timeout, aborted request, generic 500 response, or a point-in-time “not found” result does not establish this. If the outcome is unknown, throw; dispatch records uncertainty. Throwing error messages are intentionally not stored because they may contain secrets. Keep diagnostic logs in the application.

Each persisted dispatch intent consumes one attempt. Claims alone do not consume attempts. The default maximum is 3, configurable from 1 to 100. `retryAfterMs` sets the earliest eligibility time, not a timer: the application or workflow engine must invoke `claim` again. Lease duration is 1 ms to 24 hours; there are no heartbeats in this version. Choose a realistic lease plus a provider deadline, while recognizing that a local timeout does not cancel an external effect.

## Resolving uncertainty

After obtaining correlated provider evidence, a trusted application/operator can confirm success:

```js
const action = await actions.get(ref);
const result = await actions.resolve(ref, {
  expectedRevision: action.revision,
  actor: 'operator:123',
  evidence: { source: 'provider-query', providerId: 'post-456' },
  receipt: { providerId: 'post-456' },
});
```

The library records evidence but cannot independently verify it or authorize the actor. Resolution accepts only an uncertain action, including one found expired in that transaction. The revision compares against the record before expiry normalization. Conflicting decisions return `accepted: false`.

This version supports only confirmed-success resolution. It has no negative resolution or force-retry API. This intentionally leaves some uncertain actions blocked until a stronger provider-specific recovery contract is designed. Rejected late receipts are not saved automatically; retain them in application-owned logs when needed.

## Storage and integration boundaries

The PostgreSQL adapter serializes each action using a primary key and a row lock. Action state, claim, attempts, and resolution are one JSONB record, updated in one transaction. It samples the database clock after acquiring the lock. It never holds a database transaction during the provider call and never retries a mutator or an ambiguous commit. The source references for these SQL semantics are PostgreSQL's [locking documentation](https://www.postgresql.org/docs/current/explicit-locking.html) and [clock documentation](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT).

`initialize()` creates `external_action_ledger_v1` in an existing schema (`public` by default). In production, table creation should be an explicit migration step with the appropriate permissions. The caller owns the pool, connection timeouts, and PostgreSQL durability configuration. The prototype assumes normal durable commits; it does not claim safety if acknowledged ledger state is later lost by database rollback, restore, or failover.

Reads are observational. `get` can show an expired `executing` record until `claim`, `dispatch`, or `resolve` normalizes it. There is no background expiration sweeper or discovery/queue API. Keep action references in your application or durable job system.

The library does not yet atomically enqueue with your application's business transaction. It is an action ledger, not a transactional outbox replacement. An application that needs that guarantee must retain its existing durable outbox and redeliver the same reference into this library. Workflow engines should retry the library entry point with the same reference, and never directly replay the provider call outside `dispatch`.

Namespaces scope uniqueness; they provide no tenant authorization or row-level security. Stored payloads and receipts are plaintext JSONB: minimize sensitive data and keep provider credentials out. `Store` and claims are trusted internal APIs, not HTTP endpoints. Restrict direct database and mutation access.

Payload, receipt, and evidence values must be finite, acyclic JSON with plain objects, dense arrays, valid Unicode, and no NUL. Each is limited to 256 KiB and 64 nesting levels. `Date`, `BigInt`, `undefined`, accessors, symbol properties, and non-finite numbers are rejected. Invalid adapter results become uncertain. This record-oriented prototype rewrites attempt history on changes; throughput, pruning, migrations, and large-history performance are not evaluated.

There is no universal exactly-once guarantee. Leases fence ledger ownership, not external requests. Provider-specific adapters must still define reliable success/rejection evidence and compatible idempotency behavior.

## Origin and next gate

This is an independent implementation of generic external-action reliability patterns: persisted dispatch intent, bounded safe retries, claim fencing, and explicit uncertainty. The package contains no product-specific policies, prompts, customer data, or provider integrations.

The release workflow requires the included multi-connection tests against native PostgreSQL to pass. Before production use, validate a real provider adapter and integrate it in a small application. See [VALIDATION.md](VALIDATION.md) for results and limits and [Actions](https://github.com/anatolyben/external-action-ledger/actions) for the exact revision's run. This source is provided under the MIT license.
