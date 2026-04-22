import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { JSDOM } from "jsdom";
import type { ProjectQuickLinkPreview } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

const MAX_REDIRECTS = 3;
const MAX_HTML_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 3_000;
const MAX_TITLE_LENGTH = 160;
const MAX_SITE_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 500;

type LookupAddress = { address: string; family: number };
type LookupHost = (hostname: string) => Promise<LookupAddress[]>;
type FetchImpl = typeof fetch;

export type ProjectQuickLinkPreviewFetcher = (url: string) => Promise<ProjectQuickLinkPreview>;

export type ProjectQuickLinkPreviewFetcherOptions = {
  fetchImpl?: FetchImpl;
  lookupHost?: LookupHost;
};

function cleanText(value: string | null | undefined, maxLength: number): string | null {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trimEnd() : cleaned;
}

function normalizeHostname(hostname: string) {
  return hostname.replace(/^\[|\]$/g, "").trim().toLowerCase();
}

function ipv4ToNumber(address: string) {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return parts.reduce((acc, part) => (acc << 8) + part, 0) >>> 0;
}

function isIpv4InRange(value: number, base: string, prefix: number) {
  const baseNumber = ipv4ToNumber(base);
  if (baseNumber === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseNumber & mask);
}

function isBlockedIpv4(address: string) {
  const value = ipv4ToNumber(address);
  if (value === null) return true;
  return [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ].some(([base, prefix]) => isIpv4InRange(value, base as string, prefix as number));
}

function isBlockedIpv6(address: string) {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  if (normalized.startsWith("::ffff:")) {
    const mappedIpv4 = normalized.slice("::ffff:".length);
    return isBlockedIpv4(mappedIpv4);
  }
  return false;
}

function isBlockedAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

async function defaultLookupHost(hostname: string): Promise<LookupAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

async function assertSafeFetchUrl(rawUrl: string, lookupHost: LookupHost) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw unprocessable("Link preview URL is invalid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw unprocessable("Link preview URL must use http or https.");
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw unprocessable("Link preview cannot fetch local or private hosts.");
  }

  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw unprocessable("Link preview cannot fetch local or private hosts.");
    }
    return parsed;
  }

  let addresses: LookupAddress[];
  try {
    addresses = await lookupHost(hostname);
  } catch {
    throw unprocessable("Link preview host could not be resolved.");
  }
  if (addresses.length === 0 || addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw unprocessable("Link preview cannot fetch local or private hosts.");
  }
  return parsed;
}

function resolveMetadataUrl(value: string | null, baseUrl: string): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value.trim(), baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

async function readHtmlWithLimit(response: Response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let html = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_HTML_BYTES) {
      html += decoder.decode(value.slice(0, Math.max(0, value.byteLength - (totalBytes - MAX_HTML_BYTES))), { stream: true });
      await reader.cancel().catch(() => {});
      break;
    }
    html += decoder.decode(value, { stream: true });
  }

  html += decoder.decode();
  return html;
}

async function fetchHtml(
  rawUrl: string,
  opts: { fetchImpl: FetchImpl; lookupHost: LookupHost; redirectCount?: number },
): Promise<{ finalUrl: string; html: string }> {
  const parsed = await assertSafeFetchUrl(rawUrl, opts.lookupHost);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await opts.fetchImpl(parsed.toString(), {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "PaperclipLinkPreview/1.0",
      },
      redirect: "manual",
      signal: controller.signal,
    });
  } catch {
    throw unprocessable("Link preview could not fetch this URL.");
  } finally {
    clearTimeout(timeout);
  }

  if (response.status >= 300 && response.status < 400) {
    const nextUrl = response.headers.get("location");
    if (!nextUrl) throw unprocessable("Link preview redirect did not include a destination.");
    const redirectCount = opts.redirectCount ?? 0;
    if (redirectCount >= MAX_REDIRECTS) throw unprocessable("Link preview followed too many redirects.");
    return fetchHtml(new URL(nextUrl, parsed.toString()).toString(), {
      ...opts,
      redirectCount: redirectCount + 1,
    });
  }

  if (!response.ok) throw unprocessable("Link preview could not fetch this URL.");
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
    throw unprocessable("Link preview only supports HTML pages.");
  }

  return {
    finalUrl: parsed.toString(),
    html: await readHtmlWithLimit(response),
  };
}

function extractMetadata(html: string, finalUrl: string): ProjectQuickLinkPreview {
  const dom = new JSDOM(html, { url: finalUrl });
  const document = dom.window.document;
  const meta = (selector: string) => document.querySelector<HTMLMetaElement>(selector)?.content ?? null;
  const linkHref = (selector: string) => document.querySelector<HTMLLinkElement>(selector)?.href ?? null;
  const host = new URL(finalUrl).hostname.replace(/^www\./i, "");

  const title = cleanText(
    meta('meta[property="og:title"]')
      ?? meta('meta[name="twitter:title"]')
      ?? document.querySelector("title")?.textContent
      ?? host,
    MAX_TITLE_LENGTH,
  ) ?? host;

  const siteName = cleanText(meta('meta[property="og:site_name"]') ?? host, MAX_SITE_NAME_LENGTH);
  const description = cleanText(
    meta('meta[property="og:description"]')
      ?? meta('meta[name="twitter:description"]')
      ?? meta('meta[name="description"]'),
    MAX_DESCRIPTION_LENGTH,
  );
  const imageUrl = resolveMetadataUrl(
    meta('meta[property="og:image"]') ?? meta('meta[name="twitter:image"]'),
    finalUrl,
  );
  const faviconUrl =
    resolveMetadataUrl(
      linkHref('link[rel~="icon"]')
        ?? linkHref('link[rel="shortcut icon"]')
        ?? linkHref('link[rel="apple-touch-icon"]')
        ?? "/favicon.ico",
      finalUrl,
    );

  return {
    url: finalUrl,
    title,
    siteName,
    description,
    imageUrl,
    faviconUrl,
  };
}

export function createProjectQuickLinkPreviewFetcher(
  options: ProjectQuickLinkPreviewFetcherOptions = {},
): ProjectQuickLinkPreviewFetcher {
  const fetchImpl = options.fetchImpl ?? fetch;
  const lookupHost = options.lookupHost ?? defaultLookupHost;
  return async (url) => {
    const { finalUrl, html } = await fetchHtml(url, { fetchImpl, lookupHost });
    return extractMetadata(html, finalUrl);
  };
}
