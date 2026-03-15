import path from 'node:path';
import { decryptChromiumAes256GcmCookieValue } from './chromeSqlite/crypto.js';
import { getCookiesFromChromeSqliteDb } from './chromeSqlite/shared.js';
import { getWindowsChromiumMasterKey } from './chromium/windowsMasterKey.js';
import { resolveChromiumPathsWindows } from './chromium/windowsPaths.js';
export async function getCookiesFromEdgeSqliteWindows(options, origins, allowlistNames) {
    const resolveArgs = {
        localAppDataVendorPath: path.join('Microsoft', 'Edge', 'User Data'),
    };
    if (options.profile !== undefined)
        resolveArgs.profile = options.profile;
    const { dbPath, userDataDir } = resolveChromiumPathsWindows(resolveArgs);
    if (!dbPath || !userDataDir) {
        return { cookies: [], warnings: ['Edge cookies database not found.'] };
    }
    // On Windows, Edge stores an AES key in `Local State` encrypted with DPAPI (CurrentUser).
    // That master key is then used for AES-256-GCM cookie values (`v10`/`v11`/`v20` prefixes).
    const masterKey = await getWindowsChromiumMasterKey(userDataDir, 'Edge');
    if (!masterKey.ok) {
        return { cookies: [], warnings: [masterKey.error] };
    }
    const decrypt = (encryptedValue, opts) => {
        return decryptChromiumAes256GcmCookieValue(encryptedValue, masterKey.value, {
            stripHashPrefix: opts.stripHashPrefix,
        });
    };
    const dbOptions = {
        dbPath,
    };
    if (options.profile)
        dbOptions.profile = options.profile;
    if (options.includeExpired !== undefined)
        dbOptions.includeExpired = options.includeExpired;
    if (options.debug !== undefined)
        dbOptions.debug = options.debug;
    return await getCookiesFromChromeSqliteDb(dbOptions, origins, allowlistNames, decrypt);
}
//# sourceMappingURL=edgeSqliteWindows.js.map