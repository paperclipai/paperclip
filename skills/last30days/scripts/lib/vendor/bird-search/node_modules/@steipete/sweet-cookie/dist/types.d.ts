/**
 * Supported browser backends.
 *
 * Notes:
 * - `safari` is macOS-only.
 * - `chrome` targets Google Chrome paths by default.
 * - `edge` targets Microsoft Edge paths by default.
 * - Other Chromium browsers often work by passing an explicit cookie DB path via `chromeProfile`
 *   (or `edgeProfile` if you want to keep sources separate).
 * - Only modern Chromium cookie DB schemas are supported (roughly Chrome >= 100).
 */
export type BrowserName = 'chrome' | 'edge' | 'firefox' | 'safari';
export type CookieSameSite = 'Strict' | 'Lax' | 'None';
export interface Cookie {
    /** Cookie name (required). */
    name: string;
    /** Cookie value (required; may be empty string). */
    value: string;
    /** Hostname without leading dot (e.g. `example.com`). */
    domain?: string;
    /** Path (defaults to `/` when omitted). */
    path?: string;
    /**
     * Optional URL form. Useful when a cookie is host-only or when `domain` is not known.
     * If present, it should be a valid origin URL like `https://example.com`.
     */
    url?: string;
    /** Unix timestamp in seconds. Omit for session cookies. */
    expires?: number;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: CookieSameSite;
    source?: {
        browser: BrowserName;
        /** Optional profile identifier when resolved from a profile. */
        profile?: string;
        /** Optional origin that produced this cookie (implementation detail). */
        origin?: string;
        /** Optional store identifier (implementation detail; e.g. extension cookie store). */
        storeId?: string;
    };
}
export type CookieMode = 'merge' | 'first';
export interface GetCookiesOptions {
    /**
     * Primary URL used to derive default origin filtering.
     * Must include a protocol (e.g. `https://example.com/`).
     */
    url: string;
    /**
     * Additional origins to include when filtering cookies.
     * Useful for OAuth/SSO flows where cookies are set on multiple domains.
     */
    origins?: string[];
    /** Allowlist of cookie names. When omitted, all matching cookies are returned. */
    names?: string[];
    /**
     * Which browser backends to try, in order.
     * Defaults to `chrome`, `safari`, `firefox` (and is also configurable via env).
     */
    browsers?: BrowserName[];
    /** Alias for chromeProfile (common case). */
    profile?: string;
    /**
     * Chrome/Chromium profile selector.
     *
     * Accepted values:
     * - profile directory name like `Default` / `Profile 2`
     * - a path to a profile directory
     * - a path to a cookie DB file (`.../Network/Cookies` or `.../Cookies`)
     */
    chromeProfile?: string;
    /**
     * Microsoft Edge profile selector.
     *
     * Accepted values:
     * - profile directory name like `Default` / `Profile 2`
     * - a path to a profile directory
     * - a path to a cookie DB file (`.../Network/Cookies` or `.../Cookies`)
     */
    edgeProfile?: string;
    /**
     * Firefox profile selector (profile name or filesystem path).
     * If a directory is provided, `cookies.sqlite` is resolved within it.
     */
    firefoxProfile?: string;
    /** Override path to Safari Cookies.binarycookies (for tests / debugging). */
    safariCookiesFile?: string;
    /** Include expired cookies (default: false). */
    includeExpired?: boolean;
    /** Timeout for OS helper calls (keychain/keyring/DPAPI). */
    timeoutMs?: number;
    /** Emit extra provider warnings (no raw cookie values). */
    debug?: boolean;
    /** Merge cookies across backends (`merge`) or return first successful backend (`first`). */
    mode?: CookieMode;
    /**
     * Inline cookie payload source. Commonly a file path exported by the extension.
     * If it looks like a file path, Sweet Cookie will attempt to read it.
     */
    inlineCookiesFile?: string;
    /** Inline cookie payload as JSON string (either `Cookie[]` or `{ cookies: Cookie[] }`). */
    inlineCookiesJson?: string;
    /** Inline cookie payload as base64-encoded JSON. */
    inlineCookiesBase64?: string;
}
export interface GetCookiesResult {
    cookies: Cookie[];
    /**
     * Non-fatal warnings from providers (missing keyring tools, schema drift, unsupported cookies, etc).
     * Never includes raw cookie values.
     */
    warnings: string[];
}
export interface CookieHeaderOptions {
    /** If true, keeps the first cookie value per name and drops duplicates. */
    dedupeByName?: boolean;
    /** Sorting strategy for the emitted header. */
    sort?: 'name' | 'none';
}
//# sourceMappingURL=types.d.ts.map