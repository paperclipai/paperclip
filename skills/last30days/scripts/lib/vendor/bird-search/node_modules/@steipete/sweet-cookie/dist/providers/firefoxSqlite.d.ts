import type { GetCookiesResult } from '../types.js';
export declare function getCookiesFromFirefox(options: {
    profile?: string;
    includeExpired?: boolean;
}, origins: string[], allowlistNames: Set<string> | null): Promise<GetCookiesResult>;
//# sourceMappingURL=firefoxSqlite.d.ts.map