import type { Socket } from "node:net";
import type { ClientHttp2Session } from "node:http2";
import type { ClientRequest } from "node:http";

// Exact resources reported by the opt-in grpc1.14.5 delivery patch. No global
// socket interception, recurring timer, activity inference or destroyed flag.
type Resource = Socket | ClientHttp2Session | ClientRequest;
type Entry = { closed: Promise<void>; resolve(): void; onClose(): void; observed: boolean };
export class PhotonTransportResources {
  private readonly abort = new AbortController();
  private readonly entries = new WeakMap<Resource, Entry>();
  private readonly resources = new Map<Resource, Entry>();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly disposalErrors = new Map<Resource, unknown>();
  private attempt?: Promise<void>;
  private joined = false;
  readonly signal = this.abort.signal;
  readonly pending = (operation: Promise<unknown>): void => {
    this.operations.add(operation);
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
  };
  readonly socket = (socket: Socket): void => { this.observe(socket); };
  readonly session = (session: ClientHttp2Session): void => { this.observe(session); };
  readonly request = (request: ClientRequest): void => { this.observe(request); };
  private observe(resource: Resource): void {
    let entry = this.entries.get(resource);
    if (!entry) {
      let resolve!: () => void;
      const closed = new Promise<void>(done => { resolve = done; });
      entry = { closed, resolve, observed: false, onClose: () => {} };
      const current = entry;
      current.onClose = () => {
        current.observed = true;
        this.resources.delete(resource);
        this.disposalErrors.delete(resource);
        current.resolve();
      };
      this.entries.set(resource, current);
      this.resources.set(resource, current);
    }
    // grpc's normal CONNECT/remoteSettings transitions remove listeners. The
    // delivered hook reports that SAME object again in the same synchronous
    // transition. Reinstall the same observer; do not replace its receipt.
    if (!entry.observed && !resource.listeners("close").includes(entry.onClose)) resource.once("close", entry.onClose);
    if (this.signal.aborted && !entry.observed) this.destroy(resource);
  }
  private destroy(resource: Resource): void {
    try { resource.destroy(); this.disposalErrors.delete(resource); }
    catch (error) { this.disposalErrors.set(resource, error); }
  }
  beginClose(): void {
    this.abort.abort();
  }
  close(): Promise<void> {
    if (this.joined) return Promise.resolve();
    if (this.attempt) return this.attempt;
    const attempt = this.closeOwned(); this.attempt = attempt;
    void attempt.then(() => { this.joined = true; }, () => { if (this.attempt === attempt) this.attempt = undefined; });
    return attempt;
  }
  private async closeOwned(): Promise<void> {
    this.beginClose();
    for (const [resource, entry] of this.resources) if (!entry.observed) this.destroy(resource);
    // A synchronous destroy refusal is real retryable debt. Do not wait forever
    // on the resource that refused disposal or discard any of its identity.
    if (this.disposalErrors.size) throw new AggregateError([...this.disposalErrors.values()], "Photon transport disposal remains incomplete");
    // Every allocation after an await checks this same aborted signal. A late
    // resource is observed and destroyed before its connect promise settles.
    while (this.operations.size) {
      await Promise.allSettled([...this.operations]);
      if (this.disposalErrors.size) throw new AggregateError([...this.disposalErrors.values()], "Photon late transport disposal remains incomplete");
    }
    await Promise.all([...this.resources.values()].map(entry => entry.closed));
    if (this.disposalErrors.size) throw new AggregateError([...this.disposalErrors.values()], "Photon transport join remains incomplete");
  }
}
