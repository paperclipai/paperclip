/**
 * Adapter layer that shells out to the `agentcash` CLI binary.
 *
 * The agentcash npm package doesn't export its operations as a library —
 * the built output uses tsup code-splitting, so deep imports don't resolve.
 * Instead, we call the CLI binary with `--format json` and parse the output.
 *
 * This is intentionally simple and robust. If the agentcash team later adds
 * proper library exports, this file is the only one that needs updating.
 */

import { execFile } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function agentcashBin(): string {
  // Resolve from node_modules/.bin relative to this package
  return resolve(__dirname, "..", "node_modules", ".bin", "agentcash");
}

function exec(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      agentcashBin(),
      [...args, "--format", "json"],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          // Try to parse JSON error from stdout before rejecting
          try {
            const parsed = JSON.parse(stdout);
            if (parsed.error) {
              reject(new Error(parsed.error.message ?? JSON.stringify(parsed.error)));
              return;
            }
          } catch {
            // not JSON, fall through
          }
          reject(new Error(`agentcash CLI failed: ${stderr || err.message}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Empty response from agentcash CLI");
  const parsed = JSON.parse(trimmed) as Record<string, unknown>;

  // CLI wraps responses in { success: bool, data: ... }
  if (parsed.success === false) {
    const errMsg = parsed.error
      ? JSON.stringify(parsed.error)
      : "Unknown CLI error";
    throw new Error(errMsg);
  }
  return parsed.data ?? parsed;
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

let walletChecked = false;

export async function checkWallet(): Promise<boolean> {
  if (walletChecked) return true;
  try {
    await exec(["balance"]);
    walletChecked = true;
    return true;
  } catch {
    return false;
  }
}

export function isWalletLoaded(): boolean {
  return walletChecked;
}

// ---------------------------------------------------------------------------
// Get Balance
// ---------------------------------------------------------------------------

export interface BalanceResult {
  totalBalance: number;
  accounts: Array<{
    network: string;
    address: string;
    balance: number;
    depositLink: string;
  }>;
}

export async function agentcashGetBalance(): Promise<BalanceResult> {
  const { stdout } = await exec(["accounts"]);
  const data = parseJson(stdout) as BalanceResult;
  return data;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

export interface FetchParams {
  url: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  maxAmount?: number;
}

export interface PaymentInfo {
  protocol: string;
  price: string;
  network: string;
  txHash: string | null;
}

export interface FetchResult {
  body: string;
  paymentInfo: PaymentInfo | null;
}

export async function agentcashFetch(params: FetchParams): Promise<FetchResult> {
  const args: string[] = ["fetch", params.url];

  if (params.method) {
    args.push("--method", params.method);
  }
  if (params.body != null) {
    const bodyStr = typeof params.body === "string" ? params.body : JSON.stringify(params.body);
    args.push("--body", bodyStr);
  }
  if (params.headers) {
    for (const [key, value] of Object.entries(params.headers)) {
      args.push("--header", `${key}: ${value}`);
    }
  }
  if (params.maxAmount != null) {
    args.push("--max-amount", String(params.maxAmount));
  }

  const { stdout } = await exec(args);

  // CLI returns { success, data, metadata? } — parseJson already unwraps `data`
  // but we need the raw parsed object to get `metadata` (payment info)
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Empty response from agentcash CLI");
  const raw = JSON.parse(trimmed) as Record<string, unknown>;

  if (raw.success === false) {
    const errMsg = raw.error ? JSON.stringify(raw.error) : "Fetch failed";
    throw new Error(errMsg);
  }

  const responseData = raw.data as Record<string, unknown> | undefined;
  const metadata = raw.metadata as Record<string, unknown> | undefined;

  // Payment info lives in `metadata` (protocol, network, price, payment.transactionHash)
  let paymentInfo: PaymentInfo | null = null;
  if (metadata) {
    const payment = metadata.payment as Record<string, unknown> | undefined;
    paymentInfo = {
      protocol: String(metadata.protocol ?? ""),
      price: String(metadata.price ?? "0").replace(/^\$/, ""),
      network: String(metadata.network ?? ""),
      txHash: payment?.transactionHash ? String(payment.transactionHash) : null,
    };
  }

  const body = responseData ? JSON.stringify(responseData, null, 2) : "";

  return { body, paymentInfo };
}

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

export interface DiscoverParams {
  url: string;
  includeGuidance?: boolean;
}

export async function agentcashDiscover(params: DiscoverParams): Promise<unknown> {
  const args: string[] = ["discover", params.url];
  if (params.includeGuidance) {
    args.push("--include-guidance");
  }

  const { stdout } = await exec(args);
  return parseJson(stdout);
}

// ---------------------------------------------------------------------------
// Check Schema
// ---------------------------------------------------------------------------

export interface CheckSchemaParams {
  url: string;
  method?: string;
  body?: unknown;
}

export async function agentcashCheckSchema(params: CheckSchemaParams): Promise<unknown> {
  const args: string[] = ["check", params.url];

  if (params.method) {
    args.push("--method", params.method);
  }
  if (params.body != null) {
    const bodyStr = typeof params.body === "string" ? params.body : JSON.stringify(params.body);
    args.push("--body", bodyStr);
  }

  const { stdout } = await exec(args);
  return parseJson(stdout);
}
