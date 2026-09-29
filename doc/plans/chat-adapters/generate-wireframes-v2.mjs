import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { providerScreens } from "./platform-wireframe-data.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, "wireframes-v2");
mkdirSync(out, { recursive: true });

const screens = [
  { id: "01", slug: "connectors-catalog", title: "Connectors", subtitle: "Connect tools and places where people talk to agents.", group: "Discover", kind: "catalog", rationale: "This is the existing Apps catalog with small capability metadata, not a second channel marketplace." },
  { id: "02", slug: "connection-purpose", title: "Connect GitHub", subtitle: "How do you want to use GitHub?", group: "Connect", kind: "purpose", rationale: "Only providers with both purposes show this choice; Slack and other chat-only connectors skip it." },
  { id: "03", slug: "choose-agent", title: "Which agent do you want to chat with?", subtitle: "Slack will show the selected agent as its own bot.", group: "Connect", kind: "agent", rationale: "The one-agent endpoint decision is the only Paperclip-specific configuration required before provider installation." },
  { id: "04", slug: "invite-bot", title: "Invite Maya to Slack", subtitle: "Connect the Paperclip agent to your Slack workspace.", group: "Connect", kind: "invite", rationale: "Provider authorization is the final setup action; safe defaults eliminate review and activation steps." },
  { id: "05", slug: "connector-overview", title: "Maya on Slack", subtitle: "Connected and ready for conversations.", group: "Manage", kind: "detail", active: "Overview", rationale: "The current connector-detail shell becomes the home for all post-connect configuration and health." },
  { id: "06", slug: "channels", title: "Channels", subtitle: "Choose where Maya listens.", group: "Manage", kind: "detail", active: "Channels", rationale: "Reach and thread behavior are editable after connection; the bot works immediately wherever it is invited." },
  { id: "07", slug: "access", title: "Access", subtitle: "Control who people act as in Paperclip.", group: "Manage", kind: "detail", active: "Access", rationale: "Identity linking and restricted guest authority are important but should never block initial connection." },
  { id: "08", slug: "behavior", title: "Behavior", subtitle: "Adjust what Maya sends and how messages are handled.", group: "Manage", kind: "detail", active: "Behavior", rationale: "One compact page exposes reviewed defaults and capability fallbacks; advanced routing stays collapsed." },
  { id: "09", slug: "conversations", title: "Conversations", subtitle: "See the Paperclip issue behind every external thread.", group: "Manage", kind: "detail", active: "Conversations", rationale: "This is the operator view of the one-thread/one-issue invariant and detach lifecycle." },
  { id: "10", slug: "activity", title: "Activity", subtitle: "Inspect deliveries, retries, and provider health.", group: "Manage", kind: "detail", active: "Activity", rationale: "Diagnostics stay out of setup and appear only when an operator needs them." },
  { id: "11", slug: "bound-task", title: "Refund workflow is failing", subtitle: "PAP-1842 · Created from Slack", group: "Related", kind: "task", rationale: "Externally created work remains a normal Paperclip task with explicit publication and assignment-lock affordances." },
  { id: "12", slug: "agent-channels", title: "Maya · Channels", subtitle: "Every place people can reach this agent.", group: "Related", kind: "agentChannels", rationale: "Agent detail summarizes endpoints and recent tasks, while connector administration remains in Apps." },
];

const spec = readFileSync(join(root, "2026-09-04-chat-adapters-ui-surfaces-v2.md"), "utf8");
const annotationMap = new Map(
  [...spec.matchAll(/### (\d{2})[^\n]*\n\nPurpose:[^\n]*\n\n((?:\d+\.[^\n]*\n){4})/g)].map((match) => [
    match[1],
    match[2].trim().split("\n").map((line) => line.replace(/^\d+\.\s*/, "")),
  ]),
);
for (const screen of screens) {
  screen.annotations = annotationMap.get(screen.id);
  if (!screen.annotations || screen.annotations.length !== 4) {
    throw new Error(`Expected four documented annotations for screen ${screen.id}`);
  }
}

const esc = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

const tx = (x, y, value, size = 14, fill = "#000", extra = "") =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" stroke="none" ${extra}>${esc(value)}</text>`;
const ln = (x1, y1, x2, y2, extra = "") => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${extra}/>`;
const rc = (x, y, w, h, extra = "") => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" ${extra}/>`;
const circle = (x, y, r, extra = "") => `<circle cx="${x}" cy="${y}" r="${r}" ${extra}/>`;

function wrap(value, width = 48, max = 2) {
  const lines = [];
  let current = "";
  for (const word of value.split(" ")) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width && current) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines.slice(0, max);
}

function multiline(x, y, lines, size = 12, fill = "#666", gap = 18, extra = "") {
  return lines.map((line, index) => tx(x, y + index * gap, line, size, fill, extra)).join("\n");
}

function button(x, y, w, label, primary = false) {
  return `${rc(x, y, w, 48, primary ? 'fill="#000"' : 'fill="#fff"')}${tx(x + w / 2, y + 30, label, 14, primary ? "#fff" : "#000", 'text-anchor="middle" font-weight="600"')}`;
}

function badge(x, y, label) {
  const w = Math.max(64, label.length * 7 + 20);
  return `${rc(x, y, w, 24, 'fill="#fff"')}${tx(x + w / 2, y + 17, label, 12, "#666", 'text-anchor="middle"')}`;
}

function annotations(regions, mobile = false) {
  return `<g data-region="annotations">${regions.map((region, index) => {
    const radius = mobile ? 9 : 12;
    const cx = region.x;
    const cy = region.y;
    return `${rc(region.x, region.y, region.w, region.h, 'fill="none" stroke="#d33" stroke-dasharray="6 4"')}${circle(cx, cy, radius, 'fill="#fff" stroke="#d33" stroke-dasharray="4 2"')}${tx(cx, cy + 4, index + 1, 12, "#d33", 'text-anchor="middle" font-weight="700"')}`;
  }).join("\n")}</g>`;
}

function baseSvg(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif" fill="#fff" stroke="#000" stroke-width="1.5"><rect width="${width}" height="${height}"/>${body}</svg>`;
}

function globalSidebar(active = "Connectors") {
  const items = ["New Task", "Search", "Dashboard", "Inbox", "Tasks", "Projects", "Routines", "Artifacts", "Agents", "Skills", "Connectors", "Audit"];
  return `<g data-region="global-navigation">${tx(24, 38, "Paperclip", 20, "#000", 'font-weight="700"')}${items.map((item, index) => {
    const y = 78 + index * 46;
    const selected = item === active;
    return `${selected ? rc(12, y - 28, 216, 38, 'fill="#e6e6e6"') : ""}${circle(32, y - 10, 6, 'fill="#e6e6e6"')}${tx(52, y - 5, item, 14, selected ? "#000" : "#666", selected ? 'font-weight="600"' : "")}`;
  }).join("\n")}${tx(24, 744, "Acme Company", 14, "#000", 'font-weight="600"')}${tx(24, 772, "Dana · Admin", 12, "#666")}${ln(240, 0, 240, 800)}</g>`;
}

function topbar(crumb) {
  return `<g data-region="topbar">${ln(240, 60, 1280, 60)}${tx(264, 36, crumb, 14, "#666")}${circle(1240, 30, 16, 'fill="#e6e6e6"')}</g>`;
}

function catalogContext(active = "Browse") {
  const items = ["Browse", "Review"];
  return `<g data-region="context-navigation">${tx(264, 96, "CONNECTORS", 12, "#666", 'font-weight="600"')}${items.map((item, i) => `${item === active ? rc(252, 116 + i * 48, 216, 40, 'fill="#e6e6e6"') : ""}${tx(280, 142 + i * 48, item, 14, item === active ? "#000" : "#666", item === active ? 'font-weight="600"' : "")}`).join("\n")}${ln(480, 60, 480, 800)}</g>`;
}

function detailContext(active) {
  const items = ["Overview", "Channels", "Access", "Behavior", "Conversations", "Activity"];
  return `<g data-region="connector-navigation">${tx(264, 94, "‹  All connectors", 12, "#666")}${circle(280, 132, 18, 'fill="#e6e6e6"')}${tx(308, 138, "Maya on Slack", 14, "#000", 'font-weight="700"')}${items.map((item, i) => `${item === active ? rc(252, 168 + i * 48, 216, 40, 'fill="#e6e6e6"') : ""}${tx(280, 194 + i * 48, item, 14, item === active ? "#000" : "#666", item === active ? 'font-weight="600"' : "")}`).join("\n")}${ln(480, 60, 480, 800)}</g>`;
}

function pageHeader(title, subtitle, step = "") {
  return `<g data-region="page-header">${step ? tx(504, 94, step, 12, "#666", 'font-weight="600"') : ""}${tx(504, step ? 130 : 112, title, 28, "#000", 'font-weight="700"')}${tx(504, step ? 158 : 140, subtitle, 14, "#666")}</g>`;
}

function catalogDesktop(screen) {
  const providers = [
    ["Slack", "Chat · Stable", "Maya on Slack · Active", "Add connection"],
    ["GitHub", "Chat + tools · Preview", "1 tool connection", "Connect"],
    ["Discord", "Chat · Preview", "Not connected", "Connect"],
    ["Telegram", "Chat · Preview", "2 agent bots", "Manage"],
  ];
  const rows = providers.map((provider, i) => {
    const y = 196 + i * 128;
    return `<g data-region="provider-row-${i + 1}">${rc(504, y, 720, 112)}${circle(536, y + 32, 18, 'fill="#e6e6e6"')}${tx(568, y + 30, provider[0], 14, "#000", 'font-weight="700"')}${tx(568, y + 54, provider[1], 12, "#666")}${ln(520, y + 72, 1208, y + 72, 'stroke="#e6e6e6"')}${tx(520, y + 96, provider[2], 12, i === 0 ? "#000" : "#666")}${button(1080, y + 32, 128, provider[3], false)}</g>`;
  }).join("\n");
  return baseSvg(1280, 800, `${globalSidebar()}${topbar("CONNECTORS")}${catalogContext()}${tx(504, 104, screen.title, 28, "#000", 'font-weight="700"')}${rc(504, 132, 560, 48)}${circle(528, 156, 8, 'fill="#e6e6e6"')}${tx(550, 162, "Search connectors…", 14, "#666")}${badge(1076, 144, "All")}${badge(1148, 144, "Chat")}${rows}${annotations([{x:236,y:56,w:248,h:744},{x:496,y:124,w:728,h:64},{x:496,y:188,w:728,h:520},{x:1068,y:188,w:164,h:520}])}`);
}

function purposeDesktop(screen) {
  const cards = [
    ["Chat with an agent", "People mention a Paperclip agent in GitHub.", "Comments become Paperclip task turns."],
    ["Use this channel as an agent tool", "Agents use GitHub during Paperclip runs.", "Continue with existing credential and access setup."],
  ];
  const body = cards.map((card, i) => {
    const y = 214 + i * 168;
    return `${rc(540, y, 648, 144, i === 0 ? 'fill="#e6e6e6"' : 'fill="#fff"')}${circle(570, y + 32, 10, i === 0 ? 'fill="#000"' : 'fill="#fff"')}${tx(598, y + 38, card[0], 20, "#000", 'font-weight="600"')}${tx(598, y + 74, card[1], 14, "#666")}${tx(598, y + 104, card[2], 14, "#666")}`;
  }).join("\n");
  return baseSvg(1280, 800, `${globalSidebar()}${topbar("CONNECTORS  ›  Connect an app")}${catalogContext()}${pageHeader(screen.title, screen.subtitle, "Step 1 of 3")}${body}${button(540, 606, 120, "Back")}${button(1012, 606, 176, "Continue", true)}${tx(540, 680, "Slack and chat-only connectors skip this choice.", 12, "#666")}${annotations([{x:496,y:72,w:728,h:112},{x:532,y:206,w:664,h:160},{x:532,y:374,w:664,h:160},{x:1004,y:598,w:192,h:64}])}`);
}

function chooseAgentDesktop(screen) {
  const agents = [["Maya", "Support lead · Active"], ["Quinn", "Engineer · Active"], ["Rin", "Researcher · Active"]];
  const rows = agents.map((agent, i) => {
    const y = 292 + i * 64;
    return `${i ? ln(556, y, 1148, y, 'stroke="#e6e6e6"') : ""}${circle(580, y + 32, 16, 'fill="#e6e6e6"')}${tx(610, y + 28, agent[0], 14, "#000", 'font-weight="600"')}${tx(610, y + 48, agent[1], 12, "#666")}${circle(1124, y + 32, 10, i === 0 ? 'fill="#000"' : 'fill="#fff"')}`;
  }).join("\n");
  return baseSvg(1280, 800, `${globalSidebar()}${topbar("CONNECTORS  ›  Connect Slack")}${catalogContext()}${pageHeader(screen.title, screen.subtitle, "Step 1 of 2")}${rc(540, 206, 648, 56)}${tx(560, 241, "Search agents…", 14, "#666")}${rc(540, 278, 648, 208)}${rows}${tx(540, 530, "One agent per connection. Add another connection for another bot.", 12, "#666")}${button(540, 606, 120, "Back")}${button(980, 606, 208, "Continue with Maya", true)}${annotations([{x:496,y:72,w:728,h:112},{x:532,y:198,w:664,h:72},{x:532,y:270,w:664,h:224},{x:972,y:598,w:224,h:64}])}`);
}

function inviteDesktop(screen) {
  return baseSvg(1280, 800, `${globalSidebar()}${topbar("CONNECTORS  ›  Connect Slack")}${catalogContext()}${pageHeader(screen.title, screen.subtitle, "Step 2 of 2")}${rc(540, 214, 648, 112, 'fill="#e6e6e6"')}${circle(580, 270, 24, 'fill="#fff"')}${tx(620, 260, "Maya", 20, "#000", 'font-weight="700"')}${tx(620, 286, "Paperclip Support lead  →  Slack bot @maya", 14, "#666")}${rc(540, 350, 648, 128)}${tx(566, 386, "Slack workspace", 12, "#666", 'font-weight="600"')}${tx(566, 418, "Acme", 14, "#000", 'font-weight="600"')}${tx(566, 448, "Paperclip will verify the bot and event subscription.", 12, "#666")}${button(540, 510, 648, "Invite Maya to Slack  ↗", true)}${tx(540, 590, "▸  Set up manually with a Slack app manifest", 14, "#000", 'font-weight="600"')}${tx(540, 632, "After Slack confirms, you’ll go straight to Maya on Slack.", 12, "#666")}${annotations([{x:496,y:72,w:728,h:112},{x:532,y:206,w:664,h:128},{x:532,y:342,w:664,h:144},{x:532,y:502,w:664,h:104}])}`);
}

function overviewBody() {
  return `${rc(504, 176, 720, 96, 'fill="#e6e6e6"')}${circle(544, 224, 24, 'fill="#fff"')}${tx(584, 214, "Maya  ·  @maya", 20, "#000", 'font-weight="700"')}${tx(584, 242, "Slack workspace: Acme  ·  Active", 14, "#666")}${button(1056, 200, 144, "Open Slack")}${rc(504, 296, 344, 152)}${tx(528, 330, "Health", 14, "#000", 'font-weight="700"')}${tx(528, 366, "Provider", 12, "#666")}${tx(816, 366, "Healthy", 12, "#000", 'text-anchor="end" font-weight="600"')}${tx(528, 398, "Webhook", 12, "#666")}${tx(816, 398, "Healthy", 12, "#000", 'text-anchor="end" font-weight="600"')}${tx(528, 430, "Last message", 12, "#666")}${tx(816, 430, "2m ago", 12, "#000", 'text-anchor="end"')}${rc(872, 296, 352, 152)}${tx(896, 330, "Defaults", 14, "#000", 'font-weight="700"')}${tx(896, 366, "Mention → thread → one issue", 12, "#666")}${tx(896, 398, "Replies continue · Messages queue", 12, "#666")}${tx(896, 430, "Safe progress and final output", 12, "#666")}${tx(504, 496, "Connection", 20, "#000", 'font-weight="600"')}${button(504, 522, 112, "Test bot")}${button(632, 522, 112, "Pause")}${button(760, 522, 136, "Reconnect")}${tx(504, 630, "Advanced", 14, "#000", 'font-weight="600"')}${tx(504, 658, "Direct ingress · Relay not needed", 12, "#666")}${tx(1100, 716, "Remove connection", 12, "#666", 'text-anchor="end"')}`;
}

function channelsBody() {
  const rows = [["#customer-support", "Invited · Listening"], ["#product-feedback", "Invited · Listening"], ["#private-escalations", "Not invited"]];
  return `${rc(504, 176, 720, 88, 'fill="#e6e6e6"')}${tx(528, 208, "Default reach", 14, "#000", 'font-weight="700"')}${tx(528, 236, "Listen in channels where @maya is invited, within this allowlist.", 14, "#666")}${tx(504, 310, "Slack channels", 20, "#000", 'font-weight="600"')}${button(1064, 286, 160, "Add channel")}${rc(504, 336, 720, 192)}${rows.map((row, i) => `${i ? ln(520, 336 + i * 64, 1208, 336 + i * 64, 'stroke="#e6e6e6"') : ""}${tx(528, 374 + i * 64, row[0], 14, "#000", 'font-weight="600"')}${tx(1192, 374 + i * 64, row[1], 12, "#666", 'text-anchor="end"')}`).join("\n")}${rc(504, 560, 720, 120)}${tx(528, 594, "Conversation boundary", 14, "#000", 'font-weight="700"')}${tx(528, 624, "Mention @maya in a channel. Maya opens a thread and one Paperclip issue.", 12, "#666")}${tx(528, 650, "Continue in that thread without mentioning Maya again.  ·  DMs: On", 12, "#666")}`;
}

function accessBody() {
  return `${rc(504, 176, 720, 96, 'fill="#e6e6e6"')}${tx(528, 208, "Endpoint sponsor", 12, "#666", 'font-weight="600"')}${tx(528, 238, "Dana · Company admin", 14, "#000", 'font-weight="700"')}${tx(840, 238, "Caps authority for unlinked people", 12, "#666")}${button(1080, 200, 120, "Change")}${tx(504, 320, "People", 20, "#000", 'font-weight="600"')}${rc(504, 344, 720, 168)}${tx(528, 378, "Slack identity", 12, "#666", 'font-weight="600"')}${tx(840, 378, "Paperclip identity", 12, "#666", 'font-weight="600"')}${ln(520, 392, 1208, 392, 'stroke="#e6e6e6"')}${tx(528, 428, "Ari S.", 14, "#000", 'font-weight="600"')}${tx(840, 428, "Ari Stone · Linked", 14, "#000")}${tx(1176, 428, "Revoke", 12, "#666", 'text-anchor="end"')}${ln(520, 448, 1208, 448, 'stroke="#e6e6e6"')}${tx(528, 484, "Jules P.", 14, "#000", 'font-weight="600"')}${tx(840, 484, "Restricted guest", 14, "#666")}${tx(1176, 484, "Link", 12, "#000", 'text-anchor="end" font-weight="600"')}${rc(504, 544, 720, 120)}${tx(528, 578, "Restricted guest", 14, "#000", 'font-weight="700"')}${tx(528, 608, "Can message this task and attach safe files in allowed channels.", 12, "#666")}${tx(528, 636, "Cannot approve, change budgets, hire, manage access, or reassign agents.", 12, "#666")}`;
}

function behaviorBody() {
  const groups = [
    ["Progress", "React when received", "Safe milestones + final answer"],
    ["Interactions", "Files, cards, buttons, commands", "Unsupported → text + Paperclip link"],
    ["Overlapping messages", "Queue", "Burst · Debounce · Drop · Concurrent"],
  ];
  return `${groups.map((group, i) => { const y = 176 + i * 144; return `${rc(504, y, 720, 120, i === 0 ? 'fill="#e6e6e6"' : 'fill="#fff"')}${tx(528, y + 34, group[0], 14, "#000", 'font-weight="700"')}${tx(528, y + 68, group[1], 14, "#000")}${tx(528, y + 96, group[2], 12, "#666")}${tx(1192, y + 66, "Change  ›", 12, "#000", 'text-anchor="end" font-weight="600"')}`; }).join("\n")}${rc(504, 624, 720, 56)}${tx(528, 658, "▸  Advanced · Failures, retries, and agent-to-agent routes (Off)", 14, "#000", 'font-weight="600"')}${tx(504, 716, "Reasoning and internal tool traces are never published.", 12, "#666")}`;
}

function conversationsBody() {
  const rows = [
    ["#customer-support · Refund workflow", "PAP-1842", "In progress · 8m"],
    ["DM with Ari Stone", "PAP-1839", "Waiting · 24m"],
    ["#product-feedback · CSV import", "PAP-1804", "Done · 1d"],
  ];
  return `${rc(504, 176, 464, 48)}${tx(528, 206, "Search conversations…", 14, "#666")}${badge(984, 188, "Active")}${badge(1064, 188, "All")}${rc(504, 248, 720, 256)}${tx(528, 278, "External thread", 12, "#666", 'font-weight="600"')}${tx(900, 278, "Paperclip issue", 12, "#666", 'font-weight="600"')}${rows.map((row, i) => { const y = 304 + i * 64; return `${ln(520, y, 1208, y, 'stroke="#e6e6e6"')}${tx(528, y + 38, row[0], 14, "#000", 'font-weight="600"')}${tx(900, y + 28, row[1], 14, "#000", 'font-weight="600"')}${tx(900, y + 48, row[2], 12, "#666")}${tx(1192, y + 38, "Open  ›", 12, "#000", 'text-anchor="end"')}`; }).join("\n")}${rc(504, 536, 720, 120, 'fill="#e6e6e6"')}${tx(528, 570, "Selected · PAP-1842", 14, "#000", 'font-weight="700"')}${tx(528, 600, "One Slack thread ↔ one issue · Assigned to Maya", 12, "#666")}${tx(528, 632, "Open Slack     Open task", 12, "#000", 'font-weight="600"')}${tx(1192, 632, "Detach…", 12, "#666", 'text-anchor="end"')}`;
}

function activityBody() {
  const rows = [
    ["Inbound mention", "Applied", "PAP-1842 · 122 ms · deduped"],
    ["Outbound final", "Retrying", "PAP-1842 · attempt 2 · rate limit"],
    ["Button action", "Denied", "PAP-1839 · user not linked"],
  ];
  return `${rc(504, 176, 720, 80, 'fill="#e6e6e6"')}${tx(528, 208, "Provider healthy", 14, "#000", 'font-weight="700"')}${tx(528, 234, "Direct webhook · Rate limit normal · Relay not used · Backlog 0", 12, "#666")}${tx(504, 304, "Recent activity", 20, "#000", 'font-weight="600"')}${rc(504, 330, 720, 240)}${rows.map((row, i) => { const y = 330 + i * 72; return `${i ? ln(520, y, 1208, y, 'stroke="#e6e6e6"') : ""}${tx(528, y + 30, row[0], 14, "#000", 'font-weight="600"')}${tx(840, y + 30, row[1], 12, "#000", 'font-weight="600"')}${tx(528, y + 54, row[2], 12, "#666")}${tx(1192, y + 42, "Details  ›", 12, "#000", 'text-anchor="end"')}`; }).join("\n")}${rc(504, 600, 720, 88)}${tx(528, 632, "Selected failure", 14, "#000", 'font-weight="700"')}${tx(528, 660, "Redacted provider error · Safe to replay", 12, "#666")}${button(1080, 620, 120, "Replay")}`;
}

function detailDesktop(screen) {
  const bodies = { Overview: overviewBody, Channels: channelsBody, Access: accessBody, Behavior: behaviorBody, Conversations: conversationsBody, Activity: activityBody };
  const regions = screen.active === "Overview" ? [{x:236,y:56,w:248,h:744},{x:496,y:72,w:728,h:208},{x:496,y:288,w:728,h:168},{x:496,y:488,w:728,h:240}]
    : screen.active === "Channels" ? [{x:236,y:56,w:248,h:744},{x:496,y:168,w:728,h:104},{x:496,y:328,w:728,h:208},{x:496,y:552,w:728,h:136}]
      : screen.active === "Access" ? [{x:496,y:168,w:728,h:112},{x:496,y:336,w:728,h:184},{x:824,y:392,w:384,h:120},{x:496,y:536,w:728,h:136}]
        : screen.active === "Behavior" ? [{x:496,y:168,w:728,h:136},{x:496,y:312,w:728,h:136},{x:496,y:456,w:728,h:136},{x:496,y:616,w:728,h:104}]
          : screen.active === "Conversations" ? [{x:496,y:240,w:728,h:272},{x:496,y:168,w:728,h:64},{x:888,y:296,w:320,h:208},{x:496,y:528,w:728,h:136}]
            : [{x:496,y:168,w:728,h:96},{x:496,y:322,w:728,h:256},{x:520,y:322,w:688,h:248},{x:496,y:592,w:728,h:104}];
  return baseSvg(1280, 800, `${globalSidebar()}${topbar(`CONNECTORS  ›  Maya on Slack  ›  ${screen.active}`)}${detailContext(screen.active)}${pageHeader(screen.title, screen.subtitle)}${bodies[screen.active]()}${annotations(regions)}`);
}

function taskDesktop(screen) {
  return baseSvg(1280, 800, `${globalSidebar("Tasks")}${topbar("TASKS  ›  PAP-1842")}${tx(280, 110, screen.title, 28, "#000", 'font-weight="700"')}${tx(280, 140, screen.subtitle, 14, "#666")}${rc(280, 168, 944, 88, 'fill="#e6e6e6"')}${tx(304, 200, "Slack · #customer-support · Refund workflow", 14, "#000", 'font-weight="700"')}${tx(304, 230, "Assigned to Maya while connected  ·  Open Slack  ·  Manage connector", 12, "#666")}${rc(320, 288, 720, 104)}${circle(352, 320, 16, 'fill="#e6e6e6"')}${tx(380, 318, "Ari S. · External · Linked as Ari Stone", 12, "#666", 'font-weight="600"')}${tx(344, 360, "The refund step is timing out again.", 14, "#000")}${rc(432, 416, 720, 128, 'fill="#e6e6e6"')}${tx(456, 448, "Maya · Agent", 12, "#666", 'font-weight="600"')}${tx(456, 482, "I found the failing retry boundary and prepared a patch.", 14, "#000")}${tx(456, 518, "Delivered to Slack · retry-analysis.md", 12, "#666")}${rc(280, 584, 944, 136)}${tx(304, 616, "Internal note", 12, "#666")}${ln(304, 640, 1200, 640, 'stroke="#666"')}${tx(304, 684, "□  Send to channel", 14, "#000", 'font-weight="600"')}${button(1064, 660, 136, "Comment", true)}${annotations([{x:272,y:160,w:960,h:104},{x:312,y:280,w:736,h:120},{x:424,y:408,w:736,h:144},{x:272,y:576,w:960,h:152}])}`);
}

function agentChannelsDesktop(screen) {
  const nav = ["Overview", "Work", "Instructions", "Skills", "Runtime", "Tools", "Channels", "Permissions"];
  const endpointRows = [["Slack · @maya", "Acme · 2 channels", "Healthy"], ["Telegram · @maya_helper_bot", "Support group + DMs", "Needs attention"]];
  return baseSvg(1280, 800, `${globalSidebar("Agents")}${topbar("AGENTS  ›  Maya  ›  Channels")}<g>${tx(264, 94, "‹  All agents", 12, "#666")}${tx(264, 132, "Maya", 14, "#000", 'font-weight="700"')}${nav.map((item,i)=>`${item === "Channels" ? rc(252,152+i*48,216,40,'fill="#e6e6e6"') : ""}${tx(280,178+i*48,item,14,item === "Channels" ? "#000" : "#666",item === "Channels" ? 'font-weight="600"' : "")}`).join("\n")}${ln(480,60,480,800)}</g>${pageHeader(screen.title, screen.subtitle)}${button(1040, 96, 184, "Connect a channel", true)}${tx(504, 190, "Connected identities", 20, "#000", 'font-weight="600"')}${endpointRows.map((row,i)=>{const y=216+i*112;return `${rc(504,y,720,96,i===0?'fill="#e6e6e6"':'fill="#fff"')}${circle(536,y+32,16,'fill="#fff"')}${tx(568,y+30,row[0],14,"#000",'font-weight="700"')}${tx(568,y+56,row[1],12,"#666")}${tx(1188,y+30,row[2],12,"#000",'text-anchor="end" font-weight="600"')}${tx(1188,y+62,"Manage  ›",12,"#666",'text-anchor="end"')}`;}).join("\n")}${tx(504, 488, "Recent channel tasks", 20, "#000", 'font-weight="600"')}${rc(504, 514, 720, 144)}${tx(528, 550, "PAP-1842 · Refund workflow", 14, "#000", 'font-weight="600"')}${tx(1188, 550, "Slack · 8m", 12, "#666", 'text-anchor="end"')}${ln(520, 574, 1208, 574, 'stroke="#e6e6e6"')}${tx(528, 610, "PAP-1839 · Customer question", 14, "#000", 'font-weight="600"')}${tx(1188, 610, "Telegram · 24m", 12, "#666", 'text-anchor="end"')}${annotations([{x:236,y:56,w:248,h:744},{x:496,y:88,w:728,h:80},{x:496,y:208,w:728,h:216},{x:496,y:480,w:728,h:186}])}`);
}

function mobileHeader(label = "Connectors") {
  return `${rc(0, 0, 375, 56)}${tx(16, 35, `‹  ${label}`, 14, "#000", 'font-weight="600"')}${tx(359, 35, "Menu", 12, "#666", 'text-anchor="end"')}`;
}

function mobileTitle(screen, step = "") {
  return `${step ? tx(16, 86, step, 12, "#666", 'font-weight="600"') : ""}${multiline(16, step ? 120 : 96, wrap(screen.title, 34, 2), 20, "#000", 24, 'font-weight="700"')}${multiline(16, step ? 170 : 146, wrap(screen.subtitle, 52, 2), 12, "#666", 16)}`;
}

function catalogMobile(screen) {
  const providers = [["Slack", "Chat · Maya active", "Add"], ["GitHub", "Chat + tools · 1 tool", "Connect"], ["Discord", "Chat · Preview", "Connect"], ["Telegram", "Chat · 2 bots", "Manage"]];
  return baseSvg(375, 812, `${mobileHeader()}${tx(16, 96, screen.title, 20, "#000", 'font-weight="700"')}${rc(16, 120, 343, 48)}${tx(48, 150, "Search connectors…", 14, "#666")}${tx(16, 198, "All      Chat      Tools      Connected", 12, "#000", 'font-weight="600"')}${providers.map((row,i)=>{const y=218+i*120;return `${rc(16,y,343,104,i===0?'fill="#e6e6e6"':'fill="#fff"')}${circle(44,y+32,16,'fill="#fff"')}${tx(72,y+30,row[0],14,"#000",'font-weight="700"')}${tx(72,y+54,row[1],12,"#666")}${tx(335,y+84,row[2],12,"#000",'text-anchor="end" font-weight="600"')}`;}).join("\n")}${annotations([{x:8,y:0,w:359,h:56},{x:8,y:112,w:359,h:96},{x:8,y:210,w:359,h:496},{x:272,y:210,w:95,h:496}],true)}`);
}

function purposeMobile(screen) {
  return baseSvg(375, 812, `${mobileHeader()}${mobileTitle(screen,"Step 1 of 3")}${rc(16,214,343,152,'fill="#e6e6e6"')}${circle(44,244,10,'fill="#000"')}${tx(68,250,"Chat with an agent",14,"#000",'font-weight="700"')}${multiline(68,280,["People mention an agent.","Comments become task turns."],12,"#666",24)}${rc(16,382,343,176)}${circle(44,412,10,'fill="#fff"')}${multiline(68,418,["Use this channel as", "an agent tool"],14,"#000",22,'font-weight="700"')}${multiline(68,472,["Use the existing credential", "and access setup."],12,"#666",22)}${button(16,744,343,"Continue",true)}${annotations([{x:8,y:64,w:359,h:128},{x:8,y:206,w:359,h:168},{x:8,y:374,w:359,h:192},{x:8,y:736,w:359,h:64}],true)}`);
}

function chooseAgentMobile(screen) {
  const rows=[["Maya","Support lead · Active"],["Quinn","Engineer · Active"],["Rin","Researcher · Active"]];
  return baseSvg(375,812,`${mobileHeader()}${mobileTitle(screen,"Step 1 of 2")}${rc(16,214,343,48)}${tx(36,244,"Search agents…",14,"#666")}${rc(16,278,343,216)}${rows.map((row,i)=>{const y=278+i*72;return `${i?ln(32,y,343,y,'stroke="#e6e6e6"'):""}${circle(48,y+36,16,'fill="#e6e6e6"')}${tx(78,y+32,row[0],14,"#000",'font-weight="700"')}${tx(78,y+54,row[1],12,"#666")}${circle(327,y+36,10,i===0?'fill="#000"':'fill="#fff"')}`;}).join("\n")}${multiline(16,538,["One agent per connection.","Add another connection for another bot."],12,"#666",20)}${button(16,744,343,"Continue with Maya",true)}${annotations([{x:8,y:64,w:359,h:128},{x:8,y:206,w:359,h:64},{x:8,y:270,w:359,h:232},{x:8,y:736,w:359,h:64}],true)}`);
}

function inviteMobile(screen) {
  return baseSvg(375,812,`${mobileHeader()}${mobileTitle(screen,"Step 2 of 2")}${rc(16,214,343,112,'fill="#e6e6e6"')}${circle(48,270,24,'fill="#fff"')}${tx(88,260,"Maya",20,"#000",'font-weight="700"')}${tx(88,286,"Paperclip agent → @maya",12,"#666")}${rc(16,350,343,120)}${tx(36,382,"Slack workspace",12,"#666",'font-weight="600"')}${tx(36,414,"Acme",14,"#000",'font-weight="700"')}${tx(36,442,"Bot and webhook verified after invite",12,"#666")}${button(16,494,343,"Invite Maya to Slack  ↗",true)}${rc(16,566,343,56)}${tx(36,600,"▸  Set up manually",14,"#000",'font-weight="600"')}${multiline(16,662,["Success goes directly to", "Maya on Slack."],12,"#666",18)}${annotations([{x:8,y:64,w:359,h:128},{x:8,y:206,w:359,h:128},{x:8,y:342,w:359,h:136},{x:8,y:486,w:359,h:144}],true)}`);
}

function mobileDetailNav(active) {
  return `${rc(16, 158, 343, 48)}${tx(32, 188, active, 14, "#000", 'font-weight="600"')}${tx(335, 188, "⌄", 14, "#666", 'text-anchor="end"')}`;
}

function detailMobile(screen) {
  let body = "";
  let regions = [];
  if (screen.active === "Overview") {
    body = `${rc(16,222,343,104,'fill="#e6e6e6"')}${tx(36,254,"Maya · @maya",14,"#000",'font-weight="700"')}${tx(36,282,"Acme · Active · Healthy",12,"#666")}${tx(36,308,"Last message 2m ago",12,"#666")}${rc(16,342,343,128)}${tx(36,374,"Defaults",14,"#000",'font-weight="700"')}${multiline(36,404,["Mention → thread → one issue","Replies continue · Messages queue","Safe progress + final output"],12,"#666",22)}${button(16,494,104,"Test")}${button(128,494,104,"Pause")}${button(240,494,119,"Reconnect")}${rc(16,566,343,56)}${tx(36,600,"▸  Advanced · Direct ingress",14,"#000",'font-weight="600"')}`;
    regions=[{x:8,y:150,w:359,h:64},{x:8,y:214,w:359,h:120},{x:8,y:334,w:359,h:144},{x:8,y:486,w:359,h:144}];
  } else if (screen.active === "Channels") {
    body = `${rc(16,222,343,88,'fill="#e6e6e6"')}${tx(36,252,"Listen where @maya is invited",14,"#000",'font-weight="700"')}${tx(36,280,"Bounded by this channel allowlist",12,"#666")}${rc(16,326,343,176)}${[["#customer-support","Listening"],["#product-feedback","Listening"],["#private-escalations","Not invited"]].map((r,i)=>`${i?ln(32,326+i*56,343,326+i*56,'stroke="#e6e6e6"'):""}${tx(36,360+i*56,r[0],14,"#000",'font-weight="600"')}${tx(335,360+i*56,r[1],12,"#666",'text-anchor="end"')}`).join("\n")}${rc(16,518,343,128)}${tx(36,550,"Conversation boundary",14,"#000",'font-weight="700"')}${multiline(36,580,["Root mention opens a thread", "and one Paperclip issue.", "DMs: On"],12,"#666",22)}`;
    regions=[{x:8,y:214,w:359,h:104},{x:8,y:318,w:359,h:192},{x:8,y:510,w:359,h:144},{x:24,y:566,w:327,h:80}];
  } else if (screen.active === "Access") {
    body = `${rc(16,222,343,96,'fill="#e6e6e6"')}${tx(36,252,"Sponsor · Dana",14,"#000",'font-weight="700"')}${tx(36,280,"Caps authority for unlinked people",12,"#666")}${tx(327,298,"Change",12,"#000",'text-anchor="end" font-weight="600"')}${rc(16,334,343,144)}${tx(36,366,"Ari S.",14,"#000",'font-weight="600"')}${tx(335,366,"Ari Stone · Linked",12,"#666",'text-anchor="end"')}${ln(32,390,343,390,'stroke="#e6e6e6"')}${tx(36,426,"Jules P.",14,"#000",'font-weight="600"')}${tx(335,426,"Guest · Link",12,"#000",'text-anchor="end"')}${rc(16,494,343,152)}${tx(36,526,"Restricted guest",14,"#000",'font-weight="700"')}${multiline(36,556,["May message and attach safe files.","Cannot approve, hire, change budgets,", "manage access, or reassign."],12,"#666",22)}`;
    regions=[{x:8,y:214,w:359,h:112},{x:8,y:326,w:359,h:160},{x:168,y:326,w:199,h:160},{x:8,y:486,w:359,h:168}];
  } else if (screen.active === "Behavior") {
    const groups=[["Progress","Reaction · safe milestones · final"],["Interactions","Files, cards, actions · fallback"],["Overlap","Queue"]];
    body = `${groups.map((r,i)=>{const y=222+i*112;return `${rc(16,y,343,96,i===0?'fill="#e6e6e6"':'fill="#fff"')}${tx(36,y+32,r[0],14,"#000",'font-weight="700"')}${tx(36,y+62,r[1],12,"#666")}${tx(335,y+48,"›",14,"#000",'text-anchor="end"')}`;}).join("\n")}${rc(16,574,343,56)}${tx(36,608,"▸  Advanced · Routes off",14,"#000",'font-weight="600"')}${multiline(16,674,["Reasoning and internal traces", "are never published."],12,"#666",18)}`;
    regions=[{x:8,y:214,w:359,h:112},{x:8,y:326,w:359,h:112},{x:8,y:438,w:359,h:112},{x:8,y:566,w:359,h:144}];
  } else if (screen.active === "Conversations") {
    const rows=[["#support · Refund","PAP-1842 · Working"],["DM · Ari Stone","PAP-1839 · Waiting"],["#feedback · CSV","PAP-1804 · Done"]];
    body = `${rc(16,222,343,48)}${tx(36,252,"Search conversations…",14,"#666")}${rows.map((r,i)=>{const y=286+i*104;return `${rc(16,y,343,88,i===0?'fill="#e6e6e6"':'fill="#fff"')}${tx(36,y+30,r[0],14,"#000",'font-weight="700"')}${tx(36,y+58,r[1],12,"#666")}${tx(335,y+48,"›",14,"#000",'text-anchor="end"')}`;}).join("\n")}${rc(16,614,343,88)}${tx(36,646,"Open Slack     Open task",12,"#000",'font-weight="600"')}${tx(335,680,"Detach…",12,"#666",'text-anchor="end"')}`;
    regions=[{x:8,y:278,w:359,h:320},{x:8,y:214,w:359,h:64},{x:248,y:278,w:119,h:320},{x:8,y:606,w:359,h:104}];
  } else {
    const rows=[["Inbound mention","Applied · 122 ms"],["Outbound final","Retrying · attempt 2"],["Button action","Denied · unlinked"]];
    body = `${rc(16,222,343,80,'fill="#e6e6e6"')}${tx(36,252,"Provider healthy",14,"#000",'font-weight="700"')}${tx(36,280,"Direct · Rate limit normal · Backlog 0",12,"#666")}${rows.map((r,i)=>{const y=318+i*96;return `${rc(16,y,343,80)}${tx(36,y+30,r[0],14,"#000",'font-weight="700"')}${tx(36,y+56,r[1],12,"#666")}${tx(335,y+44,"›",14,"#000",'text-anchor="end"')}`;}).join("\n")}${button(239,626,120,"Replay",false)}${tx(16,660,"Selected error is redacted and safe to replay.",12,"#666")}`;
    regions=[{x:8,y:214,w:359,h:96},{x:8,y:310,w:359,h:296},{x:24,y:310,w:319,h:280},{x:224,y:612,w:143,h:72}];
  }
  return baseSvg(375,812,`${mobileHeader("Maya on Slack")}${tx(16,96,screen.title,20,"#000",'font-weight="700"')}${tx(16,124,screen.subtitle,12,"#666")}${mobileDetailNav(screen.active)}${body}${annotations(regions,true)}`);
}

function taskMobile(screen) {
  return baseSvg(375,812,`${mobileHeader("PAP-1842")}${multiline(16,96,wrap(screen.title,32,2),20,"#000",24,'font-weight="700"')}${tx(16,150,"Created from Slack",12,"#666")}${rc(16,174,343,96,'fill="#e6e6e6"')}${tx(36,206,"#customer-support · Refund",14,"#000",'font-weight="700"')}${tx(36,234,"Assigned to Maya · Open Slack",12,"#666")}${rc(16,286,343,104)}${tx(36,316,"Ari S. · External · Linked",12,"#666",'font-weight="600"')}${tx(36,352,"The refund step is timing out again.",14,"#000")}${rc(16,406,343,120,'fill="#e6e6e6"')}${tx(36,436,"Maya · Agent",12,"#666",'font-weight="600"')}${multiline(36,470,["I found the failing retry boundary", "and prepared a patch."],14,"#000",22)}${tx(36,514,"Delivered to Slack",12,"#666")}${rc(16,542,343,168)}${tx(36,574,"Internal note",12,"#666")}${ln(36,598,339,598,'stroke="#666"')}${tx(36,638,"□  Send to channel",14,"#000",'font-weight="600"')}${button(207,650,132,"Comment",true)}${annotations([{x:8,y:166,w:359,h:112},{x:8,y:278,w:359,h:120},{x:8,y:398,w:359,h:136},{x:8,y:534,w:359,h:184}],true)}`);
}

function agentChannelsMobile(screen) {
  return baseSvg(375,812,`${mobileHeader("Maya")}${tx(16,96,"Channels",20,"#000",'font-weight="700"')}${tx(16,124,"Every place people can reach Maya.",12,"#666")}${rc(16,158,343,48)}${tx(32,188,"Channels",14,"#000",'font-weight="600"')}${tx(335,188,"⌄",14,"#666",'text-anchor="end"')}${button(16,222,343,"Connect a channel",true)}${[["Slack · @maya","Acme · 2 channels · Healthy"],["Telegram · @maya_helper_bot","Support + DMs · Needs attention"]].map((r,i)=>{const y=294+i*112;return `${rc(16,y,343,96,i===0?'fill="#e6e6e6"':'fill="#fff"')}${tx(36,y+32,r[0],14,"#000",'font-weight="700"')}${tx(36,y+62,r[1],12,"#666")}${tx(335,y+48,"›",14,"#000",'text-anchor="end"')}`;}).join("\n")}${tx(16,546,"Recent channel tasks",14,"#000",'font-weight="700"')}${rc(16,566,343,120)}${tx(36,600,"PAP-1842 · Refund workflow",14,"#000",'font-weight="600"')}${tx(335,600,"Slack",12,"#666",'text-anchor="end"')}${ln(32,622,343,622,'stroke="#e6e6e6"')}${tx(36,656,"PAP-1839 · Customer question",14,"#000",'font-weight="600"')}${annotations([{x:8,y:150,w:359,h:64},{x:8,y:214,w:359,h:64},{x:8,y:286,w:359,h:224},{x:8,y:538,w:359,h:156}],true)}`);
}

function flowSvg() {
  const node = (x,y,w,title,sub,fill=false) => `${rc(x,y,w,88,fill?'fill="#e6e6e6"':'fill="#fff"')}${tx(x+16,y+32,title,14,"#000",'font-weight="700"')}${tx(x+16,y+58,sub,12,"#666")}`;
  const arrow = (x1,y1,x2,y2,dashed=false) => `${ln(x1,y1,x2,y2,dashed?'stroke-dasharray="6 4"':'')}<polygon points="${x2},${y2} ${x2-9},${y2-6} ${x2-9},${y2+6}" fill="#000" stroke="none"/>`;
  return baseSvg(1280,800,`${tx(48,48,"Chat connectors · simplified Paperclip product flow",28,"#000",'font-weight="700"')}${tx(48,76,"The provider handoff completes setup; all policy editing happens later in the existing connector-detail shell.",14,"#666")}${node(48,128,176,"/apps","Choose connector",true)}${arrow(224,172,264,172)}${node(264,128,192,"Purpose?","Only when ambiguous")}${arrow(456,172,496,172)}${node(496,128,184,"Choose agent","Exactly one")}${arrow(680,172,720,172)}${node(720,128,184,"Invite bot","Provider handoff")}${arrow(904,172,944,172)}${node(944,128,240,"Connector overview","Connected with defaults",true)}${arrow(360,216,360,290,true)}${node(264,290,192,"Existing tool flow","Credential + access")}${tx(48,258,"CHAT PATH",12,"#666",'font-weight="700"')}${tx(264,274,"TOOL BRANCH",12,"#666",'font-weight="700"')}${node(48,402,168,"Channels","Reach + threads")}${node(232,402,168,"Access","People + authority")}${node(416,402,168,"Behavior","Output + overlap")}${node(600,402,184,"Conversations","Thread ↔ issue",true)}${node(800,402,168,"Activity","Delivery ledger")}${node(984,402,200,"Agent · Channels","Endpoint summary")}${`<path d="M 1064 216 C 1064 336, 692 320, 692 394" fill="none" stroke="#000" stroke-dasharray="6 4"/><polygon points="692,394 686,385 698,385" fill="#000" stroke="none"/>`}${arrow(692,490,692,558)}${node(600,558,184,"Bound task","Normal task UI",true)}${arrow(784,602,896,602)}${node(896,558,224,"Provider thread","Safe publication")}${node(48,650,168,"Identity link","From Access")}${node(232,650,168,"Relay drawer","When private")}${node(416,650,168,"Detach/rebind","From conversation")}${arrow(416,694,592,626,true)}${annotations([{x:40,y:120,w:1152,h:184},{x:256,y:282,w:208,h:104},{x:40,y:394,w:1152,h:104},{x:40,y:542,w:1096,h:204}])}`);
}

function viewerHtml() {
  const templatePath = join(root, "../../../packages/skills-catalog/catalog/bundled/product/wireframe/assets/site-template.html");
  const template = readFileSync(templatePath, "utf8");
  const style = template.match(/<style>[\s\S]*?<\/style>/)?.[0];
  if (!style) throw new Error(`Could not read viewer styles from ${templatePath}`);
  const viewerScreens = [...screens, ...providerScreens];
  const toc = viewerScreens.map((screen) => `<a href="#s${screen.id}"><span class="num">${Number(screen.id)}</span>${esc(screen.title)}</a>`).join("\n");
  const sections = viewerScreens.map((screen) => {
    const notes = screen.annotations.map((note,index)=>`<li><b>${index+1}</b> — ${esc(note).replaceAll("**","")}</li>`).join("\n");
    return `<section id="s${screen.id}"><div class="lede">${screen.group}</div><h2><span class="step-num">${Number(screen.id)}.</span>${esc(screen.title)}</h2><p class="desc">${esc(screen.subtitle)}</p><div class="grid"><div class="wire" data-zoom data-caption="${screen.id} · ${esc(screen.title)} (desktop)"><div class="label"><span>${screen.id}-${screen.slug}.svg</span><span>1280×800 · desktop</span></div><img src="wireframes-v2/${screen.id}-${screen.slug}.svg" alt="${esc(screen.title)} desktop wireframe" /></div><div class="wire mobile-wire mobile-col" data-zoom data-caption="${screen.id} · ${esc(screen.title)} (mobile)"><div class="label"><span>mobile</span><span>375×812</span></div><img src="wireframes-v2/${screen.id}-${screen.slug}-mobile.svg" alt="${esc(screen.title)} mobile wireframe" /></div><div class="notes-col"><div class="notes"><h3>Annotations</h3><ul>${notes}</ul><div class="why"><b>Rationale:</b> ${esc(screen.rationale)}</div></div></div></div></section>`;
  }).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Paperclip chat adapters — provider planning</title>${style}<style>.doc-links{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:16px}.doc-links a{min-height:48px;display:inline-flex;align-items:center;font-size:13px;font-weight:600}.notice{max-width:var(--maxw);margin:-32px 0 48px;padding:14px 18px;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:4px}.notice p{margin:0}.decision{margin-top:24px;padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:8px}.decision b{display:block;margin-bottom:6px}code{font-size:.92em}</style></head><body><div class="shell"><details class="toc"><summary class="toc-summary"><span><span class="crumb">Chat adapters · v2</span><br><span class="title">Jump to a screen</span></span><span class="chevron" aria-hidden="true"></span></summary><nav class="toc-body" aria-label="Section navigation"><h1>Chat adapters</h1><div style="font-size:13px;color:var(--muted);margin-bottom:16px">Shared flow + provider deep dives</div><h2>Documents</h2><a href="2026-09-03-chat-adapters-architecture.md"><span class="num">A</span>Architecture</a><a href="2026-09-04-chat-adapters-ui-surfaces-v2.md"><span class="num">U</span>Shared UI specification</a><a href="2026-09-04-chat-adapters-platform-surfaces.md"><span class="num">P</span>Platform specification</a><a href="2026-09-03-chat-adapters-research-notes.md"><span class="num">R</span>Research notes</a><h2>Flow</h2><a href="#flow"><span class="num">⤳</span>Product flow</a><h2>Screens</h2>${toc}<h2>Review</h2><a href="#coverage"><span class="num">✓</span>Decisions and coverage</a></nav></details><main><header class="hero"><div class="crumb">Paperclip · Connectors · Provider planning</div><h1>Connect simply. Configure precisely.</h1><p>Chat connectors live in the existing <code>/apps</code> catalog. The shared path asks for an agent and provider invite; detailed Slack, GitHub, Teams, and Telegram setup and behavior stay provider-specific.</p><div class="decision"><b>Minimum chat path</b><span>Connectors → purpose only if ambiguous → agent → provider handoff → connected.</span></div><div class="doc-links"><a href="2026-09-03-chat-adapters-architecture.md">Architecture plan</a><a href="2026-09-04-chat-adapters-ui-surfaces-v2.md">Shared UI specification</a><a href="2026-09-04-chat-adapters-platform-surfaces.md">Platform-specific specification</a><a href="2026-09-03-chat-adapters-ui-surfaces.md">v1 requirements inventory</a></div><div class="pills"><span class="pill">24 focused surfaces</span><span class="pill">4 provider deep dives</span><span class="pill">Setup + settings + interactions</span><span class="pill">Desktop + mobile</span></div></header><div class="notice" role="note"><p><b>Review convention:</b> red dashed marks and numbered circles are annotations only. They are not proposed Paperclip interface elements.</p></div><section id="flow" class="flow-section"><div class="lede">Navigation and product flow</div><h2>Setup ends at the provider handoff</h2><p class="desc">The tool branch returns to the existing tool-connection flow. The chat branch creates a default endpoint, then uses the ordinary connector-detail shell. Screens 13–24 detail the external setup, settings, and native interaction model for each launch provider.</p><div class="wire" data-zoom data-caption="Simplified chat connector product flow"><div class="label"><span>flow.svg</span><span>1280×800</span></div><img src="wireframes-v2/flow.svg" alt="Simplified chat connector navigation and product flow"/></div><div class="notes"><h3>Annotations</h3><ul><li><b>1</b> — Primary chat path from the existing catalog through provider invite.</li><li><b>2</b> — Conditional tool-purpose branch into the existing setup flow.</li><li><b>3</b> — Connector detail navigation and the agent-summary route.</li><li><b>4</b> — Bound task, publication, identity, relay, and detach branches.</li></ul></div></section>${sections}<section id="coverage"><div class="lede">Decisions and coverage</div><h2>What this version resolves</h2><div class="notes"><ul><li><b>One catalog:</b> Connectors remains the only discovery, setup, and management entry point.</li><li><b>Minimal shared wizard:</b> chat-only providers ask for agent and provider handoff; dual-purpose providers add one direction choice.</li><li><b>Real external handoffs:</b> each provider setup separates Paperclip-owned fields from provider app registration, policy, consent, installation, and verification.</li><li><b>Provider-native task boundaries:</b> Slack thread, GitHub object/review thread, Teams post/conversation, and Telegram active chat/topic behavior are explicit.</li><li><b>Least privilege:</b> GitHub code/tool access, Teams RSC/Graph access, Slack optional rich scopes, and Telegram topic administration are never implied by basic chat setup.</li><li><b>Exact fallbacks:</b> unsupported streaming, files, buttons, modals, ephemeral replies, history, or ambient visibility degrade to a named behavior.</li><li><b>Research pins:</b> Paperclip <code>b84964e5a2fa8b1e6498a1ccb471f6adba97d470</code>; Vercel Chat SDK <code>51322dde8f4aafd8a7fc7a20cbfd7ae45cafaa5c</code>; OpenTag <code>6a770d862349f8e996c23c145aef6d6275914a23</code>.</li></ul></div></section><div class="footer">Generated from Paperclip's bundled <code>wireframe</code> skill viewer template. Wires use black 1.5 strokes, white surfaces, grayscale placeholders, an 8px rhythm, and 12/14/20/28 type sizes. Red is reserved for review annotations.</div></main></div><div class="lightbox" id="lb" aria-hidden="true"><span class="close" id="lbClose" role="button" aria-label="Close preview">×</span><img id="lbImg" alt=""/><div class="caption" id="lbCap"></div></div><script>const lb=document.getElementById('lb'),lbImg=document.getElementById('lbImg'),lbCap=document.getElementById('lbCap');document.querySelectorAll('[data-zoom]').forEach(el=>el.addEventListener('click',()=>{const target=el.tagName==='IMG'?el:el.querySelector('img');if(!target)return;lbImg.src=target.src;lbImg.alt=target.alt;lbCap.textContent=el.dataset.caption||target.alt||'';lb.classList.add('open');lb.setAttribute('aria-hidden','false')}));function closeLightbox(){lb.classList.remove('open');lb.setAttribute('aria-hidden','true')}lb.addEventListener('click',closeLightbox);document.getElementById('lbClose').addEventListener('click',closeLightbox);document.addEventListener('keydown',e=>{if(e.key==='Escape')closeLightbox()});const tocElement=document.querySelector('details.toc'),media=window.matchMedia('(max-width:900px)'),setToc=()=>{tocElement.open=!media.matches};setToc();media.addEventListener('change',setToc);tocElement.querySelectorAll('.toc-body a').forEach(link=>link.addEventListener('click',()=>{if(media.matches)tocElement.open=false}));</script></body></html>`;
}

for (const screen of screens) {
  const desktop = screen.kind === "catalog" ? catalogDesktop(screen)
    : screen.kind === "purpose" ? purposeDesktop(screen)
      : screen.kind === "agent" ? chooseAgentDesktop(screen)
        : screen.kind === "invite" ? inviteDesktop(screen)
          : screen.kind === "detail" ? detailDesktop(screen)
            : screen.kind === "task" ? taskDesktop(screen)
              : agentChannelsDesktop(screen);
  const mobile = screen.kind === "catalog" ? catalogMobile(screen)
    : screen.kind === "purpose" ? purposeMobile(screen)
      : screen.kind === "agent" ? chooseAgentMobile(screen)
        : screen.kind === "invite" ? inviteMobile(screen)
          : screen.kind === "detail" ? detailMobile(screen)
            : screen.kind === "task" ? taskMobile(screen)
              : agentChannelsMobile(screen);
  writeFileSync(join(out, `${screen.id}-${screen.slug}.svg`), `${desktop}\n`);
  writeFileSync(join(out, `${screen.id}-${screen.slug}-mobile.svg`), `${mobile}\n`);
}
writeFileSync(join(out, "flow.svg"), `${flowSvg()}\n`);
writeFileSync(
  join(root, "index.html"),
  `${viewerHtml().replaceAll("b84964e5a2fa8b1e6498a1ccb471f6adba97d470", "7b094724e65c04949706df638d497afb02c84b62")}\n`,
);
console.log(`Generated ${screens.length * 2 + 1} SVGs and simplified index.html`);
