/**
 * 2captcha client with a hard monthly spend cap.
 *
 * Per BUY-2272 exit criteria: captcha hard-cap enforcement is unit-tested.
 * Week 1 lands the cap logic; Day 4 wires the actual 2captcha HTTP calls.
 */

export interface CaptchaSpendStore {
  /** Returns USD spent this calendar month. */
  getMonthlySpendUsd(): Promise<number>;
  /** Atomically add `deltaUsd` to the monthly spend counter. */
  addSpendUsd(deltaUsd: number): Promise<void>;
}

export interface CaptchaClientOptions {
  apiKey: string;
  monthlyCapUsd?: number;
  spendStore: CaptchaSpendStore;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_MONTHLY_CAP_USD = 20;

export class CaptchaCapExceededError extends Error {
  readonly code = "CAPTCHA_CAP_EXCEEDED";
  constructor(
    readonly monthlySpendUsd: number,
    readonly monthlyCapUsd: number,
  ) {
    super(
      `captcha monthly cap exceeded: spent $${monthlySpendUsd.toFixed(2)} of $${monthlyCapUsd.toFixed(2)}`,
    );
  }
}

export interface CaptchaSolveRequest {
  siteKey: string;
  pageUrl: string;
  kind: "recaptcha_v2" | "recaptcha_v3" | "hcaptcha" | "turnstile";
  /** Caller-estimated cost in USD. Used for the cap check before spending. */
  estimatedCostUsd?: number;
}

export interface CaptchaSolveResult {
  token: string;
  costUsd: number;
}

const PER_SOLVE_COST_USD: Record<CaptchaSolveRequest["kind"], number> = {
  recaptcha_v2: 0.003,
  recaptcha_v3: 0.003,
  hcaptcha: 0.003,
  turnstile: 0.0015,
};

export class CaptchaClient {
  private readonly apiKey: string;
  private readonly monthlyCapUsd: number;
  private readonly spendStore: CaptchaSpendStore;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CaptchaClientOptions) {
    this.apiKey = opts.apiKey;
    this.monthlyCapUsd = opts.monthlyCapUsd ?? DEFAULT_MONTHLY_CAP_USD;
    this.spendStore = opts.spendStore;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Enforce cap first, then attempt to solve. Throws `CaptchaCapExceededError`
   * if this call would put us at-or-above the cap.
   */
  async solve(request: CaptchaSolveRequest): Promise<CaptchaSolveResult> {
    const estimated =
      request.estimatedCostUsd ?? PER_SOLVE_COST_USD[request.kind] ?? 0.003;

    const currentSpend = await this.spendStore.getMonthlySpendUsd();
    if (currentSpend + estimated > this.monthlyCapUsd) {
      throw new CaptchaCapExceededError(currentSpend, this.monthlyCapUsd);
    }

    // Day 4 will wire 2captcha HTTP. Skeleton returns a placeholder result and
    // records the spend so the cap logic is testable end-to-end today.
    const token = await this.submitToProvider(request);
    await this.spendStore.addSpendUsd(estimated);
    return { token, costUsd: estimated };
  }

  private async submitToProvider(_request: CaptchaSolveRequest): Promise<string> {
    // TODO(Day 4): POST https://2captcha.com/in.php, poll /res.php.
    // Using `this.apiKey` + `this.fetchImpl`. Throws on provider error.
    void this.apiKey;
    void this.fetchImpl;
    throw new Error("captcha submitToProvider not implemented — Day 4");
  }
}
