import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeExpiration } from '../../util/expire.js';
import { hostMatchesCookieDomain } from '../../util/hostMatch.js';
import { importNodeSqlite, supportsReadBigInts } from '../../util/nodeSqlite.js';
import { isBunRuntime } from '../../util/runtime.js';
export async function getCookiesFromChromeSqliteDb(options, origins, allowlistNames, decrypt) {
    const warnings = [];
    // Chrome can keep its cookie DB locked and/or rely on WAL sidecars.
    // Copying to a temp dir gives us a stable snapshot that both node:sqlite and bun:sqlite can open.
    const tempDir = mkdtempSync(path.join(tmpdir(), 'sweet-cookie-chrome-'));
    const tempDbPath = path.join(tempDir, 'Cookies');
    try {
        copyFileSync(options.dbPath, tempDbPath);
        // If WAL is enabled, the latest writes might live in `Cookies-wal`/`Cookies-shm`.
        // Copy them too when present so our snapshot reflects the current browser state.
        copySidecar(options.dbPath, `${tempDbPath}-wal`, '-wal');
        copySidecar(options.dbPath, `${tempDbPath}-shm`, '-shm');
    }
    catch (error) {
        rmSync(tempDir, { recursive: true, force: true });
        warnings.push(`Failed to copy Chrome cookie DB: ${error instanceof Error ? error.message : String(error)}`);
        return { cookies: [], warnings };
    }
    try {
        const hosts = origins.map((o) => new URL(o).hostname);
        const where = buildHostWhereClause(hosts, 'host_key');
        const metaVersion = await readChromiumMetaVersion(tempDbPath);
        // Chromium >= 24 stores a 32-byte hash prefix in decrypted cookie values.
        // We detect this via the `meta` table version and strip it when present.
        const stripHashPrefix = metaVersion >= 24;
        const rowsResult = await readChromeRows(tempDbPath, where);
        if (!rowsResult.ok) {
            warnings.push(rowsResult.error);
            return { cookies: [], warnings };
        }
        const collectOptions = {};
        if (options.profile)
            collectOptions.profile = options.profile;
        if (options.includeExpired !== undefined)
            collectOptions.includeExpired = options.includeExpired;
        const cookies = collectChromeCookiesFromRows(rowsResult.rows, collectOptions, hosts, allowlistNames, (encryptedValue) => decrypt(encryptedValue, { stripHashPrefix }), warnings);
        return { cookies: dedupeCookies(cookies), warnings };
    }
    finally {
        rmSync(tempDir, { recursive: true, force: true });
    }
}
function collectChromeCookiesFromRows(rows, options, hosts, allowlistNames, decrypt, warnings) {
    const cookies = [];
    const now = Math.floor(Date.now() / 1000);
    let warnedEncryptedType = false;
    for (const row of rows) {
        const name = typeof row.name === 'string' ? row.name : null;
        if (!name)
            continue;
        if (allowlistNames && allowlistNames.size > 0 && !allowlistNames.has(name))
            continue;
        const hostKey = typeof row.host_key === 'string' ? row.host_key : null;
        if (!hostKey)
            continue;
        if (!hostMatchesAny(hosts, hostKey))
            continue;
        const rowPath = typeof row.path === 'string' ? row.path : '';
        const valueString = typeof row.value === 'string' ? row.value : null;
        let value = valueString;
        if (value === null || value.length === 0) {
            // Many modern Chromium cookies keep `value` empty and only store `encrypted_value`.
            // We decrypt on demand and drop rows we can't interpret.
            const encryptedBytes = getEncryptedBytes(row);
            if (!encryptedBytes) {
                if (!warnedEncryptedType && row.encrypted_value !== undefined) {
                    warnings.push('Chrome cookie encrypted_value is in an unsupported type.');
                    warnedEncryptedType = true;
                }
                continue;
            }
            value = decrypt(encryptedBytes);
        }
        if (value === null)
            continue;
        const expiresRaw = typeof row.expires_utc === 'number' || typeof row.expires_utc === 'bigint'
            ? row.expires_utc
            : tryParseInt(row.expires_utc);
        const expires = normalizeExpiration(expiresRaw ?? undefined);
        if (!options.includeExpired) {
            if (expires && expires < now)
                continue;
        }
        const secure = row.is_secure === 1 ||
            row.is_secure === 1n ||
            row.is_secure === '1' ||
            row.is_secure === true;
        const httpOnly = row.is_httponly === 1 ||
            row.is_httponly === 1n ||
            row.is_httponly === '1' ||
            row.is_httponly === true;
        const sameSite = normalizeChromiumSameSite(row.samesite);
        const source = { browser: 'chrome' };
        if (options.profile)
            source.profile = options.profile;
        const cookie = {
            name,
            value,
            domain: hostKey.startsWith('.') ? hostKey.slice(1) : hostKey,
            path: rowPath || '/',
            secure,
            httpOnly,
            source,
        };
        if (expires !== undefined)
            cookie.expires = expires;
        if (sameSite !== undefined)
            cookie.sameSite = sameSite;
        cookies.push(cookie);
    }
    return cookies;
}
function tryParseInt(value) {
    if (typeof value === 'bigint') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    if (typeof value !== 'string')
        return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
}
function normalizeChromiumSameSite(value) {
    if (typeof value === 'bigint') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? normalizeChromiumSameSite(parsed) : undefined;
    }
    if (typeof value === 'number') {
        if (value === 2)
            return 'Strict';
        if (value === 1)
            return 'Lax';
        if (value === 0)
            return 'None';
        return undefined;
    }
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed))
            return normalizeChromiumSameSite(parsed);
        const normalized = value.toLowerCase();
        if (normalized === 'strict')
            return 'Strict';
        if (normalized === 'lax')
            return 'Lax';
        if (normalized === 'none' || normalized === 'no_restriction')
            return 'None';
    }
    return undefined;
}
function getEncryptedBytes(row) {
    const raw = row.encrypted_value;
    if (raw instanceof Uint8Array)
        return raw;
    return null;
}
async function readChromiumMetaVersion(dbPath) {
    const sql = `SELECT value FROM meta WHERE key = 'version'`;
    const result = isBunRuntime()
        ? await queryNodeOrBun({ kind: 'bun', dbPath, sql })
        : await queryNodeOrBun({ kind: 'node', dbPath, sql });
    if (!result.ok)
        return 0;
    const first = result.rows[0];
    const value = first?.value;
    if (typeof value === 'number')
        return Math.floor(value);
    if (typeof value === 'bigint') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? Math.floor(parsed) : 0;
    }
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
}
async function readChromeRows(dbPath, where) {
    const sqliteKind = isBunRuntime() ? 'bun' : 'node';
    const sqliteLabel = sqliteKind === 'bun' ? 'bun:sqlite' : 'node:sqlite';
    const sql = `SELECT name, value, host_key, path, expires_utc, samesite, encrypted_value, ` +
        `is_secure AS is_secure, is_httponly AS is_httponly ` +
        `FROM cookies WHERE (${where}) ORDER BY expires_utc DESC;`;
    const result = await queryNodeOrBun({ kind: sqliteKind, dbPath, sql });
    if (result.ok)
        return { ok: true, rows: result.rows };
    // Intentionally strict: only support modern Chromium cookie DB schemas.
    // If this fails, assume the local Chrome/Chromium is too old or uses a non-standard schema.
    return {
        ok: false,
        error: `${sqliteLabel} failed reading Chrome cookies (requires modern Chromium, e.g. Chrome >= 100): ${result.error}`,
    };
}
async function queryNodeOrBun(options) {
    try {
        if (options.kind === 'node') {
            // Node's `node:sqlite` is synchronous and returns plain JS values. Keep it boxed in a
            // small scope so callers don't need to care about runtime differences.
            const { DatabaseSync } = await importNodeSqlite();
            const dbOptions = { readOnly: true };
            if (supportsReadBigInts()) {
                dbOptions.readBigInts = true;
            }
            const db = new DatabaseSync(options.dbPath, dbOptions);
            try {
                const rows = db.prepare(options.sql).all();
                return { ok: true, rows };
            }
            finally {
                db.close();
            }
        }
        // Bun's sqlite API has a different surface (`Database` + `.query().all()`).
        const { Database } = await import('bun:sqlite');
        const db = new Database(options.dbPath, { readonly: true });
        try {
            const rows = db.query(options.sql).all();
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
function buildHostWhereClause(hosts, column) {
    const clauses = [];
    for (const host of hosts) {
        // Chrome cookies often live on parent domains (e.g. .google.com for gemini.google.com).
        // Include parent domains so the SQL filter doesn't drop valid session cookies.
        for (const candidate of expandHostCandidates(host)) {
            const escaped = sqlLiteral(candidate);
            const escapedDot = sqlLiteral(`.${candidate}`);
            const escapedLike = sqlLiteral(`%.${candidate}`);
            clauses.push(`${column} = ${escaped}`);
            clauses.push(`${column} = ${escapedDot}`);
            clauses.push(`${column} LIKE ${escapedLike}`);
        }
    }
    return clauses.length ? clauses.join(' OR ') : '1=0';
}
function sqlLiteral(value) {
    const escaped = value.replaceAll("'", "''");
    return `'${escaped}'`;
}
function expandHostCandidates(host) {
    const parts = host.split('.').filter(Boolean);
    if (parts.length <= 1)
        return [host];
    const candidates = new Set();
    candidates.add(host);
    // Include parent domains down to two labels (avoid TLD-only fragments).
    for (let i = 1; i <= parts.length - 2; i += 1) {
        const candidate = parts.slice(i).join('.');
        if (candidate)
            candidates.add(candidate);
    }
    return Array.from(candidates);
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
//# sourceMappingURL=shared.js.map