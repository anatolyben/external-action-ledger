# A lost response does not mean a failed action

A runnable demonstration of **external-action-ledger 0.1.0**, an experimental library for tracking external actions. It has five operations: `enqueue`, `get`, `claim`, `dispatch`, and `resolve`, with memory and PostgreSQL storage implementations.

This companion demo imports the versioned package from its GitHub release. It contains no copied library implementation. The [source repository](https://github.com/anatolyben/external-action-ledger) maintains the implementation, broader failure simulations, database tests, and [validation record](https://github.com/anatolyben/external-action-ledger/blob/main/VALIDATION.md).

## Run

With Node.js 22 or later, download and extract the [companion demo](https://github.com/anatolyben/external-action-ledger/releases/download/v0.1.0/external-action-ledger-demo-0.1.0.zip), or put all the gist files into one directory:

```sh
npm install
npm test
npm start
```

The dependency is pinned to the `0.1.0` tarball attached to the [GitHub release](https://github.com/anatolyben/external-action-ledger/releases/tag/v0.1.0). npm registry publication is separate and is not required to run this demo.

## What happens

1. A simulated provider creates a post, then loses the response.
2. The ledger records `uncertain` because the caller cannot know whether it worked.
3. Another client tries again after the lease expires. The ledger refuses the claim, so the provider receives no second request.
4. An independent provider lookup confirms the post exists. The application records that evidence with `resolve`, which changes the ledger state to `succeeded` without sending another request.

Expected observations:

| Observation | Result |
| --- | --- |
| State after response loss | `uncertain` |
| Retry allowed after lease expiry | `false` |
| Resolution accepted | `true` |
| Final state | `succeeded` |
| Provider calls / effects | `1 / 1` |

The provider deliberately has no deduplication. An unsafe repeat would create a second effect and fail the tests. Three tests assert the observable behavior using the installed package's public API.

## PostgreSQL in an application

Install `pg` alongside the library and supply your own pool:

```js
import pg from 'pg';
import { createActionLedger } from 'external-action-ledger';
import { createPostgresStore } from 'external-action-ledger/postgres';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const store = createPostgresStore(pool);
await store.initialize(); // Explicit database setup; requires table creation rights.
const actions = createActionLedger({ store });
// Use actions in your application; close the pool during shutdown.
```

## Limits

This demo uses an in-memory store and a simulated provider. Creating another client reuses the same store; it does not test process restarts, disk durability, or PostgreSQL concurrency. See the full source project's validation record for separately executed tests.

Leases fence ledger writes, not external requests. They cannot stop a paused process from sending later. There is no exactly-once guarantee. Applications own authorization, evidence verification, work discovery, and scheduling. A provider adapter must make one logical operation with hidden retries disabled. Only affirmative evidence resolves an uncertain action in this version; a missing provider lookup is not proof that retrying is safe.

This is an experimental `0.1.0` API, not a production-readiness claim. MIT license.

## Related example

[Lowercasing doesn't catch lookalike usernames](https://gist.github.com/anatolyben/f326542a92a47fea8db2d2f3419ff25c) demonstrates JavaScript confusable folding and its false-positive tradeoffs.
