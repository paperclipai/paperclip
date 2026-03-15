export declare function readKeychainGenericPassword(options: {
    account: string;
    service: string;
    timeoutMs: number;
}): Promise<{
    ok: true;
    password: string;
} | {
    ok: false;
    error: string;
}>;
export declare function readKeychainGenericPasswordFirst(options: {
    account: string;
    services: string[];
    timeoutMs: number;
    label: string;
}): Promise<{
    ok: true;
    password: string;
} | {
    ok: false;
    error: string;
}>;
//# sourceMappingURL=macosKeychain.d.ts.map