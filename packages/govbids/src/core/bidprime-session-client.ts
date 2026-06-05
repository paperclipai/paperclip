import { normalizeBidPrimeV2Bid } from "./bidprime-session-normalizer.js";
import type { BidPrimeSession } from "./bidprime-session.js";
import type { NormalizedOpportunity } from "./types.js";

const BASE = "https://www.bidprime.com";

const LIST_PATH = "/api/v2/inbox/bid/list";
const DETAIL_PATH = (uuid: string) => `/api/v2/bid/get?uuid=${uuid}`;
const DOC_DOWNLOAD_PATH = (bidId: string) =>
  `/api/v2/document/download/zip?bidId=${bidId}`;

export interface BidPrimeV2Code {
  type: string;
  code: string;
}

export interface BidPrimeV2Document {
  id: string | number;
  name: string | null;
  filename: string | null;
  contentType: string | null;
  contentLength: number | null;
  link: string | null;
  matchedPages: unknown[];
}

export interface BidPrimeV2Bid {
  uuid: string;
  refnum: string | null;
  title: string | null;
  description: string | null;
  entity: string | null;
  link: string | null;
  issueDate: string | null;
  expireDate: string | null;
  opportunityDates: unknown;
  region?: string | null;
  regionId: number | string | null;
  regionType: string | null;
  postal: string | null;
  estimate: string | number | null;
  industryId: number | string | null;
  flag: unknown;
  setaside: unknown;
  contact: unknown;
  publisher: unknown;
  documents: BidPrimeV2Document[];
  codes: BidPrimeV2Code[];
  inboxes: unknown;
  notes: unknown;
  matchedWords: string[];
  matchedSnippets: unknown[];
  matchedQueries: unknown[];
  metadata: Record<string, unknown>;
}

export interface BidPrimeV2ListResponse {
  items?: BidPrimeV2Bid[];
  bids?: BidPrimeV2Bid[];
  results?: BidPrimeV2Bid[];
  total?: number;
  page?: number;
  limit?: number;
  [key: string]: unknown;
}

interface FetchResult {
  opportunities: NormalizedOpportunity[];
  apiCallsUsed: number;
  total: number;
}

interface BidPrimeSessionClientOptions {
  session: BidPrimeSession;
  /** BidPrime user ID (numeric). Visible in /api/v2/alerts/list under each alert's userIds[]. */
  userId: number;
}

interface InboxListBody {
  page: number;
  pageSize: number;
  sort: string;
  filter: string;
  userId: number;
  inbox: "notifications" | "saved" | "removed";
}

interface InboxListResponse {
  items: BidPrimeV2Bid[];
  total: number;
}

/**
 * Session-cookie based client for the BidPrime internal v2 API.
 *
 * Uses the same endpoints the React web app calls — authenticated via
 * the session cookie copied from a logged-in browser. Bypasses the
 * $3,500/yr public REST API tier and its Docs on Demand quota.
 *
 * Trade-offs documented in packages/govbids/docs/bidprime-session.md.
 */
export class BidPrimeSessionClient {
  private readonly session: BidPrimeSession;
  private readonly userId: number;

  constructor(options: BidPrimeSessionClientOptions) {
    this.session = options.session;
    this.userId = options.userId;
  }

  private headers(): HeadersInit {
    return {
      Cookie: this.session.cookieHeader,
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
      Origin: BASE,
    };
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${BASE}${path}`, {
      headers: this.headers(),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `BidPrime ${response.status} ${response.statusText} on ${path}: ` +
          body.slice(0, 200),
      );
    }
    return (await response.json()) as T;
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `BidPrime ${response.status} ${response.statusText} on ${path}: ` +
          text.slice(0, 200),
      );
    }
    return (await response.json()) as T;
  }

  /**
   * Fetch a single bid's full detail via /api/v2/bid/get.
   * Returns the rich ~4KB description, document links, and match metadata.
   */
  async getBid(uuid: string): Promise<BidPrimeV2Bid> {
    return this.getJson<BidPrimeV2Bid>(DETAIL_PATH(uuid));
  }

  /**
   * Download a bid's documents as raw bytes (single PDF or ZIP).
   * Caller is responsible for content-type detection and parsing.
   */
  async downloadDocuments(
    bidId: string,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    const response = await fetch(`${BASE}${DOC_DOWNLOAD_PATH(bidId)}`, {
      headers: this.headers(),
    });
    if (!response.ok) {
      throw new Error(
        `BidPrime document download ${response.status} for bid ${bidId}`,
      );
    }
    const contentType =
      response.headers.get("content-type") ?? "application/octet-stream";
    const buffer = await response.arrayBuffer();
    return { bytes: new Uint8Array(buffer), contentType };
  }

  /**
   * Fetch one page of inbox bids via /api/v2/inbox/bid/list.
   * The page response includes thin metadata + matchedWords + matchedSnippets;
   * description is sometimes truncated, in which case caller can call getBid()
   * to fetch the rich version.
   */
  async listInbox(params: {
    page: number;
    pageSize?: number;
    inbox?: "notifications" | "saved" | "removed";
    sort?: string;
    filter?: string;
  }): Promise<InboxListResponse> {
    const body: InboxListBody = {
      page: params.page,
      pageSize: params.pageSize ?? 25,
      sort: params.sort ?? "issue desc",
      filter: params.filter ?? "",
      userId: this.userId,
      inbox: params.inbox ?? "notifications",
    };
    return this.postJson<InboxListResponse>(LIST_PATH, body);
  }

  /**
   * Fetch all bids from the inbox, paginating until exhausted.
   * Optionally enriches each bid with a /bid/get call for the full
   * rich description (default: enrichment off, since list response
   * already has matchedWords/matchedSnippets and partial description).
   */
  async fetchAllNotifications(options?: {
    onProgress?: (done: number, total: number) => void;
    /** Cap for testing — default fetches all bids in the inbox. */
    maxBids?: number;
    /** Per-page size for list calls (default 100, max appears to be 100). */
    pageSize?: number;
    /** Fetch /bid/get for each bid to get full rich description (default false). */
    enrichDetail?: boolean;
    /** Throttle between requests in ms (default 1100ms). */
    throttleMs?: number;
  }): Promise<FetchResult> {
    const pageSize = options?.pageSize ?? 100;
    const throttle = options?.throttleMs ?? 1100;
    const enrich = options?.enrichDetail ?? false;
    const allOpps: NormalizedOpportunity[] = [];
    let apiCallsUsed = 0;
    let page = 1;
    let total = 0;
    const seen = new Set<string>();

    outer: while (true) {
      const resp = await this.listInbox({ page, pageSize });
      apiCallsUsed++;
      total = resp.total;

      for (const stub of resp.items) {
        if (!stub.uuid || seen.has(stub.uuid)) continue;
        seen.add(stub.uuid);

        let bid: BidPrimeV2Bid = stub;
        if (enrich) {
          if (throttle > 0) {
            const jitter = throttle + Math.floor(Math.random() * 400);
            await new Promise((r) => setTimeout(r, jitter));
          }
          bid = await this.getBid(stub.uuid);
          apiCallsUsed++;
        }
        allOpps.push(normalizeBidPrimeV2Bid(bid));
        options?.onProgress?.(allOpps.length, total);

        if (options?.maxBids && allOpps.length >= options.maxBids) break outer;
      }

      if (resp.items.length < pageSize) break;
      if (allOpps.length >= total) break;
      page++;

      if (throttle > 0) {
        await new Promise((r) => setTimeout(r, throttle));
      }
    }

    return { opportunities: allOpps, apiCallsUsed, total };
  }
}
