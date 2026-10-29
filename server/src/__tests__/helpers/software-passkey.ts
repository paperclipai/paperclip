import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

type CborValue = number | string | Buffer | CborValue[] | Map<CborValue, CborValue>;

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) {
    const head = Buffer.alloc(3);
    head[0] = (major << 5) | 25;
    head.writeUInt16BE(length, 1);
    return head;
  }
  const head = Buffer.alloc(5);
  head[0] = (major << 5) | 26;
  head.writeUInt32BE(length, 1);
  return head;
}

function encodeCbor(value: CborValue): Buffer {
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([cborHead(4, value.length), ...value.map(encodeCbor)]);
  const entries = [...value.entries()];
  return Buffer.concat([
    cborHead(5, entries.length),
    ...entries.flatMap(([key, entry]) => [encodeCbor(key), encodeCbor(entry)]),
  ]);
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

function clientData(type: "webauthn.create" | "webauthn.get", challenge: string, origin: string): Buffer {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8");
}

export class SoftwarePasskey {
  private readonly credentialId = randomBytes(32);
  private readonly privateKey: KeyObject;
  private readonly publicKeyJwk: { x: string; y: string };
  private signCount = 0;

  constructor(
    private readonly rpId: string,
    private readonly origin: string,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" });
    this.publicKeyJwk = { x: jwk.x!, y: jwk.y! };
  }

  get id(): string {
    return base64url(this.credentialId);
  }

  private authenticatorData(flags: number, attestedCredential?: Buffer): Buffer {
    const rpIdHash = createHash("sha256").update(this.rpId).digest();
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.signCount);
    return Buffer.concat([rpIdHash, Buffer.from([flags]), counter, ...(attestedCredential ? [attestedCredential] : [])]);
  }

  /** `userVerified: false` models a security key with no PIN: user presence only. */
  register(options: { challenge: string }, { userVerified = true }: { userVerified?: boolean } = {}) {
    const coseKey = new Map<CborValue, CborValue>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(this.publicKeyJwk.x, "base64url")],
      [-3, Buffer.from(this.publicKeyJwk.y, "base64url")],
    ]);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const attestedCredential = Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, encodeCbor(coseKey)]);
    const authData = this.authenticatorData(0x01 | (userVerified ? 0x04 : 0) | 0x40, attestedCredential);
    const attestationObject = encodeCbor(
      new Map<CborValue, CborValue>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64url(clientData("webauthn.create", options.challenge, this.origin)),
        attestationObject: base64url(attestationObject),
        transports: ["internal"],
      },
    };
  }

  authenticate(options: { challenge: string }, { userVerified = true }: { userVerified?: boolean } = {}) {
    this.signCount += 1;
    const authData = this.authenticatorData(0x01 | (userVerified ? 0x04 : 0));
    const clientDataJSON = clientData("webauthn.get", options.challenge, this.origin);
    const signature = sign(
      "sha256",
      Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]),
      this.privateKey,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: base64url(clientDataJSON),
        authenticatorData: base64url(authData),
        signature: base64url(signature),
      },
    };
  }
}
