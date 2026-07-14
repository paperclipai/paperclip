import type { KvStateSnapshot } from "./store.js";

export interface RenderOptions {
  token?: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderRows(snapshot: KvStateSnapshot): string {
  if (snapshot.entries.length === 0) {
    return `<tr class="empty"><td colspan="3">No values yet — call the <code>kv_set</code> tool to add one.</td></tr>`;
  }
  return snapshot.entries
    .map(
      (entry) => `<tr>
        <td class="key">${escapeHtml(entry.key)}</td>
        <td class="value">${escapeHtml(entry.value)}</td>
        <td class="updated">${escapeHtml(entry.updatedAt)}</td>
      </tr>`,
    )
    .join("\n");
}

/**
 * Render the values UI. The page server-renders the current snapshot and then
 * polls {@code GET /api/state} so the table reflects tool writes without a manual
 * refresh.
 */
export function renderStatePage(snapshot: KvStateSnapshot, options: RenderOptions = {}): string {
  const token = options.token?.trim() || "";
  const stateUrl = token ? `/api/state?token=${encodeURIComponent(token)}` : "/api/state";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>KV Demo MCP Server</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
  .meta { color: #6b7280; margin: 0 0 1.5rem; }
  .meta strong { color: inherit; }
  table { border-collapse: collapse; width: 100%; max-width: 960px; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  th { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7280; }
  td.key { font-weight: 600; }
  td.value { white-space: pre-wrap; word-break: break-word; }
  td.updated { color: #6b7280; white-space: nowrap; }
  tr.empty td { color: #6b7280; font-style: italic; }
  code { background: rgba(127,127,127,0.18); padding: 0.05rem 0.3rem; border-radius: 4px; }
</style>
</head>
<body>
  <h1>KV Demo MCP Server</h1>
  <p class="meta">In-memory values for this process. <strong id="count">${snapshot.count}</strong> key(s), revision <strong id="revision">${snapshot.revision}</strong>. <span id="status">Auto-refreshing every 2s.</span></p>
  <table>
    <thead><tr><th>Key</th><th>Value</th><th>Updated</th></tr></thead>
    <tbody id="rows">
${renderRows(snapshot)}
    </tbody>
  </table>
  <script>
    const STATE_URL = ${JSON.stringify(stateUrl)};
    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      })[ch]);
    }
    function render(state) {
      document.getElementById("count").textContent = state.count;
      document.getElementById("revision").textContent = state.revision;
      const rows = document.getElementById("rows");
      if (!state.entries.length) {
        rows.innerHTML = '<tr class="empty"><td colspan="3">No values yet — call the <code>kv_set</code> tool to add one.</td></tr>';
        return;
      }
      rows.innerHTML = state.entries.map((entry) =>
        '<tr><td class="key">' + escapeHtml(entry.key) +
        '</td><td class="value">' + escapeHtml(entry.value) +
        '</td><td class="updated">' + escapeHtml(entry.updatedAt) + '</td></tr>'
      ).join("");
    }
    async function refresh() {
      const status = document.getElementById("status");
      try {
        const res = await fetch(STATE_URL, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error("HTTP " + res.status);
        render(await res.json());
        status.textContent = "Auto-refreshing every 2s.";
      } catch (err) {
        status.textContent = "Refresh failed: " + err.message;
      }
    }
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;
}
