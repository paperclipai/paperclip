import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
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
  packageVersion: "0.0.0",
  binaryContractVersion: 2,
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

  it.skipIf(process.platform === "win32")(
    "executes a private copy of the verified bytes when the source path is swapped",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "paperclip-runnerd-artifact-"));
      const executablePath = join(root, "paperclip-runnerd");
      const verifiedScript = `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(valid)}'\n`;
      const replacementScript = "#!/bin/sh\nprintf '%s\\n' 'unverified replacement'\n";
      const expectedSha256 = `sha256:${createHash("sha256").update(verifiedScript).digest("hex")}`;

      try {
        await writeFile(executablePath, verifiedScript, { mode: 0o700 });
        const input = {
          executablePath,
          expectedSha256,
          get metadataTimeoutMs() {
            writeFileSync(executablePath, replacementScript, { mode: 0o700 });
            return 5_000;
          },
        };

        await expect(resolvePaperclipRunnerdArtifact(input)).resolves.toMatchObject({
          executablePath,
          sha256: expectedSha256,
          byteSize: Buffer.byteLength(verifiedScript),
          buildMetadata: valid,
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
