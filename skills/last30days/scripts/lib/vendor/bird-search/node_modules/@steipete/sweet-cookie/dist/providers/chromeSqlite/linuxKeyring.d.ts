export type LinuxKeyringBackend = 'gnome' | 'kwallet' | 'basic';
/**
 * Read the "Safe Storage" password from a Linux keyring.
 *
 * Chromium browsers typically store their cookie encryption password under:
 * - service: "<Browser> Safe Storage"
 * - account: "<Browser>"
 *
 * We keep this logic in JS (no native deps) and return an empty password on failure
 * (Chromium may still have v10 cookies, and callers can use inline/export escape hatches).
 */
export declare function getLinuxChromiumSafeStoragePassword(options: {
    backend?: LinuxKeyringBackend;
    app: 'chrome' | 'edge';
}): Promise<{
    password: string;
    warnings: string[];
}>;
export declare function getLinuxChromeSafeStoragePassword(options?: {
    backend?: LinuxKeyringBackend;
}): Promise<{
    password: string;
    warnings: string[];
}>;
//# sourceMappingURL=linuxKeyring.d.ts.map