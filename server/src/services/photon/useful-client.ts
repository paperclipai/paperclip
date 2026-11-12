import { registerIdleLocalWorkProbe } from "../idle-local-work.js";

export type PhotonUsefulCloseReceipt = () => Promise<void | "obsolete">;

/** Unary useful work owns its actual channel until close resolves. There is no
 * keepalive, idle timeout or new poller. Failed close retains the same resource
 * and blocks the next operation until its normal retry actually closes it. */
export class PhotonUsefulClient<T extends { close(): Promise<void> | void }> {
  private client?: T;
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private failed = false;
  private unrecordedDebt = false;
  private closeReceipt?: PhotonUsefulCloseReceipt;
  private stopped = false;
  private readonly unregister: () => void;
  constructor(private readonly create: () => T, initial?: T, private readonly recordDebt: () => Promise<void> = async () => {}) {
    this.client = initial;
    this.unregister = registerIdleLocalWorkProbe(() => this.failed || this.unrecordedDebt || this.closeReceipt ? "unknown" : this.pending || this.client ? "present" : "none");
  }
  private async closeCurrent(afterClose?: PhotonUsefulCloseReceipt) {
    const client = this.client;
    if (client) {
      try { await client.close(); this.client = undefined; this.failed = false; }
      catch (error) {
        this.failed = true; this.unrecordedDebt = true;
        try { await this.recordDebt(); this.unrecordedDebt = false; } catch { /* Exact resource stays owned and the probe remains unknown. */ }
        throw error;
      }
    }
    // The exact cleanup receipt substitutes for recording debt after an actual
    // successful close. A failed receipt stays pending and is not a close error.
    if (afterClose) this.closeReceipt = afterClose;
    const receipt = this.closeReceipt;
    if (receipt) {
      const outcome = await receipt();
      if (this.closeReceipt === receipt) this.closeReceipt = undefined;
      this.unrecordedDebt = false;
      if (outcome === "obsolete") this.stopped = true;
    } else if (this.unrecordedDebt) { await this.recordDebt(); this.unrecordedDebt = false; }
  }
  hasUnrecordedCleanupDebt(): boolean { return this.unrecordedDebt || !!this.closeReceipt; }
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
      if (this.stopped) throw new Error("Photon useful client is stopped");
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
  drain(afterClose?: PhotonUsefulCloseReceipt): Promise<void> { return this.enqueue(() => this.closeCurrent(afterClose)); }
  close(): Promise<void> {
    this.stopped = true;
    return this.enqueue(async () => { await this.closeCurrent(); this.unregister(); });
  }
}
