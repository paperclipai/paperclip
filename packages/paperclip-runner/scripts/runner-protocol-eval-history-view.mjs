import { compareCampaignAnalytics } from "./runner-protocol-eval-metrics.mjs";

const escape = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const date = (value) => new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value));
const percentage = (run) => run.totals.selected ? 100 * run.totals.passed / run.totals.selected : null;
const dollars = (value) => `$${(value / 1e9).toFixed(6)}`;

export function costLabel(costs, field = "estimated") {
  const metric = costs?.[field];
  if (!Number.isFinite(metric?.nanodollars) || metric.nanodollars < 0) return "Unknown";
  const incomplete = metric.recordedAttempts < costs.attempts;
  return `${incomplete ? "≥ " : ""}${dollars(metric.nanodollars)}`;
}

function costCell(costs) {
  const coverage = costs?.estimated?.recordedAttempts ?? 0;
  const attempts = costs?.attempts ?? 0;
  return `<strong>${escape(costLabel(costs))}</strong><small>Estimated · ${coverage}/${attempts} entries</small><small>Provider list: ${escape(costLabel(costs, "providerReported"))}</small><small>${costs?.scope === "all_attempts" ? "All attempts, including retries" : "Historical final attempts only"}</small>`;
}

function commit(repository, sha, label) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) return `<small>${label}: unknown</small>`;
  return `<small>${label}: <a href="https://github.com/${repository}/commit/${sha}" title="${sha}"><code>${sha.slice(0, 8)}</code></a></small>`;
}

function sourceLinks(run) {
  const url = run.source?.workflowRunUrl;
  const workflow = /^https:\/\/github\.com\/paperclipai\/paperclip\/actions\/runs\/[1-9][0-9]*$/.test(url ?? "")
    ? `<small><a href="${url}">GitHub Actions ↗</a></small>` : "";
  return `${commit("paperclipai/paperclip", run.source?.paperclip?.sha, "Paperclip")}${commit("paperclipai/paperclip-evals", run.source?.evals?.sha, "Evals")}${workflow}<small>${escape(run.source?.paperclip?.ref ?? "")}</small>`;
}

function chart(runs, analytics, kind, id) {
  const cost = kind === "cost";
  const label = cost ? "Estimated cost over time (USD)" : "Pass rate over time (%)";
  const values = runs.map((run) => cost ? analytics[run.campaignId]?.costs?.estimated?.nanodollars : percentage(run));
  const max = cost ? Math.max(1, ...values.filter(Number.isFinite)) : 100;
  const timestamps = runs.map((run) => Date.parse(run.generatedAt));
  const elapsed = timestamps.at(-1) - timestamps[0];
  const x = (index) => elapsed > 0 ? 48 + 504 * (timestamps[index] - timestamps[0]) / elapsed : 300;
  const y = (value) => 145 - value / max * 116;
  const scopes = cost ? ["all_attempts", "final_attempts"] : ["pass"];
  const series = scopes.map((scope) => {
    let drawing = false;
    const path = values.map((value, index) => {
      const present = Number.isFinite(value) && value >= 0 && (!cost || analytics[runs[index].campaignId]?.costs?.scope === scope);
      if (!present) { drawing = false; return ""; }
      const point = `${drawing ? "L" : "M"}${x(index).toFixed(2)},${y(value).toFixed(2)}`;
      drawing = true;
      return point;
    }).join(" ");
    return `<path class="trend-line ${scope}" d="${path}"/>`;
  }).join("");
  const points = values.map((value, index) => {
    if (!Number.isFinite(value) || value < 0) return "";
    const run = runs[index];
    const metric = analytics[run.campaignId];
    const description = `${date(run.generatedAt)} UTC · ${run.campaignId} · ${cost ? `${costLabel(metric?.costs)} (${metric?.costs?.scope})` : `${value.toFixed(1)}% (${run.totals.passed}/${run.totals.selected})`}`;
    return `<a href="${escape(run.publicUrl)}" aria-label="${escape(description)}"><circle class="trend-point ${cost ? metric?.costs?.scope : "pass"}" cx="${x(index).toFixed(2)}" cy="${y(value).toFixed(2)}" r="4"><title>${escape(description)}</title></circle></a>`;
  }).join("");
  const tick = (run) => `${run.generatedAt.slice(5, 16).replace("T", " ")} UTC`;
  return `<figure><figcaption>${label}</figcaption><svg class="trend-chart" viewBox="0 0 600 186" role="img" aria-labelledby="${id}"><title id="${id}">${label}. Each point links to its recorded run.</title><path class="trend-axis" d="M48,25V145H552"/><text x="40" y="33" text-anchor="end">${cost ? `$${(max / 1e9).toFixed(2)}` : "100%"}</text><text x="40" y="149" text-anchor="end">0</text>${series}${points}<text x="48" y="176">${escape(tick(runs[0]))}</text><text x="552" y="176" text-anchor="end">${escape(tick(runs.at(-1)))}</text></svg></figure>`;
}

function changeCell(run, analytics, previous) {
  if (run.reportRevision) return '<span class="muted">Presentation only</span>';
  if (!previous) return '<span class="muted">No matching baseline</span>';
  const change = compareCampaignAnalytics(analytics[run.campaignId], analytics[previous.campaignId]);
  if (!change) return '<span class="muted">Suite changed</span>';
  const failures = (cells, destination) => cells.map((cell) => `<li><a href="${escape(destination.publicUrl)}tests/${encodeURIComponent(cell.caseId)}.html">${escape(cell.caseId)}</a> · ${escape(cell.rosterId)}${cell.disposition === "infrastructure_failure" ? " · infrastructure" : ""}</li>`).join("");
  const counts = `${change.regressions.length} regressions · ${change.recoveries.length} recoveries`;
  return `<details><summary>${counts}</summary><small>Versus <a href="${escape(previous.publicUrl)}">${escape(previous.campaignId)}</a></small>${change.regressions.length ? `<strong>Previously passing → failing</strong><ul>${failures(change.regressions, run)}</ul>` : ""}${change.recoveries.length ? `<strong>Previously failing → passing</strong><ul>${failures(change.recoveries, run)}</ul>` : ""}</details>`;
}

export function renderProtocolEvalHistoryIndex(history, stylesheetHref) {
  if (!/^campaigns\/gha-[a-z0-9-]+\/viewer\/assets\/[A-Za-z0-9._-]+\.css$/.test(stylesheetHref ?? ""))
    throw new Error("History requires an immutable campaign's Runner Lab stylesheet");
  for (const run of history.campaigns) {
    if (!["selected", "passed", "behaviorFailures", "infrastructureFailures"].every((field) => Number.isSafeInteger(run.totals?.[field]) && run.totals[field] >= 0)
      || !run.rosters.every((roster) => Number.isSafeInteger(roster.selected) && Number.isSafeInteger(roster.passed)))
      throw new Error("History requires numeric recorded counts");
    const url = new URL(run.publicUrl);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("History report links must be credential-free HTTPS URLs");
  }
  const analytics = history.analytics ?? {};
  const presentations = new Map();
  for (const refresh of history.campaigns.filter((run) => run.reportRevision)
    .sort((a, b) => a.reportRevision.renderedAt.localeCompare(b.reportRevision.renderedAt)))
    presentations.set(refresh.reportRevision.sourceCampaignId, refresh);
  const measurements = history.campaigns.filter((run) => !run.reportRevision)
    .map((run) => presentations.has(run.campaignId)
      ? { ...run, originalPublicUrl: run.publicUrl, publicUrl: presentations.get(run.campaignId).publicUrl }
      : run)
    .sort((a, b) => a.generatedAt.localeCompare(b.generatedAt) || a.campaignId.localeCompare(b.campaignId));
  const groups = new Map();
  const baselines = new Map();
  for (const run of measurements) {
    const key = analytics[run.campaignId]?.suiteKey;
    if (!key || !run.complete) continue;
    const group = groups.get(key) ?? [];
    baselines.set(run.campaignId, group.at(-1));
    group.push(run);
    groups.set(key, group);
  }
  const ordered = [...groups.entries()].sort(([, a], [, b]) => b.at(-1).totals.selected - a.at(-1).totals.selected || b.at(-1).generatedAt.localeCompare(a.at(-1).generatedAt));
  const trends = ordered.map(([key, runs], index) => {
    const latest = runs.at(-1);
    return `<details class="trend-group" ${index === 0 ? "open" : ""}><summary>${latest.totals.selected} cells · ${latest.rosters.length} configurations · ${runs.length} recorded runs · evals ${escape(latest.source.evals.sha.slice(0, 8))}</summary><div class="trend-grid">${chart(runs, analytics, "pass", `pass-${key}`)}${chart(runs, analytics, "cost", `cost-${key}`)}</div><p class="muted">Cost: solid cyan includes retries; dashed purple is historical final-attempt cost. Missing cost is a gap, not zero. Hover or select a point to inspect its run.</p></details>`;
  }).join("") || '<p class="muted">Comparable run metadata has not been recorded yet.</p>';
  const row = (run) => {
    const metric = analytics[run.reportRevision?.sourceCampaignId ?? run.campaignId];
    const status = !run.complete ? "incomplete" : run.allPassed ? "passed" : "failed";
    const models = run.rosters.map((roster) => `<li>${escape(roster.model)} · ${roster.passed}/${roster.selected}<small>${escape(roster.driver)} · ${escape(roster.rosterId)}</small></li>`).join("");
    const scope = metric?.selection === "maintained_full" ? "Full maintained suite" : metric?.selection === "subset" ? "Selected subset" : `${run.totals.selected} recorded cells`;
    return `<tr><td><a href="${escape(run.publicUrl)}"><code>${escape(run.campaignId)}</code></a><small>${escape(date(run.generatedAt))} UTC</small>${run.reportRevision ? `<small>Report refresh · no new model calls · source ${escape(run.reportRevision.sourceCampaignId)}</small>` : `<small>${scope}</small>`}<small><a href="${escape(run.publicUrl)}">Open Evalbook →</a></small></td><td><span class="status ${status}">${status}</span><strong class="pass-rate">${run.totals.passed}/${run.totals.selected} · ${percentage(run)?.toFixed(1) ?? "—"}%</strong><small>${run.totals.behaviorFailures} behavior · ${run.totals.infrastructureFailures} infrastructure</small><details><summary>${run.rosters.length} model configurations</summary><ul>${models}</ul></details></td><td>${changeCell(run, analytics, baselines.get(run.campaignId))}</td><td>${run.reportRevision ? '<small>No additional model cost</small>' : costCell(metric?.costs)}</td><td>${sourceLinks(run)}</td></tr>`;
  };
  const table = (runs) => `<div class="table history-table" role="region" aria-label="Recorded eval runs" tabindex="0"><table><thead><tr><th>Run</th><th>Pass / fail</th><th>Change vs matching suite</th><th>Cost (USD)</th><th>Exact source</th></tr></thead><tbody>${runs.map(row).join("") || '<tr><td colspan="5">No campaigns have been published yet.</td></tr>'}</tbody></table></div>`;
  const refreshes = history.campaigns.filter((run) => run.reportRevision);
  const latest = measurements.find((run) => run.campaignId === history.latestCampaignId);
  const green = measurements.find((run) => run.campaignId === history.latestGreenCampaignId);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Runner protocol eval campaigns · Paperclip</title><link rel="stylesheet" href="${escape(stylesheetHref)}"></head><body class="evalbook-site"><main><header class="top"><a href="index.html">paperclip-runner evals</a><span class="badge">Run history</span></header><h1>Runner protocol eval campaigns</h1><p class="muted">Every recorded campaign, its cost, and its exact source. Public chat replays are linked below; full provider evidence remains in access-controlled workflow artifacts.</p><nav class="pointers">${latest ? `<a href="${escape(latest.publicUrl)}">Latest · ${escape(latest.campaignId)}</a>` : ""}${green ? `<a href="${escape(green.publicUrl)}">Latest green · ${escape(green.campaignId)}</a>` : ""}<a href="history.json">Download history JSON</a></nav><h2>Like-for-like trends</h2><p class="muted">Only identical cells, model configurations, and eval-suite SHAs are compared. A changed suite starts a separate series. Report refreshes never count as new measurements. Regressions distinguish model behavior from infrastructure failures.</p>${trends}<h2>All runs · ${measurements.length}</h2><p class="muted">Estimated cost and provider list cost are alternatives, not additive. ≥ means some entries lack usage. Historical final-only cost excludes retry spending. Commit links expose the full SHA on hover.</p>${table([...measurements].reverse())}${refreshes.length ? `<details><summary>Report refreshes · ${refreshes.length} (no new measurements)</summary>${table(refreshes)}</details>` : ""}<footer>Updated ${escape(date(history.updatedAt))} UTC · All run records retained · Immutable campaign bundles</footer></main></body></html>`;
}
