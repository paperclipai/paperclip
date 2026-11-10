import { registerIdleLocalWorkProbe } from "../idle-local-work.js";

/** Unary useful work owns its actual channel until close resolves. There is no
 * keepalive, idle timeout or new poller. Failed close retains the same resource
 * and blocks the next operation until its normal retry actually closes it. */
export class PhotonUsefulClient<T extends { close(): Promise<void> | void }> {
  private client?: T;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private failed = false;
  private unrecordedDebt = false;
  private stopped = false;
  private readonly unregister: () => void;
  constructor(private readonly create: () => T, initial?: T, private readonly recordDebt: () => Promise<void> = async () => {}) {
    this.client = initial;
    this.unregister = registerIdleLocalWorkProbe(() => this.failed || this.unrecordedDebt ? "unknown" : this.pending || this.client ? "present" : "none");
  }
  private async closeCurrent() {
    const client = this.client;
    if (!client) {
      if (this.unrecordedDebt) { await this.recordDebt(); this.unrecordedDebt = false; }
      return;
    }
    try { await client.close(); this.client = undefined; this.failed = false; }
    catch (error) {
      this.failed = true; this.unrecordedDebt = true;
      try { await this.recordDebt(); this.unrecordedDebt = false; } catch { /* Exact resource stays owned and the probe remains unknown. */ }
      throw error;
    }
    if (this.unrecordedDebt) { await this.recordDebt(); this.unrecordedDebt = false; }
  }
  private enqueue<R>(action: () => Promise<R>): Promise<R> {
    this.pending += 1;
    const result = this.tail.then(action);
    this.tail = result.then(() => undefined, () => undefined);
    void this.tail.then(() => { this.pending -= 1; });
    return result;
  }
  run<R>(action: (client: T) => Promise<R>): Promise<R> {
    return this.enqueue(async () => {
      if (this.stopped) throw new Error("Photon useful client is stopped");
      await this.closeCurrent();
      const client = this.create(); this.client = client;
      let value: R;
      try { value = await action(client); }
      catch (primary) {
        try { await this.closeCurrent(); } catch (cleanup) { throw new AggregateError([primary, cleanup], "Photon useful operation and close failed"); }
        throw primary;
      }
      // The provider result is already known. Preserve it for the caller's
      // ordinary durable receipt commit; cleanup failure is separately owned.
      try { await this.closeCurrent(); } catch { /* Retained exact resource/debt, never a second provider invocation. */ }
      return value;
    });
  }
  drain(): Promise<void> { return this.enqueue(() => this.closeCurrent()); }
  close(): Promise<void> {
    this.stopped = true;
    return this.enqueue(async () => { await this.closeCurrent(); this.unregister(); });
  }
}
