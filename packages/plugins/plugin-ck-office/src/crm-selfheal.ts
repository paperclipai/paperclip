// Deterministic CRM address self-heal — NO LLM, ~0 cost, idempotent.
//
// Recurring failure it cures: a bulk venue import (e.g. golf-club "Liste"/"Manuell")
// stuffs the town into billingAddressStreet, the canton into billingAddressState, and
// leaves billingAddressCity BLANK. Zefix enrichment can't touch these (clubs aren't in
// the register), so no matter how many times a routine/agent is "triggered", the City
// column stays empty. This moves the town Street->City so the field actually fills.
//
// Shared by the scheduled job (JOB_CRM_ADDRESS_SELFHEAL) and the on-demand tool
// (crm_backfill_city) so the routine and GOV-25's delegated call run identical logic.
import type { Espo } from "./espo.js";

const blank = (v: unknown) => !String(v ?? "").trim();

/** Clean a locality string: drop "(…)" notes, "- nahe/bei/near …", and ", Kanton XX". */
export function cleanTown(s: string): string {
  let t = String(s || "").trim();
  t = t.replace(/\s*\([^)]*\)\s*/g, " ");
  t = t.replace(/\s*[-–]\s*(nahe|bei|near|ca\.|~)\b.*$/i, "");
  t = t.replace(/\s*,\s*(Kanton|Canton)\s+\w+.*$/i, "");
  return t.replace(/\s{2,}/g, " ").trim();
}

/** From a Street field holding a locality (or "Street 12, Town"), derive [newStreet, city]. */
export function deriveCity(street: string): { street: string; city: string } {
  const raw = String(street || "").trim();
  if (raw.includes(",")) {
    const idx = raw.indexOf(",");
    const head = raw.slice(0, idx);
    const tail = raw.slice(idx + 1);
    if (/\d/.test(head)) return { street: head.trim(), city: cleanTown(tail) }; // real "Street 12, Town"
  }
  return { street: "", city: cleanTown(raw) }; // locality-only -> clear the bogus street
}

export interface SelfHealResult {
  scanned: number;
  emptyCity: number;
  filled: number;
  skipped: number;
  changes: Array<{ id: string; name: string; city: string; streetCleared: boolean }>;
}

/**
 * Fill empty billingAddressCity from the Street field across ALL Account rows.
 * Only writes when a city can be derived; never overwrites a non-empty City.
 */
export async function selfHealCityFromStreet(espo: Espo, apply = true): Promise<SelfHealResult> {
  const sel = ["id", "name", "billingAddressStreet", "billingAddressCity"];
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < 10000; offset += 200) {
    const page = await espo.list("Account", { select: sel, maxSize: 200, offset });
    const batch = (page.list as Array<Record<string, unknown>>) || [];
    rows.push(...batch);
    if (batch.length < 200) break;
  }
  const empty = rows.filter((a) => blank(a.billingAddressCity));
  const res: SelfHealResult = { scanned: rows.length, emptyCity: empty.length, filled: 0, skipped: 0, changes: [] };
  for (const a of empty) {
    const street = String(a.billingAddressStreet || "");
    const { street: newStreet, city } = deriveCity(street);
    if (!city) { res.skipped++; continue; }
    const patch: Record<string, unknown> = { billingAddressCity: city };
    const streetCleared = newStreet !== street;
    if (streetCleared) patch.billingAddressStreet = newStreet;
    if (apply) {
      try {
        await espo.update("Account", String(a.id), patch);
      } catch {
        res.skipped++;
        continue;
      }
    }
    res.filled++;
    res.changes.push({ id: String(a.id), name: String(a.name || ""), city, streetCleared });
  }
  return res;
}
