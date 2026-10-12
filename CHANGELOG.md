# Changelog

## 0.1.0 (experimental)

Initial experimental release:

- Five-operation external-action API: enqueue, get, claim, dispatch, resolve.
- PostgreSQL storage with per-action locking and atomic attempt history.
- Persisted dispatch intent, bounded retries for definitive rejection, and explicit uncertainty.
- Stale-claim and stale-settlement rejection; confirmed-success reconciliation.
- Strict JSON validation, TypeScript declarations, and no runtime dependencies.
- Deterministic failure simulations, a real HTTP response-loss test, SQL tests, and a native PostgreSQL concurrency gate.

There is no exactly-once guarantee, automatic retry of uncertain actions, scheduler, or atomic coupling to application business transactions. The release workflow gates tagging on native PostgreSQL tests. Provider-specific validation is still required before production use.
