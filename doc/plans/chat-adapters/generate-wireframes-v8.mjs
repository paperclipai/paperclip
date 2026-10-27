import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { baseSha, providers } from "./platform-wireframe-data-v4.mjs";
import { setupFlows } from "./setup-wireframe-data-v8.mjs";
import {
  permissionModel,
  providerManagement,
} from "./management-wireframe-data-v8.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const previous = join(root, "wireframes-v7");
const out = join(root, "wireframes-v8");
mkdirSync(out, { recursive: true });

const esc = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const tx = (x, y, value, size = 14, fill = "#000", extra = "") =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" stroke="none" ${extra}>${esc(value)}</text>`;
const ln = (x1, y1, x2, y2, extra = "") =>
  `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${extra}/>`;
const rc = (x, y, w, h, extra = "") =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" ${extra}/>`;
const circle = (x, y, r, extra = "") =>
  `<circle cx="${x}" cy="${y}" r="${r}" ${extra}/>`;

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

function multiline(
  x,
  y,
  lines,
  size = 12,
  fill = "#666",
  gap = 16,
  extra = "",
) {
  return lines
    .map((line, index) => tx(x, y + index * gap, line, size, fill, extra))
    .join("\n");
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

function setupRail(screen, height) {
  const startY = 152;
  const gap = 80;
  return `${tx(264, 104, "SETUP", 12, "#666", 'font-weight="700"')}${ln(288, startY, 288, startY + gap * (screen.rail.length - 1))}${screen.rail
    .map((label, index) => {
      const y = startY + index * gap;
      const completed = index < screen.active;
      const active = index === screen.active;
      return `${circle(288, y, 16, completed ? 'fill="#000"' : 'fill="#fff"')}${tx(288, y + 5, completed ? "✓" : index + 1, 14, completed ? "#fff" : "#000", 'text-anchor="middle" font-weight="700"')}${tx(320, y - 4, label, 14, active ? "#000" : completed ? "#000" : "#666", active ? 'font-weight="700"' : "")}`;
    })
    .join("\n")}${ln(520, 64, 520, height)}`;
}

function githubSetupDesktop(screen) {
  const body = [
    tx(560, 112, screen.title, 28, "#000", 'font-weight="700"'),
    tx(560, 144, screen.subtitle, 14, "#666"),
    tx(560, 192, "Do this", 20, "#000", 'font-weight="700"'),
  ];
  let y = 232;
  for (const [index, [title, detail]] of screen.instructions.entries()) {
    body.push(circle(584, y + 16, 16, 'fill="#fff"'));
    body.push(
      tx(
        584,
        y + 21,
        index + 1,
        14,
        "#000",
        'text-anchor="middle" font-weight="700"',
      ),
    );
    body.push(tx(616, y + 12, title, 14, "#000", 'font-weight="600"'));
    body.push(multiline(616, y + 36, wrap(detail, 82, 2), 12, "#666", 16));
    y += 88;
    body.push(ln(616, y - 8, 1224, y - 8, 'stroke="#e6e6e6"'));
  }
  for (const [label, value] of screen.values ?? []) {
    body.push(tx(560, y + 16, label, 12, "#666", 'font-weight="600"'));
    body.push(tx(760, y + 16, value, 12, "#000"));
    y += 40;
  }
  for (const [label, placeholder] of screen.fields ?? []) {
    body.push(tx(560, y + 20, label, 12, "#000", 'font-weight="600"'));
    body.push(rc(760, y, 464, 40, 'fill="#fff"'));
    body.push(tx(776, y + 25, placeholder, 12, "#666"));
    y += 56;
  }
  const actions = screen.actions ?? [];
  const buttonGap = 12;
  const buttonWidth = Math.floor(
    (664 - buttonGap * Math.max(0, actions.length - 1)) /
      Math.max(1, actions.length),
  );
  actions.forEach(([label], index) => {
    body.push(
      button(
        560 + index * (buttonWidth + buttonGap),
        y + 16,
        buttonWidth,
        label,
        index === actions.length - 1,
      ),
    );
  });
  const height = Math.max(800, y + 144);
  const topbar = `${ln(240, 64, 1280, 64)}${tx(264, 40, "CONNECTORS  ›  GitHub  ›  Chat with an agent", 14, "#666")}${circle(1240, 32, 16, 'fill="#e6e6e6"')}`;
  return {
    width: 1280,
    height,
    svg: baseSvg(
      1280,
      height,
      `${globalSidebar(height)}<g data-region="topbar">${topbar}</g>${setupRail(screen, height)}${body.join("\n")}${annotations(
        [
          { x: 256, y: 88, w: 248, h: Math.min(height - 112, 360) },
          { x: 552, y: 160, w: 680, h: y - 144 },
          { x: 552, y, w: 680, h: 80 },
        ],
      )}`,
    ),
  };
}

function githubSetupMobile(screen) {
  const body = [
    rc(0, 0, 375, 56),
    tx(16, 32, "‹  GitHub setup", 14, "#000", 'font-weight="600"'),
    tx(16, 88, screen.title, 20, "#000", 'font-weight="700"'),
    multiline(16, 116, wrap(screen.subtitle, 46, 3), 12, "#666", 16),
  ];
  let y = 176;
  screen.rail.forEach((label, index) => {
    const completed = index < screen.active;
    const active = index === screen.active;
    body.push(circle(32, y, 14, completed ? 'fill="#000"' : 'fill="#fff"'));
    body.push(
      tx(
        32,
        y + 5,
        completed ? "✓" : index + 1,
        12,
        completed ? "#fff" : "#000",
        'text-anchor="middle" font-weight="700"',
      ),
    );
    body.push(
      tx(
        56,
        y + 5,
        label,
        12,
        active ? "#000" : completed ? "#000" : "#666",
        active ? 'font-weight="700"' : "",
      ),
    );
    y += 40;
  });
  body.push(tx(16, y + 24, "Do this", 20, "#000", 'font-weight="700"'));
  y += 64;
  for (const [index, [title, detail]] of screen.instructions.entries()) {
    body.push(circle(32, y, 14, 'fill="#fff"'));
    body.push(
      tx(
        32,
        y + 5,
        index + 1,
        12,
        "#000",
        'text-anchor="middle" font-weight="700"',
      ),
    );
    body.push(tx(56, y - 4, title, 12, "#000", 'font-weight="600"'));
    const detailLines = wrap(detail, 42, 4);
    body.push(multiline(56, y + 16, detailLines, 12, "#666", 16));
    y += 48 + detailLines.length * 16;
    body.push(ln(56, y - 12, 359, y - 12, 'stroke="#e6e6e6"'));
  }
  for (const [label, value] of screen.values ?? []) {
    body.push(tx(16, y, label, 12, "#000", 'font-weight="600"'));
    body.push(multiline(16, y + 20, wrap(value, 46, 2), 12, "#666", 16));
    y += 64;
  }
  for (const [label, placeholder] of screen.fields ?? []) {
    body.push(tx(16, y, label, 12, "#000", 'font-weight="600"'));
    body.push(rc(16, y + 12, 343, 40, 'fill="#fff"'));
    body.push(tx(32, y + 37, placeholder, 12, "#666"));
    y += 72;
  }
  for (const [label] of screen.actions ?? []) {
    body.push(button(16, y, 343, label, label === "Connect and verify"));
    y += 64;
  }
  const height = Math.max(812, y + 40);
  return {
    width: 375,
    height,
    svg: baseSvg(
      375,
      height,
      `${body.join("\n")}${annotations(
        [
          { x: 8, y: 64, w: 359, h: 224 },
          { x: 8, y: 288, w: 359, h: Math.max(160, height - 392) },
        ],
        true,
      )}`,
    ),
  };
}

function globalSidebar(height) {
  const items = [
    "New Task",
    "Search",
    "Dashboard",
    "Inbox",
    "Tasks",
    "Projects",
    "Routines",
    "Artifacts",
    "Agents",
    "Skills",
    "Connectors",
    "Audit",
  ];
  return `<g data-region="global-sidebar">${tx(24, 40, "Paperclip", 20, "#000", 'font-weight="700"')}${items
    .map((item, index) => {
      const y = 80 + index * 48;
      return `${item === "Connectors" ? rc(8, y - 24, 224, 40, 'fill="#e6e6e6"') : ""}${circle(32, y - 8, 6, 'fill="#e6e6e6"')}${tx(56, y, item, 14, item === "Connectors" ? "#000" : "#666", item === "Connectors" ? 'font-weight="600"' : "")}`;
    })
    .join(
      "\n",
    )}${tx(24, height - 56, "Acme Company", 14, "#000", 'font-weight="600"')}${tx(24, height - 32, "Dana · Admin", 12, "#666")}${ln(240, 0, 240, height)}</g>`;
}

function topbar(provider, tab) {
  return `<g data-region="topbar">${ln(240, 64, 1280, 64)}${tx(264, 40, `CONNECTORS  ›  Maya on ${provider}  ›  ${tab}`, 14, "#666")}${circle(1240, 32, 16, 'fill="#e6e6e6"')}</g>`;
}

function endpointNav(provider, active, height) {
  const tabs = ["Settings", "Access", "Conversations", "Activity"];
  return `<g data-region="connector-navigation">${tx(264, 96, "‹  All connectors", 12, "#666")}${circle(280, 136, 16, 'fill="#e6e6e6"')}${tx(312, 144, `Maya on ${provider}`, 14, "#000", 'font-weight="700"')}${tabs
    .map((tab, index) => {
      const y = 192 + index * 48;
      return `${tab === active ? rc(256, y - 24, 208, 40, 'fill="#e6e6e6"') : ""}${tx(280, y, tab, 14, tab === active ? "#000" : "#666", tab === active ? 'font-weight="600"' : "")}`;
    })
    .join("\n")}${ln(480, 64, 480, height)}</g>`;
}

function mobileHeader(provider, active) {
  return `${rc(0, 0, 375, 56)}${tx(16, 32, `‹  Maya on ${provider}`, 14, "#000", 'font-weight="600"')}${tx(359, 32, "Menu", 12, "#666", 'text-anchor="end"')}${rc(16, 72, 343, 48, 'fill="#fff"')}${tx(32, 104, active, 14, "#000", 'font-weight="600"')}${tx(343, 104, "⌄", 14, "#666", 'text-anchor="end"')}`;
}

function settingsDesktop(data, provider) {
  const hasToggles = data.conversationToggles.length > 0;
  const height = hasToggles
    ? 984 + Math.max(0, data.conversationToggles.length - 1) * 80
    : 816;
  const body = [
    tx(512, 112, data.settingsTitle, 28, "#000", 'font-weight="700"'),
    tx(512, 144, data.settingsSubtitle, 14, "#666"),
    tx(512, 208, data.resourcesTitle, 20, "#000", 'font-weight="700"'),
    tx(512, 236, data.resourcesIntro, 12, "#666"),
    ln(512, 264, 1224, 264),
  ];
  data.resources.forEach(([label, detail, on], index) => {
    const y = 280 + index * 80;
    if (index) body.push(ln(528, y, 1208, y, 'stroke="#e6e6e6"'));
    body.push(tx(528, y + 28, label, 14, "#000", 'font-weight="600"'));
    body.push(tx(528, y + 52, detail, 12, "#666"));
    body.push(toggle(1160, y + 28, on));
  });
  const actionY = 304 + data.resources.length * 80;
  body.push(button(904, actionY, 320, data.providerAction));
  body.push(tx(904, actionY + 72, data.providerActionHelp, 12, "#666"));
  const regions = [
    { x: 504, y: 192, w: 728, h: 96 + data.resources.length * 80 },
    { x: 1144, y: 288, w: 80, h: data.resources.length * 80 - 16 },
    { x: 888, y: actionY - 16, w: 344, h: 104 },
  ];
  let saveY = actionY + 128;
  if (hasToggles) {
    const top = actionY + 136;
    body.push(
      tx(
        512,
        top + 24,
        "Private conversations",
        20,
        "#000",
        'font-weight="700"',
      ),
    );
    body.push(ln(512, top + 56, 1224, top + 56));
    data.conversationToggles.forEach(([label, detail, on], index) => {
      const y = top + 72 + index * 80;
      if (index) body.push(ln(528, y, 1208, y, 'stroke="#e6e6e6"'));
      body.push(tx(528, y + 24, label, 14, "#000", 'font-weight="600"'));
      body.push(tx(528, y + 48, detail, 12, "#666"));
      body.push(toggle(1160, y + 24, on));
    });
    regions.push({
      x: 504,
      y: top + 8,
      w: 728,
      h: 64 + data.conversationToggles.length * 80,
    });
    saveY = top + 96 + data.conversationToggles.length * 80;
  }
  body.push(button(1016, saveY, 208, "Save changes", true));
  return {
    width: 1280,
    height,
    svg: baseSvg(
      1280,
      height,
      `${globalSidebar(height)}${topbar(provider, "Settings")}${endpointNav(provider, "Settings", height)}${body.join("\n")}${annotations(regions)}`,
    ),
  };
}

function settingsMobile(data) {
  const body = [
    mobileHeader(data.short, "Settings"),
    tx(16, 160, data.settingsTitle, 20, "#000", 'font-weight="700"'),
    multiline(16, 190, wrap(data.settingsSubtitle, 46, 3), 12, "#666", 16),
    tx(16, 256, data.resourcesTitle, 20, "#000", 'font-weight="700"'),
    multiline(16, 286, wrap(data.resourcesIntro, 46, 3), 12, "#666", 16),
    ln(16, 336, 359, 336),
  ];
  let y = 352;
  data.resources.forEach(([label, detail, on], index) => {
    if (index) body.push(ln(24, y, 351, y, 'stroke="#e6e6e6"'));
    body.push(tx(24, y + 28, label, 14, "#000", 'font-weight="600"'));
    body.push(multiline(24, y + 52, wrap(detail, 34, 2), 12, "#666", 16));
    body.push(toggle(303, y + 28, on, true));
    y += 96;
  });
  const resourceEnd = y;
  body.push(button(16, y + 16, 343, data.providerAction));
  body.push(
    multiline(16, y + 84, wrap(data.providerActionHelp, 46, 3), 12, "#666", 16),
  );
  const actionEnd = y + 132;
  y += 152;
  const regions = [
    { x: 8, y: 248, w: 359, h: resourceEnd - 240 },
    { x: 287, y: 344, w: 80, h: resourceEnd - 336 },
    { x: 8, y: resourceEnd + 8, w: 359, h: actionEnd - resourceEnd },
  ];
  if (data.conversationToggles.length) {
    const top = y;
    body.push(
      tx(
        16,
        top + 24,
        "Private conversations",
        20,
        "#000",
        'font-weight="700"',
      ),
    );
    body.push(ln(16, top + 56, 359, top + 56));
    y = top + 72;
    data.conversationToggles.forEach(([label, detail, on], index) => {
      if (index) body.push(ln(24, y, 351, y, 'stroke="#e6e6e6"'));
      body.push(tx(24, y + 24, label, 14, "#000", 'font-weight="600"'));
      body.push(multiline(24, y + 48, wrap(detail, 40, 3), 12, "#666", 16));
      body.push(toggle(303, y + 24, on, true));
      y += 104;
    });
    regions.push({ x: 8, y: top + 8, w: 359, h: y - top });
  }
  body.push(button(16, y + 24, 343, "Save changes", true));
  const height = Math.max(812, y + 104);
  body.push(annotations(regions, true));
  return { width: 375, height, svg: baseSvg(375, height, body.join("\n")) };
}

function accessDesktop(data, provider) {
  const height = 880;
  const body = [
    tx(512, 112, data.accessTitle, 28, "#000", 'font-weight="700"'),
    tx(512, 144, data.accessSubtitle, 14, "#666"),
    tx(512, 208, "Unlinked people", 20, "#000", 'font-weight="700"'),
    ln(512, 240, 1224, 240),
    tx(528, 280, data.unlinkedLabel, 14, "#000", 'font-weight="600"'),
    multiline(528, 306, wrap(data.unlinkedDetail, 80, 2), 12, "#666", 18),
    toggle(1160, 280, true),
    tx(528, 376, "Restricted access", 14, "#000", 'font-weight="600"'),
    tx(
      528,
      402,
      "Can message enabled conversations and attach safe files. Cannot approve or administer Paperclip.",
      12,
      "#666",
    ),
    tx(512, 488, "Linked accounts", 20, "#000", 'font-weight="700"'),
    tx(
      512,
      516,
      "Linked people use their current Paperclip permissions.",
      12,
      "#666",
    ),
    ln(512, 544, 1224, 544),
  ];
  data.linked.forEach(([external, paperclip, action], index) => {
    const y = 560 + index * 80;
    if (index) body.push(ln(528, y, 1208, y, 'stroke="#e6e6e6"'));
    body.push(tx(528, y + 28, external, 14, "#000", 'font-weight="600"'));
    body.push(tx(528, y + 52, paperclip, 12, "#666"));
    body.push(button(1096, y + 16, 112, action));
  });
  const actionY = 584 + data.linked.length * 80;
  body.push(button(1016, actionY, 208, "Link account", true));
  return {
    width: 1280,
    height,
    svg: baseSvg(
      1280,
      height,
      `${globalSidebar(height)}${topbar(provider, "Access")}${endpointNav(provider, "Access", height)}${body.join("\n")}${annotations(
        [
          { x: 504, y: 192, w: 728, h: 152 },
          { x: 504, y: 352, w: 728, h: 72 },
          { x: 504, y: 472, w: 728, h: 280 },
        ],
      )}`,
    ),
  };
}

function accessMobile(data) {
  const height = 920;
  const body = [
    mobileHeader(data.short, "Access"),
    tx(16, 160, data.accessTitle, 20, "#000", 'font-weight="700"'),
    multiline(16, 190, wrap(data.accessSubtitle, 46, 2), 12, "#666", 16),
    tx(16, 256, "Unlinked people", 20, "#000", 'font-weight="700"'),
    ln(16, 288, 359, 288),
    tx(24, 328, data.unlinkedLabel, 14, "#000", 'font-weight="600"'),
    multiline(24, 356, wrap(data.unlinkedDetail, 38, 3), 12, "#666", 18),
    toggle(303, 328, true, true),
    tx(24, 440, "Restricted access", 14, "#000", 'font-weight="600"'),
    multiline(
      24,
      468,
      [
        "May message and attach safe files.",
        "Cannot approve or administer Paperclip.",
      ],
      12,
      "#666",
      18,
    ),
    tx(16, 560, "Linked accounts", 20, "#000", 'font-weight="700"'),
    tx(16, 588, "Uses current Paperclip permissions.", 12, "#666"),
    ln(16, 616, 359, 616),
  ];
  data.linked.forEach(([external, paperclip, action], index) => {
    const y = 632 + index * 96;
    if (index) body.push(ln(24, y, 351, y, 'stroke="#e6e6e6"'));
    body.push(tx(24, y + 28, external, 14, "#000", 'font-weight="600"'));
    body.push(tx(24, y + 52, paperclip, 12, "#666"));
    body.push(button(247, y + 16, 104, action));
  });
  body.push(button(16, 840, 343, "Link account", true));
  body.push(
    annotations(
      [
        { x: 8, y: 248, w: 359, h: 168 },
        { x: 8, y: 424, w: 359, h: 88 },
        { x: 8, y: 552, w: 359, h: 336 },
      ],
      true,
    ),
  );
  return { width: 375, height, svg: baseSvg(375, height, body.join("\n")) };
}

function conversationsDesktop(data, provider) {
  const height = 800;
  const body = [
    tx(512, 112, data.conversationsTitle, 28, "#000", 'font-weight="700"'),
    tx(512, 144, data.conversationsSubtitle, 14, "#666"),
    tx(528, 216, "CONVERSATION", 12, "#666", 'font-weight="700"'),
    tx(744, 216, "PAPERCLIP TASK", 12, "#666", 'font-weight="700"'),
    tx(984, 216, "STATE", 12, "#666", 'font-weight="700"'),
    ln(512, 232, 1224, 232),
  ];
  data.conversations.forEach(([conversation, task, state], index) => {
    const y = 248 + index * 120;
    if (index) body.push(ln(528, y, 1208, y, 'stroke="#e6e6e6"'));
    body.push(tx(528, y + 32, conversation, 14, "#000", 'font-weight="600"'));
    body.push(tx(744, y + 32, task, 14, "#000"));
    body.push(tx(984, y + 32, state, 12, "#666", 'font-weight="600"'));
    body.push(button(744, y + 56, 136, data.openProvider));
    body.push(button(896, y + 56, 136, "Open task", true));
  });
  return {
    width: 1280,
    height,
    svg: baseSvg(
      1280,
      height,
      `${globalSidebar(height)}${topbar(provider, "Conversations")}${endpointNav(provider, "Conversations", height)}${body.join("\n")}${annotations(data.conversations.map((_, index) => ({ x: 504, y: 240 + index * 120, w: 728, h: 112 })))}`,
    ),
  };
}

function conversationsMobile(data) {
  const height = 916;
  const body = [
    mobileHeader(data.short, "Conversations"),
    tx(16, 160, data.conversationsTitle, 20, "#000", 'font-weight="700"'),
    tx(16, 190, data.conversationsSubtitle, 12, "#666"),
  ];
  data.conversations.forEach(([conversation, task, state], index) => {
    const y = 224 + index * 216;
    body.push(rc(16, y, 343, 200));
    body.push(tx(32, y + 32, conversation, 14, "#000", 'font-weight="600"'));
    body.push(multiline(32, y + 62, wrap(task, 40, 2), 12, "#666", 18));
    body.push(tx(32, y + 108, state, 12, "#666", 'font-weight="600"'));
    body.push(button(32, y + 136, 144, data.openProvider));
    body.push(button(192, y + 136, 151, "Open task", true));
  });
  body.push(
    annotations(
      data.conversations.map((_, index) => ({
        x: 8,
        y: 216 + index * 216,
        w: 359,
        h: 216,
      })),
      true,
    ),
  );
  return { width: 375, height, svg: baseSvg(375, height, body.join("\n")) };
}

const sharedDefinitions = [
  {
    id: "01",
    slug: "connectors-catalog",
    title: "Connectors",
    subtitle: "Connect tools and places where people talk to agents.",
    group: "Start",
    tab: "Shared",
    annotations: [
      "The existing Apps catalog remains the entry point.",
      "Filters separate chat and tool methods.",
      "Each connector row has one Connect action.",
      "Connection state remains visible in the catalog.",
    ],
    rationale: "The current Connectors surface remains canonical.",
  },
  {
    id: "02",
    slug: "connection-purpose",
    title: "Choose how to connect",
    subtitle:
      "Shown for every connector that supports both chat and tool methods.",
    group: "Start",
    tab: "Shared",
    annotations: [
      "The existing connection wizard shell and selected provider are reused.",
      "Chat with an agent is the incoming-conversation path.",
      "Use this connection as an agent tool is the outbound tool/credential path.",
      "Single-purpose providers skip the choice.",
    ],
    rationale:
      "The registry drives the same direction choice for every dual-surface connector.",
  },
  {
    id: "03",
    slug: "choose-agent",
    title: "Which agent do you want to chat with?",
    subtitle: "Choose the one agent represented by this connection.",
    group: "Start",
    tab: "Shared",
    annotations: [
      "The existing agent selector is reused.",
      "Only active agents can be selected.",
      "One selection is required.",
      "Continue begins provider setup.",
    ],
    rationale: "This is the only shared Paperclip-specific setup decision.",
  },
  {
    id: "11",
    slug: "bound-task",
    title: "Externally connected task",
    subtitle: "A normal Paperclip task connected to its provider conversation.",
    group: "Paperclip",
    tab: "Task",
    annotations: [
      "The task shows its external source and provider link.",
      "External actors remain attributed.",
      "Eligible agent output shows publication status.",
      "Board comments remain internal unless Send to channel is selected.",
    ],
    rationale:
      "The agent assignment stays fixed for the lifetime of the external task; a different agent requires a new connection.",
  },
  {
    id: "12",
    slug: "agent-channels",
    title: "Agent Channels",
    subtitle: "See every provider identity representing this agent.",
    group: "Paperclip",
    tab: "Agent",
    annotations: [
      "Channel identities are summarized per provider.",
      "Health and recent tasks remain visible.",
      "Connections open in Connectors.",
      "Connect a channel preselects this agent.",
    ],
    rationale:
      "Agent detail summarizes endpoints while Connectors manages them.",
  },
];

const sharedScreens = sharedDefinitions.map((screen) => {
  for (const suffix of ["", "-mobile"])
    writeFileSync(
      join(out, `${screen.id}-${screen.slug}${suffix}.svg`),
      readFileSync(
        join(previous, `${screen.id}-${screen.slug}${suffix}.svg`),
        "utf8",
      ),
    );
  return { ...screen, desktopSize: "1280×800", mobileSize: "375×812" };
});

const setupScreens = [];
for (const obsoleteGitHubSetupAsset of [
  "45-github-install.svg",
  "45-github-install-mobile.svg",
  "47-github-existing.svg",
  "47-github-existing-mobile.svg",
]) {
  rmSync(join(out, obsoleteGitHubSetupAsset), { force: true });
}
for (const flow of setupFlows)
  for (const definition of flow.screens) {
    const screen = {
      ...definition,
      provider: flow.provider,
      group: flow.provider,
      tab: definition.mode === "advanced" ? "Custom setup" : "Setup",
    };
    if (flow.provider === "GitHub") {
      const desktop = githubSetupDesktop(screen);
      const mobile = githubSetupMobile(screen);
      writeFileSync(
        join(out, `${screen.id}-${screen.slug}.svg`),
        `${desktop.svg}\n`,
      );
      writeFileSync(
        join(out, `${screen.id}-${screen.slug}-mobile.svg`),
        `${mobile.svg}\n`,
      );
    } else {
      // The non-GitHub v8 setup assets contain settled provider-specific copy
      // that intentionally differs from v7. Validate that they exist without
      // replacing them with historical artwork during regeneration.
      for (const suffix of ["", "-mobile"])
        readFileSync(
          join(out, `${screen.id}-${screen.slug}${suffix}.svg`),
          "utf8",
        );
    }
    const desktop = readFileSync(
      join(out, `${screen.id}-${screen.slug}.svg`),
      "utf8",
    );
    const mobile = readFileSync(
      join(out, `${screen.id}-${screen.slug}-mobile.svg`),
      "utf8",
    );
    setupScreens.push({
      ...screen,
      desktopSize: desktop
        .match(/width="(\d+)" height="(\d+)"/)
        ?.slice(1)
        .join("×"),
      mobileSize: mobile
        .match(/width="(\d+)" height="(\d+)"/)
        ?.slice(1)
        .join("×"),
    });
  }

const detailScreens = [];
for (const provider of providers) {
  const data = providerManagement[provider.name];
  const settingsD = settingsDesktop(data, provider.name);
  const settingsM = settingsMobile(data);
  writeFileSync(join(out, `${data.id}-${data.slug}.svg`), `${settingsD.svg}\n`);
  writeFileSync(
    join(out, `${data.id}-${data.slug}-mobile.svg`),
    `${settingsM.svg}\n`,
  );
  const settingsAnnotations = [
    "Only provider-available destinations appear here.",
    "Each toggle is Paperclip's independent allow or deny decision.",
    "The provider action changes availability; newly discovered destinations remain disabled.",
    ...(data.conversationToggles.length
      ? ["Private-conversation reach is an explicit Paperclip choice."]
      : []),
  ];
  detailScreens.push({
    id: data.id,
    slug: data.slug,
    title: data.settingsTitle,
    provider: provider.name,
    group: provider.name,
    tab: "Settings",
    subtitle: data.settingsSubtitle,
    annotations: settingsAnnotations,
    rationale:
      "Provider membership is the ceiling; Paperclip enablement is the narrower enforcement boundary.",
    desktopSize: `${settingsD.width}×${settingsD.height}`,
    mobileSize: `${settingsM.width}×${settingsM.height}`,
  });

  const accessD = accessDesktop(data, provider.name);
  const accessM = accessMobile(data);
  const accessId = provider.ids.access;
  const accessSlug = `${provider.slug}-access`;
  writeFileSync(join(out, `${accessId}-${accessSlug}.svg`), `${accessD.svg}\n`);
  writeFileSync(
    join(out, `${accessId}-${accessSlug}-mobile.svg`),
    `${accessM.svg}\n`,
  );
  detailScreens.push({
    id: accessId,
    slug: accessSlug,
    title: data.accessTitle,
    provider: provider.name,
    group: provider.name,
    tab: "Access",
    subtitle: data.accessSubtitle,
    annotations: [
      "The only guest-policy choice is whether unlinked people may participate.",
      "The restricted profile permits task conversation but never Paperclip governance.",
      `Linked accounts map a stable ${data.identityHint} to a Paperclip user and can be revoked.`,
    ],
    rationale:
      "Settings controls where the bot works; Access controls who external people represent and which authority model applies.",
    desktopSize: `${accessD.width}×${accessD.height}`,
    mobileSize: `${accessM.width}×${accessM.height}`,
  });

  const conversationsD = conversationsDesktop(data, provider.name);
  const conversationsM = conversationsMobile(data);
  const conversationsId = provider.ids.conversations;
  const conversationsSlug = `${provider.slug}-conversations`;
  writeFileSync(
    join(out, `${conversationsId}-${conversationsSlug}.svg`),
    `${conversationsD.svg}\n`,
  );
  writeFileSync(
    join(out, `${conversationsId}-${conversationsSlug}-mobile.svg`),
    `${conversationsM.svg}\n`,
  );
  detailScreens.push({
    id: conversationsId,
    slug: conversationsSlug,
    title: data.conversationsTitle,
    provider: provider.name,
    group: provider.name,
    tab: "Conversations",
    subtitle: data.conversationsSubtitle,
    annotations: [
      `The active row pairs one ${provider.name} conversation with its task, state, Open ${data.short}, and Open task links.`,
      `The waiting row keeps the same compact fields and actions.`,
      `The completed row remains available as history with the same two links.`,
    ],
    rationale:
      "Conversations is a plain cross-linking list, not a binding-management surface.",
    desktopSize: `${conversationsD.width}×${conversationsD.height}`,
    mobileSize: `${conversationsM.width}×${conversationsM.height}`,
  });

  const activityId = provider.ids.activity;
  const activitySlug = `${provider.slug}-activity`;
  for (const suffix of ["", "-mobile"])
    writeFileSync(
      join(out, `${activityId}-${activitySlug}${suffix}.svg`),
      readFileSync(
        join(previous, `${activityId}-${activitySlug}${suffix}.svg`),
        "utf8",
      ),
    );
  const activityDesktop = readFileSync(
    join(out, `${activityId}-${activitySlug}.svg`),
    "utf8",
  );
  const activityMobile = readFileSync(
    join(out, `${activityId}-${activitySlug}-mobile.svg`),
    "utf8",
  );
  detailScreens.push({
    id: activityId,
    slug: activitySlug,
    title: `${provider.name} activity`,
    provider: provider.name,
    group: provider.name,
    tab: "Activity",
    subtitle: "Health, deliveries, publications, and repair actions.",
    annotations: provider.activityAnnotations,
    rationale:
      "Diagnostics and conditional repairs live here instead of Settings.",
    desktopSize: activityDesktop
      .match(/width="(\d+)" height="(\d+)"/)
      ?.slice(1)
      .join("×"),
    mobileSize: activityMobile
      .match(/width="(\d+)" height="(\d+)"/)
      ?.slice(1)
      .join("×"),
  });
}

function flowSvg() {
  const node = (x, y, w, title, sub, fill = false) =>
    `${rc(x, y, w, 88, fill ? 'fill="#e6e6e6"' : 'fill="#fff"')}${tx(x + 16, y + 32, title, 14, "#000", 'font-weight="700"')}${tx(x + 16, y + 64, sub, 12, "#666")}`;
  const arrow = (x1, y1, x2, y2) =>
    `${ln(x1, y1, x2, y2)}<polygon points="${x2},${y2} ${x2 - 8},${y2 - 8} ${x2 - 8},${y2 + 8}" fill="#000" stroke="none"/>`;
  return baseSvg(
    1280,
    880,
    `${tx(48, 48, "Chat connector product flow", 28, "#000", 'font-weight="700"')}${tx(48, 80, "The provider grants availability; Paperclip grants permission to act.", 14, "#666")}
    ${node(48, 128, 176, "Connectors", "Choose provider", true)}${arrow(224, 176, 264, 176)}${node(264, 128, 192, "Choose agent", "Exactly once")}${arrow(456, 176, 496, 176)}${node(496, 128, 208, "Install or invite", "Provider ceiling")}${arrow(704, 176, 744, 176)}${node(744, 128, 208, "Test destination", "Enabled first")}${arrow(952, 176, 992, 176)}${node(992, 128, 192, "Active", "Ready", true)}
    ${tx(48, 304, "ENDPOINT MANAGEMENT", 12, "#666", 'font-weight="700"')}${node(48, 336, 232, "Settings", "Where it may work", true)}${node(304, 336, 232, "Access", "Who people are")}${node(560, 336, 232, "Conversations", "Provider ↔ task")}${node(816, 336, 232, "Activity", "Health + repair")}
    ${tx(48, 512, "RESOURCE LIFECYCLE", 12, "#666", 'font-weight="700"')}${node(48, 544, 232, "Invited / installed", "Available")}${arrow(280, 588, 320, 588)}${node(320, 544, 232, "Enabled in Settings", "Eligible")}${arrow(552, 588, 592, 588)}${node(592, 544, 232, "Conversation", "One task")}${arrow(824, 588, 864, 588)}${node(864, 544, 232, "Task output", "Safe publication")}
    ${tx(48, 720, "Fixed behavior", 20, "#000", 'font-weight="700"')}${tx(48, 752, "Invitation alone creates no task. Removed provider access makes the resource unavailable; history stays linked and read-only.", 14, "#666")}
    ${annotations([
      { x: 40, y: 120, w: 1152, h: 112 },
      { x: 40, y: 328, w: 1016, h: 112 },
      { x: 40, y: 536, w: 1064, h: 112 },
      { x: 40, y: 704, w: 1152, h: 80 },
    ])}`,
  );
}

writeFileSync(join(out, "flow.svg"), `${flowSvg()}\n`);

const groups = [
  ["Start", sharedScreens.filter((screen) => screen.group === "Start")],
  ...providers.map((provider) => [
    provider.name,
    [
      ...setupScreens.filter((screen) => screen.provider === provider.name),
      ...detailScreens.filter((screen) => screen.provider === provider.name),
    ],
  ]),
  ["Paperclip", sharedScreens.filter((screen) => screen.group === "Paperclip")],
];
const orderedScreens = groups.flatMap(([, screens]) => screens);

function uiDocument() {
  const inventory = orderedScreens
    .map(
      (screen) =>
        `| ${screen.id} | ${screen.group} | ${screen.tab} | ${screen.title} | ${screen.desktopSize} | ${screen.mobileSize} |`,
    )
    .join("\n");
  const details = orderedScreens
    .map(
      (screen) =>
        `### ${screen.id} · ${screen.title}\n\nPurpose: ${screen.subtitle}\n\n${screen.annotations.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\n${screen.actions ? `Actions:\n\n${screen.actions.map(([label, effect]) => `- **${label}:** ${effect}`).join("\n")}\n\n` : ""}Rationale: ${screen.rationale}`,
    )
    .join("\n\n");
  const permissions = permissionModel
    .map(([name, behavior]) => `- **${name}:** ${behavior}`)
    .join("\n");
  return `# Paperclip Chat Adapters UI Surfaces — v8\n\nDate: 2026-09-04  \nOriginal planning base: \`${baseSha}\`; release qualification records the exact tested revision separately.  \nReview viewer: [\`index.html\`](./index.html)  \nWireframes: [\`wireframes-v8/\`](./wireframes-v8/)\n\n## Permission model\n\n${permissions}\n\n## Access tab\n\n**Settings answers where the bot may work. Access answers who an external sender represents and what Paperclip authority applies.** A linked external identity acts as its mapped Paperclip user and is checked against current permissions on every action. An unlinked identity may be allowed under the fixed restricted profile: it can converse within enabled resources and attach safe files, but it cannot approve, change budgets, hire, manage permissions or connections, or reassign agents. The connection owner remains an internal audit and authority ceiling; it is not ordinary UI configuration.\n\n## Conversations tab\n\nEach provider has one plain list. Every row contains the external conversation, Paperclip task, current state, an Open-provider link, and Open task. There is no separate binding-management section or conversation-boundary explainer. If provider access disappears, the row becomes unavailable while its history remains inspectable.\n\nThe former \"How conversations work\" screens are removed. Provider-native activation and reply behavior remains implementation documentation, not a standalone product page.\n\n## Screen inventory\n\n| ID | Group | Surface | Title | Desktop | Mobile |\n|---|---|---|---|---|---|\n${inventory}\n\n## Annotation and action notes\n\n${details}\n`;
}

function viewerHtml() {
  const template = readFileSync(
    join(
      root,
      "../../../packages/skills-catalog/catalog/bundled/product/wireframe/assets/site-template.html",
    ),
    "utf8",
  );
  const style = template.match(/<style>[\s\S]*?<\/style>/)?.[0];
  if (!style) throw new Error("Could not load wireframe viewer styles");
  const toc = groups
    .map(
      ([label, screens]) =>
        `<h2>${esc(label)}</h2>${screens.map((screen) => `<a href="#s${screen.id}"><span class="num">${Number(screen.id)}</span>${esc(screen.title)}</a>`).join("\n")}`,
    )
    .join("\n");
  const sections = groups
    .map(
      ([label, screens]) =>
        `<div class="provider-break"><div class="lede">${esc(label)}</div><h2>${label === "Start" ? "Shared connection start" : label === "Paperclip" ? "Shared Paperclip surfaces" : `${esc(label)} connector`}</h2></div>${screens
          .map((screen) => {
            const notes = screen.annotations
              .map(
                (note, index) => `<li><b>${index + 1}</b> — ${esc(note)}</li>`,
              )
              .join("\n");
            const actions = screen.actions
              ? `<h3>What the actions do</h3><ul>${screen.actions.map(([name, effect]) => `<li><b>${esc(name)}</b> — ${esc(effect)}</li>`).join("\n")}</ul>`
              : "";
            return `<section id="s${screen.id}"><div class="lede">${esc(screen.group)} · ${esc(screen.tab)}</div><h2><span class="step-num">${Number(screen.id)}.</span>${esc(screen.title)}</h2><p class="desc">${esc(screen.subtitle)}</p><div class="grid"><div class="wire" data-zoom data-caption="${screen.id} · ${esc(screen.title)} (desktop)"><div class="label"><span>${screen.id}-${screen.slug}.svg</span><span>${screen.desktopSize} · desktop</span></div><img src="wireframes-v8/${screen.id}-${screen.slug}.svg" alt="${esc(screen.title)} desktop wireframe" /></div><div class="wire mobile-wire mobile-col" data-zoom data-caption="${screen.id} · ${esc(screen.title)} (mobile)"><div class="label"><span>mobile</span><span>${screen.mobileSize}</span></div><img src="wireframes-v8/${screen.id}-${screen.slug}-mobile.svg" alt="${esc(screen.title)} mobile wireframe" /></div><div class="notes-col"><div class="notes"><h3>Annotations</h3><ul>${notes}</ul>${actions}<div class="why"><b>Rationale:</b> ${esc(screen.rationale)}</div></div></div></div></section>`;
          })
          .join("\n")}`,
    )
    .join("\n");
  const permissions = permissionModel
    .map(
      ([name, behavior]) => `<li><b>${esc(name)}</b> — ${esc(behavior)}</li>`,
    )
    .join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Paperclip chat adapters — permissions and conversation review</title>${style}<style>.doc-links{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:16px}.doc-links a{min-height:48px;display:inline-flex;align-items:center;font-size:13px;font-weight:600}.notice{max-width:var(--maxw);margin:-32px 0 48px;padding:14px 18px;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:4px}.notice p{margin:0}.decision{margin-top:24px;padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:8px}.decision b{display:block;margin-bottom:6px}.provider-break{max-width:var(--maxw);margin:80px 0 8px;padding-top:24px;border-top:2px solid var(--ink)}.provider-break h2{font-size:28px;margin:6px 0 0}.toc-body h2{margin-top:18px}code{font-size:.92em}</style></head><body><div class="shell"><details class="toc"><summary class="toc-summary"><span><span class="crumb">Chat adapters · v8</span><br><span class="title">Jump to a screen</span></span><span class="chevron" aria-hidden="true"></span></summary><nav class="toc-body" aria-label="Section navigation"><h1>Chat adapters</h1><div style="font-size:13px;color:var(--muted);margin-bottom:16px">Permissions + conversations</div><h2>Documents</h2><a href="2026-09-03-chat-adapters-architecture.md"><span class="num">A</span>Architecture</a><a href="2026-09-04-chat-adapters-ui-surfaces-v8.md"><span class="num">U</span>UI specification v8</a><a href="2026-09-04-chat-adapters-browser-e2e-runbook.md"><span class="num">E</span>Browser E2E runbook</a><a href="2026-09-04-chat-adapters-minimum-setup-v6.md"><span class="num">M</span>Minimum setup</a><a href="2026-09-04-chat-adapters-platform-surfaces.md"><span class="num">P</span>Platform research</a><h2>Flow</h2><a href="#flow"><span class="num">↳</span>Product flow</a>${toc}<h2>Review</h2><a href="#decisions"><span class="num">✓</span>Permission model</a></nav></details><main><header class="hero"><div class="crumb">Paperclip · Connectors · v8</div><h1>Providers grant presence. Paperclip grants permission.</h1><p>Settings enables destinations. Access maps people to Paperclip authority. Conversations is a simple list linking each external conversation to its task.</p><div class="decision"><b>Effective reach</b><span>Provider-installed or invited ∩ Paperclip-enabled ∩ active connection ∩ authorized action.</span></div><div class="doc-links"><a href="2026-09-03-chat-adapters-architecture.md">Architecture plan</a><a href="2026-09-04-chat-adapters-ui-surfaces-v8.md">UI specification v8</a><a href="2026-09-04-chat-adapters-browser-e2e-runbook.md">Browser E2E runbook</a><a href="2026-09-04-chat-adapters-platform-surfaces.md">Platform decisions</a></div><div class="pills"><span class="pill">${orderedScreens.length} product surfaces</span><span class="pill">4 management tabs</span><span class="pill">No walkthrough pages</span><span class="pill">Desktop + mobile</span></div></header><div class="notice" role="note"><p><b>Review convention:</b> red dashed marks are annotations, not proposed UI.</p></div><section id="flow" class="flow-section"><div class="lede">Navigation and product flow</div><h2>Provider availability, then Paperclip enablement</h2><p class="desc">The setup test destination is enabled explicitly. Later provider invitations or installations become available but remain off until enabled in Settings.</p><div class="wire" data-zoom data-caption="Chat connector product flow"><div class="label"><span>flow.svg</span><span>1280×880</span></div><img src="wireframes-v8/flow.svg" alt="Chat connector product flow"/></div></section>${sections}<section id="decisions"><div class="lede">Product decisions</div><h2>Permission model</h2><div class="notes"><ul>${permissions}</ul><div class="why"><b>Access tab:</b> linked people use current Paperclip permissions; allowed unlinked people receive a fixed restricted profile and cannot govern Paperclip.</div></div></section><div class="footer">Generated with Paperclip’s wireframe contract. Conversation walkthrough pages and binding-management controls are intentionally absent.</div></main></div><div class="lightbox" id="lb" aria-hidden="true"><span class="close" id="lbClose" role="button" aria-label="Close preview">×</span><img id="lbImg" alt=""/><div class="caption" id="lbCap"></div></div><script>const lb=document.getElementById('lb'),lbImg=document.getElementById('lbImg'),lbCap=document.getElementById('lbCap');document.querySelectorAll('[data-zoom]').forEach(el=>el.addEventListener('click',()=>{const target=el.querySelector('img');if(!target)return;lbImg.src=target.src;lbImg.alt=target.alt;lbCap.textContent=el.dataset.caption||target.alt||'';lb.classList.add('open');lb.setAttribute('aria-hidden','false')}));function closeLightbox(){lb.classList.remove('open');lb.setAttribute('aria-hidden','true')}lb.addEventListener('click',closeLightbox);document.getElementById('lbClose').addEventListener('click',closeLightbox);document.addEventListener('keydown',e=>{if(e.key==='Escape')closeLightbox()});const tocElement=document.querySelector('details.toc'),media=window.matchMedia('(max-width:900px)'),setToc=()=>{tocElement.open=!media.matches};setToc();media.addEventListener('change',setToc);tocElement.querySelectorAll('.toc-body a').forEach(link=>link.addEventListener('click',()=>{if(media.matches)tocElement.open=false}));</script></body></html>`;
}

writeFileSync(
  join(root, "2026-09-04-chat-adapters-ui-surfaces-v8.md"),
  `${uiDocument().replaceAll("  \n", "\n").trimEnd()}\n`,
);
writeFileSync(join(root, "index.html"), `${viewerHtml()}\n`);
console.log(
  `Generated ${orderedScreens.length * 2 + 1} v8 SVGs across ${orderedScreens.length} product surfaces.`,
);
