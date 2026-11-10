import { reviewedChatExecutionIds } from "./chat-runtime-profile.js";
import { constants } from "node:fs";
import { lstat, realpath, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { CHAT_PRIVATE_INPUTS_ENV } from "./chat-private-inputs.js";

export const vaultScenarioId = "secrets.vault-reference";
export const vaultExecutionId = reviewedChatExecutionIds(vaultScenarioId)[0]!;
export const vaultExecutionIds = reviewedChatExecutionIds(vaultScenarioId);
export const vaultPrivateFields = [
  "provider",
  "region",
  "deploymentId",
  "kmsKeyId",
  "secretReference",
  "accessKeyIdEnv",
  "secretAccessKeyEnv",
  "sessionTokenEnv",
  "expectedValueEnv",
] as const;
type Binding = {
  disposable: boolean;
  resourceIds: string[];
  credentialEnv: string[];
  prerequisites: Record<string, string>;
};
interface Envelope {
  version: number;
  executionId: string;
  references: Record<string, string>;
  external?: { schemaVersion?: number; providers?: { vault?: Binding } };
  declaredReferenceNames?: string[];
  declaredExternalRequirements?: Array<{ provider: string; fields: string[] }>;
  setupBlockers?: string[];
}
export function privateVaultMetadataMatches(
  info: { uid: number; mode: number },
  expectedUid: number,
) {
  return info.uid === expectedUid && !(info.mode & 0o077);
}
export function validVaultBinding(
  binding: Binding | undefined,
): binding is Binding {
  if (
    !binding ||
    binding.disposable !== true ||
    !Array.isArray(binding.resourceIds) ||
    !Array.isArray(binding.credentialEnv) ||
    !binding.prerequisites
  )
    return false;
  const p = binding.prerequisites;
  if (
    vaultPrivateFields.some(
      (field) => typeof p[field] !== "string" || !p[field].trim(),
    ) ||
    p.provider !== "aws_secrets_manager" ||
    !/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(p.region!) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}$/.test(p.deploymentId!)
  )
    return false;
  const secret =
    /^arn:(aws(?:-us-gov|-cn)?):secretsmanager:([^:]+):(\d{12}):secret:([^\r\n]+)$/.exec(
      p.secretReference!,
    );
  const kms =
    /^arn:(aws(?:-us-gov|-cn)?):kms:([^:]+):(\d{12}):key\/([a-f0-9-]{36})$/.exec(
      p.kmsKeyId!,
    );
  if (
    !secret ||
    !kms ||
    secret[1] !== kms[1] ||
    secret[2] !== p.region ||
    kms[2] !== p.region ||
    secret[3] !== kms[3] ||
    ![p.secretReference, p.kmsKeyId].every((ref) =>
      binding.resourceIds.includes(ref!),
    )
  )
    return false;
  const names = [
    p.accessKeyIdEnv!,
    p.secretAccessKeyEnv!,
    p.sessionTokenEnv!,
    p.expectedValueEnv!,
  ];
  return (
    new Set(names).size === names.length &&
    names.every(
      (name) =>
        /^PAPERCLIP_CHAT_EVAL_[A-Z0-9_]+$/.test(name) &&
        binding.credentialEnv.includes(name),
    ) &&
    binding.credentialEnv.every((name) => names.includes(name))
  );
}
/** Only the selected product server receives these credentials. Oracle values,
 * config pointers, profiles and SDK fallback sources never cross this boundary. */
export async function readSelectedVaultServerEnvironment(input: {
  executionIds: readonly string[];
  temporaryRoot: string;
  backendOrigin: string;
  env: NodeJS.ProcessEnv;
}): Promise<NodeJS.ProcessEnv> {
  if (!input.executionIds.some(id => vaultExecutionIds.includes(id))) return {};
  if (input.executionIds.length !== 1)
    throw new Error(
      "Vault runtime inputs require the exact single selected source execution",
    );
  const backend = new URL(input.backendOrigin);
  if (
    backend.protocol !== "http:" ||
    backend.hostname !== "127.0.0.1" ||
    backend.origin !== input.backendOrigin
  )
    throw new Error("Vault runtime inputs require the owned loopback backend");
  const filename = input.env[CHAT_PRIVATE_INPUTS_ENV];
  if (!filename) return {};
  const directory = path.join(input.temporaryRoot, "selected-private-inputs");
  if (filename !== path.join(directory, "chat-selected-inputs.json"))
    throw new Error(
      "Vault runtime input path escaped its owned attempt directory",
    );
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error("Vault runtime input ownership cannot be verified");
  for (const target of [input.temporaryRoot, directory]) {
    const info = await lstat(target);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      !privateVaultMetadataMatches(info, uid)
    )
      throw new Error("Vault runtime input directory is not private and owned");
  }
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let envelope: Envelope;
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      !privateVaultMetadataMatches(before, uid) ||
      before.size > 262144 ||
      !(await realpath(filename)).startsWith(
        (await realpath(input.temporaryRoot)) + path.sep,
      )
    )
      throw new Error("Vault runtime input file is not private and owned");
    const bytes = await handle.readFile(),
      after = await handle.stat(),
      named = await lstat(filename);
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      named.ino !== before.ino ||
      named.dev !== before.dev
    )
      throw new Error("Vault private input changed during read");
    try {
      envelope = JSON.parse(bytes.toString("utf8")) as Envelope;
    } catch {
      throw new Error("Vault runtime input JSON is invalid; contents withheld");
    }
  } finally {
    await handle.close();
  }
  if (envelope.version !== 1 || envelope.executionId !== input.executionIds[0])
    throw new Error("Vault runtime input belongs to another execution");
  // Ordinary reserved setup handles missing selected provider inputs. It never
  // receives an ambient fallback merely because the private binding is absent.
  if (!envelope.external?.providers?.vault || envelope.setupBlockers?.length)
    return {};
  const binding = envelope.external.providers.vault;
  if (envelope.external.schemaVersion !== 1 || !validVaultBinding(binding))
    throw new Error(
      "Vault runtime binding does not designate the exact allowed AWS resources",
    );
  const declaration = envelope.declaredExternalRequirements;
  if (
    declaration?.length !== 1 ||
    declaration[0]?.provider !== "vault" ||
    [...declaration[0].fields].sort().join() !==
      [...vaultPrivateFields].sort().join()
  )
    throw new Error(
      "Vault runtime fields differ from the selected fingerprinted declaration",
    );
  const p = binding.prerequisites;
  const read = (
    field: "accessKeyIdEnv" | "secretAccessKeyEnv" | "sessionTokenEnv",
  ) => {
    const name = p[field]!;
    if (!envelope.declaredReferenceNames?.includes(name))
      throw new Error(
        "Vault runtime credential is not an explicitly selected reference",
      );
    const value = envelope.references?.[name];
    if (
      typeof value !== "string" ||
      !value ||
      /[\r\n\0]/.test(value) ||
      value.length > 16384
    )
      throw new Error(
        "Selected AWS runtime credential is missing or invalid; value withheld",
      );
    return value;
  };
  const accessKey = read("accessKeyIdEnv"),
    secretKey = read("secretAccessKeyEnv"),
    sessionToken = read("sessionTokenEnv");
  if (
    !/^ASIA[A-Z0-9]{12,124}$/.test(accessKey) ||
    secretKey.length < 16 ||
    sessionToken.length < 16
  )
    throw new Error(
      "Vault runtime requires explicitly selected temporary AWS credentials",
    );
  const awsConfig = path.join(directory, "aws-vault-empty-config");
  try {
    await writeFile(awsConfig, "", { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(awsConfig);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size !== 0 ||
      !privateVaultMetadataMatches(info, uid)
    )
      throw new Error("Selected empty AWS config file is unsafe");
  }
  return {
    AWS_ACCESS_KEY_ID: accessKey,
    AWS_SECRET_ACCESS_KEY: secretKey,
    AWS_SESSION_TOKEN: sessionToken,
    AWS_REGION: p.region,
    AWS_DEFAULT_REGION: p.region,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_CONFIG_FILE: awsConfig,
    AWS_SHARED_CREDENTIALS_FILE: awsConfig,
    PAPERCLIP_SECRETS_AWS_REGION: p.region,
    PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID: p.deploymentId,
    PAPERCLIP_SECRETS_AWS_KMS_KEY_ID: p.kmsKeyId,
  };
}
