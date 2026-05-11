import {
  HIGHERGOV_API_BASE_URL,
  DEFAULT_PAGE_SIZE,
  NAICS_CODES,
  NAICS_CODES_EXTENDED,
} from "./constants.js";
import { normalizeOpportunity } from "./normalizer.js";
import type {
  HigherGovOpportunity,
  HigherGovSearchParams,
  NormalizedOpportunity,
} from "./types.js";

interface HigherGovClientOptions {
  apiKey: string;
  baseUrl?: string;
}

interface FetchAllParams {
  capturedAfter?: string;
  dueDateAfter?: string;
  dueDateBefore?: string;
  maxRecords?: number;
  useExtendedNaics?: boolean;
}

interface FetchAllResult {
  opportunities: NormalizedOpportunity[];
  apiCallsUsed: number;
}

/**
 * Default captured_date: 7 days ago (required by HigherGov API).
 */
function defaultCapturedDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}

/**
 * Robust, quota-aware HTTP client for the HigherGov API.
 */
export class HigherGovClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: HigherGovClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? HIGHERGOV_API_BASE_URL;
  }

  /**
   * Search for state & local contract opportunities with given parameters.
   * Returns raw API responses.
   */
  async searchOpportunities(
    params: HigherGovSearchParams,
  ): Promise<{ results: HigherGovOpportunity[]; apiCallsUsed: number }> {
    const queryParams: Record<string, string> = {
      api_key: this.apiKey,
      page_size: String(params.pageSize ?? DEFAULT_PAGE_SIZE),
    };

    if (params.page) queryParams.page = String(params.page);
    if (params.keywords) queryParams.keywords = params.keywords;
    // API only accepts a single NAICS code per request
    if (params.naics?.length) queryParams.naics_code = params.naics[0];
    if (params.psc?.length) queryParams.psc_code = params.psc[0];
    if (params.minValue) queryParams.val_est_low = String(params.minValue);
    if (params.maxValue) queryParams.val_est_high = String(params.maxValue);
    if (params.dueDateAfter) queryParams.due_date_after = params.dueDateAfter;
    if (params.dueDateBefore) queryParams.due_date_before = params.dueDateBefore;
    // captured_date is REQUIRED by the API
    queryParams.captured_date = params.capturedAfter ?? defaultCapturedDate();
    if (params.opportunityType) queryParams.opportunity_type = params.opportunityType;
    if (params.sourceType) queryParams.source_type = params.sourceType;

    const results = await this.request<{ results: HigherGovOpportunity[] }>(
      "/opportunity/",
      queryParams,
    );

    return {
      results: results.results ?? [],
      apiCallsUsed: 1,
    };
  }

  /**
   * Fetch opportunities by NAICS code — one search per NAICS code.
   * This is much more precise than keyword search since the HigherGov keyword
   * matching is very broad and returns mostly irrelevant results.
   * Deduplicates across searches by opp_key.
   */
  async fetchAllKeywordSearches(
    params: FetchAllParams = {},
  ): Promise<FetchAllResult> {
    const seen = new Map<string, NormalizedOpportunity>();
    let apiCallsUsed = 0;
    const maxRecords = params.maxRecords ?? 500;

    // Search by NAICS code (one per request — API limitation)
    const naicsList = params.useExtendedNaics ? NAICS_CODES_EXTENDED : NAICS_CODES;
    for (const naicsCode of naicsList) {
      const searchParams: HigherGovSearchParams = {
        naics: [naicsCode],
        capturedAfter: params.capturedAfter ?? undefined,
        dueDateAfter: params.dueDateAfter ?? undefined,
        dueDateBefore: params.dueDateBefore ?? undefined,
        pageSize: DEFAULT_PAGE_SIZE,
      };

      let page = 1;
      let hasMore = true;

      while (hasMore) {
        searchParams.page = page;
        const result = await this.searchOpportunities(searchParams);
        apiCallsUsed += result.apiCallsUsed;

        for (const raw of result.results) {
          if (!seen.has(raw.opp_key)) {
            seen.set(raw.opp_key, normalizeOpportunity(raw));
          }
        }

        hasMore = result.results.length === DEFAULT_PAGE_SIZE;
        page++;

        if (seen.size >= maxRecords) {
          hasMore = false;
        }
      }

      console.log(`  NAICS ${naicsCode}: ${seen.size} total (${apiCallsUsed} API calls)`);
    }

    return {
      opportunities: Array.from(seen.values()),
      apiCallsUsed,
    };
  }

  private async request<T>(
    endpoint: string,
    params: Record<string, string>,
  ): Promise<T> {
    const base = this.baseUrl.endsWith("/") ? this.baseUrl : this.baseUrl + "/";
    const path = endpoint.startsWith("/") ? endpoint.slice(1) : endpoint;
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await fetch(url.toString(), { signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok) {
          throw new Error(
            `HigherGov API error: ${response.status} ${response.statusText}`,
          );
        }
        return (await response.json()) as T;
      } catch (error) {
        clearTimeout(timeout);
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }

    throw lastError;
  }
}
