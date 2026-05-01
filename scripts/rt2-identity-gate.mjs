#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TARGETS = [
  "ui/src/App.tsx",
  "ui/src/context/BreadcrumbContext.tsx",
  "ui/src/components/CompanyRail.tsx",
  "ui/src/components/CommandPalette.tsx",
  "ui/src/components/InstanceSidebar.tsx",
  "ui/src/components/MobileBottomNav.tsx",
  "ui/src/components/Rt2DailyBoard.tsx",
  "ui/src/components/Sidebar.tsx",
  "ui/src/components/SidebarAccountMenu.tsx",
  "ui/src/pages/Auth.tsx",
  "ui/src/pages/Dashboard.tsx",
  "ui/src/pages/NotFound.tsx",
  "ui/src/pages/rt2/DailyWorkPage.tsx",
  "ui/src/pages/rt2/KnowledgePage.tsx",
  "ui/src/pages/rt2/OneLinerPage.tsx",
  "ui/src/pages/rt2/PlanAlignmentPage.tsx",
  "ui/src/pages/rt2/QuickCapturePage.tsx",
  "ui/public/site.webmanifest",
  { path: "doc/PRODUCT.md", surface: "product_doc", allowCompatibilityBoundary: true },
  { path: "doc/SPEC.md", surface: "product_doc", allowCompatibilityBoundary: true },
  { path: "doc/REALTYCOON2-COMPATIBILITY.md", surface: "compatibility_doc", allowCompatibilityBoundary: true },
  { path: "server/src/routes/llms.ts", surface: "server_operator_copy" },
  { path: "server/src/routes/org-chart-svg.ts", surface: "server_operator_copy" },
];

const EXCLUDED_SEGMENTS = [
  ".test.",
  ".stories.",
  "/adapters/",
  "/api/",
  "/lib/",
  "/plugins/",
  "/storybook/",
];

const RULES = [
  {
    category: "legacy-product-name",
    pattern: /\bPaperclip\b|Paper Company|\bMultica\b/g,
    guidance: "제품 표면에서는 RealTycoon2/Jarvis/업무 중심 용어를 사용하세요.",
  },
  {
    category: "english-loading-default",
    pattern: /\bLoading (graph|data|tasks|projects|board|evidence)\b|Rendering diagram\.\.\./g,
    guidance: "로딩 문구는 한국어 운영 문구로 바꾸세요.",
  },
  {
    category: "english-empty-default",
    pattern: /\bNo (graph data|nodes|wiki evidence|citation|evidence|data) available\b|No .* yet\./g,
    guidance: "빈 상태 문구는 한국어 운영 문구로 바꾸세요.",
  },
  {
    category: "support-surface-english-label",
    pattern: /\bTask Mesh\b|\bQuality Score\b|\bShadow Mode\b|\bOpen citation\b/g,
    guidance: "지원 surface의 라벨은 한국어로 표시하세요.",
  },
];

function normalizePath(path) {
  return path.replace(/\\/g, "/");
}

function isScannableFile(path) {
  const normalized = normalizePath(path);
  if (EXCLUDED_SEGMENTS.some((segment) => normalized.includes(segment))) return false;
  return [".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".webmanifest"].includes(extname(path));
}

function targetDescriptor(target) {
  if (typeof target === "string") {
    return {
      path: target,
      surface: "product_surface",
      allowCompatibilityBoundary: false,
    };
  }
  return {
    surface: "product_surface",
    allowCompatibilityBoundary: false,
    ...target,
  };
}

function addFileEntry(entries, file, descriptor) {
  const key = normalizePath(file);
  const existing = entries.get(key);
  entries.set(key, {
    file,
    surface: existing?.surface ?? descriptor.surface,
    allowCompatibilityBoundary:
      Boolean(existing?.allowCompatibilityBoundary) || Boolean(descriptor.allowCompatibilityBoundary),
  });
}

function collectFileEntries(targets, cwd = process.cwd()) {
  const entries = new Map();
  for (const target of targets) {
    const descriptor = targetDescriptor(target);
    const absolute = resolve(cwd, descriptor.path);
    if (!existsSync(absolute)) continue;
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute, { recursive: true })) {
        const child = resolve(absolute, entry.toString());
        if (existsSync(child) && statSync(child).isFile() && isScannableFile(child)) {
          addFileEntry(entries, child, descriptor);
        }
      }
    } else if (stat.isFile() && isScannableFile(absolute)) {
      addFileEntry(entries, absolute, descriptor);
    }
  }
  return Array.from(entries.values()).sort((a, b) => a.file.localeCompare(b.file));
}

function hasCompatibilityBoundary(text) {
  const lower = text.toLowerCase();
  return (
    lower.includes("realtycoon2") &&
    lower.includes("paperclip") &&
    /compatibility|control[- ]plane|infrastructure|reference|runtime|호환|참조|인프라|런타임/.test(lower)
  );
}

function isAllowedCompatibilityFinding({ rule, token, entry, text }) {
  if (!entry.allowCompatibilityBoundary) return false;
  if (rule.category !== "legacy-product-name") return false;
  if (token === "Paper Company") return false;
  return hasCompatibilityBoundary(text);
}

export function runRt2IdentityGate({ cwd = process.cwd(), targets = DEFAULT_TARGETS, out = console.log, err = console.error } = {}) {
  const entries = collectFileEntries(targets, cwd);
  const findings = [];

  for (const entry of entries) {
    const text = readFileSync(entry.file, "utf8");
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const rule of RULES) {
        rule.pattern.lastIndex = 0;
        const matches = Array.from(line.matchAll(rule.pattern));
        for (const match of matches) {
          if (isAllowedCompatibilityFinding({ rule, token: match[0], entry, text })) {
            continue;
          }
          findings.push({
            file: normalizePath(relative(cwd, entry.file)),
            line: index + 1,
            surface: entry.surface,
            category: rule.category,
            token: match[0],
            guidance: rule.guidance,
          });
        }
      }
    }
  }

  if (findings.length > 0) {
    err("RealTycoon2 identity gate failed:\n");
    for (const finding of findings) {
      err(`  ${finding.file}:${finding.line} [${finding.surface}/${finding.category}] ${finding.token}`);
      err(`    ${finding.guidance}`);
    }
    return 1;
  }

  out(`RealTycoon2 identity gate passed (${entries.length} file(s) scanned).`);
  return 0;
}

function main() {
  const targets = process.argv.slice(2);
  process.exit(runRt2IdentityGate({ targets: targets.length > 0 ? targets : DEFAULT_TARGETS }));
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main();
}
