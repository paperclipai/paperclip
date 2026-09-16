import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseSha, providers } from "./platform-wireframe-data-v4.mjs";
import { providerScreens as walkthroughSources } from "./platform-wireframe-data-v3.mjs";
import { setupFlows } from "./setup-wireframe-data-v6.mjs";
import { fixedBehavior, providerSettings } from "./settings-wireframe-data-v7.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const previous = join(root, "wireframes-v6");
const out = join(root, "wireframes-v7");
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
  return `${rc(x, y, w, 48, primary ? 'fill="#000"' : 'fill="#fff"')}${tx(x + w / 2, y + 32, label, 14, primary ? "#fff" : "#000", 'text-anchor="middle" font-weight="600"')}`;
}

function toggle(x, y, on, mobile = false) {
  const hit = mobile ? rc(x - 16, y - 16, 64, 48, 'fill="#fff"') : "";
  return `${hit}${rc(x, y - 4, 48, 24, on ? 'fill="#000"' : 'fill="#fff"')}${circle(on ? x + 32 : x + 16, y + 8, 8, on ? 'fill="#fff"' : 'fill="#000"')}`;
}

function annotations(regions, mobile = false) {
  return `<g data-region="annotations">${regions.map((region, index) => `${rc(region.x, region.y, region.w, region.h, 'fill="none" stroke="#d33" stroke-dasharray="6 4"')}${circle(region.x, region.y, mobile ? 8 : 12, 'fill="#fff" stroke="#d33" stroke-dasharray="4 2"')}${tx(region.x, region.y + 4, index + 1, 12, "#d33", 'text-anchor="middle" font-weight="700"')}`).join("\n")}</g>`;
}

function globalSidebar(height) {
  const items = ["New Task", "Search", "Dashboard", "Inbox", "Tasks", "Projects", "Routines", "Artifacts", "Agents", "Skills", "Connectors", "Audit"];
  return `<g data-region="global-sidebar">${tx(24, 40, "Paperclip", 20, "#000", 'font-weight="700"')}${items.map((item, index) => {
    const y = 80 + index * 48;
    return `${item === "Connectors" ? rc(8, y - 24, 224, 40, 'fill="#e6e6e6"') : ""}${circle(32, y - 8, 6, 'fill="#e6e6e6"')}${tx(56, y, item, 14, item === "Connectors" ? "#000" : "#666", item === "Connectors" ? 'font-weight="600"' : "")}`;
  }).join("\n")}${tx(24, height - 56, "Acme Company", 14, "#000", 'font-weight="600"')}${tx(24, height - 32, "Dana · Admin", 12, "#666")}${ln(240, 0, 240, height)}</g>`;
}

function topbar(provider, tab) {
  return `<g data-region="topbar">${ln(240, 64, 1280, 64)}${tx(264, 40, `CONNECTORS  ›  Maya on ${provider}  ›  ${tab}`, 14, "#666")}${circle(1240, 32, 16, 'fill="#e6e6e6"')}</g>`;
}

function endpointNav(provider, active, height) {
  const tabs = ["Settings", "Access", "Conversations", "Activity"];
  return `<g data-region="connector-navigation">${tx(264, 96, "‹  All connectors", 12, "#666")}${circle(280, 136, 16, 'fill="#e6e6e6"')}${tx(312, 144, `Maya on ${provider}`, 14, "#000", 'font-weight="700"')}${tabs.map((tab, index) => {
    const y = 192 + index * 48;
    return `${tab === active ? rc(256, y - 24, 208, 40, 'fill="#e6e6e6"') : ""}${tx(280, y, tab, 14, tab === active ? "#000" : "#666", tab === active ? 'font-weight="600"' : "")}`;
  }).join("\n")}${ln(480, 64, 480, height)}</g>`;
}

function sectionHeight(section) {
  if (section.kind === "resources") return 176 + section.items.length * 72;
  return 104 + section.items.length * 80;
}

function sectionDesktop(section, top) {
  const body = [tx(512, top + 24, section.title, 20, "#000", 'font-weight="700"'), multiline(512, top + 48, wrap(section.intro, 88, 2), 12, "#666", 16), ln(512, top + 72, 1224, top + 72)];
  if (section.kind === "resources") {
    section.items.forEach(([label, detail], index) => {
      const y = top + 80 + index * 72;
      if (index) body.push(ln(528, y, 1208, y, 'stroke="#e6e6e6"'));
      body.push(rc(528, y + 16, 24, 24, 'fill="#000"'));
      body.push(tx(540, y + 32, "✓", 12, "#fff", 'text-anchor="middle" font-weight="700"'));
      body.push(tx(568, y + 24, label, 14, "#000", 'font-weight="600"'));
      body.push(tx(568, y + 48, detail, 12, "#666"));
    });
    const actionY = top + 96 + section.items.length * 72;
    body.push(button(1000, actionY, 224, section.action));
  } else {
    section.items.forEach(([label, detail, on], index) => {
      const y = top + 80 + index * 80;
      if (index) body.push(ln(528, y, 1208, y, 'stroke="#e6e6e6"'));
      body.push(tx(528, y + 24, label, 14, "#000", 'font-weight="600"'));
      body.push(tx(528, y + 48, detail, 12, "#666"));
      body.push(toggle(1160, y + 24, on));
    });
  }
  const height = sectionHeight(section);
  return { body: body.join("\n"), height, region:{ x:504, y:top - 8, w:728, h:height } };
}

function settingsDesktop(screen, provider) {
  const contentHeight = screen.sections.reduce((sum, section) => sum + sectionHeight(section), 0);
  const height = Math.max(800, 176 + contentHeight + 112);
  const body = [tx(512, 112, screen.title, 28, "#000", 'font-weight="700"'), tx(512, 144, screen.subtitle, 14, "#666")];
  const regions = [{ x:256, y:80, w:216, h:304 }];
  let top = 176;
  for (const section of screen.sections) {
    const rendered = sectionDesktop(section, top);
    body.push(rendered.body);
    regions.push(rendered.region);
    top += rendered.height;
  }
  const actionY = top + 24;
  body.push(button(1016, actionY, 208, "Save changes", true));
  regions.push({ x:1000, y:actionY - 16, w:232, h:72 });
  return { width:1280, height, svg:baseSvg(1280, height, `${globalSidebar(height)}${topbar(provider, "Settings")}${endpointNav(provider, "Settings", height)}${body.join("\n")}${annotations(regions)}`) };
}

function mobileHeader(provider) {
  return `${rc(0, 0, 375, 56)}${tx(16, 32, `‹  Maya on ${provider}`, 14, "#000", 'font-weight="600"')}${tx(359, 32, "Menu", 12, "#666", 'text-anchor="end"')}${rc(16, 72, 343, 48, 'fill="#fff"')}${tx(32, 104, "Settings", 14, "#000", 'font-weight="600"')}${tx(343, 104, "⌄", 14, "#666", 'text-anchor="end"')}`;
}

function sectionMobile(section, top) {
  const introLines = wrap(section.intro, 46, 3);
  const headerHeight = 72 + introLines.length * 16;
  const body = [tx(16, top + 24, section.title, 20, "#000", 'font-weight="700"'), multiline(16, top + 48, introLines, 12, "#666", 16), ln(16, top + headerHeight, 359, top + headerHeight)];
  let y = top + headerHeight + 16;
  if (section.kind === "resources") {
    section.items.forEach(([label, detail], index) => {
      if (index) body.push(ln(24, y, 351, y, 'stroke="#e6e6e6"'));
      body.push(rc(24, y + 16, 24, 24, 'fill="#000"'));
      body.push(tx(36, y + 32, "✓", 12, "#fff", 'text-anchor="middle" font-weight="700"'));
      body.push(tx(64, y + 24, label, 14, "#000", 'font-weight="600"'));
      body.push(tx(64, y + 48, detail, 12, "#666"));
      y += 80;
    });
    body.push(button(16, y + 16, 343, section.action));
    y += 88;
  } else {
    section.items.forEach(([label, detail, on], index) => {
      if (index) body.push(ln(24, y, 351, y, 'stroke="#e6e6e6"'));
      body.push(tx(24, y + 24, label, 14, "#000", 'font-weight="600"'));
      body.push(multiline(24, y + 48, wrap(detail, 40, 2), 12, "#666", 16));
      body.push(toggle(303, y + 24, on, true));
      y += 96;
    });
  }
  return { body:body.join("\n"), height:y - top, region:{ x:8, y:top - 8, w:359, h:y - top } };
}

function settingsMobile(screen, provider) {
  const body = [mobileHeader(provider), tx(16, 160, screen.title, 20, "#000", 'font-weight="700"'), multiline(16, 192, wrap(screen.subtitle, 46, 3), 12, "#666", 16)];
  const regions = [{ x:8, y:64, w:359, h:64 }];
  let top = 232;
  for (const section of screen.sections) {
    const rendered = sectionMobile(section, top);
    body.push(rendered.body);
    regions.push(rendered.region);
    top += rendered.height + 16;
  }
  const actionY = top + 16;
  body.push(button(16, actionY, 343, "Save changes", true));
  regions.push({ x:8, y:actionY - 8, w:359, h:64 });
  const height = Math.max(812, actionY + 88);
  body.push(annotations(regions, true));
  return { width:375, height, svg:baseSvg(375, height, body.join("\n")) };
}

function patchDesktopNavigation(svg, provider, tab) {
  const start = svg.indexOf('<g><text x="264" y="94"');
  const marker = '</g><text x="504"';
  const end = svg.indexOf(marker, start);
  if (start < 0 || end < 0) throw new Error(`Could not replace ${provider} ${tab} navigation`);
  const height = Number(svg.match(/<svg[^>]+height="(\d+)"/)?.[1]);
  return `${svg.slice(0, start)}${endpointNav(provider, tab, height)}${svg.slice(end + 4)}`;
}

const conversationBoundaryCopy = {
  Slack: "A channel root and its replies are one task. The first mention in an existing thread binds it. A DM has one open task; after completion the next message starts another.",
  GitHub: "An issue, pull-request conversation, or inline review thread binds once to one Paperclip task.",
  "Microsoft Teams": "A channel post and its replies are one task. A personal or group chat has one open task; after completion the next message starts another.",
  Telegram: "A DM or ordinary group has one open task; after completion the next addressed message starts another. A forum topic has one stable topic-to-task binding."
};

function patchConversationBoundary(svg, provider, mobile) {
  const startToken = mobile ? '<text x="16" y="260"' : '<text x="504" y="234"';
  const endToken = mobile ? '<line x1="16" y1="348"' : '<line x1="504" y1="278"';
  const start = svg.indexOf(startToken);
  const end = svg.indexOf(endToken, start);
  if (start < 0 || end < 0) throw new Error(`Could not replace ${provider} conversation boundary`);
  const copy = conversationBoundaryCopy[provider];
  const replacement = mobile
    ? multiline(16, 260, wrap(copy, 46, 4), 12, "#666", 18)
    : multiline(504, 234, wrap(copy, 88, 2), 14, "#666", 20);
  return `${svg.slice(0, start)}${replacement}${svg.slice(end)}`.replaceAll("active task", "open task");
}

const sharedDefinitions = [
  { id:"01", slug:"connectors-catalog", title:"Connectors", subtitle:"Connect tools and places where people talk to agents.", group:"Start", tab:"Shared", annotations:["The existing Apps catalog remains the entry point.", "Filters separate chat and tool methods.", "Each connector row has one Connect action.", "Connection state remains visible in the catalog."], rationale:"The current Connectors surface remains canonical." },
  { id:"02", slug:"connection-purpose", title:"Choose how to connect", subtitle:"Shown for every connector that supports both chat and tool methods.", group:"Start", tab:"Shared", annotations:["The existing connection wizard shell and selected provider are reused.", "Chat with an agent is the incoming-conversation path.", "Use this connection as an agent tool is the outbound tool/credential path.", "Single-purpose providers skip the choice."], rationale:"The registry drives the same direction choice for every dual-surface connector." },
  { id:"03", slug:"choose-agent", title:"Which agent do you want to chat with?", subtitle:"Choose the one agent represented by this connection.", group:"Start", tab:"Shared", annotations:["The existing agent selector is reused.", "Only active agents can be selected.", "One selection is required.", "Continue begins provider setup."], rationale:"This is the only shared Paperclip-specific setup decision." },
  { id:"11", slug:"bound-task", title:"Externally bound task", subtitle:"A normal Paperclip task with explicit publication and detach controls.", group:"Paperclip", tab:"Task", annotations:["The task shows its external source.", "External actors remain attributed.", "Publishing back to the provider is explicit for human comments.", "The agent remains locked until detach."], rationale:"External work stays in the ordinary governed task experience." },
  { id:"12", slug:"agent-channels", title:"Agent Channels", subtitle:"See every provider identity representing this agent.", group:"Paperclip", tab:"Agent", annotations:["Channel identities are summarized per provider.", "Health and recent tasks remain visible.", "Connections open in Connectors.", "Connect a channel preselects this agent."], rationale:"Agent detail summarizes endpoints while Connectors manages them." }
];

const sharedScreens = sharedDefinitions.map((screen) => {
  for (const suffix of ["", "-mobile"]) writeFileSync(join(out, `${screen.id}-${screen.slug}${suffix}.svg`), readFileSync(join(previous, `${screen.id}-${screen.slug}${suffix}.svg`), "utf8"));
  return { ...screen, desktopSize:"1280×800", mobileSize:"375×812" };
});

const setupScreens = [];
for (const flow of setupFlows) for (const definition of flow.screens) {
  const screen = { ...definition, provider:flow.provider, group:flow.provider, tab:definition.mode === "advanced" ? "Custom setup" : "Setup" };
  for (const suffix of ["", "-mobile"]) writeFileSync(join(out, `${screen.id}-${screen.slug}${suffix}.svg`), readFileSync(join(previous, `${screen.id}-${screen.slug}${suffix}.svg`), "utf8"));
  const desktop = readFileSync(join(out, `${screen.id}-${screen.slug}.svg`), "utf8");
  const mobile = readFileSync(join(out, `${screen.id}-${screen.slug}-mobile.svg`), "utf8");
  setupScreens.push({ ...screen, desktopSize:desktop.match(/width="(\d+)" height="(\d+)"/)?.slice(1).join("×"), mobileSize:mobile.match(/width="(\d+)" height="(\d+)"/)?.slice(1).join("×") });
}

const detailScreens = [];
for (const provider of providers) {
  const setting = providerSettings[provider.name];
  const desktop = settingsDesktop(setting, provider.name);
  const mobile = settingsMobile(setting, provider.name);
  writeFileSync(join(out, `${setting.id}-${setting.slug}.svg`), `${desktop.svg}\n`);
  writeFileSync(join(out, `${setting.id}-${setting.slug}-mobile.svg`), `${mobile.svg}\n`);
  detailScreens.push({ ...setting, provider:provider.name, group:provider.name, tab:"Settings", rationale:"Only destination reach remains configurable; all conversation and delivery behavior is a product default.", desktopSize:`${desktop.width}×${desktop.height}`, mobileSize:`${mobile.width}×${mobile.height}` });

  for (const [key, tab, subtitle, rationale] of [
    ["access", "Access", "Identity links, sponsored guests, and effective authority.", "Identity and authority remain independently manageable."],
    ["conversations", "Conversations", "Native conversation-to-Paperclip task bindings.", "Operators can inspect and detach durable bindings."],
    ["activity", "Activity", "Health, deliveries, publications, and repair actions.", "Diagnostics and conditional repairs live here instead of Settings."]
  ]) {
    const id = provider.ids[key];
    const slug = `${provider.slug}-${key}`;
    let desktopSource = patchDesktopNavigation(readFileSync(join(previous, `${id}-${slug}.svg`), "utf8"), provider.name, tab);
    let mobileSource = readFileSync(join(previous, `${id}-${slug}-mobile.svg`), "utf8");
    if (key === "conversations") {
      desktopSource = patchConversationBoundary(desktopSource, provider.name, false);
      mobileSource = patchConversationBoundary(mobileSource, provider.name, true);
    }
    writeFileSync(join(out, `${id}-${slug}.svg`), desktopSource);
    writeFileSync(join(out, `${id}-${slug}-mobile.svg`), mobileSource);
    const annotationsForKey = key === "access" ? provider.accessAnnotations : key === "conversations" ? provider.conversationAnnotations : provider.activityAnnotations;
    detailScreens.push({ id, slug, title:`${provider.name} ${key}`, provider:provider.name, group:provider.name, tab, subtitle, rationale, annotations:annotationsForKey, desktopSize:desktopSource.match(/width="(\d+)" height="(\d+)"/)?.slice(1).join("×"), mobileSize:mobileSource.match(/width="(\d+)" height="(\d+)"/)?.slice(1).join("×") });
  }

  const source = walkthroughSources.find((screen) => screen.id === provider.ids.walkthrough);
  const slug = `${provider.slug}-interactions`;
  const walkthroughDesktop = patchDesktopNavigation(readFileSync(join(previous, `${source.id}-${slug}.svg`), "utf8"), provider.name, "");
  writeFileSync(join(out, `${source.id}-${slug}.svg`), walkthroughDesktop);
  writeFileSync(join(out, `${source.id}-${slug}-mobile.svg`), readFileSync(join(previous, `${source.id}-${slug}-mobile.svg`), "utf8"));
  detailScreens.push({ ...source, slug, title:`How ${provider.name} conversations work`, provider:provider.name, group:provider.name, tab:"Conversation walkthrough", subtitle:"The fixed provider-native interaction and fallback model.", rationale:"The walkthrough explains automatic behavior without turning it into configuration.", desktopSize:"1280×960", mobileSize:"375×1320" });
}

function flowSvg() {
  const node = (x, y, w, title, sub, fill = false) => `${rc(x, y, w, 88, fill ? 'fill="#e6e6e6"' : 'fill="#fff"')}${tx(x + 16, y + 32, title, 14, "#000", 'font-weight="700"')}${tx(x + 16, y + 64, sub, 12, "#666")}`;
  const arrow = (x1, y1, x2, y2) => `${ln(x1, y1, x2, y2)}<polygon points="${x2},${y2} ${x2 - 8},${y2 - 8} ${x2 - 8},${y2 + 8}" fill="#000" stroke="none"/>`;
  return baseSvg(1280, 880, `${tx(48, 48, "Chat connector product flow", 28, "#000", 'font-weight="700"')}${tx(48, 80, "Configuration is limited to destination reach.", 14, "#666")}
    ${node(48,128,176,"Connectors","Choose provider",true)}${arrow(224,176,264,176)}${node(264,128,192,"Purpose","If dual-surface")}${arrow(456,176,496,176)}${node(496,128,184,"Choose agent","Once")}${arrow(680,176,720,176)}${node(720,128,216,"Provider setup","Minimum actions")}${arrow(936,176,976,176)}${node(976,128,208,"Test","Real message",true)}
    ${tx(48,304,"ENDPOINT MANAGEMENT",12,"#666",'font-weight="700"')}${node(48,336,232,"Settings","Reach only",true)}${node(304,336,232,"Access","Identity + authority")}${node(560,336,232,"Conversations","Bindings")}${node(816,336,232,"Activity","Health + repair")}
    ${tx(48,512,"FIXED PRODUCT BEHAVIOR",12,"#666",'font-weight="700"')}${node(48,544,232,"Activation","Mention starts task")}${node(304,544,232,"Continuation","Replies stay bound")}${node(560,544,232,"Delivery","Instance-selected")}${node(816,544,232,"Capabilities","Maximum safe set")}
    ${tx(48,720,"Removed",20,"#000",'font-weight="700"')}${tx(48,752,"Overview tab, task-boundary settings, delivery-path settings, credential rows, drift rows, and immutable provider identity fields.",14,"#666")}
    ${annotations([{x:40,y:120,w:1152,h:112},{x:40,y:328,w:1016,h:112},{x:40,y:536,w:1016,h:112},{x:40,y:704,w:1152,h:80}])}`);
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
  const defaults = fixedBehavior.map(([name, behavior]) => `- **${name}:** ${behavior}`).join("\n");
  return `# Paperclip Chat Adapters UI Surfaces — v7\n\nDate: 2026-09-04  \nPaperclip base: \`${baseSha}\`  \nReview viewer: [\`index.html\`](./index.html)  \nWireframes: [\`wireframes-v7/\`](./wireframes-v7/)\n\n## Product decision\n\nOverview is removed. Activated connectors open on Settings and expose only four management tabs: Settings, Access, Conversations, and Activity. Settings contains only destination reach that a user can plausibly change.\n\n${defaults}\n\n## Settings inventory\n\n- Slack: allowed channels and an Allow direct messages toggle.\n- GitHub: allowed repositories only.\n- Microsoft Teams: allowed channels, Allow direct messages, and Allow group chats.\n- Telegram: allowed groups/topics and an Allow direct messages toggle.\n\n## Screen inventory\n\n| ID | Group | Surface | Title | Desktop | Mobile |\n|---|---|---|---|---|---|\n${inventory}\n\n## Annotation and action notes\n\n${details}\n`;
}

function viewerHtml() {
  const template = readFileSync(join(root, "../../../packages/skills-catalog/catalog/bundled/product/wireframe/assets/site-template.html"), "utf8");
  const style = template.match(/<style>[\s\S]*?<\/style>/)?.[0];
  if (!style) throw new Error("Could not load wireframe viewer styles");
  const toc = groups.map(([label, screens]) => `<h2>${esc(label)}</h2>${screens.map((screen) => `<a href="#s${screen.id}"><span class="num">${Number(screen.id)}</span>${esc(screen.title)}</a>`).join("\n")}`).join("\n");
  const sections = groups.map(([label, screens]) => `<div class="provider-break"><div class="lede">${esc(label)}</div><h2>${label === "Start" ? "Shared connection start" : label === "Paperclip" ? "Shared Paperclip surfaces" : `${esc(label)} connector`}</h2></div>${screens.map((screen) => {
    const notes = screen.annotations.map((note, index) => `<li><b>${index + 1}</b> — ${esc(note)}</li>`).join("\n");
    const actions = screen.actions ? `<h3>What the actions do</h3><ul>${screen.actions.map(([name, effect]) => `<li><b>${esc(name)}</b> — ${esc(effect)}</li>`).join("\n")}</ul>` : "";
    return `<section id="s${screen.id}"><div class="lede">${esc(screen.group)} · ${esc(screen.tab)}</div><h2><span class="step-num">${Number(screen.id)}.</span>${esc(screen.title)}</h2><p class="desc">${esc(screen.subtitle)}</p><div class="grid"><div class="wire" data-zoom data-caption="${screen.id} · ${esc(screen.title)} (desktop)"><div class="label"><span>${screen.id}-${screen.slug}.svg</span><span>${screen.desktopSize} · desktop</span></div><img src="wireframes-v7/${screen.id}-${screen.slug}.svg" alt="${esc(screen.title)} desktop wireframe" /></div><div class="wire mobile-wire mobile-col" data-zoom data-caption="${screen.id} · ${esc(screen.title)} (mobile)"><div class="label"><span>mobile</span><span>${screen.mobileSize}</span></div><img src="wireframes-v7/${screen.id}-${screen.slug}-mobile.svg" alt="${esc(screen.title)} mobile wireframe" /></div><div class="notes-col"><div class="notes"><h3>Annotations</h3><ul>${notes}</ul>${actions}<div class="why"><b>Rationale:</b> ${esc(screen.rationale)}</div></div></div></div></section>`;
  }).join("\n")}`).join("\n");
  const defaults = fixedBehavior.map(([name, behavior]) => `<li><b>${esc(name)}</b> — ${esc(behavior)}</li>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Paperclip chat adapters — configurable reach review</title>${style}<style>.doc-links{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:16px}.doc-links a{min-height:48px;display:inline-flex;align-items:center;font-size:13px;font-weight:600}.notice{max-width:var(--maxw);margin:-32px 0 48px;padding:14px 18px;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:4px}.notice p{margin:0}.decision{margin-top:24px;padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:8px}.decision b{display:block;margin-bottom:6px}.provider-break{max-width:var(--maxw);margin:80px 0 8px;padding-top:24px;border-top:2px solid var(--ink)}.provider-break h2{font-size:28px;margin:6px 0 0}.toc-body h2{margin-top:18px}code{font-size:.92em}</style></head><body><div class="shell"><details class="toc"><summary class="toc-summary"><span><span class="crumb">Chat adapters · v7</span><br><span class="title">Jump to a screen</span></span><span class="chevron" aria-hidden="true"></span></summary><nav class="toc-body" aria-label="Section navigation"><h1>Chat adapters</h1><div style="font-size:13px;color:var(--muted);margin-bottom:16px">Configurable reach review</div><h2>Documents</h2><a href="2026-09-03-chat-adapters-architecture.md"><span class="num">A</span>Architecture</a><a href="2026-09-04-chat-adapters-ui-surfaces-v7.md"><span class="num">U</span>UI specification v7</a><a href="2026-09-04-chat-adapters-minimum-setup-v6.md"><span class="num">M</span>Minimum setup</a><a href="2026-09-04-chat-adapters-platform-surfaces.md"><span class="num">P</span>Platform research</a><h2>Flow</h2><a href="#flow"><span class="num">⤳</span>Product flow</a>${toc}<h2>Review</h2><a href="#decisions"><span class="num">✓</span>Fixed product behavior</a></nav></details><main><header class="hero"><div class="crumb">Paperclip · Connectors · Settings v7</div><h1>Configure reach. Default everything else.</h1><p>The read-only Overview tab is gone. Settings contains only destinations and private-conversation toggles that an operator can plausibly change.</p><div class="decision"><b>Product rule</b><span>Task boundaries, delivery, credentials, installation drift, and provider capabilities are fixed behavior or conditional repair state—not settings.</span></div><div class="doc-links"><a href="2026-09-03-chat-adapters-architecture.md">Architecture plan</a><a href="2026-09-04-chat-adapters-ui-surfaces-v7.md">UI specification v7</a><a href="2026-09-04-chat-adapters-platform-surfaces.md">Platform decisions</a></div><div class="pills"><span class="pill">${orderedScreens.length} product surfaces</span><span class="pill">4 management tabs</span><span class="pill">Reach-only settings</span><span class="pill">Desktop + mobile</span></div></header><div class="notice" role="note"><p><b>Review convention:</b> red dashed marks are annotations, not proposed UI.</p></div><section id="flow" class="flow-section"><div class="lede">Navigation and product flow</div><h2>Setup, then reach-only management</h2><p class="desc">Activated connectors open on Settings. Diagnostics and conditional repairs live in Activity.</p><div class="wire" data-zoom data-caption="Chat connector product flow"><div class="label"><span>flow.svg</span><span>1280×880</span></div><img src="wireframes-v7/flow.svg" alt="Chat connector product flow"/></div></section>${sections}<section id="decisions"><div class="lede">Product decisions</div><h2>Behaviors removed from Settings</h2><div class="notes"><ul>${defaults}</ul></div></section><div class="footer">Generated with Paperclip’s wireframe contract. The current viewer contains no Overview page or non-configurable settings rows.</div></main></div><div class="lightbox" id="lb" aria-hidden="true"><span class="close" id="lbClose" role="button" aria-label="Close preview">×</span><img id="lbImg" alt=""/><div class="caption" id="lbCap"></div></div><script>const lb=document.getElementById('lb'),lbImg=document.getElementById('lbImg'),lbCap=document.getElementById('lbCap');document.querySelectorAll('[data-zoom]').forEach(el=>el.addEventListener('click',()=>{const target=el.querySelector('img');if(!target)return;lbImg.src=target.src;lbImg.alt=target.alt;lbCap.textContent=el.dataset.caption||target.alt||'';lb.classList.add('open');lb.setAttribute('aria-hidden','false')}));function closeLightbox(){lb.classList.remove('open');lb.setAttribute('aria-hidden','true')}lb.addEventListener('click',closeLightbox);document.getElementById('lbClose').addEventListener('click',closeLightbox);document.addEventListener('keydown',e=>{if(e.key==='Escape')closeLightbox()});const tocElement=document.querySelector('details.toc'),media=window.matchMedia('(max-width:900px)'),setToc=()=>{tocElement.open=!media.matches};setToc();media.addEventListener('change',setToc);tocElement.querySelectorAll('.toc-body a').forEach(link=>link.addEventListener('click',()=>{if(media.matches)tocElement.open=false}));</script></body></html>`;
}

writeFileSync(join(root, "2026-09-04-chat-adapters-ui-surfaces-v7.md"), `${uiDocument()}\n`);
writeFileSync(join(root, "index.html"), `${viewerHtml()}\n`);
console.log(`Generated ${orderedScreens.length * 2 + 1} v7 SVGs across ${orderedScreens.length} product surfaces.`);
