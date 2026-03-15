import type { GetCookiesResult } from '../../types.js';
export declare function getCookiesFromChromeSqliteDb(options: {
    dbPath: string;
    profile?: string;
    includeExpired?: boolean;
    debug?: boolean;
}, origins: string[], allowlistNames: Set<string> | null, decrypt: (encryptedValue: Uint8Array, options: {
    stripHashPrefix: boolean;
}) => string | null): Promise<GetCookiesResult>;
//# sourceMappingURL=shared.d.ts.map