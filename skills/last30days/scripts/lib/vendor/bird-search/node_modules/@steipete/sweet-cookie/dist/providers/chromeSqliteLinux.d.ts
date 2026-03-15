import type { GetCookiesResult } from '../types.js';
export declare function getCookiesFromChromeSqliteLinux(options: {
    profile?: string;
    includeExpired?: boolean;
    debug?: boolean;
}, origins: string[], allowlistNames: Set<string> | null): Promise<GetCookiesResult>;
//# sourceMappingURL=chromeSqliteLinux.d.ts.map