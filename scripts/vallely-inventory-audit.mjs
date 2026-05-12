#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const DEFAULT_BASE_URL = "https://www.vallelymarine.com";
const DEFAULT_REPORT_FILE = "reports/vallely-inventory-feed-audit.md";
const DEFAULT_STALE_DAYS = 7;
const DEFAULT_THRESHOLD_PERCENT = 5;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_USER_AGENT = "paperclip-vallely-inventory-audit/1.0";

function usage() {
  return `Usage: node scripts/vallely-inventory-audit.mjs [options]

Options:
  --base-url <url>          Site root (default: ${DEFAULT_BASE_URL})
  --input-file <json>       Use a saved raw audit payload instead of fetching live data
  --output <path>           Markdown report path (default: ${DEFAULT_REPORT_FILE})
  --json-output <path>      Optional normalized JSON result path
  --alert-only              Evaluate thresholds and post an alert, but do not write the report
  --no-alert                Skip Paperclip alert posting
  --concurrency <number>    Detail-page fetch concurrency (default: ${DEFAULT_CONCURRENCY})
  --stale-days <number>     Staleness threshold (default: ${DEFAULT_STALE_DAYS})
  --threshold-percent <n>   Alert threshold for stale/missing-photo percent (default: ${DEFAULT_THRESHOLD_PERCENT})

Alert env:
  PAPERCLIP_API_URL, PAPERCLIP_API_KEY, VALLELY_INVENTORY_ALERT_ISSUE_ID
  Optional: PAPERCLIP_RUN_ID, VALLELY_INVENTORY_ALERT_CTO_AGENT_ID
`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    if (arg === "--alert-only") {
      args.alertOnly = true;
      continue;
    }
    if (arg === "--no-alert") {
      args.noAlert = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    args[arg.slice(2)] = value;
    index += 1;
  }
  return args;
}

function parsePositiveNumber(value, fallback) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Expected a positive number, got ${value}`);
  return parsed;
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function decodeXml(value) {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

function stripHtml(value) {
  return decodeXml(String(value).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseSitemap(xml, inventoryKind) {
  const entries = [];
  const urlPattern = /<url>\s*<loc>([\s\S]*?)<\/loc>\s*<lastmod>([\s\S]*?)<\/lastmod>[\s\S]*?<\/url>/gi;
  for (const match of xml.matchAll(urlPattern)) {
    const url = decodeXml(match[1].trim());
    const id = url.match(/-(\d+)(?:[/?#].*)?$/)?.[1] ?? null;
    entries.push({
      id,
      url,
      inventoryKind,
      lastUpdatedAt: match[2].trim(),
    });
  }
  return entries;
}

function parseMoney(value) {
  if (!value) return null;
  const cleaned = String(value).replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseJsonAssignment(html, variableName) {
  const pattern = new RegExp(`(?:var|window\\.)\\s*${variableName}\\s*=\\s*(\\{[\\s\\S]*?\\});`);
  const match = html.match(pattern);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function parseUtagData(html) {
  const match = html.match(/window\.utag_data\s*=\s*(\{[\s\S]*?\});/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function uniqueImageUrls(html) {
  const urls = new Set();
  for (const match of html.matchAll(/(?:src=|background-image:url\()["']?([^"')\s>]+)["']?/gi)) {
    const url = decodeXml(match[1]);
    if (!/\.(?:jpg|jpeg|png|webp)(?:[?#].*)?$/i.test(url)) continue;
    if (/no-image|template\/|logo|favicon|badge|certified/i.test(url)) continue;
    if (!/cdn\.dealerspike\.com\/imglib/i.test(url)) continue;
    urls.add(url.replace(/^\/\//, "https://"));
  }
  return [...urls];
}

function productMediaHtml(html) {
  const match = html.match(/<div id="invUnitSlider"[\s\S]*?<\/div><!-- \.invUnitImgSlider -->/i);
  return match?.[0] ?? "";
}

function parseLabeledUnitValues(html) {
  const values = {};
  const unitPattern = /<li[^>]*class=["'][^"']*liUnit[^"']*["'][^>]*>\s*<label[^>]*>([\s\S]*?)<\/label>\s*<span[^>]*>([\s\S]*?)<\/span>/gi;
  for (const match of html.matchAll(unitPattern)) {
    const label = stripHtml(match[1]).replace(/:$/, "");
    if (label) values[label] = stripHtml(match[2]);
  }
  return values;
}

export function normalizeListing(entry, detail = {}, now = new Date(), options = {}) {
  const staleDays = parsePositiveNumber(options.staleDays, DEFAULT_STALE_DAYS);
  const lastUpdatedAt = entry.lastUpdatedAt ? new Date(`${entry.lastUpdatedAt}T00:00:00.000Z`) : null;
  const ageDays = lastUpdatedAt && Number.isFinite(lastUpdatedAt.getTime())
    ? Math.floor((now.getTime() - lastUpdatedAt.getTime()) / 86_400_000)
    : null;
  const salePrice = parseMoney(detail.salePrice ?? detail.productPrice);
  const retailPrice = parseMoney(detail.retailPrice);
  const msrp = parseMoney(detail.msrp ?? detail.productMsrp);
  const publicPrice = salePrice ?? retailPrice ?? null;
  const photoCount = Number.isFinite(Number(detail.photoCount)) ? Number(detail.photoCount) : 0;
  const detailProductId = detail.productId ? String(detail.productId) : null;

  return {
    id: entry.id ?? detailProductId,
    title: detail.title ?? null,
    url: entry.url,
    inventoryKind: entry.inventoryKind,
    lastUpdatedAt: entry.lastUpdatedAt ?? null,
    ageDays,
    stale: ageDays === null ? true : ageDays > staleDays,
    photoCount,
    missingPhotos: photoCount < 1,
    publicPrice,
    msrp,
    missingPrice: publicPrice === null,
    stockNumber: detail.stockNumber ?? null,
    make: detail.make ?? null,
    model: detail.model ?? null,
    location: detail.location ?? null,
    status: detail.status ?? null,
    publicFeedSyncStatus: detail.fetchOk && (!entry.id || !detailProductId || entry.id === detailProductId)
      ? "public_detail_synced"
      : "public_detail_not_verified",
    manufacturerPortalSyncStatus: "not_exposed_in_public_feed",
    detailError: detail.error ?? null,
  };
}

export function parseInventoryDetail(html, url) {
  const vehicle = parseJsonAssignment(html, "vehicle") ?? {};
  const utag = parseUtagData(html) ?? {};
  const values = parseLabeledUnitValues(html);
  const images = uniqueImageUrls(productMediaHtml(html));
  const productImage = typeof utag.product_image_url === "string" && !/no-image/i.test(utag.product_image_url)
    ? utag.product_image_url
    : null;
  const imageCount = new Set([...images, productImage].filter(Boolean)).size;

  return {
    fetchOk: true,
    url,
    title: stripHtml(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? utag.product_name ?? vehicle.bike ?? ""),
    productId: utag.product_id ? String(utag.product_id) : url.match(/-(\d+)(?:[/?#].*)?$/)?.[1] ?? null,
    stockNumber: vehicle.stockno || values["Stock Number"] || null,
    make: vehicle.make || values.Make || utag.product_make || null,
    model: vehicle.model || values.Model || utag.product_model || null,
    location: vehicle.location || values.Location || null,
    status: values.Status || null,
    salePrice: values["Sale Price"] || values["Selling Price"] || null,
    retailPrice: values["Retail Price"] || null,
    msrp: values.MSRP || null,
    productPrice: utag.product_price,
    productMsrp: utag.product_msrp,
    photoCount: imageCount,
  };
}

export function summarizeListings(listings, now = new Date()) {
  const total = listings.length;
  const countWhere = (predicate) => listings.filter(predicate).length;
  const percent = (count) => total === 0 ? 0 : Number(((count / total) * 100).toFixed(2));
  const stale = countWhere((listing) => listing.stale);
  const missingPhotos = countWhere((listing) => listing.missingPhotos);
  const missingPrice = countWhere((listing) => listing.missingPrice);
  const syncUnverified = countWhere((listing) => listing.publicFeedSyncStatus !== "public_detail_synced");

  return {
    generatedAt: now.toISOString(),
    totalListings: total,
    staleListings: stale,
    stalePercent: percent(stale),
    missingPhotos,
    missingPhotosPercent: percent(missingPhotos),
    missingPrice,
    missingPricePercent: percent(missingPrice),
    publicSyncUnverified: syncUnverified,
    publicSyncUnverifiedPercent: percent(syncUnverified),
    byKind: ["new", "pre-owned"].map((kind) => {
      const subset = listings.filter((listing) => listing.inventoryKind === kind);
      return {
        kind,
        total: subset.length,
        stale: subset.filter((listing) => listing.stale).length,
        missingPhotos: subset.filter((listing) => listing.missingPhotos).length,
        missingPrice: subset.filter((listing) => listing.missingPrice).length,
      };
    }),
  };
}

export function evaluateAlert(summary, options = {}) {
  const thresholdPercent = parsePositiveNumber(options.thresholdPercent, DEFAULT_THRESHOLD_PERCENT);
  const breaches = [];
  if (summary.stalePercent > thresholdPercent) {
    breaches.push(`stale inventory ${summary.stalePercent}% > ${thresholdPercent}%`);
  }
  if (summary.missingPhotosPercent > thresholdPercent) {
    breaches.push(`missing photos ${summary.missingPhotosPercent}% > ${thresholdPercent}%`);
  }
  return {
    alert: breaches.length > 0,
    breaches,
    thresholdPercent,
  };
}

function markdownTable(rows, columns) {
  const header = `| ${columns.map((column) => column.label).join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${columns.map((column) => String(column.value(row) ?? "").replaceAll("|", "\\|")).join(" | ")} |`);
  return [header, divider, ...body].join("\n");
}

export function buildMarkdownReport(audit, options = {}) {
  const { summary, listings } = audit;
  const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
  const thresholdPercent = options.thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT;
  const topStale = [...listings]
    .filter((listing) => listing.stale)
    .sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1))
    .slice(0, 25);
  const missingPhotoSample = listings.filter((listing) => listing.missingPhotos).slice(0, 25);
  const missingPriceSample = listings.filter((listing) => listing.missingPrice).slice(0, 25);

  return `# Vallely Marine Inventory Feed Freshness + Completeness Audit

Generated: ${summary.generatedAt}

## Summary

- Total listings: ${summary.totalListings}
- Stale listings >${staleDays} days: ${summary.staleListings} (${summary.stalePercent}%)
- Missing photos: ${summary.missingPhotos} (${summary.missingPhotosPercent}%)
- Missing public price: ${summary.missingPrice} (${summary.missingPricePercent}%)
- Public detail sync unverified: ${summary.publicSyncUnverified} (${summary.publicSyncUnverifiedPercent}%)
- Alert threshold: stale >${thresholdPercent}% or missing photos >${thresholdPercent}%

## Feed Coverage

${markdownTable(summary.byKind, [
  { label: "Feed", value: (row) => row.kind },
  { label: "Listings", value: (row) => row.total },
  { label: "Stale", value: (row) => row.stale },
  { label: "Missing photos", value: (row) => row.missingPhotos },
  { label: "Missing public price", value: (row) => row.missingPrice },
])}

## Method

- Freshness source: public inventory sitemaps \`default.asp?page=xsitemap&s=NewInventory\` and \`default.asp?page=xsitemap&s=PreOwnedInventory\`.
- Photo source: public detail page Dealer Spike image URLs, excluding generic no-image/template/logo assets.
- Price source: explicit sale/retail/product price values. Listings that only show MSRP or "Click for a Quote" count as missing public price.
- Sync source: detail page availability and matching product id. Manufacturer portal sync status is not exposed in the public feed, so every row records \`not_exposed_in_public_feed\`.

## Oldest Stale Listings

${topStale.length ? markdownTable(topStale, listingColumns()) : "No stale listings found."}

## Missing Photo Sample

${missingPhotoSample.length ? markdownTable(missingPhotoSample, listingColumns()) : "No missing-photo listings found."}

## Missing Price Sample

${missingPriceSample.length ? markdownTable(missingPriceSample, listingColumns()) : "No missing-price listings found."}
`;
}

function listingColumns() {
  return [
    { label: "ID", value: (row) => row.id },
    { label: "Kind", value: (row) => row.inventoryKind },
    { label: "Age days", value: (row) => row.ageDays },
    { label: "Photos", value: (row) => row.photoCount },
    { label: "Public price", value: (row) => row.publicPrice ? `$${row.publicPrice}` : "" },
    { label: "Stock", value: (row) => row.stockNumber },
    { label: "Title", value: (row) => row.title },
    { label: "URL", value: (row) => row.url },
  ];
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": DEFAULT_USER_AGENT,
    },
  });
  if (!response.ok) throw new Error(`${url} failed with HTTP ${response.status}`);
  return response.text();
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function runAudit(options = {}) {
  const now = options.now ?? new Date();
  const staleDays = parsePositiveNumber(options.staleDays, DEFAULT_STALE_DAYS);
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  let entries;
  let detailsById = new Map();

  if (options.inputFile) {
    const raw = JSON.parse(await readFile(options.inputFile, "utf8"));
    if (raw?.summary && Array.isArray(raw?.listings)) {
      return raw;
    }
    entries = raw.entries;
    detailsById = new Map((raw.details ?? []).map((detail) => [String(detail.id ?? detail.productId), detail]));
  } else {
    const [newXml, preOwnedXml] = await Promise.all([
      fetchText(`${baseUrl}/default.asp?page=xsitemap&s=NewInventory`),
      fetchText(`${baseUrl}/default.asp?page=xsitemap&s=PreOwnedInventory`),
    ]);
    entries = [
      ...parseSitemap(newXml, "new"),
      ...parseSitemap(preOwnedXml, "pre-owned"),
    ];
    const details = await mapWithConcurrency(
      entries,
      parsePositiveNumber(options.concurrency, DEFAULT_CONCURRENCY),
      async (entry) => {
        try {
          return {
            id: entry.id,
            ...parseInventoryDetail(await fetchText(entry.url), entry.url),
          };
        } catch (error) {
          return { id: entry.id, fetchOk: false, error: error.message };
        }
      },
    );
    detailsById = new Map(details.map((detail) => [String(detail.id ?? detail.productId), detail]));
  }

  const listings = entries.map((entry) => normalizeListing(entry, detailsById.get(String(entry.id)) ?? {}, now, { staleDays }));
  const summary = summarizeListings(listings, now);
  return { summary, listings };
}

async function writeText(filePath, body) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body, "utf8");
}

async function postPaperclipAlert(audit, alertEvaluation, options = {}) {
  const apiUrl = process.env.PAPERCLIP_API_URL?.replace(/\/+$/, "");
  const apiKey = process.env.PAPERCLIP_API_KEY;
  const issueId = process.env.VALLELY_INVENTORY_ALERT_ISSUE_ID || options.issueId;
  if (!apiUrl || !apiKey || !issueId || !alertEvaluation.alert) return false;

  const ctoAgentId = process.env.VALLELY_INVENTORY_ALERT_CTO_AGENT_ID;
  const mention = ctoAgentId ? `[@CTO](agent://${ctoAgentId}) ` : "";
  const body = `## Vallely inventory audit alert

${mention}Inventory quality thresholds were breached.

- Breaches: ${alertEvaluation.breaches.join("; ")}
- Total listings: ${audit.summary.totalListings}
- Stale >7 days: ${audit.summary.staleListings} (${audit.summary.stalePercent}%)
- Missing photos: ${audit.summary.missingPhotos} (${audit.summary.missingPhotosPercent}%)
- Missing public price: ${audit.summary.missingPrice} (${audit.summary.missingPricePercent}%)
- Owner action: inspect Dealer Spike inventory sync and add listing photos/prices for the affected units.
`;

  const response = await fetch(`${apiUrl}/api/issues/${issueId}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(process.env.PAPERCLIP_RUN_ID ? { "X-Paperclip-Run-Id": process.env.PAPERCLIP_RUN_ID } : {}),
    },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) throw new Error(`Paperclip alert comment failed with HTTP ${response.status}: ${await response.text()}`);
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const staleDays = parsePositiveNumber(args["stale-days"], DEFAULT_STALE_DAYS);
  const thresholdPercent = parsePositiveNumber(args["threshold-percent"], DEFAULT_THRESHOLD_PERCENT);
  const audit = await runAudit({
    baseUrl: args["base-url"],
    inputFile: args["input-file"],
    concurrency: args.concurrency,
    staleDays,
  });
  const alertEvaluation = evaluateAlert(audit.summary, { thresholdPercent });

  if (!args.alertOnly) {
    const output = args.output || DEFAULT_REPORT_FILE;
    await writeText(output, buildMarkdownReport(audit, { staleDays, thresholdPercent }));
    if (args["json-output"]) {
      await writeText(args["json-output"], `${JSON.stringify(audit, null, 2)}\n`);
    }
  }
  if (!args.noAlert) {
    await postPaperclipAlert(audit, alertEvaluation);
  }

  console.log(JSON.stringify({ summary: audit.summary, alert: alertEvaluation }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
