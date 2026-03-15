import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { hostMatchesCookieDomain } from '../util/hostMatch.js';
const MAC_EPOCH_DELTA_SECONDS = 978_307_200;
export async function getCookiesFromSafari(options, origins, allowlistNames) {
    const warnings = [];
    if (process.platform !== 'darwin') {
        return { cookies: [], warnings };
    }
    const cookieFile = options.file ?? resolveSafariBinaryCookiesPath();
    if (!cookieFile) {
        warnings.push('Safari Cookies.binarycookies not found.');
        return { cookies: [], warnings };
    }
    const hosts = origins.map((o) => new URL(o).hostname);
    const now = Math.floor(Date.now() / 1000);
    try {
        const data = readFileSync(cookieFile);
        // Safari's `Cookies.binarycookies` is a small binary container with multiple "pages".
        // We decode only the fields we need (name/value/domain/path/flags/expiry).
        const parsed = decodeBinaryCookies(data);
        const cookies = [];
        for (const cookie of parsed) {
            if (!cookie.name)
                continue;
            if (allowlistNames && allowlistNames.size > 0 && !allowlistNames.has(cookie.name))
                continue;
            const domain = cookie.domain;
            if (!domain)
                continue;
            if (!hosts.some((h) => hostMatchesCookieDomain(h, domain)))
                continue;
            if (!options.includeExpired && cookie.expires && cookie.expires < now)
                continue;
            cookies.push(cookie);
        }
        return { cookies: dedupeCookies(cookies), warnings };
    }
    catch (error) {
        warnings.push(`Failed to read Safari cookies: ${error instanceof Error ? error.message : String(error)}`);
        return { cookies: [], warnings };
    }
}
function resolveSafariBinaryCookiesPath() {
    const home = homedir();
    const candidates = [
        path.join(home, 'Library', 'Cookies', 'Cookies.binarycookies'),
        path.join(home, 'Library', 'Containers', 'com.apple.Safari', 'Data', 'Library', 'Cookies', 'Cookies.binarycookies'),
    ];
    for (const candidate of candidates) {
        if (existsSync(candidate))
            return candidate;
    }
    return null;
}
function decodeBinaryCookies(buffer) {
    if (buffer.length < 8)
        return [];
    if (buffer.subarray(0, 4).toString('utf8') !== 'cook')
        return [];
    const pageCount = buffer.readUInt32BE(4);
    let cursor = 8;
    const pageSizes = [];
    for (let i = 0; i < pageCount; i += 1) {
        pageSizes.push(buffer.readUInt32BE(cursor));
        cursor += 4;
    }
    const cookies = [];
    for (const pageSize of pageSizes) {
        const page = buffer.subarray(cursor, cursor + pageSize);
        cursor += pageSize;
        cookies.push(...decodePage(page));
    }
    return cookies;
}
function decodePage(page) {
    if (page.length < 16)
        return [];
    const header = page.readUInt32BE(0);
    if (header !== 0x00000100)
        return [];
    const cookieCount = page.readUInt32LE(4);
    const offsets = [];
    let cursor = 8;
    for (let i = 0; i < cookieCount; i += 1) {
        offsets.push(page.readUInt32LE(cursor));
        cursor += 4;
    }
    const cookies = [];
    for (const offset of offsets) {
        const cookie = decodeCookie(page.subarray(offset));
        if (cookie)
            cookies.push(cookie);
    }
    return cookies;
}
function decodeCookie(cookieBuffer) {
    if (cookieBuffer.length < 48)
        return null;
    const size = cookieBuffer.readUInt32LE(0);
    if (size < 48 || size > cookieBuffer.length)
        return null;
    const flagsValue = cookieBuffer.readUInt32LE(8);
    const isSecure = (flagsValue & 1) !== 0;
    const isHttpOnly = (flagsValue & 4) !== 0;
    const urlOffset = cookieBuffer.readUInt32LE(16);
    const nameOffset = cookieBuffer.readUInt32LE(20);
    const pathOffset = cookieBuffer.readUInt32LE(24);
    const valueOffset = cookieBuffer.readUInt32LE(28);
    // Safari stores dates as "Mac absolute time" (seconds since 2001-01-01).
    const expiration = readDoubleLE(cookieBuffer, 40);
    const rawUrl = readCString(cookieBuffer, urlOffset, size);
    const name = readCString(cookieBuffer, nameOffset, size);
    const cookiePath = readCString(cookieBuffer, pathOffset, size) ?? '/';
    const value = readCString(cookieBuffer, valueOffset, size) ?? '';
    if (!name)
        return null;
    const domain = rawUrl ? safeHostnameFromUrl(rawUrl) : undefined;
    const expires = expiration && expiration > 0 ? Math.round(expiration + MAC_EPOCH_DELTA_SECONDS) : undefined;
    const decoded = {
        name,
        value,
        path: cookiePath,
        secure: isSecure,
        httpOnly: isHttpOnly,
        source: { browser: 'safari' },
    };
    if (domain)
        decoded.domain = domain;
    if (expires !== undefined)
        decoded.expires = expires;
    return decoded;
}
function readDoubleLE(buffer, offset) {
    if (offset + 8 > buffer.length)
        return 0;
    const slice = buffer.subarray(offset, offset + 8);
    return slice.readDoubleLE(0);
}
function readCString(buffer, offset, end) {
    if (offset <= 0 || offset >= end)
        return null;
    let cursor = offset;
    while (cursor < end && buffer[cursor] !== 0)
        cursor += 1;
    if (cursor >= end)
        return null;
    return buffer.toString('utf8', offset, cursor);
}
function safeHostnameFromUrl(raw) {
    try {
        const url = raw.includes('://') ? raw : `https://${raw}`;
        const parsed = new URL(url);
        return parsed.hostname.startsWith('.') ? parsed.hostname.slice(1) : parsed.hostname;
    }
    catch {
        const cleaned = raw.trim();
        if (!cleaned)
            return undefined;
        return cleaned.startsWith('.') ? cleaned.slice(1) : cleaned;
    }
}
function dedupeCookies(cookies) {
    const merged = new Map();
    for (const cookie of cookies) {
        const key = `${cookie.name}|${cookie.domain ?? ''}|${cookie.path ?? ''}`;
        if (!merged.has(key))
            merged.set(key, cookie);
    }
    return Array.from(merged.values());
}
//# sourceMappingURL=safariBinaryCookies.js.map