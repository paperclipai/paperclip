import type { GetCookiesResult } from '../types.js';
type InlineSource = {
    source: string;
    payload: string;
};
export declare function getCookiesFromInline(inline: InlineSource, origins: string[], allowlistNames: Set<string> | null): Promise<GetCookiesResult>;
export {};
//# sourceMappingURL=inline.d.ts.map