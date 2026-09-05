import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseSha, providers } from "./platform-wireframe-data-v4.mjs";
import { providerScreens as walkthroughSources } from "./platform-wireframe-data-v3.mjs";
import { setupFlows } from "./setup-wireframe-data-v6.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const previous = join(root, "wireframes-v5");
const out = join(root, "wireframes-v6");
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

function topbar(provider) {
  return `<g data-region="topbar">${ln(240, 64, 1280, 64)}${tx(264, 40, `CONNECTORS  ›  ${provider}  ›  Chat with an agent`, 14, "#666")}${circle(1240, 32, 16, 'fill="#e6e6e6"')}</g>`;
}

function stepRail(screen, height) {
  const startY = 152;
  const gap = 80;
  const body = [
    tx(264, 104, screen.mode === "advanced" ? "CUSTOM SETUP" : "SETUP", 12, "#666", 'font-weight="700"'),
    tx(264, 128, screen.provider, 14, "#000", 'font-weight="700"'),
    ln(520, 64, 520, height)
  ];
  if (screen.rail.length > 1) body.push(ln(288, startY, 288, startY + (screen.rail.length - 1) * gap));
  screen.rail.forEach((label, index) => {
    const y = startY + index * gap;
    const complete = index < screen.active;
    const active = index === screen.active;
    body.push(circle(288, y, 16, complete ? 'fill="#000"' : 'fill="#fff"'));
    body.push(tx(288, y + 5, complete ? "✓" : index + 1, 14, complete ? "#fff" : "#000", 'text-anchor="middle" font-weight="700"'));
    body.push(multiline(320, y - 4, wrap(label, 22, 2), 14, active || complete ? "#000" : "#666", 18, active ? 'font-weight="700"' : ""));
  });
  return body.join("\n");
}

function instructionsDesktop(items, top) {
  if (!items?.length) return { body: "", top, region: null };
  const start = top;
  const body = [tx(560, top + 24, "Do this", 20, "#000", 'font-weight="700"')];
  top += 56;
  items.forEach(([title, detail], index) => {
    body.push(circle(584, top + 24, 16, 'fill="#fff"'));
    body.push(tx(584, top + 29, index + 1, 14, "#000", 'text-anchor="middle" font-weight="700"'));
    body.push(tx(616, top + 20, title, 14, "#000", 'font-weight="600"'));
    body.push(multiline(616, top + 44, wrap(detail, 76, 2), 12, "#666", 16));
    if (index < items.length - 1) body.push(ln(616, top + 80, 1224, top + 80, 'stroke="#e6e6e6"'));
    top += 96;
  });
  return { body: body.join("\n"), top, region: { x:552, y:start - 8, w:680, h:top - start } };
}

function copyDesktop(copyValue, top) {
  if (!copyValue) return { body:"", top, region:null };
  const [label, action] = copyValue;
  return {
    body: `${tx(560, top + 16, label, 14, "#000", 'font-weight="600"')}${button(904, top, 320, action)}`,
    top: top + 80,
    region: { x:552, y:top - 8, w:680, h:64 }
  };
}

function codeDesktop(value, top) {
  if (!value) return { body:"", top, region:null };
  return {
    body: `${tx(560, top + 16, "Setup command", 14, "#000", 'font-weight="600"')}${rc(560, top + 32, 664, 56, 'fill="#e6e6e6"')}${tx(576, top + 66, value, 14, "#000")}`,
    top: top + 112,
    region: { x:552, y:top - 8, w:680, h:104 }
  };
}

function fieldsDesktop(fields, top) {
  if (!fields?.length) return { body:"", top, region:null };
  const start = top;
  const body = [];
  for (const [label, placeholder] of fields) {
    body.push(tx(560, top + 16, label, 14, "#000", 'font-weight="600"'));
    body.push(rc(560, top + 32, 664, 48, 'fill="#fff"'));
    body.push(tx(576, top + 62, placeholder, 14, "#666"));
    top += 104;
  }
  return { body:body.join("\n"), top, region:{ x:552, y:start - 8, w:680, h:top - start - 8 } };
}

function desktopRegions(screen, bodyStart, bodyEnd, actionY, firstRegion, fieldsRegion) {
  const rail = { x:256, y:88, w:248, h:Math.min(440, actionY - 72) };
  const action = { x:552, y:actionY - 16, w:680, h:72 };
  if (screen.annotations.length === 2) return [rail, { x:552, y:88, w:680, h:actionY + 56 - 88 }];
  if (screen.annotations.length === 3) return [rail, { x:552, y:bodyStart - 16, w:680, h:bodyEnd - bodyStart + 24 }, action];
  return [rail, firstRegion || { x:552, y:bodyStart - 16, w:680, h:160 }, fieldsRegion || { x:552, y:bodyEnd - 96, w:680, h:96 }, action];
}

function setupDesktop(screen) {
  const bodyStart = 176;
  const body = [tx(560, 112, screen.title, 28, "#000", 'font-weight="700"'), multiline(560, 144, wrap(screen.subtitle, 84, 2), 14, "#666", 20)];
  let top = bodyStart;
  const copy = copyDesktop(screen.copyValue, top); body.push(copy.body); top = copy.top;
  const code = codeDesktop(screen.code, top); body.push(code.body); top = code.top;
  const instructions = instructionsDesktop(screen.instructions, top); body.push(instructions.body); top = instructions.top;
  const fields = fieldsDesktop(screen.fields, top + (screen.fields?.length ? 16 : 0)); body.push(fields.body); top = fields.top;
  const actionY = top + 32;
  const height = Math.max(800, actionY + (screen.secondary ? 104 : 96));
  if (screen.secondary) {
    body.push(button(560, actionY, 256, screen.secondary));
    body.push(button(832, actionY, 392, screen.primary, true));
  } else body.push(button(832, actionY, 392, screen.primary, true));
  const firstRegion = copy.region || code.region || instructions.region;
  const regions = desktopRegions(screen, bodyStart, top, actionY, firstRegion, fields.region);
  return { width:1280, height, svg:baseSvg(1280, height, `${globalSidebar(height)}${topbar(screen.provider)}${stepRail(screen, height)}${body.join("\n")}${annotations(regions)}`) };
}

function mobileHeader(screen) {
  return `<g data-region="mobile-header">${rc(0, 0, 375, 56)}${tx(16, 35, `‹  ${screen.short}`, 14, "#000", 'font-weight="600"')}${tx(359, 35, "Save & exit", 12, "#666", 'text-anchor="end"')}</g>`;
}

function mobileRail(screen) {
  const start = 88;
  const gap = 56;
  const body = [tx(16, 80, screen.mode === "advanced" ? "CUSTOM SETUP" : "SETUP", 12, "#666", 'font-weight="700"')];
  if (screen.rail.length > 1) body.push(ln(32, start + 16, 32, start + 16 + (screen.rail.length - 1) * gap));
  screen.rail.forEach((label, index) => {
    const y = start + index * gap;
    const complete = index < screen.active;
    const active = index === screen.active;
    body.push(circle(32, y + 16, 16, complete ? 'fill="#000"' : 'fill="#fff"'));
    body.push(tx(32, y + 21, complete ? "✓" : index + 1, 14, complete ? "#fff" : "#000", 'text-anchor="middle" font-weight="700"'));
    body.push(tx(64, y + 21, label, 14, active || complete ? "#000" : "#666", active ? 'font-weight="700"' : ""));
  });
  return { body:body.join("\n"), end:start + screen.rail.length * gap };
}

function instructionsMobile(items, top) {
  if (!items?.length) return { body:"", top, region:null };
  const start = top;
  const body = [tx(16, top + 24, "Do this", 20, "#000", 'font-weight="700"')];
  top += 56;
  items.forEach(([title, detail], index) => {
    body.push(circle(32, top + 24, 16, 'fill="#fff"'));
    body.push(tx(32, top + 29, index + 1, 14, "#000", 'text-anchor="middle" font-weight="700"'));
    body.push(tx(64, top + 20, title, 14, "#000", 'font-weight="600"'));
    body.push(multiline(64, top + 44, wrap(detail, 38, 3), 12, "#666", 16));
    if (index < items.length - 1) body.push(ln(64, top + 96, 359, top + 96, 'stroke="#e6e6e6"'));
    top += 112;
  });
  return { body:body.join("\n"), top, region:{ x:8, y:start - 8, w:359, h:top - start } };
}

function setupMobile(screen) {
  const rail = mobileRail(screen);
  const body = [rail.body];
  let top = rail.end + 32;
  const titleStart = top;
  body.push(multiline(16, top + 24, wrap(screen.title, 32, 2), 20, "#000", 24, 'font-weight="700"'));
  top += 80;
  body.push(multiline(16, top, wrap(screen.subtitle, 46, 3), 12, "#666", 16));
  top += 64;
  let firstRegion = null;
  if (screen.copyValue) {
    const [label, action] = screen.copyValue;
    const start = top;
    body.push(tx(16, top + 16, label, 14, "#000", 'font-weight="600"'));
    body.push(button(16, top + 32, 343, action));
    top += 104;
    firstRegion = { x:8, y:start - 8, w:359, h:96 };
  }
  if (screen.code) {
    const start = top;
    body.push(tx(16, top + 16, "Setup command", 14, "#000", 'font-weight="600"'));
    body.push(rc(16, top + 32, 343, 72, 'fill="#e6e6e6"'));
    body.push(multiline(32, top + 58, wrap(screen.code, 42, 2), 12, "#000", 18));
    top += 128;
    firstRegion ||= { x:8, y:start - 8, w:359, h:120 };
  }
  const instructions = instructionsMobile(screen.instructions, top); body.push(instructions.body); top = instructions.top;
  firstRegion ||= instructions.region;
  let fieldsRegion = null;
  if (screen.fields?.length) {
    const start = top + 16;
    top = start;
    for (const [label, placeholder] of screen.fields) {
      body.push(tx(16, top + 16, label, 14, "#000", 'font-weight="600"'));
      body.push(rc(16, top + 32, 343, 48, 'fill="#fff"'));
      body.push(tx(32, top + 62, placeholder, 14, "#666"));
      top += 104;
    }
    fieldsRegion = { x:8, y:start - 8, w:359, h:top - start - 8 };
  }
  const actionY = top + 32;
  if (screen.secondary) {
    body.push(button(16, actionY, 343, screen.secondary));
    body.push(button(16, actionY + 64, 343, screen.primary, true));
  } else body.push(button(16, actionY, 343, screen.primary, true));
  const actionHeight = screen.secondary ? 128 : 64;
  const height = Math.max(812, actionY + actionHeight + 24);
  const railRegion = { x:8, y:64, w:359, h:rail.end - 56 };
  const actionRegion = { x:8, y:actionY - 8, w:359, h:actionHeight };
  let regions;
  if (screen.annotations.length === 2) regions = [railRegion, { x:8, y:titleStart - 8, w:359, h:actionY + actionHeight - titleStart }];
  else if (screen.annotations.length === 3) regions = [railRegion, { x:8, y:titleStart - 8, w:359, h:top - titleStart + 16 }, actionRegion];
  else regions = [railRegion, firstRegion || { x:8, y:titleStart - 8, w:359, h:160 }, fieldsRegion || { x:8, y:top - 104, w:359, h:96 }, actionRegion];
  return { width:375, height, svg:baseSvg(375, height, `${mobileHeader(screen)}${body.join("\n")}${annotations(regions, true)}`) };
}

const sharedDefinitions = [
  { id:"01", slug:"connectors-catalog", title:"Connectors", subtitle:"Connect tools and places where people talk to agents.", group:"Start", tab:"Shared", annotations:["The existing Apps catalog remains the entry point.", "Filters separate chat and tool methods.", "Each connector row has one Connect action.", "Connection state remains visible in the catalog."], rationale:"The current Connectors surface remains canonical." },
  { id:"02", slug:"connection-purpose", title:"Choose how to connect", subtitle:"Shown for every connector that supports both chat and tool methods.", group:"Start", tab:"Shared", annotations:["The existing connection wizard shell and selected provider are reused.", "Chat with an agent is the incoming-conversation path.", "Use this connection as an agent tool is the outbound tool/credential path.", "Single-purpose providers skip the choice."], rationale:"The registry drives the same direction choice for every dual-surface connector." },
  { id:"03", slug:"choose-agent", title:"Which agent do you want to chat with?", subtitle:"Choose the one agent represented by this connection.", group:"Start", tab:"Shared", annotations:["The existing agent selector is reused.", "Only active agents can be selected.", "One selection is required.", "Continue begins provider setup."], rationale:"This is the only shared Paperclip-specific setup decision." },
  { id:"11", slug:"bound-task", title:"Externally bound task", subtitle:"A normal Paperclip task with explicit publication and detach controls.", group:"Paperclip", tab:"Task", annotations:["The task shows its external source.", "External actors remain attributed.", "Publishing back to the provider is explicit for human comments.", "The agent remains locked until detach."], rationale:"External work stays in the ordinary governed task experience." },
  { id:"12", slug:"agent-channels", title:"Agent Channels", subtitle:"See every provider identity representing this agent.", group:"Paperclip", tab:"Agent", annotations:["Channel identities are summarized per provider.", "Health and recent tasks remain visible.", "Connections open in Connectors.", "Connect a channel preselects this agent."], rationale:"Agent detail summarizes endpoints while Connectors manages them." }
];

const sharedScreens = sharedDefinitions.map((screen) => {
  for (const suffix of ["", "-mobile"]) {
    writeFileSync(join(out, `${screen.id}-${screen.slug}${suffix}.svg`), readFileSync(join(previous, `${screen.id}-${screen.slug}${suffix}.svg`), "utf8"));
  }
  return { ...screen, desktopSize:"1280×800", mobileSize:"375×812" };
});

const setupScreens = [];
for (const flow of setupFlows) {
  for (const definition of flow.screens) {
    const screen = { ...definition, provider:flow.provider, short:flow.short, group:flow.provider, tab:definition.mode === "advanced" ? "Custom setup" : "Setup" };
    const desktop = setupDesktop(screen);
    const mobile = setupMobile(screen);
    writeFileSync(join(out, `${screen.id}-${screen.slug}.svg`), `${desktop.svg}\n`);
    writeFileSync(join(out, `${screen.id}-${screen.slug}-mobile.svg`), `${mobile.svg}\n`);
    setupScreens.push({ ...screen, desktopSize:`${desktop.width}×${desktop.height}`, mobileSize:`${mobile.width}×${mobile.height}` });
  }
}

const detailScreens = [];
for (const provider of providers) {
  const definitions = [
    [provider.ids.overview, `${provider.slug}-overview`, `${provider.name} overview`, "Overview", provider.overviewAnnotations, "Identity, health, capabilities, and lifecycle."],
    [provider.ids.settings, `${provider.slug}-settings`, `${provider.name} settings`, "Settings", provider.settingsAnnotations, "Scope, task boundaries, and necessary provider operations."],
    [provider.ids.access, `${provider.slug}-access`, `${provider.name} access`, "Access", provider.accessAnnotations, "Identity links, sponsored guests, and effective authority."],
    [provider.ids.conversations, `${provider.slug}-conversations`, `${provider.name} conversations`, "Conversations", provider.conversationAnnotations, "Native conversation-to-Paperclip task bindings."],
    [provider.ids.activity, `${provider.slug}-activity`, `${provider.name} activity`, "Activity", provider.activityAnnotations, "Provider health, deliveries, publications, and retries."]
  ];
  for (const [id, slug, title, tab, screenAnnotations, subtitle] of definitions) {
    for (const suffix of ["", "-mobile"]) writeFileSync(join(out, `${id}-${slug}${suffix}.svg`), readFileSync(join(previous, `${id}-${slug}${suffix}.svg`), "utf8"));
    const svg = readFileSync(join(out, `${id}-${slug}.svg`), "utf8");
    const mobile = readFileSync(join(out, `${id}-${slug}-mobile.svg`), "utf8");
    const desktopSize = svg.match(/width="(\d+)" height="(\d+)"/)?.slice(1).join("×");
    const mobileSize = mobile.match(/width="(\d+)" height="(\d+)"/)?.slice(1).join("×");
    detailScreens.push({ id, slug, title, tab, subtitle, annotations:screenAnnotations, rationale:`${tab} remains provider-specific and outside onboarding.`, provider:provider.name, group:provider.name, desktopSize, mobileSize });
  }
  const source = walkthroughSources.find((screen) => screen.id === provider.ids.walkthrough);
  const slug = `${provider.slug}-interactions`;
  for (const suffix of ["", "-mobile"]) writeFileSync(join(out, `${source.id}-${slug}${suffix}.svg`), readFileSync(join(previous, `${source.id}-${slug}${suffix}.svg`), "utf8"));
  detailScreens.push({ ...source, slug, title:`How ${provider.name} conversations work`, tab:"Conversation walkthrough", subtitle:"The provider-native interaction and fallback model.", rationale:"Capabilities are demonstrated here, not configured during setup.", provider:provider.name, group:provider.name, desktopSize:"1280×960", mobileSize:"375×1320" });
}

function flowSvg() {
  const node = (x, y, w, title, sub, fill = false) => `${rc(x, y, w, 88, fill ? 'fill="#e6e6e6"' : 'fill="#fff"')}${tx(x + 16, y + 32, title, 14, "#000", 'font-weight="700"')}${tx(x + 16, y + 60, sub, 12, "#666")}`;
  const arrow = (x1, y1, x2, y2) => `${ln(x1, y1, x2, y2)}<polygon points="${x2},${y2} ${x2 - 8},${y2 - 6} ${x2 - 8},${y2 + 6}" fill="#000" stroke="none"/>`;
  return baseSvg(1280, 880, `${tx(48, 48, "Minimum chat-connector setup", 28, "#000", 'font-weight="700"')}${tx(48, 80, "Every setup screen contains only actions or values the operator must provide.", 14, "#666")}
    ${node(48,128,176,"Connectors","Choose provider",true)}${arrow(224,172,264,172)}${node(264,128,192,"Purpose?","Only if dual-surface")}${arrow(456,172,496,172)}${node(496,128,184,"Choose agent","Once")}${arrow(680,172,720,172)}${node(720,128,216,"Provider actions","Minimum required")}${arrow(936,172,976,172)}${node(976,128,208,"Test","Real message",true)}
    ${tx(48,304,"NORMAL PATHS",12,"#666",'font-weight="700"')}${node(48,336,248,"Slack","Add to Slack → test")}${node(312,336,248,"GitHub","Create → repos → test")}${node(576,336,264,"Microsoft Teams","Command → install → test")}${node(856,336,248,"Telegram","BotFather token → test")}
    ${tx(48,512,"ONLY WHEN THE NORMAL PATH IS UNAVAILABLE",12,"#666",'font-weight="700"')}${node(48,544,320,"Customer-owned Slack App","Manifest → install → 2 secrets")}${node(392,544,320,"Existing GitHub App","Webhook settings → ID + key")}${node(736,544,320,"Manual Microsoft setup","Endpoint → 3 identity values")}
    ${tx(48,728,"After setup",20,"#000",'font-weight="700"')}${tx(48,760,"Overview shows automatic health and capabilities. Settings contains only real scope, boundary, access, and repair decisions.",14,"#666")}
    ${annotations([{x:40,y:120,w:1152,h:104},{x:40,y:328,w:1072,h:104},{x:40,y:536,w:1024,h:104},{x:40,y:712,w:1152,h:72}])}`);
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

function uiDocument() {
  const inventory = orderedScreens.map((screen) => `| ${screen.id} | ${screen.group} | ${screen.tab} | ${screen.title} | ${screen.desktopSize} | ${screen.mobileSize} |`).join("\n");
  const details = orderedScreens.map((screen) => `### ${screen.id} · ${screen.title}\n\nPurpose: ${screen.subtitle}\n\n${screen.annotations.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\n${screen.actions ? `Actions:\n\n${screen.actions.map(([label, effect]) => `- **${label}:** ${effect}`).join("\n")}\n\n` : ""}Rationale: ${screen.rationale}`).join("\n\n");
  return `# Paperclip Chat Adapters UI Surfaces — v6\n\nDate: 2026-09-04  \nPaperclip base: \`${baseSha}\`  \nReview viewer: [\`index.html\`](./index.html)  \nWireframes: [\`wireframes-v6/\`](./wireframes-v6/)  \nMinimum-setup specification: [\`2026-09-04-chat-adapters-minimum-setup-v6.md\`](./2026-09-04-chat-adapters-minimum-setup-v6.md)\n\n## Relevance rule\n\nA setup screen may show only something the operator must click, copy, paste, upload, choose, or perform at the provider during that step. Do not repeat the selected agent, describe automatic Paperclip work, list capabilities, or show successful checks. Errors and unmet prerequisites appear only when they occur.\n\n## Current setup inventory\n\n- Slack: Add to Slack and a three-step customer-owned-App fallback converge on one test screen.\n- GitHub: App Manifest creation, repository installation, and test; existing App is an advanced fallback.\n- Microsoft Teams: one guided command, one install link, and test; manual Microsoft registration is an advanced fallback.\n- Telegram: BotFather token and one private-message test.\n- Capabilities and health remain on Overview and the interaction walkthroughs, never in setup.\n\n## Inventory\n\n| ID | Group | Surface | Title | Desktop | Mobile |\n|---|---|---|---|---|---|\n${inventory}\n\n## Annotation and action notes\n\n${details}\n`;
}

function viewerHtml() {
  const template = readFileSync(join(root, "../../../packages/skills-catalog/catalog/bundled/product/wireframe/assets/site-template.html"), "utf8");
  const style = template.match(/<style>[\s\S]*?<\/style>/)?.[0];
  if (!style) throw new Error("Could not load wireframe viewer styles");
  const toc = groups.map(([label, screens]) => `<h2>${esc(label)}</h2>${screens.map((screen) => `<a href="#s${screen.id}"><span class="num">${Number(screen.id)}</span>${esc(screen.title)}</a>`).join("\n")}`).join("\n");
  const sections = groups.map(([label, screens]) => `<div class="provider-break"><div class="lede">${esc(label)}</div><h2>${label === "Start" ? "Shared connection start" : label === "Paperclip" ? "Shared Paperclip surfaces" : `${esc(label)} connector`}</h2></div>${screens.map((screen) => {
    const notes = screen.annotations.map((note, index) => `<li><b>${index + 1}</b> — ${esc(note)}</li>`).join("\n");
    const actions = screen.actions ? `<h3>What the actions do</h3><ul>${screen.actions.map(([name, effect]) => `<li><b>${esc(name)}</b> — ${esc(effect)}</li>`).join("\n")}</ul>` : "";
    return `<section id="s${screen.id}"><div class="lede">${esc(screen.group)} · ${esc(screen.tab)}</div><h2><span class="step-num">${Number(screen.id)}.</span>${esc(screen.title)}</h2><p class="desc">${esc(screen.subtitle)}</p><div class="grid"><div class="wire" data-zoom data-caption="${screen.id} · ${esc(screen.title)} (desktop)"><div class="label"><span>${screen.id}-${screen.slug}.svg</span><span>${screen.desktopSize} · desktop</span></div><img src="wireframes-v6/${screen.id}-${screen.slug}.svg" alt="${esc(screen.title)} desktop wireframe" /></div><div class="wire mobile-wire mobile-col" data-zoom data-caption="${screen.id} · ${esc(screen.title)} (mobile)"><div class="label"><span>mobile</span><span>${screen.mobileSize}</span></div><img src="wireframes-v6/${screen.id}-${screen.slug}-mobile.svg" alt="${esc(screen.title)} mobile wireframe" /></div><div class="notes-col"><div class="notes"><h3>Annotations</h3><ul>${notes}</ul>${actions}<div class="why"><b>Rationale:</b> ${esc(screen.rationale)}</div></div></div></div></section>`;
  }).join("\n")}`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Paperclip chat adapters — minimum setup review</title>${style}<style>.doc-links{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:16px}.doc-links a{min-height:48px;display:inline-flex;align-items:center;font-size:13px;font-weight:600}.notice{max-width:var(--maxw);margin:-32px 0 48px;padding:14px 18px;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:4px}.notice p{margin:0}.decision{margin-top:24px;padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:8px}.decision b{display:block;margin-bottom:6px}.provider-break{max-width:var(--maxw);margin:80px 0 8px;padding-top:24px;border-top:2px solid var(--ink)}.provider-break h2{font-size:28px;margin:6px 0 0}.toc-body h2{margin-top:18px}code{font-size:.92em}</style></head><body><div class="shell"><details class="toc"><summary class="toc-summary"><span><span class="crumb">Chat adapters · v6</span><br><span class="title">Jump to a screen</span></span><span class="chevron" aria-hidden="true"></span></summary><nav class="toc-body" aria-label="Section navigation"><h1>Chat adapters</h1><div style="font-size:13px;color:var(--muted);margin-bottom:16px">Minimum setup review</div><h2>Documents</h2><a href="2026-09-03-chat-adapters-architecture.md"><span class="num">A</span>Architecture</a><a href="2026-09-04-chat-adapters-minimum-setup-v6.md"><span class="num">M</span>Minimum setup</a><a href="2026-09-04-chat-adapters-ui-surfaces-v6.md"><span class="num">U</span>UI specification v6</a><a href="2026-09-04-chat-adapters-platform-surfaces.md"><span class="num">P</span>Platform research</a><h2>Flow</h2><a href="#flow"><span class="num">⤳</span>Product flow</a>${toc}<h2>Review</h2><a href="#coverage"><span class="num">✓</span>Decisions and coverage</a></nav></details><main><header class="hero"><div class="crumb">Paperclip · Connectors · Setup v6</div><h1>Only show what the person must do.</h1><p>Every provider wizard now contains only required clicks, copied values, uploads, provider actions, and test instructions. Automatic Paperclip work is absent from setup.</p><div class="decision"><b>Relevance test</b><span>If the operator cannot act on it during this step, it does not appear on the screen.</span></div><div class="doc-links"><a href="2026-09-03-chat-adapters-architecture.md">Architecture plan</a><a href="2026-09-04-chat-adapters-minimum-setup-v6.md">Minimum setup specification</a><a href="2026-09-04-chat-adapters-ui-surfaces-v6.md">UI specification v6</a></div><div class="pills"><span class="pill">${orderedScreens.length} product surfaces</span><span class="pill">${setupScreens.length} setup phases</span><span class="pill">No setup status reports</span><span class="pill">Desktop + mobile</span></div></header><div class="notice" role="note"><p><b>Review convention:</b> red dashed marks are annotations, not proposed UI. The supplied screenshot informed only the persistent step-rail layout.</p></div><section id="flow" class="flow-section"><div class="lede">Navigation and product flow</div><h2>Minimum provider setup</h2><p class="desc">Normal paths are short. Manual provider registration appears only when the simpler handoff is unavailable.</p><div class="wire" data-zoom data-caption="Minimum chat connector setup flow"><div class="label"><span>flow.svg</span><span>1280×880</span></div><img src="wireframes-v6/flow.svg" alt="Minimum chat connector setup flow"/></div></section>${sections}<section id="coverage"><div class="lede">Review</div><h2>What changed in v6</h2><div class="notes"><ul><li>Agent identity is not repeated after the agent-selection step.</li><li>Automatic credentials, delivery, capabilities, and successful checks are absent from setup.</li><li>Test screens contain instructions only.</li><li>Slack's customer-owned-App branch gives the exact manifest, installation, token, signing-secret, and channel test sequence.</li><li>GitHub uses its manifest and repository-installation handoffs.</li><li>Teams uses the install link returned by the guided CLI command; package upload is no longer the normal path.</li><li>Telegram goes directly from BotFather token to a private-message test.</li><li>Paperclip base: <code>${baseSha}</code>, matching <code>origin/master</code> when generated.</li></ul></div></section><div class="footer">Generated with Paperclip’s wireframe contract. Empty space is intentional; setup contains no non-actionable filler.</div></main></div><div class="lightbox" id="lb" aria-hidden="true"><span class="close" id="lbClose" role="button" aria-label="Close preview">×</span><img id="lbImg" alt=""/><div class="caption" id="lbCap"></div></div><script>const lb=document.getElementById('lb'),lbImg=document.getElementById('lbImg'),lbCap=document.getElementById('lbCap');document.querySelectorAll('[data-zoom]').forEach(el=>el.addEventListener('click',()=>{const target=el.querySelector('img');if(!target)return;lbImg.src=target.src;lbImg.alt=target.alt;lbCap.textContent=el.dataset.caption||target.alt||'';lb.classList.add('open');lb.setAttribute('aria-hidden','false')}));function closeLightbox(){lb.classList.remove('open');lb.setAttribute('aria-hidden','true')}lb.addEventListener('click',closeLightbox);document.getElementById('lbClose').addEventListener('click',closeLightbox);document.addEventListener('keydown',e=>{if(e.key==='Escape')closeLightbox()});const tocElement=document.querySelector('details.toc'),media=window.matchMedia('(max-width:900px)'),setToc=()=>{tocElement.open=!media.matches};setToc();media.addEventListener('change',setToc);tocElement.querySelectorAll('.toc-body a').forEach(link=>link.addEventListener('click',()=>{if(media.matches)tocElement.open=false}));</script></body></html>`;
}

writeFileSync(join(root, "2026-09-04-chat-adapters-ui-surfaces-v6.md"), `${uiDocument()}\n`);
writeFileSync(join(root, "index.html"), `${viewerHtml()}\n`);
console.log(`Generated ${orderedScreens.length * 2 + 1} v6 SVGs across ${orderedScreens.length} product surfaces.`);
