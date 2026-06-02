/**
 * HubSpot CRM v3 client — ported from agnb lib/integrations/hubspot.ts.
 * Private App token auth (Bearer). Region-agnostic base (api.hubapi.com).
 *
 * Trimmed to what the Paperclip hygiene scanner needs: a paginated GET
 * helper plus typed deal/contact shapes. Accepts either HUBSPOT_TOKEN or
 * HUBSPOT_API_KEY as the bearer token.
 */
const API = "https://api.hubapi.com";

export function hubspotToken(): string | null {
  return process.env.HUBSPOT_TOKEN || process.env.HUBSPOT_API_KEY || null;
}

export function hubspotConfigured(): boolean {
  return !!hubspotToken();
}

export interface HsResp<T> {
  results: T[];
  paging?: { next?: { after: string } };
}

export interface HsDeal {
  id: string;
  properties: {
    dealname?: string;
    dealstage?: string;
    closedate?: string;
    hubspot_owner_id?: string;
    hs_lastmodifieddate?: string;
    createdate?: string;
    [k: string]: string | undefined;
  };
}

export interface HsContact {
  id: string;
  properties: { email?: string; firstname?: string; lastname?: string; phone?: string; [k: string]: string | undefined };
}

/** Single GET against the HubSpot CRM API. Throws on missing token / non-OK. */
export async function hsFetch<T>(path: string): Promise<HsResp<T>> {
  const token = hubspotToken();
  if (!token) throw new Error("HUBSPOT_TOKEN / HUBSPOT_API_KEY missing");
  const r = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`hubspot http ${r.status}: ${await r.text()}`);
  return (await r.json()) as HsResp<T>;
}
