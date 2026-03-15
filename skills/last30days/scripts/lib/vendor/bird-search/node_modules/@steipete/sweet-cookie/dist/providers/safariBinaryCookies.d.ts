import type { GetCookiesResult } from '../types.js';
export declare function getCookiesFromSafari(options: {
    includeExpired?: boolean;
    file?: string;
}, origins: string[], allowlistNames: Set<string> | null): Promise<GetCookiesResult>;
//# sourceMappingURL=safariBinaryCookies.d.ts.map