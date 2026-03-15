import type { GetCookiesResult } from '../types.js';
export declare function getCookiesFromEdgeSqliteLinux(options: {
    profile?: string;
    includeExpired?: boolean;
    debug?: boolean;
}, origins: string[], allowlistNames: Set<string> | null): Promise<GetCookiesResult>;
//# sourceMappingURL=edgeSqliteLinux.d.ts.map