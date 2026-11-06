// The TestOps "Reliability — staging soak" plan: a sibling of the standing
// Product regression plan (plan 2) on the same trusted workflow, TestOps job,
// selection, projection, upload and verification path. Each case selects one
// existing everyday-workflows reliability cell; it does not change the prompt,
// grader, budget or runtime. Six plan cells run native OpenCode with DeepSeek
// 1017 through OpenRouter. queue-steer must steer an active turn, which the
// OpenCode driver does not support (`steering: false`), so the plan uses the
// existing native Codex Daytona cell for it. The other native Codex and ACPX
// reliability cells stay explicit-only extras outside the plan.

export const reliabilityPlanKey = 'reliability';
export const reliabilityPlanName = 'Reliability — staging soak';
export const reliabilitySuite = 'everyday-workflows';
export const reliabilityProfile = 'runner-opencode-deepseek-1017';
export const reliabilityModel = 'openrouter/deepseek/deepseek-v4.1-flash-1017';
const steeringProfile = ['runner-codex', 'gpt-6.1-sol'];

// Daytona only where the soak failure was a sandbox lease failure (S49, S52/S52b,
// S55). The catalog test binds this table to everyday-reliability-cases.ts.
export const reliabilityDefinitions = Object.freeze([
  ['interrupt-redirect', 'local', 'S47'],
  ['reassign-midrun', 'local', 'S48'],
  ['three-turn-revise', 'daytona', 'S49'],
  ['long-silent-command', 'daytona', 'S52/S52b'],
  ['tree-pause-release', 'local', 'S50/S50b'],
  ['queue-steer', 'daytona', 'H2', ...steeringProfile],
  ['queued-across-restart', 'daytona', 'S55/U9'],
].map(([name, environment, signature, profile = reliabilityProfile, model = reliabilityModel]) => Object.freeze({
  plan: reliabilityPlanKey, suite: reliabilitySuite, name, environment, signature, profile, model,
  fullName: `paperclip.Product E2E.${reliabilitySuite}.${name}`,
  executionId: `${reliabilitySuite}.${profile}.${environment}.${name}`,
})));

// TestOps assigns these identities; they are never invented here. Fill them,
// in one reviewed change, from the receipt of the trusted
// `runner-e2e-testops-registration.yml` workflow (operation `register`).
// Until every case and the plan have an identity, selecting this plan fails
// closed with `product_regression_testops_reliability_unregistered`.
export const reliabilityRegistration = Object.freeze({
  planId: null,
  caseIds: Object.freeze({}),
});

const fail = code => { throw new Error(`product_regression_testops_${code}`); };
const positive = value => Number.isSafeInteger(value) && value > 0;

/**
 * Bind the reviewed TestOps identities to the reliability cells. Returns null
 * while nothing is registered; any partial, duplicate, foreign or malformed
 * registration fails instead of selecting a subset.
 */
export function registeredReliabilityCases(registration = reliabilityRegistration, reservedCaseIds = [], reservedPlanIds = [2]) {
  const ids = registration?.caseIds ?? {};
  if (registration?.planId == null && Object.keys(ids).length === 0) return null;
  const names = reliabilityDefinitions.map(row => row.name);
  if (!positive(registration.planId) || reservedPlanIds.includes(registration.planId)
      || Object.keys(ids).length !== names.length || names.some(name => !positive(ids[name]))
      || new Set(names.map(name => ids[name])).size !== names.length
      || names.some(name => reservedCaseIds.includes(ids[name]))) fail('reliability_registration_invalid');
  return Object.freeze(reliabilityDefinitions.map(row => Object.freeze({ id: ids[row.name], ...row })));
}
