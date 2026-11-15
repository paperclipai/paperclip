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

// A server test shard's job log is 30-65 MB (actions run 43133035381) and one
// download took 59 s on its own. Three in parallel overran the old 120 s limit,
// so the weekly refresh died mid-download and the shard weights stopped moving.
const jsonFetchOptions = { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 };
const logFetchOptions = { maxBuffer: 512 * 1024 * 1024, timeout: 900_000 };

// A failed log download carries the partial log on stdout; never print it.
function conciseError(endpoint, error) {
  const reason = error?.killed ? `killed by ${error.signal ?? "timeout"}` : `exit ${error?.code ?? "unknown"}`;
  const stderr = String(error?.stderr ?? "").trim().split("\n").slice(-3).join(" | ");
  return Object.assign(new Error(`gh api ${endpoint} failed (${reason})${stderr ? `: ${stderr}` : ""}`),
    { stderr: error?.stderr, code: error?.code, killed: error?.killed, signal: error?.signal });
}

// Calls `gh api` with argv only; no shell sees the endpoint. `run` exists for tests.
export async function ghApi(endpoint, { json = true, run = execute } = {}) {
  const options = { encoding: "utf8", ...(json ? jsonFetchOptions : logFetchOptions) };
  const call = async flags => {
    try {
      return await run("gh", ["api", ...flags, endpoint], options);
    } catch (error) {
      throw conciseError(endpoint, error);
    }
  };
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
