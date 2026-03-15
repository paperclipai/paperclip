export declare function looksLikePath(value: string): boolean;
export declare function expandPath(input: string): string;
export declare function safeStat(candidate: string): {
    isFile: () => boolean;
    isDirectory: () => boolean;
} | null;
export declare function resolveCookiesDbFromProfileOrRoots(options: {
    profile?: string;
    roots: string[];
}): string | null;
//# sourceMappingURL=paths.d.ts.map