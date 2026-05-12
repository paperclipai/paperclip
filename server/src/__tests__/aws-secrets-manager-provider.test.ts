import { afterEach, describe, expect, it, vi } from "vitest";
import { createAwsSecretsManagerProvider } from "../secrets/aws-secrets-manager-provider.js";
import { SecretProviderClientError } from "../secrets/types.js";

describe("awsSecretsManagerProvider", () => {
  const previousEnv = {
    PAPERCLIP_SECRETS_AWS_REGION: process.env.PAPERCLIP_SECRETS_AWS_REGION,
    AWS_REGION: process.env.AWS_REGION,
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION,
    PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID: process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID,
    PAPERCLIP_SECRETS_AWS_KMS_KEY_ID: process.env.PAPERCLIP_SECRETS_AWS_KMS_KEY_ID,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
  };

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("creates Paperclip-managed AWS secrets without persisting plaintext in provider material", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = createAwsSecretsManagerProvider({
      config: {
        region: "us-east-1",
        endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
        deploymentId: "prod-use1",
        prefix: "paperclip",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        environmentTag: "production",
        providerOwnerTag: "paperclip",
        deleteRecoveryWindowDays: 30,
      },
      gateway: {
        async createSecret(input) {
          calls.push({ op: "createSecret", input });
          return {
            ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
            VersionId: "aws-version-1",
          };
        },
        async putSecretValue(input) {
          calls.push({ op: "putSecretValue", input });
          return { ARN: String(input.SecretId), VersionId: "unused" };
        },
        async getSecretValue(input) {
          calls.push({ op: "getSecretValue", input });
          return { SecretString: "resolved-value", VersionId: "unused" };
        },
        async deleteSecret(input) {
          calls.push({ op: "deleteSecret", input });
          return {};
        },
      },
    });

    const prepared = await provider.createSecret({
      value: "super-secret-value",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/attacker",
      context: {
        companyId: "company-1",
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 1,
      },
    });

    expect(calls).toEqual([
      expect.objectContaining({
        op: "createSecret",
        input: expect.objectContaining({
          Name: "paperclip/prod-use1/company-1/openai-api-key",
          KmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        }),
      }),
    ]);
    expect(JSON.stringify(prepared)).not.toContain("super-secret-value");
    expect(prepared.externalRef).toContain("paperclip/prod-use1/company-1/openai-api-key");
    expect(prepared.providerVersionRef).toBe("aws-version-1");
  });

  it("creates AWS secrets from selected provider vault config without deployment env fallback", async () => {
    delete process.env.PAPERCLIP_SECRETS_AWS_REGION;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID;
    delete process.env.PAPERCLIP_SECRETS_AWS_KMS_KEY_ID;

    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = createAwsSecretsManagerProvider({
      gateway: {
        async createSecret(input) {
          calls.push({ op: "createSecret", input });
          return {
            ARN: "arn:aws:secretsmanager:us-west-2:123456789012:secret:clip/prod-us-west/company-1/openai-api-key",
            VersionId: "aws-version-1",
          };
        },
        async putSecretValue(input) {
          calls.push({ op: "putSecretValue", input });
          return { ARN: String(input.SecretId), VersionId: "unused" };
        },
        async getSecretValue(input) {
          calls.push({ op: "getSecretValue", input });
          return { SecretString: "resolved-value", VersionId: "unused" };
        },
        async deleteSecret(input) {
          calls.push({ op: "deleteSecret", input });
          return {};
        },
      },
    });

    const providerConfig = {
      id: "vault-1",
      provider: "aws_secrets_manager" as const,
      status: "ready",
      config: {
        region: "us-west-2",
        namespace: "prod-us-west",
        secretNamePrefix: "clip",
        ownerTag: "platform",
        environmentTag: "production",
      },
    };

    const health = await provider.healthCheck({ providerConfig });
    const prepared = await provider.createSecret({
      value: "super-secret-value",
      providerConfig,
      context: {
        companyId: "company-1",
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 1,
      },
    });

    expect(health.status).toBe("ok");
    expect(health.details).toMatchObject({
      region: "us-west-2",
      prefix: "clip",
      deploymentId: "prod-us-west",
      kmsKeyConfigured: false,
    });
    expect(calls).toEqual([
      expect.objectContaining({
        op: "createSecret",
        input: expect.objectContaining({
          Name: "clip/prod-us-west/company-1/openai-api-key",
          SecretString: "super-secret-value",
          Tags: expect.arrayContaining([
            { Key: "paperclip:provider-owner", Value: "platform" },
            { Key: "paperclip:environment", Value: "production" },
          ]),
        }),
      }),
    ]);
    expect(calls[0]?.input).not.toHaveProperty("KmsKeyId");
    expect(JSON.stringify(prepared)).not.toContain("super-secret-value");
    expect(prepared.externalRef).toContain("clip/prod-us-west/company-1/openai-api-key");
  });

  it("signs AWS Secrets Manager JSON requests with default runtime credentials", async () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIA_TEST_ACCESS";
    process.env.AWS_SECRET_ACCESS_KEY = "test-secret-key";
    process.env.AWS_SESSION_TOKEN = "test-session-token";

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod/company-1/openai-api-key",
          VersionId: "aws-version-1",
        }),
        { status: 200 },
      ),
    );
    const provider = createAwsSecretsManagerProvider({
      config: {
        region: "us-east-1",
        endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
        deploymentId: "prod",
        prefix: "paperclip",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        environmentTag: "production",
        providerOwnerTag: "paperclip",
        deleteRecoveryWindowDays: 30,
      },
    });

    await provider.createSecret({
      value: "super-secret-value",
      context: {
        companyId: "company-1",
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 1,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(String(url)).toBe("https://secretsmanager.us-east-1.amazonaws.com/");
    expect(headers["x-amz-target"]).toBe("secretsmanager.CreateSecret");
    expect(headers["x-amz-security-token"]).toBe("test-session-token");
    expect(headers.authorization).toContain("Credential=AKIA_TEST_ACCESS/");
    expect(headers.authorization).toContain("/us-east-1/secretsmanager/aws4_request");
    expect(headers.authorization).toContain("SignedHeaders=");
    expect(headers.authorization).toContain("Signature=");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("creates new AWS secret versions against a namespace-valid existing secret reference", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = createAwsSecretsManagerProvider({
      config: {
        region: "us-east-1",
        endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
        deploymentId: "prod-use1",
        prefix: "paperclip",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        environmentTag: "production",
        providerOwnerTag: "paperclip",
        deleteRecoveryWindowDays: 30,
      },
      gateway: {
        async createSecret() {
          throw new Error("not used");
        },
        async putSecretValue(input) {
          calls.push({ op: "putSecretValue", input });
          return {
            ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
            VersionId: "aws-version-2",
          };
        },
        async getSecretValue() {
          throw new Error("not used");
        },
        async deleteSecret() {
          throw new Error("not used");
        },
      },
    });

    const prepared = await provider.createVersion({
      value: "rotated-secret-value",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
      context: {
        companyId: "company-1",
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 2,
      },
    });

    expect(calls).toEqual([
      {
        op: "putSecretValue",
        input: {
          SecretId:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
          SecretString: "rotated-secret-value",
          VersionStages: ["PAPERCLIP_PENDING"],
        },
      },
    ]);
    expect(JSON.stringify(prepared)).not.toContain("rotated-secret-value");
    expect(prepared.providerVersionRef).toBe("aws-version-2");
  });

  it("rejects out-of-namespace refs for managed AWS secret version writes", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = createAwsSecretsManagerProvider({
      config: {
        region: "us-east-1",
        endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
        deploymentId: "prod-use1",
        prefix: "paperclip",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        environmentTag: "production",
        providerOwnerTag: "paperclip",
        deleteRecoveryWindowDays: 30,
      },
      gateway: {
        async createSecret() {
          throw new Error("not used");
        },
        async putSecretValue(input) {
          calls.push({ op: "putSecretValue", input });
          return { Name: String(input.SecretId), VersionId: "aws-version-2" };
        },
        async getSecretValue() {
          throw new Error("not used");
        },
        async deleteSecret() {
          throw new Error("not used");
        },
      },
    });

    await expect(
      provider.createVersion({
        value: "rotated-secret-value",
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/attacker",
        context: {
          companyId: "company-1",
          secretKey: "openai-api-key",
          secretName: "OpenAI API Key",
          version: 2,
        },
      }),
    ).rejects.toThrow(/drifted outside the derived deployment\/company scope/i);

    expect(calls).toEqual([]);
  });

  it("stores linked external references as metadata-only provider material", async () => {
    const provider = createAwsSecretsManagerProvider({
      config: {
        region: "us-east-1",
        endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
        deploymentId: "prod-use1",
        prefix: "paperclip",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        environmentTag: "production",
        providerOwnerTag: "paperclip",
        deleteRecoveryWindowDays: 30,
      },
    });

    const prepared = await provider.linkExternalSecret({
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/external",
      providerVersionRef: "linked-version-7",
    });

    expect(prepared.externalRef).toBe(
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/external",
    );
    expect(prepared.providerVersionRef).toBe("linked-version-7");
    expect(prepared.valueSha256).toBeTruthy();
  });

  it("rejects linked external references under the Paperclip-managed namespace", async () => {
    const provider = createAwsSecretsManagerProvider({
      config: {
        region: "us-east-1",
        endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
        deploymentId: "prod-use1",
        prefix: "paperclip",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        environmentTag: "production",
        providerOwnerTag: "paperclip",
        deleteRecoveryWindowDays: 30,
      },
    });

    await expect(
      provider.linkExternalSecret({
        externalRef:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-2/openai-api-key",
        providerVersionRef: "linked-version-7",
      }),
    ).rejects.toThrow(/Paperclip-managed namespace/i);
  });

  it("lists remote AWS secrets with metadata only and never resolves plaintext", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = createAwsSecretsManagerProvider({
      config: {
        region: "us-east-1",
        endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
        deploymentId: "prod-use1",
        prefix: "paperclip",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        environmentTag: "production",
        providerOwnerTag: "paperclip",
        deleteRecoveryWindowDays: 30,
      },
      gateway: {
        async createSecret() {
          throw new Error("not used");
        },
        async putSecretValue() {
          throw new Error("not used");
        },
        async getSecretValue() {
          throw new Error("GetSecretValue must not be used for remote import preview");
        },
        async deleteSecret() {
          throw new Error("not used");
        },
        async listSecrets(input) {
          calls.push({ op: "listSecrets", input });
          return {
            NextToken: "token-2",
            SecretList: [
              {
                ARN: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
                Name: "prod/openai",
                Description: "OpenAI API key",
                CreatedDate: new Date("2026-05-06T00:00:00.000Z"),
                Tags: [{ Key: "team", Value: "platform" }],
              },
            ],
          };
        },
      },
    });

    const listed = await provider.listRemoteSecrets?.({
      query: "openai",
      nextToken: "token-1",
      pageSize: 25,
    });

    expect(calls).toEqual([
      {
        op: "listSecrets",
        input: {
          MaxResults: 25,
          NextToken: "token-1",
          IncludePlannedDeletion: false,
          Filters: [{ Key: "all", Values: ["openai"] }],
        },
      },
    ]);
    expect(listed).toEqual({
      nextToken: "token-2",
      secrets: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
          name: "prod/openai",
          providerVersionRef: null,
          metadata: expect.objectContaining({
            createdDate: "2026-05-06T00:00:00.000Z",
            hasDescription: true,
            tagCount: 1,
          }),
        },
      ],
    });
    expect(JSON.stringify(listed)).not.toContain("SecretString");
    expect(JSON.stringify(listed)).not.toContain("OpenAI API key");
    expect(JSON.stringify(listed)).not.toContain("team");
  });

  it("redacts AWS provider exception text when remote listing fails", async () => {
    const rawProviderMessage =
      "AccessDeniedException: User: arn:aws:sts::123456789012:assumed-role/prod/Paperclip is not authorized to perform secretsmanager:ListSecrets on arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai";
    const provider = createAwsSecretsManagerProvider({
      config: {
        region: "us-east-1",
        endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
        deploymentId: "prod-use1",
        prefix: "paperclip",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        environmentTag: "production",
        providerOwnerTag: "paperclip",
        deleteRecoveryWindowDays: 30,
      },
      gateway: {
        async createSecret() {
          throw new Error("not used");
        },
        async putSecretValue() {
          throw new Error("not used");
        },
        async getSecretValue() {
          throw new Error("not used");
        },
        async deleteSecret() {
          throw new Error("not used");
        },
        async listSecrets() {
          throw new Error(rawProviderMessage);
        },
      },
    });

    let thrown: unknown;
    try {
      await provider.listRemoteSecrets?.({});
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SecretProviderClientError);
    expect(thrown).toMatchObject({
      code: "access_denied",
      status: 403,
      message: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
      rawMessage: rawProviderMessage,
    });
    expect(thrown instanceof Error ? thrown.message : String(thrown)).not.toContain("arn:aws");
    expect(thrown instanceof Error ? thrown.message : String(thrown)).not.toContain("123456789012");
  });

  it("resolves AWS secret values by provider version reference", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = createAwsSecretsManagerProvider({
      config: {
        region: "us-east-1",
        endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
        deploymentId: "prod-use1",
        prefix: "paperclip",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        environmentTag: "production",
        providerOwnerTag: "paperclip",
        deleteRecoveryWindowDays: 30,
      },
      gateway: {
        async createSecret() {
          throw new Error("not used");
        },
        async putSecretValue() {
          throw new Error("not used");
        },
        async getSecretValue(input) {
          calls.push({ op: "getSecretValue", input });
          return { SecretString: "resolved-secret-value", VersionId: "aws-version-2" };
        },
        async deleteSecret() {
          throw new Error("not used");
        },
      },
    });

    const resolved = await provider.resolveVersion({
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
        versionId: "aws-version-2",
        source: "managed",
      },
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
      providerVersionRef: "aws-version-2",
      context: {
        companyId: "company-1",
        secretId: "secret-1",
        secretKey: "openai-api-key",
        version: 2,
      },
    });

    expect(resolved).toBe("resolved-secret-value");
    expect(calls).toEqual([
      {
        op: "getSecretValue",
        input: {
          SecretId:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
          VersionId: "aws-version-2",
          VersionStage: undefined,
        },
      },
    ]);
  });

  it("rejects managed resolve attempts when stored refs drift outside the derived scope", async () => {
    const provider = createAwsSecretsManagerProvider({
      config: {
        region: "us-east-1",
        endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
        deploymentId: "prod-use1",
        prefix: "paperclip",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        environmentTag: "production",
        providerOwnerTag: "paperclip",
        deleteRecoveryWindowDays: 30,
      },
      gateway: {
        async createSecret() {
          throw new Error("not used");
        },
        async putSecretValue() {
          throw new Error("not used");
        },
        async getSecretValue() {
          throw new Error("should not be called");
        },
        async deleteSecret() {
          throw new Error("not used");
        },
      },
    });

    await expect(
      provider.resolveVersion({
        material: {
          scheme: "aws_secrets_manager_v1",
          secretId:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-2/openai-api-key",
          versionId: "aws-version-2",
          source: "managed",
        },
        externalRef:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-2/openai-api-key",
        providerVersionRef: "aws-version-2",
        context: {
          companyId: "company-1",
          secretId: "secret-1",
          secretKey: "openai-api-key",
          version: 2,
        },
      }),
    ).rejects.toThrow(/drifted outside the derived deployment\/company scope/i);
  });

  it("warns when AWS provider configuration is incomplete and blocks managed writes", async () => {
    delete process.env.PAPERCLIP_SECRETS_AWS_REGION;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID;
    delete process.env.PAPERCLIP_SECRETS_AWS_KMS_KEY_ID;

    const provider = createAwsSecretsManagerProvider();
    const health = await provider.healthCheck();

    expect(health.status).toBe("warn");
    expect(health.message).toContain("missing PAPERCLIP_SECRETS_AWS_REGION");
    expect(health.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Missing required non-secret AWS provider config"),
        expect.stringContaining("AWS bootstrap credentials must be available"),
        expect.stringContaining("Do not store AWS root credentials"),
      ]),
    );
    expect(health.details).toMatchObject({
      missingConfig: [
        "PAPERCLIP_SECRETS_AWS_REGION or AWS_REGION/AWS_DEFAULT_REGION",
        "PAPERCLIP_SECRETS_AWS_DEPLOYMENT_ID",
        "PAPERCLIP_SECRETS_AWS_KMS_KEY_ID",
      ],
      credentialSource: "AWS SDK default credential provider chain",
    });
    await expect(
      provider.createSecret({
        value: "super-secret-value",
        context: {
          companyId: "company-1",
          secretKey: "openai-api-key",
          secretName: "OpenAI API Key",
          version: 1,
        },
      }),
    ).rejects.toThrow(/PAPERCLIP_SECRETS_AWS_REGION|AWS_REGION/i);
  });

  it("deletes only Paperclip-managed AWS secrets", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = createAwsSecretsManagerProvider({
      config: {
        region: "us-east-1",
        endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
        deploymentId: "prod-use1",
        prefix: "paperclip",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        environmentTag: "production",
        providerOwnerTag: "paperclip",
        deleteRecoveryWindowDays: 30,
      },
      gateway: {
        async createSecret() {
          throw new Error("not used");
        },
        async putSecretValue() {
          throw new Error("not used");
        },
        async getSecretValue() {
          throw new Error("not used");
        },
        async deleteSecret(input) {
          calls.push({ op: "deleteSecret", input });
          return {};
        },
      },
    });

    await provider.deleteOrArchive({
      mode: "delete",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
        versionId: null,
        source: "managed",
      },
      context: {
        companyId: "company-1",
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 2,
      },
    });
    await expect(
      provider.deleteOrArchive({
        mode: "delete",
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/attacker",
        material: {
          scheme: "aws_secrets_manager_v1",
          secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/attacker",
          versionId: null,
          source: "managed",
        },
        context: {
          companyId: "company-1",
          secretKey: "openai-api-key",
          secretName: "OpenAI API Key",
          version: 2,
        },
      }),
    ).rejects.toThrow(/drifted outside the derived deployment\/company scope/i);
    await provider.deleteOrArchive({
      mode: "delete",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/external",
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/external",
        versionId: "linked-version-7",
        source: "external_reference",
      },
      context: {
        companyId: "company-1",
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 2,
      },
    });

    expect(calls).toEqual([
      {
        op: "deleteSecret",
        input: {
          SecretId:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
          RecoveryWindowInDays: 30,
        },
      },
    ]);
  });

  it("archives pending Paperclip-managed AWS versions without deleting the secret", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = createAwsSecretsManagerProvider({
      config: {
        region: "us-east-1",
        endpoint: "https://secretsmanager.us-east-1.amazonaws.com",
        deploymentId: "prod-use1",
        prefix: "paperclip",
        kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/test",
        environmentTag: "production",
        providerOwnerTag: "paperclip",
        deleteRecoveryWindowDays: 30,
      },
      gateway: {
        async createSecret() {
          throw new Error("not used");
        },
        async putSecretValue() {
          throw new Error("not used");
        },
        async getSecretValue() {
          throw new Error("not used");
        },
        async deleteSecret(input) {
          calls.push({ op: "deleteSecret", input });
          return {};
        },
        async updateSecretVersionStage(input) {
          calls.push({ op: "updateSecretVersionStage", input });
          return {};
        },
      },
    });

    await provider.deleteOrArchive({
      mode: "archive",
      externalRef:
        "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
      material: {
        scheme: "aws_secrets_manager_v1",
        secretId:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
        versionId: "aws-version-2",
        source: "managed",
      },
      context: {
        companyId: "company-1",
        secretKey: "openai-api-key",
        secretName: "OpenAI API Key",
        version: 2,
      },
    });

    expect(calls).toEqual([
      {
        op: "updateSecretVersionStage",
        input: {
          SecretId:
            "arn:aws:secretsmanager:us-east-1:123456789012:secret:paperclip/prod-use1/company-1/openai-api-key",
          VersionStage: "PAPERCLIP_PENDING",
          RemoveFromVersionId: "aws-version-2",
        },
      },
    ]);
  });
});
