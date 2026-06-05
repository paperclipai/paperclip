import { normalizeRfpMartOpportunity } from "./rfpmart-normalizer.js";
import type { NormalizedOpportunity } from "./types.js";

/**
 * RFPMart category IDs relevant to ConsultAdd's IT services.
 */
const IT_CATEGORY_IDS = [
  "1",  // Web Design and Development
  "7",  // Software, System and Application
  "26", // Networking Services and Supplies
  "34", // Professional, Consulting, Administrative or Management Support Services
  "37", // IT Services (Computer Maintenance and Technical Services)
  "38", // Data Research and Analytics
  "39", // Staffing Services
  "40", // Mobile Application Development
  "89", // Artificial Intelligence and Machine Learning
];

/** US country ID in RFPMart */
const US_COUNTRY_ID = "2";

const RFPMART_API_BASE = "https://api.rfpmartllc.com/index.php";

interface RfpMartClientOptions {
  customerId: string;
}

interface RfpMartRawOpportunity {
  rfpmart_rfp_id: string;
  rfpmart_title: string;
  rfpmart_budget: string;
  rfpmart_budget_2: string;
  rfpmart_scope_1: string;
  rfpmart_scope_2: string;
  rfpmart_rfp_eligibility: string;
  rfpmart_rfp_performance: string;
  rfpmart_link: string;
  rfpmart_rfp_doc_link: string;
  rfpmart_rfp_pub_url: string;
  rfpmart_rfp_date: string;
  rfpmart_rfp_deadline: string;
  rfpmart_preproposal_date: string;
  rfpmart_question_answer_date: string;
  rfpmart_country: string;
  rfpmart_state: string;
  rfpmart_category: string;
  rfpmart_rfp_type: string;
  rfpmart_rfp_set_aside: string;
  govt_agency_type: string;
  [key: string]: unknown;
}

export type { RfpMartRawOpportunity };

interface FetchResult {
  opportunities: NormalizedOpportunity[];
  apiCallsUsed: number;
}

/**
 * Format date as DD-MM-YY for RFPMart API (they use 2-digit year).
 */
function formatDate(date: Date): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yy = String(date.getFullYear()).slice(2);
  return `${yy}-${mm}-${dd}`;
}

/**
 * Client for the RFPMart API.
 *
 * Constraints:
 * - 50 API requests/day
 * - Max 7 consecutive days per request
 * - No data older than 30 days
 */
export class RfpMartClient {
  private readonly customerId: string;

  constructor(options: RfpMartClientOptions) {
    this.customerId = options.customerId;
  }

  /**
   * Fetch US RFPs for a date range (max 7 days).
   */
  async fetchByDateRange(
    fromDate: Date,
    toDate: Date,
  ): Promise<FetchResult> {
    const from = formatDate(fromDate);
    const to = formatDate(toDate);

    const url = `${RFPMART_API_BASE}?customer_id=${this.customerId}&from_date=${from}&to_date=${to}&rfpmart_country=${US_COUNTRY_ID}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`RFPMart API error: ${response.status} ${response.statusText}`);
    }

    const raw = (await response.json()) as RfpMartRawOpportunity[];
    if (!Array.isArray(raw)) {
      return { opportunities: [], apiCallsUsed: 1 };
    }

    // Filter to IT-relevant categories
    const itOnly = raw.filter((r) => IT_CATEGORY_IDS.includes(r.rfpmart_category));

    const opportunities = itOnly.map(normalizeRfpMartOpportunity);

    return { opportunities, apiCallsUsed: 1 };
  }

  /**
   * Fetch the last N days of US IT RFPs, respecting the 7-day window limit.
   * Splits into multiple requests if needed.
   */
  async fetchRecentDays(days: number = 7): Promise<FetchResult> {
    const allOpps: NormalizedOpportunity[] = [];
    let apiCallsUsed = 0;

    // Cap at 30 days (API limit)
    const effectiveDays = Math.min(days, 30);

    // Split into 7-day chunks
    const today = new Date();
    let endDate = new Date(today);
    let remaining = effectiveDays;

    while (remaining > 0) {
      const chunkDays = Math.min(remaining, 7);
      const startDate = new Date(endDate);
      startDate.setDate(startDate.getDate() - chunkDays + 1);

      console.log(`  RFPMart: fetching ${formatDate(startDate)} to ${formatDate(endDate)}...`);

      try {
        const { opportunities, apiCallsUsed: calls } =
          await this.fetchByDateRange(startDate, endDate);
        allOpps.push(...opportunities);
        apiCallsUsed += calls;
        console.log(`    Found ${opportunities.length} IT opportunities`);
      } catch (error) {
        console.log(`    Error: ${error instanceof Error ? error.message : String(error)}`);
      }

      // Move window back
      endDate = new Date(startDate);
      endDate.setDate(endDate.getDate() - 1);
      remaining -= chunkDays;

      // Rate limit: brief pause between requests
      if (remaining > 0) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    return { opportunities: allOpps, apiCallsUsed };
  }
}
