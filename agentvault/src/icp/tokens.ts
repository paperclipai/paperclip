/**
 * Token Operations
 *
 * Provides token operations via icp-cli.
 * Supports ICP and ICRC-1/ICRC-2 tokens.
 */

import { tokenBalance, tokenTransfer } from './icpcli.js';

/**
 * Check token balance for a canister.
 *
 * @param canister - Token canister ID
 * @param options - Common ICP options
 * @returns Command result with balance
 */
export async function checkBalance(
  canister: string,
): Promise<any> {
  return tokenBalance({ canister });
}

/**
 * Transfer tokens to a recipient.
 *
 * @param amount - Amount to transfer
 * @param to - Recipient principal or account
 * @param options - Common ICP options
 * @returns Command result
 */
export async function transferTokens(
  amount: string,
  to: string,
): Promise<any> {
  return tokenTransfer({ amount, to });
}
