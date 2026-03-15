import type { GetCookiesResult } from '../types.js';
export declare function getCookiesFromChromeSqliteWindows(options: {
    profile?: string;
    includeExpired?: boolean;
    debug?: boolean;
}, origins: string[], allowlistNames: Set<string> | null): Promise<GetCookiesResult>;
//# sourceMappingURL=chromeSqliteWindows.d.ts.map