import { config } from "./config.js";

interface HunterEmailFinderResult {
  email: string | null;
  score: number;
  sources: Array<{ domain: string; uri: string; extracted_on: string }>;
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  twitter: string | null;
  linkedin_url: string | null;
}

interface HunterDomainSearchResult {
  domain: string;
  disposable: boolean;
  webmail: boolean;
  accept_all: boolean;
  pattern: string | null;
  organization: string | null;
  emails: Array<{
    value: string;
    type: string;
    confidence: number;
    first_name: string | null;
    last_name: string | null;
    position: string | null;
    department: string | null;
    linkedin: string | null;
    twitter: string | null;
    sources: Array<{ domain: string; uri: string; extracted_on: string }>;
  }>;
}

interface HunterEmailVerifyResult {
  email: string;
  result: "deliverable" | "undeliverable" | "risky" | "unknown";
  score: number;
  regexp: boolean;
  gibberish: boolean;
  disposable: boolean;
  webmail: boolean;
  mx_records: boolean;
  smtp_server: boolean;
  smtp_check: boolean;
  accept_all: boolean;
  block: boolean;
  sources: Array<{ domain: string; uri: string; extracted_on: string }>;
}

interface HunterDiscoverResult {
  domain: string;
  emails: Array<{
    value: string;
    type: string;
    confidence: number;
    first_name: string | null;
    last_name: string | null;
    position: string | null;
    department: string | null;
    linkedin: string | null;
    sources: Array<{ domain: string; uri: string; extracted_on: string }>;
  }>;
}

interface HunterCompanyResult {
  name: string | null;
  domain: string;
  description: string | null;
  industry: string | null;
  size: string | null;
  linkedin_url: string | null;
  twitter: string | null;
  facebook: string | null;
  instagram: string | null;
  youtube: string | null;
  technologies: string[];
  city: string | null;
  state: string | null;
  country: string | null;
  postal_code: string | null;
  street: string | null;
  founded_year: number | null;
  phone_number: string | null;
}

interface HunterPersonResult {
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  seniority: string | null;
  department: string | null;
  twitter: string | null;
  linkedin_url: string | null;
  phone_number: string | null;
  company: {
    name: string | null;
    domain: string | null;
    industry: string | null;
    size: string | null;
  } | null;
}

async function request<T>(path: string, params: Record<string, string> = {}, method = "GET", body?: unknown): Promise<T> {
  const url = new URL(`${config.baseUrl}${path}`);
  url.searchParams.set("api_key", config.apiKey);
  if (method === "GET") {
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Hunter API error ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { data: T; errors?: Array<{ id: string; code: number; details: string }> };
  if (json.errors?.length) {
    throw new Error(`Hunter API error: ${json.errors.map((e) => e.details).join(", ")}`);
  }
  return json.data;
}

export async function findEmail(params: {
  firstName: string;
  lastName: string;
  domain: string;
}): Promise<HunterEmailFinderResult> {
  return request<HunterEmailFinderResult>("/email-finder", {
    first_name: params.firstName,
    last_name: params.lastName,
    domain: params.domain,
  });
}

export async function searchDomain(params: {
  domain: string;
  limit?: number;
  department?: string;
  seniority?: string;
}): Promise<HunterDomainSearchResult> {
  return request<HunterDomainSearchResult>("/domain-search", {
    domain: params.domain,
    limit: String(params.limit ?? 10),
    ...(params.department ? { department: params.department } : {}),
    ...(params.seniority ? { seniority: params.seniority } : {}),
  });
}

export async function verifyEmail(email: string): Promise<HunterEmailVerifyResult> {
  return request<HunterEmailVerifyResult>("/email-verifier", { email });
}

export async function discoverDomain(params: {
  domain: string;
  limit?: number;
}): Promise<HunterDiscoverResult> {
  return request<HunterDiscoverResult>("/discover", {}, "POST", {
    domain: params.domain,
    limit: params.limit ?? 10,
  });
}

export async function enrichCompany(domain: string): Promise<HunterCompanyResult> {
  return request<HunterCompanyResult>("/companies/find", { domain });
}

export async function enrichPerson(email: string): Promise<HunterPersonResult> {
  return request<HunterPersonResult>("/people/find", { email });
}

export async function enrichCombined(email: string): Promise<{ person: HunterPersonResult; company: HunterCompanyResult }> {
  return request<{ person: HunterPersonResult; company: HunterCompanyResult }>("/combined/find", { email });
}

export async function getAccountInfo(): Promise<{ plan_name: string; requests: { searches: { used: number; available: number }; verifications: { used: number; available: number } } }> {
  return request("/account");
}
