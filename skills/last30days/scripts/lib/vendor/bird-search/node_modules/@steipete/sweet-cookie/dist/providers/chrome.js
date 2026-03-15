import { getCookiesFromChromeSqliteLinux } from './chromeSqliteLinux.js';
import { getCookiesFromChromeSqliteMac } from './chromeSqliteMac.js';
import { getCookiesFromChromeSqliteWindows } from './chromeSqliteWindows.js';
export async function getCookiesFromChrome(options, origins, allowlistNames) {
    const warnings = [];
    // Platform dispatch only. All real logic lives in the per-OS providers.
    if (process.platform === 'darwin') {
        const r = await getCookiesFromChromeSqliteMac(options, origins, allowlistNames);
        warnings.push(...r.warnings);
        const cookies = r.cookies;
        return { cookies, warnings };
    }
    if (process.platform === 'linux') {
        const r = await getCookiesFromChromeSqliteLinux(options, origins, allowlistNames);
        warnings.push(...r.warnings);
        const cookies = r.cookies;
        return { cookies, warnings };
    }
    if (process.platform === 'win32') {
        const r = await getCookiesFromChromeSqliteWindows(options, origins, allowlistNames);
        warnings.push(...r.warnings);
        const cookies = r.cookies;
        return { cookies, warnings };
    }
    return { cookies: [], warnings };
}
//# sourceMappingURL=chrome.js.map