// Standalone ROI engine — ported from hf-web-v2 cost-model.ts + roi-calc.ts.
// Computes a human-vs-Finn comparison for a given monthly call volume.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const D = (f) => JSON.parse(readFileSync(join(__dir, "..", "data", f), "utf8"));

const HUMAN = D("human-cost.json");
const FINN = D("finn-roi.json");
const PLANS = D("plans.json").PLANS;

// Finn connect-rate uplift from swivel-chair-tax (≈38% vs 12% human → 3.2×)
const FINN_CONNECT_RATE = 0.38;

// default plan tier by client segment (overridable via answers.planId)
export const planForClient = (clientType) =>
  ({ smb: "pro", enterprise: "growth", investor: "growth" }[clientType] || "growth");

const cur = (region) => (region === "india" ? "inr" : "usd");
const sym = (region) => (region === "india" ? "₹" : "$");

function planRate(planId, region) {
  const p = PLANS.find((x) => x.id === planId) || PLANS.find((x) => x.id === "growth") || PLANS[1];
  return p.ratePerCredit[cur(region)];
}

const fmt = (region, n) => {
  const s = sym(region);
  if (n > 0 && n < 10) return `${s}${n.toFixed(2)}`;
  if (n >= 1e7) return `${s}${(n / 1e7).toFixed(1)}Cr`;
  if (n >= 1e5 && region === "india") return `${s}${(n / 1e5).toFixed(1)}L`;
  if (n >= 1000) return `${s}${(n / 1000).toFixed(n >= 1e5 ? 0 : 1)}K`;
  return `${s}${Math.round(n).toLocaleString()}`;
};

// monthlyCalls = dials attempted per month
export function computeRoi({ monthlyCalls = 5000, region = "india", planId = "growth", avgCallMin } = {}) {
  const c = cur(region);
  const callMin = avgCallMin || HUMAN.AVG_CALL_MIN || 1;
  const rate = planRate(planId, region);

  // human side
  const humanRepDays = monthlyCalls / HUMAN.DIALS_PER_REP_DAY;
  const humanCost = humanRepDays * HUMAN.REP_DAY_COST[c];
  const humanConnects = monthlyCalls * HUMAN.CONNECT_RATE;

  // finn side: ~1 credit per minute, charged at plan rate
  const finnCredits = monthlyCalls * callMin;
  const finnCost = finnCredits * rate;
  const finnConnects = monthlyCalls * FINN_CONNECT_RATE;

  const savings = humanCost - finnCost;
  const savingsPct = humanCost > 0 ? savings / humanCost : 0;
  const uplift = HUMAN.CONNECT_RATE > 0 ? FINN_CONNECT_RATE / HUMAN.CONNECT_RATE : 0;

  return {
    region, sym: sym(region), planId, rate, monthlyCalls, callMin,
    human: { cost: humanCost, costFmt: fmt(region, humanCost), connects: Math.round(humanConnects), repDays: Math.round(humanRepDays), connectRate: HUMAN.CONNECT_RATE },
    finn: { cost: finnCost, costFmt: fmt(region, finnCost), connects: Math.round(finnConnects), credits: Math.round(finnCredits), connectRate: FINN_CONNECT_RATE },
    savings, savingsFmt: fmt(region, savings),
    savingsPct: Math.round(savingsPct * 100),
    uplift: Number(uplift.toFixed(1)),
    perConnectHuman: fmt(region, HUMAN.REP_DAY_COST[c] / HUMAN.CONNECTS_PER_REP_DAY),
    perCallFinn: fmt(region, rate * callMin)
  };
}

export { HUMAN, FINN, PLANS, fmt, sym };
