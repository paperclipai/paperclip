import type { GetCookiesResult } from '../types.js';
export declare function getCookiesFromChromeSqliteMac(options: {
    profile?: string;
    includeExpired?: boolean;
    debug?: boolean;
}, origins: string[], allowlistNames: Set<string> | null): Promise<GetCookiesResult>;
//# sourceMappingURL=chromeSqliteMac.d.ts.map