/**
 * Minimal stub for cloudflare:workers used in plain vitest/node tests.
 * The real runtime provides these; in node tests we only need type-compatible stubs.
 */

export class WorkflowEntrypoint<_Env = unknown, _Params = unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected env: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected ctx: any;
}
