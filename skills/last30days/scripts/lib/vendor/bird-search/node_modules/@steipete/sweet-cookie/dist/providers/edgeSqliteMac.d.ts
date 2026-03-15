import type { GetCookiesResult } from '../types.js';
export declare function getCookiesFromEdgeSqliteMac(options: {
    profile?: string;
    includeExpired?: boolean;
    debug?: boolean;
    timeoutMs?: number;
}, origins: string[], allowlistNames: Set<string> | null): Promise<GetCookiesResult>;
//# sourceMappingURL=edgeSqliteMac.d.ts.map