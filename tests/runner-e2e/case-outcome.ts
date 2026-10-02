import type { RunnerE2EResult } from "./types.js";
const html = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
/** An interrupted first-task journey is not evidence of failed downstream behavior. */
export function isIncompleteFirstTaskResult(
  result: RunnerE2EResult,
  errors: readonly string[] = [],
) {
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
    (result.firstTask?.checks.length ? result.firstTask.checks : undefined) ??
    (result.matcherResults ?? []).map((m) => ({
      id: m.matcher.kind === "json_path" ? m.matcher.path : m.matcher.kind,
      passed: m.passed,
      notReached: undefined as string | undefined,
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
    <strong>${incomplete ? "Incomplete journey" : failed ? "Overall failed" : "Overall passed"} · ${checks.length ? `${passed}/${evaluated} behavioral checks passed${notReached.length ? ` · ${notReached.length} not reached` : ""}` : "No behavioral checks recorded"}</strong>
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
