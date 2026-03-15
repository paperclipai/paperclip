import { homedir } from 'node:os';
import path from 'node:path';
import { decryptChromiumAes128CbcCookieValue, deriveAes128CbcKeyFromPassword, } from './chromeSqlite/crypto.js';
import { getCookiesFromChromeSqliteDb } from './chromeSqlite/shared.js';
import { readKeychainGenericPasswordFirst } from './chromium/macosKeychain.js';
import { resolveCookiesDbFromProfileOrRoots } from './chromium/paths.js';
export async function getCookiesFromEdgeSqliteMac(options, origins, allowlistNames) {
    const dbPath = resolveEdgeCookiesDb(options.profile);
    if (!dbPath) {
        return { cookies: [], warnings: ['Edge cookies database not found.'] };
    }
    const warnings = [];
    // On macOS, Edge stores its "Safe Storage" secret in Keychain (same scheme as Chrome).
    // `security find-generic-password` is stable and avoids any native Node keychain modules.
    const passwordResult = await readKeychainGenericPasswordFirst({
        account: 'Microsoft Edge',
        services: ['Microsoft Edge Safe Storage', 'Microsoft Edge'],
        timeoutMs: options.timeoutMs ?? 3_000,
        label: 'Microsoft Edge Safe Storage',
    });
    if (!passwordResult.ok) {
        warnings.push(passwordResult.error);
        return { cookies: [], warnings };
    }
    const edgePassword = passwordResult.password.trim();
    if (!edgePassword) {
        warnings.push('macOS Keychain returned an empty Microsoft Edge Safe Storage password.');
        return { cookies: [], warnings };
    }
    // Chromium uses PBKDF2(password, "saltysalt", 1003, 16, sha1) for AES-128-CBC cookie values on macOS.
    const key = deriveAes128CbcKeyFromPassword(edgePassword, { iterations: 1003 });
    const decrypt = (encryptedValue, opts) => decryptChromiumAes128CbcCookieValue(encryptedValue, [key], {
        stripHashPrefix: opts.stripHashPrefix,
        treatUnknownPrefixAsPlaintext: true,
    });
    const dbOptions = {
        dbPath,
    };
    if (options.profile)
        dbOptions.profile = options.profile;
    if (options.includeExpired !== undefined)
        dbOptions.includeExpired = options.includeExpired;
    if (options.debug !== undefined)
        dbOptions.debug = options.debug;
    const result = await getCookiesFromChromeSqliteDb(dbOptions, origins, allowlistNames, decrypt);
    result.warnings.unshift(...warnings);
    return result;
}
function resolveEdgeCookiesDb(profile) {
    const home = homedir();
    /* c8 ignore next */
    const roots = process.platform === 'darwin'
        ? [path.join(home, 'Library', 'Application Support', 'Microsoft Edge')]
        : [];
    const args = { roots };
    if (profile !== undefined)
        args.profile = profile;
    return resolveCookiesDbFromProfileOrRoots(args);
}
//# sourceMappingURL=edgeSqliteMac.js.map