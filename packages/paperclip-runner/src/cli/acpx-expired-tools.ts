export class ExpiredAcpxTools {
  readonly #outstanding = new Set<string>();
  readonly #receipts = new Set<string>();

  assertCapacity(activeCalls: number): void {
    if (this.#outstanding.size + activeCalls >= 4_096) {
      throw new Error("ACPX unsettled tool limit reached");
    }
  }

  remember(callId: string, turnId: string): void {
    this.#outstanding.add(JSON.stringify([turnId, callId]));
  }

  acknowledge(callId: string, turnId: string): boolean {
    const key = JSON.stringify([turnId, callId]);
    if (!this.#outstanding.delete(key)) return this.#receipts.has(key);
    this.#receipts.add(key);
    if (this.#receipts.size > 512) this.#receipts.delete(this.#receipts.values().next().value!);
    return true;
  }
}
