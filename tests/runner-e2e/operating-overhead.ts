import { reservationBound, type EvalCostBoundEvidence } from "./cost-bound-evidence.js";
import { usdToUnits } from "../../packages/shared/src/money.js";

export const EVAL_OVERHEAD_COMPONENTS = ["ci_compute", "artifact_storage", "observability", "shared_subscription"] as const;
export interface EvalOperatingOverhead {
  version: 1;
  accountingReadiness?: "model_requests";
  reference: string;
  runner: "github-hosted" | "aws-fleet" | "local";
  verifiedAt: string;
  expiresAt: string;
  components: Array<{ component: typeof EVAL_OVERHEAD_COMPONENTS[number]; maxUsd: string; reference: string; provisionalBound?: EvalCostBoundEvidence }>;
}

const object = (value: unknown, allowed: string[]) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Invalid operating overhead fields");
};
const reference = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,511}$/.test(value);

export function operatingReservationBound(allowance: EvalOperatingOverhead, component: EvalOperatingOverhead["components"][number]) {
  if (component.provisionalBound === undefined) return undefined;
  return reservationBound("operating_allowance", component.provisionalBound, {
    ...(allowance.accountingReadiness ? { accountingReadiness: allowance.accountingReadiness } : {}),
    reference: allowance.reference, runner: allowance.runner, verifiedAt: allowance.verifiedAt, expiresAt: allowance.expiresAt,
    component: { component: component.component, maxUsd: component.maxUsd, reference: component.reference },
  });
}

export function validateOperatingOverhead(value: EvalOperatingOverhead, totalUsd: string): bigint {
  object(value, ["version", "accountingReadiness", "reference", "runner", "verifiedAt", "expiresAt", "components"]);
  if (value.accountingReadiness !== undefined && value.accountingReadiness !== "model_requests") throw new Error("Invalid accounting readiness policy");
  if (value.version !== 1 || !reference(value.reference) || !["github-hosted", "aws-fleet", "local"].includes(value.runner)
      || typeof value.verifiedAt !== "string" || typeof value.expiresAt !== "string"
      || !Number.isFinite(Date.parse(value.verifiedAt)) || !Number.isFinite(Date.parse(value.expiresAt))
      || Date.parse(value.expiresAt) <= Date.parse(value.verifiedAt)
      || Date.parse(value.expiresAt) - Date.parse(value.verifiedAt) > 31 * 86_400_000
      || !Array.isArray(value.components) || value.components.length !== EVAL_OVERHEAD_COMPONENTS.length) {
    throw new Error("Incomplete operating overhead allowance");
  }
  const seen = new Set<string>();
  let reserved = 0n;
  for (const component of value.components) {
    object(component, ["component", "maxUsd", "reference", "provisionalBound"]);
    if (component.provisionalBound !== undefined) operatingReservationBound(value, component);
    if (!EVAL_OVERHEAD_COMPONENTS.includes(component.component) || seen.has(component.component)
        || !reference(component.reference) || typeof component.maxUsd !== "string"
        || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(component.maxUsd)) throw new Error("Invalid operating overhead component");
    seen.add(component.component);
    reserved += usdToUnits(component.maxUsd);
  }
  if (reserved >= usdToUnits(totalUsd)) throw new Error("Operating overhead leaves no model allowance");
  return reserved;
}

export function scheduledOperatingOverhead(raw: string | undefined, runner: string | undefined, totalUsd: string, now: number, cadence?: "daily" | "weekly"): EvalOperatingOverhead {
  if (!raw || raw.length > 16_384) throw new Error("Missing reviewed operating overhead allowance");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Invalid operating overhead JSON"); }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && !("version" in parsed)) {
    object(parsed, ["daily", "weekly"]);
    if (!cadence) throw new Error("Missing operating overhead cadence");
    parsed = (parsed as Record<string, unknown>)[cadence];
  }
  const value = parsed as EvalOperatingOverhead;
  validateOperatingOverhead(value, totalUsd);
  if (runner !== "ubuntu-latest" || value.runner !== "github-hosted") throw new Error("Bounded campaigns require the standard GitHub-hosted runner allowance");
  if (!Number.isFinite(now) || now < Date.parse(value.verifiedAt) || now + 4 * 3_600_000 >= Date.parse(value.expiresAt)) {
    throw new Error("Operating overhead allowance needs review before paid admission");
  }
  return value;
}
