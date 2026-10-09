import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseSha, providers } from "./platform-wireframe-data-v4.mjs";
import { providerScreens as v3ProviderScreens } from "./platform-wireframe-data-v3.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const previous = join(root, "wireframes-v3");
const out = join(root, "wireframes-v4");
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

function wrap(value, width = 62, max = 3) {
  const words = String(value).split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
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

function multiline(x, y, lines, size = 12, fill = "#666", gap = 18, extra = "") {
  return lines.map((line, index) => tx(x, y + index * gap, line, size, fill, extra)).join("\n");
}

function button(x, y, w, label, primary = false) {
  return `${rc(x, y, w, 48, primary ? 'fill="#000"' : 'fill="#fff"')}${tx(x + w / 2, y + 30, label, 14, primary ? "#fff" : "#000", 'text-anchor="middle" font-weight="600"')}`;
}

function valueBox(x, y, w, value) {
  return `${rc(x, y, w, 48, 'fill="#fff"')}${tx(x + w / 2, y + 30, value, 12, "#000", 'text-anchor="middle" font-weight="600"')}`;
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
  const label = provider.name === "Microsoft Teams" ? "Teams" : provider.name;
  return `<g>${tx(264, 94, "‹  All connectors", 12, "#666")}${circle(280, 132, 18, 'fill="#e6e6e6"')}${tx(308, 138, `Maya on ${label}`, 14, "#000", 'font-weight="700"')}${items.map((item, index) => `${item === active ? rc(252, 168 + index * 48, 216, 40, 'fill="#e6e6e6"') : ""}${tx(280, 194 + index * 48, item, 14, item === active ? "#000" : "#666", item === active ? 'font-weight="600"' : "")}`).join("\n")}${ln(480, 60, 480, height)}</g>`;
}

function mobileHeader(label, active = null) {
  return `${rc(0, 0, 375, 56)}${tx(16, 35, `‹  ${label}`, 14, "#000", 'font-weight="600"')}${tx(359, 35, "Menu", 12, "#666", 'text-anchor="end"')}${active ? `${rc(16, 72, 343, 48, 'fill="#fff"')}${tx(32, 102, active, 14, "#000", 'font-weight="600"')}${tx(343, 102, "⌄", 14, "#666", 'text-anchor="end"')}` : ""}`;
}

function rowsHeight(sections, mobile = false) {
  const row = mobile ? 112 : 72;
  const section = mobile ? 84 : 78;
  return sections.reduce((sum, item) => sum + section + item.rows.length * row, 0);
}

function sectionsDesktop(sections, startY, regions) {
  let top = startY;
  const rendered = [];
  for (const section of sections) {
    const blockHeight = 78 + section.rows.length * 72;
    regions.push({ x: 496, y: top - 8, w: 736, h: blockHeight + 8 });
    rendered.push(tx(504, top + 22, section.title, 20, "#000", 'font-weight="700"'));
    rendered.push(multiline(504, top + 47, wrap(section.intro, 96, 2), 12, "#666", 16));
    rendered.push(ln(504, top + 70, 1224, top + 70));
    section.rows.forEach((row, index) => {
      const y = top + 70 + index * 72;
      if (index) rendered.push(ln(520, y, 1208, y, 'stroke="#e6e6e6"'));
      rendered.push(tx(520, y + 26, row[0], 14, "#000", 'font-weight="600"'));
      rendered.push(multiline(520, y + 48, wrap(row[1], 72, 2), 12, "#666", 16));
      rendered.push(valueBox(1032, y + 12, 176, row[2]));
    });
    top += blockHeight;
  }
  return rendered.join("\n");
}

function sectionsMobile(sections, startY, regions) {
  let top = startY;
  const rendered = [];
  for (const section of sections) {
    const blockHeight = 84 + section.rows.length * 112;
    regions.push({ x: 8, y: top - 8, w: 359, h: blockHeight + 8 });
    rendered.push(tx(16, top + 22, section.title, 20, "#000", 'font-weight="700"'));
    rendered.push(multiline(16, top + 48, wrap(section.intro, 47, 2), 12, "#666", 16));
    rendered.push(ln(16, top + 76, 359, top + 76));
    section.rows.forEach((row, index) => {
      const y = top + 76 + index * 112;
      if (index) rendered.push(ln(24, y, 351, y, 'stroke="#e6e6e6"'));
      rendered.push(tx(24, y + 24, row[0], 14, "#000", 'font-weight="600"'));
      rendered.push(multiline(24, y + 46, wrap(row[1], 43, 2), 12, "#666", 16));
      rendered.push(valueBox(223, y + 56, 128, row[2]));
    });
    top += blockHeight;
  }
  return rendered.join("\n");
}

function setupDesktop(screen) {
  const contentHeight = rowsHeight(screen.sections);
  const height = 200 + contentHeight + 96;
  const regions = [];
  const body = sectionsDesktop(screen.sections, 176, regions);
  return { width: 1280, height, svg: baseSvg(1280, height, `${globalSidebar(height)}${topbar(`CONNECTORS  ›  ${screen.provider.name}  ›  Chat with an agent`)}${tx(288, 108, screen.title, 28, "#000", 'font-weight="700"')}${tx(288, 138, screen.subtitle, 14, "#666")}${ln(264, 160, 1224, 160)}<g transform="translate(-216,0)">${body}${annotations(regions)}</g>${button(1008, height - 72, 216, `Activate ${screen.provider.short}`, true)}${tx(288, height - 42, "All provider-owned approvals and installation steps stay visible and resumable.", 12, "#666")}`) };
}

function setupMobile(screen) {
  const contentHeight = rowsHeight(screen.sections, true);
  const titleLines = wrap(screen.title.replace("Microsoft Teams", "Teams"), 34, 2);
  const subtitleLines = wrap(screen.subtitle, 48, 2);
  const subtitleY = 92 + titleLines.length * 24;
  const contentY = subtitleY + subtitleLines.length * 16 + 24;
  const height = contentY + contentHeight + 104;
  const regions = [];
  const body = sectionsMobile(screen.sections, contentY, regions);
  return { width: 375, height, svg: baseSvg(375, height, `${mobileHeader(screen.provider.short)}${multiline(16, 88, titleLines, 20, "#000", 24, 'font-weight="700"')}${multiline(16, subtitleY, subtitleLines, 12, "#666", 16)}${body}${button(16, height - 72, 343, `Activate ${screen.provider.short}`, true)}${annotations(regions, true)}`) };
}

function detailDesktop(screen) {
  const contentHeight = rowsHeight(screen.sections);
  const height = 200 + contentHeight + 96;
  const regions = [];
  const body = sectionsDesktop(screen.sections, 176, regions);
  return { width: 1280, height, svg: baseSvg(1280, height, `${globalSidebar(height)}${topbar(`CONNECTORS  ›  Maya on ${screen.provider.name}  ›  ${screen.tab}`)}${detailContext(screen.provider, screen.tab, height)}${tx(504, 108, screen.title, 28, "#000", 'font-weight="700"')}${tx(504, 138, screen.subtitle, 14, "#666")}${body}${screen.tab === "Settings" ? button(1048, height - 72, 176, "Save changes", true) : ""}${annotations(regions)}`) };
}

function detailMobile(screen) {
  const contentHeight = rowsHeight(screen.sections, true);
  const height = 208 + contentHeight + (screen.tab === "Settings" ? 96 : 40);
  const regions = [];
  const body = sectionsMobile(screen.sections, 200, regions);
  return { width: 375, height, svg: baseSvg(375, height, `${mobileHeader(`Maya on ${screen.provider.short}`, screen.tab)}${tx(16, 152, screen.title.replace("Microsoft Teams", "Teams"), 20, "#000", 'font-weight="700"')}${multiline(16, 176, wrap(screen.subtitle, 48, 2), 12, "#666", 16)}${body}${screen.tab === "Settings" ? button(16, height - 72, 343, "Save changes", true) : ""}${annotations(regions, true)}`) };
}

function conversationsDesktop(screen) {
  const height = 1160;
  const rows = screen.provider.conversationRows.map((row, index) => {
    const y = 318 + index * 112;
    return `${index ? ln(520, y, 1208, y, 'stroke="#e6e6e6"') : ""}${tx(520, y + 28, row[0], 14, "#000", 'font-weight="700"')}${tx(520, y + 54, row[1], 14, "#000")}${tx(520, y + 80, row[2], 12, "#666")}${button(1048, y + 24, 160, row[3])}`;
  }).join("\n");
  return { width: 1280, height, svg: baseSvg(1280, height, `${globalSidebar(height)}${topbar(`CONNECTORS  ›  Maya on ${screen.provider.name}  ›  Conversations`)}${detailContext(screen.provider, "Conversations", height)}${tx(504, 108, screen.title, 28, "#000", 'font-weight="700"')}${tx(504, 138, screen.subtitle, 14, "#666")}
    ${tx(504, 206, "Conversation boundary", 20, "#000", 'font-weight="700"')}${multiline(504, 234, wrap(screen.provider.conversationBoundary, 94, 2), 14, "#666", 20)}${ln(504, 278, 1224, 278)}
    ${tx(504, 310, "Live bindings", 20, "#000", 'font-weight="700"')}${rows}
    ${tx(504, 704, "Binding actions", 20, "#000", 'font-weight="700"')}${tx(504, 734, "Open either side at any time. Detach only after explicit confirmation.", 14, "#666")}${ln(504, 760, 1224, 760)}
    ${tx(520, 804, "Selected binding", 14, "#000", 'font-weight="700"')}${tx(520, 832, screen.provider.conversationRows[0][0], 12, "#666")}${button(520, 864, 176, "Open provider")}${button(712, 864, 176, "Open task")}${button(1032, 864, 176, "Detach")}
    ${tx(504, 984, "Detached conversations", 20, "#000", 'font-weight="700"')}${tx(504, 1014, "History and message links remain auditable. A later valid activation creates or claims a new binding.", 14, "#666")}
    ${annotations([{x:496,y:190,w:736,h:96},{x:496,y:294,w:736,h:362},{x:496,y:688,w:736,h:224},{x:496,y:968,w:736,h:72}])}`) };
}

function conversationsMobile(screen) {
  const height = 1600;
  const rows = screen.provider.conversationRows.map((row, index) => {
    const y = 412 + index * 190;
    return `${index ? ln(24, y, 351, y, 'stroke="#e6e6e6"') : ""}${tx(24, y + 28, row[0], 14, "#000", 'font-weight="700"')}${multiline(24, y + 54, wrap(row[1], 42, 2), 12, "#000", 16)}${tx(24, y + 92, row[2], 12, "#666")}${button(24, y + 116, 327, row[3])}`;
  }).join("\n");
  return { width: 375, height, svg: baseSvg(375, height, `${mobileHeader(`Maya on ${screen.provider.short}`, "Conversations")}${tx(16, 152, screen.title, 20, "#000", 'font-weight="700"')}${tx(16, 178, "External conversation ↔ Paperclip issue", 12, "#666")}
    ${tx(16, 230, "Conversation boundary", 20, "#000", 'font-weight="700"')}${multiline(16, 260, wrap(screen.provider.conversationBoundary, 46, 4), 12, "#666", 18)}${ln(16, 348, 359, 348)}
    ${tx(16, 390, "Live bindings", 20, "#000", 'font-weight="700"')}${rows}
    ${tx(16, 1012, "Binding actions", 20, "#000", 'font-weight="700"')}${multiline(16, 1042, ["Open either side at any time.", "Detach only after explicit confirmation."], 12, "#666", 18)}${button(16, 1100, 343, "Open selected task")}${button(16, 1164, 343, "Detach selected binding")}
    ${tx(16, 1260, "Detached conversations", 20, "#000", 'font-weight="700"')}${multiline(16, 1290, ["History and message links remain auditable.", "Later activation creates or claims a new binding."], 12, "#666", 18)}
    ${annotations([{x:8,y:214,w:359,h:142},{x:8,y:374,w:359,h:608},{x:8,y:996,w:359,h:236},{x:8,y:1244,w:359,h:96}], true)}`) };
}

function activityDesktop(screen) {
  const height = 1200;
  const health = screen.provider.activityHealth.map((item, index) => `${tx(520, 250 + index * 48, item, 14, index === 0 ? "#000" : "#666", index === 0 ? 'font-weight="700"' : "")}${tx(1208, 250 + index * 48, "●", 14, "#000", 'text-anchor="end"')}${ln(520, 266 + index * 48, 1208, 266 + index * 48, 'stroke="#e6e6e6"')}`).join("\n");
  const rows = screen.provider.activityRows.map((row, index) => {
    const y = 520 + index * 86;
    return `${index ? ln(520, y, 1208, y, 'stroke="#e6e6e6"') : ""}${tx(520, y + 28, row[0], 14, "#000", 'font-weight="700"')}${tx(720, y + 28, row[1], 12, "#666")}${tx(1208, y + 28, row[2], 12, "#000", 'text-anchor="end" font-weight="600"')}${tx(520, y + 56, `ID and payload details are redacted until opened by an authorized operator.`, 12, "#666")}`;
  }).join("\n");
  return { width: 1280, height, svg: baseSvg(1280, height, `${globalSidebar(height)}${topbar(`CONNECTORS  ›  Maya on ${screen.provider.name}  ›  Activity`)}${detailContext(screen.provider, "Activity", height)}${tx(504, 108, screen.title, 28, "#000", 'font-weight="700"')}${tx(504, 138, screen.subtitle, 14, "#666")}
    ${tx(504, 204, "Provider and delivery health", 20, "#000", 'font-weight="700"')}${tx(504, 228, "Current checks across the provider, credentials, ingress, and permission surface.", 12, "#666")}${ln(504, 272, 1224, 272)}${health}
    ${tx(504, 478, "Delivery ledger", 20, "#000", 'font-weight="700"')}${tx(504, 502, "Inbound events, callbacks, and outbound publications in chronological order.", 12, "#666")}${ln(504, 520, 1224, 520)}${rows}
    ${tx(504, 900, "Failure handling", 20, "#000", 'font-weight="700"')}${tx(504, 928, "Replay re-runs authorization and deduplication. Sensitive provider payload fields remain redacted.", 14, "#666")}${button(520, 970, 176, "Open redacted detail")}${button(712, 970, 176, "Replay failed")}
    ${tx(504, 1070, "Provider limits and drift", 20, "#000", 'font-weight="700"')}${tx(504, 1098, "Rate limits, permission changes, uninstall/revocation, and relay state create explicit ledger events.", 14, "#666")}
    ${annotations([{x:496,y:188,w:736,h:238},{x:496,y:462,w:736,h:374},{x:496,y:884,w:736,h:148},{x:496,y:1054,w:736,h:70}])}`) };
}

function activityMobile(screen) {
  const height = 1640;
  const health = screen.provider.activityHealth.map((item, index) => `${tx(24, 284 + index * 52, item, 14, index === 0 ? "#000" : "#666", index === 0 ? 'font-weight="700"' : "")}${tx(351, 284 + index * 52, "●", 14, "#000", 'text-anchor="end"')}${ln(24, 302 + index * 52, 351, 302 + index * 52, 'stroke="#e6e6e6"')}`).join("\n");
  const rows = screen.provider.activityRows.map((row, index) => {
    const y = 590 + index * 146;
    return `${index ? ln(24, y, 351, y, 'stroke="#e6e6e6"') : ""}${tx(24, y + 26, row[0], 14, "#000", 'font-weight="700"')}${multiline(24, y + 50, wrap(row[1], 44, 2), 12, "#666", 16)}${tx(24, y + 90, row[2], 12, "#000", 'font-weight="600"')}${tx(24, y + 116, "Details redacted until opened.", 12, "#666")}`;
  }).join("\n");
  return { width: 375, height, svg: baseSvg(375, height, `${mobileHeader(`Maya on ${screen.provider.short}`, "Activity")}${tx(16, 152, screen.title, 20, "#000", 'font-weight="700"')}${tx(16, 178, "Deliveries, publications, callbacks, and health", 12, "#666")}
    ${tx(16, 230, "Provider and delivery health", 20, "#000", 'font-weight="700"')}${health}
    ${tx(16, 528, "Delivery ledger", 20, "#000", 'font-weight="700"')}${tx(16, 554, "Newest first · durable and deduplicated", 12, "#666")}${rows}
    ${tx(16, 1208, "Failure handling", 20, "#000", 'font-weight="700"')}${multiline(16, 1238, ["Replay repeats permission and dedupe checks.", "Sensitive provider fields stay redacted."], 12, "#666", 18)}${button(16, 1296, 343, "Open selected detail")}${button(16, 1360, 343, "Replay selected failure")}
    ${tx(16, 1460, "Provider limits and drift", 20, "#000", 'font-weight="700"')}${multiline(16, 1490, ["Rate, permission, uninstall, revocation, and", "relay changes create explicit ledger events."], 12, "#666", 18)}
    ${annotations([{x:8,y:214,w:359,h:250},{x:8,y:512,w:359,h:650},{x:8,y:1192,w:359,h:232},{x:8,y:1444,w:359,h:92}], true)}`) };
}

function flowSvg() {
  const height = 980;
  const node = (x, y, w, title, sub, fill = false) => `${rc(x, y, w, 88, fill ? 'fill="#e6e6e6"' : 'fill="#fff"')}${tx(x + 16, y + 32, title, 14, "#000", 'font-weight="700"')}${tx(x + 16, y + 58, sub, 12, "#666")}`;
  const arrow = (x1, y1, x2, y2) => `${ln(x1, y1, x2, y2)}<polygon points="${x2},${y2} ${x2 - 9},${y2 - 6} ${x2 - 9},${y2 + 6}" fill="#000" stroke="none"/>`;
  return baseSvg(1280, height, `${tx(48, 48, "Chat connectors · complete provider detail flow", 28, "#000", 'font-weight="700"')}${tx(48, 76, "Shared discovery and agent choice lead to provider setup, then the same five-tab connector shell.", 14, "#666")}
    ${node(48,128,176,"Connectors","Choose provider",true)}${arrow(224,172,264,172)}${node(264,128,192,"Purpose?","Only if ambiguous")}${arrow(456,172,496,172)}${node(496,128,184,"Choose agent","Exactly one")}${arrow(680,172,720,172)}${node(720,128,216,"Provider setup","External handoff")}${arrow(936,172,976,172)}${node(976,128,208,"Activate","Create endpoint",true)}
    ${tx(48,300,"EVERY PROVIDER ENDPOINT",12,"#666",'font-weight="700"')}${node(48,326,176,"Overview","Health + features")}${node(240,326,176,"Settings","Scope + boundaries")}${node(432,326,176,"Access","Identity + authority")}${node(624,326,176,"Conversations","Native thread ↔ task")}${node(816,326,176,"Activity","Durable ledger")}
    ${tx(48,496,"PROVIDER GROUPS",12,"#666",'font-weight="700"')}${node(48,522,216,"Slack","App + native thread")}${node(280,522,216,"GitHub","App + existing object")}${node(512,522,216,"Microsoft Teams","Package + post thread")}${node(744,522,216,"Telegram","BotFather + active task")}
    ${tx(48,690,"CONVERSATION LIFECYCLE",12,"#666",'font-weight="700"')}${node(48,716,216,"Native activation","Mention / addressed")}${arrow(264,760,304,760)}${node(304,716,216,"Paperclip issue","One per binding",true)}${arrow(520,760,560,760)}${node(560,716,216,"Safe publication","Maximal capability")}${arrow(776,760,816,760)}${node(816,716,216,"Detach","Preserve history")}
    ${tx(48,872,"Overview reports available features; Settings contains only scope, boundary, access, and necessary provider operations.",14,"#666")}
    ${annotations([{x:40,y:120,w:1152,h:104},{x:40,y:318,w:960,h:104},{x:40,y:514,w:928,h:104},{x:40,y:708,w:1000,h:104}])}`);
}

const v3Spec = readFileSync(join(root, "2026-09-04-chat-adapters-ui-surfaces-v2.md"), "utf8");
const oldAnnotations = new Map(
  [...v3Spec.matchAll(/### (\d{2})[^\n]*\n\nPurpose:[^\n]*\n\n((?:\d+\.[^\n]*\n){4,5})/g)].map((match) => [
    match[1], match[2].trim().split("\n").map((line) => line.replace(/^\d+\.\s*/, ""))
  ])
);

const sharedScreens = [
  { id:"01", slug:"connectors-catalog", title:"Connectors", subtitle:"Connect tools and places where people talk to agents.", group:"Start", source:"01-connectors-catalog", rationale:"The existing Apps catalog remains the single entry point." },
  { id:"02", slug:"connection-purpose", title:"Connect GitHub", subtitle:"Choose chat or tool use only when a provider supports both.", group:"Start", source:"02-connection-purpose", rationale:"The purpose decision appears only when the provider is ambiguous." },
  { id:"03", slug:"choose-agent", title:"Which agent do you want to chat with?", subtitle:"Choose the one Paperclip agent represented by this bot.", group:"Start", source:"03-choose-agent", rationale:"This is the only shared Paperclip-specific setup decision." },
  { id:"11", slug:"bound-task", title:"Externally bound task", subtitle:"A normal Paperclip task with explicit publication and detach controls.", group:"Paperclip", source:"11-bound-task", rationale:"External work remains governed by the ordinary task experience." },
  { id:"12", slug:"agent-channels", title:"Agent Channels", subtitle:"See every provider identity representing this agent.", group:"Paperclip", source:"12-agent-channels", rationale:"Agent detail summarizes endpoints; Connectors continues to manage them." }
].map((screen) => ({ ...screen, annotations: oldAnnotations.get(screen.id), desktopSize:"1280×800", mobileSize:"375×812" }));

for (const screen of sharedScreens) {
  writeFileSync(join(out, `${screen.id}-${screen.slug}.svg`), readFileSync(join(previous, `${screen.source}.svg`), "utf8"));
  writeFileSync(join(out, `${screen.id}-${screen.slug}-mobile.svg`), readFileSync(join(previous, `${screen.source}-mobile.svg`), "utf8"));
}

const screenKinds = ["setup", "overview", "settings", "access", "conversations", "activity", "walkthrough"];
const providerScreens = [];

for (const provider of providers) {
  const v3Walkthrough = v3ProviderScreens.find((screen) => screen.id === provider.ids.walkthrough);
  const screens = {
    setup: { id:provider.ids.setup, slug:`${provider.slug}-setup`, title:provider.setupTitle, subtitle:provider.setupSubtitle, tab:"Setup", sections:provider.setupSections, annotations:provider.setupAnnotations, rationale:"Provider-owned setup is a resumable, top-to-bottom handoff rather than a dense card dashboard." },
    overview: { id:provider.ids.overview, slug:`${provider.slug}-overview`, title:`${provider.name} overview`, subtitle:"Identity, installation health, automatic capabilities, and connector lifecycle.", tab:"Overview", sections:provider.overviewSections, annotations:provider.overviewAnnotations, rationale:"Overview reports everything this connection can do automatically without turning capabilities into settings." },
    settings: { id:provider.ids.settings, slug:`${provider.slug}-settings`, title:`${provider.name} settings`, subtitle:"Only scope, task boundaries, access, and necessary provider operations.", tab:"Settings", sections:provider.settingsSections, annotations:provider.settingsAnnotations, rationale:"Settings contains genuine operator decisions and repair actions; provider capabilities are automatic and live on Overview." },
    access: { id:provider.ids.access, slug:`${provider.slug}-access`, title:`${provider.name} access`, subtitle:"External identities, linked Paperclip users, sponsored guests, and effective authority.", tab:"Access", sections:provider.accessSections, annotations:provider.accessAnnotations, rationale:"The shared permission model is made concrete with provider-specific stable identity keys and edge cases." },
    conversations: { id:provider.ids.conversations, slug:`${provider.slug}-conversations`, title:`${provider.name} conversations`, subtitle:"Inspect native conversation-to-Paperclip issue bindings.", tab:"Conversations", annotations:provider.conversationAnnotations, rationale:"Operators can see and manage the exact native boundary used for each durable task binding." },
    activity: { id:provider.ids.activity, slug:`${provider.slug}-activity`, title:`${provider.name} activity`, subtitle:"Inspect provider health, deliveries, callbacks, publications, and retries.", tab:"Activity", annotations:provider.activityAnnotations, rationale:"The durable ledger is shared in concept but includes the diagnostics and lifecycle states of this provider." },
    walkthrough: { ...v3Walkthrough, slug:`${provider.slug}-interactions`, tab:"Conversation walkthrough", rationale:"The walkthrough demonstrates the automatic maximal capability policy in the provider-native medium." }
  };
  for (const kind of screenKinds) providerScreens.push({ ...screens[kind], kind, group:provider.name, provider });
}

for (const screen of providerScreens) {
  let desktop;
  let mobile;
  if (screen.kind === "walkthrough") {
    writeFileSync(join(out, `${screen.id}-${screen.slug}.svg`), readFileSync(join(previous, `${screen.id}-${screen.slug}.svg`), "utf8"));
    writeFileSync(join(out, `${screen.id}-${screen.slug}-mobile.svg`), readFileSync(join(previous, `${screen.id}-${screen.slug}-mobile.svg`), "utf8"));
    screen.desktopSize = "1280×960";
    screen.mobileSize = "375×1320";
    continue;
  }
  if (screen.kind === "setup") {
    desktop = setupDesktop(screen);
    mobile = setupMobile(screen);
  } else if (screen.kind === "conversations") {
    desktop = conversationsDesktop(screen);
    mobile = conversationsMobile(screen);
  } else if (screen.kind === "activity") {
    desktop = activityDesktop(screen);
    mobile = activityMobile(screen);
  } else {
    desktop = detailDesktop(screen);
    mobile = detailMobile(screen);
  }
  writeFileSync(join(out, `${screen.id}-${screen.slug}.svg`), `${desktop.svg}\n`);
  writeFileSync(join(out, `${screen.id}-${screen.slug}-mobile.svg`), `${mobile.svg}\n`);
  screen.desktopSize = `${desktop.width}×${desktop.height}`;
  screen.mobileSize = `${mobile.width}×${mobile.height}`;
}

writeFileSync(join(out, "flow.svg"), `${flowSvg()}\n`);

const groups = [
  ["Start", sharedScreens.filter((screen) => screen.group === "Start")],
  ...providers.map((provider) => [provider.name, providerScreens.filter((screen) => screen.provider === provider)]),
  ["Paperclip", sharedScreens.filter((screen) => screen.group === "Paperclip")]
];
const orderedScreens = groups.flatMap(([, screens]) => screens);

function uiDoc() {
  const inventory = orderedScreens.map((screen) => `| ${screen.id} | ${screen.group} | ${screen.title} | ${screen.desktopSize} | ${screen.mobileSize} |`).join("\n");
  const details = orderedScreens.map((screen) => `### ${screen.id} · ${screen.title}\n\nPurpose: ${screen.subtitle}\n\n${screen.annotations.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\nRationale: ${screen.rationale}`).join("\n\n");
  return `# Paperclip Chat Adapters UI Surfaces — v4\n\nDate: 2026-09-04  \nPaperclip base: \`${baseSha}\`  \nReview viewer: [\`index.html\`](./index.html)  \nWireframes: [\`wireframes-v4/\`](./wireframes-v4/)\n\n## Product rules represented\n\n- \`/apps\` remains the Connectors catalog. A purpose choice appears only for platforms such as GitHub that can be both a chat medium and an agent tool.\n- Chat setup asks for the agent first, then performs a provider-owned installation handoff with reasonable defaults.\n- Each provider endpoint has the complete existing-style detail shell: Overview, Settings, Access, Conversations, and Activity.\n- Setup and settings use ordinary top-to-bottom sections. Desktop canvases grow to fit their content; the pages are not compressed into an 800px dashboard or bento grid.\n- Provider capabilities are implementation guarantees, not endpoint preferences. Paperclip automatically uses the maximum safe set available to that adapter, provider installation, conversation type, and current Paperclip permission check.\n- Settings therefore contain only genuine choices: scope, task boundaries, delivery/deployment, credentials, and explicit provider permission grants. Reactions, streaming, rich messages/cards, actions, modals, commands, files, edits, and private fallbacks are never shown as on/off settings.\n- Overview reports the capability set as **Available automatically**. Conversation walkthroughs demonstrate it in the provider's native medium.\n- Red dashed marks and numbers are review annotations, not proposed UI.\n\n## Complete tab coverage\n\nEvery provider group contains Setup, Overview, Settings, Access, Conversations, Activity, and a behavior walkthrough. The five tab names shown in the endpoint sidebar each have a provider-specific desktop and mobile wireframe. Shared generic Overview/Access/Conversations/Activity mockups are removed from the current viewer so they cannot be mistaken for the provider-specific designs.\n\n## Inventory\n\n| ID | Group | Surface | Desktop | Mobile |\n|---|---|---|---|---|\n${inventory}\n\n## Annotation notes\n\n${details}\n\n## Verification intent\n\n- Desktop SVGs use 1280px width and whatever height their ordinary vertical content requires.\n- Mobile SVGs use 375px width, minimum 48px controls, and enough height to avoid clipping.\n- The house palette remains white, black, \`#e6e6e6\`, \`#666\`, and annotation-only \`#d33\`, with 1.5px black strokes and 12/14/20/28px type.\n- Secrets appear only as masked references. No provider feature toggle can disable a safe supported capability.\n`;
}

function viewerHtml() {
  const template = readFileSync(join(root, "../../../packages/skills-catalog/catalog/bundled/product/wireframe/assets/site-template.html"), "utf8");
  const style = template.match(/<style>[\s\S]*?<\/style>/)?.[0];
  if (!style) throw new Error("Could not load wireframe viewer styles");
  const toc = groups.map(([label, screens]) => `<h2>${esc(label)}</h2>${screens.map((screen) => `<a href="#s${screen.id}"><span class="num">${Number(screen.id)}</span>${esc(screen.title)}</a>`).join("\n")}`).join("\n");
  const sections = groups.map(([label, screens]) => `<div class="provider-break"><div class="lede">${esc(label)}</div><h2>${label === "Start" ? "Shared connection start" : label === "Paperclip" ? "Shared Paperclip surfaces" : `${esc(label)} connector`}</h2></div>${screens.map((screen) => {
    const notes = screen.annotations.map((note, index) => `<li><b>${index + 1}</b> — ${esc(note).replaceAll("**", "")}</li>`).join("\n");
    return `<section id="s${screen.id}"><div class="lede">${esc(screen.group)} · ${esc(screen.tab || "Shared")}</div><h2><span class="step-num">${Number(screen.id)}.</span>${esc(screen.title)}</h2><p class="desc">${esc(screen.subtitle)}</p><div class="grid"><div class="wire" data-zoom data-caption="${screen.id} · ${esc(screen.title)} (desktop)"><div class="label"><span>${screen.id}-${screen.slug}.svg</span><span>${screen.desktopSize} · desktop</span></div><img src="wireframes-v4/${screen.id}-${screen.slug}.svg" alt="${esc(screen.title)} desktop wireframe" /></div><div class="wire mobile-wire mobile-col" data-zoom data-caption="${screen.id} · ${esc(screen.title)} (mobile)"><div class="label"><span>mobile</span><span>${screen.mobileSize}</span></div><img src="wireframes-v4/${screen.id}-${screen.slug}-mobile.svg" alt="${esc(screen.title)} mobile wireframe" /></div><div class="notes-col"><div class="notes"><h3>Annotations</h3><ul>${notes}</ul><div class="why"><b>Rationale:</b> ${esc(screen.rationale)}</div></div></div></div></section>`;
  }).join("\n")}`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Paperclip chat adapters — complete provider review</title>${style}<style>.doc-links{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:16px}.doc-links a{min-height:48px;display:inline-flex;align-items:center;font-size:13px;font-weight:600}.notice{max-width:var(--maxw);margin:-32px 0 48px;padding:14px 18px;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:4px}.notice p{margin:0}.decision{margin-top:24px;padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:8px}.decision b{display:block;margin-bottom:6px}.provider-break{max-width:var(--maxw);margin:80px 0 8px;padding-top:24px;border-top:2px solid var(--ink)}.provider-break h2{font-size:28px;margin:6px 0 0}.toc-body h2{margin-top:18px}code{font-size:.92em}</style></head><body><div class="shell"><details class="toc"><summary class="toc-summary"><span><span class="crumb">Chat adapters · v4</span><br><span class="title">Jump to a screen</span></span><span class="chevron" aria-hidden="true"></span></summary><nav class="toc-body" aria-label="Section navigation"><h1>Chat adapters</h1><div style="font-size:13px;color:var(--muted);margin-bottom:16px">Complete provider review</div><h2>Documents</h2><a href="2026-09-03-chat-adapters-architecture.md"><span class="num">A</span>Architecture</a><a href="2026-09-04-chat-adapters-ui-surfaces-v4.md"><span class="num">U</span>UI specification v4</a><a href="2026-09-04-chat-adapters-platform-surfaces.md"><span class="num">P</span>Platform research</a><h2>Flow</h2><a href="#flow"><span class="num">⤳</span>Product flow</a>${toc}<h2>Review</h2><a href="#coverage"><span class="num">✓</span>Decisions and coverage</a></nav></details><main><header class="hero"><div class="crumb">Paperclip · Connectors · Complete v4</div><h1>Every provider. Every endpoint tab.</h1><p>Slack, GitHub, Microsoft Teams, and Telegram each have a conventional vertical setup plus provider-specific Overview, Settings, Access, Conversations, and Activity pages. Capabilities are automatic implementation behavior, not switches.</p><div class="decision"><b>Maximum safe capability is the invariant</b><span>Paperclip always uses every safe feature supported by the adapter, provider installation, current conversation type, and current Paperclip permission check. Settings contain only genuine operator choices.</span></div><div class="doc-links"><a href="2026-09-03-chat-adapters-architecture.md">Architecture plan</a><a href="2026-09-04-chat-adapters-ui-surfaces-v4.md">UI specification v4</a><a href="2026-09-04-chat-adapters-platform-surfaces.md">Platform-specific research</a></div><div class="pills"><span class="pill">33 product surfaces</span><span class="pill">5 tabs × 4 providers</span><span class="pill">Tall vertical pages</span><span class="pill">Desktop + mobile</span></div></header><div class="notice" role="note"><p><b>Review convention:</b> red dashed marks are annotations, not proposed UI. Feature lists on Overview are informational; they are not settings.</p></div><section id="flow" class="flow-section"><div class="lede">Navigation and product flow</div><h2>Shared start, provider setup, complete detail shell</h2><p class="desc">Every activated endpoint lands in the same five-tab shell. The content is provider-specific because installation, identity, native thread boundaries, and diagnostics differ.</p><div class="wire" data-zoom data-caption="Complete chat connector product flow"><div class="label"><span>flow.svg</span><span>1280×980</span></div><img src="wireframes-v4/flow.svg" alt="Complete chat connector product flow"/></div></section>${sections}<section id="coverage"><div class="lede">Review</div><h2>What changed in v4</h2><div class="notes"><ul><li><b>No bento setup pages:</b> screens 13, 16, 19, and 22 are now long, conventional, top-to-bottom installation flows.</li><li><b>No feature toggles:</b> reactions, streaming, rich content, actions, modals, commands, files, edits, and private fallbacks are automatic whenever safely available.</li><li><b>Complete endpoint shells:</b> every provider has an Overview, Settings, Access, Conversations, and Activity wireframe for desktop and mobile.</li><li><b>Provider specificity:</b> installation, identity keys, task boundaries, permission grants, activity ledgers, and fallbacks reflect the actual platform.</li><li><b>Stable original anchors:</b> IDs 13–24 still refer to the same provider setup/settings/walkthrough topics; new tabs use IDs 25–40.</li><li><b>Paperclip base:</b> <code>${baseSha}</code>, matching <code>origin/master</code> when generated.</li></ul></div></section><div class="footer">Generated with Paperclip’s wireframe contract. Page height follows content; no provider setup or settings page is forced into an 800px dashboard.</div></main></div><div class="lightbox" id="lb" aria-hidden="true"><span class="close" id="lbClose" role="button" aria-label="Close preview">×</span><img id="lbImg" alt=""/><div class="caption" id="lbCap"></div></div><script>const lb=document.getElementById('lb'),lbImg=document.getElementById('lbImg'),lbCap=document.getElementById('lbCap');document.querySelectorAll('[data-zoom]').forEach(el=>el.addEventListener('click',()=>{const target=el.querySelector('img');if(!target)return;lbImg.src=target.src;lbImg.alt=target.alt;lbCap.textContent=el.dataset.caption||target.alt||'';lb.classList.add('open');lb.setAttribute('aria-hidden','false')}));function closeLightbox(){lb.classList.remove('open');lb.setAttribute('aria-hidden','true')}lb.addEventListener('click',closeLightbox);document.getElementById('lbClose').addEventListener('click',closeLightbox);document.addEventListener('keydown',e=>{if(e.key==='Escape')closeLightbox()});const tocElement=document.querySelector('details.toc'),media=window.matchMedia('(max-width:900px)'),setToc=()=>{tocElement.open=!media.matches};setToc();media.addEventListener('change',setToc);tocElement.querySelectorAll('.toc-body a').forEach(link=>link.addEventListener('click',()=>{if(media.matches)tocElement.open=false}));</script></body></html>`;
}

writeFileSync(join(root, "2026-09-04-chat-adapters-ui-surfaces-v4.md"), `${uiDoc()}\n`);
writeFileSync(join(root, "index.html"), `${viewerHtml()}\n`);
console.log(`Generated ${orderedScreens.length * 2 + 1} v4 SVGs, UI specification, and index.html`);
