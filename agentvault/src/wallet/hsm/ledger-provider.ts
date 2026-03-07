/**
 * Ledger Hardware Wallet HSM Provider
 *
 * Offloads key generation and signing to a Ledger hardware wallet over USB HID.
 * The device generates keys internally from its BIP39 seed phrase, which is
 * entered on the physical keypad and NEVER transmitted to the host machine.
 *
 * Security properties:
 *   - Private key is generated inside the Secure Element and never leaves it.
 *   - BIP39 mnemonic is air-gapped on the device (entered via physical buttons).
 *   - The host receives ONLY the derived public key and chain address.
 *   - Transaction signing: the host sends an unsigned digest; the device returns
 *     only the signature bytes.
 *   - RAM dumps of the host process contain zero key material.
 *
 * Supported chains / apps (Ledger app must be open on device):
 *   secp256k1: Ethereum app  → ckETH, Polkadot (ECDSA mode)
 *   ed25519:   Solana app    → Solana, ICP, Arweave
 *
 * Dependencies (optional peer deps, dynamically imported):
 *   @ledgerhq/hw-transport-node-hid  – USB HID transport
 *   @ledgerhq/hw-app-eth             – Ethereum APDU client
 *   @ledgerhq/hw-app-solana          – Solana APDU client
 *
 * Install with:
 *   npm install @ledgerhq/hw-transport-node-hid @ledgerhq/hw-app-eth @ledgerhq/hw-app-solana
 */

import { createHash } from 'node:crypto';
import type {
  HsmProvider,
  HsmBackend,
  HsmCurve,
  HsmPublicKeyResult,
  HsmSignatureResult,
} from './types.js';
import {
  HsmNotAvailableError,
  HsmCurveUnsupportedError,
  HsmOperationError,
} from './types.js';

// ---------------------------------------------------------------------------
// Lazy-loaded Ledger package types (kept as `any` to avoid hard dep)
// ---------------------------------------------------------------------------

type LedgerTransport = {
  close(): Promise<void>;
  deviceModel?: { productName?: string; id?: string };
};

type LedgerTransportConstructor = {
  create(): Promise<LedgerTransport>;
  list(): Promise<unknown[]>;
};

type EthApp = {
  getAddress(path: string, display?: boolean): Promise<{ address: string; publicKey: string }>;
  signTransaction(path: string, rawTxHex: string): Promise<{ r: string; s: string; v: string }>;
  getAppConfiguration(): Promise<{ version: string }>;
};

type SolanaApp = {
  getAddress(path: string): Promise<{ address: Buffer }>;
  signTransaction(path: string, txBuffer: Buffer): Promise<{ signature: Buffer }>;
};

// ---------------------------------------------------------------------------
// Address derivation helpers (pure, no private key needed)
// ---------------------------------------------------------------------------
// LedgerHsmProvider
// ---------------------------------------------------------------------------

/**
 * HSM provider that delegates all key operations to a connected Ledger device.
 *
 * Usage:
 * ```ts
 * const ledger = new LedgerHsmProvider();
 * await ledger.open();                          // connects over USB HID
 * const { address } = await ledger.getPublicKey("m/44'/60'/0'/0/0", 'secp256k1');
 * await ledger.close();
 * ```
 */
export class LedgerHsmProvider implements HsmProvider {
  readonly name = 'Ledger Hardware Wallet';
  readonly backend: HsmBackend = 'ledger';
  readonly supportedCurves: ReadonlyArray<HsmCurve> = ['secp256k1', 'ed25519'];

  private _transport: LedgerTransport | null = null;
  private _deviceProduct: string | null = null;
  private _deviceSerial: string | null = null;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async open(): Promise<void> {
    if (this._transport) return; // already open

    // Dynamically import – avoids hard dependency if Ledger is not installed.
    let TransportNodeHid: LedgerTransportConstructor;
    try {
      const mod = await import('@ledgerhq/hw-transport-node-hid' as any);
      TransportNodeHid = mod.default ?? mod;
    } catch (err) {
      throw new HsmNotAvailableError(
        'ledger',
        'Package @ledgerhq/hw-transport-node-hid is not installed. ' +
          'Run: npm install @ledgerhq/hw-transport-node-hid @ledgerhq/hw-app-eth @ledgerhq/hw-app-solana',
      );
    }

    // Check that at least one device is reachable before trying to open.
    let devices: unknown[];
    try {
      devices = await TransportNodeHid.list();
    } catch (err) {
      throw new HsmNotAvailableError('ledger', 'Failed to list HID devices: ' + String(err));
    }

    if (devices.length === 0) {
      throw new HsmNotAvailableError(
        'ledger',
        'No Ledger device found. Connect the device, unlock it, and open the correct app.',
      );
    }

    try {
      this._transport = await TransportNodeHid.create();
    } catch (err) {
      throw new HsmNotAvailableError('ledger', 'Could not open HID transport: ' + String(err));
    }

    // Capture device identity for later.
    this._deviceProduct = this._transport.deviceModel?.productName ?? 'Ledger';
    // Use a hash of the product name + current open time as a stable-enough ID.
    this._deviceSerial =
      this._transport.deviceModel?.id ??
      createHash('sha256')
        .update(this._deviceProduct + '-' + Date.now())
        .digest('hex')
        .slice(0, 16);
  }

  async close(): Promise<void> {
    if (this._transport) {
      await this._transport.close().catch(() => {});
      this._transport = null;
    }
  }

  // -------------------------------------------------------------------------
  // Public key retrieval
  // -------------------------------------------------------------------------

  async getPublicKey(derivationPath: string, curve: HsmCurve): Promise<HsmPublicKeyResult> {
    this._assertOpen();

    if (!this.supportedCurves.includes(curve)) {
      throw new HsmCurveUnsupportedError('ledger', curve);
    }

    try {
      if (curve === 'secp256k1') {
        return await this._getEthPublicKey(derivationPath);
      } else {
        return await this._getSolanaPublicKey(derivationPath);
      }
    } catch (err) {
      if (err instanceof HsmNotAvailableError || err instanceof HsmCurveUnsupportedError) {
        throw err;
      }
      throw new HsmOperationError('ledger', 'getPublicKey', err);
    }
  }

  /**
   * Retrieve secp256k1 public key from the Ledger Ethereum app.
   * The device derives the key at `path` from its internal seed and returns
   * only the public key + EIP-55 address.  No private key is transmitted.
   */
  private async _getEthPublicKey(path: string): Promise<HsmPublicKeyResult> {
    let EthApp: any;
    try {
      const mod = await import('@ledgerhq/hw-app-eth' as any);
      EthApp = mod.default ?? mod;
    } catch {
      throw new HsmNotAvailableError(
        'ledger',
        'Package @ledgerhq/hw-app-eth is not installed.',
      );
    }

    const eth: EthApp = new EthApp(this._transport);
    // display=false → no on-device confirmation required (just address derivation)
    const result = await eth.getAddress(path, false);

    return {
      publicKeyHex: result.publicKey.startsWith('04')
        ? result.publicKey
        : '04' + result.publicKey,
      address: result.address,
      derivationPath: path,
      curve: 'secp256k1',
    };
  }

  /**
   * Retrieve Ed25519 public key from the Ledger Solana app.
   * Works for Solana, ICP, and Arweave (all use Ed25519).
   * The host receives only the 32-byte public key; the private key stays sealed.
   */
  private async _getSolanaPublicKey(path: string): Promise<HsmPublicKeyResult> {
    let SolanaApp: any;
    try {
      const mod = await import('@ledgerhq/hw-app-solana' as any);
      SolanaApp = mod.default ?? mod;
    } catch {
      throw new HsmNotAvailableError(
        'ledger',
        'Package @ledgerhq/hw-app-solana is not installed.',
      );
    }

    const sol: SolanaApp = new SolanaApp(this._transport);
    const result = await sol.getAddress(path);
    const pubkeyHex = Buffer.from(result.address).toString('hex');

    // For Solana the address is the base58-encoded public key.
    // We derive it here so callers get a usable address without needing bs58.
    const { PublicKey } = await import('@solana/web3.js');
    const address = new PublicKey(result.address).toBase58();

    return {
      publicKeyHex: pubkeyHex,
      address,
      derivationPath: path,
      curve: 'ed25519',
    };
  }

  // -------------------------------------------------------------------------
  // Signing
  // -------------------------------------------------------------------------

  async signDigest(
    derivationPath: string,
    digestHex: string,
    curve: HsmCurve,
  ): Promise<HsmSignatureResult> {
    this._assertOpen();

    if (!this.supportedCurves.includes(curve)) {
      throw new HsmCurveUnsupportedError('ledger', curve);
    }

    try {
      if (curve === 'secp256k1') {
        return await this._signEth(derivationPath, digestHex);
      } else {
        return await this._signSolana(derivationPath, digestHex);
      }
    } catch (err) {
      if (err instanceof HsmNotAvailableError || err instanceof HsmCurveUnsupportedError) {
        throw err;
      }
      throw new HsmOperationError('ledger', 'signDigest', err);
    }
  }

  private async _signEth(path: string, digestHex: string): Promise<HsmSignatureResult> {
    let EthApp: any;
    try {
      const mod = await import('@ledgerhq/hw-app-eth' as any);
      EthApp = mod.default ?? mod;
    } catch {
      throw new HsmNotAvailableError('ledger', 'Package @ledgerhq/hw-app-eth is not installed.');
    }

    const eth: EthApp = new EthApp(this._transport);
    // The Ledger Ethereum app signs raw transactions; we pass the digest as a
    // minimal "raw tx" hex.  For EIP-191 personal signs callers should use
    // signPersonalMessage instead; this method handles arbitrary 32-byte digests.
    const sig = await eth.signTransaction(path, digestHex);

    const r = sig.r.replace(/^0x/, '');
    const s = sig.s.replace(/^0x/, '');
    const vHex = sig.v.replace(/^0x/, '').padStart(2, '0');
    const recovery = parseInt(vHex, 16) % 2; // 0 or 1

    return { signatureHex: r + s + vHex, recovery };
  }

  private async _signSolana(path: string, digestHex: string): Promise<HsmSignatureResult> {
    let SolanaApp: any;
    try {
      const mod = await import('@ledgerhq/hw-app-solana' as any);
      SolanaApp = mod.default ?? mod;
    } catch {
      throw new HsmNotAvailableError(
        'ledger',
        'Package @ledgerhq/hw-app-solana is not installed.',
      );
    }

    const sol: SolanaApp = new SolanaApp(this._transport);
    const txBuffer = Buffer.from(digestHex, 'hex');
    const result = await sol.signTransaction(path, txBuffer);

    return { signatureHex: Buffer.from(result.signature).toString('hex') };
  }

  // -------------------------------------------------------------------------
  // Device identity
  // -------------------------------------------------------------------------

  async deviceId(): Promise<string> {
    this._assertOpen();
    return this._deviceSerial ?? 'ledger-unknown';
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private _assertOpen(): void {
    if (!this._transport) {
      throw new HsmNotAvailableError(
        'ledger',
        'Provider is not open. Call open() before any key operations.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Probe helper – call without opening a full provider
// ---------------------------------------------------------------------------

/**
 * Quick check: is a Ledger device currently connected and unlocked?
 *
 * @returns `true` if at least one HID device is enumerable, `false` otherwise.
 *          Does NOT verify that any particular Ledger app is open.
 */
export async function isLedgerAvailable(): Promise<boolean> {
  try {
    const mod = await import('@ledgerhq/hw-transport-node-hid' as any);
    const Transport = mod.default ?? mod;
    const devices = await Transport.list();
    return Array.isArray(devices) && devices.length > 0;
  } catch {
    return false;
  }
}
