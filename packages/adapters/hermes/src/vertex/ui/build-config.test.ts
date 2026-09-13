import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";

import { DEFAULT_GOOGLE_VERTEX_MODEL } from "../shared/constants.js";
import { buildGoogleVertexConfig } from "./build-config.js";

function values(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "google_vertex",
    cwd: "",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: false,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    payloadTemplateJson: "",
    maxTurnsPerRun: 0,
    heartbeatEnabled: true,
    intervalSec: 3600,
    ...overrides,
  };
}

describe("buildGoogleVertexConfig", () => {
  it("creates a Vertex-only config with the default model and region", () => {
    expect(buildGoogleVertexConfig(values())).toMatchObject({
      provider: "vertex",
      model: DEFAULT_GOOGLE_VERTEX_MODEL,
      region: "global",
      persistSession: true,
    });
  });

  it("keeps schema routing fields while preventing a provider override", () => {
    expect(
      buildGoogleVertexConfig(
        values({
          model: "google/gemini-3.1-pro-preview",
          adapterSchemaValues: {
            provider: "openrouter",
            projectId: "project-123",
            region: "us-central1",
            credentialsPath: "/secure/vertex.json",
          },
        }),
      ),
    ).toMatchObject({
      provider: "vertex",
      model: "google/gemini-3.1-pro-preview",
      projectId: "project-123",
      region: "us-central1",
      credentialsPath: "/secure/vertex.json",
    });
  });
});
