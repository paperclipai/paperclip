import { describe, expect, it } from "vitest";

import {
  DEFAULT_GOOGLE_VERTEX_MODEL,
  DEFAULT_GOOGLE_VERTEX_REGION,
  GOOGLE_VERTEX_PROVIDER,
} from "../shared/constants.js";
import { buildGoogleVertexRuntimeConfig } from "./config.js";

describe("buildGoogleVertexRuntimeConfig", () => {
  it("fixes the provider and supplies safe Vertex defaults", () => {
    expect(buildGoogleVertexRuntimeConfig({ provider: "openrouter" })).toMatchObject({
      provider: GOOGLE_VERTEX_PROVIDER,
      model: DEFAULT_GOOGLE_VERTEX_MODEL,
      env: { VERTEX_REGION: DEFAULT_GOOGLE_VERTEX_REGION },
    });
  });

  it("maps routing fields and the service-account pointer into Hermes env", () => {
    const config = buildGoogleVertexRuntimeConfig({
      model: " google/gemini-3.1-pro-preview ",
      projectId: " project-123 ",
      region: " us-central1 ",
      credentialsPath: " /secure/vertex.json ",
      env: { EXISTING: "value" },
    });

    expect(config).toMatchObject({
      provider: "vertex",
      model: "google/gemini-3.1-pro-preview",
      env: {
        EXISTING: "value",
        VERTEX_PROJECT_ID: "project-123",
        VERTEX_REGION: "us-central1",
        VERTEX_CREDENTIALS_PATH: "/secure/vertex.json",
      },
    });
  });
});
