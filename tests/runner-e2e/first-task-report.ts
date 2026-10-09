import { renderFirstTaskTranscript } from "./first-task-transcript.js";
import type { RunnerE2EResult } from "./types.js";
const html = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function renderFirstTaskDetails(result?: RunnerE2EResult) {
  const e = result?.firstTask;
  if (!e) return "";
  const prefix = `first-task-${encodeURIComponent(result!.executionId)}`;
  const q = result?.firstTaskQuality;
  const ref = (id: string) => `${prefix}-${encodeURIComponent(id)}`;
  const last = e.checkpoints.at(-1);
  return `<details class="case-context conversation-details"><summary>Read full conversation</summary>${renderFirstTaskTranscript(e, (id) => `#${ref(id)}`)}</details><details class="case-context"><summary>Onboarding instructions, approval timeline, and quality</summary>
    <p>Source: ${html(e.source?.sha ?? result?.source?.sha ?? "Unknown")} · ${html(e.source?.ref ?? result?.source?.ref ?? "Unknown")} ${e.source?.dirty ? "(working tree modified; compare instruction hashes)" : ""}</p>
    ${e.runtimeSettings?.onboardingRuntime ? `<p>Setup: ${html((e.runtimeSettings.onboardingRuntime as { mode: string }).mode)}.</p>` : ""}
    <p>Configured model: ${html(e.configuredModel ?? "Provider default")}. Observed: ${html(e.observedModels.join(", ") || "Not reported")}.</p>
    <details><summary>Runtime settings and permissions</summary><pre>${html(JSON.stringify(e.runtimeSettings ?? {}, null, 2))}</pre></details>
    <details><summary>Full instruction snapshots (${e.instructions.length})</summary>${e.instructions.map((i) => `<details><summary>${html(i.path)}</summary><p>Source SHA-256: <code>${html(i.sha256)}</code></p>${i.redacted ? `<p>Credential redaction applied to this display copy. Display SHA-256: <code>${html(i.contentSha256)}</code></p>` : ""}<pre>${html(i.content)}</pre></details>`).join("")}</details>
    <p>Quality scores are informational and never change behavioral pass/fail.</p>
    ${
      q
        ? `<p>Judge: ${html(q.config.model)} · ${html(q.status)} · estimated cost: ${html(q.estimatedCostUsd === null ? "unknown" : `$${q.estimatedCostUsd.toFixed(6)}`)} · reservation: $${q.reservedCostUsd.toFixed(6)} · ${html(q.inputTokens ?? "?")} input / ${html(q.outputTokens ?? "?")} output tokens.</p>
      <table class="matchers"><thead><tr><th>Dimension</th><th>Score / 5</th><th>Reason and evidence</th></tr></thead><tbody>${q.scores.map((s) => `<tr><td>${html(s.dimension)}</td><td>${s.score}</td><td>${html(s.rationale)} ${s.evidence.map((id) => `<a href="#${html(ref(id))}">${html(id)}</a>`).join(" ")}</td></tr>`).join("")}</tbody></table>
      <details><summary>Judge configuration and accounting</summary><pre>${html(JSON.stringify(q, null, 2))}</pre></details>`
        : `<p>Not judged. Run the explicit judge command to add scores.</p>`
    }
    <h4>Approval timeline</h4><ol>${e.checkpoints.map((c) => `<li><a href="#${html(ref(c.id))}">${html(c.phase)}</a> · ${html(c.at)} · ${c.tasks.length} tasks · ${c.runs.length} runs</li>`).join("")}</ol>
    <h4>Resulting tasks and documents</h4><ul>${(last?.tasks ?? []).map((t) => `<li><a href="#${html(ref(`task-${t.id}`))}">${html(t.identifier ?? t.id)}: ${html(t.title)}</a> · ${html(t.status)}</li>`).join("")}</ul>
    ${(last?.tasks ?? [])
      .map(
        (t) =>
          `<details id="${html(ref(`task-${t.id}`))}"><summary>${html(t.title)} · ${html(t.status)}</summary><pre>${html(JSON.stringify(t, null, 2))}</pre>${(
            last?.documents ?? []
          )
            .filter((d) => d.issueId === t.id)
            .map(
              (d) =>
                `<details><summary>${html(d.key)} · ${html(d.title)}</summary><pre>${html(d.body)}</pre></details>`,
            )
            .join("")}</details>`,
      )
      .join("")}
    ${e.checkpoints.map((c) => `<details id="${html(ref(c.id))}"><summary>${html(c.id)} · ${html(c.at)}</summary><pre>${html(JSON.stringify(c, null, 2))}</pre></details>`).join("")}
  </details>`;
}
