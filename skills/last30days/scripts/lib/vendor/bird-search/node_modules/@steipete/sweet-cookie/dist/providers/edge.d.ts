import type { GetCookiesResult } from '../types.js';
export declare function getCookiesFromEdge(options: {
    profile?: string;
    timeoutMs?: number;
    includeExpired?: boolean;
    debug?: boolean;
}, origins: string[], allowlistNames: Set<string> | null): Promise<GetCookiesResult>;
//# sourceMappingURL=edge.d.ts.map