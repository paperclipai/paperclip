import { getCookiesFromChrome } from './providers/chrome.js';
import { getCookiesFromEdge } from './providers/edge.js';
import { getCookiesFromFirefox } from './providers/firefoxSqlite.js';
import { getCookiesFromInline } from './providers/inline.js';
import { getCookiesFromSafari } from './providers/safariBinaryCookies.js';
import { normalizeOrigins } from './util/origins.js';
const DEFAULT_BROWSERS = ['chrome', 'safari', 'firefox'];
/**
 * Read cookies for a URL from one or more browser backends (and/or inline payloads).
 *
 * Supported backends:
 * - `chrome`: macOS / Windows / Linux (Chromium-based; default discovery targets Google Chrome paths)
 * - `edge`: macOS / Windows / Linux (Chromium-based; default discovery targets Microsoft Edge paths)
 * - `firefox`: macOS / Windows / Linux
 * - `safari`: macOS only (`Cookies.binarycookies`)
 *
 * Runtime requirements:
 * - Node >= 22 (uses `node:sqlite`) or Bun (uses `bun:sqlite`)
 *
 * The function returns `{ cookies, warnings }`:
 * - `cookies`: best-effort results, filtered by `url`/`origins` and optional `names` allowlist
 * - `warnings`: non-fatal diagnostics (no raw cookie values)
 */
export async function getCookies(options) {
    const warnings = [];
    const url = options.url;
    const origins = normalizeOrigins(url, options.origins);
    const names = normalizeNames(options.names);
    let browsers;
    if (Array.isArray(options.browsers) && options.browsers.length > 0) {
        browsers = options.browsers;
    }
    else {
        browsers = parseBrowsersEnv() ?? DEFAULT_BROWSERS;
    }
    const mode = options.mode ?? parseModeEnv() ?? 'merge';
    const inlineSources = await resolveInlineSources(options);
    // Inline sources are the most reliable path (they bypass DB locks + keychain prompts).
    // We short-circuit on the first inline source that yields any cookies.
    for (const source of inlineSources) {
        const inlineResult = await getCookiesFromInline(source, origins, names);
        warnings.push(...inlineResult.warnings);
        if (inlineResult.cookies.length) {
            return { cookies: inlineResult.cookies, warnings };
        }
    }
    const merged = new Map();
    const tryAdd = (cookie) => {
        // Dedupe by name+domain+path (a common stable identity for HTTP cookies).
        const domain = cookie.domain ?? '';
        const pathValue = cookie.path ?? '';
        const key = `${cookie.name}|${domain}|${pathValue}`;
        if (!merged.has(key)) {
            merged.set(key, cookie);
        }
    };
    for (const browser of browsers) {
        let result;
        if (browser === 'chrome') {
            const chromeOptions = {};
            const chromeProfile = options.chromeProfile ?? options.profile ?? readEnv('SWEET_COOKIE_CHROME_PROFILE');
            if (chromeProfile)
                chromeOptions.profile = chromeProfile;
            if (options.timeoutMs !== undefined)
                chromeOptions.timeoutMs = options.timeoutMs;
            if (options.includeExpired !== undefined)
                chromeOptions.includeExpired = options.includeExpired;
            if (options.debug !== undefined)
                chromeOptions.debug = options.debug;
            result = await getCookiesFromChrome(chromeOptions, origins, names);
        }
        else if (browser === 'edge') {
            const edgeOptions = {};
            const edgeProfile = options.edgeProfile ??
                options.profile ??
                readEnv('SWEET_COOKIE_EDGE_PROFILE') ??
                readEnv('SWEET_COOKIE_CHROME_PROFILE');
            if (edgeProfile)
                edgeOptions.profile = edgeProfile;
            if (options.timeoutMs !== undefined)
                edgeOptions.timeoutMs = options.timeoutMs;
            if (options.includeExpired !== undefined)
                edgeOptions.includeExpired = options.includeExpired;
            if (options.debug !== undefined)
                edgeOptions.debug = options.debug;
            result = await getCookiesFromEdge(edgeOptions, origins, names);
        }
        else if (browser === 'firefox') {
            const firefoxOptions = {};
            const firefoxProfile = options.firefoxProfile ?? readEnv('SWEET_COOKIE_FIREFOX_PROFILE');
            if (firefoxProfile)
                firefoxOptions.profile = firefoxProfile;
            if (options.includeExpired !== undefined)
                firefoxOptions.includeExpired = options.includeExpired;
            result = await getCookiesFromFirefox(firefoxOptions, origins, names);
        }
        else {
            const safariOptions = {};
            if (options.includeExpired !== undefined)
                safariOptions.includeExpired = options.includeExpired;
            if (options.safariCookiesFile)
                safariOptions.file = options.safariCookiesFile;
            result = await getCookiesFromSafari(safariOptions, origins, names);
        }
        warnings.push(...result.warnings);
        if (mode === 'first' && result.cookies.length) {
            // "first" returns the first backend that produced anything (plus accumulated warnings).
            return { cookies: result.cookies, warnings };
        }
        for (const cookie of result.cookies) {
            tryAdd(cookie);
        }
    }
    return { cookies: Array.from(merged.values()), warnings };
}
/**
 * Convert cookies to an HTTP `Cookie` header value.
 *
 * This is a helper for typical Node fetch clients / HTTP libraries.
 * It does not validate cookie RFC edge cases; it simply joins `name=value` pairs.
 */
export function toCookieHeader(cookies, options = {}) {
    const sort = options.sort ?? 'name';
    const dedupeByName = options.dedupeByName ?? false;
    const items = cookies
        .filter((cookie) => cookie?.name && typeof cookie.value === 'string')
        .map((cookie) => ({ name: cookie.name, value: cookie.value }));
    const ordered = sort === 'name' ? items.slice().sort((a, b) => a.name.localeCompare(b.name)) : items;
    if (!dedupeByName) {
        return ordered.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    }
    const seen = new Set();
    const deduped = [];
    for (const cookie of ordered) {
        const key = cookie.name;
        if (seen.has(key))
            continue;
        seen.add(key);
        deduped.push(cookie);
    }
    return deduped.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}
function normalizeNames(names) {
    if (!names?.length)
        return null;
    const cleaned = names.map((n) => n.trim()).filter(Boolean);
    if (!cleaned.length)
        return null;
    return new Set(cleaned);
}
async function resolveInlineSources(options) {
    const sources = [];
    if (options.inlineCookiesJson) {
        sources.push({ source: 'inline-json', payload: options.inlineCookiesJson });
    }
    if (options.inlineCookiesBase64) {
        sources.push({ source: 'inline-base64', payload: options.inlineCookiesBase64 });
    }
    if (options.inlineCookiesFile) {
        sources.push({ source: 'inline-file', payload: options.inlineCookiesFile });
    }
    return sources;
}
function parseBrowsersEnv() {
    const raw = readEnv('SWEET_COOKIE_BROWSERS') ?? readEnv('SWEET_COOKIE_SOURCES');
    if (!raw)
        return undefined;
    const tokens = raw
        .split(/[,\s]+/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
    const out = [];
    for (const token of tokens) {
        if (token === 'chrome' || token === 'edge' || token === 'firefox' || token === 'safari') {
            if (!out.includes(token))
                out.push(token);
        }
    }
    return out.length ? out : undefined;
}
function parseModeEnv() {
    const raw = readEnv('SWEET_COOKIE_MODE');
    if (!raw)
        return undefined;
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'merge' || normalized === 'first')
        return normalized;
    return undefined;
}
function readEnv(key) {
    const value = process.env[key];
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length ? trimmed : undefined;
}
//# sourceMappingURL=public.js.map