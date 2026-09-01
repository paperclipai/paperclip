import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeDaytonaImageContentId,
  DAYTONA_IMAGE_INPUT_PATHS,
} from "./daytona-image-content.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

describe("runner E2E Daytona image contract", () => {
  it("builds runnerd and the provider pack and verifies every required transport", async () => {
    const [dockerfile, dockerignore, workflow] = await Promise.all([
      readFile(
        path.join(repositoryRoot, "docker/daytona-runner/Dockerfile"),
        "utf8",
      ),
      readFile(path.join(repositoryRoot, ".dockerignore"), "utf8"),
      readFile(
        path.join(
          repositoryRoot,
          ".github/workflows/runner-full-stack-e2e.yml",
        ),
        "utf8",
      ),
    ]);
    expect(dockerfile).toContain("--bin paperclip-runnerd");
    expect(dockerfile).toContain("build-provider-pack.mjs /provider-pack");
    expect(dockerfile).toContain(
      "/opt/paperclip-runner/provider-pack/provider-pack.json",
    );
    expect(dockerfile).toContain(
      "${PAPERCLIP_RUNNER_PROVIDER_PACK_ROOT}/node_modules/.bin",
    );
    for (const command of ["acpx", "claude-agent-acp", "codex-acp"]) {
      expect(dockerfile).toContain(command);
    }
    for (const transport of ["dial_ws_loopback", "dial_wss", "listen_ws"]) {
      expect(dockerfile).toContain(transport);
    }
    expect(dockerfile).toContain(
      'metadata="$(paperclip-runnerd --build-metadata)"',
    );
    expect(dockerfile).toContain("provider-pack.json");
    expect(dockerfile).toContain("io.paperclip.runner.content-id");
    expect(dockerfile).toContain("org.opencontainers.image.revision");
    expect(dockerignore).toContain("**/node_modules");
    expect(dockerignore).toContain("packages/paperclip-runner/dist");
    expect(dockerignore).toContain("packages/paperclip-runner/runner/target");
    expect(workflow).toContain("--platform linux/amd64");
    expect(workflow).toContain(
      "e2e-content-${{ needs.catalog.outputs.daytona_image_content_id }}",
    );
    expect(workflow).toContain(
      '--build-arg "PAPERCLIP_RUNNER_CONTENT_ID=${IMAGE_CONTENT_ID}"',
    );
    expect(workflow).not.toContain("e2e-git-${{ github.sha }}");
    expect(workflow).toContain("cosign sign --yes");
    expect(workflow).toContain("docker image inspect");
    expect(workflow).toContain('.Config.User == "daytona"');
    expect(workflow).toContain("PAPERCLIP_RUNNER_PROVIDER_PACK_ROOT=");
    expect(workflow).toContain(
      "pnpm --filter @paperclipai/paperclip-runner build:provider-pack",
    );
    expect(workflow).toContain(
      "PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH: ${{ github.workspace }}/packages/paperclip-runner/provider-pack",
    );
    expect(workflow).toContain(
      "PAPERCLIP_RUNNER_SOURCE_REVISION: ${{ needs.daytona_image.outputs.source_revision }}",
    );
    expect(workflow).toContain("anonymous_config");
  });

  it("hashes the audited image dependency closure rather than the repository revision", async () => {
    for (const requiredPath of [
      ".dockerignore",
      "docker/daytona-runner/Dockerfile",
      "pnpm-lock.yaml",
      "patches",
      "packages/paperclip-eval-kernel",
      "packages/paperclip-runner",
    ]) {
      expect(DAYTONA_IMAGE_INPUT_PATHS).toContain(requiredPath);
    }

    const contentId = await computeDaytonaImageContentId();
    expect(contentId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes only when a selected image input or target platform changes", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "paperclip-daytona-image-id-"),
    );
    try {
      await mkdir(path.join(root, "image-input"));
      await writeFile(
        path.join(root, "image-input", "runner.ts"),
        "version one\n",
      );
      const baseline = await computeDaytonaImageContentId({
        repositoryRoot: root,
        inputPaths: ["image-input"],
      });

      await writeFile(
        path.join(root, "unrelated.txt"),
        "does not enter the image\n",
      );
      expect(
        await computeDaytonaImageContentId({
          repositoryRoot: root,
          inputPaths: ["image-input"],
        }),
      ).toBe(baseline);

      await writeFile(
        path.join(root, "image-input", "runner.ts"),
        "version two\n",
      );
      expect(
        await computeDaytonaImageContentId({
          repositoryRoot: root,
          inputPaths: ["image-input"],
        }),
      ).not.toBe(baseline);
      expect(
        await computeDaytonaImageContentId({
          repositoryRoot: root,
          inputPaths: ["image-input"],
          platform: "linux/arm64",
        }),
      ).not.toBe(baseline);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
