import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { vertexCredentialCheck, vertexHermesMinimumVersionCheck } from "./index.js";

describe("Google Vertex environment validation", () => {
  it("requires Hermes Agent 0.21.2 or newer", () => {
    expect(
      vertexHermesMinimumVersionCheck([
        { level: "info", message: "Hermes Agent version: 0.21.1", code: "hermes_version" },
      ]),
    ).toMatchObject({ level: "error", code: "google_vertex_hermes_version_unsupported" });
    expect(
      vertexHermesMinimumVersionCheck([
        { level: "info", message: "Hermes Agent version: v0.21.2", code: "hermes_version" },
      ]),
    ).toBeNull();
    expect(
      vertexHermesMinimumVersionCheck([
        { level: "info", message: "Hermes Agent version: 1.0.0", code: "hermes_version" },
      ]),
    ).toBeNull();
  });

  it("fails closed when the Hermes version cannot be verified", () => {
    expect(
      vertexHermesMinimumVersionCheck([
        { level: "warn", message: "Could not determine version", code: "hermes_version_unknown" },
      ]),
    ).toMatchObject({ level: "error", code: "google_vertex_hermes_version_unknown" });
  });

  it("requires an absolute credential path", async () => {
    await expect(
      vertexCredentialCheck({ env: { VERTEX_CREDENTIALS_PATH: "credentials.json" } }),
    ).resolves.toMatchObject({
      level: "error",
      code: "google_vertex_service_account_path_not_absolute",
    });
  });

  it("requires a readable regular credential file", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-vertex-"));
    const directoryPath = join(root, "credentials-dir");
    const filePath = join(root, "credentials.json");
    await mkdir(directoryPath);
    await writeFile(filePath, "{}", "utf8");

    await expect(
      vertexCredentialCheck({ env: { VERTEX_CREDENTIALS_PATH: directoryPath } }),
    ).resolves.toMatchObject({
      level: "error",
      code: "google_vertex_service_account_not_file",
    });
    await expect(
      vertexCredentialCheck({ env: { VERTEX_CREDENTIALS_PATH: filePath } }),
    ).resolves.toMatchObject({
      level: "info",
      code: "google_vertex_service_account_configured",
    });
  });
});
