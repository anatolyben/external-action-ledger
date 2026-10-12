export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ActionRef { namespace: string; key: string }
export type ActionState = 'ready' | 'claimed' | 'executing' | 'succeeded' | 'failed' | 'uncertain';
export interface StoredClaim { token: string; attemptId: string; workerId: string; expiresAt: number }
export interface Claim extends ActionRef, StoredClaim { revision: number }
export interface Attempt {
  id: string;
  number: number;
  workerId: string;
  startedAt: number;
  finishedAt: number | null;
  outcome: 'applied' | 'not_applied' | 'unknown' | null;
  reason: string | null;
  receipt: Json;
}
export interface Resolution {
  actor: string;
  evidence: { [key: string]: Json };
  receipt: Json;
  resolvedAt: number;
  attemptId: string;
}
export interface ActionRecord extends ActionRef {
  id: string;
  kind: string;
  payload: Json;
  maxAttempts: number;
  state: ActionState;
  revision: number;
  createdAt: number;
  updatedAt: number;
  availableAt: number;
  claim: StoredClaim | null;
  attempts: Attempt[];
  resolution: Resolution | null;
}
export interface StoreMutation<T> { record: ActionRecord | null; result: T }
/** Mutators must be synchronous and execute once under a per-action lock. */
export interface Store {
  read(ref: ActionRef): Promise<ActionRecord | null>;
  transact<T>(ref: ActionRef, mutator: (record: ActionRecord | null, nowMs: number) => StoreMutation<T>): Promise<T>;
}
export interface EnqueueInput extends ActionRef { kind: string; payload: Json; maxAttempts?: number }
export interface ClaimOptions { workerId: string; leaseMs: number }
export interface AdapterContext extends ActionRef {
  actionId: string;
  kind: string;
  payload: Json;
  /** Stable action ID. Mapping to provider idempotency is caller-owned. */
  effectKey: string;
  attemptId: string;
  attemptNumber: number;
  workerId: string;
  leaseExpiresAt: number;
}
export type AdapterOutcome =
  | { outcome: 'applied'; receipt: Json }
  /** Asserts no current, partial, delayed, or future effect from this attempt. */
  | { outcome: 'not_applied'; reason: string; retryable: boolean; retryAfterMs?: number };
export type Adapter = (context: AdapterContext) => AdapterOutcome | Promise<AdapterOutcome>;
export interface Decision { accepted: boolean; action: ActionRecord | null }
export interface ResolveOptions {
  expectedRevision: number;
  actor: string;
  evidence: { [key: string]: Json };
  receipt: Json;
  outcome?: 'applied';
}
export interface ActionLedger {
  enqueue(input: EnqueueInput): Promise<ActionRecord>;
  /** Observational read; expired states are normalized by mutations. */
  get(ref: ActionRef): Promise<ActionRecord | null>;
  claim(ref: ActionRef, options: ClaimOptions): Promise<Claim | null>;
  /** accepted reports whether settlement was persisted, not whether the provider applied. */
  dispatch(claim: Claim, adapter: Adapter): Promise<Decision>;
  /** Confirms success only. Does not reopen or retry uncertainty. */
  resolve(ref: ActionRef, options: ResolveOptions): Promise<Decision>;
}
export class ConflictError extends Error { readonly code: 'ACTION_CONFLICT' }
export function createActionLedger(options: { store: Store }): ActionLedger;
/** Non-durable reference store for tests and simulations. */
export function createMemoryStore(options?: { clock?: () => number }): Store;
