/**
 * 2captcha client with a hard monthly spend cap.
 *
 * Per BUY-2272 exit criteria: captcha hard-cap enforcement is unit-tested.
 * Cap logic (Day 1) + 2captcha HTTP (Day 4) are both live here.
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

/** How long to wait between polls for the solved token (ms). */
const POLL_INTERVAL_MS = 5_000;
/** How many polls before giving up. 24 × 5s = 2 min total. */
const MAX_POLLS = 24;

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

export class CaptchaProviderError extends Error {
  readonly code = "CAPTCHA_PROVIDER_ERROR";
  constructor(message: string) {
    super(message);
  }
}

export interface CaptchaSolveRequest {
  siteKey: string;
  pageUrl: string;
  kind: "recaptcha_v2" | "recaptcha_v3" | "hcaptcha" | "turnstile";
  /** Caller-estimated cost in USD. Used for the cap check before spending. */
  estimatedCostUsd?: number;
  /** Minimum score for recaptcha_v3 (0.0–1.0). Defaults to 0.3. */
  minScore?: number;
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

const TWOCAPTCHA_BASE = "https://2captcha.com";

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
   * Enforce cap first, then solve via 2captcha. Throws `CaptchaCapExceededError`
   * if this call would put us at-or-above the cap, `CaptchaProviderError` on
   * provider failure.
   */
  async solve(request: CaptchaSolveRequest): Promise<CaptchaSolveResult> {
    const estimated =
      request.estimatedCostUsd ?? PER_SOLVE_COST_USD[request.kind] ?? 0.003;

    const currentSpend = await this.spendStore.getMonthlySpendUsd();
    if (currentSpend + estimated > this.monthlyCapUsd) {
      throw new CaptchaCapExceededError(currentSpend, this.monthlyCapUsd);
    }

    const token = await this.submitToProvider(request);
    // Record spend only after a successful solve — provider errors don't cost.
    await this.spendStore.addSpendUsd(estimated);
    return { token, costUsd: estimated };
  }

  private async submitToProvider(request: CaptchaSolveRequest): Promise<string> {
    const taskId = await this.createTask(request);
    return this.pollForResult(taskId);
  }

  /**
   * POST /in.php — submit the captcha task and return the task ID.
   */
  private async createTask(request: CaptchaSolveRequest): Promise<string> {
    const params = new URLSearchParams({
      key: this.apiKey,
      pageurl: request.pageUrl,
      googlekey: request.siteKey,
      json: "1",
    });

    switch (request.kind) {
      case "recaptcha_v2":
        params.set("method", "userrecaptcha");
        break;
      case "recaptcha_v3":
        params.set("method", "userrecaptcha");
        params.set("version", "v3");
        params.set("min_score", String(request.minScore ?? 0.3));
        break;
      case "hcaptcha":
        params.set("method", "hcaptcha");
        break;
      case "turnstile":
        params.set("method", "turnstile");
        break;
    }

    const resp = await this.fetchImpl(`${TWOCAPTCHA_BASE}/in.php`, {
      method: "POST",
      body: params,
    });

    if (!resp.ok) {
      throw new CaptchaProviderError(`2captcha /in.php HTTP ${resp.status}`);
    }

    const body = (await resp.json()) as { status: number; request: string };
    if (body.status !== 1) {
      throw new CaptchaProviderError(`2captcha /in.php error: ${body.request}`);
    }

    return body.request; // task ID
  }

  /**
   * Poll /res.php until the token is ready or MAX_POLLS is reached.
   */
  private async pollForResult(taskId: string): Promise<string> {
    const params = new URLSearchParams({
      key: this.apiKey,
      action: "get",
      id: taskId,
      json: "1",
    });
    const url = `${TWOCAPTCHA_BASE}/res.php?${params.toString()}`;

    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      // 2captcha recommends waiting at least 5s before first poll
      await sleep(POLL_INTERVAL_MS);

      const resp = await this.fetchImpl(url);
      if (!resp.ok) {
        throw new CaptchaProviderError(`2captcha /res.php HTTP ${resp.status}`);
      }

      const body = (await resp.json()) as { status: number; request: string };

      if (body.status === 1) {
        return body.request; // solved token
      }

      if (body.request !== "CAPCHA_NOT_READY") {
        throw new CaptchaProviderError(`2captcha /res.php error: ${body.request}`);
      }
      // CAPCHA_NOT_READY → keep polling
    }

    throw new CaptchaProviderError(
      `2captcha solve timed out after ${MAX_POLLS * POLL_INTERVAL_MS / 1000}s`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
