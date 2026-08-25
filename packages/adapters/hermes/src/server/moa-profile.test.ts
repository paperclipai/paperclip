import { describe, expect, it } from "vitest";

import { resolveHermesModelSelection } from "./moa-profile.js";

describe("Hermes profile-scoped MoA selection", () => {
  it("selects the named LagunaS-Qwen preset only for the bound Planner profile", () => {
    const config = {
      model: "qwen3.6:27b",
      provider: "ollama-launch",
      moaProfileBindings: {
        planner: "LagunaS-Qwen",
      },
    };

    expect(resolveHermesModelSelection(config, "planner")).toEqual({
      model: "moa:LagunaS-Qwen",
      provider: "moa",
      moaPreset: "LagunaS-Qwen",
    });
  });

  it("keeps an unbound Executor on its configured single-model Qwen route", () => {
    const config = {
      model: "qwen3.6:27b",
      provider: "ollama-launch",
      moaProfileBindings: {
        planner: "LagunaS-Qwen",
      },
    };

    expect(resolveHermesModelSelection(config, "executor")).toEqual({
      model: "qwen3.6:27b",
      provider: "ollama-launch",
    });
  });

  it("ignores malformed bindings instead of creating an implicit global MOA route", () => {
    expect(resolveHermesModelSelection({
      model: "qwen3.6:27b",
      moaProfileBindings: {
        planner: "LagunaS-Qwen/Node-B",
      },
    }, "planner")).toEqual({
      model: "qwen3.6:27b",
    });
  });
});
