/**
 * HSM / TEE Keygen Module
 *
 * Exports the public API for hardware-backed key generation.
 *
 * Quick-start:
 *
 *   import { createHsmProvider, isHsmAvailable } from './hsm/index.js';
 *
 *   const available = await isHsmAvailable('ledger');
 *   if (available) {
 *     const provider = await createHsmProvider('ledger');
 *     // provider.getPublicKey() never exposes private key material
 *   }
 */

// Types
export type {
  HsmBackend,
  HsmCurve,
  HsmProvider,
  HsmPublicKeyResult,
  HsmSignatureResult,
  HsmWalletMetadata,
} from './types.js';

export {
  HsmError,
  HsmNotAvailableError,
  HsmCurveUnsupportedError,
  HsmOperationError,
} from './types.js';

// Providers
export { LedgerHsmProvider, isLedgerAvailable } from './ledger-provider.js';
export { SgxHsmProvider, isSgxAvailable } from './sgx-provider.js';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

import type { HsmBackend, HsmProvider } from './types.js';
import { HsmNotAvailableError } from './types.js';
import { LedgerHsmProvider, isLedgerAvailable } from './ledger-provider.js';
import { SgxHsmProvider, isSgxAvailable } from './sgx-provider.js';

/**
 * Probe whether the given HSM backend is reachable without fully opening it.
 *
 * @param backend - 'ledger' or 'sgx'
 * @returns `true` if the backend appears available.
 */
export async function isHsmAvailable(backend: HsmBackend): Promise<boolean> {
  if (backend === 'ledger') return isLedgerAvailable();
  if (backend === 'sgx') return isSgxAvailable();
  return false;
}

/**
 * Instantiate and open an HSM provider for the given backend.
 *
 * The returned provider is already open (open() has been called).
 * The caller is responsible for calling close() when done.
 *
 * @param backend - Which hardware backend to use ('ledger' | 'sgx').
 * @param options - Backend-specific options (socketPath, enclavePath, …).
 * @throws {HsmNotAvailableError} when the backend cannot be opened.
 */
export async function createHsmProvider(
  backend: HsmBackend,
  options: Record<string, string> = {},
): Promise<HsmProvider> {
  let provider: HsmProvider;

  if (backend === 'ledger') {
    provider = new LedgerHsmProvider();
  } else if (backend === 'sgx') {
    provider = new SgxHsmProvider(options);
  } else {
    throw new HsmNotAvailableError(backend as HsmBackend, `Unknown backend: ${backend}`);
  }

  await provider.open();
  return provider;
}
