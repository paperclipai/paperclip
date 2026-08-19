import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PAPERCLIP_RUNNERD_BUILD_METADATA_SCHEMA } from "./build-metadata.js";
import {
  PaperclipRunnerdArtifactError,
  parsePaperclipRunnerdBuildMetadata,
  resolvePaperclipRunnerdArtifact,
} from "./runnerd-artifact.js";

const valid = {
  schema: PAPERCLIP_RUNNERD_BUILD_METADATA_SCHEMA,
  binaryName: "paperclip-runnerd",
  packageName: "@paperclipai/paperclip-runner",
  packageVersion: "0.1.2",
  binaryContractVersion: 1,
  nativeExecutionVersion: 1,
  harnessDriverVersion: 1,
  prp: { name: "paperclip.runner", minimumVersion: 1, maximumVersion: 1 },
};

describe("runnerd artifact metadata", () => {
  it("parses the exact runnerd identity", () => {
    expect(parsePaperclipRunnerdBuildMetadata(valid)).toEqual(valid);
  });

  it("rejects an unknown binary metadata schema", () => {
    expect(() => parsePaperclipRunnerdBuildMetadata({ ...valid, schema: "runnerd/v2" }))
      .toThrow(PaperclipRunnerdArtifactError);
    expect(() => parsePaperclipRunnerdBuildMetadata({ ...valid, schema: "runnerd/v2" }))
      .toThrow(/unsupported/);
  });

  it("rejects an invalid or mismatched explicit artifact digest before execution", async () => {
    await expect(resolvePaperclipRunnerdArtifact({
      executablePath: "/does/not/matter",
      expectedSha256: "not-a-digest",
    })).rejects.toMatchObject({ issue: "digest_invalid" });

    const root = await mkdtemp(join(tmpdir(), "paperclip-runnerd-artifact-"));
    const executablePath = join(root, "paperclip-runnerd");
    try {
      await writeFile(executablePath, "not the expected binary");
      await expect(resolvePaperclipRunnerdArtifact({
        executablePath,
        expectedSha256: `sha256:${"0".repeat(64)}`,
      })).rejects.toMatchObject({
        issue: "digest_mismatch",
        message: expect.stringContaining("observed sha256:"),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
