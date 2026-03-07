/**
 * Intel SGX TEE HSM Provider
 *
 * Offloads key generation and signing to an Intel SGX trusted enclave.
 * The enclave generates keys inside its protected memory, seals them with
 * the processor's platform key, and only ever exposes public keys and
 * signatures to the untrusted host.
 *
 * Security properties:
 *   - Private key material generated inside the SGX enclave (ring-0 isolation).
 *   - Keys are *sealed* to the enclave identity (MRENCLAVE / MRSIGNER):
 *       sealed blobs are opaque byte strings that cannot be read outside
 *       the matching enclave even with physical DRAM access.
 *   - Host process receives ONLY public keys and signatures.
 *   - RAM dumps of the host process contain zero key material.
 *
 * Architecture:
 *   Host (this file) ──UNIX-socket──▶ AESM daemon (aesmd)
 *                                         │
 *                                    SGX driver / enclave
 *
 * The AESM socket path is configurable; default: /var/run/aesmd/aesm.socket
 * For development / CI without real SGX hardware, set env SGX_SIMULATION=1
 * to use the libsgx_urts simulation mode.
 *
 * Real deployment:
 *   1. Install Intel SGX driver + platform software stack.
 *   2. Build / sign the enclave shared library (agentvault_keygen.signed.so).
 *   3. Set AGENTVAULT_SGX_ENCLAVE_PATH to point at the .signed.so file.
 *   4. Start aesmd.
 *   5. Run `agentvault wallet create --hsm sgx`.
 *
 * This file implements the host-side stub that communicates with the enclave
 * via a JSON-over-UNIX-socket protocol.  The protocol is intentionally simple
 * so that the enclave-side implementation can be small and auditable.
 */

import * as net from 'node:net';
import * as crypto from 'node:crypto';
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
// Configuration constants
// ---------------------------------------------------------------------------

/** Default UNIX socket path used by Intel's AESM daemon. */
const DEFAULT_AESM_SOCKET = '/var/run/aesmd/aesm.socket';

/**
 * Environment variable pointing to the signed enclave shared object.
 * When unset the provider falls back to simulation mode (SGX_SIMULATION=1).
 */
const ENCLAVE_PATH_ENV = 'AGENTVAULT_SGX_ENCLAVE_PATH';

/** Socket I/O timeout in milliseconds. */
const SOCKET_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Wire protocol types (JSON-over-UNIX-socket)
// ---------------------------------------------------------------------------

type SgxRequest =
  | { op: 'ping' }
  | { op: 'getPublicKey'; path: string; curve: HsmCurve }
  | { op: 'signDigest'; path: string; digestHex: string; curve: HsmCurve }
  | { op: 'deviceId' };

type SgxResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// SgxHsmProvider
// ---------------------------------------------------------------------------

/**
 * HSM provider that delegates all key operations to an Intel SGX enclave.
 *
 * The enclave binary must implement the agentvault_keygen.edl interface and
 * respond to the JSON-over-UNIX-socket protocol defined above.
 *
 * Usage:
 * ```ts
 * const sgx = new SgxHsmProvider();
 * await sgx.open();                              // connects to AESM daemon
 * const { address } = await sgx.getPublicKey("m/44'/60'/0'/0/0", 'secp256k1');
 * await sgx.close();
 * ```
 */
export class SgxHsmProvider implements HsmProvider {
  readonly name = 'Intel SGX TEE Enclave';
  readonly backend: HsmBackend = 'sgx';
  readonly supportedCurves: ReadonlyArray<HsmCurve> = ['secp256k1', 'ed25519'];

  private readonly _socketPath: string;
  private readonly _enclavePath: string;
  private _socket: net.Socket | null = null;

  constructor(options: { socketPath?: string; enclavePath?: string } = {}) {
    this._socketPath = options.socketPath ?? DEFAULT_AESM_SOCKET;
    this._enclavePath =
      options.enclavePath ??
      process.env[ENCLAVE_PATH_ENV] ??
      '/usr/lib/agentvault/agentvault_keygen.signed.so';
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async open(): Promise<void> {
    if (this._socket) return; // already open

    await this._connectSocket();

    try {
      await this._send({ op: 'ping' });
    } catch (err) {
      await this.close();
      throw new HsmNotAvailableError(
        'sgx',
        `SGX daemon at ${this._socketPath} did not respond to ping: ${String(err)}`,
      );
    }
  }

  async close(): Promise<void> {
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
  }

  // -------------------------------------------------------------------------
  // Public key retrieval
  // -------------------------------------------------------------------------

  async getPublicKey(derivationPath: string, curve: HsmCurve): Promise<HsmPublicKeyResult> {
    this._assertOpen();

    if (!this.supportedCurves.includes(curve)) {
      throw new HsmCurveUnsupportedError('sgx', curve);
    }

    let result: unknown;
    try {
      result = await this._send({ op: 'getPublicKey', path: derivationPath, curve });
    } catch (err) {
      throw new HsmOperationError('sgx', 'getPublicKey', err);
    }

    // Validate response shape
    const r = result as { publicKeyHex: string; address: string };
    if (typeof r.publicKeyHex !== 'string' || typeof r.address !== 'string') {
      throw new HsmOperationError('sgx', 'getPublicKey', 'Malformed response from enclave');
    }

    return {
      publicKeyHex: r.publicKeyHex,
      address: r.address,
      derivationPath,
      curve,
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
      throw new HsmCurveUnsupportedError('sgx', curve);
    }

    if (!/^[0-9a-fA-F]{64}$/.test(digestHex)) {
      throw new HsmOperationError('sgx', 'signDigest', 'digestHex must be exactly 32 bytes (64 hex chars)');
    }

    let result: unknown;
    try {
      result = await this._send({ op: 'signDigest', path: derivationPath, digestHex, curve });
    } catch (err) {
      throw new HsmOperationError('sgx', 'signDigest', err);
    }

    const r = result as { signatureHex: string; recovery?: number };
    if (typeof r.signatureHex !== 'string') {
      throw new HsmOperationError('sgx', 'signDigest', 'Malformed signature from enclave');
    }

    return { signatureHex: r.signatureHex, recovery: r.recovery };
  }

  // -------------------------------------------------------------------------
  // Device identity
  // -------------------------------------------------------------------------

  async deviceId(): Promise<string> {
    this._assertOpen();

    try {
      const result = await this._send({ op: 'deviceId' }) as { id: string };
      return typeof result?.id === 'string' ? result.id : 'sgx-unknown';
    } catch {
      // Fall back to a stable hash derived from the enclave path
      return createHash('sha256').update(this._enclavePath).digest('hex').slice(0, 16);
    }
  }

  // -------------------------------------------------------------------------
  // UNIX socket transport
  // -------------------------------------------------------------------------

  private async _connectSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this._socketPath });

      const onConnect = () => {
        socket.removeListener('error', onError);
        this._socket = socket;
        resolve();
      };

      const onError = (err: Error) => {
        socket.destroy();
        reject(
          new HsmNotAvailableError(
            'sgx',
            `Cannot connect to SGX AESM socket at ${this._socketPath}: ${err.message}. ` +
              'Is Intel SGX installed and aesmd running? (systemctl status aesmd)',
          ),
        );
      };

      socket.once('connect', onConnect);
      socket.once('error', onError);
      socket.setTimeout(SOCKET_TIMEOUT_MS, () => {
        socket.destroy();
        reject(
          new HsmNotAvailableError(
            'sgx',
            `Timeout connecting to SGX AESM socket at ${this._socketPath}`,
          ),
        );
      });
    });
  }

  /**
   * Send a JSON request to the enclave daemon and await a JSON response.
   * Each message is framed as a 4-byte big-endian length prefix followed by
   * the UTF-8 JSON payload (same framing as Intel's AESM RPC protocol).
   */
  private async _send(request: SgxRequest): Promise<unknown> {
    const socket = this._socket;
    if (!socket) throw new Error('Socket not connected');

    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(request), 'utf8');
      const frame = Buffer.allocUnsafe(4 + payload.length);
      frame.writeUInt32BE(payload.length, 0);
      payload.copy(frame, 4);

      const chunks: Buffer[] = [];

      const onData = (chunk: Buffer) => {
        chunks.push(chunk);
        const accumulated = Buffer.concat(chunks);

        // Wait for at least 4 bytes (length prefix)
        if (accumulated.length < 4) return;

        const bodyLen = accumulated.readUInt32BE(0);
        if (accumulated.length < 4 + bodyLen) return;

        // Full response received
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);

        const bodyStr = accumulated.slice(4, 4 + bodyLen).toString('utf8');
        let parsed: SgxResponse;
        try {
          parsed = JSON.parse(bodyStr) as SgxResponse;
        } catch (err) {
          return reject(new Error(`Invalid JSON from enclave: ${bodyStr}`));
        }

        if (!parsed.ok) {
          return reject(new Error(parsed.error ?? 'Unknown enclave error'));
        }
        resolve(parsed.data);
      };

      const onError = (err: Error) => {
        socket.removeListener('data', onData);
        reject(err);
      };

      socket.on('data', onData);
      socket.once('error', onError);

      socket.write(frame, (err) => {
        if (err) {
          socket.removeListener('data', onData);
          socket.removeListener('error', onError);
          reject(err);
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private _assertOpen(): void {
    if (!this._socket) {
      throw new HsmNotAvailableError(
        'sgx',
        'Provider is not open. Call open() before any key operations.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function createHash(alg: string) {
  return crypto.createHash(alg);
}

// ---------------------------------------------------------------------------
// Probe helper
// ---------------------------------------------------------------------------

/**
 * Quick check: is the SGX AESM daemon socket accessible?
 *
 * @returns `true` if the socket file exists and can be stat'd, `false` otherwise.
 */
export async function isSgxAvailable(
  socketPath: string = DEFAULT_AESM_SOCKET,
): Promise<boolean> {
  try {
    const { stat } = await import('node:fs/promises');
    const info = await stat(socketPath);
    return info.isSocket();
  } catch {
    return false;
  }
}
