/**
 * Cycles Management
 *
 * Provides cycles management via icp-cli.
 * Check balances, mint cycles, transfer cycles.
 */

import {
  cyclesBalance,
  cyclesMint,
  cyclesTransfer,
} from './icpcli.js';

/**
 * Check cycle balance of a canister.
 *
 * @param canister - Canister ID or name
 * @returns Command result with balance in stdout
 */
export async function checkBalance(
  canister: string,
): Promise<any> {
  return cyclesBalance({ canister });
}

/**
 * Mint cycles to a canister.
 *
 * @param amount - Amount to mint
 * @returns Command result
 */
export async function mintCycles(
  amount: string,
): Promise<any> {
  return cyclesMint({ amount });
}

/**
 * Transfer cycles between canisters.
 *
 * @param amount - Amount to transfer
 * @param to - Recipient principal or canister ID
 * @returns Command result
 */
export async function transferCycles(
  amount: string,
  to: string,
): Promise<any> {
  return cyclesTransfer({ amount, to });
}
