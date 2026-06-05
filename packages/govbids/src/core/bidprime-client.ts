import { normalizeBidPrimeBid } from "./bidprime-normalizer.js";
import type { NormalizedOpportunity } from "./types.js";

const BIDPRIME_API_BASE = "https://api.bidprime.com/api/rest/v1";

export interface BidPrimeCode {
  type: string;
  code: string;
}

export interface BidPrimeBid {
  inbox: "notifications" | "saved" | "removed";
  id: string;
  title: string | null;
  refnum: string | null;
  entity: string | null;
  region: string | null;
  regionType: "Federal" | "StateLocal" | null;
  issuedAt: string | null;
  expiresAt: string | null;
  notifiedAt: string | null;
  savedAt: string | null;
  description: string | null;
  contact: string | null;
  email: string | null;
  phone: string | null;
  postalCode: string | null;
  codes: BidPrimeCode[];
  bidprimeLink: string | null;
  directLink: string | null;
  publisherLink: string | null;
  documentLink: string | null;
  requestDocumentsLink: string | null;
}

interface BidListResponse {
  items: BidPrimeBid[];
  total: number;
  page: number;
  limit: number;
}

interface BidPrimeClientOptions {
  apiToken: string;
}

interface FetchResult {
  opportunities: NormalizedOpportunity[];
  apiCallsUsed: number;
  total: number;
}

/**
 * Client for BidPrime's REST API.
 *
 * Inbox-based: the API only returns bids that matched the account's
 * saved searches inside BidPrime. No keyword/date filtering at request time —
 * all filtering happens via the saved search config on bidprime.com.
 *
 * Pagination: max 100 per page. List calls don't count toward the daily
 * detail limit; detail/document calls do.
 */
export class BidPrimeClient {
  private readonly apiToken: string;

  constructor(options: BidPrimeClientOptions) {
    this.apiToken = options.apiToken;
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${BIDPRIME_API_BASE}${path}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `BidPrime API ${response.status} ${response.statusText}: ${body.slice(0, 200)}`,
      );
    }
    return (await response.json()) as T;
  }

  /**
   * List all bids in the notifications inbox, paginating until exhausted.
   */
  async fetchAllNotifications(
    pageSize: number = 100,
  ): Promise<FetchResult> {
    const allOpps: NormalizedOpportunity[] = [];
    let apiCallsUsed = 0;
    let page = 1;
    let total = 0;

    while (true) {
      const resp = await this.request<BidListResponse>(
        `/bids?inbox=notifications&page=${page}&limit=${pageSize}&sortField=issuedAt&sortDir=desc`,
      );
      apiCallsUsed++;
      total = resp.total;

      for (const bid of resp.items) {
        allOpps.push(normalizeBidPrimeBid(bid));
      }

      if (resp.items.length < pageSize || allOpps.length >= resp.total) break;
      page++;
    }

    return { opportunities: allOpps, apiCallsUsed, total };
  }
}
