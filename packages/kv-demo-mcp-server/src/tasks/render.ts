import type { DemoState } from "./store.js";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function time(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

/**
 * A plain status page: every task, how many times each tool was started, and
 * the latest protocol events. It reloads itself every two seconds.
 */
export function renderTasksPage(state: DemoState | null, now: number): string {
  const body = state === null
    ? `<p>This server requires a token, so its state is not shown here. Read <code>/api/state</code> with the token instead.</p>`
    : `
<h2>Tasks</h2>
<table>
  <thead><tr><th>Tool</th><th>Status</th><th>Created</th><th>Checks</th><th>TTL left</th><th>Task ID</th></tr></thead>
  <tbody>${state.tasks.length === 0
    ? `<tr><td colspan="6">No tasks yet. Ask an agent to call <code>slow_report</code>.</td></tr>`
    : [...state.tasks].reverse().map((task) => `<tr>
    <td>${escapeHtml(task.tool)}</td>
    <td class="status ${escapeHtml(task.status)}">${escapeHtml(task.status)}</td>
    <td>${time(task.createdAt)}</td>
    <td>${task.polls}</td>
    <td>${Math.max(0, Math.round((task.createdAt + task.ttlMs - now) / 1000))} s</td>
    <td><code>${escapeHtml(task.taskId)}</code></td>
  </tr>`).join("")}</tbody>
</table>
<h2>Times each tool was started (<code>tools/call</code>)</h2>
<p>${Object.entries(state.toolCalls).map(([tool, count]) => `<code>${escapeHtml(tool)}</code>: ${count}`).join(" · ") || "none yet"}</p>
<h2>Latest events</h2>
<table>
  <thead><tr><th>Time</th><th>Event</th><th>Tool</th><th>Detail</th></tr></thead>
  <tbody>${[...state.events].reverse().slice(0, 60).map((event) => `<tr>
    <td>${time(event.at)}</td><td><code>${escapeHtml(event.method)}</code></td><td>${escapeHtml(event.tool ?? "")}</td><td>${escapeHtml(event.detail)}</td>
  </tr>`).join("")}</tbody>
</table>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="2">
<title>MCP Tasks demo</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 24px; color: #1a1a1a; background: #fff; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 16px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #e5e5e5; }
  .status.completed { color: #15803d; } .status.failed { color: #b91c1c; }
  .status.cancelled { color: #6b7280; } .status.input_required { color: #b45309; }
  @media (prefers-color-scheme: dark) { body { color: #eee; background: #111; } th, td { border-color: #333; } }
</style>
</head>
<body>
<h1>MCP Tasks demo server</h1>
<p>MCP endpoint: <code>/mcp</code> (protocol 2026-07-28, extension <code>io.modelcontextprotocol/tasks</code>). This page reloads every 2 seconds.</p>
${body}
</body>
</html>`;
}
