/**
 * Browser-safe shim for the slice of `node:crypto` that
 * `@paperclipai/shared/external-objects.ts` imports.
 *
 * The shared canonicalizer runs server-side and never executes in the browser,
 * but the static `import { createHash } from "node:crypto"` is still pulled
 * into Storybook's module graph. Vite's built-in `node:crypto` polyfill does
 * not export `createHash`, so the build fails before our code runs. This shim
 * provides a no-op implementation so the bundler can resolve the import; if a
 * code path ever reaches it in the browser we throw loudly so we notice.
 */

class BrowserHash {
  update(_value: string): this {
    throw new Error(
      "createHash from node:crypto is not available in the browser bundle",
    );
  }

  digest(_encoding: string): string {
    throw new Error(
      "createHash from node:crypto is not available in the browser bundle",
    );
  }
}

export function createHash(_algorithm: string): BrowserHash {
  return new BrowserHash();
}

export default { createHash };
