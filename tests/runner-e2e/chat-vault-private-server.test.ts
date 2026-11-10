import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHAT_PRIVATE_INPUTS_ENV } from "./chat-private-inputs.js";
import {
  buildPaperclipServerEnvironment,
  buildRunnerE2EProcessEnvironment,
} from "./harness-env.js";
import {
  readSelectedVaultServerEnvironment,
  privateVaultMetadataMatches,
  validVaultBinding,
  vaultPrivateFields,
  vaultExecutionId,
  vaultExecutionIds,
} from "./chat-vault-private-server.js";
import type { MatrixExecution } from "./types.js";

const roots: string[] = [];
afterEach(async () => {
  for (const directory of roots.splice(0))
    await rm(directory, { recursive: true, force: true });
});
function binding() {
  return {
    disposable: true,
    resourceIds: [
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:disposable/deployment-AbCdEf",
      "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012",
    ],
    credentialEnv: [
      "PAPERCLIP_CHAT_EVAL_AWS_ACCESS",
      "PAPERCLIP_CHAT_EVAL_AWS_SECRET",
      "PAPERCLIP_CHAT_EVAL_AWS_SESSION",
      "PAPERCLIP_CHAT_EVAL_VAULT_EXPECTED",
    ],
    prerequisites: {
      provider: "aws_secrets_manager",
      region: "us-east-1",
      deploymentId: "disposable-catalog",
      kmsKeyId:
        "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012",
      secretReference:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:disposable/deployment-AbCdEf",
      accessKeyIdEnv: "PAPERCLIP_CHAT_EVAL_AWS_ACCESS",
      secretAccessKeyEnv: "PAPERCLIP_CHAT_EVAL_AWS_SECRET",
      sessionTokenEnv: "PAPERCLIP_CHAT_EVAL_AWS_SESSION",
      expectedValueEnv: "PAPERCLIP_CHAT_EVAL_VAULT_EXPECTED",
    },
  };
}
async function fixture() {
  const root = await mkdtemp(
    path.join(tmpdir(), "paperclip-runner-e2e-vault-control-"),
  );
  roots.push(root);
  const directory = path.join(root, "selected-private-inputs");
  await mkdir(directory, { mode: 0o700 });
  const filename = path.join(directory, "chat-selected-inputs.json"),
    b = binding();
  const envelope = {
    version: 1,
    executionId: vaultExecutionId,
    references: {
      PAPERCLIP_CHAT_EVAL_AWS_ACCESS: "ASIA1234567890123456",
      PAPERCLIP_CHAT_EVAL_AWS_SECRET: "synthetic-selected-secret-key",
      PAPERCLIP_CHAT_EVAL_AWS_SESSION: "synthetic-selected-session-token",
      PAPERCLIP_CHAT_EVAL_VAULT_EXPECTED: "synthetic-vault-oracle-only",
    },
    external: { schemaVersion: 1, providers: { vault: b } },
    declaredReferenceNames: b.credentialEnv,
    declaredExternalRequirements: [
      { provider: "vault", fields: [...vaultPrivateFields] },
    ],
    setupBlockers: [] as string[],
  };
  const save = () =>
    writeFile(filename, JSON.stringify(envelope), { mode: 0o600 });
  await save();
  return {
    envelope,
    save,
    filename,
    input: {
      executionIds: [vaultExecutionId],
      temporaryRoot: root,
      backendOrigin: "http://127.0.0.1:3399",
      env: {
        [CHAT_PRIVATE_INPUTS_ENV]: filename,
        AWS_ACCESS_KEY_ID: "AMBIENT-DO-NOT-USE",
        AWS_PROFILE: "unrelated-personal-profile",
        PAPERCLIP_SECRETS_AWS_ENDPOINT: "http://unrelated.test",
      },
    },
  };
}
it("supplies only explicitly selected server credentials/config and excludes oracle values/default profiles", async () => {
  const f = await fixture(),
    env = await readSelectedVaultServerEnvironment(f.input);
  expect(env.AWS_ACCESS_KEY_ID).toBe(
    f.envelope.references.PAPERCLIP_CHAT_EVAL_AWS_ACCESS,
  );
  expect(env.AWS_SECRET_ACCESS_KEY).toBe(
    f.envelope.references.PAPERCLIP_CHAT_EVAL_AWS_SECRET,
  );
  expect(env.AWS_SESSION_TOKEN).toBe(
    f.envelope.references.PAPERCLIP_CHAT_EVAL_AWS_SESSION,
  );
  expect(env.AWS_EC2_METADATA_DISABLED).toBe("true");
  expect(env.AWS_PROFILE).toBeUndefined();
  expect(env.PAPERCLIP_SECRETS_AWS_ENDPOINT).toBeUndefined();
  expect(JSON.stringify(env)).not.toContain(
    f.envelope.references.PAPERCLIP_CHAT_EVAL_VAULT_EXPECTED,
  );
  expect(
    Object.keys(env).some((name) => name.startsWith("PAPERCLIP_CHAT_EVAL_")),
  ).toBe(false);
  expect(env.AWS_CONFIG_FILE).toBe(env.AWS_SHARED_CREDENTIALS_FILE);
});
it("keeps missing selected inputs as reserved setup prerequisites without using ambient AWS", async () => {
  const f = await fixture();
  expect(
    await readSelectedVaultServerEnvironment({
      ...f.input,
      env: { AWS_ACCESS_KEY_ID: "ambient" },
    }),
  ).toEqual({});
  f.envelope.setupBlockers = [
    "missing-external-reference:PAPERCLIP_CHAT_EVAL_AWS_ACCESS",
  ];
  await f.save();
  expect(await readSelectedVaultServerEnvironment(f.input)).toEqual({});
  expect(
    await readSelectedVaultServerEnvironment({
      ...f.input,
      executionIds: ["unrelated"],
    }),
  ).toEqual({});
});
it("rejects another execution, unsafe private files, undeclared references and cross-account resources", async () => {
  const f = await fixture();
  await expect(
    readSelectedVaultServerEnvironment({
      ...f.input,
      executionIds: [vaultExecutionId, "unrelated"],
    }),
  ).rejects.toThrow(/single selected/);
  f.envelope.executionId = "another-execution";
  await f.save();
  await expect(readSelectedVaultServerEnvironment(f.input)).rejects.toThrow(
    /another execution/,
  );
  f.envelope.executionId = vaultExecutionId;
  f.envelope.declaredReferenceNames = [];
  await f.save();
  await expect(readSelectedVaultServerEnvironment(f.input)).rejects.toThrow(
    /selected reference/,
  );
  f.envelope.declaredReferenceNames = binding().credentialEnv;
  await f.save();
  await chmod(f.filename, 0o644);
  await expect(readSelectedVaultServerEnvironment(f.input)).rejects.toThrow(
    /private and owned/,
  );
  expect(privateVaultMetadataMatches({ uid: 101, mode: 0o600 }, 101)).toBe(
    true,
  );
  expect(privateVaultMetadataMatches({ uid: 102, mode: 0o600 }, 101)).toBe(
    false,
  );
  const b = binding();
  expect(validVaultBinding(b)).toBe(true);
  b.prerequisites.kmsKeyId = b.prerequisites.kmsKeyId.replace(
    "123456789012",
    "987654321012",
  );
  expect(validVaultBinding(b)).toBe(false);
  const other = binding();
  other.resourceIds = [];
  expect(validVaultBinding(other)).toBe(false);
});
it("scrubs ambient AWS and vault SDK config while preserving explicit unrelated suite mechanisms", () => {
  const ambient = {
    AWS_ACCESS_KEY_ID: "ambient",
    AWS_SECRET_ACCESS_KEY: "ambient-secret",
    AWS_PROFILE: "personal",
    AWS_CONTAINER_CREDENTIALS_FULL_URI: "https://unrelated.test",
    AWS_WEB_IDENTITY_TOKEN_FILE: "/private/personal-token",
    PAPERCLIP_SECRETS_AWS_ENDPOINT: "https://unrelated.test",
    KEEP: "yes",
  };
  expect(buildPaperclipServerEnvironment(ambient)).toEqual({ KEEP: "yes" });
  expect(
    buildPaperclipServerEnvironment(ambient, {
      AWS_ACCESS_KEY_ID: "explicit-selected",
    }).AWS_ACCESS_KEY_ID,
  ).toBe("explicit-selected");
  const execution = {
    suite: { id: "chat-features" },
    task: { id: "secrets.vault-reference" },
    profile: { generation: "native", provider: "codex" },
    environment: { id: "local" },
  } as MatrixExecution;
  const chat = buildRunnerE2EProcessEnvironment(ambient, [execution]);
  expect(
    Object.keys(chat).some(
      (name) =>
        name.startsWith("AWS_") || name.startsWith("PAPERCLIP_SECRETS_AWS_"),
    ),
  ).toBe(false);
  const other = buildRunnerE2EProcessEnvironment(ambient, [
    {
      ...execution,
      suite: { ...execution.suite, id: "explicit-unrelated-suite" },
    },
  ]);
  expect(other.AWS_ACCESS_KEY_ID).toBe("ambient");
});

it("binds the OpenCode vault envelope to the exact selected new execution, never the prior campaign", async () => {
  const f = await fixture();
  f.input.executionIds = [vaultExecutionIds[1]!]; f.envelope.executionId = vaultExecutionIds[1]!; await f.save();
  expect(await readSelectedVaultServerEnvironment(f.input)).toHaveProperty("AWS_ACCESS_KEY_ID", f.envelope.references.PAPERCLIP_CHAT_EVAL_AWS_ACCESS);
  f.envelope.executionId = vaultExecutionId; await f.save();
  await expect(readSelectedVaultServerEnvironment(f.input)).rejects.toThrow();
});
