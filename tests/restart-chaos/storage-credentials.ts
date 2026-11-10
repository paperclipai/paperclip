import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchMinio, type ObjectStore } from "./object-store.js";
import { CREDENTIAL_ERROR_CODES, type StorageFaultRule } from "./storage-proxy.js";

export type CredentialFaultKind = "ST5" | "ST5R";
export const ROTATING_PROFILE = "chaos-rotating";
export const ROTATION_HOLD_MS = 5_000;

export interface StoreCredentials { accessKeyId: string; secretAccessKey: string }
type ProxyControl = { setRules(rules: readonly StorageFaultRule[]): void; clear(): void };
type RecordEvent = (kind: string, data: { [key: string]: unknown }) => void;

export function credentialFaultRules(kind: CredentialFaultKind, random: () => number): StorageFaultRule[] {
  if (kind === "ST5R") return [{ fault: { kind: "credential_rotation" } }];
  const code = CREDENTIAL_ERROR_CODES[Math.floor(random() * CREDENTIAL_ERROR_CODES.length)]!;
  return [{ fault: { kind: "expired_credentials", code } }];
}

const isRotation = (rule: StorageFaultRule) => rule.fault.kind === "credential_rotation";

export function needsCredentialRotation(options: { storageFaults?: readonly string[];
  storageWindows?: ReadonlyArray<{ rules: readonly StorageFaultRule[] }> }): boolean {
  return Boolean(options.storageFaults?.includes("ST5R") || options.storageWindows?.some(window => window.rules.some(isRotation)));
}

export function freshCredentials(): StoreCredentials {
  return { accessKeyId: `chaos${randomBytes(6).toString("hex")}`, secretAccessKey: randomBytes(24).toString("hex") };
}

const CREDENTIAL_PROCESS = `import { readFileSync } from "node:fs";
const { accessKeyId, secretAccessKey } = JSON.parse(readFileSync(process.argv[2], "utf8"));
process.stdout.write(JSON.stringify({ Version: 1, AccessKeyId: accessKeyId, SecretAccessKey: secretAccessKey }));
`;

export interface RotatingCredentialSource {
  environment: { [key: string]: string };
  publish(credentials: StoreCredentials): Promise<void>;
}

export async function writeRotatingCredentialSource(root: string, initial: StoreCredentials,
  nodeBinary: string = process.execPath): Promise<RotatingCredentialSource> {
  const dir = path.join(root, "aws-credentials");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const state = path.join(dir, "current.json");
  const script = path.join(dir, "credential-process.mjs");
  const configFile = path.join(dir, "config");
  const credentialsFile = path.join(dir, "credentials");
  const publish = async (credentials: StoreCredentials) => {
    const staged = `${state}.${randomBytes(4).toString("hex")}`;
    await writeFile(staged, JSON.stringify(credentials), { mode: 0o600 });
    await rename(staged, state);
  };
  await publish(initial);
  await writeFile(script, CREDENTIAL_PROCESS, { mode: 0o600 });
  await writeFile(credentialsFile, "", { mode: 0o600 });
  await writeFile(configFile, `[profile ${ROTATING_PROFILE}]\ncredential_process = "${nodeBinary}" "${script}" "${state}"\n`, { mode: 0o600 });
  return {
    environment: { AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "", AWS_PROFILE: ROTATING_PROFILE,
      AWS_CONFIG_FILE: configFile, AWS_SHARED_CREDENTIALS_FILE: credentialsFile },
    publish,
  };
}

export async function restartMinioWithCredentials(store: ObjectStore, binary: string, next: StoreCredentials,
  readyTimeoutMs = 30_000): Promise<void> {
  await store.stop();
  const stop = await launchMinio({ binary, dataDir: store.dataDir, address: new URL(store.endpoint).host, home: path.dirname(store.dataDir),
    accessKeyId: next.accessKeyId, secretAccessKey: next.secretAccessKey, readyTimeoutMs });
  Object.assign(store, { stop, accessKeyId: next.accessKeyId, secretAccessKey: next.secretAccessKey });
}

export class CredentialRotation {
  private work: Promise<void> = Promise.resolve();
  private generation = 0;
  private unpublished: StoreCredentials | null = null;
  rotations = 0;
  readonly failures: string[] = [];

  constructor(private readonly rotate: (next: StoreCredentials) => Promise<void>,
    private readonly source: Pick<RotatingCredentialSource, "publish">, private readonly record: RecordEvent,
    private readonly nextCredentials: () => StoreCredentials = freshCredentials) {}

  wrap(proxy: ProxyControl): ProxyControl {
    return {
      setRules: rules => {
        const generation = ++this.generation;
        const rest = rules.filter(rule => !isRotation(rule));
        if (rest.length === rules.length) { proxy.setRules(rest); return; }
        proxy.setRules([{ fault: { kind: "latency", ms: ROTATION_HOLD_MS } }]);
        this.work = this.work.then(async () => {
          const next = this.nextCredentials();
          const startedAt = Date.now();
          try {
            await this.rotate(next);
            this.unpublished = next;
            this.rotations += 1;
            this.record("storage_credentials_rotated", { rotation: this.rotations, restartMs: Date.now() - startedAt });
          } catch (error) {
            this.failures.push(`rotation: ${String(error)}`);
            this.record("storage_credentials_rotation_failed", { error: String(error) });
          } finally {
            if (generation === this.generation) { if (rest.length) proxy.setRules(rest); else proxy.clear(); }
          }
        });
      },
      clear: () => {
        ++this.generation;
        proxy.clear();
        this.work = this.work.then(async () => {
          const next = this.unpublished;
          if (!next) return;
          this.unpublished = null;
          await this.source.publish(next)
            .then(() => this.record("storage_credentials_published", { rotation: this.rotations }))
            .catch(error => {
              this.failures.push(`publish: ${String(error)}`);
              this.record("storage_credentials_publish_failed", { error: String(error) });
            });
        });
      },
    };
  }

  settled(): Promise<void> { return this.work; }
}

export async function startCredentialRotation(input: { store: ObjectStore; binary: string; root: string; record: RecordEvent }) {
  const source = await writeRotatingCredentialSource(input.root, { accessKeyId: input.store.accessKeyId, secretAccessKey: input.store.secretAccessKey });
  const rotation = new CredentialRotation(next => restartMinioWithCredentials(input.store, input.binary, next), source, input.record);
  return { environment: source.environment, rotation };
}
