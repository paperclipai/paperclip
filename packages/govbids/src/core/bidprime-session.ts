import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_SESSION_PATH = ".bidprime-session";

export interface BidPrimeSession {
  cookieHeader: string;
}

/**
 * Load a BidPrime session cookie from a local file.
 *
 * The file should contain the raw `Cookie:` header value copied from
 * Chrome DevTools (Application → Cookies → bidprime.com, or Network →
 * any authenticated request → Request Headers → Cookie). One line, no
 * `Cookie:` prefix.
 *
 * Cookies typically last ~30 days before re-login is needed.
 */
export async function loadBidPrimeSession(
  path: string = DEFAULT_SESSION_PATH,
): Promise<BidPrimeSession> {
  const abs = resolve(process.cwd(), path);
  let content: string;
  try {
    content = await readFile(abs, "utf-8");
  } catch {
    throw new Error(
      `BidPrime session file not found at ${abs}. ` +
        `Log in at bidprime.com, copy the Cookie header from DevTools, ` +
        `and save it to ${path} (one line, no "Cookie:" prefix).`,
    );
  }
  const cookieHeader = content.trim();
  if (!cookieHeader) {
    throw new Error(`${abs} is empty.`);
  }
  return { cookieHeader };
}
