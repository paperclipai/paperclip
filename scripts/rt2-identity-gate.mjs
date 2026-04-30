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
  "ui/src/pages/rt2/QuickCapturePage.tsx",
  "ui/public/site.webmanifest",
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
  return [".ts", ".tsx", ".js", ".jsx", ".json", ".webmanifest"].includes(extname(path));
}

function collectFiles(targets, cwd = process.cwd()) {
  const files = [];
  for (const target of targets) {
    const absolute = resolve(cwd, target);
    if (!existsSync(absolute)) continue;
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute, { recursive: true })) {
        const child = resolve(absolute, entry.toString());
        if (existsSync(child) && statSync(child).isFile() && isScannableFile(child)) {
          files.push(child);
        }
      }
    } else if (stat.isFile() && isScannableFile(absolute)) {
      files.push(absolute);
    }
  }
  return Array.from(new Set(files)).sort();
}

export function runRt2IdentityGate({ cwd = process.cwd(), targets = DEFAULT_TARGETS, out = console.log, err = console.error } = {}) {
  const files = collectFiles(targets, cwd);
  const findings = [];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const rule of RULES) {
        rule.pattern.lastIndex = 0;
        const matches = Array.from(line.matchAll(rule.pattern));
        for (const match of matches) {
          findings.push({
            file: normalizePath(relative(cwd, file)),
            line: index + 1,
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
      err(`  ${finding.file}:${finding.line} [${finding.category}] ${finding.token}`);
      err(`    ${finding.guidance}`);
    }
    return 1;
  }

  out(`RealTycoon2 identity gate passed (${files.length} file(s) scanned).`);
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
