import { describe, expect, it } from "vitest";
import {
  buildK8sEnvironmentConfig,
  parseAccountsList,
  parseKeyValueLines,
  parseTolerationsJson,
  readProviderExtras,
} from "./environment-form";

describe("parseKeyValueLines", () => {
  it("parses key=value pairs separated by newlines", () => {
    expect(parseKeyValueLines("foo=bar\nbaz=qux")).toEqual({
      foo: "bar",
      baz: "qux",
    });
  });

  it("supports key: value form", () => {
    expect(parseKeyValueLines("foo: bar\nbaz: qux")).toEqual({
      foo: "bar",
      baz: "qux",
    });
  });

  it("ignores blank lines and comments", () => {
    expect(parseKeyValueLines("\n# comment\nfoo=bar\n   \n")).toEqual({
      foo: "bar",
    });
  });

  it("returns null for malformed entries", () => {
    expect(parseKeyValueLines("not-a-pair")).toBeNull();
  });

  it("returns an empty object for whitespace-only input", () => {
    expect(parseKeyValueLines("   \n  \n")).toEqual({});
  });
});

describe("parseTolerationsJson", () => {
  it("parses an array of tolerations", () => {
    const result = parseTolerationsJson(
      JSON.stringify([{ key: "foo", operator: "Equal", value: "bar", effect: "NoSchedule" }]),
    );
    expect(result).toEqual([
      { key: "foo", operator: "Equal", value: "bar", effect: "NoSchedule" },
    ]);
  });

  it("returns undefined for empty input", () => {
    expect(parseTolerationsJson("")).toBeUndefined();
    expect(parseTolerationsJson("   ")).toBeUndefined();
  });

  it("returns null sentinel for invalid JSON", () => {
    expect(parseTolerationsJson("not json")).toBeNull();
  });

  it("returns null sentinel when value is not an array", () => {
    expect(parseTolerationsJson('{"key":"foo"}')).toBeNull();
  });
});

describe("buildK8sEnvironmentConfig", () => {
  it("returns an empty object when nothing is filled in (in-cluster auth)", () => {
    expect(
      buildK8sEnvironmentConfig({
        k8sKubeconfigSecretRef: "",
        k8sUseInClusterAuth: true,
        k8sNamespace: "",
        k8sServiceAccountName: "",
        k8sNodeSelector: "",
        k8sTolerations: "",
        k8sLabels: "",
        k8sImagePullPolicy: "",
        k8sResourcesRequestsCpu: "",
        k8sResourcesRequestsMemory: "",
        k8sResourcesLimitsCpu: "",
        k8sResourcesLimitsMemory: "",
        k8sWorkspaceVolumeClaim: "",
        k8sWorkspaceMountPath: "",
        k8sSecretsNamespace: "",
        k8sProviderAnthropicKind: "ccrotate",
        k8sProviderAnthropicAccounts: "",
        k8sProviderOpenaiKind: "ccrotate",
        k8sProviderOpenaiAccounts: "",
        k8sProviderExtras: {},
      }),
    ).toEqual({});
  });

  it("includes kubeconfigSecretRef only when not using in-cluster auth", () => {
    const usingSecret = buildK8sEnvironmentConfig({
      k8sKubeconfigSecretRef: "kubeconfig-prod",
      k8sUseInClusterAuth: false,
      k8sNamespace: "",
      k8sServiceAccountName: "",
      k8sNodeSelector: "",
      k8sTolerations: "",
      k8sLabels: "",
      k8sImagePullPolicy: "",
      k8sResourcesRequestsCpu: "",
      k8sResourcesRequestsMemory: "",
      k8sResourcesLimitsCpu: "",
      k8sResourcesLimitsMemory: "",
      k8sWorkspaceVolumeClaim: "",
      k8sWorkspaceMountPath: "",
      k8sSecretsNamespace: "",
      k8sProviderAnthropicKind: "ccrotate",
      k8sProviderAnthropicAccounts: "",
      k8sProviderOpenaiKind: "ccrotate",
      k8sProviderOpenaiAccounts: "",
      k8sProviderExtras: {},
    });
    expect(usingSecret).toEqual({ kubeconfigSecretRef: "kubeconfig-prod" });

    const inCluster = buildK8sEnvironmentConfig({
      k8sKubeconfigSecretRef: "kubeconfig-prod",
      k8sUseInClusterAuth: true,
      k8sNamespace: "",
      k8sServiceAccountName: "",
      k8sNodeSelector: "",
      k8sTolerations: "",
      k8sLabels: "",
      k8sImagePullPolicy: "",
      k8sResourcesRequestsCpu: "",
      k8sResourcesRequestsMemory: "",
      k8sResourcesLimitsCpu: "",
      k8sResourcesLimitsMemory: "",
      k8sWorkspaceVolumeClaim: "",
      k8sWorkspaceMountPath: "",
      k8sSecretsNamespace: "",
      k8sProviderAnthropicKind: "ccrotate",
      k8sProviderAnthropicAccounts: "",
      k8sProviderOpenaiKind: "ccrotate",
      k8sProviderOpenaiAccounts: "",
      k8sProviderExtras: {},
    });
    expect(inCluster).toEqual({});
    expect(inCluster).not.toHaveProperty("kubeconfigSecretRef");
  });

  it("trims namespace, service account, workspace, secrets fields", () => {
    expect(
      buildK8sEnvironmentConfig({
        k8sKubeconfigSecretRef: "",
        k8sUseInClusterAuth: true,
        k8sNamespace: "  prod  ",
        k8sServiceAccountName: "  paperclip-runner  ",
        k8sNodeSelector: "",
        k8sTolerations: "",
        k8sLabels: "",
        k8sImagePullPolicy: "",
        k8sResourcesRequestsCpu: "",
        k8sResourcesRequestsMemory: "",
        k8sResourcesLimitsCpu: "",
        k8sResourcesLimitsMemory: "",
        k8sWorkspaceVolumeClaim: "  workspace-pvc  ",
        k8sWorkspaceMountPath: "  /workspace  ",
        k8sSecretsNamespace: "  paperclip-secrets  ",
        k8sProviderAnthropicKind: "ccrotate",
        k8sProviderAnthropicAccounts: "",
        k8sProviderOpenaiKind: "ccrotate",
        k8sProviderOpenaiAccounts: "",
        k8sProviderExtras: {},
      }),
    ).toEqual({
      namespace: "prod",
      serviceAccountName: "paperclip-runner",
      workspaceVolumeClaim: "workspace-pvc",
      workspaceMountPath: "/workspace",
      secretsNamespace: "paperclip-secrets",
    });
  });

  it("parses node selector and labels into records", () => {
    expect(
      buildK8sEnvironmentConfig({
        k8sKubeconfigSecretRef: "",
        k8sUseInClusterAuth: true,
        k8sNamespace: "",
        k8sServiceAccountName: "",
        k8sNodeSelector: "tier=runner\nzone=us-east-1a",
        k8sTolerations: "",
        k8sLabels: "app=paperclip\nteam=core",
        k8sImagePullPolicy: "",
        k8sResourcesRequestsCpu: "",
        k8sResourcesRequestsMemory: "",
        k8sResourcesLimitsCpu: "",
        k8sResourcesLimitsMemory: "",
        k8sWorkspaceVolumeClaim: "",
        k8sWorkspaceMountPath: "",
        k8sSecretsNamespace: "",
        k8sProviderAnthropicKind: "ccrotate",
        k8sProviderAnthropicAccounts: "",
        k8sProviderOpenaiKind: "ccrotate",
        k8sProviderOpenaiAccounts: "",
        k8sProviderExtras: {},
      }),
    ).toEqual({
      nodeSelector: { tier: "runner", zone: "us-east-1a" },
      labels: { app: "paperclip", team: "core" },
    });
  });

  it("includes only requests when limits are blank", () => {
    expect(
      buildK8sEnvironmentConfig({
        k8sKubeconfigSecretRef: "",
        k8sUseInClusterAuth: true,
        k8sNamespace: "",
        k8sServiceAccountName: "",
        k8sNodeSelector: "",
        k8sTolerations: "",
        k8sLabels: "",
        k8sImagePullPolicy: "",
        k8sResourcesRequestsCpu: "500m",
        k8sResourcesRequestsMemory: "1Gi",
        k8sResourcesLimitsCpu: "",
        k8sResourcesLimitsMemory: "",
        k8sWorkspaceVolumeClaim: "",
        k8sWorkspaceMountPath: "",
        k8sSecretsNamespace: "",
        k8sProviderAnthropicKind: "ccrotate",
        k8sProviderAnthropicAccounts: "",
        k8sProviderOpenaiKind: "ccrotate",
        k8sProviderOpenaiAccounts: "",
        k8sProviderExtras: {},
      }),
    ).toEqual({
      resources: { requests: { cpu: "500m", memory: "1Gi" } },
    });
  });

  it("includes both requests and limits when set", () => {
    expect(
      buildK8sEnvironmentConfig({
        k8sKubeconfigSecretRef: "",
        k8sUseInClusterAuth: true,
        k8sNamespace: "",
        k8sServiceAccountName: "",
        k8sNodeSelector: "",
        k8sTolerations: "",
        k8sLabels: "",
        k8sImagePullPolicy: "IfNotPresent",
        k8sResourcesRequestsCpu: "500m",
        k8sResourcesRequestsMemory: "1Gi",
        k8sResourcesLimitsCpu: "1",
        k8sResourcesLimitsMemory: "2Gi",
        k8sWorkspaceVolumeClaim: "",
        k8sWorkspaceMountPath: "",
        k8sSecretsNamespace: "",
        k8sProviderAnthropicKind: "ccrotate",
        k8sProviderAnthropicAccounts: "",
        k8sProviderOpenaiKind: "ccrotate",
        k8sProviderOpenaiAccounts: "",
        k8sProviderExtras: {},
      }),
    ).toEqual({
      imagePullPolicy: "IfNotPresent",
      resources: {
        requests: { cpu: "500m", memory: "1Gi" },
        limits: { cpu: "1", memory: "2Gi" },
      },
    });
  });

  it("parses tolerations JSON when valid", () => {
    expect(
      buildK8sEnvironmentConfig({
        k8sKubeconfigSecretRef: "",
        k8sUseInClusterAuth: true,
        k8sNamespace: "",
        k8sServiceAccountName: "",
        k8sNodeSelector: "",
        k8sTolerations: '[{"key":"dedicated","operator":"Equal","value":"paperclip","effect":"NoSchedule"}]',
        k8sLabels: "",
        k8sImagePullPolicy: "",
        k8sResourcesRequestsCpu: "",
        k8sResourcesRequestsMemory: "",
        k8sResourcesLimitsCpu: "",
        k8sResourcesLimitsMemory: "",
        k8sWorkspaceVolumeClaim: "",
        k8sWorkspaceMountPath: "",
        k8sSecretsNamespace: "",
        k8sProviderAnthropicKind: "ccrotate",
        k8sProviderAnthropicAccounts: "",
        k8sProviderOpenaiKind: "ccrotate",
        k8sProviderOpenaiAccounts: "",
        k8sProviderExtras: {},
      }),
    ).toEqual({
      tolerations: [
        { key: "dedicated", operator: "Equal", value: "paperclip", effect: "NoSchedule" },
      ],
    });
  });

  it("omits providers when both account textareas are empty", () => {
    const result = buildK8sEnvironmentConfig({
      k8sKubeconfigSecretRef: "",
      k8sUseInClusterAuth: true,
      k8sNamespace: "",
      k8sServiceAccountName: "",
      k8sNodeSelector: "",
      k8sTolerations: "",
      k8sLabels: "",
      k8sImagePullPolicy: "",
      k8sResourcesRequestsCpu: "",
      k8sResourcesRequestsMemory: "",
      k8sResourcesLimitsCpu: "",
      k8sResourcesLimitsMemory: "",
      k8sWorkspaceVolumeClaim: "",
      k8sWorkspaceMountPath: "",
      k8sSecretsNamespace: "",
      k8sProviderAnthropicKind: "ccrotate",
      k8sProviderAnthropicAccounts: "",
      k8sProviderOpenaiKind: "ccrotate",
      k8sProviderOpenaiAccounts: "   \n  ",
      k8sProviderExtras: {},
    });
    expect(result).not.toHaveProperty("providers");
  });

  it("emits providers.anthropic only when only anthropic textarea is populated", () => {
    expect(
      buildK8sEnvironmentConfig({
        k8sKubeconfigSecretRef: "",
        k8sUseInClusterAuth: true,
        k8sNamespace: "",
        k8sServiceAccountName: "",
        k8sNodeSelector: "",
        k8sTolerations: "",
        k8sLabels: "",
        k8sImagePullPolicy: "",
        k8sResourcesRequestsCpu: "",
        k8sResourcesRequestsMemory: "",
        k8sResourcesLimitsCpu: "",
        k8sResourcesLimitsMemory: "",
        k8sWorkspaceVolumeClaim: "",
        k8sWorkspaceMountPath: "",
        k8sSecretsNamespace: "",
        k8sProviderAnthropicKind: "ccrotate",
        k8sProviderAnthropicAccounts: "a@b.net\nc@d.net",
        k8sProviderOpenaiKind: "ccrotate",
        k8sProviderOpenaiAccounts: "",
        k8sProviderExtras: {},
      }),
    ).toEqual({
      providers: {
        anthropic: { kind: "ccrotate", accounts: ["a@b.net", "c@d.net"] },
      },
    });
  });

  it("emits both anthropic and openai pools when both textareas populated", () => {
    expect(
      buildK8sEnvironmentConfig({
        k8sKubeconfigSecretRef: "",
        k8sUseInClusterAuth: true,
        k8sNamespace: "",
        k8sServiceAccountName: "",
        k8sNodeSelector: "",
        k8sTolerations: "",
        k8sLabels: "",
        k8sImagePullPolicy: "",
        k8sResourcesRequestsCpu: "",
        k8sResourcesRequestsMemory: "",
        k8sResourcesLimitsCpu: "",
        k8sResourcesLimitsMemory: "",
        k8sWorkspaceVolumeClaim: "",
        k8sWorkspaceMountPath: "",
        k8sSecretsNamespace: "",
        k8sProviderAnthropicKind: "ccrotate",
        k8sProviderAnthropicAccounts: "a@b.net",
        k8sProviderOpenaiKind: "ccrotate",
        k8sProviderOpenaiAccounts: "x@y.net, z@w.net",
        k8sProviderExtras: {},
      }),
    ).toEqual({
      providers: {
        anthropic: { kind: "ccrotate", accounts: ["a@b.net"] },
        openai: { kind: "ccrotate", accounts: ["x@y.net", "z@w.net"] },
      },
    });
  });
});

describe("parseAccountsList", () => {
  it("splits on newlines", () => {
    expect(parseAccountsList("a@b.net\nc@d.net")).toEqual(["a@b.net", "c@d.net"]);
  });

  it("splits on commas with optional whitespace", () => {
    expect(parseAccountsList("a@b.net, c@d.net,e@f.net")).toEqual([
      "a@b.net",
      "c@d.net",
      "e@f.net",
    ]);
  });

  it("supports a mix of newlines, commas, and whitespace", () => {
    expect(parseAccountsList("  a@b.net , c@d.net\n\n  e@f.net  ")).toEqual([
      "a@b.net",
      "c@d.net",
      "e@f.net",
    ]);
  });

  it("returns an empty array for empty / whitespace-only input", () => {
    expect(parseAccountsList("")).toEqual([]);
    expect(parseAccountsList("   \n  \n,, ")).toEqual([]);
  });

  it("deduplicates exact repeats", () => {
    expect(parseAccountsList("a@b.net\na@b.net")).toEqual(["a@b.net"]);
  });

  it("deduplicates case-insensitively, preserving first-seen casing", () => {
    expect(parseAccountsList("Foo@Bar.net\nfoo@bar.net\nFOO@BAR.NET")).toEqual([
      "Foo@Bar.net",
    ]);
  });
});

describe("readProviderExtras", () => {
  it("returns {} for non-object inputs", () => {
    expect(readProviderExtras(null)).toEqual({});
    expect(readProviderExtras(undefined)).toEqual({});
    expect(readProviderExtras("nope")).toEqual({});
    expect(readProviderExtras([])).toEqual({});
  });

  it("ignores known provider keys (anthropic, openai)", () => {
    expect(
      readProviderExtras({
        anthropic: { kind: "ccrotate", accounts: ["a@b.net"] },
        openai: { kind: "ccrotate", accounts: ["c@d.net"] },
      }),
    ).toEqual({});
  });

  it("preserves unknown provider keys with valid ccrotate shape", () => {
    expect(
      readProviderExtras({
        anthropic: { kind: "ccrotate", accounts: ["a@b.net"] },
        claude: { kind: "ccrotate", accounts: ["e@f.net"] },
        Anthropic: { kind: "ccrotate", accounts: ["g@h.net"] },
      }),
    ).toEqual({
      claude: { kind: "ccrotate", accounts: ["e@f.net"] },
      Anthropic: { kind: "ccrotate", accounts: ["g@h.net"] },
    });
  });

  it("drops malformed entries (wrong kind, missing accounts, empty accounts)", () => {
    expect(
      readProviderExtras({
        bad1: { kind: "other", accounts: ["x@y.net"] },
        bad2: { kind: "ccrotate" },
        bad3: { kind: "ccrotate", accounts: [] },
        bad4: { kind: "ccrotate", accounts: [123, null] },
        good: { kind: "ccrotate", accounts: ["v@w.net"] },
      }),
    ).toEqual({
      good: { kind: "ccrotate", accounts: ["v@w.net"] },
    });
  });
});
