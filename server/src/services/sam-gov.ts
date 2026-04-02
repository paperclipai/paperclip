/**
 * SAM.gov Opportunities API service.
 *
 * Wraps the public Get Opportunities v2 API so Paperclip agents can search
 * federal contract opportunities (bids) directly.
 *
 * API docs: https://open.gsa.gov/api/get-opportunities-public-api/
 */

const SAM_BASE_URL = "https://api.sam.gov/opportunities/v2/search";

export interface SamSearchParams {
  /** Posted-date range start (MM/dd/yyyy) */
  postedFrom: string;
  /** Posted-date range end   (MM/dd/yyyy) */
  postedTo: string;

  /* ---- optional filters ---- */
  /** Procurement type codes: u,p,a,r,s,o,g,k,i */
  ptype?: string;
  /** Solicitation number */
  solnum?: string;
  /** Notice ID */
  noticeid?: string;
  /** Keyword in title */
  title?: string;
  /** Place-of-performance state abbreviation */
  state?: string;
  /** Place-of-performance zip */
  zip?: string;
  /** NAICS code (max 6 digits) */
  ncode?: string;
  /** Classification code */
  ccode?: string;
  /** Set-aside code (SBA, 8A, HZC, SDVOSBC, WOSB, …) */
  typeOfSetAside?: string;
  /** Department / subtier name */
  organizationName?: string;
  /** Response-deadline range start (MM/dd/yyyy) */
  rdlfrom?: string;
  /** Response-deadline range end   (MM/dd/yyyy) */
  rdlto?: string;
  /** Records per page (1-1000, default 10) */
  limit?: number;
  /** Page offset (default 0) */
  offset?: number;
}

export interface SamOpportunity {
  noticeId: string;
  title: string;
  solicitationNumber: string;
  department: string | null;
  subTier: string | null;
  office: string | null;
  postedDate: string;
  type: string;
  baseType: string;
  setAsideDescription: string | null;
  setAsideCode: string | null;
  responseDeadLine: string | null;
  naicsCode: string | null;
  classificationCode: string | null;
  active: string;
  award: {
    date: string | null;
    number: string | null;
    amount: string | null;
    awardee: { name: string | null } | null;
  } | null;
  pointOfContact: Array<{
    type: string;
    fullName: string | null;
    email: string | null;
    phone: string | null;
  }>;
  description: string | null;
  organizationType: string | null;
  uiLink: string;
  placeOfPerformance: {
    streetAddress: string | null;
    city: { code: string | null; name: string | null };
    state: { code: string | null; name: string | null };
    zip: string | null;
    country: { code: string | null; name: string | null };
  } | null;
  // passthrough for any extra fields SAM returns
  [key: string]: unknown;
}

export interface SamSearchResult {
  totalRecords: number;
  limit: number;
  offset: number;
  opportunitiesData: SamOpportunity[];
}

export function samGovService(apiKey: string) {
  async function search(params: SamSearchParams): Promise<SamSearchResult> {
    const url = new URL(SAM_BASE_URL);
    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("postedFrom", params.postedFrom);
    url.searchParams.set("postedTo", params.postedTo);
    url.searchParams.set("limit", String(params.limit ?? 10));
    url.searchParams.set("offset", String(params.offset ?? 0));

    const optionalKeys: (keyof SamSearchParams)[] = [
      "ptype",
      "solnum",
      "noticeid",
      "title",
      "state",
      "zip",
      "ncode",
      "ccode",
      "typeOfSetAside",
      "organizationName",
      "rdlfrom",
      "rdlto",
    ];
    for (const key of optionalKeys) {
      const val = params[key];
      if (val !== undefined && val !== null && val !== "") {
        url.searchParams.set(key, String(val));
      }
    }

    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `SAM.gov API error ${res.status}: ${body || res.statusText}`,
      );
    }

    return (await res.json()) as SamSearchResult;
  }

  async function getOpportunity(noticeId: string): Promise<SamOpportunity | null> {
    const now = new Date();
    const oneYearAgo = new Date(now);
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const fmt = (d: Date) =>
      `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;

    const result = await search({
      postedFrom: fmt(oneYearAgo),
      postedTo: fmt(now),
      noticeid: noticeId,
      limit: 1,
    });

    return result.opportunitiesData?.[0] ?? null;
  }

  return { search, getOpportunity };
}
