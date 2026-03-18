#!/usr/bin/env node

import {
  captureClaudeCliUsageText,
  fetchClaudeCliQuota,
  fetchClaudeQuota,
  getQuotaWindows,
  parseClaudeCliUsageText,
  readClaudeAuthStatus,
  readClaudeToken,
} from "../server/quota.js";

interface ProbeArgs {
  json: boolean;
  includeRawCli: boolean;
  oauthOnly: boolean;
  cliOnly: boolean;
}

function parseArgs(argv: string[]): ProbeArgs {
  return {
    json: argv.includes("--json"),
    includeRawCli: argv.includes("--raw-cli"),
    oauthOnly: argv.includes("--oauth-only"),
    cliOnly: argv.includes("--cli-only"),
  };
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.oauthOnly && args.cliOnly) {
    throw new Error("Choose either --oauth-only or --cli-only, not both.");
  }

  const authStatus = await readClaudeAuthStatus();
  const token = await readClaudeToken();

  const result: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    authStatus,
    tokenAvailable: token != null,
  };

  if (!args.cliOnly) {
    if (!token) {
      result.oauth = {
        ok: false,
        error: "No Claude OAuth access token found in local credentials files.",
        windows: [],
      };
    } else {
      try {
        result.oauth = {
          ok: true,
          windows: await fetchClaudeQuota(token),
        };
      } catch (error) {
        result.oauth = {
          ok: false,
          error: stringifyError(error),
          windows: [],
        };
      }
    }
  }

  if (!args.oauthOnly) {
    try {
      const rawCliText = args.includeRawCli ? await captureClaudeCliUsageText() : null;
      const windows = rawCliText ? parseClaudeCliUsageText(rawCliText) : await fetchClaudeCliQuota();
      result.cli = rawCliText
        ? {
            ok: true,
            windows,
            rawText: rawCliText,
          }
        : {
            ok: true,
            windows,
          };
    } catch (error) {
      result.cli = {
        ok: false,
        error: stringifyError(error),
        windows: [],
      };
    }
  }

  if (!args.oauthOnly && !args.cliOnly) {
    try {
      result.aggregated = await getQuotaWindows();
    } catch (error) {
      result.aggregated = {
        ok: false,
        error: stringifyError(error),
      };
    }
  }

  const oauthOk = (result.oauth as { ok?: boolean } | undefined)?.ok === true;
  const cliOk = (result.cli as { ok?: boolean } | undefined)?.ok === true;
  const aggregatedOk = (result.aggregated as { ok?: boolean } | undefined)?.ok === true;
  const ok = oauthOk || cliOk || aggregatedOk;

  if (args.json || process.stdout.isTTY === false) {
    console.log(JSON.stringify({ ok, ...result }, null, 2));
  } else {
    console.log(`timestamp: ${result.timestamp}`);
    console.log(`auth: ${JSON.stringify(authStatus)}`);
    console.log(`tokenAvailable: ${token != null}`);
    if (result.oauth) console.log(`oauth: ${JSON.stringify(result.oauth, null, 2)}`);
    if (result.cli) console.log(`cli: ${JSON.stringify(result.cli, null, 2)}`);
    if (result.aggregated) console.log(`aggregated: ${JSON.stringify(result.aggregated, null, 2)}`);
  }

  if (!ok) process.exitCode = 1;
}

await main();
