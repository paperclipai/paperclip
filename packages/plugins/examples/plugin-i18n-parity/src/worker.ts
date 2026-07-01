import { definePlugin, runWorker, type PluginContext, type ToolResult } from "@paperclipai/plugin-sdk";
import { load as cheerioLoad } from "cheerio";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SurfaceName = "meta" | "nav" | "hero" | "main" | "cta" | "footer" | "embeds";

type SurfaceStatus = "translated" | "partial" | "still_english" | "empty";

type SurfaceResult = {
  english_likelihood: number; // 0–1
  status: SurfaceStatus;
  evidence: string[];
};

// v1 report schema (extensible for GA/GSC)
type V1PageResult = {
  locale: string;
  path: string;
  page_localization_score: number; // 0–1
  still_english_flag: boolean;
  missing?: boolean;
  surfaces: Record<SurfaceName, SurfaceResult>;
  scannedAt: string;
};

type V1LocaleSummary = {
  total_pages: number;
  above_threshold: number;
  avg_score: number;
  worst_pages: Array<{ path: string; page_localization_score: number }>;
};

type V1Report = {
  schema_version: 1;
  generated_at: string;
  config: {
    min_score: number;
    locales_scanned: string[];
  };
  localization: {
    summary: Record<string, V1LocaleSummary>;
    pages: V1PageResult[];
  };
  analytics: null;
  search_console: null;
};

type I18nParityConfig = {
  repoPath: string;
  localeConfigFile: string;
  minScore: number;
  surfaceWeights: Record<SurfaceName, number>;
  excludePatterns: string[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LOCALE_CONFIG_FILE = "config.locales.json";
const DEFAULT_MIN_SCORE = 0.7;

const DEFAULT_SURFACE_WEIGHTS: Record<SurfaceName, number> = {
  meta: 0.15,
  nav: 0.05,
  hero: 0.30,
  main: 0.30,
  cta: 0.10,
  footer: 0.05,
  embeds: 0.05,
};

// EN baseline routes — mirrors check-locale-coverage.js EN_BASELINE_ROUTES.
// Strategy pages are discovered dynamically from the repo at scan time.
const STATIC_BASELINE_ROUTES: string[] = [
  "index.html",
  "how-to-play.html",
  "easy.html",
  "hard.html",
  "expert.html",
  "master.html",
  "medium.html",
  "daily-sudoku.html",
  "printable-sudoku-puzzles.html",
  "privacy.html",
  "rules.html",
  "sudoku-beginner-guide.html",
  "sudoku-brain-benefits.html",
  "sudoku-difficulty-levels.html",
  "sudoku-faq.html",
  "sudoku-for-beginners.html",
  "sudoku-for-seniors.html",
  "sudoku-rules-cheat-sheet.html",
  "sudoku-strategies.html",
  "sudoku-strategy-cheat-sheet.html",
  "sudoku-tips.html",
  "sudoku-variants.html",
  "best-ad-free-sudoku-app.html",
  "best-sudoku-app-comparison.html",
  "comparison-pages/sudoku-a-day-vs-andoku.html",
  "comparison-pages/sudoku-a-day-vs-brainium.html",
  "comparison-pages/sudoku-a-day-vs-good-sudoku.html",
  "comparison-pages/sudoku-a-day-vs-sudoku-coach.html",
  "comparison-pages/sudoku-a-day-vs-sudoku-com.html",
  "printable-sudoku-puzzles/easy/index.html",
  "printable-sudoku-puzzles/expert/index.html",
  "printable-sudoku-puzzles/hard/index.html",
  "printable-sudoku-puzzles/master/index.html",
  "printable-sudoku-puzzles/medium/index.html",
  "printable-sudoku-puzzles/weekly-packs/index.html",
];

// Common English stopwords used for EN likelihood detection.
const EN_STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can",
  "her", "was", "one", "our", "out", "day", "get", "has", "him",
  "his", "how", "its", "may", "new", "now", "old", "see", "two",
  "who", "did", "she", "use", "way", "will", "with", "have", "from",
  "this", "that", "they", "been", "your", "more", "also", "into",
  "than", "then", "some", "what", "when", "where", "which", "while",
  "play", "free", "daily", "sudoku", "puzzle", "online", "learn",
  "start", "here", "easy", "hard", "best", "app", "get", "now",
]);

// ---------------------------------------------------------------------------
// In-memory scan state — keyed by scannedAt timestamp
// ---------------------------------------------------------------------------

const scanHistory = new Map<string, V1Report>();
let latestScanKey: string | null = null;
let cachedCompanyId: string | null = null;

async function resolveCompanyId(ctx: PluginContext): Promise<string> {
  if (cachedCompanyId) return cachedCompanyId;
  const companies = await ctx.companies.list({ limit: 1 });
  if (!companies || companies.length === 0) throw new Error("No company found for this plugin instance.");
  cachedCompanyId = companies[0].id;
  return cachedCompanyId;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

async function getConfig(ctx: PluginContext): Promise<I18nParityConfig> {
  const raw = await ctx.config.get();
  const repoPath = typeof raw.repoPath === "string" ? raw.repoPath.trim() : "";
  const localeConfigFile =
    typeof raw.localeConfigFile === "string" && raw.localeConfigFile.trim()
      ? raw.localeConfigFile.trim()
      : DEFAULT_LOCALE_CONFIG_FILE;
  const minScore =
    typeof raw.minScore === "number" && raw.minScore >= 0 && raw.minScore <= 1
      ? raw.minScore
      : DEFAULT_MIN_SCORE;

  const surfaceWeights: Record<SurfaceName, number> = { ...DEFAULT_SURFACE_WEIGHTS };
  if (raw.surfaceWeights && typeof raw.surfaceWeights === "object") {
    const overrides = raw.surfaceWeights as Record<string, unknown>;
    for (const [k, v] of Object.entries(overrides)) {
      if (typeof v === "number" && k in DEFAULT_SURFACE_WEIGHTS) {
        surfaceWeights[k as SurfaceName] = v;
      }
    }
  }

  const excludePatterns: string[] = Array.isArray(raw.excludePatterns)
    ? raw.excludePatterns.filter((p): p is string => typeof p === "string")
    : [];

  return { repoPath, localeConfigFile, minScore, surfaceWeights, excludePatterns };
}

// ---------------------------------------------------------------------------
// Locale config loader
// ---------------------------------------------------------------------------

type LocaleConfig = {
  defaultLocale: string;
  supportedLocales: string[];
  pathPrefixByLocale: Record<string, string>;
};

function loadLocaleConfig(repoPath: string, localeConfigFile: string): LocaleConfig {
  const fullPath = path.isAbsolute(localeConfigFile)
    ? localeConfigFile
    : path.join(repoPath, localeConfigFile);
  const raw = JSON.parse(fs.readFileSync(fullPath, "utf-8")) as Record<string, unknown>;
  return {
    defaultLocale: typeof raw.defaultLocale === "string" ? raw.defaultLocale : "en",
    supportedLocales: Array.isArray(raw.supportedLocales)
      ? (raw.supportedLocales as string[])
      : [],
    pathPrefixByLocale:
      raw.pathPrefixByLocale && typeof raw.pathPrefixByLocale === "object"
        ? (raw.pathPrefixByLocale as Record<string, string>)
        : {},
  };
}

// ---------------------------------------------------------------------------
// Baseline routes — mirrors check-locale-coverage.js FULL_BASELINE
// ---------------------------------------------------------------------------

function buildBaselineRoutes(repoPath: string): string[] {
  const routes = [...STATIC_BASELINE_ROUTES];
  // Dynamically discover strategy pages from the EN repo
  const strategiesDir = path.join(repoPath, "sudoku-strategies");
  if (fs.existsSync(strategiesDir)) {
    try {
      const files = fs.readdirSync(strategiesDir)
        .filter((f) => f.endsWith(".html"))
        .sort();
      for (const f of files) {
        routes.push(`sudoku-strategies/${f}`);
      }
    } catch {
      // ignore read errors
    }
  }
  return routes;
}

// ---------------------------------------------------------------------------
// Exclude pattern matcher (simple prefix/glob support)
// ---------------------------------------------------------------------------

function isExcluded(relPath: string, excludePatterns: string[]): boolean {
  for (const pattern of excludePatterns) {
    // Support simple wildcard suffix (e.g. "daily-sudoku/20*")
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (relPath.startsWith(prefix)) return true;
    } else if (relPath === pattern || relPath.startsWith(pattern + "/")) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Language heuristics
// ---------------------------------------------------------------------------

function hasCjkScript(text: string): boolean {
  return /[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(text);
}

function hasCyrillicScript(text: string): boolean {
  return /[\u0400-\u04ff]/.test(text);
}

function hasDevanagariScript(text: string): boolean {
  return /[\u0900-\u097f]/.test(text);
}

function estimateEnglishLikelihood(text: string): number {
  if (!text || text.trim().length === 0) return 0;

  if (hasCjkScript(text) || hasCyrillicScript(text) || hasDevanagariScript(text)) {
    return 0.05;
  }

  const words = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);

  if (words.length === 0) return 0.1;

  const stopwordCount = words.filter((w) => EN_STOPWORDS.has(w)).length;
  const stopwordRate = stopwordCount / words.length;
  return Math.min(1, stopwordRate * 3.0);
}

function extractEvidenceSnippet(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > 120 ? trimmed.slice(0, 117) + "..." : trimmed;
}

function likelihoodToStatus(likelihood: number): SurfaceStatus {
  if (likelihood >= 0.65) return "still_english";
  if (likelihood >= 0.35) return "partial";
  if (likelihood === 0) return "empty";
  return "translated";
}

// ---------------------------------------------------------------------------
// Surface extractors
// ---------------------------------------------------------------------------

function extractMeta(html: ReturnType<typeof cheerioLoad>): SurfaceResult {
  const parts: string[] = [];
  const title = html("title").text().trim();
  if (title) parts.push(title);
  const desc = html('meta[name="description"]').attr("content") ?? "";
  if (desc) parts.push(desc);
  const ogTitle = html('meta[property="og:title"]').attr("content") ?? "";
  if (ogTitle) parts.push(ogTitle);
  const ogDesc = html('meta[property="og:description"]').attr("content") ?? "";
  if (ogDesc) parts.push(ogDesc);
  const combined = parts.join(" ");
  const likelihood = estimateEnglishLikelihood(combined);
  return { english_likelihood: likelihood, status: likelihoodToStatus(likelihood), evidence: parts.slice(0, 3).map(extractEvidenceSnippet) };
}

function extractNav(html: ReturnType<typeof cheerioLoad>): SurfaceResult {
  const texts: string[] = [];
  html("nav, header nav, .nav, #navigation, [role='navigation']").each((_, el) => {
    const t = html(el).text().replace(/\s+/g, " ").trim();
    if (t) texts.push(t);
  });
  const combined = texts.join(" ");
  const likelihood = estimateEnglishLikelihood(combined);
  return { english_likelihood: likelihood, status: likelihoodToStatus(likelihood), evidence: texts.slice(0, 2).map(extractEvidenceSnippet) };
}

function extractHero(html: ReturnType<typeof cheerioLoad>): SurfaceResult {
  const texts: string[] = [];
  html(".hero, .hero-text, [class*='hero'], section:first-of-type h1, h1").each((_, el) => {
    const t = html(el).text().replace(/\s+/g, " ").trim();
    if (t) texts.push(t);
  });
  const combined = texts.join(" ");
  const likelihood = estimateEnglishLikelihood(combined);
  return { english_likelihood: likelihood, status: likelihoodToStatus(likelihood), evidence: texts.slice(0, 3).map(extractEvidenceSnippet) };
}

function extractMain(html: ReturnType<typeof cheerioLoad>): SurfaceResult {
  const texts: string[] = [];
  html("main, article, .content, #content, section").each((_, el) => {
    const clone = html(el).clone();
    clone.find("nav, header, footer, script, style").remove();
    const t = clone.text().replace(/\s+/g, " ").trim();
    if (t.length > 20) texts.push(t);
  });
  const combined = texts.join(" ").slice(0, 500);
  const likelihood = estimateEnglishLikelihood(combined);
  return { english_likelihood: likelihood, status: likelihoodToStatus(likelihood), evidence: texts.slice(0, 2).map((t) => extractEvidenceSnippet(t.slice(0, 120))) };
}

function extractCta(html: ReturnType<typeof cheerioLoad>): SurfaceResult {
  const texts: string[] = [];
  html("a.button, .button, .btn, [class*='cta'], a[href*='app'], button").each((_, el) => {
    const t = html(el).text().replace(/\s+/g, " ").trim();
    if (t.length > 1 && t.length < 80) texts.push(t);
  });
  const combined = texts.join(" ");
  const likelihood = estimateEnglishLikelihood(combined);
  return { english_likelihood: likelihood, status: likelihoodToStatus(likelihood), evidence: texts.slice(0, 4).map(extractEvidenceSnippet) };
}

function extractFooter(html: ReturnType<typeof cheerioLoad>): SurfaceResult {
  const texts: string[] = [];
  html("footer, .footer, #footer").each((_, el) => {
    const t = html(el).text().replace(/\s+/g, " ").trim();
    if (t) texts.push(t);
  });
  const combined = texts.join(" ").slice(0, 400);
  const likelihood = estimateEnglishLikelihood(combined);
  return { english_likelihood: likelihood, status: likelihoodToStatus(likelihood), evidence: texts.slice(0, 2).map((t) => extractEvidenceSnippet(t.slice(0, 120))) };
}

function extractEmbeds(html: ReturnType<typeof cheerioLoad>): SurfaceResult {
  const texts: string[] = [];
  html("img[alt], iframe[title], [aria-label]").each((_, el) => {
    const t = html(el).attr("alt") ?? html(el).attr("title") ?? html(el).attr("aria-label") ?? "";
    if (t.trim()) texts.push(t.trim());
  });
  const combined = texts.join(" ");
  const likelihood = estimateEnglishLikelihood(combined);
  return { english_likelihood: likelihood, status: likelihoodToStatus(likelihood), evidence: texts.slice(0, 4).map(extractEvidenceSnippet) };
}

// ---------------------------------------------------------------------------
// Page scanner
// ---------------------------------------------------------------------------

function scanPage(
  absolutePath: string,
  locale: string,
  relPath: string,
  surfaceWeights: Record<SurfaceName, number>,
): V1PageResult {
  const html = fs.readFileSync(absolutePath, "utf-8");
  const $ = cheerioLoad(html);

  const surfaces: Record<SurfaceName, SurfaceResult> = {
    meta: extractMeta($),
    nav: extractNav($),
    hero: extractHero($),
    main: extractMain($),
    cta: extractCta($),
    footer: extractFooter($),
    embeds: extractEmbeds($),
  };

  let weightedScore = 0;
  let totalWeight = 0;
  for (const [name, result] of Object.entries(surfaces) as Array<[SurfaceName, SurfaceResult]>) {
    const weight = surfaceWeights[name] ?? 0;
    weightedScore += (1 - result.english_likelihood) * weight;
    totalWeight += weight;
  }
  if (totalWeight > 0) weightedScore = weightedScore / totalWeight;

  const page_localization_score = Math.round(weightedScore * 1000) / 1000;
  const still_english_flag = page_localization_score < 0.5;

  return {
    locale,
    path: relPath,
    page_localization_score,
    still_english_flag,
    surfaces,
    scannedAt: new Date().toISOString(),
  };
}

// Zero-score page result for missing locale files.
function missingPage(locale: string, relPath: string): V1PageResult {
  const emptySurface: SurfaceResult = { english_likelihood: 0, status: "empty", evidence: [] };
  return {
    locale,
    path: relPath,
    page_localization_score: 0,
    still_english_flag: true,
    missing: true,
    surfaces: {
      meta: emptySurface,
      nav: emptySurface,
      hero: emptySurface,
      main: emptySurface,
      cta: emptySurface,
      footer: emptySurface,
      embeds: emptySurface,
    },
    scannedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Full scan runner — iterates EN_BASELINE_ROUTES x non-EN locales
// ---------------------------------------------------------------------------

function runScan(
  config: I18nParityConfig,
  localeFilter?: string,
  logger?: { info: (msg: string) => void },
): V1Report {
  const localeConf = loadLocaleConfig(config.repoPath, config.localeConfigFile);
  const nonEnLocales = localeConf.supportedLocales.filter((l) => l !== localeConf.defaultLocale);
  const localesToScan = localeFilter ? nonEnLocales.filter((l) => l === localeFilter) : nonEnLocales;

  const baselineRoutes = buildBaselineRoutes(config.repoPath);
  logger?.info(`[i18n-parity] baseline routes: ${baselineRoutes.length}, locales: ${localesToScan.length}`);

  const pages: V1PageResult[] = [];

  for (const locale of localesToScan) {
    const prefix = localeConf.pathPrefixByLocale[locale] ?? `/${locale}`;
    const localeDir = path.join(config.repoPath, prefix.replace(/^\//, ""));

    const localeDirExists = fs.existsSync(localeDir);

    for (const route of baselineRoutes) {
      // Apply exclude patterns
      if (isExcluded(route, config.excludePatterns)) continue;

      if (!localeDirExists) {
        pages.push(missingPage(locale, route));
        continue;
      }

      const absPath = path.join(localeDir, route);
      if (!fs.existsSync(absPath)) {
        pages.push(missingPage(locale, route));
        continue;
      }

      try {
        pages.push(scanPage(absPath, locale, route, config.surfaceWeights));
      } catch (err) {
        logger?.info(
          `[i18n-parity] error scanning ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        pages.push(missingPage(locale, route));
      }
    }

    logger?.info(`[i18n-parity] locale=${locale} scanned ${pages.filter((p) => p.locale === locale).length} pages`);
  }

  // Build per-locale summary
  const summary: Record<string, V1LocaleSummary> = {};
  for (const locale of localesToScan) {
    const localePages = pages.filter((p) => p.locale === locale);
    const scores = localePages.map((p) => p.page_localization_score);
    const above_threshold = localePages.filter((p) => p.page_localization_score >= config.minScore).length;
    const avg_score = scores.length > 0
      ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 1000) / 1000
      : 0;
    const worst_pages = localePages
      .sort((a, b) => a.page_localization_score - b.page_localization_score)
      .slice(0, 5)
      .map((p) => ({ path: p.path, page_localization_score: p.page_localization_score }));

    summary[locale] = { total_pages: localePages.length, above_threshold, avg_score, worst_pages };
  }

  const generated_at = new Date().toISOString();

  return {
    schema_version: 1,
    generated_at,
    config: {
      min_score: config.minScore,
      locales_scanned: localesToScan,
    },
    localization: { summary, pages },
    analytics: null,
    search_console: null,
  };
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("ocho.i18n-parity setup complete");

    // Data handler for UI components
    ctx.data.register("i18n-parity-report", async () => {
      if (!latestScanKey) return { pages: [], summary: {}, scannedAt: null };
      return scanHistory.get(latestScanKey) ?? { pages: [], summary: {}, scannedAt: null };
    });

    // Tool: run-scan
    ctx.tools.register(
      "run-scan",
      {
        displayName: "Run i18n Parity Scan",
        description: "Scans all baseline-route locale pages and returns parity scores. Params: locale? (filter to one locale).",
        parametersSchema: {
          type: "object",
          properties: {
            locale: { type: "string", description: "Optional: scan only this locale" },
          },
        },
      },
      async (params): Promise<ToolResult> => {
        try {
          const input = params as { locale?: string };
          const config = await getConfig(ctx);
          if (!config.repoPath) return { error: "repoPath is not configured." };

          const report = runScan(config, input.locale, ctx.logger);
          latestScanKey = report.generated_at;
          scanHistory.set(latestScanKey, report);

          const totalPages = report.localization.pages.length;
          const flagged = report.localization.pages.filter((p) => p.still_english_flag).length;
          return {
            content: `Scan complete. ${totalPages} pages across ${report.config.locales_scanned.length} locale(s). ${flagged} still-English pages flagged.`,
            data: report,
          };
        } catch (err) {
          return { error: `run-scan failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    );

    // Tool: get-report
    ctx.tools.register(
      "get-report",
      {
        displayName: "Get Parity Report",
        description: "Returns the full parity report with optional filters.",
        parametersSchema: {
          type: "object",
          properties: {
            locale: { type: "string", description: "Filter pages by locale" },
            minScore: { type: "number", description: "Return only pages below this score" },
            flaggedOnly: { type: "boolean", description: "Return only still_english_flag pages" },
          },
        },
      },
      async (params): Promise<ToolResult> => {
        if (!latestScanKey) return { error: "No scan report available. Run run-scan first." };
        const report = scanHistory.get(latestScanKey)!;
        const input = params as { locale?: string; minScore?: number; flaggedOnly?: boolean };

        let pages = report.localization.pages;
        if (input.locale) pages = pages.filter((p) => p.locale === input.locale);
        if (typeof input.minScore === "number") pages = pages.filter((p) => p.page_localization_score < input.minScore!);
        if (input.flaggedOnly) pages = pages.filter((p) => p.still_english_flag);

        const filtered = { ...report, localization: { ...report.localization, pages } };
        return {
          content: `Report from ${report.generated_at}. ${pages.length} pages returned.`,
          data: filtered,
        };
      },
    );

    // Tool: get-summary
    ctx.tools.register(
      "get-summary",
      {
        displayName: "Get Parity Summary",
        description: "Returns per-locale roll-up: total_pages, above_threshold, avg_score, worst_pages.",
        parametersSchema: {
          type: "object",
          properties: {
            locale: { type: "string", description: "Filter to a specific locale" },
          },
        },
      },
      async (params): Promise<ToolResult> => {
        if (!latestScanKey) return { error: "No scan report available. Run run-scan first." };
        const report = scanHistory.get(latestScanKey)!;
        const input = params as { locale?: string };
        const summary = input.locale
          ? { [input.locale]: report.localization.summary[input.locale] }
          : report.localization.summary;

        const localeCount = Object.keys(summary).length;
        const worstLocale = Object.entries(summary).sort(
          ([, a], [, b]) => a.avg_score - b.avg_score,
        )[0];
        return {
          content: `Summary: ${localeCount} locale(s). Worst: ${worstLocale ? `${worstLocale[0]} (avg ${worstLocale[1].avg_score})` : "n/a"}.`,
          data: summary,
        };
      },
    );

    // Tool: get-page-detail
    ctx.tools.register(
      "get-page-detail",
      {
        displayName: "Get Page Parity Detail",
        description: "Returns per-surface breakdown for a specific locale+path.",
        parametersSchema: {
          type: "object",
          properties: {
            locale: { type: "string" },
            path: { type: "string" },
          },
          required: ["locale", "path"],
        },
      },
      async (params): Promise<ToolResult> => {
        const input = params as { locale?: string; path?: string };
        if (!input.locale || !input.path) return { error: "locale and path are required." };
        if (!latestScanKey) return { error: "No scan report available. Run run-scan first." };
        const report = scanHistory.get(latestScanKey)!;
        const page = report.localization.pages.find(
          (p) => p.locale === input.locale && p.path === input.path,
        );
        if (!page) return { error: `No result for locale=${input.locale} path=${input.path}.` };
        return {
          content: `${input.locale}/${input.path}: score=${page.page_localization_score}, still_english=${page.still_english_flag}`,
          data: page,
        };
      },
    );

    // Tool: create-tickets
    ctx.tools.register(
      "create-tickets",
      {
        displayName: "Create Parity Tickets",
        description: "Creates Paperclip issues for pages below the minScore threshold.",
        parametersSchema: {
          type: "object",
          properties: {
            minScore: { type: "number" },
            dryRun: { type: "boolean" },
            maxTickets: { type: "number", description: "Cap on number of tickets to create" },
          },
        },
      },
      async (params): Promise<ToolResult> => {
        try {
          const input = params as { minScore?: number; dryRun?: boolean; maxTickets?: number };
          if (!latestScanKey) return { error: "No scan report available. Run run-scan first." };
          const report = scanHistory.get(latestScanKey)!;
          const config = await getConfig(ctx);
          const threshold = typeof input.minScore === "number" ? input.minScore : config.minScore;
          const dryRun = input.dryRun === true;
          const maxTickets = typeof input.maxTickets === "number" ? input.maxTickets : undefined;

          let flaggedPages = report.localization.pages.filter((p) => p.page_localization_score < threshold);
          if (maxTickets !== undefined) flaggedPages = flaggedPages.slice(0, maxTickets);

          if (flaggedPages.length === 0) {
            return { content: `No pages below threshold ${threshold}. No tickets needed.`, data: { created: 0 } };
          }

          if (dryRun) {
            return {
              content: `Dry run: ${flaggedPages.length} page(s) would be ticketed.`,
              data: {
                dryRun: true,
                threshold,
                pages: flaggedPages.map((p) => ({ locale: p.locale, path: p.path, page_localization_score: p.page_localization_score })),
              },
            };
          }

          // Group by locale
          const byLocale = new Map<string, typeof flaggedPages>();
          for (const page of flaggedPages) {
            const arr = byLocale.get(page.locale) ?? [];
            arr.push(page);
            byLocale.set(page.locale, arr);
          }

          const companyId = await resolveCompanyId(ctx);
          const created: Array<{ locale: string; issueId: string }> = [];
          for (const [locale, pages] of byLocale.entries()) {
            const pageList = pages.map((p) => `- \`${p.path}\` (score: ${p.page_localization_score})`).join("\n");
            const issue = await ctx.issues.create({
              companyId,
              title: `i18n parity below ${threshold}: ${locale} (${pages.length} pages)`,
              description: `## i18n Parity Issue\n\nLocale **${locale}** has ${pages.length} page(s) with parity score below **${threshold}**.\n\n### Flagged Pages\n${pageList}\n\n*Generated by ocho.i18n-parity on ${report.generated_at}*`,
              priority: "medium",
            });
            created.push({ locale, issueId: issue.id });
          }

          return {
            content: `Created ${created.length} ticket(s) for ${flaggedPages.length} flagged page(s).`,
            data: { created, threshold, flaggedPageCount: flaggedPages.length },
          };
        } catch (err) {
          return { error: `create-tickets failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    );
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!config.repoPath || typeof config.repoPath !== "string" || !config.repoPath.trim()) {
      errors.push("repoPath is required.");
    } else if (!fs.existsSync(config.repoPath as string)) {
      warnings.push(`repoPath does not exist on this machine: ${config.repoPath}`);
    }

    if (
      config.minScore !== undefined &&
      (typeof config.minScore !== "number" || config.minScore < 0 || config.minScore > 1)
    ) {
      errors.push("minScore must be a number between 0 and 1.");
    }

    return { ok: errors.length === 0, warnings, errors };
  },

  async onHealth() {
    return { status: "ok", message: "i18n-parity plugin worker ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
