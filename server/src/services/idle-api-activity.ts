/** Authenticated API use is real activity; rejecting an unknown key is not. */
export class IdleApiActivity {
  private until = 0;
  constructor(private readonly now: () => number = () => performance.now()) {}
  record(): void {
    this.until = Math.max(this.until, this.now() + 10 * 60_000);
  }
  active(): boolean {
    return this.now() < this.until;
  }
}
export const idleApiActivity = new IdleApiActivity();
