import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, "wireframes");
mkdirSync(out, { recursive: true });
mkdirSync(join(root, "screenshots"), { recursive: true });

const screens = [
  {
    id: "01", slug: "connectors-catalog", title: "Connectors", subtitle: "Connect tools and places where people talk to agents.", context: "Apps", active: "Connectors", kind: "catalog",
    panels: [
      ["Slack", "Tools: 1 account", "Channels: Maya bot · Active", "Add account"],
      ["Microsoft Teams", "Tools: Not connected", "Channels: Available", "Connect"],
      ["Discord", "Tools: Not available", "Channels: Preview", "Connect"],
      ["Telegram", "Tools: Not available", "Channels: 2 bots", "Manage"],
      ["GitHub", "Tools: 1 app", "Channels: Available", "Connect"],
    ],
    notes: ["Filter by Tools, Channels, or Connected.", "Slack, Teams, Discord, Telegram, and GitHub form the initial supported set.", "Maturity and deployment state control the available action."],
  },
  {
    id: "02", slug: "connection-method", title: "Connect Slack", subtitle: "Choose how Slack and Paperclip should communicate.", context: "Apps", active: "Setup", kind: "choice",
    panels: [
      ["Agent uses Slack", "Give selected agents Slack tools.", "Agents call Slack during Paperclip runs.", "Uses tool permissions and grants."],
      ["People talk to an agent", "Install one Paperclip agent as a Slack bot.", "Messages become Paperclip task turns.", "Uses channel identity and access rules."],
      ["Separate connections", "These methods do not share credentials.", "Choose the direction before setup.", "Recommended: channel connection"],
    ],
    notes: ["Two directions are named before credentials are requested.", "The channel method binds one bot to one Paperclip agent.", "Credentials and permissions remain independent."],
  },
  {
    id: "03", slug: "choose-agent-identity", title: "Choose the agent", subtitle: "This Slack bot will always represent one Paperclip agent.", context: "Apps", active: "Setup", kind: "wizard", step: "Step 1 of 7 · Agent & identity",
    panels: [
      ["Paperclip agent", "Maya · Support lead", "Active · Codex runtime", "Change agent"],
      ["Slack bot preview", "Maya", "@maya-support", "Avatar from agent profile"],
      ["One bot per agent", "Add another Slack app for another agent.", "Native mentions select the agent.", "No hidden dispatcher bot."],
    ],
    notes: ["Only active, invokable agents can be selected.", "Provider bot identity is previewed beside the Paperclip agent.", "Multiple agents require multiple native bot identities."],
  },
  {
    id: "04", slug: "provider-installation", title: "Install the Slack bot", subtitle: "Bring your own Slack app and verify every connection layer.", context: "Apps", active: "Setup", kind: "wizard", step: "Step 2 of 7 · Provider installation",
    panels: [
      ["1 · Create the app", "Open generated Slack manifest", "Install or reinstall to workspace", "Invite @maya-support to a channel"],
      ["2 · Save credentials", "Bot token · Secret reference", "Signing secret · Secret reference", "Values are hidden after save"],
      ["3 · Verify", "Bot identity · Passed", "Webhook signature · Passed", "Scopes · 1 action needed"],
    ],
    notes: ["BYO app setup is the required release path.", "Secrets are stored as Paperclip secret references.", "Credential, signature, scope, and reachability checks are separate."],
  },
  {
    id: "05", slug: "conversation-reach", title: "Choose where Maya listens", subtitle: "Allow exact resources and make activation behavior predictable.", context: "Apps", active: "Setup", kind: "wizard", step: "Step 3 of 7 · Conversation reach",
    panels: [
      ["Allowed channels", "#customer-support · On", "#product-feedback · On", "+ Add exact channel"],
      ["Thread activation", "Mention Maya in the channel root", "Bot opens thread + one issue", "Continue in thread without mentions"],
      ["Direct messages", "One task per Slack DM thread", "Proactive DMs: Off", "Linked users and guests allowed"],
    ],
    notes: ["Resource ids, not display names, enforce reach.", "Root mention → native thread → one Paperclip issue is the thread-capable default.", "GitHub binds an existing thread; Telegram uses its stable chat or topic."],
  },
  {
    id: "06", slug: "people-permissions", title: "Choose who people act as", subtitle: "Every external message receives a bounded Paperclip identity.", context: "Apps", active: "Setup", kind: "wizard", step: "Step 4 of 7 · People & permissions",
    panels: [
      ["Endpoint sponsor", "Dana · Company admin", "Provides a maximum authority envelope", "Change sponsor"],
      ["Linked people", "Act as their Paperclip user", "Current permissions checked each action", "Invite identity link"],
      ["Unlinked people", "Sponsored restricted guest", "May message this task and attach files", "Cannot govern, approve, hire, or reassign"],
    ],
    notes: ["The endpoint sponsor is visible before activation.", "Linked users are reauthorized with current permissions.", "Guest authority is an intersection and excludes governance."],
  },
  {
    id: "07", slug: "output-interactions", title: "Choose channel behavior", subtitle: "Expose useful progress without exposing Paperclip internals.", context: "Apps", active: "Setup", kind: "wizard", step: "Step 5 of 7 · Output & interactions",
    panels: [
      ["Acknowledgement & progress", "React with eyes when supported", "Safe milestones: On", "Update every 4 seconds at most"],
      ["Rich output", "Final text, approved files, cards", "Buttons, dropdowns, modals: On", "Unsupported: text + Paperclip link"],
      ["Overlapping messages", "Queue messages on this task", "Other modes: Burst · Debounce · Drop", "Concurrent mode requires explicit selection"],
    ],
    notes: ["Milestones never include reasoning or raw tool traces.", "Every rich feature has a named text/link fallback.", "Queue is the default concurrency policy."],
  },
  {
    id: "08", slug: "agent-routes", title: "Agent-to-agent routes", subtitle: "Let bots talk only through explicit directed routes.", context: "Apps", active: "Setup", kind: "wizard", step: "Step 6 of 7 · Agent routes",
    panels: [
      ["Agent routing", "Off by default", "Bot messages are ignored", "Enable with a directed route"],
      ["Allowed route", "Maya in #support → Quinn in #engineering", "Trigger: Native mention only", "Maximum hops: 2"],
      ["Loop protection", "Suppress self and revisited endpoints", "Suppress repeated causal fingerprint", "Keep immutable route audit"],
    ],
    notes: ["A master default-off control prevents accidental bot loops.", "Routes are directed and resource-scoped.", "Hop, revisit, self, and fingerprint guards are mandatory."],
  },
  {
    id: "09", slug: "review-activate", title: "Review and activate", subtitle: "Verify the bot, its authority, and a real Slack message.", context: "Apps", active: "Setup", kind: "wizard", step: "Step 7 of 7 · Review & activate",
    panels: [
      ["Configuration", "Maya · @maya-support", "2 allowed channels · DMs on", "Sponsor: Dana · Guest profile: Restricted"],
      ["Required checks", "Credentials · Passed", "Webhook & signature · Passed", "Bot invited to #customer-support · Passed"],
      ["Live test", "1. Mention Maya in the channel root", "2. Bot opens thread + one issue", "3. Follow up there without a mention"],
    ],
    notes: ["Review summarizes identity, reach, permissions, and behavior.", "The live test proves activation and subscription behavior.", "BYO completion enables activation; managed install is optional."],
  },
  {
    id: "10", slug: "endpoint-overview", title: "Maya on Slack", subtitle: "See what is connected, whether it works, and what needs attention.", context: "Apps", active: "Overview", kind: "detail",
    panels: [
      ["Endpoint", "Agent: Maya · Support lead", "Bot: @maya-support", "Workspace: Acme"],
      ["Health", "Provider credentials · Healthy", "Direct ingress · Healthy", "Last delivery · 2 minutes ago"],
      ["Activity", "18 conversations · 7 active tasks", "24 linked people · 3 guests", "1 failed publication"],
    ],
    notes: ["Agent, bot, installation, and endpoint status stay together.", "Health separates credentials, ingress/relay, and delivery.", "Lifecycle controls sit near status; removal remains a danger action."],
  },
  {
    id: "11", slug: "endpoint-access", title: "Access", subtitle: "Manage where the bot listens and who external people represent.", context: "Apps", active: "Access", kind: "table",
    panels: [
      ["Resources", "#customer-support · Active", "#product-feedback · Active", "#private-escalations · Disabled"],
      ["People", "Ari S. → Ari Stone · Linked", "Jules P. → Sponsored guest", "build-bot → External bot · Routed"],
      ["Policy", "Sponsor: Dana", "Guest: Message + safe files", "Governance: Linked authorized users only"],
    ],
    notes: ["Resource status and exact provider identity remain visible.", "People rows distinguish linked users, guests, and bots.", "Revoke preserves historical attribution while stopping future authority."],
  },
  {
    id: "12", slug: "endpoint-behavior", title: "Behavior", subtitle: "Edit inbound, outbound, and interaction policies with fallbacks visible.", context: "Apps", active: "Behavior", kind: "detail",
    panels: [
      ["Inbound", "Root mention → bot thread", "One issue per endpoint thread", "Existing thread / chat fallback shown"],
      ["Outbound", "Acknowledge: Reaction → Ephemeral", "Safe milestones + final output", "Stream: Native → Post and edit"],
      ["Capabilities", "Files · Supported", "Cards/actions/modals · Supported", "Deletes · Append tombstone"],
    ],
    notes: ["Inbound settings name their task/run consequence.", "Outbound settings show provider fallback order.", "Saving creates a versioned policy with a change preview."],
  },
  {
    id: "13", slug: "conversations-tasks", title: "Conversations", subtitle: "Every bot-owned external thread maps to one Paperclip issue.", context: "Apps", active: "Conversations", kind: "table",
    panels: [
      ["#customer-support · Refund workflow", "PAP-1842 · In progress", "4 participants · 8m ago", "Subscribed"],
      ["DM with Ari Stone", "PAP-1839 · Waiting for input", "Linked user · 24m ago", "Subscribed"],
      ["#product-feedback · Import CSV", "PAP-1804 · Done", "Detached yesterday", "Open history"],
    ],
    notes: ["Rows pair one external thread with exactly one endpoint-owned Paperclip issue.", "Filters cover active, waiting, failed, detached, and DMs.", "Detach preserves history and unlocks assignment."],
  },
  {
    id: "14", slug: "deliveries-diagnostics", title: "Activity and deliveries", subtitle: "Diagnose accepted, ignored, retried, and failed external events.", context: "Apps", active: "Activity", kind: "table",
    panels: [
      ["Inbound mention", "Applied · PAP-1842", "event Ev04…91 · deduped once", "122 ms"],
      ["Outbound final", "Retrying · Slack rate limit", "publication Pb18…40 · attempt 2", "Retry in 28 seconds"],
      ["Button action", "Denied · User not linked", "action Ac77…10 · acknowledged", "Open redacted details"],
    ],
    notes: ["One ledger covers inbound, outbound, and interactive actions.", "Rows expose dedupe, attempt, timing, and task without payload secrets.", "Replay is idempotent and limited to eligible failures."],
  },
  {
    id: "15", slug: "agent-channels", title: "Maya · Channels", subtitle: "Every place this Paperclip agent can be reached.", context: "Agent", active: "Channels", kind: "agent",
    panels: [
      ["Slack · @maya-support", "Acme · 2 allowed channels", "Healthy · Root mention opens thread", "7 active tasks"],
      ["Telegram · @maya_helper_bot", "Support group + DMs", "Needs attention · Token expires", "3 active tasks"],
      ["Recent channel tasks", "PAP-1842 · Refund workflow", "PAP-1839 · Ari DM", "PAP-1827 · Product question"],
    ],
    notes: ["Channels sits under Runtime in agent navigation.", "Endpoint cards retain platform identity, reach, health, and trigger policy.", "Add channel starts Apps with this agent preselected."],
  },
  {
    id: "16", slug: "bound-task", title: "Refund workflow is failing", subtitle: "PAP-1842 · Externally bound to Maya on Slack.", context: "Task", active: "Task", kind: "task",
    panels: [
      ["Slack · #customer-support", "Thread: Refund workflow", "Assigned agent locked to Maya", "Open Slack · Manage connection"],
      ["Ari S. · External participant", "The refund step is timing out again.", "Linked as Ari Stone", "8 minutes ago"],
      ["Maya · Agent output", "I found the failing retry boundary…", "Publication: Delivered to Slack", "Artifact: retry-analysis.md"],
    ],
    notes: ["A source banner explains the binding and assignment lock.", "External attribution never impersonates a Paperclip user.", "The composer defaults internal; Send to channel is explicit and previewed."],
  },
  {
    id: "17", slug: "identity-link", title: "Link your Slack identity", subtitle: "Confirm who you will act as when messaging Maya.", context: "Identity", active: "Link", kind: "link",
    panels: [
      ["Slack identity", "Ari S. · Acme workspace", "Requested by @maya-support", "Expires in 9 minutes"],
      ["Paperclip identity", "Ari Stone · ari@acme.example", "Company: Acme", "Signed in"],
      ["After linking", "Future actions use current permissions", "This does not share Slack credentials", "You can revoke from endpoint Access"],
    ],
    notes: ["Both identities and company are visible before confirmation.", "Authentication returns to the same single-use intent.", "Expired, used, revoked, and mismatch states fail safely."],
  },
  {
    id: "18", slug: "self-hosted-relay", title: "Ingress for this instance", subtitle: "Use direct HTTPS or an outbound relay for a private Paperclip.", context: "Apps", active: "Overview", kind: "relay",
    panels: [
      ["Direct HTTPS", "Recommended when Paperclip is public", "Provider sends to this instance", "Current: Not reachable"],
      ["Outbound relay", "Private instance opens one connection", "Encrypted bounded delivery envelopes", "Current: Connected"],
      ["Relay health", "Owner: chat-adapters-dev", "Heartbeat: 12 seconds ago", "Backlog: 0 · Key rotated 8d ago"],
    ],
    notes: ["Mode comparison starts with detected reachability.", "Enrollment reveals a one-time secret only once.", "Health distinguishes relay receipt from Paperclip processing."],
  },
  {
    id: "19", slug: "adapter-state-matrix", title: "Adapter and state matrix", subtitle: "One UI system covers provider shapes and operational fallbacks.", context: "Apps", active: "Reference", kind: "matrix",
    panels: [
      ["Workspace apps", "Slack · Teams · Discord · Google Chat", "App registration + tenant + webhook", "Rich interactions and streaming vary"],
      ["Comments and messaging", "GitHub · Linear · Notion · Telegram", "Token/app + resource allowlist", "Thread and mention rules vary"],
      ["Phone, social, and email", "WhatsApp · Twilio · X · Resend · iMessage", "Sender identity + webhook", "Media, window, and rate limits vary"],
    ],
    notes: ["Provider taxonomy drives setup fields without cloning the wizard.", "Capability rows name supported, fallback, and unavailable behavior.", "Shared states cover loading, empty, degraded, denied, rate-limited, revoked, and dead letter."],
  },
];

const uiSurfaceSpec = readFileSync(join(root, "2026-09-03-chat-adapters-ui-surfaces.md"), "utf8");
const annotationMap = new Map(
  [...uiSurfaceSpec.matchAll(/### (\d{2})[^\n]*\n\nPurpose:[^\n]*\n\n((?:\d+\.[^\n]*\n){5})/g)].map((match) => [
    match[1],
    match[2].trim().split("\n").map((line) => line.replace(/^\d+\.\s*/, "")),
  ]),
);

for (const screen of screens) {
  screen.annotations = annotationMap.get(screen.id);
  if (!screen.annotations || screen.annotations.length !== 5) {
    throw new Error(`Expected five documented annotations for screen ${screen.id}`);
  }
}

const esc = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const text = (x, y, value, size = 14, fill = "#000", extra = "") =>
  `<text x="${x}" y="${y}" font-size="${size}" stroke="none" fill="${fill}" ${extra}>${esc(value)}</text>`;

const multiline = (x, y, lines, size = 14, fill = "#666", gap = 24) =>
  lines.map((line, index) => text(x, y + index * gap, line, size, fill)).join("\n");

function wrapWords(value, maxCharacters = 48) {
  const lines = [];
  let current = "";
  for (const word of value.split(" ")) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharacters && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 2);
}

const mobileSubtitle = (y, value) => multiline(16, y, wrapWords(value), 12, "#666", 16);

function desktopSidebar(screen) {
  const appItems = screen.context === "Agent"
    ? ["Overview", "Instructions", "Skills", "Runtime", "Secrets", "Tools", "Channels", "Permissions"]
    : screen.context === "Task"
      ? ["Inbox", "Tasks", "Projects", "Agents", "Apps", "Activity"]
      : ["Connectors", "Review", "Setup", "Overview", "Access", "Behavior", "Conversations", "Activity"];
  return `
  <g data-region="navigation">
    <rect x="0" y="0" width="240" height="800" />
    ${text(24, 40, "Paperclip", 20, "#000", 'font-weight="600"')}
    ${text(24, 72, screen.context, 12, "#666", 'font-weight="600"')}
    ${appItems.map((item, i) => {
      const y = 96 + i * 48;
      const active = item === screen.active;
      return `${active ? `<rect x="8" y="${y - 24}" width="224" height="40" rx="4" fill="#e6e6e6" />` : ""}${text(24, y, item, 14, active ? "#000" : "#666", active ? 'font-weight="600"' : "")}`;
    }).join("\n")}
    ${text(24, 760, "Acme Company", 14, "#000", 'font-weight="600"')}
    ${text(24, 784, "Operator", 12, "#666")}
  </g>
  <g data-region="topbar">
    <line x1="240" y1="64" x2="1280" y2="64" />
    ${text(264, 40, `${screen.context} / ${screen.title}`, 14, "#666")}
    <circle cx="1240" cy="32" r="16" fill="#e6e6e6" />
  </g>`;
}

function annotations(regions, mobile = false) {
  return `<g data-region="annotations">${regions.map((r, index) => {
    const n = index + 1;
    const cx = r.x;
    const cy = r.y;
    return `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="4" fill="none" stroke="#d33" stroke-dasharray="6 3" />
      <circle cx="${cx}" cy="${cy}" r="${mobile ? 8 : 12}" fill="#fff" stroke="#d33" stroke-dasharray="4 2" />
      ${text(cx, cy + (mobile ? 4 : 4), n, 12, "#d33", 'font-weight="700" text-anchor="middle"')}`;
  }).join("\n")}</g>`;
}

function desktopCard(x, y, width, height, panel, index) {
  const [heading, ...lines] = panel;
  return `<g transform="translate(${x},${y})" data-region="panel-${index + 1}">
    <rect width="${width}" height="${height}" rx="8" />
    ${text(24, 40, heading, 20, "#000", 'font-weight="600"')}
    ${lines.map((line, i) => {
      const yy = 80 + i * 40;
      return `<line x1="24" y1="${yy - 16}" x2="${width - 24}" y2="${yy - 16}" stroke="#e6e6e6" />${text(24, yy + 4, line, 14, i === lines.length - 1 ? "#000" : "#666", i === lines.length - 1 ? 'font-weight="600"' : "")}`;
    }).join("\n")}
  </g>`;
}

function desktopGeneric(screen) {
  const contentX = 280;
  const width = 952;
  const cards = screen.panels.map((panel, i) => desktopCard(contentX + (i % 3) * 312, 224, 288, 288, panel, i)).join("\n");
  const step = screen.step ? text(contentX, 96, screen.step, 12, "#666", 'font-weight="600"') : "";
  const actions = screen.id === "10"
    ? `<g transform="translate(952,104)"><rect width="120" height="40" rx="4" />${text(60, 25, "Test", 14, "#000", 'text-anchor="middle"')}</g><g transform="translate(1088,104)"><rect width="120" height="40" rx="4" fill="#000" />${text(60, 25, "Pause", 14, "#fff", 'font-weight="600" text-anchor="middle"')}</g>`
    : screen.id === "09"
      ? `<g transform="translate(1040,104)"><rect width="168" height="40" rx="4" fill="#000" />${text(84, 25, "Activate channel", 14, "#fff", 'font-weight="600" text-anchor="middle"')}</g>`
      : screen.kind === "wizard"
        ? `<g transform="translate(1088,680)"><rect width="120" height="40" rx="4" fill="#000" />${text(60, 25, "Continue", 14, "#fff", 'font-weight="600" text-anchor="middle"')}</g><g transform="translate(952,680)"><rect width="120" height="40" rx="4" />${text(60, 25, "Back", 14, "#000", 'text-anchor="middle"')}</g>`
        : `<g transform="translate(1088,104)"><rect width="120" height="40" rx="4" fill="#000" />${text(60, 25, screen.id === "15" ? "Add channel" : "Save", 14, "#fff", 'font-weight="600" text-anchor="middle"')}</g>`;
  const lower = screen.kind === "table"
    ? `<g transform="translate(${contentX},544)"><rect width="928" height="136" rx="8" fill="#e6e6e6" />${text(24, 32, "Selected details", 14, "#000", 'font-weight="600"')}${multiline(24, 64, ["Exact provider and Paperclip identifiers", "Current state, last event, and safe operator actions", "Sensitive payload values remain redacted"], 12, "#666", 24)}</g>`
    : `<g transform="translate(${contentX},544)"><rect width="928" height="96" rx="8" fill="#e6e6e6" />${text(24, 32, screen.notes[0], 14, "#000", 'font-weight="600"')}${text(24, 64, screen.notes[1], 12, "#666")}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800" font-family="-apple-system, system-ui, sans-serif" fill="#fff" stroke="#000" stroke-width="1.5">
  <!-- ${screen.id} · ${esc(screen.title)} · Desktop 1280×800 -->
  <rect x="0" y="0" width="1280" height="800" />
  ${desktopSidebar(screen)}
  ${step}
  ${text(contentX, 136, screen.title, 28, "#000", 'font-weight="700"')}
  ${text(contentX, 168, screen.subtitle, 14, "#666")}
  ${actions}
  ${screen.kind === "wizard" ? `<line x1="${contentX}" y1="192" x2="1208" y2="192" /><line x1="${contentX}" y1="192" x2="${contentX + Number(screen.id) * 72}" y2="192" />` : ""}
  ${cards}
  ${lower}
  ${annotations([
    {x: 272, y: 88, w: 944, h: 112},
    {x: 272, y: 216, w: 304, h: 304},
    {x: 584, y: 216, w: 304, h: 304},
    {x: 896, y: 216, w: 320, h: 304},
    {x: 272, y: 536, w: 944, h: screen.kind === "table" ? 152 : 112},
  ])}
  </svg>`;
}

function desktopCatalog(screen) {
  const rows = screen.panels.map((panel, i) => {
    const y = 264 + i * 96;
    return `<g transform="translate(280,${y})"><rect width="928" height="80" rx="8" ${i === 0 ? 'fill="#e6e6e6"' : ""}/><rect x="16" y="16" width="48" height="48" rx="8" fill="#e6e6e6" />${text(80, 32, panel[0], 14, "#000", 'font-weight="600"')}${text(80, 56, `${panel[1]} · ${panel[2]}`, 12, "#666")}${text(888, 48, panel[3], 14, "#000", 'font-weight="600" text-anchor="end"')}</g>`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800" font-family="-apple-system, system-ui, sans-serif" fill="#fff" stroke="#000" stroke-width="1.5"><rect x="0" y="0" width="1280" height="800"/>${desktopSidebar(screen)}${text(280,128,screen.title,28,"#000",'font-weight="700"')}${text(280,160,screen.subtitle,14,"#666")}<g transform="translate(280,184)"><rect width="480" height="40" rx="20"/><circle cx="24" cy="20" r="8"/><line x1="32" y1="28" x2="40" y2="36"/>${text(48,25,"Search connectors",14,"#666")}</g><g transform="translate(784,184)"><rect width="424" height="40" rx="4"/>${text(16,25,"All     Tools     Channels     Connected",14,"#000")}</g>${rows}${annotations([{x:8,y:64,w:232,h:408},{x:272,y:176,w:944,h:56},{x:272,y:256,w:944,h:472},{x:272,y:448,w:944,h:80},{x:1072,y:256,w:144,h:472}])}</svg>`;
}

function desktopTask(screen) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800" font-family="-apple-system, system-ui, sans-serif" fill="#fff" stroke="#000" stroke-width="1.5"><rect width="1280" height="800"/>${desktopSidebar(screen)}${text(280,112,screen.title,28,"#000",'font-weight="700"')}${text(280,144,screen.subtitle,14,"#666")}<g transform="translate(280,176)"><rect width="928" height="88" rx="8" fill="#e6e6e6"/>${text(24,32,screen.panels[0][0],14,"#000",'font-weight="600"')}${text(24,56,screen.panels[0][1],12,"#666")}${text(24,76,screen.panels[0][2],12,"#666")}${text(888,48,"Open Slack",14,"#000",'font-weight="600" text-anchor="end"')}</g><g transform="translate(280,296)"><rect width="640" height="128" rx="8"/><circle cx="32" cy="32" r="16" fill="#e6e6e6"/>${text(64,32,screen.panels[1][0],14,"#000",'font-weight="600"')}${text(64,64,screen.panels[1][1],14,"#000")}${text(64,96,`${screen.panels[1][2]} · ${screen.panels[1][3]}`,12,"#666")}</g><g transform="translate(280,448)"><rect width="640" height="144" rx="8" fill="#e6e6e6"/><circle cx="32" cy="32" r="16" fill="#e6e6e6"/>${text(64,32,screen.panels[2][0],14,"#000",'font-weight="600"')}${text(64,64,screen.panels[2][1],14,"#000")}${text(64,96,screen.panels[2][2],12,"#666")}${text(64,120,screen.panels[2][3],12,"#666")}</g><g transform="translate(944,296)"><rect width="264" height="296" rx="8"/>${text(24,32,"Properties",20,"#000",'font-weight="600"')}${multiline(24,72,["Status · In progress","Assignee · Maya (locked)","Priority · High","Project · Support","Channel · Slack"],14,"#666",40)}<g transform="translate(24,232)"><rect width="216" height="40" rx="4"/>${text(108,25,"Detach channel",14,"#000",'text-anchor="middle"')}</g></g><g transform="translate(280,624)"><rect width="928" height="104" rx="8"/>${text(16,32,"Internal note",12,"#666")}<line x1="16" y1="56" x2="752" y2="56" stroke="#666"/><rect x="760" y="16" width="152" height="40" rx="4" fill="#000"/>${text(836,41,"Add comment",14,"#fff",'font-weight="600" text-anchor="middle"')}${text(16,88,"○ Send to channel · Preview required",12,"#000")}</g>${annotations([{x:272,y:168,w:944,h:104},{x:272,y:288,w:656,h:144},{x:272,y:440,w:656,h:160},{x:272,y:616,w:944,h:120},{x:936,y:288,w:280,h:312}])}</svg>`;
}

function desktopLink(screen) {
  const cards = screen.panels.map((p,i)=>desktopCard(280+i*312,248,288,248,p,i)).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800" font-family="-apple-system, system-ui, sans-serif" fill="#fff" stroke="#000" stroke-width="1.5"><rect width="1280" height="800"/>${text(48,48,"Paperclip",20,"#000",'font-weight="600"')}<circle cx="1232" cy="40" r="16" fill="#e6e6e6"/>${text(640,144,screen.title,28,"#000",'font-weight="700" text-anchor="middle"')}${text(640,176,screen.subtitle,14,"#666",'text-anchor="middle"')}${cards}<g transform="translate(488,544)"><rect width="304" height="48" rx="4" fill="#000"/>${text(152,30,"Confirm identity link",14,"#fff",'font-weight="600" text-anchor="middle"')}</g>${text(640,624,"Single use · Expires in 9 minutes · Revoke from endpoint Access",12,"#666",'text-anchor="middle"')}${annotations([{x:272,y:104,w:936,h:88},{x:272,y:240,w:304,h:264},{x:584,y:240,w:304,h:264},{x:480,y:536,w:320,h:64},{x:376,y:600,w:528,h:40}])}</svg>`;
}

function desktopMatrix(screen) {
  const rows = [
    ["Workspace app","Slack · Teams · Discord","Yes","Native/edit","Rich"],
    ["Comment system","GitHub · Linear · Notion","Yes","Edit","Link/card"],
    ["Bot token","Telegram","Yes","Draft/edit","Keyboard"],
    ["Meta messaging","WhatsApp · Messenger","DM","Post","Buttons"],
    ["Phone/iMessage","Twilio · Photon · Linq","DM","Post","Limited"],
    ["Social/email","X · Resend","Mixed","Post/edit","Mixed"],
  ];
  const body = rows.map((r,i)=>`<g transform="translate(280,${272+i*56})"><rect width="928" height="56" ${i%2?'fill="#e6e6e6"':''}/>${text(16,34,r[0],14,"#000",'font-weight="600"')}${text(200,34,r[1],14,"#666")}${text(520,34,r[2],14,"#666")}${text(640,34,r[3],14,"#666")}${text(792,34,r[4],14,"#666")}</g>`).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800" font-family="-apple-system, system-ui, sans-serif" fill="#fff" stroke="#000" stroke-width="1.5"><rect width="1280" height="800"/>${desktopSidebar(screen)}${text(280,128,screen.title,28,"#000",'font-weight="700"')}${text(280,160,screen.subtitle,14,"#666")}<g transform="translate(280,208)"><rect width="928" height="56" fill="#e6e6e6"/>${text(16,34,"Setup pattern",12,"#000",'font-weight="600"')}${text(200,34,"Providers",12,"#000",'font-weight="600"')}${text(520,34,"Mentions",12,"#000",'font-weight="600"')}${text(640,34,"Streaming",12,"#000",'font-weight="600"')}${text(792,34,"Interactions",12,"#000",'font-weight="600"')}</g>${body}<g transform="translate(280,632)"><rect width="928" height="88" rx="8"/>${text(24,32,"Shared operational states",14,"#000",'font-weight="600"')}${text(24,64,"Loading · Empty · Degraded · Denied · Unsupported fallback · Rate limited · Revoked · Dead letter",12,"#666")}</g>${annotations([{x:272,y:264,w:192,h:352},{x:784,y:200,w:432,h:416},{x:464,y:200,w:320,h:416},{x:272,y:200,w:192,h:64},{x:272,y:624,w:944,h:104}])}</svg>`;
}

function mobileHeader(screen) {
  return `<rect x="0" y="0" width="375" height="64"/><text x="16" y="40" font-size="14" font-weight="600" stroke="none" fill="#000">${esc(screen.context)}</text><text x="343" y="40" font-size="14" text-anchor="end" stroke="none" fill="#666">Menu</text>`;
}

function mobileCard(y, panel, index, compact = false) {
  const [heading, ...lines] = panel;
  const height = compact ? 120 : 144;
  return `<g transform="translate(16,${y})" data-region="panel-${index + 1}"><rect width="343" height="${height}" rx="8" ${index===0?'fill="#e6e6e6"':''}/>${text(16,32,heading,14,"#000",'font-weight="600"')}${lines.slice(0,3).map((line,i)=>text(16,64+i*24,line,12,i===2?"#000":"#666",i===2?'font-weight="600"':"")).join("\n")}</g>`;
}

function mobileGeneric(screen) {
  const start = screen.step ? 184 : 160;
  const compact = screen.panels.length > 3;
  const gap = compact ? 128 : 152;
  const cards = screen.panels.slice(0,4).map((p,i)=>mobileCard(start+i*gap,p,i,compact)).join("\n");
  const lastY = start + Math.min(screen.panels.length,4)*gap;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="375" height="812" viewBox="0 0 375 812" font-family="-apple-system, system-ui, sans-serif" fill="#fff" stroke="#000" stroke-width="1.5"><rect width="375" height="812"/>${mobileHeader(screen)}${screen.step?text(16,88,screen.step,12,"#666",'font-weight="600"'):""}${text(16,screen.step?120:104,screen.title,20,"#000",'font-weight="600"')}${mobileSubtitle(screen.step?144:128,screen.subtitle)}${cards}<g transform="translate(16,${Math.min(lastY,744)})"><rect width="343" height="48" rx="4" fill="#000"/>${text(171,30,screen.kind==="wizard"?"Continue":screen.id==="15"?"Add channel":"Save",14,"#fff",'font-weight="600" text-anchor="middle"')}</g>${annotations([{x:8,y:72,w:359,h:88},{x:8,y:start-8,w:359,h:160},{x:8,y:start+gap-8,w:359,h:160},{x:8,y:start+gap*2-8,w:359,h:160},{x:8,y:Math.min(lastY-8,736),w:359,h:64}],true)}</svg>`;
}

function mobileCatalog(screen) {
  const cards=screen.panels.map((panel,index)=>`<g transform="translate(16,${232+index*104})" data-region="provider-${index+1}"><rect width="343" height="96" rx="8" ${index===0?'fill="#e6e6e6"':''}/>${text(16,24,panel[0],14,"#000",'font-weight="600"')}${text(16,48,panel[1],12,"#666")}${text(16,68,panel[2],12,"#666")}${text(327,88,panel[3],12,"#000",'font-weight="600" text-anchor="end"')}</g>`).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="375" height="812" viewBox="0 0 375 812" font-family="-apple-system, system-ui, sans-serif" fill="#fff" stroke="#000" stroke-width="1.5"><rect width="375" height="812"/>${mobileHeader(screen)}${text(16,104,screen.title,20,"#000",'font-weight="600"')}${mobileSubtitle(128,screen.subtitle)}<g transform="translate(16,152)"><rect width="343" height="48" rx="24"/><circle cx="24" cy="24" r="8"/><line x1="32" y1="32" x2="40" y2="40"/>${text(48,30,"Search connectors",14,"#666")}</g>${text(16,216,"All     Tools     Channels     Connected",12,"#000",'font-weight="600"')}${cards}${annotations([{x:8,y:0,w:359,h:64},{x:8,y:144,w:359,h:88},{x:8,y:224,w:359,h:528},{x:24,y:488,w:184,h:32},{x:240,y:224,w:128,h:528}],true)}</svg>`;
}

function mobileTask(screen) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="375" height="812" viewBox="0 0 375 812" font-family="-apple-system, system-ui, sans-serif" fill="#fff" stroke="#000" stroke-width="1.5"><rect width="375" height="812"/>${mobileHeader(screen)}${text(16,96,"PAP-1842",12,"#666")}${text(16,128,screen.title,20,"#000",'font-weight="600"')}<g transform="translate(16,152)"><rect width="343" height="104" rx="8" fill="#e6e6e6"/>${text(16,32,"Slack · #customer-support",14,"#000",'font-weight="600"')}${text(16,56,"Assigned agent locked to Maya",12,"#666")}${text(16,80,"Open Slack · Manage connection",12,"#000",'font-weight="600"')}</g><g transform="translate(16,280)"><rect width="343" height="120" rx="8"/><circle cx="32" cy="32" r="16" fill="#e6e6e6"/>${text(56,32,"Ari S. · External participant",12,"#000",'font-weight="600"')}${text(16,72,"The refund step is timing out again.",14,"#000")}${text(16,96,"Linked as Ari Stone · 8m ago",12,"#666")}</g><g transform="translate(16,424)"><rect width="343" height="136" rx="8" fill="#e6e6e6"/>${text(16,32,"Maya · Agent output",12,"#000",'font-weight="600"')}${text(16,64,"I found the failing retry boundary…",14,"#000")}${text(16,96,"Delivered to Slack",12,"#666")}${text(16,120,"retry-analysis.md",12,"#000",'font-weight="600"')}</g><g transform="translate(16,584)"><rect width="343" height="136" rx="8"/>${text(16,32,"Internal note",12,"#666")}<line x1="16" y1="56" x2="327" y2="56" stroke="#666"/>${text(16,88,"○ Send to channel · Preview",12,"#000")}<rect x="207" y="80" width="120" height="40" rx="4" fill="#000"/>${text(267,105,"Comment",14,"#fff",'font-weight="600" text-anchor="middle"')}</g>${annotations([{x:8,y:144,w:359,h:120},{x:8,y:272,w:359,h:136},{x:8,y:416,w:359,h:152},{x:8,y:576,w:359,h:152},{x:200,y:648,w:152,h:64}],true)}</svg>`;
}

function mobileLink(screen) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="375" height="812" viewBox="0 0 375 812" font-family="-apple-system, system-ui, sans-serif" fill="#fff" stroke="#000" stroke-width="1.5"><rect width="375" height="812"/>${text(16,40,"Paperclip",14,"#000",'font-weight="600"')}${text(16,96,screen.title,20,"#000",'font-weight="600"')}${mobileSubtitle(120,screen.subtitle)}${screen.panels.map((p,i)=>mobileCard(152+i*152,p,i)).join("\n")}<g transform="translate(16,624)"><rect width="343" height="48" rx="4" fill="#000"/>${text(171,30,"Confirm identity link",14,"#fff",'font-weight="600" text-anchor="middle"')}</g>${text(187,704,"Single use · Expires in 9 minutes",12,"#666",'text-anchor="middle"')}${annotations([{x:8,y:72,w:359,h:56},{x:8,y:144,w:359,h:160},{x:8,y:296,w:359,h:160},{x:8,y:616,w:359,h:64},{x:8,y:688,w:359,h:40}],true)}</svg>`;
}

function mobileMatrix(screen) {
  const rows=[["Workspace apps","Slack · Teams · Discord"],["Comment systems","GitHub · Linear · Notion"],["Bot token","Telegram"],["Meta messaging","WhatsApp · Instagram"],["Phone/iMessage","Twilio · Photon · Linq"],["Social/email","X · Resend"]];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="375" height="812" viewBox="0 0 375 812" font-family="-apple-system, system-ui, sans-serif" fill="#fff" stroke="#000" stroke-width="1.5"><rect width="375" height="812"/>${mobileHeader(screen)}${text(16,104,screen.title,20,"#000",'font-weight="600"')}${mobileSubtitle(128,screen.subtitle)}${rows.map((r,i)=>`<g transform="translate(16,${160+i*72})"><rect width="343" height="64" rx="4" ${i%2?'fill="#e6e6e6"':''}/>${text(16,26,r[0],14,"#000",'font-weight="600"')}${text(16,50,r[1],12,"#666")}${text(327,38,"›",20,"#000",'text-anchor="end"')}</g>`).join("\n")}<g transform="translate(16,616)"><rect width="343" height="104" rx="8"/>${text(16,32,"Shared states",14,"#000",'font-weight="600"')}${text(16,56,"Loading · Empty · Degraded · Denied",12,"#666")}${text(16,80,"Rate limited · Revoked · Dead letter",12,"#666")}</g>${annotations([{x:8,y:152,w:176,h:448},{x:184,y:152,w:183,h:448},{x:8,y:152,w:359,h:232},{x:8,y:384,w:359,h:216},{x:8,y:608,w:359,h:120}],true)}</svg>`;
}

function flowSvg() {
  const cells = screens.map((s, i) => {
    const col = i % 5;
    const row = Math.floor(i / 5);
    const x = 48 + col * 240;
    const y = 96 + row * 168;
    return `<g transform="translate(${x},${y})"><rect width="192" height="112" rx="8" ${[8,9,14,15].includes(i)?'fill="#e6e6e6"':''}/><rect x="16" y="16" width="40" height="40" rx="4" fill="#e6e6e6"/>${text(72,32,s.id,12,"#666",'font-weight="600"')}${text(72,56,s.title.length>14?`${s.title.slice(0,14)}…`:s.title,14,"#000",'font-weight="600"')}${text(16,88,i<9?"SETUP":i<14?"MANAGE":"RELATED",12,"#666",'font-weight="600"')}</g>`;
  }).join("\n");
  const arrows=[];
  for(let i=0;i<screens.length-1;i++){
    const c=i%5,r=Math.floor(i/5); const nc=(i+1)%5,nr=Math.floor((i+1)/5);
    if(r===nr){const x=240+c*240,y=152+r*168;arrows.push(`<line x1="${x}" y1="${y}" x2="${x+32}" y2="${y}"/><polygon points="${x+32},${y} ${x+24},${y-8} ${x+24},${y+8}" fill="#000" stroke="none"/>`);}
  }
  arrows.push(`<path d="M 1008 208 C 1104 232, 1104 248, 48 264" fill="none" stroke="#000" stroke-dasharray="6 3"/>`);
  arrows.push(`<path d="M 768 544 C 768 640, 1008 640, 1008 600" fill="none" stroke="#000" stroke-dasharray="6 3"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800" font-family="-apple-system, system-ui, sans-serif" fill="#fff" stroke="#000" stroke-width="1.5"><rect width="1280" height="800"/>${text(48,40,"Chat adapters · Paperclip product flow",28,"#000",'font-weight="700"')}${text(48,72,"Solid arrows follow the primary review path; dashed arrows mark management, identity, relay, diagnostics, and detach branches.",14,"#666")}${cells}${arrows}${annotations([{x:40,y:88,w:1168,h:312},{x:40,y:416,w:1168,h:312}])}</svg>`;
}

function viewerHtml() {
  const templatePath = join(root, "../../../packages/skills-catalog/catalog/bundled/product/wireframe/assets/site-template.html");
  const template = readFileSync(templatePath, "utf8");
  const style = template.match(/<style>[\s\S]*?<\/style>/)?.[0];
  if (!style) throw new Error(`Could not read viewer styles from ${templatePath}`);

  const toc = screens.map((screen) =>
    `<a href="#s${screen.id}"><span class="num">${Number(screen.id)}</span>${esc(screen.title)}</a>`,
  ).join("\n");

  const sections = screens.map((screen) => {
    const notes = screen.annotations.map((note, index) =>
      `<li><b>${index + 1}</b> — ${esc(note).replaceAll("**", "")}</li>`,
    ).join("\n");
    const rationale = screen.notes.map((note) => esc(note)).join(" ");
    return `<section id="s${screen.id}">
        <div class="lede">${Number(screen.id) <= 9 ? "Setup" : Number(screen.id) <= 14 ? "Endpoint management" : "Related surfaces"}</div>
        <h2><span class="step-num">${Number(screen.id)}.</span>${esc(screen.title)}</h2>
        <p class="desc">${esc(screen.subtitle)}</p>
        <div class="grid">
          <div class="wire" data-zoom data-caption="${screen.id} · ${esc(screen.title)} (desktop)">
            <div class="label"><span>${screen.id}-${screen.slug}.svg</span><span>1280×800 · desktop</span></div>
            <img src="wireframes/${screen.id}-${screen.slug}.svg" alt="${esc(screen.title)} desktop wireframe" />
          </div>
          <div class="wire mobile-wire mobile-col" data-zoom data-caption="${screen.id} · ${esc(screen.title)} (mobile)">
            <div class="label"><span>mobile</span><span>375×812</span></div>
            <img src="wireframes/${screen.id}-${screen.slug}-mobile.svg" alt="${esc(screen.title)} mobile wireframe" />
          </div>
          <div class="notes-col">
            <div class="notes">
              <h3>Annotations</h3>
              <ul>${notes}</ul>
              <div class="why"><b>Rationale:</b> ${rationale}</div>
            </div>
          </div>
        </div>
      </section>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Paperclip chat adapters — planning review</title>
${style}
<style>
  .doc-links { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 16px; }
  .doc-links a { min-height: 48px; display: inline-flex; align-items: center; font-size: 13px; font-weight: 600; }
  .notice { max-width: var(--maxw); margin: -32px 0 48px; padding: 14px 18px; background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 4px; }
  .notice p { margin: 0; }
  code { font-size: 0.92em; }
</style>
</head>
<body>
  <div class="shell">
    <details class="toc">
      <summary class="toc-summary">
        <span><span class="crumb">Chat adapters · planning</span><br><span class="title">Jump to a screen</span></span>
        <span class="chevron" aria-hidden="true"></span>
      </summary>
      <nav class="toc-body" aria-label="Section navigation">
        <h1>Chat adapters</h1>
        <div style="font-size: 13px; color: var(--muted); margin-bottom: 16px;">Planning review package</div>
        <h2>Documents</h2>
        <a href="2026-09-03-chat-adapters-architecture.md"><span class="num">A</span>Architecture</a>
        <a href="2026-09-03-chat-adapters-research-notes.md"><span class="num">R</span>Research notes</a>
        <a href="2026-09-03-chat-adapters-ui-surfaces.md"><span class="num">U</span>UI specification</a>
        <h2>Flow</h2>
        <a href="#flow"><span class="num">⤳</span>Product flow</a>
        <h2>Screens</h2>
        ${toc}
        <h2>Review</h2>
        <a href="#coverage"><span class="num">✓</span>Coverage and sources</a>
      </nav>
    </details>
    <main>
      <header class="hero">
        <div class="crumb">Paperclip · Chat adapters · Planning artifact</div>
        <h1>Connect one Paperclip agent to every place people already work</h1>
        <p>This package defines the administration, agent, task, identity-link, and relay surfaces for durable external chat endpoints. Paperclip remains the control plane; provider channels are communication media.</p>
        <div class="doc-links">
          <a href="2026-09-03-chat-adapters-architecture.md">Read architecture plan</a>
          <a href="2026-09-03-chat-adapters-research-notes.md">Read research appendix</a>
          <a href="2026-09-03-chat-adapters-ui-surfaces.md">Read UI surface specification</a>
        </div>
        <div class="pills">
          <span class="pill">19 product screens</span>
          <span class="pill">Desktop + mobile</span>
          <span class="pill">Slack-first · 5-provider launch</span>
          <span class="pill">Click any wireframe to zoom</span>
        </div>
      </header>
      <div class="notice" role="note"><p><b>Review convention:</b> red dashed marks and numbered circles are annotations only. They are not proposed Paperclip interface elements.</p></div>
      <section id="flow" class="flow-section">
        <div class="lede">Navigation and product flow</div>
        <h2>From Apps discovery to an externally bound task</h2>
        <p class="desc">Solid arrows follow setup and activation. Dashed paths branch to endpoint management, identity linking, private-instance relay, diagnostics, and detach/rebind. This is a product navigation flow, not a system architecture diagram.</p>
        <div class="wire" data-zoom data-caption="Chat adapters product flow">
          <div class="label"><span>flow.svg</span><span>1280×800</span></div>
          <img src="wireframes/flow.svg" alt="Chat adapters navigation and product flow" />
        </div>
        <div class="notes"><h3>Annotations</h3><ul><li><b>1</b> — Discovery, connection-method choice, setup, review, and activation.</li><li><b>2</b> — Endpoint operations and the agent, task, identity-link, relay, and adapter-state branches.</li></ul></div>
      </section>
      ${sections}
      <section id="coverage">
        <div class="lede">Coverage and sources</div>
        <h2>Review checklist</h2>
        <div class="notes">
          <ul>
            <li><b>Paperclip invariant:</b> agents, tasks, runs, permissions, approvals, budgets, artifacts, and audit history remain authoritative in Paperclip.</li>
            <li><b>Provider model:</b> one installed native bot identity maps to exactly one Paperclip agent endpoint.</li>
            <li><b>First supported set:</b> Slack, Microsoft Teams, Discord, Telegram, and GitHub.</li>
            <li><b>Thread model:</b> a root mention creates/opens a provider thread and one endpoint-owned Paperclip issue where supported; GitHub binds an existing issue/PR/discussion thread; Telegram uses the stable chat/topic boundary.</li>
            <li><b>Chat SDK coverage:</b> events, streaming, cards, actions, modals, commands, emoji, files, DMs, ephemeral output, and overlap policies appear in screens 07, 12, 14, and 19.</li>
            <li><b>Research pins:</b> Paperclip <code>b84964e5a2fa8b1e6498a1ccb471f6adba97d470</code>; Vercel Chat SDK <code>51322dde8f4aafd8a7fc7a20cbfd7ae45cafaa5c</code>; OpenTag <code>6a770d862349f8e996c23c145aef6d6275914a23</code>.</li>
            <li><b>Current-state screenshots:</b> omitted because no deterministic local fixture was used; no reference UI has been invented.</li>
          </ul>
        </div>
      </section>
      <div class="footer">Generated from Paperclip's bundled <code>wireframe</code> skill viewer template. Wires use black 1.5 strokes, white surfaces, grayscale placeholders, an 8px rhythm, and 12/14/20/28 type sizes. Red is reserved for review annotations.</div>
    </main>
  </div>
  <div class="lightbox" id="lb" aria-hidden="true">
    <span class="close" id="lbClose" role="button" aria-label="Close preview">×</span>
    <img id="lbImg" alt="" />
    <div class="caption" id="lbCap"></div>
  </div>
<script>
  const lb = document.getElementById('lb');
  const lbImg = document.getElementById('lbImg');
  const lbCap = document.getElementById('lbCap');
  document.querySelectorAll('[data-zoom]').forEach((el) => {
    el.addEventListener('click', () => {
      const target = el.tagName === 'IMG' ? el : el.querySelector('img');
      if (!target) return;
      lbImg.src = target.src;
      lbImg.alt = target.alt;
      lbCap.textContent = el.dataset.caption || target.alt || '';
      lb.classList.add('open');
      lb.setAttribute('aria-hidden', 'false');
    });
  });
  function closeLightbox() { lb.classList.remove('open'); lb.setAttribute('aria-hidden', 'true'); }
  lb.addEventListener('click', closeLightbox);
  document.getElementById('lbClose').addEventListener('click', closeLightbox);
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeLightbox(); });
  const tocElement = document.querySelector('details.toc');
  const media = window.matchMedia('(max-width: 900px)');
  const setToc = () => { tocElement.open = !media.matches; };
  setToc();
  media.addEventListener('change', setToc);
  tocElement.querySelectorAll('.toc-body a').forEach((link) => link.addEventListener('click', () => { if (media.matches) tocElement.open = false; }));
</script>
</body>
</html>`;
}

for (const screen of screens) {
  const desktop = screen.kind === "catalog" ? desktopCatalog(screen)
    : screen.kind === "task" ? desktopTask(screen)
      : screen.kind === "link" ? desktopLink(screen)
        : screen.kind === "matrix" ? desktopMatrix(screen)
          : desktopGeneric(screen);
  const mobile = screen.kind === "catalog" ? mobileCatalog(screen)
    : screen.kind === "task" ? mobileTask(screen)
      : screen.kind === "link" ? mobileLink(screen)
        : screen.kind === "matrix" ? mobileMatrix(screen)
          : mobileGeneric(screen);
  writeFileSync(join(out, `${screen.id}-${screen.slug}.svg`), `${desktop}\n`);
  writeFileSync(join(out, `${screen.id}-${screen.slug}-mobile.svg`), `${mobile}\n`);
}

writeFileSync(join(out, "flow.svg"), `${flowSvg()}\n`);
writeFileSync(join(root, "index.html"), `${viewerHtml()}\n`);
console.log(`Generated ${screens.length * 2 + 1} SVGs and index.html in ${root}`);
