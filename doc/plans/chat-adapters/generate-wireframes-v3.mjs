import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { providerScreens } from "./platform-wireframe-data-v3.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const previous = join(root, "wireframes-v2");
const out = join(root, "wireframes-v3");
mkdirSync(out, { recursive: true });

const esc = (value) => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const tx = (x, y, value, size = 14, fill = "#000", extra = "") =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" stroke="none" ${extra}>${esc(value)}</text>`;
const ln = (x1, y1, x2, y2, extra = "") => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${extra}/>`;
const rc = (x, y, w, h, extra = "") => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" ${extra}/>`;
const circle = (x, y, r, extra = "") => `<circle cx="${x}" cy="${y}" r="${r}" ${extra}/>`;

function baseSvg(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif" fill="#fff" stroke="#000" stroke-width="1.5"><rect width="${width}" height="${height}"/>${body}</svg>`;
}

function wrap(value, width = 54, max = 2) {
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

function control(x, y, label, width = 176) {
  return `${rc(x, y, width, 48, 'fill="#fff"')}${tx(x + 16, y + 30, label, 12, "#000", 'font-weight="600"')}${tx(x + width - 16, y + 30, "⌄", 12, "#666", 'text-anchor="end"')}`;
}

function annotations(regions, mobile = false) {
  return `<g data-region="annotations">${regions.map((region, index) => {
    const radius = mobile ? 9 : 12;
    return `${rc(region.x, region.y, region.w, region.h, 'fill="none" stroke="#d33" stroke-dasharray="6 4"')}${circle(region.x, region.y, radius, 'fill="#fff" stroke="#d33" stroke-dasharray="4 2"')}${tx(region.x, region.y + 4, index + 1, 12, "#d33", 'text-anchor="middle" font-weight="700"')}`;
  }).join("\n")}</g>`;
}

function globalSidebar(height) {
  const items = ["New Task", "Search", "Dashboard", "Inbox", "Tasks", "Projects", "Routines", "Artifacts", "Agents", "Skills", "Connectors", "Audit"];
  return `<g>${tx(24, 38, "Paperclip", 20, "#000", 'font-weight="700"')}${items.map((item, index) => {
    const y = 78 + index * 46;
    return `${item === "Connectors" ? rc(12, y - 28, 216, 38, 'fill="#e6e6e6"') : ""}${circle(32, y - 10, 6, 'fill="#e6e6e6"')}${tx(52, y - 5, item, 14, item === "Connectors" ? "#000" : "#666", item === "Connectors" ? 'font-weight="600"' : "")}`;
  }).join("\n")}${tx(24, height - 56, "Acme Company", 14, "#000", 'font-weight="600"')}${tx(24, height - 28, "Dana · Admin", 12, "#666")}${ln(240, 0, 240, height)}</g>`;
}

function topbar(crumb) {
  return `<g>${ln(240, 60, 1280, 60)}${tx(264, 36, crumb, 14, "#666")}${circle(1240, 30, 16, 'fill="#e6e6e6"')}</g>`;
}

function detailContext(provider, active, height) {
  const items = ["Overview", "Settings", "Access", "Conversations", "Activity"];
  const label = provider === "Microsoft Teams" ? "Teams" : provider;
  return `<g>${tx(264, 94, "‹  All connectors", 12, "#666")}${circle(280, 132, 18, 'fill="#e6e6e6"')}${tx(308, 138, `Maya on ${label}`, 14, "#000", 'font-weight="700"')}${items.map((item, index) => `${item === active ? rc(252, 168 + index * 48, 216, 40, 'fill="#e6e6e6"') : ""}${tx(280, 194 + index * 48, item, 14, item === active ? "#000" : "#666", item === active ? 'font-weight="600"' : "")}`).join("\n")}${ln(480, 60, 480, height)}</g>`;
}

function mobileHeader(label) {
  return `${rc(0, 0, 375, 56)}${tx(16, 35, `‹  ${label}`, 14, "#000", 'font-weight="600"')}${tx(359, 35, "Menu", 12, "#666", 'text-anchor="end"')}`;
}

const settingsData = {
  Slack: [
    { title: "Where Maya can listen", intro: "Paperclip can narrow Slack reach, but cannot exceed where the app is installed and invited.", rows: [
      ["Workspace", "Installation that owns this bot identity.", "Acme"],
      ["Allowed channels", "Only these invited channels may activate Maya.", "2 channels"],
      ["Membership changes", "Pause a channel if Slack removes the bot.", "Automatic"],
      ["Direct messages", "Allow people in this workspace to start tasks in DM.", "On"]
    ]},
    { title: "Conversation and task boundaries", intro: "Slack threads provide the native boundary for channel work.", rows: [
      ["New channel task", "A root @maya mention starts one Slack thread and one issue.", "Mention"],
      ["Thread replies", "Human replies in a bound thread continue without a mention.", "Subscribed"],
      ["Existing threads", "A first mention inside an unbound thread may claim it once.", "Allow"]
    ]},
    { title: "Responses and interactions", intro: "Each feature is enabled independently and still passes through Paperclip authorization.", rows: [
      ["Acknowledgement", "React immediately, then report safe task milestones.", "Reaction"],
      ["Streaming", "Use Slack native streaming and optional Stop when available.", "Native"],
      ["Rich responses", "Block Kit cards, buttons, selects, and safe links.", "On"],
      ["Modals and commands", "Open validated forms and registered commands.", "On"],
      ["Files and private replies", "Sanitized files; ephemeral denial with DM fallback.", "On"]
    ]},
    { title: "Installation, security, and delivery", intro: "Operational state remains visible without joining the setup wizard.", rows: [
      ["Installation", "Single workspace, OAuth workspace, or Enterprise Grid.", "OAuth"],
      ["Ingress", "Verified webhook by default; relay for private Paperclip.", "Direct"],
      ["Slack alternative", "Socket Mode requires an app token and persistent listener.", "Off"],
      ["Credential health", "Signing secret, token rotation, scopes, and events.", "Healthy"]
    ]},
    { title: "Fallbacks", intro: "Degrade one feature without breaking the endpoint.", rows: [
      ["Missing membership or scope", "Offer Invite in Slack or Reinstall with scope; otherwise use text plus a Paperclip link.", "Explain"]
    ]}
  ],
  GitHub: [
    { title: "Repositories and conversation surfaces", intro: "Paperclip narrows the repositories selected in the GitHub App installation.", rows: [
      ["GitHub installation", "The App installation and its selected repositories.", "Acme org"],
      ["Allowed repositories", "Only these installed repositories may activate Maya.", "2 repos"],
      ["Conversation types", "Issues, PR conversations, and inline review threads.", "3 types"],
      ["GitHub host", "GitHub.com or a verified Enterprise Server base URL.", "GitHub.com"]
    ]},
    { title: "Conversation and task boundaries", intro: "GitHub already owns the native thread; Paperclip never manufactures another.", rows: [
      ["Activation", "A direct @maya comment binds the addressed object or thread.", "Mention"],
      ["Pull requests", "PR conversation and inline review threads stay distinct.", "Separate"],
      ["Additional automation", "Labels or trusted authors can start work only if enabled.", "Off"]
    ]},
    { title: "Responses and interactions", intro: "Use GitHub-native comments and make unsupported chat features explicit.", rows: [
      ["Acknowledgement", "Add a reaction after the webhook delivery is accepted.", "Reaction"],
      ["Progress", "Edit one GFM comment at a coarse cadence.", "One comment"],
      ["Final response", "Complete the same comment or post one final comment.", "Edit"],
      ["Files", "Publish signed Paperclip artifact links; no adapter upload.", "Links"],
      ["Governed actions", "Send users to authenticated Paperclip pages.", "Links"]
    ]},
    { title: "App security and delivery", intro: "The chat App has no implicit repository-code authority.", rows: [
      ["App permissions", "Issues and Pull requests write; Metadata read.", "Minimum"],
      ["Code/tool access", "Contents and code actions require a separate tool connection.", "Separate"],
      ["Webhook", "Verify signature and delivery ID; suppress self messages.", "Healthy"],
      ["Installation health", "Track suspension, permission drift, and rate limits.", "Healthy"]
    ]},
    { title: "Fallbacks", intro: "GitHub is asynchronous and comment-shaped.", rows: [
      ["Unsupported chat features", "No native stream, DM, ephemeral, modal, or SDK button: use GFM text plus a Paperclip link.", "Explain"]
    ]}
  ],
  "Microsoft Teams": [
    { title: "Tenant and conversation reach", intro: "The installed Teams app and Paperclip allowlist jointly determine reach.", rows: [
      ["Tenant", "Single-tenant or multi-tenant bot installation.", "Acme"],
      ["Teams and channels", "Allowed team/channel installations for Maya.", "1 channel"],
      ["Personal scope", "Allow direct messages to create active tasks.", "On"],
      ["Group chats", "Allow installed group chats to create active tasks.", "On"]
    ]},
    { title: "Conversation and task boundaries", intro: "The Teams conversation type selects the native boundary.", rows: [
      ["Channel posts", "A root mention and its replies map to one issue.", "Post thread"],
      ["DM and group chat", "One active issue until the person chooses New task.", "Active task"],
      ["Unmentioned replies", "Use when delivered; otherwise tell people to mention Maya.", "Detect"]
    ]},
    { title: "Responses and interactions", intro: "Start with mention-only delivery; add broader listening only when justified.", rows: [
      ["Message visibility", "Receive direct mentions under the basic installation.", "Mention only"],
      ["All-message/history RSC", "Per-team or chat grant that changes ambient visibility.", "Off"],
      ["Streaming", "Native in DM; buffered or edited in groups/channels.", "Automatic"],
      ["Cards and task modules", "Adaptive Cards, actions, and validated modal flow.", "On"],
      ["Files and private replies", "Bounded files; targeted reply with DM/text fallback.", "On"]
    ]},
    { title: "Microsoft identity and consent", intro: "Basic live conversation does not depend on broad Graph permissions.", rows: [
      ["Bot authentication", "Exactly one client secret or federated workload identity.", "Federated"],
      ["Tenant mode", "Tenant ID is required for a single-tenant app.", "Single"],
      ["User directory", "User.Read.All requires Entra application admin consent.", "Not granted"],
      ["DM history", "Chat.Read.All is privileged and separately consented.", "Off"]
    ]},
    { title: "Fallbacks", intro: "Tell the operator and participant exactly what Teams can deliver.", rows: [
      ["Missing delivery or feature", "Require a mention, request scoped RSC, or use targeted message → DM → normal text and link.", "Explain"]
    ]}
  ],
  Telegram: [
    { title: "Chats, topics, and people", intro: "Allowed IDs narrow the bot token's reach while Telegram controls membership.", rows: [
      ["Allowed chats", "Groups and private chats that may activate Maya.", "2 chats"],
      ["Forum topics", "Optional message_thread_id allowlist within a forum.", "1 topic"],
      ["Allowed users", "Optional principal allowlist before Paperclip identity rules.", "All scoped"],
      ["Privacy mode", "Keep BotFather privacy on for ordinary groups.", "On"]
    ]},
    { title: "Conversation and task boundaries", intro: "Linear chats need an explicit active task instead of a fictional native thread.", rows: [
      ["Direct messages", "First message creates the active issue.", "Active task"],
      ["Start or close", "/new or New task starts another; /close ends the active issue.", "Commands"],
      ["Groups and forums", "@maya/reply continues a group; forum topic maps directly.", "Addressed"]
    ]},
    { title: "Responses and interactions", intro: "Telegram output is rate-aware and varies between private and group chats.", rows: [
      ["Acknowledgement", "Typing indicator or reaction after durable acceptance.", "Typing"],
      ["Streaming", "Throttled post/edit; private-chat draft previews opt in.", "Post/edit"],
      ["Buttons", "Inline callbacks and URL buttons with opaque short IDs.", "On"],
      ["Files and media", "Bounded documents, photos, audio, video, and media groups.", "On"],
      ["Unavailable features", "No ephemeral, modal, select, or full thread listing.", "Text fallback"]
    ]},
    { title: "Bot security and delivery", intro: "Webhook and polling are mutually exclusive delivery modes.", rows: [
      ["Production delivery", "HTTPS webhook plus secret-token verification.", "Webhook"],
      ["Local development", "Long polling for one long-running local process.", "Polling off"],
      ["Update health", "Deduplicate update_id; track pending updates and errors.", "Healthy"],
      ["Flood and bot routes", "Rate-safe cadence; bot-to-bot routes remain off.", "Guarded"]
    ]},
    { title: "Fallbacks", intro: "Privacy and platform limits are visible behavior, not silent failure.", rows: [
      ["Unaddressed or governed action", "Ignore unrelated group traffic; use a normal reply or DM plus a Paperclip link.", "Explain"]
    ]}
  ]
};

const interactionData = {
  Slack: {
    surface: "Slack · #customer-support",
    messages: [
      ["Ari", "@maya investigate the refund timeout", "Root channel mention starts work"],
      ["Maya", "I’m on it. I opened a thread for this task.", "Thread reply · PAP-1842"],
      ["Ari", "It started after yesterday’s deploy.", "Reply in thread · no new mention"],
      ["Maya", "The retry boundary is fixed. Patch and analysis attached.", "Final thread publication"]
    ],
    task: ["PAP-1842 · Refund timeout", "Assigned to Maya · locked", "Source · Slack thread", "Ari · linked external user", "Status · Done", "Publication · Delivered"],
    rules: ["Fresh roots without @maya are ignored.", "Thread replies, files, and actions continue PAP-1842.", "Internal notes and tool traces stay in Paperclip."]
  },
  GitHub: {
    surface: "GitHub · acme/api · Issue #418",
    messages: [
      ["Ari", "@maya can you diagnose this retry regression?", "Existing issue comment"],
      ["Maya", "👀 I’m investigating and will update this comment.", "Reaction + GFM comment"],
      ["Ari", "The failing trace is linked above.", "Later issue comment"],
      ["Maya", "Cause found in the backoff boundary. See the Paperclip artifact.", "Edited final comment"]
    ],
    task: ["PAP-1848 · Retry regression", "Assigned to Maya · locked", "Source · Issue #418", "Thread · Issue conversation", "Status · Done", "Publication · Comment edited"],
    rules: ["An inline review thread would create a different binding.", "Bot-authored comments and duplicate deliveries are ignored.", "Code access requires Maya’s separate GitHub tool grant."]
  },
  "Microsoft Teams": {
    surface: "Teams · Support / General",
    messages: [
      ["Ari", "@Maya investigate the refund timeout", "New channel post"],
      ["Maya", "I’m working on it in this post’s replies.", "Reply under the root post"],
      ["Ari", "It started after yesterday’s deploy.", "Thread reply · mention if required"],
      ["Maya", "The fix is ready. Open PAP-1851 for details.", "Buffered final + Adaptive Card"]
    ],
    task: ["PAP-1851 · Refund timeout", "Assigned to Maya · locked", "Tenant · Acme", "Source · General post thread", "Status · Done", "Publication · Delivered"],
    rules: ["The installed manifest/RSC decides whether unmentioned replies arrive.", "DM/group chat uses one active task with New task.", "DM streams natively; channel/group output buffers."]
  },
  Telegram: {
    surface: "Telegram · DM / group / forum",
    messages: [
      ["DM", "First message → one active Paperclip issue", "New task or /new starts another"],
      ["Group", "@maya starts; reply to Maya continues", "Privacy-on unrelated traffic is unseen"],
      ["Forum", "Topic 381 → one Paperclip issue", "Uses stable message_thread_id"],
      ["Maya", "Working… then one rate-safe final response", "Post/edit + inline buttons"]
    ],
    task: ["PAP-1854 · Active Telegram task", "Assigned to Maya · locked", "Source · DM, group, or topic", "Boundary · Explicit and visible", "Status · Working", "Publication · Editing"],
    rules: ["The UI always names the active task in linear chats.", "Callback IDs are opaque; Paperclip reauthorizes actions.", "Unsupported/governed actions use reply or DM + link."]
  }
};

function settingsDesktop(screen) {
  const height = 1680;
  const sections = settingsData[screen.provider];
  let top = 176;
  const regions = [];
  const rendered = sections.map((section) => {
    const sectionHeight = 72 + section.rows.length * 56;
    regions.push({ x: 496, y: top - 8, w: 736, h: sectionHeight + 8 });
    const rows = section.rows.map((row, index) => {
      const y = top + 64 + index * 56;
      return `${index ? ln(520, y, 1208, y, 'stroke="#e6e6e6"') : ""}${tx(520, y + 22, row[0], 14, "#000", 'font-weight="600"')}${tx(520, y + 43, row[1], 12, "#666")}${control(1024, y + 4, row[2], 184)}`;
    }).join("\n");
    const block = `${tx(504, top + 24, section.title, 20, "#000", 'font-weight="700"')}${tx(504, top + 48, section.intro, 12, "#666")}${ln(504, top + 64, 1224, top + 64)}${rows}`;
    top += sectionHeight;
    return block;
  }).join("\n");
  return baseSvg(1280, height, `${globalSidebar(height)}${topbar(`CONNECTORS  ›  Maya on ${screen.provider}  ›  Settings`)}${detailContext(screen.provider, "Settings", height)}${tx(504, 108, screen.title, 28, "#000", 'font-weight="700"')}${tx(504, 138, screen.subtitle, 14, "#666")}${rendered}${button(1048, 1608, 176, "Save changes", true)}${tx(504, 1638, "Internal reasoning and tool traces are never published.", 12, "#666")}${annotations(regions)}`);
}

function settingsMobile(screen) {
  const height = 2112;
  const sections = settingsData[screen.provider];
  let top = 160;
  const regions = [];
  const rendered = sections.map((section) => {
    const sectionHeight = 70 + section.rows.length * 82;
    regions.push({ x: 8, y: top - 8, w: 359, h: sectionHeight + 8 });
    const rows = section.rows.map((row, index) => {
      const y = top + 62 + index * 82;
      return `${index ? ln(24, y, 351, y, 'stroke="#e6e6e6"') : ""}${tx(24, y + 24, row[0], 14, "#000", 'font-weight="600"')}${multiline(24, y + 45, wrap(row[1], 32, 2), 12, "#666", 16)}${rc(239, y + 12, 112, 48, 'fill="#fff"')}${tx(295, y + 42, row[2], 12, "#000", 'text-anchor="middle" font-weight="600"')}`;
    }).join("\n");
    const block = `${tx(16, top + 22, section.title, 20, "#000", 'font-weight="700"')}${tx(16, top + 48, section.intro.length > 56 ? section.intro.slice(0, 55) + "…" : section.intro, 12, "#666")}${ln(16, top + 62, 359, top + 62)}${rows}`;
    top += sectionHeight;
    return block;
  }).join("\n");
  const title = screen.provider === "Microsoft Teams" ? "Teams settings" : screen.title;
  return baseSvg(375, height, `${mobileHeader(`Maya on ${screen.provider === "Microsoft Teams" ? "Teams" : screen.provider}`)}${tx(16, 92, title, 20, "#000", 'font-weight="700"')}${tx(16, 120, "Provider-specific settings", 12, "#666")}${rendered}${button(16, 2040, 343, "Save changes", true)}${annotations(regions, true)}`);
}

function chatMessage(x, y, w, message, index) {
  const isAgent = message[0] === "Maya";
  return `${rc(x + (isAgent ? 48 : 0), y, w - 48, 84, isAgent ? 'fill="#e6e6e6"' : 'fill="#fff"')}${tx(x + (isAgent ? 68 : 20), y + 24, message[0], 12, "#666", 'font-weight="600"')}${tx(x + (isAgent ? 68 : 20), y + 48, message[1], 12, "#000", 'font-weight="600"')}${tx(x + (isAgent ? 68 : 20), y + 70, message[2], 12, "#666")}`;
}

function interactionDesktop(screen) {
  const height = 960;
  const d = interactionData[screen.provider];
  const messageYs = [248, 348, 448, 548];
  const messages = d.messages.map((message, index) => chatMessage(520, messageYs[index], 408, message, index)).join("\n");
  const taskRows = d.task.map((row, index) => `${index ? ln(992, 306 + index * 44, 1200, 306 + index * 44, 'stroke="#e6e6e6"') : ""}${tx(992, 334 + index * 44, row, index === 0 ? 14 : 12, index === 0 ? "#000" : "#666", index === 0 ? 'font-weight="700"' : "")}`).join("\n");
  return baseSvg(1280, height, `${globalSidebar(height)}${topbar(`CONNECTORS  ›  Maya on ${screen.provider}  ›  Conversation example`)}${detailContext(screen.provider, "Conversations", height)}${tx(504, 104, "Behavior walkthrough · planning artifact", 12, "#666", 'font-weight="600"')}${tx(504, 138, screen.title, 28, "#000", 'font-weight="700"')}${tx(504, 166, screen.subtitle, 14, "#666")}
    ${tx(504, 210, `What Ari sees · ${d.surface}`, 20, "#000", 'font-weight="700"')}${rc(504, 228, 440, 420)}${messages}
    ${tx(968, 210, "What Paperclip creates", 20, "#000", 'font-weight="700"')}${rc(968, 228, 256, 420, 'fill="#e6e6e6"')}${taskRows}${button(992, 572, 208, "Open task")}
    ${tx(504, 704, "Behavior that stays true", 20, "#000", 'font-weight="700"')}${d.rules.map((rule, index) => `${circle(520, 748 + index * 52, 8, 'fill="#e6e6e6"')}${tx(544, 752 + index * 52, rule, 14, "#000")}`).join("\n")}
    ${tx(504, 910, "This walkthrough explains behavior; it is not a proposed standalone product page.", 12, "#666")}
    ${annotations([{x:512,y:240,w:424,h:96},{x:560,y:340,w:376,h:96},{x:960,y:220,w:272,h:436},{x:512,y:440,w:424,h:96},{x:560,y:540,w:376,h:96}])}`);
}

function interactionMobile(screen) {
  const height = 1320;
  const d = interactionData[screen.provider];
  const messageYs = [242, 344, 446, 548];
  const messages = d.messages.map((message, index) => `${rc(24 + (message[0] === "Maya" ? 24 : 0), messageYs[index], message[0] === "Maya" ? 303 : 327, 88, message[0] === "Maya" ? 'fill="#e6e6e6"' : 'fill="#fff"')}${tx(40 + (message[0] === "Maya" ? 24 : 0), messageYs[index] + 22, message[0], 12, "#666", 'font-weight="600"')}${tx(40 + (message[0] === "Maya" ? 24 : 0), messageYs[index] + 46, message[1].length > 42 ? message[1].slice(0, 41) + "…" : message[1], 12, "#000", 'font-weight="600"')}${tx(40 + (message[0] === "Maya" ? 24 : 0), messageYs[index] + 70, message[2].length > 42 ? message[2].slice(0, 41) + "…" : message[2], 12, "#666")}`).join("\n");
  return baseSvg(375, height, `${mobileHeader("Conversation example")}${tx(16, 84, "Behavior walkthrough · not a product page", 12, "#666", 'font-weight="600"')}${tx(16, 116, screen.title.replace("Microsoft Teams", "Teams"), 20, "#000", 'font-weight="700"')}${tx(16, 156, `What Ari sees · ${d.surface.length > 35 ? d.surface.slice(0, 34) + "…" : d.surface}`, 14, "#000", 'font-weight="700"')}${rc(16, 176, 343, 476)}${messages}
    ${tx(16, 700, "What Paperclip creates", 20, "#000", 'font-weight="700"')}${rc(16, 724, 343, 320, 'fill="#e6e6e6"')}${d.task.map((row,index)=>`${index?ln(32,760+index*36,343,760+index*36,'stroke="#fff"'):""}${tx(36, 752 + index * 36, row, index===0?14:12, index===0?"#000":"#666", index===0?'font-weight="700"':"")}`).join("\n")}${button(36, 972, 303, "Open task")}
    ${tx(16, 1080, "Behavior that stays true", 20, "#000", 'font-weight="700"')}${d.rules.map((rule,index)=>`${circle(28,1120+index*62,7,'fill="#e6e6e6"')}${multiline(48,1124+index*62,wrap(rule,43,2),12,"#000",16)}`).join("\n")}
    ${annotations([{x:16,y:234,w:343,h:104},{x:40,y:336,w:319,h:104},{x:8,y:716,w:359,h:336},{x:16,y:438,w:343,h:104},{x:40,y:540,w:319,h:104}],true)}`);
}

function flowSvg() {
  const height = 900;
  const node = (x,y,w,title,sub,fill=false) => `${rc(x,y,w,88,fill?'fill="#e6e6e6"':'fill="#fff"')}${tx(x+16,y+32,title,14,"#000",'font-weight="700"')}${tx(x+16,y+58,sub,12,"#666")}`;
  const arrow = (x1,y1,x2,y2) => `${ln(x1,y1,x2,y2)}<polygon points="${x2},${y2} ${x2-9},${y2-6} ${x2-9},${y2+6}" fill="#000" stroke="none"/>`;
  return baseSvg(1280,height,`${tx(48,48,"Chat connectors · consolidated review flow",28,"#000",'font-weight="700"')}${tx(48,76,"One shared start, then provider-specific setup and settings; shared Paperclip operations appear once.",14,"#666")}
    ${node(48,128,176,"Connectors","Choose provider",true)}${arrow(224,172,264,172)}${node(264,128,192,"Purpose?","Only if ambiguous")}${arrow(456,172,496,172)}${node(496,128,184,"Choose agent","Exactly one")}
    ${tx(48,278,"PROVIDER-SPECIFIC PATH",12,"#666",'font-weight="700"')}${node(48,304,232,"Slack","App install → settings")}${node(296,304,232,"GitHub","GitHub App → settings")}${node(544,304,232,"Microsoft Teams","App package → settings")}${node(792,304,232,"Telegram","BotFather → settings")}
    ${arrow(680,216,680,264)}${ln(164,264,908,264)}${ln(164,264,164,304)}${ln(412,264,412,304)}${ln(660,264,660,304)}${ln(908,264,908,304)}
    ${tx(48,486,"EACH PROVIDER",12,"#666",'font-weight="700"')}${node(48,512,216,"External setup","Provider-owned handoff",true)}${arrow(264,556,304,556)}${node(304,512,216,"Settings","Vertical sections")}${arrow(520,556,560,556)}${node(560,512,240,"Conversation example","What people see")}
    ${tx(48,690,"SHARED PAPERCLIP OPERATIONS",12,"#666",'font-weight="700"')}${node(48,716,176,"Overview","Health + lifecycle")}${node(240,716,176,"Access","Identity + authority")}${node(432,716,176,"Conversations","Thread ↔ issue")}${node(624,716,176,"Activity","Delivery ledger")}${node(816,716,176,"Bound task","Publish + detach")}${node(1008,716,176,"Agent Channels","Endpoint summary")}
    ${annotations([{x:40,y:120,w:648,h:104},{x:40,y:256,w:992,h:152},{x:40,y:504,w:768,h:104},{x:40,y:708,w:1152,h:104}])}`);
}

const sharedSpec = readFileSync(join(root, "2026-09-04-chat-adapters-ui-surfaces-v2.md"), "utf8");
const oldAnnotations = new Map(
  [...sharedSpec.matchAll(/### (\d{2})[^\n]*\n\nPurpose:[^\n]*\n\n((?:\d+\.[^\n]*\n){4})/g)].map((match) => [
    match[1], match[2].trim().split("\n").map((line) => line.replace(/^\d+\.\s*/, ""))
  ])
);

const sharedScreens = [
  { id:"01", slug:"connectors-catalog", title:"Connectors", subtitle:"Connect tools and places where people talk to agents.", group:"Start", source:"01-connectors-catalog", rationale:"The existing Apps catalog remains the single entry point." },
  { id:"02", slug:"connection-purpose", title:"Connect GitHub", subtitle:"Choose chat or tool use only when a provider supports both.", group:"Start", source:"02-connection-purpose", rationale:"The purpose decision appears only when the provider is ambiguous." },
  { id:"03", slug:"choose-agent", title:"Which agent do you want to chat with?", subtitle:"Choose the one Paperclip agent represented by this bot.", group:"Start", source:"03-choose-agent", rationale:"This is the only shared Paperclip-specific setup decision." },
  { id:"05", slug:"connector-overview", title:"Connector overview", subtitle:"Identity, health, lifecycle, and the provider-specific settings entry point.", group:"Paperclip", source:"05-connector-overview", rationale:"Overview remains shared while setup and settings vary by provider." },
  { id:"07", slug:"access", title:"Access", subtitle:"Map external people to Paperclip authority.", group:"Paperclip", source:"07-access", rationale:"Linked users and sponsored guests use one cross-provider permission model." },
  { id:"09", slug:"conversations", title:"Conversations", subtitle:"Inspect each external conversation and its Paperclip issue.", group:"Paperclip", source:"09-conversations", rationale:"Every provider-specific boundary resolves to the same durable binding view." },
  { id:"10", slug:"activity", title:"Activity", subtitle:"Inspect deliveries, retries, permission failures, and provider health.", group:"Paperclip", source:"10-activity", rationale:"Diagnostics remain one shared durable ledger." },
  { id:"11", slug:"bound-task", title:"Externally bound task", subtitle:"A normal Paperclip task with explicit publication and detach controls.", group:"Paperclip", source:"11-bound-task", rationale:"External work remains governed by the ordinary task experience." },
  { id:"12", slug:"agent-channels", title:"Agent Channels", subtitle:"See every provider identity representing this agent.", group:"Paperclip", source:"12-agent-channels", rationale:"Agent detail summarizes endpoints; Apps continues to manage them." }
].map((screen) => ({...screen, annotations:oldAnnotations.get(screen.id), desktopSize:"1280×800", mobileSize:"375×812"}));

for (const screen of sharedScreens) {
  writeFileSync(join(out, `${screen.id}-${screen.slug}.svg`), readFileSync(join(previous, `${screen.source}.svg`), "utf8"));
  writeFileSync(join(out, `${screen.id}-${screen.slug}-mobile.svg`), readFileSync(join(previous, `${screen.source}-mobile.svg`), "utf8"));
}

for (const screen of providerScreens) {
  if (screen.kind === "providerSetup") {
    writeFileSync(join(out, `${screen.id}-${screen.slug}.svg`), readFileSync(join(previous, `${screen.id}-${screen.slug}.svg`), "utf8"));
    writeFileSync(join(out, `${screen.id}-${screen.slug}-mobile.svg`), readFileSync(join(previous, `${screen.id}-${screen.slug}-mobile.svg`), "utf8"));
    screen.desktopSize = "1280×800";
    screen.mobileSize = "375×812";
  } else if (screen.kind === "providerSettings") {
    writeFileSync(join(out, `${screen.id}-${screen.slug}.svg`), `${settingsDesktop(screen)}\n`);
    writeFileSync(join(out, `${screen.id}-${screen.slug}-mobile.svg`), `${settingsMobile(screen)}\n`);
    screen.desktopSize = "1280×1680";
    screen.mobileSize = "375×2112";
  } else {
    writeFileSync(join(out, `${screen.id}-${screen.slug}.svg`), `${interactionDesktop(screen)}\n`);
    writeFileSync(join(out, `${screen.id}-${screen.slug}-mobile.svg`), `${interactionMobile(screen)}\n`);
    screen.desktopSize = "1280×960";
    screen.mobileSize = "375×1320";
  }
}
writeFileSync(join(out, "flow.svg"), `${flowSvg()}\n`);

const groups = [
  ["Start", sharedScreens.filter((screen) => screen.group === "Start")],
  ["Slack", providerScreens.filter((screen) => screen.provider === "Slack")],
  ["GitHub", providerScreens.filter((screen) => screen.provider === "GitHub")],
  ["Microsoft Teams", providerScreens.filter((screen) => screen.provider === "Microsoft Teams")],
  ["Telegram", providerScreens.filter((screen) => screen.provider === "Telegram")],
  ["Paperclip", sharedScreens.filter((screen) => screen.group === "Paperclip")]
];
const orderedScreens = groups.flatMap(([, screens]) => screens);

function viewerHtml() {
  const template = readFileSync(join(root, "../../../packages/skills-catalog/catalog/bundled/product/wireframe/assets/site-template.html"), "utf8");
  const style = template.match(/<style>[\s\S]*?<\/style>/)?.[0];
  if (!style) throw new Error("Could not load wireframe viewer styles");
  const toc = groups.map(([label, screens]) => `<h2>${esc(label)}</h2>${screens.map((screen) => `<a href="#s${screen.id}"><span class="num">${Number(screen.id)}</span>${esc(screen.title)}</a>`).join("\n")}`).join("\n");
  const sections = groups.map(([label, screens]) => `<div class="provider-break"><div class="lede">${esc(label)}</div><h2>${label === "Start" ? "Shared connection start" : label === "Paperclip" ? "Shared Paperclip operations" : `${esc(label)} planning`}</h2></div>${screens.map((screen) => {
    const notes = screen.annotations.map((note,index)=>`<li><b>${index+1}</b> — ${esc(note).replaceAll("**","")}</li>`).join("\n");
    return `<section id="s${screen.id}"><div class="lede">${esc(screen.group)}</div><h2><span class="step-num">${Number(screen.id)}.</span>${esc(screen.title)}</h2><p class="desc">${esc(screen.subtitle)}</p><div class="grid"><div class="wire" data-zoom data-caption="${screen.id} · ${esc(screen.title)} (desktop)"><div class="label"><span>${screen.id}-${screen.slug}.svg</span><span>${screen.desktopSize} · desktop</span></div><img src="wireframes-v3/${screen.id}-${screen.slug}.svg" alt="${esc(screen.title)} desktop wireframe" /></div><div class="wire mobile-wire mobile-col" data-zoom data-caption="${screen.id} · ${esc(screen.title)} (mobile)"><div class="label"><span>mobile</span><span>${screen.mobileSize}</span></div><img src="wireframes-v3/${screen.id}-${screen.slug}-mobile.svg" alt="${esc(screen.title)} mobile wireframe" /></div><div class="notes-col"><div class="notes"><h3>Annotations</h3><ul>${notes}</ul><div class="why"><b>Rationale:</b> ${esc(screen.rationale)}</div></div></div></div></section>`;
  }).join("\n")}`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Paperclip chat adapters — consolidated provider review</title>${style}<style>.doc-links{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:16px}.doc-links a{min-height:48px;display:inline-flex;align-items:center;font-size:13px;font-weight:600}.notice{max-width:var(--maxw);margin:-32px 0 48px;padding:14px 18px;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:4px}.notice p{margin:0}.decision{margin-top:24px;padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:8px}.decision b{display:block;margin-bottom:6px}.provider-break{max-width:var(--maxw);margin:80px 0 8px;padding-top:24px;border-top:2px solid var(--ink)}.provider-break h2{font-size:28px;margin:6px 0 0}.toc-body h2{margin-top:18px}code{font-size:.92em}</style></head><body><div class="shell"><details class="toc"><summary class="toc-summary"><span><span class="crumb">Chat adapters · v3</span><br><span class="title">Jump to a screen</span></span><span class="chevron" aria-hidden="true"></span></summary><nav class="toc-body" aria-label="Section navigation"><h1>Chat adapters</h1><div style="font-size:13px;color:var(--muted);margin-bottom:16px">Consolidated provider review</div><h2>Documents</h2><a href="2026-09-03-chat-adapters-architecture.md"><span class="num">A</span>Architecture</a><a href="2026-09-04-chat-adapters-ui-surfaces-v3.md"><span class="num">U</span>Consolidated UI specification</a><a href="2026-09-04-chat-adapters-platform-surfaces.md"><span class="num">P</span>Platform research</a><h2>Flow</h2><a href="#flow"><span class="num">⤳</span>Product flow</a>${toc}<h2>Review</h2><a href="#coverage"><span class="num">✓</span>Decisions and coverage</a></nav></details><main><header class="hero"><div class="crumb">Paperclip · Connectors · Consolidated v3</div><h1>One start. Four provider paths.</h1><p>The generic connection screens appear once. Slack, GitHub, Microsoft Teams, and Telegram then own their setup, vertical settings, and plain-language conversation walkthroughs.</p><div class="decision"><b>No duplicate setup</b><span>“Invite Maya to Slack” appears only in the Slack group. Generic Channels and Behavior screens are replaced by each provider’s real settings.</span></div><div class="doc-links"><a href="2026-09-03-chat-adapters-architecture.md">Architecture plan</a><a href="2026-09-04-chat-adapters-ui-surfaces-v3.md">Consolidated UI specification</a><a href="2026-09-04-chat-adapters-platform-surfaces.md">Platform-specific research</a></div><div class="pills"><span class="pill">21 consolidated surfaces</span><span class="pill">4 provider groups</span><span class="pill">Vertical settings</span><span class="pill">Desktop + mobile</span></div></header><div class="notice" role="note"><p><b>Review convention:</b> red dashed marks are annotations, not proposed UI. Conversation walkthroughs explain what people see and what Paperclip creates; they are not standalone product pages.</p></div><section id="flow" class="flow-section"><div class="lede">Navigation and product flow</div><h2>Provider-specific after the shared start</h2><p class="desc">Connectors, conditional purpose, and agent selection are shared. The provider then owns its external handoff, settings, and conversation semantics. Paperclip operations appear once.</p><div class="wire" data-zoom data-caption="Consolidated chat connector product flow"><div class="label"><span>flow.svg</span><span>1280×900</span></div><img src="wireframes-v3/flow.svg" alt="Consolidated chat connector product flow"/></div></section>${sections}<section id="coverage"><div class="lede">Review</div><h2>What changed in v3</h2><div class="notes"><ul><li><b>Grouped navigation:</b> Slack, GitHub, Microsoft Teams, and Telegram each have their own left-navigation header and three screens.</li><li><b>No duplicate Slack handoff:</b> the earlier generic Invite screen is removed from the viewer; Slack Setup is the only version.</li><li><b>No generic settings duplicates:</b> the earlier generic Channels and Behavior screens are removed; provider settings own those decisions.</li><li><b>Normal settings layout:</b> every provider uses full-width vertical sections and ordinary setting rows, with tall canvases where needed.</li><li><b>Understandable interactions:</b> internal ingress/binding pipeline labels are replaced by the provider conversation people see beside the single Paperclip issue it creates.</li><li><b>Stable review links:</b> provider IDs 13–24 are retained, so existing anchors such as <code>#s15</code> still point to the same provider topic.</li><li><b>Paperclip base:</b> <code>7b094724e65c04949706df638d497afb02c84b62</code>, matching <code>origin/master</code> when generated.</li></ul></div></section><div class="footer">Generated with Paperclip’s wireframe contract. Provider settings intentionally use long canvases so detail remains legible in a conventional vertical settings hierarchy.</div></main></div><div class="lightbox" id="lb" aria-hidden="true"><span class="close" id="lbClose" role="button" aria-label="Close preview">×</span><img id="lbImg" alt=""/><div class="caption" id="lbCap"></div></div><script>const lb=document.getElementById('lb'),lbImg=document.getElementById('lbImg'),lbCap=document.getElementById('lbCap');document.querySelectorAll('[data-zoom]').forEach(el=>el.addEventListener('click',()=>{const target=el.querySelector('img');if(!target)return;lbImg.src=target.src;lbImg.alt=target.alt;lbCap.textContent=el.dataset.caption||target.alt||'';lb.classList.add('open');lb.setAttribute('aria-hidden','false')}));function closeLightbox(){lb.classList.remove('open');lb.setAttribute('aria-hidden','true')}lb.addEventListener('click',closeLightbox);document.getElementById('lbClose').addEventListener('click',closeLightbox);document.addEventListener('keydown',e=>{if(e.key==='Escape')closeLightbox()});const tocElement=document.querySelector('details.toc'),media=window.matchMedia('(max-width:900px)'),setToc=()=>{tocElement.open=!media.matches};setToc();media.addEventListener('change',setToc);tocElement.querySelectorAll('.toc-body a').forEach(link=>link.addEventListener('click',()=>{if(media.matches)tocElement.open=false}));</script></body></html>`;
}

writeFileSync(join(root, "index.html"), `${viewerHtml()}\n`);
console.log(`Generated ${orderedScreens.length * 2 + 1} consolidated SVGs and index.html`);
