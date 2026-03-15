import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { hostMatchesCookieDomain } from '../util/hostMatch.js';
import { importNodeSqlite } from '../util/nodeSqlite.js';
import { isBunRuntime } from '../util/runtime.js';
export async function getCookiesFromFirefox(options, origins, allowlistNames) {
    const warnings = [];
    const dbPath = resolveFirefoxCookiesDb(options.profile);
    if (!dbPath) {
        warnings.push('Firefox cookies database not found.');
        return { cookies: [], warnings };
    }
    const tempDir = mkdtempSync(path.join(tmpdir(), 'sweet-cookie-firefox-'));
    const tempDbPath = path.join(tempDir, 'cookies.sqlite');
    try {
        copyFileSync(dbPath, tempDbPath);
        copySidecar(dbPath, `${tempDbPath}-wal`, '-wal');
        copySidecar(dbPath, `${tempDbPath}-shm`, '-shm');
    }
    catch (error) {
        rmSync(tempDir, { recursive: true, force: true });
        warnings.push(`Failed to copy Firefox cookie DB: ${error instanceof Error ? error.message : String(error)}`);
        return { cookies: [], warnings };
    }
    const hosts = origins.map((o) => new URL(o).hostname);
    const now = Math.floor(Date.now() / 1000);
    const where = buildHostWhereClause(hosts);
    const expiryClause = options.includeExpired ? '' : ` AND (expiry = 0 OR expiry > ${now})`;
    const sql = `SELECT name, value, host, path, expiry, isSecure, isHttpOnly, sameSite ` +
        `FROM moz_cookies WHERE (${where})${expiryClause} ORDER BY expiry DESC;`;
    try {
        if (isBunRuntime()) {
            const bunResult = await queryFirefoxCookiesWithBunSqlite(tempDbPath, sql);
            if (!bunResult.ok) {
                warnings.push(`bun:sqlite failed reading Firefox cookies: ${bunResult.error}`);
                return { cookies: [], warnings };
            }
            const cookies = collectFirefoxCookiesFromRows(bunResult.rows, options, hosts, allowlistNames);
            return { cookies: dedupeCookies(cookies), warnings };
        }
        const nodeResult = await queryFirefoxCookiesWithNodeSqlite(tempDbPath, sql);
        if (!nodeResult.ok) {
            warnings.push(`node:sqlite failed reading Firefox cookies: ${nodeResult.error}`);
            return { cookies: [], warnings };
        }
        const cookies = collectFirefoxCookiesFromRows(nodeResult.rows, options, hosts, allowlistNames);
        return { cookies: dedupeCookies(cookies), warnings };
    }
    finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}
async function queryFirefoxCookiesWithNodeSqlite(dbPath, sql) {
    try {
        const { DatabaseSync } = await importNodeSqlite();
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
            const rows = db.prepare(sql).all();
            return { ok: true, rows };
        }
        finally {
            db.close();
        }
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
async function queryFirefoxCookiesWithBunSqlite(dbPath, sql) {
    try {
        const { Database } = await import('bun:sqlite');
        const db = new Database(dbPath, { readonly: true });
        try {
            const rows = db.query(sql).all();
            return { ok: true, rows };
        }
        finally {
            db.close();
        }
    }
    catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
function collectFirefoxCookiesFromRows(rows, options, hosts, allowlistNames) {
    const now = Math.floor(Date.now() / 1000);
    const cookies = [];
    for (const row of rows) {
        const name = typeof row.name === 'string' ? row.name : null;
        const value = typeof row.value === 'string' ? row.value : null;
        const host = typeof row.host === 'string' ? row.host : null;
        const cookiePath = typeof row.path === 'string' ? row.path : '';
        if (!name || value === null || !host)
            continue;
        if (allowlistNames && allowlistNames.size > 0 && !allowlistNames.has(name))
            continue;
        if (!hostMatchesAny(hosts, host))
            continue;
        const expiryText = typeof row.expiry === 'number'
            ? String(row.expiry)
            : typeof row.expiry === 'string'
                ? row.expiry
                : undefined;
        const expires = normalizeFirefoxExpiry(expiryText);
        if (!options.includeExpired && expires && expires < now)
            continue;
        const isSecure = row.isSecure === 1 || row.isSecure === '1' || row.isSecure === true;
        const isHttpOnly = row.isHttpOnly === 1 || row.isHttpOnly === '1' || row.isHttpOnly === true;
        const cookie = {
            name,
            value,
            domain: host.startsWith('.') ? host.slice(1) : host,
            path: cookiePath || '/',
            secure: isSecure,
            httpOnly: isHttpOnly,
        };
        if (expires !== undefined)
            cookie.expires = expires;
        const normalizedSameSite = normalizeFirefoxSameSite(typeof row.sameSite === 'number'
            ? String(row.sameSite)
            : typeof row.sameSite === 'string'
                ? row.sameSite
                : undefined);
        if (normalizedSameSite !== undefined)
            cookie.sameSite = normalizedSameSite;
        const source = { browser: 'firefox' };
        if (options.profile)
            source.profile = options.profile;
        cookie.source = source;
        cookies.push(cookie);
    }
    return cookies;
}
function resolveFirefoxCookiesDb(profile) {
    const home = homedir();
    // biome-ignore lint/complexity/useLiteralKeys: process.env is an index signature under strict TS.
    const appData = process.env['APPDATA'];
    /* c8 ignore next 10 */
    const roots = process.platform === 'darwin'
        ? [path.join(home, 'Library', 'Application Support', 'Firefox', 'Profiles')]
        : process.platform === 'linux'
            ? [path.join(home, '.mozilla', 'firefox')]
            : process.platform === 'win32'
                ? appData
                    ? [path.join(appData, 'Mozilla', 'Firefox', 'Profiles')]
                    : []
                : [];
    if (profile && looksLikePath(profile)) {
        const candidate = profile.endsWith('cookies.sqlite')
            ? profile
            : path.join(profile, 'cookies.sqlite');
        return existsSync(candidate) ? candidate : null;
    }
    for (const root of roots) {
        if (!root || !existsSync(root))
            continue;
        if (profile) {
            const candidate = path.join(root, profile, 'cookies.sqlite');
            if (existsSync(candidate))
                return candidate;
            continue;
        }
        const entries = safeReaddir(root);
        const defaultRelease = entries.find((e) => e.includes('default-release'));
        const picked = defaultRelease ?? entries[0];
        if (!picked)
            continue;
        const candidate = path.join(root, picked, 'cookies.sqlite');
        if (existsSync(candidate))
            return candidate;
    }
    return null;
}
function safeReaddir(dir) {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
    }
    catch {
        return [];
    }
}
function looksLikePath(value) {
    return value.includes('/') || value.includes('\\');
}
function copySidecar(sourceDbPath, target, suffix) {
    const sidecar = `${sourceDbPath}${suffix}`;
    if (!existsSync(sidecar))
        return;
    try {
        copyFileSync(sidecar, target);
    }
    catch {
        // ignore
    }
}
function buildHostWhereClause(hosts) {
    const clauses = [];
    for (const host of hosts) {
        const escaped = sqlLiteral(host);
        const escapedDot = sqlLiteral(`.${host}`);
        const escapedLike = sqlLiteral(`%.${host}`);
        clauses.push(`host = ${escaped}`);
        clauses.push(`host = ${escapedDot}`);
        clauses.push(`host LIKE ${escapedLike}`);
    }
    return clauses.length ? clauses.join(' OR ') : '1=0';
}
function sqlLiteral(value) {
    const escaped = value.replaceAll("'", "''");
    return `'${escaped}'`;
}
function normalizeFirefoxExpiry(expiry) {
    if (!expiry)
        return undefined;
    const value = Number.parseInt(expiry, 10);
    if (!Number.isFinite(value) || value <= 0)
        return undefined;
    return value;
}
function normalizeFirefoxSameSite(raw) {
    if (!raw)
        return undefined;
    const value = Number.parseInt(raw, 10);
    if (Number.isFinite(value)) {
        if (value === 2)
            return 'Strict';
        if (value === 1)
            return 'Lax';
        if (value === 0)
            return 'None';
    }
    const normalized = raw.toLowerCase();
    if (normalized === 'strict')
        return 'Strict';
    if (normalized === 'lax')
        return 'Lax';
    if (normalized === 'none')
        return 'None';
    return undefined;
}
function hostMatchesAny(hosts, cookieHost) {
    const cookieDomain = cookieHost.startsWith('.') ? cookieHost.slice(1) : cookieHost;
    return hosts.some((host) => hostMatchesCookieDomain(host, cookieDomain));
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
//# sourceMappingURL=firefoxSqlite.js.map