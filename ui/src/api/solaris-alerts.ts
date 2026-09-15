export type AlertSeverity = "critical" | "warning" | "info";
export type AlertDispatchStatus = "pending" | "translating" | "ready" | "failed";
export type SupportedLanguage = "en" | "es" | "zh-Hans" | "tl";

export const LANGUAGE_LABELS: Record<SupportedLanguage, string> = {
  en: "English",
  es: "Spanish",
  "zh-Hans": "Mandarin (Simplified)",
  tl: "Tagalog",
};

export const LOCALE_BADGES: Record<string, string> = {
  es: "ES",
  "zh-Hans": "ZH",
  tl: "TL",
};

export interface SolarisOrg {
  id: string;
  companyId: string;
  name: string;
  preferredLanguage: SupportedLanguage;
  contactEmail: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SolarisAlert {
  id: string;
  companyId: string;
  orgId: string | null;
  title: string;
  body: string;
  severity: AlertSeverity;
  translatedBodies: Record<string, string> | null;
  dispatchStatus: AlertDispatchStatus;
  capIdentifier: string | null;
  incidentArea: string | null;
  createdBy: string | null;
  // CAD dispatch fields (IUN-2751)
  incidentId: string | null;
  incidentName: string | null;
  incidentType: string | null;
  reportedAt: string | null;
  source: string;
  // Triage fields (IUN-2885)
  assigneeId: string | null;
  assigneeName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrgInput {
  companyId: string;
  name: string;
  preferredLanguage?: SupportedLanguage;
  contactEmail?: string;
}

export interface UpdateOrgInput {
  name?: string;
  preferredLanguage?: SupportedLanguage;
  contactEmail?: string;
}

export interface CreateAlertInput {
  companyId: string;
  title: string;
  body: string;
  severity?: AlertSeverity;
  orgId?: string;
  capIdentifier?: string;
  incidentArea?: string;
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export async function fetchSolarisOrgs(companyId: string): Promise<SolarisOrg[]> {
  const url = new URL("/api/solaris/orgs", window.location.origin);
  url.searchParams.set("companyId", companyId);
  const data = await apiFetch<{ orgs: SolarisOrg[] }>(url.toString());
  return data.orgs;
}

export async function createSolarisOrg(input: CreateOrgInput): Promise<SolarisOrg> {
  return apiFetch<SolarisOrg>("/api/solaris/orgs", { method: "POST", body: JSON.stringify(input) });
}

export async function updateSolarisOrg(orgId: string, updates: UpdateOrgInput): Promise<SolarisOrg> {
  return apiFetch<SolarisOrg>(`/api/solaris/orgs/${encodeURIComponent(orgId)}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function deleteSolarisOrg(orgId: string): Promise<void> {
  await apiFetch<void>(`/api/solaris/orgs/${encodeURIComponent(orgId)}`, { method: "DELETE" });
}

export async function fetchSolarisAlerts(companyId: string, orgId?: string, limit?: number): Promise<SolarisAlert[]> {
  const url = new URL("/api/solaris/alerts", window.location.origin);
  url.searchParams.set("companyId", companyId);
  if (orgId) url.searchParams.set("orgId", orgId);
  if (limit) url.searchParams.set("limit", String(limit));
  const data = await apiFetch<{ alerts: SolarisAlert[] }>(url.toString());
  return data.alerts;
}

export async function createSolarisAlert(input: CreateAlertInput): Promise<SolarisAlert> {
  return apiFetch<SolarisAlert>("/api/solaris/alerts", { method: "POST", body: JSON.stringify(input) });
}
