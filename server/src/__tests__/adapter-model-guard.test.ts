import { describe, expect, it, vi } from "vitest";

import {
  adapterModelRejectionMessage,
  evaluateAdapterModel,
  resolveModelCatalogAdapterType,
  type AdapterModel,
} from "../services/adapter-model-guard.js";

const CLAUDE_CATALOG: AdapterModel[] = [
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
];

const CODEX_CATALOG: AdapterModel[] = [
  { id: "gpt-5.6-sol", label: "gpt-5.6-sol" },
  { id: "gpt-5.4", label: "gpt-5.4" },
];

function catalogFor(byType: Record<string, AdapterModel[]>) {
  return vi.fn(async (adapterType: string) => byType[adapterType] ?? []);
}

const claudeAndCodex = () =>
  catalogFor({ claude_local: CLAUDE_CATALOG, codex_local: CODEX_CATALOG });

describe("evaluateAdapterModel", () => {
  it("rejects the cross-vendor model that bricked a claude_local agent", async () => {
    // The live break: a claude_local agent self-wrote an OpenAI model id, then
    // failed 14/14 dispatches at the first model call and could no longer issue
    // the write that would undo it.
    const verdict = await evaluateAdapterModel(
      {
        adapterType: "claude_local",
        requestedModel: "gpt-5.6-sol-900k",
        adapterConfig: { model: "gpt-5.6-sol-900k", provider: "openai-codex" },
        previous: { adapterType: "claude_local", model: "claude-opus-5" },
      },
      claudeAndCodex(),
    );

    expect(verdict).toEqual({
      ok: false,
      model: "gpt-5.6-sol-900k",
      adapterType: "claude_local",
      catalogAdapterType: "claude_local",
      available: ["claude-opus-5", "claude-sonnet-5"],
    });
  });

  it("names both values and the operator escape hatch in the rejection", async () => {
    const verdict = await evaluateAdapterModel(
      {
        adapterType: "claude_local",
        requestedModel: "gpt-5.6-sol-900k",
        adapterConfig: {},
      },
      claudeAndCodex(),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;

    const message = adapterModelRejectionMessage(verdict);
    expect(message).toContain('"gpt-5.6-sol-900k"');
    expect(message).toContain('"claude_local"');
    expect(message).toContain("claude-opus-5");
    expect(message).toContain("PAPERCLIP_ADAPTER_MODELS");
  });

  it("truncates a long catalog in the message instead of printing all of it", async () => {
    const wide = Array.from({ length: 30 }, (_, i) => ({ id: `m-${i}`, label: `m-${i}` }));
    const verdict = await evaluateAdapterModel(
      { adapterType: "claude_local", requestedModel: "absent", adapterConfig: {} },
      catalogFor({ claude_local: wide }),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;

    const message = adapterModelRejectionMessage(verdict);
    expect(message).toContain("m-11");
    expect(message).not.toContain("m-12");
    expect(message).toContain("(+18 more)");
  });

  it("accepts a model the adapter lists", async () => {
    const verdict = await evaluateAdapterModel(
      { adapterType: "claude_local", requestedModel: "claude-sonnet-5", adapterConfig: {} },
      claudeAndCodex(),
    );
    expect(verdict).toEqual({ ok: true, reason: "in_catalog" });
  });

  it("ignores a model the SERVER derived rather than the caller naming it", async () => {
    // A PATCH that changes only the adapter type carries the previous model
    // forward through paperclipRunnerTransitionConfig. Rejecting that would 422
    // a request over a value its sender never typed — and the carry-forward
    // cannot brick anything: it preserves a model the agent already ran, and
    // only within one provider family.
    const load = claudeAndCodex();
    const verdict = await evaluateAdapterModel(
      {
        adapterType: "paperclip_runner",
        requestedModel: undefined,
        adapterConfig: { provider: "codex", model: "gpt-5.5" },
        previous: { adapterType: "codex_local", model: "gpt-5.5" },
      },
      load,
    );
    expect(verdict).toEqual({ ok: true, reason: "not_requested" });
    expect(load).not.toHaveBeenCalled();
  });

  it("does not re-validate a model the caller re-sends unchanged", async () => {
    // A client that echoes the whole adapterConfig back must not be refused over
    // a model the agent already has. Without this, an agent on an off-catalog
    // model becomes unwritable in every OTHER field — the same one-way door,
    // opened wider.
    const load = claudeAndCodex();
    const verdict = await evaluateAdapterModel(
      {
        adapterType: "claude_local",
        requestedModel: "retired-model",
        adapterConfig: { model: "retired-model", cwd: "/next" },
        previous: { adapterType: "claude_local", model: "retired-model" },
      },
      load,
    );
    expect(verdict).toEqual({ ok: true, reason: "unchanged" });
    expect(load).not.toHaveBeenCalled();
  });

  it("re-validates an unchanged model when the adapter type changes under it", async () => {
    // Moving a codex agent onto claude_local while naming the GPT model is the
    // vendor mismatch itself, so "unchanged" must key on the PAIR, not the model.
    const verdict = await evaluateAdapterModel(
      {
        adapterType: "claude_local",
        requestedModel: "gpt-5.4",
        adapterConfig: { model: "gpt-5.4" },
        previous: { adapterType: "codex_local", model: "gpt-5.4" },
      },
      claudeAndCodex(),
    );
    expect(verdict.ok).toBe(false);
  });

  it("allows a write that names no model at all", async () => {
    const load = claudeAndCodex();
    for (const requestedModel of [undefined, null, "", "   ", 42, {}]) {
      expect(
        await evaluateAdapterModel(
          { adapterType: "claude_local", requestedModel, adapterConfig: {} },
          load,
        ),
      ).toEqual({ ok: true, reason: "not_requested" });
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("treats an empty catalog as open-ended, not as 'nothing is valid'", async () => {
    const verdict = await evaluateAdapterModel(
      { adapterType: "claude_local", requestedModel: "anything", adapterConfig: {} },
      catalogFor({ claude_local: [] }),
    );
    expect(verdict).toEqual({ ok: true, reason: "open_catalog" });
  });

  it("leaves adapters outside the enumerated set exactly as they were", async () => {
    // hermes_local and opencode_local are not enforced: one ships an empty
    // catalog, the other's real model space is wider than its static list.
    const load = claudeAndCodex();
    for (const adapterType of ["hermes_local", "opencode_local", "process", "gemini_local"]) {
      expect(
        await evaluateAdapterModel(
          { adapterType, requestedModel: "whatever", adapterConfig: {} },
          load,
        ),
      ).toEqual({ ok: true, reason: "adapter_not_enumerated" });
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("accepts a Bedrock model id on claude_local even though the catalog omits it", async () => {
    // Bedrock validity depends on the AGENT's env; the catalog is built from the
    // SERVER's env, so the server cannot tell a Bedrock agent from a typo.
    const verdict = await evaluateAdapterModel(
      {
        adapterType: "claude_local",
        requestedModel: "us.anthropic.claude-sonnet-4-6-v1:0",
        adapterConfig: {},
      },
      claudeAndCodex(),
    );
    expect(verdict).toEqual({ ok: true, reason: "also_accepted" });
  });

  it("does not extend the Bedrock exemption to codex_local", async () => {
    const verdict = await evaluateAdapterModel(
      {
        adapterType: "codex_local",
        requestedModel: "us.anthropic.claude-sonnet-4-6-v1:0",
        adapterConfig: {},
      },
      claudeAndCodex(),
    );
    expect(verdict.ok).toBe(false);
  });

  it("rejects a codex_local model outside its catalog", async () => {
    const verdict = await evaluateAdapterModel(
      { adapterType: "codex_local", requestedModel: "claude-opus-5", adapterConfig: {} },
      claudeAndCodex(),
    );
    expect(verdict.ok).toBe(false);
  });

  it("validates a paperclip_runner against the catalog its provider delegates to", async () => {
    const load = claudeAndCodex();
    expect(
      await evaluateAdapterModel(
        {
          adapterType: "paperclip_runner",
          requestedModel: "claude-sonnet-5",
          adapterConfig: { provider: "acpx" },
        },
        load,
      ),
    ).toEqual({ ok: true, reason: "in_catalog" });
    expect(load).toHaveBeenCalledWith("claude_local");

    const mismatched = await evaluateAdapterModel(
      {
        adapterType: "paperclip_runner",
        requestedModel: "gpt-5.4",
        adapterConfig: { provider: "acpx" },
      },
      load,
    );
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.catalogAdapterType).toBe("claude_local");
  });

  it("ignores a blank adapter type rather than guessing a catalog for it", async () => {
    const load = claudeAndCodex();
    expect(
      await evaluateAdapterModel(
        { adapterType: "  ", requestedModel: "x", adapterConfig: {} },
        load,
      ),
    ).toEqual({ ok: true, reason: "not_requested" });
    expect(load).not.toHaveBeenCalled();
  });

  it("trims both sides before comparing so whitespace is not a mismatch", async () => {
    // The request side is the obvious one. The catalog side matters too:
    // PAPERCLIP_ADAPTER_MODELS is operator-authored, so a padded id there would
    // otherwise reject the very model the operator declared.
    expect(
      await evaluateAdapterModel(
        { adapterType: "claude_local", requestedModel: "  claude-opus-5  ", adapterConfig: {} },
        claudeAndCodex(),
      ),
    ).toEqual({ ok: true, reason: "in_catalog" });

    expect(
      await evaluateAdapterModel(
        { adapterType: "claude_local", requestedModel: "declared-by-operator", adapterConfig: {} },
        catalogFor({ claude_local: [{ id: " declared-by-operator ", label: "Declared" }] }),
      ),
    ).toEqual({ ok: true, reason: "in_catalog" });
  });
});

describe("resolveModelCatalogAdapterType", () => {
  it("maps each runner provider onto the adapter that serves its models", () => {
    expect(resolveModelCatalogAdapterType("paperclip_runner", "acpx")).toBe("claude_local");
    expect(resolveModelCatalogAdapterType("paperclip_runner", "claude_managed")).toBe("claude_local");
    expect(resolveModelCatalogAdapterType("paperclip_runner", "opencode")).toBe("opencode_local");
    expect(resolveModelCatalogAdapterType("paperclip_runner", "aws_agentcore")).toBe("paperclip_runner");
    expect(resolveModelCatalogAdapterType("paperclip_runner", "codex")).toBe("codex_local");
    expect(resolveModelCatalogAdapterType("paperclip_runner", null)).toBe("codex_local");
  });

  it("declines to bound an opencode_local agent pointed at OpenRouter", () => {
    expect(resolveModelCatalogAdapterType("opencode_local", "openrouter")).toBeNull();
    expect(resolveModelCatalogAdapterType("opencode_local", null)).toBe("opencode_local");
  });

  it("passes every other adapter type through unchanged", () => {
    expect(resolveModelCatalogAdapterType("claude_local", null)).toBe("claude_local");
    expect(resolveModelCatalogAdapterType("codex_local", "anything")).toBe("codex_local");
  });
});
