import { bindAcpxCandidateAdmission, type AcpxCandidateAdmission } from "./candidate-admission.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KIMI_DISTRIBUTION_CLOSURE_SHA256, KIMI_NODE_DISTRIBUTIONS, KIMI_NODE_VERSION, KIMI_RUNTIME_VERSION } from "./kimi-closure-pins.js";
import { KimiMetadataProbeError } from "./kimi-models.js";
import { QUALIFIED_ACPX_PROFILES } from "./qualified-profiles.js";

const mocks = vi.hoisted(() => ({ installation: vi.fn(), open: vi.fn(), close: vi.fn(), metadata: vi.fn() }));
vi.mock("./kimi-installation.js", () => ({ verifyKimiInstallation: mocks.installation }));
vi.mock("./kimi-models.js", async original => ({ ...await original<object>(), probeKimiModels: mocks.metadata }));
import { kimiMetadataProbeNodeDigest, probeKimiMetadata, validateKimiMetadata } from "./kimi-metadata-probe.js";

const model = "selected-model";
const apiKey = "selected-secret-canary";
const target = `${process.platform}-${process.arch}` as keyof typeof KIMI_DISTRIBUTION_CLOSURE_SHA256;
const admissionSource = () => ({ schema: "paperclip.acpx-candidate-admission.v1", companyId: "metadata-company", agent: "kimi", model,
  profileDigest: QUALIFIED_ACPX_PROFILES.kimi.commandDigest,
  nativeClosureDigest: `sha256:${KIMI_DISTRIBUTION_CLOSURE_SHA256[target]}`,
  platform: process.platform, architecture: process.arch, expiresAt: Date.now() + 60_000 } as AcpxCandidateAdmission);
const admission = () => QUALIFIED_ACPX_PROFILES.kimi.qualificationStatus === "pending"
  ? bindAcpxCandidateAdmission(admissionSource(), { runId: "metadata-operation", normalizedSessionId: "metadata-session" }) : undefined;
const receipt = () => ({ schema: "paperclip.kimi.metadata.v1", status: "verified", version: KIMI_RUNTIME_VERSION,
  nodeVersion: KIMI_NODE_VERSION, profileDigest: QUALIFIED_ACPX_PROFILES.kimi.commandDigest, target,
  closureDigest: `sha256:${KIMI_DISTRIBUTION_CLOSURE_SHA256[target]}`, model, contextLength: 1048576, promptSent: false });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.installation.mockResolvedValue({ openCommand: mocks.open });
  mocks.open.mockResolvedValue({ close: mocks.close });
  mocks.close.mockResolvedValue(undefined);
  mocks.metadata.mockResolvedValue({ model, contextLength: 1048576 });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("Kimi setup metadata admission", () => {
  it("verifies and closes the complete installation before authenticating the exact selected model", async () => {
    const order: string[] = [];
    mocks.open.mockImplementation(async () => { order.push("verify-closure"); return { close: mocks.close }; });
    mocks.close.mockImplementation(async () => { order.push("cleanup"); });
    mocks.metadata.mockImplementation(async () => { order.push("authenticate"); return { model, contextLength: 1048576 }; });
    vi.stubEnv("KIMI_API_KEY", "unselected-ambient-secret");
    vi.stubEnv("KIMI_MODEL_DEFAULT", "unselected-model");
    await expect(probeKimiMetadata(model, apiKey, admission())).resolves.toEqual(receipt());
    expect(order).toEqual(["verify-closure", "cleanup", "authenticate"]);
    expect(mocks.installation).toHaveBeenCalledWith(expect.objectContaining({
      agent: "kimi", commandDigest: QUALIFIED_ACPX_PROFILES.kimi.commandDigest,
      qualificationModel: model, reportedModelId: model,
    }));
    expect(mocks.metadata).toHaveBeenCalledExactlyOnceWith(model, apiKey);
  });

  it.each(["metadata", "closure", "cleanup"])("rejects %s installation failure before authenticating", async stage => {
    const error = new Error(`private runtime failure ${apiKey}`);
    if (stage === "metadata") mocks.installation.mockRejectedValue(error);
    if (stage === "closure") mocks.open.mockRejectedValue(error);
    if (stage === "cleanup") mocks.close.mockRejectedValue(error);
    const result = await probeKimiMetadata(model, apiKey, admission());
    expect(result).toMatchObject({ status: "failed", code: "KIMI_INSTALLATION_INVALID", promptSent: false });
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(mocks.metadata).not.toHaveBeenCalled();
  });

  it("keeps a future pending profile behind exact trusted startup authority before files or HTTP", async () => {
    vi.resetModules();
    vi.doMock("./generated-profiles.js", async original => {
      const data = await original<typeof import("./generated-profiles.js")>();
      const current = structuredClone(data.QUALIFIED_ACPX_PROFILE_DATA);
      return { ...data, QUALIFIED_ACPX_PROFILE_DATA: { ...current, kimi: { ...current.kimi, qualificationStatus: "pending" } } };
    });
    try {
      const pending = await import("./kimi-metadata-probe.js");
      const authority = await import("./candidate-admission.js");
      const valid = authority.bindAcpxCandidateAdmission(admissionSource(), { runId: "metadata-operation", normalizedSessionId: "metadata-session" });
      expect(await pending.probeKimiMetadata(model, apiKey)).toMatchObject({ status: "failed", code: "KIMI_QUALIFICATION_REQUIRED", promptSent: false });
      for (const altered of [{ ...valid, model: "other-model" }, { ...valid, agent: "antigravity" },
        { ...valid, expiresAt: 0 }, { ...valid, profileDigest: `sha256:${"f".repeat(64)}` },
        { ...valid, nativeClosureDigest: `sha256:${"e".repeat(64)}` }, { ...valid, extra: true }]) {
        expect(await pending.probeKimiMetadata(model, apiKey, altered as typeof valid)).toMatchObject({ code: "KIMI_QUALIFICATION_REQUIRED" });
      }
      expect(mocks.installation).not.toHaveBeenCalled(); expect(mocks.metadata).not.toHaveBeenCalled();
      expect(await pending.probeKimiMetadata(model, apiKey, valid)).toMatchObject({ status: "verified", model, promptSent: false });
    } finally { vi.doUnmock("./generated-profiles.js"); vi.resetModules(); }
  });

  it("requires no operator grant after canonical release metadata admits Kimi", async () => {
    vi.resetModules();
    vi.doMock("./generated-profiles.js", async original => {
      const data = await original<typeof import("./generated-profiles.js")>();
      const current = structuredClone(data.QUALIFIED_ACPX_PROFILE_DATA);
      const released = { ...current.kimi } as Record<string, unknown>;
      delete released.qualificationStatus;
      return { ...data, QUALIFIED_ACPX_PROFILE_DATA: { ...current, kimi: released } };
    });
    try {
      const released = await import("./kimi-metadata-probe.js");
      expect(await released.probeKimiMetadata(model, apiKey)).toMatchObject({ status: "verified", model, promptSent: false });
      expect(mocks.metadata).toHaveBeenCalledExactlyOnceWith(model, apiKey);
    } finally { vi.doUnmock("./generated-profiles.js"); vi.resetModules(); }
  });

  it("rejects injected candidate records after ordinary release before opening native files", async () => {
    const candidate = { ...admissionSource(), runId: "metadata-operation", normalizedSessionId: "metadata-session" };
    expect(await probeKimiMetadata(model, apiKey, candidate)).toMatchObject({ code: "KIMI_QUALIFICATION_REQUIRED", promptSent: false });
    expect(mocks.installation).not.toHaveBeenCalled(); expect(mocks.metadata).not.toHaveBeenCalled();
  });

  it("requires an explicit bounded credential and exact model before installation or HTTP work", async () => {
    vi.stubEnv("KIMI_API_KEY", apiKey);
    for (const invalid of ["", " ", "key\nheader", "key\rheader", "key\0header", "x".repeat(16385)]) {
      expect(await probeKimiMetadata(model, invalid)).toMatchObject({ code: "KIMI_AUTH_REQUIRED" });
    }
    for (const invalid of ["", " ", "model\0value", "x".repeat(513), "\ud800"]) {
      expect(await probeKimiMetadata(invalid, apiKey)).toMatchObject({ code: "KIMI_MODEL_UNAVAILABLE" });
    }
    expect(mocks.installation).not.toHaveBeenCalled();
    expect(mocks.metadata).not.toHaveBeenCalled();
  });

  it.each(["KIMI_AUTH_REJECTED", "KIMI_MODEL_UNAVAILABLE", "KIMI_METADATA_TIMEOUT", "KIMI_METADATA_INVALID", "KIMI_PROVIDER_ERROR"] as const)("preserves the canonical %s failure without provider text", async code => {
    mocks.metadata.mockRejectedValue(new KimiMetadataProbeError(code));
    expect(await probeKimiMetadata(model, apiKey, admission())).toMatchObject({ status: "failed", code, promptSent: false });
    mocks.metadata.mockRejectedValue(new Error(`provider failure ${apiKey}`));
    const result = await probeKimiMetadata(model, apiKey, admission());
    expect(result).toMatchObject({ status: "failed", code: "KIMI_REQUEST_FAILED", promptSent: false });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });
});

describe("untrusted Kimi metadata receipts", () => {
  it("accepts only the current source identity and exact selected model", () => {
    expect(validateKimiMetadata(receipt(), model)).toEqual(receipt());
    expect(kimiMetadataProbeNodeDigest()).toBe(`sha256:${KIMI_NODE_DISTRIBUTIONS["linux-x64"].executableSha256}`);
    expect(validateKimiMetadata(receipt(), "different-model")).toMatchObject({ code: "KIMI_MODEL_UNAVAILABLE" });
  });

  it.each([
    { version: "latest" }, { nodeVersion: "24.0.0" }, { profileDigest: `sha256:${"0".repeat(64)}` },
    { closureDigest: `sha256:${"0".repeat(64)}` }, { target: "linux-arm64" },
  ])("rejects an incompatible installation %#", alteration => {
    expect(validateKimiMetadata({ ...receipt(), ...alteration }, model)).toMatchObject({
      status: "failed", code: "KIMI_INSTALLATION_INVALID", promptSent: false,
    });
  });

  it.each([null, [], {}, { ...receipt(), promptSent: true }, { ...receipt(), injected: true },
    { ...receipt(), schema: "other" }, { schema: "paperclip.kimi.metadata.v1", status: "failed", code: "invented", promptSent: false },
  ])("rejects malformed or open receipt contracts %#", value => {
    expect(validateKimiMetadata(value, model)).toMatchObject({ status: "failed", code: "KIMI_REQUEST_FAILED" });
  });

  it.each([0, -1, 1.5, "1048576", Number.MAX_SAFE_INTEGER + 1, undefined])("rejects invalid context length %s", contextLength => {
    expect(validateKimiMetadata({ ...receipt(), contextLength }, model)).toMatchObject({ code: "KIMI_METADATA_INVALID" });
  });

  it("replaces remote failure messages with canonical text", () => {
    const result = validateKimiMetadata({ schema: "paperclip.kimi.metadata.v1", status: "failed", code: "KIMI_AUTH_REJECTED", message: apiKey, promptSent: false }, model);
    expect(result).toMatchObject({ code: "KIMI_AUTH_REJECTED", promptSent: false });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });
});
