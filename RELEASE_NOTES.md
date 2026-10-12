# External Action Ledger 0.1.0 (experimental)

A small JavaScript/TypeScript library for tracking external actions from an application or workflow engine.

- Five operations: enqueue, get, claim, dispatch, resolve.
- PostgreSQL persistence with atomic attempt history and worker ownership checks.
- Dispatch intent recorded before the provider call.
- Bounded retries only for definitive no-effect rejection; explicit uncertainty otherwise.
- Confirmed-success reconciliation and stale-worker protection.
- Failure simulations, HTTP response-loss testing, strict JSON validation, and native PostgreSQL concurrency tests.

This release is experimental. It does not guarantee exactly-once external effects and does not include a scheduler, provider-specific adapters, or atomic enqueue with application business transactions.

The release workflow requires the behavioral/SQL tests, TypeScript checks, and native PostgreSQL tests to pass before creating this tag. Consult the linked workflow run for observed results.

The attached `.tgz` is the installable library package. The companion demo imports that package and demonstrates one applied effect, response loss, a blocked retry, and evidence-based success. npm registry publication is a separate step and is not implied by this GitHub release.
