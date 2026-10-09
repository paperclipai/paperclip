import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { providerScreens } from "./platform-wireframe-data.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, "wireframes-v2");
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

function textLines(x, y, lines, size = 12, fill = "#666", gap = 20, extra = "") {
  return lines.map((line, index) => tx(x, y + index * gap, line, size, fill, extra)).join("\n");
}

function button(x, y, w, label, primary = false) {
  return `${rc(x, y, w, 48, primary ? 'fill="#000"' : 'fill="#fff"')}${tx(x + w / 2, y + 30, label, 14, primary ? "#fff" : "#000", 'text-anchor="middle" font-weight="600"')}`;
}

function status(x, y, label, state = "Ready") {
  return `${circle(x, y - 4, 5, 'fill="#e6e6e6"')}${tx(x + 14, y, label, 12, "#000")}${tx(x + 178, y, state, 12, "#666", 'text-anchor="end"')}`;
}

function annotations(regions, mobile = false) {
  return `<g data-region="annotations">${regions.map((region, index) => {
    const radius = mobile ? 9 : 12;
    return `${rc(region.x, region.y, region.w, region.h, 'fill="none" stroke="#d33" stroke-dasharray="6 4"')}${circle(region.x, region.y, radius, 'fill="#fff" stroke="#d33" stroke-dasharray="4 2"')}${tx(region.x, region.y + 4, index + 1, 12, "#d33", 'text-anchor="middle" font-weight="700"')}`;
  }).join("\n")}</g>`;
}

function globalSidebar() {
  const items = ["New Task", "Search", "Dashboard", "Inbox", "Tasks", "Projects", "Routines", "Artifacts", "Agents", "Skills", "Connectors", "Audit"];
  return `<g data-region="global-navigation">${tx(24, 38, "Paperclip", 20, "#000", 'font-weight="700"')}${items.map((item, index) => {
    const y = 78 + index * 46;
    return `${item === "Connectors" ? rc(12, y - 28, 216, 38, 'fill="#e6e6e6"') : ""}${circle(32, y - 10, 6, 'fill="#e6e6e6"')}${tx(52, y - 5, item, 14, item === "Connectors" ? "#000" : "#666", item === "Connectors" ? 'font-weight="600"' : "")}`;
  }).join("\n")}${tx(24, 744, "Acme Company", 14, "#000", 'font-weight="600"')}${tx(24, 772, "Dana · Admin", 12, "#666")}${ln(240, 0, 240, 800)}</g>`;
}

function topbar(crumb) {
  return `<g>${ln(240, 60, 1280, 60)}${tx(264, 36, crumb, 14, "#666")}${circle(1240, 30, 16, 'fill="#e6e6e6"')}</g>`;
}

function setupContext(provider) {
  return `<g>${tx(264, 96, "CONNECTORS", 12, "#666", 'font-weight="600"')}${rc(252, 116, 216, 40, 'fill="#e6e6e6"')}${tx(280, 142, "Connect", 14, "#000", 'font-weight="600"')}${tx(280, 190, provider, 14, "#666")}${tx(280, 238, "External setup", 14, "#666")}${ln(480, 60, 480, 800)}</g>`;
}

function detailContext(provider, active = "Settings") {
  const items = ["Overview", "Settings", "Access", "Conversations", "Activity"];
  const label = provider === "Microsoft Teams" ? "Teams" : provider;
  return `<g>${tx(264, 94, "‹  All connectors", 12, "#666")}${circle(280, 132, 18, 'fill="#e6e6e6"')}${tx(308, 138, `Maya on ${label}`, 14, "#000", 'font-weight="700"')}${items.map((item, index) => `${item === active ? rc(252, 168 + index * 48, 216, 40, 'fill="#e6e6e6"') : ""}${tx(280, 194 + index * 48, item, 14, item === active ? "#000" : "#666", item === active ? 'font-weight="600"' : "")}`).join("\n")}${ln(480, 60, 480, 800)}</g>`;
}

function heading(screen, step = "") {
  return `${step ? tx(504, 90, step, 12, "#666", 'font-weight="600"') : ""}${tx(504, step ? 124 : 108, screen.title, 28, "#000", 'font-weight="700"')}${tx(504, step ? 152 : 136, screen.subtitle, 14, "#666")}`;
}

const setupData = {
  Slack: {
    bot: "Maya → Slack bot @maya", identity: "Workspace app · one bot identity",
    delivery: "Direct verified webhook", deliveryNote: "Advanced: Paperclip relay or Slack Socket Mode",
    secrets: ["Bot/OAuth token  •••• 7K2M", "Signing secret   •••• C19Q"],
    steps: ["Create app from generated manifest", "Install app to workspace or Grid org", "Return token/secret or finish OAuth", "Invite @maya to allowed channels"],
    verify: [["Bot + workspace", "Ready"], ["Signed event", "Ready"], ["Scopes + events", "Ready"], ["Channel membership", "Test next"]],
    action: "Verify Slack connection"
  },
  GitHub: {
    bot: "Maya → maya-paperclip[bot]", identity: "Chat purpose · GitHub App recommended",
    delivery: "Signed GitHub webhook", deliveryNote: "Advanced: GitHub Enterprise Server API URL",
    secrets: ["App ID  184205", "Private key  •••• PEM", "Webhook secret  •••• 93FW"],
    steps: ["Create GitHub App from checklist", "Grant Issues + PR write; Metadata read", "Subscribe to comment/review events", "Install on selected repositories"],
    verify: [["Signature ping", "Ready"], ["Bot self ID", "Ready"], ["Events", "Ready"], ["3 repositories", "Selected"]],
    action: "Verify GitHub App"
  },
  "Microsoft Teams": {
    bot: "Maya → Teams app Maya", identity: "Bot + app package · tenant installation",
    delivery: "Public messaging endpoint", deliveryNote: "Client secret or federated identity · not both",
    secrets: ["App ID  •••• 9B2A", "Client secret  •••• 18JD", "Tenant ID  •••• 7F01"],
    steps: ["Run Teams CLI create with this endpoint", "Choose tenant mode and auth method", "Get install link or app package", "Install to personal/team/group scope"],
    verify: [["Entra + bot", "Ready"], ["Manifest", "Ready"], ["Endpoint", "Ready"], ["Tenant install", "Admin action"]],
    action: "Verify Teams installation"
  },
  Telegram: {
    bot: "Maya → Telegram @maya_helper_bot", identity: "Dedicated BotFather bot",
    delivery: "Verified webhook", deliveryNote: "Polling is local-development only",
    secrets: ["Bot token  •••• A8KQ", "Webhook secret  •••• H92P"],
    steps: ["Create bot and identity in @BotFather", "Keep privacy on; allow group joining", "Set webhook URL + secret token", "Add bot to intended chats/topics"],
    verify: [["getMe identity", "Ready"], ["Delivery mode", "Webhook"], ["Pending updates", "0"], ["Test chat", "Send next"]],
    action: "Verify Telegram bot"
  }
};

const settingsData = {
  Slack: {
    reach: ["Workspace · Acme", "#customer-support · Invited", "#product-feedback · Invited", "DMs · On"],
    boundary: ["Root @maya → Slack thread", "One thread ↔ one Paperclip issue", "Bound replies need no mention"],
    capabilities: ["Agent Sessions + native stream · On", "Block Kit actions + modals · On", "Files + emoji/reactions · On", "Slash commands · Off", "Ephemeral denials · On"],
    security: ["OAuth workspace install", "Signature · Healthy", "Token rotation · Supported", "Socket Mode · Off"],
    fallback: "Missing scope → disable feature + Reinstall with scope"
  },
  GitHub: {
    reach: ["acme/api · Installed", "acme/web · Installed", "acme/legacy · Excluded", "GitHub.com"],
    boundary: ["Issue or PR conversation ↔ issue", "Review comment thread ↔ separate issue", "Discussions · Not in launch"],
    capabilities: ["Mention activation · On", "Receipt reaction · On", "One edited GFM progress comment", "Files → Paperclip links", "Labels/trusted authors · Advanced"],
    security: ["GitHub App installation", "Webhook signature · Healthy", "Self-message suppression · Ready", "Code/tool access · Separate connection"],
    fallback: "No stream/buttons/modals/DM → GFM text + Paperclip URL"
  },
  "Microsoft Teams": {
    reach: ["Tenant · Acme", "Support team / General · Allowed", "Personal scope · On", "Group chats · On"],
    boundary: ["Channel post + replies ↔ one issue", "DM/group chat ↔ active issue", "New task explicitly rebinds linear chat"],
    capabilities: ["Mention-only · On", "RSC all messages/history · Off", "Adaptive Cards + task modules · On", "DM native stream · On", "Group/channel buffered output"],
    security: ["Single tenant · Acme", "Federated identity · Healthy", "User.Read.All · Not granted", "DM history admin grant · Off"],
    fallback: "No RSC → mention on each undelivered reply; targeted → DM/text"
  },
  Telegram: {
    reach: ["Support group · Allowed", "Forum topic 381 · Allowed", "DMs · On", "Privacy mode · On"],
    boundary: ["DM → one active issue", "/new or New task → fresh issue", "Group @maya/reply; forum topic stable"],
    capabilities: ["Post/edit cadence · 3.1s group", "Native drafts in DMs · Off", "Inline buttons + URLs · On", "Files/media groups · On", "Ephemeral/modal/select · Unsupported"],
    security: ["Verified webhook · Healthy", "allowed_updates · Restricted", "Flood control · Normal", "Bot-to-bot routes · Off"],
    fallback: "Privacy-on unrelated traffic ignored; denial → reply/DM + link"
  }
};

const interactionData = {
  Slack: [
    ["Human", "Root: @maya investigate refund timeout", "Fresh root without @maya is ignored"],
    ["Ingress", "Verify signature · persist · ack < 3s", "Deduplicate event_id; resolve Ari + channel"],
    ["Binding", "Reply under root; claim Slack thread_ts", "Create one PAP issue assigned to Maya"],
    ["Turns", "Thread replies, files, buttons, modal", "Reauthorize every actor/action; queue overlap"],
    ["Output", "Native stream/edits + Stop → final", "Safe projection only; publication ID recorded"]
  ],
  GitHub: [
    ["Human", "@maya in issue, PR, or review comment", "Existing GitHub object supplies the thread"],
    ["Ingress", "Verify X-Hub-Signature-256 + delivery", "Resolve installation, repository, and actor"],
    ["Binding", "Object/thread key ↔ one PAP issue", "PR conversation ≠ inline review thread"],
    ["Turns", "Comments continue; bot comments ignored", "No code access unless separate tool grant exists"],
    ["Output", "React + post/edit one GFM comment", "No token stream; links replace files/actions"]
  ],
  "Microsoft Teams": [
    ["Human", "Channel root @Maya · or DM/group message", "Conversation type selects the boundary"],
    ["Ingress", "Verify bot activity + tenant/member", "Persist, scope-check, resolve Paperclip actor"],
    ["Binding", "Channel post thread or active conversation", "Create one PAP issue; explicit New task in DM"],
    ["Turns", "Replies, files, Adaptive Card/task module", "Mention/RSC delivery and current permissions apply"],
    ["Output", "DM native stream; group/channel buffered", "Targeted → DM/text fallback; safe output only"]
  ],
  Telegram: [
    ["DM", "First message → active issue; /new resets", "New task inline button is equivalent"],
    ["Group", "@maya activates; reply-to-Maya continues", "Privacy-on unrelated traffic is not consumed"],
    ["Forum", "message_thread_id ↔ one PAP issue", "Create/manage topics only with explicit admin grant"],
    ["Ingress", "Verify secret/poll claim; dedupe update_id", "Check chat/user scope; persist; typing/reaction"],
    ["Output", "Throttled post/edit + inline callbacks", "Opaque callback IDs; reply/DM + link fallback"]
  ]
};

function setupDesktop(screen) {
  const d = setupData[screen.provider];
  const checkRows = d.verify.map((row, index) => status(532 + (index % 2) * 338, 642 + Math.floor(index / 2) * 28, row[0], row[1])).join("\n");
  return baseSvg(1280, 800, `${globalSidebar()}${topbar(`CONNECTORS  ›  Connect ${screen.provider}`)}${setupContext(screen.provider)}${heading(screen, "Provider handoff")}
    ${rc(504, 172, 720, 72, 'fill="#e6e6e6"')}${circle(536, 208, 18, 'fill="#fff"')}${tx(568, 202, d.bot, 14, "#000", 'font-weight="700"')}${tx(568, 226, d.identity, 12, "#666")}
    ${rc(504, 264, 344, 132)}${tx(528, 294, "IN PAPERCLIP", 12, "#666", 'font-weight="600"')}${tx(528, 324, d.delivery, 14, "#000", 'font-weight="700"')}${tx(528, 350, d.deliveryNote, 12, "#666")}${tx(528, 378, "Public endpoint copied · deployment detected", 12, "#666")}
    ${rc(504, 412, 344, 172)}${tx(528, 442, "CREDENTIAL REFERENCES", 12, "#666", 'font-weight="600"')}${textLines(528, 472, d.secrets, 12, "#000", 26)}${tx(528, 558, "Values stay masked after save", 12, "#666")}
    ${rc(872, 264, 352, 320)}${tx(896, 294, "AT THE PROVIDER", 12, "#666", 'font-weight="600"')}${d.steps.map((step, index) => `${circle(912, 332 + index * 46, 12, 'fill="#e6e6e6"')}${tx(912, 336 + index * 46, index + 1, 12, "#000", 'text-anchor="middle"')}${tx(938, 336 + index * 46, step, 12, "#000", 'font-weight="600"')}`).join("\n")}${button(896, 510, 304, "Open provider setup  ↗")}
    ${rc(504, 604, 720, 92, 'fill="#e6e6e6"')}${tx(528, 628, "VERIFICATION", 12, "#666", 'font-weight="600"')}${checkRows}
    ${button(504, 720, 136, "Save draft")}${button(964, 720, 260, d.action, true)}
    ${annotations([{x:496,y:164,w:736,h:88},{x:496,y:256,w:360,h:148},{x:864,y:256,w:368,h:336},{x:496,y:404,w:360,h:188},{x:496,y:596,w:736,h:108}])}`);
}

function settingsDesktop(screen) {
  const d = settingsData[screen.provider];
  const capRows = d.capabilities.map((line, index) => `${tx(896, 236 + index * 32, line, 12, index === 1 && screen.provider === "Microsoft Teams" ? "#666" : "#000")}${tx(1196, 236 + index * 32, index === 1 && screen.provider === "Microsoft Teams" ? "Grant ›" : "", 12, "#666", 'text-anchor="end"')}`).join("\n");
  return baseSvg(1280, 800, `${globalSidebar()}${topbar(`CONNECTORS  ›  Maya on ${screen.provider}  ›  Settings`)}${detailContext(screen.provider)}${heading(screen)}
    ${rc(504, 168, 344, 168, 'fill="#e6e6e6"')}${tx(528, 198, "REACH", 12, "#666", 'font-weight="600"')}${textLines(528, 228, d.reach, 12, "#000", 25)}${tx(816, 312, "Edit  ›", 12, "#000", 'text-anchor="end" font-weight="600"')}
    ${rc(504, 352, 344, 184)}${tx(528, 382, "TASK BOUNDARY", 12, "#666", 'font-weight="600"')}${textLines(528, 414, d.boundary, 12, "#000", 27)}${tx(528, 510, "Default · provider-native and durable", 12, "#666")}
    ${rc(872, 168, 352, 232)}${tx(896, 198, "BEHAVIOR + CAPABILITIES", 12, "#666", 'font-weight="600"')}${capRows}${tx(1196, 378, "Change  ›", 12, "#000", 'text-anchor="end" font-weight="600"')}
    ${rc(872, 416, 352, 136)}${tx(896, 446, "SECURITY + DELIVERY", 12, "#666", 'font-weight="600"')}${textLines(896, 474, d.security, 12, "#000", 22)}
    ${rc(504, 568, 720, 80)}${tx(528, 598, "FALLBACK", 12, "#666", 'font-weight="600"')}${tx(528, 626, d.fallback, 12, "#000")}
    ${rc(504, 672, 720, 48)}${tx(528, 702, "Internal reasoning and tool traces are never published.", 12, "#666")}${button(1080, 672, 144, "Save changes", true)}
    ${annotations([{x:496,y:160,w:360,h:184},{x:496,y:344,w:360,h:200},{x:864,y:160,w:368,h:248},{x:864,y:408,w:368,h:152},{x:496,y:560,w:736,h:96}])}`);
}

function interactionsDesktop(screen) {
  const rows = interactionData[screen.provider];
  const rendered = rows.map((row, index) => {
    const y = 218 + index * 98;
    return `${rc(504, y, 720, 82, index === 2 ? 'fill="#e6e6e6"' : 'fill="#fff"')}${rc(520, y + 17, 104, 48, 'fill="#fff"')}${tx(572, y + 47, row[0], 12, "#000", 'text-anchor="middle" font-weight="700"')}${tx(650, y + 32, row[1], 14, "#000", 'font-weight="600"')}${tx(650, y + 59, row[2], 12, "#666")}${index < rows.length - 1 ? `<path d="M 860 ${y + 82} L 860 ${y + 98}"/><polygon points="860,${y + 98} 854,${y + 89} 866,${y + 89}" fill="#000" stroke="none"/>` : ""}`;
  }).join("\n");
  return baseSvg(1280, 800, `${globalSidebar()}${topbar(`CONNECTORS  ›  Maya on ${screen.provider}  ›  Interaction model`)}${detailContext(screen.provider, "Conversations")}${heading(screen)}${tx(504, 188, "NATIVE EVENT", 12, "#666", 'font-weight="600"')}${tx(650, 188, "PROVIDER + PAPERCLIP RESULT", 12, "#666", 'font-weight="600"')}${rendered}${tx(504, 732, "All paths use durable delivery, current authorization, one task binding, and safe outbound projection.", 12, "#666")}${annotations(rows.map((_, index) => ({x:496,y:210+index*98,w:736,h:98})) )}`);
}

function mobileHeader(label) {
  return `${rc(0, 0, 375, 56)}${tx(16, 35, `‹  ${label}`, 14, "#000", 'font-weight="600"')}${tx(359, 35, "Menu", 12, "#666", 'text-anchor="end"')}`;
}

function mobileTitle(screen, phase) {
  const shortTitles = {
    "Connect Maya to GitHub conversations": "Connect Maya to GitHub",
    "Install Maya in Microsoft Teams": "Install Maya in Teams",
    "Microsoft Teams settings": "Teams settings",
    "Microsoft Teams interaction model": "Teams interaction model"
  };
  const title = shortTitles[screen.title] ?? screen.title;
  return `${tx(16, 84, `${screen.provider} · ${phase}`, 12, "#666", 'font-weight="600"')}${tx(16, 116, title, 20, "#000", 'font-weight="700"')}${tx(16, 142, screen.subtitle.length > 55 ? screen.subtitle.slice(0, 54) + "…" : screen.subtitle, 12, "#666")}`;
}

function setupMobile(screen) {
  const d = setupData[screen.provider];
  return baseSvg(375, 812, `${mobileHeader("Connectors")}${mobileTitle(screen, "Setup")}
    ${rc(16, 166, 343, 72, 'fill="#e6e6e6"')}${tx(36, 196, d.bot, 14, "#000", 'font-weight="700"')}${tx(36, 220, d.identity, 12, "#666")}
    ${rc(16, 254, 343, 92)}${tx(36, 282, "IN PAPERCLIP", 12, "#666", 'font-weight="600"')}${tx(36, 310, d.delivery, 14, "#000", 'font-weight="700"')}${tx(36, 332, d.deliveryNote.slice(0, 48), 12, "#666")}
    ${rc(16, 362, 343, 188)}${tx(36, 390, "AT THE PROVIDER", 12, "#666", 'font-weight="600"')}${d.steps.map((step,index)=>`${circle(44,420+index*30,9,'fill="#e6e6e6"')}${tx(44,424+index*30,index+1,12,"#000",'text-anchor="middle"')}${tx(64,424+index*30,step.length>40?step.slice(0,39)+"…":step,12,"#000")}`).join("\n")}
    ${rc(16, 566, 343, 72)}${tx(36, 594, "MASKED CREDENTIALS", 12, "#666", 'font-weight="600"')}${tx(36, 620, d.secrets.join("  ·  ").slice(0, 48), 12, "#000")}
    ${rc(16, 654, 343, 66, 'fill="#e6e6e6"')}${tx(36, 682, "Verification", 12, "#666", 'font-weight="600"')}${tx(36, 706, d.verify.map(row=>`${row[0]} ${row[1]}`).join(" · ").slice(0, 52), 12, "#000")}
    ${button(16, 744, 343, d.action, true)}
    ${annotations([{x:8,y:158,w:359,h:88},{x:8,y:246,w:359,h:108},{x:8,y:354,w:359,h:204},{x:8,y:558,w:359,h:88},{x:8,y:646,w:359,h:82}],true)}`);
}

function settingsMobile(screen) {
  const d = settingsData[screen.provider];
  return baseSvg(375, 812, `${mobileHeader(`Maya on ${screen.provider === "Microsoft Teams" ? "Teams" : screen.provider}`)}${mobileTitle(screen, "Settings")}
    ${rc(16, 166, 343, 104, 'fill="#e6e6e6"')}${tx(36, 194, "REACH", 12, "#666", 'font-weight="600"')}${textLines(36, 220, d.reach.slice(0,3), 12, "#000", 20)}
    ${rc(16, 286, 343, 116)}${tx(36, 314, "TASK BOUNDARY", 12, "#666", 'font-weight="600"')}${textLines(36, 340, d.boundary, 12, "#000", 20)}
    ${rc(16, 418, 343, 126)}${tx(36, 446, "BEHAVIOR + CAPABILITIES", 12, "#666", 'font-weight="600"')}${textLines(36, 472, d.capabilities.slice(0,4), 12, "#000", 19)}
    ${rc(16, 560, 343, 104)}${tx(36, 588, "SECURITY + DELIVERY", 12, "#666", 'font-weight="600"')}${textLines(36, 614, d.security.slice(0,3), 12, "#000", 19)}
    ${rc(16, 680, 343, 56)}${tx(36, 704, "FALLBACK", 12, "#666", 'font-weight="600"')}${tx(36, 724, d.fallback.length>49?d.fallback.slice(0,48)+"…":d.fallback, 12, "#000")}
    ${button(16, 752, 343, "Save changes", true)}
    ${annotations([{x:8,y:158,w:359,h:120},{x:8,y:278,w:359,h:132},{x:8,y:410,w:359,h:142},{x:8,y:552,w:359,h:120},{x:8,y:672,w:359,h:72}],true)}`);
}

function interactionsMobile(screen) {
  const rows = interactionData[screen.provider];
  const body = rows.map((row,index)=>{const y=166+index*112;return `${rc(16,y,343,96,index===2?'fill="#e6e6e6"':'fill="#fff"')}${rc(32,y+16,64,48,'fill="#fff"')}${tx(64,y+46,row[0],12,"#000",'text-anchor="middle" font-weight="700"')}${tx(112,y+30,row[1].length>37?row[1].slice(0,36)+"…":row[1],12,"#000",'font-weight="600"')}${tx(112,y+54,row[2].length>37?row[2].slice(0,36)+"…":row[2],12,"#666")}${index<4?`<path d="M 188 ${y+96} L 188 ${y+112}"/><polygon points="188,${y+112} 182,${y+103} 194,${y+103}" fill="#000" stroke="none"/>`:""}`;}).join("\n");
  return baseSvg(375,812,`${mobileHeader(`Maya on ${screen.provider === "Microsoft Teams" ? "Teams" : screen.provider}`)}${mobileTitle(screen,"Interactions")}${body}${tx(16,754,"Durable · authorized · one task · safe output",12,"#666")}${annotations(rows.map((_,index)=>({x:8,y:158+index*112,w:359,h:112})),true)}`);
}

for (const screen of providerScreens) {
  const desktop = screen.kind === "providerSetup" ? setupDesktop(screen)
    : screen.kind === "providerSettings" ? settingsDesktop(screen)
      : interactionsDesktop(screen);
  const mobile = screen.kind === "providerSetup" ? setupMobile(screen)
    : screen.kind === "providerSettings" ? settingsMobile(screen)
      : interactionsMobile(screen);
  writeFileSync(join(out, `${screen.id}-${screen.slug}.svg`), `${desktop}\n`);
  writeFileSync(join(out, `${screen.id}-${screen.slug}-mobile.svg`), `${mobile}\n`);
}

console.log(`Generated ${providerScreens.length * 2} provider SVGs`);
