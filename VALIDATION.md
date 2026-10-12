# Validation record

Checked 2026-10-12 with Node.js 24.19.0.

| Check | Result | Scope |
|---|---|---|
| `npm test` | 28 passed | Lifecycle, failure simulations, real local HTTP socket loss, JSON parity |
| `npm run test:sql` | 11 passed | PGlite SQL execution, rollback, commit-acknowledgment faults, persistence |
| `npm run test:types` | Passed | Public API, invalid calls, actual `pg.Pool` type compatibility |
| `npm run simulate` | 10 completed | In-memory scenarios with externally counted calls/effects |
| `npm pack --dry-run` | Passed | Package source/export inventory |
| Native PostgreSQL | Required GitHub Actions gate | Check the linked workflow run for the exact revision's result |

**39 behavioral/SQL tests passed**, plus type checking. Simulations test modeled failures; they do not prove every failure schedule correct. The HTTP test applies a simulated effect on an actual local HTTP server, destroys its response socket, and checks that the action is not dispatched again.

Native PostgreSQL could not start in the original local environment because only root was mapped. PGlite runs SQL in an embedded instance; it does not establish multi-connection locking or crash durability. GitHub Actions runs the native tests against a disposable PostgreSQL 16 service and gates release creation on their success. [Inspect the workflow run](https://github.com/anatolyben/external-action-ledger/actions) for the revision being evaluated. No production database is used.

## Native gate on a normal development host

Start a disposable database:

```sh
docker run --rm --name action-ledger-test \
  -e POSTGRES_USER=action_test -e POSTGRES_PASSWORD=action_test \
  -e POSTGRES_DB=action_test -p 127.0.0.1:55432:5432 postgres:16
```

In another shell:

```sh
ACTION_LEDGER_TEST_DATABASE_URL=postgresql://action_test:action_test@127.0.0.1:55432/action_test npm run test:postgres
```

The five native tests cover concurrent first insert, rollback, time sampling after a real lock wait, concurrent enqueue/claim/dispatch, and reconciliation races. They create a unique schema and delete only that schema. An interrupted process can leave its test schema behind. Missing configuration fails instead of silently skipping. GitHub Actions provisions PostgreSQL 16 and runs this gate plus `npm run check`.

Before production use, integrate one real provider adapter and evaluate real application behavior. Native concurrency tests do not constitute crash-recovery or failover testing. No load, retention, upgrade, failover, or production-readiness claim is made. There is no scheduling, work discovery, heartbeat, negative reconciliation, authorization, or atomic enqueue with business data in this prototype.
