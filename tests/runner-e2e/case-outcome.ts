import type { RunnerE2EResult } from "./types.js";
import { isBlockedConnectionResult } from "./connection-evidence.js";
import { validateOnboardingConnectEvidence } from "./product-journeys/onboarding-connect.js";
const html = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

function renderOnboardingConnect(result: RunnerE2EResult): string {
  const receipt = result.productJourney?.onboardingConnect;
  if (receipt === undefined) return "";
  try {
    validateOnboardingConnectEvidence(receipt);
  } catch {
    return "<p>Onboarding Connect diagnostics unavailable: invalid receipt.</p>";
  }
  return `<details class="case-context"><summary>Onboarding Connect diagnostics</summary>
    <p>Last checkpoint: <code>${html(receipt.checkpoint)}</code></p>
    ${([["validation", "Native validation"], ["hire", "Agent hire"]] as const).map(([key, label]) => {
      const response = receipt[key];
      return `<h4>${label}</h4><dl>${[
        ["Response state", response.state], ["HTTP status", response.httpStatus],
        ["Test endpoint adapter", response.requestedAdapter], ["Returned adapter", response.adapter],
        ["Validation outcome", response.outcome], ["Server code", response.serverCode],
      ].map(([name, value]) => `<div><dt>${name}</dt><dd>${html(value ?? "Unavailable")}</dd></div>`).join("")}</dl>
      ${response.checks.length ? `<p>Validation checks:</p><ul>${response.checks.map(check => `<li><code>${html(check.code)}</code> · ${html(check.level)}</li>`).join("")}</ul>` : ""}
      ${response.truncatedChecks ? "<p>Only the first 32 validation checks were retained.</p>" : ""}`;
    }).join("")}</details>`;
}
/** An interrupted first-task journey is not evidence of failed downstream behavior. */
export function isIncompleteFirstTaskResult(
  result: RunnerE2EResult,
  errors: readonly string[] = [],
) {
  if (result.productJourney && ["blocked", "unsupported"].includes(result.productJourney.outcome)) return result.cleanup === "passed" && errors.length === 0;
  if (isBlockedConnectionResult(result)) return result.cleanup === "passed" && result.failureClass !== "secret_leak" && errors.length === 0;
  const checks = result.firstTask?.checks ?? [];
  return result.status === "failed" &&
    result.failureClass === "candidate_failure" &&
    result.cleanup === "passed" && errors.length === 0 &&
    checks.some((c) => c.notReached) &&
    checks.every((c) => c.passed || c.notReached);
}

export function renderCaseOutcome(
  result: RunnerE2EResult,
  valid: boolean,
  errors: readonly string[],
) {
  const checks =
    (result.productJourney?.checks.map(c => ({ ...c, detail: c.id.replaceAll("-", " "), notReached: undefined as string | undefined })) ?? (result.firstTask?.checks.length ? result.firstTask.checks : undefined)) ??
    (result.matcherResults ?? []).map((m) => ({
      id: m.matcher.kind === "json_path" ? m.matcher.path : m.matcher.kind,
      passed: m.passed,
      notReached: isBlockedConnectionResult(result) && !m.passed ? "Blocked before this checkpoint" : undefined as string | undefined,
      detail: m.detail,
    }));
  const failures = checks.filter((c) => !c.passed && !c.notReached);
  const notReached = checks.filter((c) => c.notReached);
  const evaluated = checks.length - notReached.length;
  const passed = checks.filter((c) => c.passed).length;
  const incomplete = isIncompleteFirstTaskResult(result, errors);
  const failed = !valid || result.status === "failed";
  const reason =
    result.failureClass === "secret_leak"
      ? /persisted Paperclip home/.test(result.error ?? "")
        ? "Credential-persistence check failed"
        : "Secret / evidence safety check failed"
      : (result.failureClass?.replaceAll("_", " ") ??
        (result.cleanup === "failed"
          ? "Cleanup failed"
          : "Run or evidence validation failed"));
  const messages = [
    ...new Set(
      [result.error, ...errors].filter((s): s is string => Boolean(s)),
    ),
  ];
  return `<section class="case-outcome ${failed ? "outcome-failed" : "outcome-passed"}" aria-label="Case result explanation">
    <strong>${result.productJourney ? html(result.productJourney.outcome) : isBlockedConnectionResult(result) ? `Blocked: ${html(result.providerConnection!.outcome.replaceAll("_", " "))}` : incomplete ? "Incomplete journey" : failed ? "Overall failed" : "Overall passed"} · ${checks.length ? `${passed}/${evaluated} behavioral checks passed${notReached.length ? ` · ${notReached.length} not reached` : ""}` : "No behavioral checks recorded"}</strong>
    ${result.productJourney ? `<p>Deployment: ${html(result.productJourney.deployment?.kind ?? "unavailable")} · ${html(result.productJourney.deployment?.targetId ?? "unavailable")} · ${html(result.productJourney.deployment?.commit ?? "revision unavailable")} · starting state: ${html(result.productJourney.startingState)} · resources: ${html(result.productJourney.resourceDisposition)}</p><ul>${result.productJourney.phases.map(p => `<li>${html(p.phase)}: ${html(p.outcome)}${p.code ? ` (${html(p.code)})` : ""}</li>`).join("")}</ul>` : ""}
    ${result.productJourney ? `<details class="case-context"><summary>Deployment and setup evidence</summary><dl>${[
      ["Campaign", result.productJourney.campaignId], ["Attempt", result.productJourney.attemptId],
      ["Origin", result.productJourney.deployment?.origin], ["Cloud release", result.productJourney.deployment?.cloudRelease],
      ["Runtime image", result.productJourney.deployment?.runtimeImage], ["Effective configuration hash", result.productJourney.deployment?.configurationHash],
      ["Harness revision", result.source?.sha], ["Journey definition hash", result.suiteDefinitionHash],
    ].map(([label, value]) => `<div><dt>${html(label)}</dt><dd>${html(value ?? "Unavailable")}</dd></div>`).join("")}</dl>
    ${result.productJourney.deployment?.executionEnvironment ? `<p>Managed environment: ${html(result.productJourney.deployment.executionEnvironment.id)} · ${html(result.productJourney.deployment.executionEnvironment.driver)} · ${html(result.productJourney.deployment.executionEnvironment.status)}</p>` : ""}
    ${result.productJourney.deployment?.effectiveFeatures ? `<p>Effective features:</p><dl>${Object.entries(result.productJourney.deployment.effectiveFeatures).map(([key, value]) => `<div><dt>${html(key)}</dt><dd>${html(value)}</dd></div>`).join("")}</dl>` : ""}</details>` : ""}
    ${result.productJourney?.operations ? `<p>Eval operations: ${html(result.productJourney.operations.campaignId)} · ${result.productJourney.operations.requestCount} requests · model cost $${html(result.productJourney.operations.modelCostUsd ?? "unknown")} (setup $${html(result.productJourney.operations.setupCostUsd ?? "unknown")}, counted once). Feedback: ${html(result.productJourney.operations.feedback.collection)} · ${result.productJourney.operations.feedback.complaints} complaints · ${result.productJourney.operations.feedback.suggestions} suggestions.</p>` : ""}
    ${result.productJourney?.operations?.traceIds.length ? `<details><summary>Trace correlation IDs</summary><ul>${result.productJourney.operations.traceIds.map(id => `<li><code>${html(id)}</code></li>`).join("")}</ul></details>` : ""}
    ${renderOnboardingConnect(result)}
    ${result.providerConnection ? `<p>Target: ${html(result.providerConnection.target.origin)} · ${html(result.providerConnection.target.commit ?? "revision unavailable")} · ${result.providerConnection.assisted ? "Assisted login" : "Unassisted"} · ${html(result.providerConnection.authFreshness)} browser · ${html(result.providerConnection.entry)} / ${html(result.providerConnection.method)} · stopped at ${html(result.providerConnection.phase)}</p>` : ""}
    ${failures.length ? `<p>Failed checks:</p><ul>${failures.map((c) => `<li><strong>${html(c.id)}</strong> — ${html(c.detail)}</li>`).join("")}</ul>` : checks.length ? `<p>No behavioral matcher failed.${notReached.length ? " The journey is incomplete; unexercised checks are not passes." : failed ? " The overall failure came from a separate run, cleanup, or evidence check." : ""}</p>` : ""}
    ${notReached.length ? `<p>Not reached:</p><ul>${notReached.map((c) => `<li><strong>${html(c.id)}</strong> — ${html(c.notReached)}</li>`).join("")}</ul>` : ""}
    ${checks.length ? `<details><summary>See all behavioral checks (${checks.length})</summary><table class="matchers"><thead><tr><th>Result</th><th>Check</th><th>Detail</th></tr></thead><tbody>${checks.map((c) => `<tr class="matcher-${c.notReached ? "not-reached" : c.passed ? "passed" : "failed"}"><td>${c.notReached ? "Not reached" : c.passed ? "Pass" : "Fail"}</td><td><code>${html(c.id)}</code></td><td>${html(c.detail)}${c.notReached ? ` — ${html(c.notReached)}` : ""}</td></tr>`).join("")}</tbody></table></details>` : ""}
    ${
      failed
        ? `<p><strong>${html(incomplete ? "Recording stopped before the journey finished" : reason)}</strong></p>${messages
            .map((m) =>
              m.length > 1200
                ? `<details><summary>Full failure details (${m.length.toLocaleString("en-US")} characters)</summary><div class="failure-reason">${html(m)}</div></details>`
                : `<div class="failure-reason">${html(m)}</div>`,
            )
            .join("")}`
        : ""
    }
  </section>`;
}
