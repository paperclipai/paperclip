import { decryptChromiumAes128CbcCookieValue, deriveAes128CbcKeyFromPassword, } from './chromeSqlite/crypto.js';
import { getLinuxChromeSafeStoragePassword } from './chromeSqlite/linuxKeyring.js';
import { getCookiesFromChromeSqliteDb } from './chromeSqlite/shared.js';
import { resolveChromiumCookiesDbLinux } from './chromium/linuxPaths.js';
export async function getCookiesFromChromeSqliteLinux(options, origins, allowlistNames) {
    const args = {
        configDirName: 'google-chrome',
    };
    if (options.profile !== undefined)
        args.profile = options.profile;
    const dbPath = resolveChromiumCookiesDbLinux(args);
    if (!dbPath) {
        return { cookies: [], warnings: ['Chrome cookies database not found.'] };
    }
    const { password, warnings: keyringWarnings } = await getLinuxChromeSafeStoragePassword();
    // Linux uses multiple schemes depending on distro/keyring availability.
    // - v10 often uses the hard-coded "peanuts" password
    // - v11 uses "Chrome Safe Storage" from the keyring (may be empty/unavailable)
    const v10Key = deriveAes128CbcKeyFromPassword('peanuts', { iterations: 1 });
    const emptyKey = deriveAes128CbcKeyFromPassword('', { iterations: 1 });
    const v11Key = deriveAes128CbcKeyFromPassword(password, { iterations: 1 });
    const decrypt = (encryptedValue, opts) => {
        const prefix = Buffer.from(encryptedValue).subarray(0, 3).toString('utf8');
        if (prefix === 'v10') {
            return decryptChromiumAes128CbcCookieValue(encryptedValue, [v10Key, emptyKey], {
                stripHashPrefix: opts.stripHashPrefix,
                treatUnknownPrefixAsPlaintext: false,
            });
        }
        if (prefix === 'v11') {
            return decryptChromiumAes128CbcCookieValue(encryptedValue, [v11Key, emptyKey], {
                stripHashPrefix: opts.stripHashPrefix,
                treatUnknownPrefixAsPlaintext: false,
            });
        }
        return null;
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
    const result = await getCookiesFromChromeSqliteDb(dbOptions, origins, allowlistNames, decrypt);
    result.warnings.unshift(...keyringWarnings);
    return result;
}
//# sourceMappingURL=chromeSqliteLinux.js.map