import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";

const execute = promisify(execFile);
const escapeFlag = "--allow-escape-sequences";
// Recent gh releases refuse to print a response containing terminal escape
// sequences unless the caller opts in. Job logs always contain colour codes,
// so the refresh opts in and strips them itself. Older gh releases reject
// the flag as unknown; remember that once and retry without it.
let escapeFlagSupported = true;

export function isUnknownEscapeFlagError(error) {
  return /unknown flag:?\s+--allow-escape-sequences/.test(String(error?.stderr ?? error?.message ?? ""));
}

// Calls `gh api` with argv only; no shell sees the endpoint. `run` exists for tests.
export async function ghApi(endpoint, { json = true, run = execute } = {}) {
  const options = { encoding: "utf8", maxBuffer: json ? 16 * 1024 * 1024 : 128 * 1024 * 1024, timeout: 120_000 };
  const call = flags => run("gh", ["api", ...flags, endpoint], options);
  let result;
  if (escapeFlagSupported) {
    try {
      result = await call([escapeFlag]);
    } catch (error) {
      if (!isUnknownEscapeFlagError(error)) throw error;
      escapeFlagSupported = false;
    }
  }
  result ??= await call([]);
  return json ? JSON.parse(result.stdout) : stripVTControlCharacters(result.stdout);
}

export function resetGhApiForTests() {
  escapeFlagSupported = true;
}
