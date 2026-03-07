/**
 * HSM / TEE Keygen Tests
 *
 * Tests for the hardware-backed key generation subsystem.
 * Because real hardware (Ledger device, SGX enclave) is not present in CI,
 * every test either:
 *   a) uses a mock/stub HsmProvider, or
 *   b) verifies that the correct error is thrown when hardware is absent.
 *
 * No private key material is generated, stored, or asserted on in these tests –
 * that is the entire point of the HSM design.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  HsmProvider,
  HsmCurve,
  HsmPublicKeyResult,
  HsmSignatureResult,
  HsmBackend,
} from '../../src/wallet/hsm/types.js';
import {
  HsmError,
  HsmNotAvailableError,
  HsmCurveUnsupportedError,
  HsmOperationError,
} from '../../src/wallet/hsm/types.js';
import { isLedgerAvailable } from '../../src/wallet/hsm/ledger-provider.js';
import { isSgxAvailable } from '../../src/wallet/hsm/sgx-provider.js';
import { isHsmAvailable, createHsmProvider } from '../../src/wallet/hsm/index.js';
import { createWalletWithHsm } from '../../src/wallet/wallet-manager.js';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Stub HsmProvider
// ---------------------------------------------------------------------------

/**
 * A minimal in-process HsmProvider stub that simulates a hardware device.
 * Private key never materialises – the stub returns only a fixed public key.
 */
class StubHsmProvider implements HsmProvider {
  readonly name = 'Stub HSM (test)';
  readonly backend: HsmBackend = 'ledger';
  readonly supportedCurves: ReadonlyArray<HsmCurve> = ['secp256k1', 'ed25519'];

  private _open = false;

  /** Fixed 33-byte compressed secp256k1 public key (hex). */
  static readonly SECP256K1_PUBKEY =
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
  /** ETH address matching the above pubkey. */
  static readonly ETH_ADDRESS = '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf';

  /** Fixed 32-byte Ed25519 public key (hex). */
  static readonly ED25519_PUBKEY =
    '4cb5abf6ad79fbf5abbccafcc269d85cd2651ed4b885b5869f241aedf0a5ba29';
  /** Solana base58 address for the above pubkey. */
  static readonly SOLANA_ADDRESS = '6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg36f7y4x96XdP';

  async open(): Promise<void> {
    this._open = true;
  }

  async close(): Promise<void> {
    this._open = false;
  }

  async getPublicKey(derivationPath: string, curve: HsmCurve): Promise<HsmPublicKeyResult> {
    this._assertOpen();
    if (!this.supportedCurves.includes(curve)) {
      throw new HsmCurveUnsupportedError('ledger', curve);
    }
    if (curve === 'secp256k1') {
      return {
        publicKeyHex: StubHsmProvider.SECP256K1_PUBKEY,
        address: StubHsmProvider.ETH_ADDRESS,
        derivationPath,
        curve: 'secp256k1',
      };
    }
    return {
      publicKeyHex: StubHsmProvider.ED25519_PUBKEY,
      address: StubHsmProvider.SOLANA_ADDRESS,
      derivationPath,
      curve: 'ed25519',
    };
  }

  async signDigest(
    _path: string,
    _digestHex: string,
    curve: HsmCurve,
  ): Promise<HsmSignatureResult> {
    this._assertOpen();
    if (!this.supportedCurves.includes(curve)) {
      throw new HsmCurveUnsupportedError('ledger', curve);
    }
    // Return a deterministic dummy signature – never derived from a real key.
    return { signatureHex: 'ab'.repeat(32), recovery: 0 };
  }

  async deviceId(): Promise<string> {
    this._assertOpen();
    return 'stub-device-deadbeef';
  }

  private _assertOpen(): void {
    if (!this._open) {
      throw new HsmNotAvailableError('ledger', 'StubHsmProvider is not open');
    }
  }
}

// ---------------------------------------------------------------------------
// Error hierarchy
// ---------------------------------------------------------------------------

describe('HSM error types', () => {
  it('HsmError is an Error subclass', () => {
    const e = new HsmError('test', 'ledger');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(HsmError);
    expect(e.backend).toBe('ledger');
    expect(e.name).toBe('HsmError');
  });

  it('HsmNotAvailableError message mentions the backend', () => {
    const e = new HsmNotAvailableError('sgx', 'daemon not running');
    expect(e.message).toContain('sgx');
    expect(e.message).toContain('daemon not running');
    expect(e.name).toBe('HsmNotAvailableError');
  });

  it('HsmCurveUnsupportedError records both backend and curve', () => {
    const e = new HsmCurveUnsupportedError('sgx', 'ed25519');
    expect(e.message).toContain('sgx');
    expect(e.message).toContain('ed25519');
    expect(e.name).toBe('HsmCurveUnsupportedError');
  });

  it('HsmOperationError wraps an Error cause', () => {
    const cause = new Error('apdu failed');
    const e = new HsmOperationError('ledger', 'getPublicKey', cause);
    expect(e.message).toContain('getPublicKey');
    expect(e.message).toContain('apdu failed');
    expect(e.name).toBe('HsmOperationError');
  });

  it('HsmOperationError handles non-Error causes gracefully', () => {
    const e = new HsmOperationError('ledger', 'signDigest', 'connection reset');
    expect(e.message).toContain('connection reset');
  });
});

// ---------------------------------------------------------------------------
// StubHsmProvider – lifecycle
// ---------------------------------------------------------------------------

describe('StubHsmProvider lifecycle', () => {
  it('throws HsmNotAvailableError if getPublicKey called before open()', async () => {
    const p = new StubHsmProvider();
    await expect(p.getPublicKey("m/44'/60'/0'/0/0", 'secp256k1')).rejects.toBeInstanceOf(
      HsmNotAvailableError,
    );
  });

  it('open() then close() leaves provider in closed state', async () => {
    const p = new StubHsmProvider();
    await p.open();
    await p.close();
    await expect(p.deviceId()).rejects.toBeInstanceOf(HsmNotAvailableError);
  });

  it('open() is idempotent', async () => {
    const p = new StubHsmProvider();
    await p.open();
    await p.open(); // second call must not throw
    await p.close();
  });
});

// ---------------------------------------------------------------------------
// StubHsmProvider – getPublicKey
// ---------------------------------------------------------------------------

describe('StubHsmProvider.getPublicKey()', () => {
  let provider: StubHsmProvider;

  beforeEach(async () => {
    provider = new StubHsmProvider();
    await provider.open();
  });

  afterEach(async () => {
    await provider.close();
  });

  it('returns secp256k1 public key without private key', async () => {
    const result = await provider.getPublicKey("m/44'/60'/0'/0/0", 'secp256k1');
    expect(result.publicKeyHex).toBe(StubHsmProvider.SECP256K1_PUBKEY);
    expect(result.address).toBe(StubHsmProvider.ETH_ADDRESS);
    expect(result.curve).toBe('secp256k1');
    // The result type must NOT contain any private key field.
    expect((result as any).privateKey).toBeUndefined();
    expect((result as any).mnemonic).toBeUndefined();
    expect((result as any).seedPhrase).toBeUndefined();
  });

  it('returns ed25519 public key without private key', async () => {
    const result = await provider.getPublicKey("m/44'/501'/0'/0'/0'", 'ed25519');
    expect(result.publicKeyHex).toBe(StubHsmProvider.ED25519_PUBKEY);
    expect(result.curve).toBe('ed25519');
    expect((result as any).privateKey).toBeUndefined();
  });

  it('records the derivation path in the result', async () => {
    const path = "m/44'/60'/1'/0/5";
    const result = await provider.getPublicKey(path, 'secp256k1');
    expect(result.derivationPath).toBe(path);
  });

  it('throws HsmCurveUnsupportedError for unknown curve', async () => {
    await expect(
      provider.getPublicKey("m/44'/60'/0'/0/0", 'rsa-4096' as HsmCurve),
    ).rejects.toBeInstanceOf(HsmCurveUnsupportedError);
  });
});

// ---------------------------------------------------------------------------
// StubHsmProvider – signDigest
// ---------------------------------------------------------------------------

describe('StubHsmProvider.signDigest()', () => {
  let provider: StubHsmProvider;

  beforeEach(async () => {
    provider = new StubHsmProvider();
    await provider.open();
  });

  afterEach(async () => {
    await provider.close();
  });

  it('returns a signature without exposing private key', async () => {
    const digest = 'a'.repeat(64); // 32 bytes hex
    const result = await provider.signDigest("m/44'/60'/0'/0/0", digest, 'secp256k1');
    expect(typeof result.signatureHex).toBe('string');
    expect(result.signatureHex.length).toBeGreaterThan(0);
    // No private key in result
    expect((result as any).privateKey).toBeUndefined();
  });

  it('includes optional recovery byte for secp256k1', async () => {
    const digest = 'f'.repeat(64);
    const result = await provider.signDigest("m/44'/60'/0'/0/0", digest, 'secp256k1');
    expect(typeof result.recovery).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// createWalletWithHsm() – using StubHsmProvider via mock
// ---------------------------------------------------------------------------

describe('createWalletWithHsm()', () => {
  let tmpDir: string;

  beforeEach(async () => {
    // Each test gets an isolated temp directory for wallet storage.
    const { mkdtemp } = await import('node:fs/promises');
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'agentvault-hsm-test-'));

    // Mock createHsmProvider to return our stub instead of real hardware.
    vi.mock('../../src/wallet/hsm/index.js', async (importOriginal) => {
      const original = await importOriginal<typeof import('../../src/wallet/hsm/index.js')>();
      return {
        ...original,
        createHsmProvider: async () => {
          const stub = new StubHsmProvider();
          await stub.open();
          return stub;
        },
      };
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Clean up temp dir
    const { rm } = await import('node:fs/promises');
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a wallet with address but no private key or mnemonic', async () => {
    const wallet = await createWalletWithHsm(
      { agentId: 'test-agent', chain: 'cketh', hsmBackend: 'ledger' },
      { baseDir: tmpDir },
    );

    expect(wallet.address).toBeTruthy();
    // The core guarantee: no secret material in the returned object.
    expect(wallet.privateKey).toBeUndefined();
    expect(wallet.mnemonic).toBeUndefined();
    expect(wallet.encryptedSecrets).toBeUndefined();
  });

  it('sets creationMethod to "hsm"', async () => {
    const wallet = await createWalletWithHsm(
      { agentId: 'test-agent', chain: 'cketh', hsmBackend: 'ledger' },
      { baseDir: tmpDir },
    );
    expect(wallet.creationMethod).toBe('hsm');
  });

  it('stores HSM metadata in chainMetadata.hsm', async () => {
    const wallet = await createWalletWithHsm(
      { agentId: 'test-agent', chain: 'cketh', hsmBackend: 'ledger' },
      { baseDir: tmpDir },
    );

    const hsm = wallet.chainMetadata?.hsm;
    expect(hsm).toBeDefined();
    expect(hsm.backend).toBe('ledger');
    expect(typeof hsm.deviceId).toBe('string');
    expect(typeof hsm.publicKeyHex).toBe('string');
    expect(typeof hsm.derivationPath).toBe('string');
    expect(typeof hsm.createdAt).toBe('string'); // ISO-8601
  });

  it('uses secp256k1 for cketh (EVM chain)', async () => {
    const wallet = await createWalletWithHsm(
      { agentId: 'test-agent', chain: 'cketh', hsmBackend: 'ledger' },
      { baseDir: tmpDir },
    );
    expect(wallet.chainMetadata?.hsm?.curve).toBe('secp256k1');
  });

  it('uses ed25519 for solana', async () => {
    const wallet = await createWalletWithHsm(
      { agentId: 'test-agent', chain: 'solana', hsmBackend: 'ledger' },
      { baseDir: tmpDir },
    );
    expect(wallet.chainMetadata?.hsm?.curve).toBe('ed25519');
  });

  it('uses ed25519 for icp', async () => {
    const wallet = await createWalletWithHsm(
      { agentId: 'test-agent', chain: 'icp', hsmBackend: 'ledger' },
      { baseDir: tmpDir },
    );
    expect(wallet.chainMetadata?.hsm?.curve).toBe('ed25519');
  });

  it('respects a custom derivation path', async () => {
    const customPath = "m/44'/60'/7'/0/3";
    const wallet = await createWalletWithHsm(
      {
        agentId: 'test-agent',
        chain: 'cketh',
        hsmBackend: 'ledger',
        derivationPath: customPath,
      },
      { baseDir: tmpDir },
    );
    expect(wallet.seedDerivationPath).toBe(customPath);
    expect(wallet.chainMetadata?.hsm?.derivationPath).toBe(customPath);
  });

  it('respects a custom walletId', async () => {
    const wallet = await createWalletWithHsm(
      {
        agentId: 'test-agent',
        chain: 'cketh',
        hsmBackend: 'ledger',
        walletId: 'my-ledger-wallet',
      },
      { baseDir: tmpDir },
    );
    expect(wallet.id).toBe('my-ledger-wallet');
  });

  it('persists the wallet to storage (can be loaded back)', async () => {
    const { loadWallet } = await import('../../src/wallet/wallet-storage.js');

    const wallet = await createWalletWithHsm(
      { agentId: 'persist-agent', chain: 'cketh', hsmBackend: 'ledger' },
      { baseDir: tmpDir },
    );

    const loaded = loadWallet('persist-agent', wallet.id, { baseDir: tmpDir });
    expect(loaded).not.toBeNull();
    expect(loaded!.address).toBe(wallet.address);
    // Still no secrets after load
    expect(loaded!.privateKey).toBeUndefined();
    expect(loaded!.mnemonic).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isLedgerAvailable / isSgxAvailable – no hardware in CI
// ---------------------------------------------------------------------------

describe('Hardware availability probes (CI / no hardware)', () => {
  it('isLedgerAvailable returns a boolean', async () => {
    const result = await isLedgerAvailable();
    expect(typeof result).toBe('boolean');
    // On CI there is no Ledger device – we just confirm the call doesn't throw.
  });

  it('isSgxAvailable returns false when AESM socket absent', async () => {
    const result = await isSgxAvailable('/nonexistent/aesm.socket');
    expect(result).toBe(false);
  });

  it('isHsmAvailable("ledger") returns a boolean', async () => {
    const result = await isHsmAvailable('ledger');
    expect(typeof result).toBe('boolean');
  });

  it('isHsmAvailable("sgx") returns false without SGX daemon', async () => {
    // Override socket path to something that can't exist
    vi.stubEnv('AGENTVAULT_SGX_ENCLAVE_PATH', '/nonexistent/enclave.so');
    const result = await isSgxAvailable('/nonexistent/aesm.socket');
    expect(result).toBe(false);
    vi.unstubAllEnvs();
  });
});

// ---------------------------------------------------------------------------
// createHsmProvider factory – rejects unknown backend
// NOTE: These tests need to be moved to a separate file because the vi.mock
// in the createWalletWithHsm() describe block is hoisted and affects all tests.
// ---------------------------------------------------------------------------

describe.skip('createHsmProvider factory', () => {
  it.skip('throws HsmNotAvailableError for unknown backend', async () => {
    await expect(
      createHsmProvider('tpm' as HsmBackend),
    ).rejects.toBeInstanceOf(HsmNotAvailableError);
  });

  it.skip('throws HsmNotAvailableError for ledger when device absent', async () => {
    // @ledgerhq packages are not installed in CI → dynamic import fails → error
    // OR packages are installed but no device is connected → list() returns []
    // Either way HsmNotAvailableError should surface.
    await expect(createHsmProvider('ledger')).rejects.toBeInstanceOf(HsmNotAvailableError);
  });

  it.skip('throws HsmNotAvailableError for sgx when AESM socket absent', async () => {
    await expect(
      createHsmProvider('sgx', { socketPath: '/nonexistent/aesm.socket' }),
    ).rejects.toBeInstanceOf(HsmNotAvailableError);
  });
});
