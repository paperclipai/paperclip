#!/usr/bin/env node

import {
  fetchCodexQuota,
  fetchCodexRpcQuota,
  getQuotaWindows,
  readCodexAuthInfo,
  readCodexToken,
} from "../server/quota.js";

interface ProbeArgs {
  json: boolean;
  rpcOnly: boolean;
  whamOnly: boolean;
}

function parseArgs(argv: string[]): ProbeArgs {
  return {
    json: argv.includes("--json"),
    rpcOnly: argv.includes("--rpc-only"),
    whamOnly: argv.includes("--wham-only"),
  };
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.rpcOnly && args.whamOnly) {
    throw new Error("Choose either --rpc-only or --wham-only, not both.");
  }

  const auth = await readCodexAuthInfo();
  const token = await readCodexToken();

  const result: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    auth,
    tokenAvailable: token != null,
  };

  if (!args.whamOnly) {
    try {
      result.rpc = {
        ok: true,
        ...(await fetchCodexRpcQuota()),
      };
    } catch (error) {
      result.rpc = {
        ok: false,
        error: stringifyError(error),
        windows: [],
      };
    }
  }

  if (!args.rpcOnly) {
    if (!token) {
      result.wham = {
        ok: false,
        error: "No local Codex auth token found in ~/.codex/auth.json.",
        windows: [],
      };
    } else {
      try {
        result.wham = {
          ok: true,
          windows: await fetchCodexQuota(token.token, token.accountId),
        };
      } catch (error) {
        result.wham = {
          ok: false,
          error: stringifyError(error),
          windows: [],
        };
      }
    }
  }

  if (!args.rpcOnly && !args.whamOnly) {
    try {
      result.aggregated = await getQuotaWindows();
    } catch (error) {
      result.aggregated = {
        ok: false,
        error: stringifyError(error),
      };
    }
  }

  const rpcOk = (result.rpc as { ok?: boolean } | undefined)?.ok === true;
  const whamOk = (result.wham as { ok?: boolean } | undefined)?.ok === true;
  const aggregatedOk = (result.aggregated as { ok?: boolean } | undefined)?.ok === true;
  const ok = rpcOk || whamOk || aggregatedOk;

  if (args.json || process.stdout.isTTY === false) {
    console.log(JSON.stringify({ ok, ...result }, null, 2));
  } else {
    console.log(`timestamp: ${result.timestamp}`);
    console.log(`auth: ${JSON.stringify(auth)}`);
    console.log(`tokenAvailable: ${token != null}`);
    if (result.rpc) console.log(`rpc: ${JSON.stringify(result.rpc, null, 2)}`);
    if (result.wham) console.log(`wham: ${JSON.stringify(result.wham, null, 2)}`);
    if (result.aggregated) console.log(`aggregated: ${JSON.stringify(result.aggregated, null, 2)}`);
  }

  if (!ok) process.exitCode = 1;
}

await main();
