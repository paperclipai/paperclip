import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseSha, providers } from "./platform-wireframe-data-v4.mjs";
import { setupWizards } from "./setup-wireframe-data-v5.mjs";
import { providerScreens as v3ProviderScreens } from "./platform-wireframe-data-v3.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const previous = join(root, "wireframes-v4");
const out = join(root, "wireframes-v5");
mkdirSync(out, { recursive: true });

const esc = (value) => String(value)
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const tx = (x, y, value, size = 14, fill = "#000", extra = "") =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" stroke="none" ${extra}>${esc(value)}</text>`;
const ln = (x1, y1, x2, y2, extra = "") => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${extra}/>`;
const rc = (x, y, w, h, extra = "") => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" ${extra}/>`;
const circle = (x, y, r, extra = "") => `<circle cx="${x}" cy="${y}" r="${r}" ${extra}/>`;

function baseSvg(width, height, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, system-ui, sans-serif" fill="#fff" stroke="#000" stroke-width="1.5"><rect x="0" y="0" width="${width}" height="${height}"/>${body}</svg>`;
}

function wrap(value, width = 64, max = 3) {
  const lines = [];
  let current = "";
  for (const word of String(value).split(" ")) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width && current) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  if (lines.length <= max) return lines;
  const clipped = lines.slice(0, max);
  clipped[max - 1] = `${clipped[max - 1].replace(/[.,;:]$/, "")}…`;
  return clipped;
}

function multiline(x, y, lines, size = 12, fill = "#666", gap = 16, extra = "") {
  return lines.map((line, index) => tx(x, y + index * gap, line, size, fill, extra)).join("\n");
}

function button(x, y, w, label, primary = false) {
  return `${rc(x, y, w, 48, primary ? 'fill="#000"' : 'fill="#fff"')}${tx(x + w / 2, y + 30, label, 14, primary ? "#fff" : "#000", 'text-anchor="middle" font-weight="600"')}`;
}

function statusBox(x, y, w, label) {
  return `${rc(x, y, w, 48, 'fill="#fff"')}${tx(x + w / 2, y + 30, label, 12, "#000", 'text-anchor="middle" font-weight="600"')}`;
}

function annotations(regions, mobile = false) {
  return `<g data-region="annotations">${regions.map((region, index) => `${rc(region.x, region.y, region.w, region.h, 'fill="none" stroke="#d33" stroke-dasharray="6 4"')}${circle(region.x, region.y, mobile ? 8 : 12, 'fill="#fff" stroke="#d33" stroke-dasharray="4 2"')}${tx(region.x, region.y + 4, index + 1, 12, "#d33", 'text-anchor="middle" font-weight="700"')}`).join("\n")}</g>`;
}

function globalSidebar(height) {
  const items = ["New Task", "Search", "Dashboard", "Inbox", "Tasks", "Projects", "Routines", "Artifacts", "Agents", "Skills", "Connectors", "Audit"];
  return `<g data-region="global-sidebar">${tx(24, 40, "Paperclip", 20, "#000", 'font-weight="700"')}${items.map((item, index) => {
    const y = 80 + index * 48;
    return `${item === "Connectors" ? rc(8, y - 24, 224, 40, 'fill="#e6e6e6"') : ""}${circle(32, y - 8, 6, 'fill="#e6e6e6"')}${tx(56, y - 4, item, 14, item === "Connectors" ? "#000" : "#666", item === "Connectors" ? 'font-weight="600"' : "")}`;
  }).join("\n")}${tx(24, height - 56, "Acme Company", 14, "#000", 'font-weight="600"')}${tx(24, height - 32, "Dana · Admin", 12, "#666")}${ln(240, 0, 240, height)}</g>`;
}

function topbar(crumb) {
  return `<g data-region="topbar">${ln(240, 64, 1280, 64)}${tx(264, 40, crumb, 14, "#666")}${circle(1240, 32, 16, 'fill="#e6e6e6"')}</g>`;
}

function stepRail(screen, height) {
  const startY = 152;
  const stepGap = 80;
  const rail = [
    tx(264, 104, screen.mode === "advanced" ? "ADVANCED SETUP" : "SETUP", 12, "#666", 'font-weight="700"'),
    tx(264, 128, screen.provider, 14, "#000", 'font-weight="700"'),
    ln(520, 64, 520, height)
  ];
  if (screen.rail.length > 1) rail.push(ln(288, startY, 288, startY + (screen.rail.length - 1) * stepGap));
  screen.rail.forEach((label, index) => {
    const y = startY + index * stepGap;
    const complete = index < screen.active;
    const active = index === screen.active;
    rail.push(circle(288, y, 16, complete ? 'fill="#000"' : 'fill="#fff"'));
    rail.push(tx(288, y + 5, complete ? "✓" : index + 1, 14, complete ? "#fff" : "#000", 'text-anchor="middle" font-weight="700"'));
    rail.push(multiline(320, y - 4, wrap(label, 22, 2), 14, active ? "#000" : complete ? "#000" : "#666", 18, active ? 'font-weight="700"' : ""));
  });
  rail.push(tx(264, height - 48, "Progress is saved automatically.", 12, "#666"));
  return rail.join("\n");
}

function fieldDesktop(x, y, label, placeholder, help) {
  return `${tx(x, y + 16, label, 14, "#000", 'font-weight="600"')}${rc(x, y + 32, 640, 48, 'fill="#fff"')}${tx(x + 16, y + 62, placeholder, 14, "#666")}${multiline(x, y + 104, wrap(help, 88, 2), 12, "#666", 16)}`;
}

function fieldMobile(y, label, placeholder, help) {
  return `${tx(24, y + 16, label, 14, "#000", 'font-weight="600"')}${rc(24, y + 32, 327, 48, 'fill="#fff"')}${tx(40, y + 62, placeholder.length > 40 ? `${placeholder.slice(0, 39)}…` : placeholder, 14, "#666")}${multiline(24, y + 104, wrap(help, 44, 3), 12, "#666", 16)}`;
}

function groupDesktop(group, top) {
  const height = 80 + group.rows.length * 72;
  const out = [tx(560, top + 24, group.title, 20, "#000", 'font-weight="700"'), multiline(560, top + 48, wrap(group.intro, 92, 2), 12, "#666", 16), ln(560, top + 72, 1224, top + 72)];
  group.rows.forEach((row, index) => {
    const y = top + 72 + index * 72;
    if (index) out.push(ln(576, y, 1208, y, 'stroke="#e6e6e6"'));
    out.push(tx(576, y + 24, row[0], 14, "#000", 'font-weight="600"'));
    out.push(multiline(576, y + 46, wrap(row[1], 66, 2), 12, "#666", 16));
    out.push(tx(1208, y + 28, row[2], 12, "#000", 'text-anchor="end" font-weight="600"'));
  });
  return { body: out.join("\n"), height };
}

function groupMobile(group, top) {
  const height = 88 + group.rows.length * 112;
  const out = [tx(16, top + 24, group.title, 20, "#000", 'font-weight="700"'), multiline(16, top + 48, wrap(group.intro, 46, 3), 12, "#666", 16), ln(16, top + 80, 359, top + 80)];
  group.rows.forEach((row, index) => {
    const y = top + 80 + index * 112;
    if (index) out.push(ln(24, y, 351, y, 'stroke="#e6e6e6"'));
    out.push(tx(24, y + 24, row[0], 14, "#000", 'font-weight="600"'));
    out.push(multiline(24, y + 46, wrap(row[1], 43, 2), 12, "#666", 16));
    out.push(tx(351, y + 96, row[2], 12, "#000", 'text-anchor="end" font-weight="600"'));
  });
  return { body: out.join("\n"), height };
}

function wizardDesktop(screen) {
  const fieldsHeight = (screen.fields?.length || 0) * 136;
  const groupsHeight = screen.groups.reduce((sum, group) => sum + 80 + group.rows.length * 72, 0);
  const contentStart = 176;
  const height = Math.max(920, contentStart + fieldsHeight + groupsHeight + 144);
  const body = [];
  const regions = [{ x: 256, y: 88, w: 248, h: Math.min(height - 128, 520) }];
  body.push(tx(560, 112, screen.title, 28, "#000", 'font-weight="700"'));
  body.push(multiline(560, 144, wrap(screen.subtitle, 88, 2), 14, "#666", 20));
  let top = contentStart;
  if (screen.fields?.length) {
    const start = top;
    screen.fields.forEach((field) => {
      body.push(fieldDesktop(560, top, ...field));
      top += 136;
    });
    regions.push({ x: 552, y: start - 8, w: 680, h: top - start });
  }
  const groupRegions = [];
  for (const group of screen.groups) {
    const rendered = groupDesktop(group, top);
    body.push(rendered.body);
    groupRegions.push({ x: 552, y: top - 8, w: 680, h: rendered.height });
    top += rendered.height;
  }
  if (!screen.fields?.length) regions.push(groupRegions.shift());
  if (groupRegions.length) {
    const first = groupRegions[0];
    const last = groupRegions[groupRegions.length - 1];
    regions.push({ x: first.x, y: first.y, w: first.w, h: last.y + last.h - first.y });
  } else if (regions.length < 3) {
    regions.push({ x: 552, y: top - 88, w: 680, h: 80 });
  }
  const actionY = height - 88;
  regions.push({ x: 552, y: actionY - 16, w: 680, h: 72 });
  return { width:1280, height, svg:baseSvg(1280, height, `${globalSidebar(height)}${topbar(`CONNECTORS  ›  ${screen.provider}  ›  Chat with an agent`)}${stepRail(screen, height)}${body.join("\n")}${button(560, actionY, 208, screen.secondary)}${button(784, actionY, 440, screen.primary, true)}${annotations(regions)}`) };
}

function mobileProgress(screen) {
  const startY = 80;
  const gap = 56;
  const body = [tx(16, 72, screen.mode === "advanced" ? "ADVANCED SETUP" : "SETUP", 12, "#666", 'font-weight="700"')];
  if (screen.rail.length > 1) body.push(ln(32, startY + 16, 32, startY + 16 + (screen.rail.length - 1) * gap));
  screen.rail.forEach((label, index) => {
    const y = startY + index * gap;
    const complete = index < screen.active;
    const active = index === screen.active;
    body.push(circle(32, y + 16, 16, complete ? 'fill="#000"' : 'fill="#fff"'));
    body.push(tx(32, y + 21, complete ? "✓" : index + 1, 14, complete ? "#fff" : "#000", 'text-anchor="middle" font-weight="700"'));
    body.push(tx(64, y + 21, label, 14, active ? "#000" : complete ? "#000" : "#666", active ? 'font-weight="700"' : ""));
  });
  return { body: body.join("\n"), height: 48 + screen.rail.length * gap };
}

function wizardMobile(screen) {
  const progress = mobileProgress(screen);
  const titleLines = wrap(screen.title, 34, 2);
  const subtitleLines = wrap(screen.subtitle, 46, 3);
  const headerStart = 64 + progress.height;
  const fieldsHeight = (screen.fields?.length || 0) * 152;
  const groupsHeight = screen.groups.reduce((sum, group) => sum + 88 + group.rows.length * 112, 0);
  const contentStart = headerStart + titleLines.length * 24 + subtitleLines.length * 16 + 40;
  const height = contentStart + fieldsHeight + groupsHeight + 168;
  const body = [mobileHeader(screen.short), progress.body, multiline(16, headerStart + 24, titleLines, 20, "#000", 24, 'font-weight="700"'), multiline(16, headerStart + 32 + titleLines.length * 24, subtitleLines, 12, "#666", 16)];
  const regions = [{ x: 8, y: 64, w: 359, h: progress.height }];
  let top = contentStart;
  if (screen.fields?.length) {
    const start = top;
    screen.fields.forEach((field) => {
      body.push(fieldMobile(top, ...field));
      top += 152;
    });
    regions.push({ x: 8, y: start - 8, w: 359, h: top - start });
  }
  const groupRegions = [];
  for (const group of screen.groups) {
    const rendered = groupMobile(group, top);
    body.push(rendered.body);
    groupRegions.push({ x: 8, y: top - 8, w: 359, h: rendered.height });
    top += rendered.height;
  }
  if (!screen.fields?.length) regions.push(groupRegions.shift());
  if (groupRegions.length) {
    const first = groupRegions[0];
    const last = groupRegions[groupRegions.length - 1];
    regions.push({ x: 8, y: first.y, w: 359, h: last.y + last.h - first.y });
  } else if (regions.length < 3) regions.push({ x: 8, y: top - 88, w: 359, h: 80 });
  const secondaryY = height - 136;
  const primaryY = height - 72;
  regions.push({ x: 8, y: secondaryY - 8, w: 359, h: 120 });
  body.push(button(16, secondaryY, 343, screen.secondary));
  body.push(button(16, primaryY, 343, screen.primary, true));
  body.push(annotations(regions, true));
  return { width:375, height, svg:baseSvg(375, height, body.join("\n")) };
}

function mobileHeader(label) {
  return `${rc(0, 0, 375, 56)}${tx(16, 36, `‹  ${label}`, 14, "#000", 'font-weight="600"')}${tx(359, 36, "Save & exit", 12, "#666", 'text-anchor="end"')}`;
}

const v2Spec = readFileSync(join(root, "2026-09-04-chat-adapters-ui-surfaces-v2.md"), "utf8");
const oldAnnotations = new Map(
  [...v2Spec.matchAll(/### (\d{2})[^\n]*\n\nPurpose:[^\n]*\n\n((?:\d+\.[^\n]*\n){4,5})/g)].map((match) => [
    match[1], match[2].trim().split("\n").map((line) => line.replace(/^\d+\.\s*/, ""))
  ])
);

const sharedScreens = [
  { id:"01", slug:"connectors-catalog", title:"Connectors", subtitle:"Connect tools and places where people talk to agents.", group:"Start", rationale:"The existing Apps catalog remains the single entry point.", annotations:oldAnnotations.get("01") },
  { id:"02", slug:"connection-purpose", title:"Choose how to connect", subtitle:"This choice appears for every provider that supports both chat and tool connection surfaces.", group:"Start", rationale:"The same directional choice applies to GitHub and any future dual-purpose connector.", annotations:[
    "The existing connection wizard shell and selected provider are reused.",
    "Chat with an agent is the incoming-conversation path.",
    "Use this connection as an agent tool is the outbound tool/credential path.",
    "Chat-only or tool-only providers skip this choice entirely."
  ]},
  { id:"03", slug:"choose-agent", title:"Which agent do you want to chat with?", subtitle:"Choose the one Paperclip agent represented by this connection.", group:"Start", rationale:"Agent choice happens once; every provider setup screen then shows it as immutable.", annotations:oldAnnotations.get("03") },
  { id:"11", slug:"bound-task", title:"Externally bound task", subtitle:"A normal Paperclip task with explicit publication and detach controls.", group:"Paperclip", rationale:"External work remains governed by the ordinary task experience.", annotations:oldAnnotations.get("11") },
  { id:"12", slug:"agent-channels", title:"Agent Channels", subtitle:"See every provider identity representing this agent.", group:"Paperclip", rationale:"Agent detail summarizes endpoints; Connectors continues to manage them.", annotations:oldAnnotations.get("12") }
];

for (const screen of sharedScreens) {
  let desktop = readFileSync(join(previous, `${screen.id}-${screen.slug}.svg`), "utf8");
  let mobile = readFileSync(join(previous, `${screen.id}-${screen.slug}-mobile.svg`), "utf8");
  if (screen.id === "02") {
    for (const [from, to] of [["Connect GitHub", "Choose how to connect"], ["Use this channel as an agent tool", "Use this connection as an agent tool"], ["Choose chat or tool use only when a provider supports both.", "Shown whenever this provider supports both chat and tool connections."], ["Slack and chat-only connectors skip this choice.", "Single-purpose connectors skip this choice."]]) {
      desktop = desktop.replaceAll(from, to);
      mobile = mobile.replaceAll(from, to);
    }
  }
  writeFileSync(join(out, `${screen.id}-${screen.slug}.svg`), desktop);
  writeFileSync(join(out, `${screen.id}-${screen.slug}-mobile.svg`), mobile);
  screen.desktopSize = "1280×800";
  screen.mobileSize = "375×812";
  screen.tab = "Shared";
}

const setupScreens = [];
for (const wizard of setupWizards) {
  for (const definition of wizard.screens) {
    const screen = { ...definition, provider:wizard.provider, short:wizard.short, group:wizard.provider, tab:definition.mode === "advanced" ? "Advanced setup" : "Setup", kind:"setup" };
    const desktop = wizardDesktop(screen);
    const mobile = wizardMobile(screen);
    writeFileSync(join(out, `${screen.id}-${screen.slug}.svg`), `${desktop.svg}\n`);
    writeFileSync(join(out, `${screen.id}-${screen.slug}-mobile.svg`), `${mobile.svg}\n`);
    screen.desktopSize = `${desktop.width}×${desktop.height}`;
    screen.mobileSize = `${mobile.width}×${mobile.height}`;
    setupScreens.push(screen);
  }
}

const detailScreens = [];
for (const provider of providers) {
  const definitions = [
    { key:"overview", slug:`${provider.slug}-overview`, title:`${provider.name} overview`, subtitle:"Identity, installation health, automatic capabilities, and connector lifecycle.", tab:"Overview", annotations:provider.overviewAnnotations, rationale:"Overview reports everything this connection can do automatically without turning capabilities into settings." },
    { key:"settings", slug:`${provider.slug}-settings`, title:`${provider.name} settings`, subtitle:"Only scope, task-boundary, delivery, and provider-permission choices.", tab:"Settings", annotations:provider.settingsAnnotations, rationale:"Settings contains genuine operator decisions; the maximum safe provider feature set is automatic." },
    { key:"access", slug:`${provider.slug}-access`, title:`${provider.name} access`, subtitle:"External identities, linked Paperclip users, sponsored guests, and effective authority.", tab:"Access", annotations:provider.accessAnnotations, rationale:"The shared permission model is made concrete with provider-specific stable identity keys and edge cases." },
    { key:"conversations", slug:`${provider.slug}-conversations`, title:`${provider.name} conversations`, subtitle:"Inspect native conversation-to-Paperclip issue bindings.", tab:"Conversations", annotations:provider.conversationAnnotations, rationale:"Operators can see and manage the exact native boundary used for each durable task binding." },
    { key:"activity", slug:`${provider.slug}-activity`, title:`${provider.name} activity`, subtitle:"Inspect provider health, deliveries, callbacks, publications, and retries.", tab:"Activity", annotations:provider.activityAnnotations, rationale:"The durable ledger is shared in concept but includes the diagnostics and lifecycle states of this provider." }
  ];
  for (const definition of definitions) {
    const id = provider.ids[definition.key];
    const screen = { id, ...definition, provider:provider.name, group:provider.name, kind:"detail" };
    const desktopFile = `${id}-${definition.slug}.svg`;
    const mobileFile = `${id}-${definition.slug}-mobile.svg`;
    const desktop = readFileSync(join(previous, desktopFile), "utf8");
    const mobile = readFileSync(join(previous, mobileFile), "utf8");
    writeFileSync(join(out, desktopFile), desktop);
    writeFileSync(join(out, mobileFile), mobile);
    const d = desktop.match(/<svg[^>]*width="(\d+)"[^>]*height="(\d+)"/);
    const m = mobile.match(/<svg[^>]*width="(\d+)"[^>]*height="(\d+)"/);
    screen.desktopSize = `${d[1]}×${d[2]}`;
    screen.mobileSize = `${m[1]}×${m[2]}`;
    detailScreens.push(screen);
  }
  const walkthrough = v3ProviderScreens.find((item) => item.id === provider.ids.walkthrough);
  const screen = { ...walkthrough, slug:`${provider.slug}-interactions`, provider:provider.name, group:provider.name, tab:"Conversation walkthrough", kind:"walkthrough", desktopSize:"1280×960", mobileSize:"375×1320" };
  writeFileSync(join(out, `${screen.id}-${screen.slug}.svg`), readFileSync(join(previous, `${screen.id}-${screen.slug}.svg`), "utf8"));
  writeFileSync(join(out, `${screen.id}-${screen.slug}-mobile.svg`), readFileSync(join(previous, `${screen.id}-${screen.slug}-mobile.svg`), "utf8"));
  detailScreens.push(screen);
}

function flowSvg() {
  const height = 1040;
  const node = (x, y, w, title, sub, fill = false) => `${rc(x, y, w, 88, fill ? 'fill="#e6e6e6"' : 'fill="#fff"')}${tx(x + 16, y + 32, title, 14, "#000", 'font-weight="700"')}${tx(x + 16, y + 60, sub, 12, "#666")}`;
  const arrow = (x1, y1, x2, y2) => `${ln(x1, y1, x2, y2)}<polygon points="${x2},${y2} ${x2 - 8},${y2 - 6} ${x2 - 8},${y2 + 6}" fill="#000" stroke="none"/>`;
  return baseSvg(1280, height, `${tx(48, 48, "Chat connector setup · minimal defaults with explicit provider handoffs", 28, "#000", 'font-weight="700"')}${tx(48, 80, "Agent choice is immutable. Normal setup hides delivery mechanics and provider secrets whenever an authenticated handoff can return them.", 14, "#666")}
    ${node(48,128,176,"Connectors","Choose provider",true)}${arrow(224,172,264,172)}${node(264,128,192,"Purpose?","Only for dual-purpose")}${arrow(456,172,496,172)}${node(496,128,184,"Choose agent","Exactly once")}${arrow(680,172,720,172)}${node(720,128,216,"Provider wizard","One phase at a time")}${arrow(936,172,976,172)}${node(976,128,208,"Try agent","Real provider event",true)}
    ${tx(48,304,"DEFAULT PROVIDER HANDOFFS",12,"#666",'font-weight="700"')}${node(48,336,232,"Slack","Add to Slack → try")}${node(296,336,232,"GitHub","Manifest → repos → try")}${node(544,336,232,"Microsoft Teams","Register → identity → app → try")}${node(792,336,232,"Telegram","BotFather token → chats → try")}
    ${tx(48,512,"AUTOMATIC IN EVERY DEFAULT PATH",12,"#666",'font-weight="700"')}${node(48,544,216,"Delivery","Webhook / relay selected")}${node(280,544,216,"Capabilities","Maximum safe set")}${node(512,544,216,"Secrets","Stored, never revealed")}${node(744,544,216,"Verification","Provider checks + event")}
    ${tx(48,720,"ADVANCED BRANCHES",12,"#666",'font-weight="700"')}${node(48,752,272,"Custom Slack app","Manifest → 2 secrets → verify")}${node(344,752,272,"Existing GitHub App","App ID + key + hook secret")}${node(640,752,272,"Microsoft portal","Same required identity values")}${node(936,752,248,"Instance transport","Admin operations only")}
    ${tx(48,920,"After activation",20,"#000",'font-weight="700"')}${tx(48,952,"Every endpoint enters provider-specific Overview, Settings, Access, Conversations, and Activity tabs. Setup progress and external approvals remain resumable.",14,"#666")}
    ${annotations([{x:40,y:120,w:1152,h:104},{x:40,y:328,w:992,h:104},{x:40,y:536,w:936,h:104},{x:40,y:744,w:1152,h:104}])}`);
}

writeFileSync(join(out, "flow.svg"), `${flowSvg()}\n`);

const groups = [
  ["Start", sharedScreens.filter((screen) => screen.group === "Start")],
  ...providers.map((provider) => [provider.name, [
    ...setupScreens.filter((screen) => screen.provider === provider.name),
    ...detailScreens.filter((screen) => screen.provider === provider.name)
  ]]),
  ["Paperclip", sharedScreens.filter((screen) => screen.group === "Paperclip")]
];
const orderedScreens = groups.flatMap(([, screens]) => screens);

function uiDoc() {
  const inventory = orderedScreens.map((screen) => `| ${screen.id} | ${screen.group} | ${screen.tab} | ${screen.title} | ${screen.desktopSize} | ${screen.mobileSize} |`).join("\n");
  const details = orderedScreens.map((screen) => `### ${screen.id} · ${screen.title}\n\nPurpose: ${screen.subtitle}\n\n${screen.annotations.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\n${screen.actions ? `Actions:\n\n${screen.actions.map(([label, behind]) => `- **${label}:** ${behind}`).join("\n")}\n\n` : ""}Rationale: ${screen.rationale}`).join("\n\n");
  return `# Paperclip Chat Adapters UI Surfaces — v5\n\nDate: 2026-09-04  \nPaperclip base: \`${baseSha}\`  \nReview viewer: [\`index.html\`](./index.html)  \nWireframes: [\`wireframes-v5/\`](./wireframes-v5/)  \nSetup audit: [\`2026-09-04-chat-adapters-setup-audit-v5.md\`](./2026-09-04-chat-adapters-setup-audit-v5.md)\n\n## What changed\n\n- The purpose choice now says **Use this connection as an agent tool** and applies to every provider that exposes both chat and tool connection surfaces.\n- Agent selection is one-way. Setup shows the chosen agent as **Locked**; connecting another agent means creating another connection.\n- Every provider setup is a persistent step-rail wizard. Each SVG represents one real phase, including the advanced custom/existing-app branches.\n- Normal setup never asks for direct webhook, relay, Socket Mode, or polling. Paperclip chooses delivery from the instance deployment and reports it after the fact.\n- Authenticated provider handoffs keep credentials invisible. Only customer-owned flows expose irreducible secrets: two for a custom Slack app, an App ID/private key/webhook secret for an existing GitHub App, Microsoft bot identity values for Teams, and the BotFather token for Telegram.\n- Every button is documented below with the state change or external handoff behind it.\n- Provider detail tabs and maximal-safe capability behavior from v4 remain unchanged.\n- Red dashed marks and numbers are review annotations, not proposed UI.\n\n## Inventory\n\n| ID | Group | Surface | Title | Desktop | Mobile |\n|---|---|---|---|---|---|\n${inventory}\n\n## Annotation and action notes\n\n${details}\n`;
}

function viewerHtml() {
  const template = readFileSync(join(root, "../../../packages/skills-catalog/catalog/bundled/product/wireframe/assets/site-template.html"), "utf8");
  const style = template.match(/<style>[\s\S]*?<\/style>/)?.[0];
  if (!style) throw new Error("Could not load wireframe viewer styles");
  const toc = groups.map(([label, screens]) => `<h2>${esc(label)}</h2>${screens.map((screen) => `<a href="#s${screen.id}"><span class="num">${Number(screen.id)}</span>${esc(screen.title)}</a>`).join("\n")}`).join("\n");
  const sections = groups.map(([label, screens]) => `<div class="provider-break"><div class="lede">${esc(label)}</div><h2>${label === "Start" ? "Shared connection start" : label === "Paperclip" ? "Shared Paperclip surfaces" : `${esc(label)} connector`}</h2></div>${screens.map((screen) => {
    const notes = screen.annotations.map((note, index) => `<li><b>${index + 1}</b> — ${esc(note).replaceAll("**", "")}</li>`).join("\n");
    const actionNotes = screen.actions ? `<h3>What the actions do</h3><ul>${screen.actions.map(([label, behind]) => `<li><b>${esc(label)}</b> — ${esc(behind)}</li>`).join("\n")}</ul>` : "";
    return `<section id="s${screen.id}"><div class="lede">${esc(screen.group)} · ${esc(screen.tab)}</div><h2><span class="step-num">${Number(screen.id)}.</span>${esc(screen.title)}</h2><p class="desc">${esc(screen.subtitle)}</p><div class="grid"><div class="wire" data-zoom data-caption="${screen.id} · ${esc(screen.title)} (desktop)"><div class="label"><span>${screen.id}-${screen.slug}.svg</span><span>${screen.desktopSize} · desktop</span></div><img src="wireframes-v5/${screen.id}-${screen.slug}.svg" alt="${esc(screen.title)} desktop wireframe" /></div><div class="wire mobile-wire mobile-col" data-zoom data-caption="${screen.id} · ${esc(screen.title)} (mobile)"><div class="label"><span>mobile</span><span>${screen.mobileSize}</span></div><img src="wireframes-v5/${screen.id}-${screen.slug}-mobile.svg" alt="${esc(screen.title)} mobile wireframe" /></div><div class="notes-col"><div class="notes"><h3>Annotations</h3><ul>${notes}</ul>${actionNotes}<div class="why"><b>Rationale:</b> ${esc(screen.rationale)}</div></div></div></div></section>`;
  }).join("\n")}`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Paperclip chat adapters — setup wizard review</title>${style}<style>.doc-links{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:16px}.doc-links a{min-height:48px;display:inline-flex;align-items:center;font-size:13px;font-weight:600}.notice{max-width:var(--maxw);margin:-32px 0 48px;padding:14px 18px;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:4px}.notice p{margin:0}.decision{margin-top:24px;padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:8px}.decision b{display:block;margin-bottom:6px}.provider-break{max-width:var(--maxw);margin:80px 0 8px;padding-top:24px;border-top:2px solid var(--ink)}.provider-break h2{font-size:28px;margin:6px 0 0}.toc-body h2{margin-top:18px}code{font-size:.92em}</style></head><body><div class="shell"><details class="toc"><summary class="toc-summary"><span><span class="crumb">Chat adapters · v5</span><br><span class="title">Jump to a screen</span></span><span class="chevron" aria-hidden="true"></span></summary><nav class="toc-body" aria-label="Section navigation"><h1>Chat adapters</h1><div style="font-size:13px;color:var(--muted);margin-bottom:16px">Setup wizard review</div><h2>Documents</h2><a href="2026-09-03-chat-adapters-architecture.md"><span class="num">A</span>Architecture</a><a href="2026-09-04-chat-adapters-setup-audit-v5.md"><span class="num">S</span>Setup audit</a><a href="2026-09-04-chat-adapters-ui-surfaces-v5.md"><span class="num">U</span>UI specification v5</a><a href="2026-09-04-chat-adapters-platform-surfaces.md"><span class="num">P</span>Platform research</a><h2>Flow</h2><a href="#flow"><span class="num">⤳</span>Product flow</a>${toc}<h2>Review</h2><a href="#coverage"><span class="num">✓</span>Decisions and coverage</a></nav></details><main><header class="hero"><div class="crumb">Paperclip · Connectors · Setup v5</div><h1>One decision per step. Everything else automatic.</h1><p>Provider setup is now a persistent step-rail wizard. It shows the immutable agent, sends provider-owned approvals to the provider, hides credentials when an authenticated handoff can return them, and documents the exact effect behind every action.</p><div class="decision"><b>Setup is not infrastructure configuration</b><span>Paperclip chooses delivery and maximal safe capabilities. Users see only actions the provider requires them to perform.</span></div><div class="doc-links"><a href="2026-09-03-chat-adapters-architecture.md">Architecture plan</a><a href="2026-09-04-chat-adapters-setup-audit-v5.md">Row-by-row setup audit</a><a href="2026-09-04-chat-adapters-ui-surfaces-v5.md">UI specification v5</a></div><div class="pills"><span class="pill">45 product surfaces</span><span class="pill">16 setup phases</span><span class="pill">Every action explained</span><span class="pill">Desktop + mobile</span></div></header><div class="notice" role="note"><p><b>Review convention:</b> red dashed marks are annotations, not proposed UI. The step-rail layout is informed by the supplied reference image; none of its text or functionality is copied.</p></div><section id="flow" class="flow-section"><div class="lede">Navigation and product flow</div><h2>Minimal default paths with honest advanced branches</h2><p class="desc">Agent selection happens once. Provider setup contains one focused phase at a time; transport mechanics are selected by the deployment.</p><div class="wire" data-zoom data-caption="Chat connector setup flow"><div class="label"><span>flow.svg</span><span>1280×1040</span></div><img src="wireframes-v5/flow.svg" alt="Chat connector setup flow"/></div></section>${sections}<section id="coverage"><div class="lede">Review</div><h2>What changed in v5</h2><div class="notes"><ul><li><b>Generic purpose copy:</b> “Use this connection as an agent tool” applies to every dual-purpose connector.</li><li><b>Immutable agent:</b> no setup screen offers Change agent; another agent means another connection.</li><li><b>Stepped setup:</b> Slack has two default phases plus a three-phase custom-app branch; GitHub has three default phases plus an existing-App branch; Teams has four phases; Telegram has three.</li><li><b>Automatic delivery:</b> webhook, relay, Socket Mode, and polling are not endpoint-wizard choices.</li><li><b>Credential minimization:</b> secrets appear only where a provider cannot return or provision them for Paperclip.</li><li><b>Complete review:</b> all prior provider endpoint tabs and conversation walkthroughs remain in the same grouped viewer.</li><li><b>Paperclip base:</b> <code>${baseSha}</code>, matching <code>origin/master</code> when generated.</li></ul></div></section><div class="footer">Generated with Paperclip’s wireframe contract. Setup canvases grow with their focused phase; no wizard is forced into an 800px dashboard.</div></main></div><div class="lightbox" id="lb" aria-hidden="true"><span class="close" id="lbClose" role="button" aria-label="Close preview">×</span><img id="lbImg" alt=""/><div class="caption" id="lbCap"></div></div><script>const lb=document.getElementById('lb'),lbImg=document.getElementById('lbImg'),lbCap=document.getElementById('lbCap');document.querySelectorAll('[data-zoom]').forEach(el=>el.addEventListener('click',()=>{const target=el.querySelector('img');if(!target)return;lbImg.src=target.src;lbImg.alt=target.alt;lbCap.textContent=el.dataset.caption||target.alt||'';lb.classList.add('open');lb.setAttribute('aria-hidden','false')}));function closeLightbox(){lb.classList.remove('open');lb.setAttribute('aria-hidden','true')}lb.addEventListener('click',closeLightbox);document.getElementById('lbClose').addEventListener('click',closeLightbox);document.addEventListener('keydown',e=>{if(e.key==='Escape')closeLightbox()});const tocElement=document.querySelector('details.toc'),media=window.matchMedia('(max-width:900px)'),setToc=()=>{tocElement.open=!media.matches};setToc();media.addEventListener('change',setToc);tocElement.querySelectorAll('.toc-body a').forEach(link=>link.addEventListener('click',()=>{if(media.matches)tocElement.open=false}));</script></body></html>`;
}

writeFileSync(
  join(root, "2026-09-04-chat-adapters-ui-surfaces-v5.md"),
  `${uiDoc().replace(
    "Provider detail tabs and maximal-safe capability behavior from v4 remain unchanged.",
    "Provider detail tabs remain complete. Capability inventories live on Overview and the native walkthroughs; feature toggles are absent from Settings."
  )}\n`
);
writeFileSync(join(root, "index.html"), `${viewerHtml()}\n`);
console.log(`Generated ${orderedScreens.length * 2 + 1} v5 SVGs, UI specification, and index.html`);
