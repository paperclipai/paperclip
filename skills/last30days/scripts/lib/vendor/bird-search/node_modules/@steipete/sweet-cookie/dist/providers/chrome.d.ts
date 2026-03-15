import type { GetCookiesResult } from '../types.js';
export declare function getCookiesFromChrome(options: {
    profile?: string;
    timeoutMs?: number;
    includeExpired?: boolean;
    debug?: boolean;
}, origins: string[], allowlistNames: Set<string> | null): Promise<GetCookiesResult>;
//# sourceMappingURL=chrome.d.ts.map