export class TranscriptSequence {
  observed = 0;
  persisted = 0;
  missingThrough = 0;

  observe(seq: number | undefined): boolean {
    if (seq === undefined) return false;
    if (seq > this.observed + 1) this.missingThrough = Math.max(this.missingThrough, seq - 1);
    this.observed = Math.max(this.observed, seq);
    return this.needsCatchup;
  }

  confirm(seq: number | undefined): void {
    if (seq === undefined) return;
    this.persisted = Math.max(this.persisted, seq);
    this.observed = Math.max(this.observed, seq);
  }

  requireHistory(seq: number | undefined): void {
    if (seq !== undefined) this.missingThrough = Math.max(this.missingThrough, seq);
  }

  get needsCatchup(): boolean {
    return this.missingThrough > this.persisted;
  }
}
