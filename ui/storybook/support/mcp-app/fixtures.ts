import type { McpAppViewDetail, McpAppViewSummary } from "@paperclipai/shared";

/**
 * A self-contained MCP Apps view that follows the 2026-01-26 protocol by hand:
 * ui/initialize → ui/notifications/initialized → tool-input/tool-result, then
 * size-changed, tools/call and ui/open-link. It stands in for a provider's
 * meeting-card view; the markup is original fixture content.
 */
export const MEETING_CARDS_VIEW_HTML = String.raw`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root { color-scheme: light dark; font-family: var(--font-sans, system-ui, sans-serif); }
  body { margin: 0; padding: 8px 12px; background: transparent; color: var(--color-text-primary, CanvasText); }
  .row { display: flex; align-items: center; gap: 12px; padding: 8px 4px; border-radius: 8px; cursor: pointer; }
  .row:hover { background: var(--color-background-secondary, rgba(127,127,127,.12)); }
  .avatar { width: 32px; height: 32px; border-radius: 999px; display: grid; place-items: center; font-size: 12px; font-weight: 600; color: #fff; background: #b9655a; flex: none; }
  .text { min-width: 0; flex: 1; }
  .name { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .who { font-size: 12px; color: var(--color-text-secondary, GrayText); }
  .tag { font-size: 12px; padding: 2px 8px; border: 1px solid var(--color-border-primary, rgba(127,127,127,.4)); border-radius: 999px; white-space: nowrap; }
  .date { font-size: 12px; color: var(--color-text-secondary, GrayText); width: 64px; text-align: right; }
  .actions { padding: 6px 4px 2px; }
  button { font: inherit; font-size: 12px; background: none; border: 1px solid var(--color-border-primary, rgba(127,127,127,.4)); color: inherit; border-radius: 6px; padding: 2px 8px; cursor: pointer; }
  .status { font-size: 12px; color: var(--color-text-secondary, GrayText); margin-left: 8px; }
</style>
</head>
<body>
<div id="list"><div class="who">Waiting for the meeting list…</div></div>
<div class="actions"><button id="refresh" type="button">Refresh</button><span class="status" id="status"></span></div>
<script>
  let nextId = 1;
  const pending = new Map();
  function request(method, params) {
    const id = nextId++;
    parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }
  function notify(method, params) { parent.postMessage({ jsonrpc: "2.0", method, params }, "*"); }
  function applyContext(context) {
    if (!context) return;
    if (context.theme) document.documentElement.style.colorScheme = context.theme;
    const vars = context.styles && context.styles.variables;
    if (vars) for (const key of Object.keys(vars)) document.documentElement.style.setProperty(key, vars[key]);
  }
  function initials(name) { return name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }
  function render(result) {
    const meetings = (result && result.structuredContent && result.structuredContent.meetings) || [];
    const list = document.getElementById("list");
    list.innerHTML = "";
    for (const meeting of meetings) {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = '<div class="avatar"></div><div class="text"><div class="name"></div><div class="who"></div></div><span class="tag"></span><span class="date"></span>';
      row.querySelector(".avatar").textContent = initials(meeting.organizer);
      row.querySelector(".name").textContent = meeting.name;
      row.querySelector(".who").textContent = meeting.attendees;
      row.querySelector(".tag").textContent = meeting.tag;
      row.querySelector(".date").textContent = meeting.when;
      row.addEventListener("click", () => request("ui/open-link", { url: meeting.url }));
      list.appendChild(row);
    }
    if (!meetings.length) list.innerHTML = '<div class="who">No meetings</div>';
    reportSize();
  }
  function reportSize() { notify("ui/notifications/size-changed", { height: Math.ceil(document.body.getBoundingClientRect().height) }); }
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id); pending.delete(message.id);
      message.error ? entry.reject(message.error) : entry.resolve(message.result);
      return;
    }
    if (message.method === "ui/notifications/tool-result") render(message.params);
    if (message.method === "ui/notifications/host-context-changed") applyContext(message.params);
    if (message.method === "ui/resource-teardown") parent.postMessage({ jsonrpc: "2.0", id: message.id, result: {} }, "*");
  });
  document.getElementById("refresh").addEventListener("click", async () => {
    const status = document.getElementById("status");
    status.textContent = "Refreshing…";
    try {
      const result = await request("tools/call", { name: "RefreshMeetingCards", arguments: {} });
      render(result);
      status.textContent = result.isError ? "Refresh failed" : "Updated";
    } catch (error) {
      status.textContent = (error && error.message) || "Refresh failed";
    }
    reportSize();
  });
  request("ui/initialize", { protocolVersion: "2026-01-26", appCapabilities: { availableDisplayModes: ["inline"] }, clientInfo: { name: "meeting-cards-fixture", version: "1" } })
    .then((result) => { applyContext(result.hostContext); notify("ui/notifications/initialized", {}); reportSize(); });
</script>
</body>
</html>`;

export const MEETINGS = [
  { id: "m1", name: "Paperclip/Tom", organizer: "Tom Drummond", attendees: "Tom Drummond, you, and 2 others", tag: "External / Vendor", when: "Yesterday", url: "https://app.circleback.ai/meetings/m1" },
  { id: "m2", name: "Paperclip <> Heavybit, Partner Meeting", organizer: "Tom Drummond", attendees: "Tom Drummond, you, and 2 others", tag: "3 tags", when: "Tue", url: "https://app.circleback.ai/meetings/m2" },
];

export const ISSUE_ID = "11111111-1111-4111-8111-111111111111";
export const RUN_ID = "22222222-2222-4222-8222-222222222222";

export const MEETINGS_VIEW_SUMMARY: McpAppViewSummary = {
  id: "33333333-3333-4333-8333-333333333333",
  issueId: ISSUE_ID,
  runId: RUN_ID,
  connectionId: "44444444-4444-4444-8444-444444444444",
  applicationName: "Circleback",
  toolName: "mcp.circleback-44444444:displaymeetings",
  upstreamToolName: "DisplayMeetings",
  resourceUri: "ui://circleback/meetings.html",
  toolInput: { meetingIds: ["m1", "m2"] },
  createdAt: "2026-11-12T15:00:00.000Z",
};

export const MEETINGS_VIEW_DETAIL: McpAppViewDetail = {
  ...MEETINGS_VIEW_SUMMARY,
  toolResult: {
    content: [{ type: "text", text: "Showing 2 meetings as cards." }],
    structuredContent: { meetings: MEETINGS },
  },
  resource: {
    uri: "ui://circleback/meetings.html",
    html: MEETING_CARDS_VIEW_HTML,
    csp: {},
    permissions: {},
    prefersBorder: true,
  },
};

