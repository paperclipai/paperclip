import type { Cookie, CookieHeaderOptions, GetCookiesOptions, GetCookiesResult } from './types.js';
/**
 * Read cookies for a URL from one or more browser backends (and/or inline payloads).
 *
 * Supported backends:
 * - `chrome`: macOS / Windows / Linux (Chromium-based; default discovery targets Google Chrome paths)
 * - `edge`: macOS / Windows / Linux (Chromium-based; default discovery targets Microsoft Edge paths)
 * - `firefox`: macOS / Windows / Linux
 * - `safari`: macOS only (`Cookies.binarycookies`)
 *
 * Runtime requirements:
 * - Node >= 22 (uses `node:sqlite`) or Bun (uses `bun:sqlite`)
 *
 * The function returns `{ cookies, warnings }`:
 * - `cookies`: best-effort results, filtered by `url`/`origins` and optional `names` allowlist
 * - `warnings`: non-fatal diagnostics (no raw cookie values)
 */
export declare function getCookies(options: GetCookiesOptions): Promise<GetCookiesResult>;
/**
 * Convert cookies to an HTTP `Cookie` header value.
 *
 * This is a helper for typical Node fetch clients / HTTP libraries.
 * It does not validate cookie RFC edge cases; it simply joins `name=value` pairs.
 */
export declare function toCookieHeader(cookies: readonly Cookie[], options?: CookieHeaderOptions): string;
//# sourceMappingURL=public.d.ts.map