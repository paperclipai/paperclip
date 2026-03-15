export declare function dpapiUnprotect(data: Buffer, options?: {
    timeoutMs?: number;
}): Promise<{
    ok: true;
    value: Buffer;
} | {
    ok: false;
    error: string;
}>;
//# sourceMappingURL=windowsDpapi.d.ts.map