export declare function deriveAes128CbcKeyFromPassword(password: string, options: {
    iterations: number;
}): Buffer;
export declare function decryptChromiumAes128CbcCookieValue(encryptedValue: Uint8Array, keyCandidates: readonly Buffer[], options: {
    stripHashPrefix: boolean;
    treatUnknownPrefixAsPlaintext?: boolean;
}): string | null;
export declare function decryptChromiumAes256GcmCookieValue(encryptedValue: Uint8Array, key: Buffer, options: {
    stripHashPrefix: boolean;
}): string | null;
//# sourceMappingURL=crypto.d.ts.map