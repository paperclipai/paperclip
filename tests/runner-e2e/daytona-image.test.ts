import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeDaytonaImageContentId,
  DAYTONA_IMAGE_DOCKERFILE_PATH,
  DAYTONA_IMAGE_INPUT_PATHS,
  extractDaytonaBaseImages,
  extractDaytonaDockerfileFrontendDigest,
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
    const normalizedDockerfile = dockerfile.replace(/\\\r?\n\s*/g, " ");
    expect(dockerfile).toContain("--bin paperclip-runnerd");
    expect(dockerfile).toContain("build-provider-pack.mjs /provider-pack");
    expect(normalizedDockerfile).not.toContain(
      "COPY packages/paperclip-eval-kernel ./packages/paperclip-eval-kernel",
    );
    expect(normalizedDockerfile).not.toContain(
      "COPY packages/paperclip-runner ./packages/paperclip-runner",
    );
    expect(dockerfile).toContain(
      "COPY packages/paperclip-eval-kernel/src ./packages/paperclip-eval-kernel/src",
    );
    expect(dockerfile).toContain(
      "COPY packages/paperclip-runner/src ./packages/paperclip-runner/src",
    );
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
    expect(extractDaytonaDockerfileFrontendDigest(dockerfile)).toBe(
      "sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e",
    );
    expect(extractDaytonaBaseImages(dockerfile)).toEqual([
      "rust:1.97-bookworm@sha256:408fe88047cef61a2087653b0c5255fa51c0f2d6d94ddedd7a2562a9b91a46f6",
      "node:24-bookworm@sha256:9137a20e25879e0b557227b57e3ee4e9af4bde29eb3db66134cd1723e84f830b",
      "daytonaio/sandbox:0.8.0@sha256:eadf88e4391072b7ad4bed27d9cadfc9fe9d8ed375d9219d34c2ccb518f213e3",
    ]);
    expect(dockerignore).toContain("**/node_modules");
    expect(dockerignore).toContain("packages/paperclip-runner/dist");
    expect(dockerignore).toContain("packages/paperclip-runner/runner/target");
    for (const developmentOnlyInput of [
      "packages/paperclip-runner/devtools",
      "packages/paperclip-runner/docs",
      "packages/paperclip-runner/examples",
      "packages/paperclip-runner/test",
      "packages/paperclip-runner/test-fixtures",
      "packages/paperclip-runner/test-support",
      "packages/paperclip-runner/**/*.md",
      "packages/paperclip-runner/**/*.test.ts",
      "packages/paperclip-runner/runner/crates/*/tests",
      "packages/paperclip-runner/scripts/*-smoke.mjs",
    ]) {
      expect(dockerignore).toContain(developmentOnlyInput);
    }
    expect(workflow).toContain("--platform linux/amd64");
    expect(workflow).toContain(
      "Compute Daytona image content ID with pinned bases",
    );
    expect(workflow).toContain(
      "e2e-content-${{ needs.catalog.outputs.daytona_image_content_id }}",
    );
    expect(workflow).toContain(
      '--build-arg "PAPERCLIP_RUNNER_CONTENT_ID=${IMAGE_CONTENT_ID}"',
    );
    expect(workflow).toContain(
      "IMAGE_CACHE: ghcr.io/paperclipai/paperclip-daytona-runner:e2e-buildcache-amd64",
    );
    expect(workflow).toContain(
      '--cache-from "type=registry,ref=${IMAGE_CACHE}"',
    );
    expect(workflow).toContain(
      '--cache-to "type=registry,ref=${IMAGE_CACHE},mode=max"',
    );
    expect(workflow).toContain(
      'if [ "$TARGET_REF" = "refs/heads/$DEFAULT_BRANCH" ]; then',
    );
    expect(workflow).not.toContain("e2e-git-${{ github.sha }}");
    expect(workflow).toContain("cosign sign --yes");
    expect(workflow).toContain("docker logout ghcr.io");
    expect(workflow).toContain(`docker buildx imagetools inspect "$immutable"`);
    expect(workflow).toContain(`--format '{{json .Image}}'`);
    expect(workflow).not.toContain(`docker --config "$anonymous_config" pull`);
    expect(workflow).not.toContain("docker image inspect");
    expect(workflow).not.toContain("docker buildx prune --all --force");
    expect(workflow).not.toContain("docker system prune --all --force");
    expect(workflow).toContain('.architecture == "amd64"');
    expect(workflow).toContain('.os == "linux"');
    expect(workflow).toContain('.config.User == "daytona"');
    expect(workflow).toContain("PAPERCLIP_RUNNER_PROVIDER_PACK_ROOT=");
    expect(workflow).toContain(
      "node packages/paperclip-runner/scripts/build-provider-pack.mjs packages/paperclip-runner/provider-pack",
    );
    expect(workflow).toContain(
      "PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH: ${{ github.workspace }}/packages/paperclip-runner/provider-pack",
    );
    expect(workflow).toContain(
      "PAPERCLIP_RUNNER_SOURCE_REVISION: ${{ needs.daytona_image.outputs.source_revision }}",
    );
    expect(workflow.indexOf("cosign verify")).toBeLessThan(
      workflow.indexOf("docker logout ghcr.io"),
    );
    expect(workflow.indexOf("docker logout ghcr.io")).toBeLessThan(
      workflow.indexOf(`--format '{{json .Image}}'`),
    );
    const providerInstall = dockerfile.indexOf(
      "RUN pnpm install --frozen-lockfile --filter '@paperclipai/paperclip-runner...'",
    );
    const runnerSourceCopy = dockerfile.indexOf(
      "COPY packages/paperclip-runner/src ./packages/paperclip-runner/src",
    );
    const providerRevisionArg = dockerfile.indexOf(
      "ARG PAPERCLIP_RUNNER_SOURCE_REVISION",
    );
    const cliInstall = dockerfile.indexOf("RUN npm install -g");
    const finalMetadataArgs = dockerfile.lastIndexOf(
      "ARG PAPERCLIP_RUNNER_CONTENT_ID",
    );
    expect(providerInstall).toBeGreaterThan(0);
    expect(providerInstall).toBeLessThan(runnerSourceCopy);
    expect(providerInstall).toBeLessThan(providerRevisionArg);
    expect(cliInstall).toBeGreaterThan(0);
    expect(cliInstall).toBeLessThan(finalMetadataArgs);
  });

  it("hashes the audited image dependency closure rather than the repository revision", async () => {
    for (const requiredPath of [
      ".dockerignore",
      "docker/daytona-runner/Dockerfile",
      "pnpm-lock.yaml",
      "patches",
      "packages/paperclip-eval-kernel/src",
      "packages/paperclip-runner/package.json",
      "packages/paperclip-runner/runner/crates",
      "packages/paperclip-runner/src",
    ]) {
      expect(DAYTONA_IMAGE_INPUT_PATHS).toContain(requiredPath);
    }
    expect(DAYTONA_IMAGE_INPUT_PATHS).not.toContain(
      "packages/paperclip-eval-kernel",
    );
    expect(DAYTONA_IMAGE_INPUT_PATHS).not.toContain(
      "packages/paperclip-runner",
    );
    expect(DAYTONA_IMAGE_DOCKERFILE_PATH).toBe(
      "docker/daytona-runner/Dockerfile",
    );

    const contentId = await computeDaytonaImageContentId();
    expect(contentId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes for runtime source, package, lockfile, Dockerfile, frontend, base, or platform inputs", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "paperclip-daytona-image-id-"),
    );
    const inputPaths = [
      "docker/daytona-runner/Dockerfile",
      "package.json",
      "pnpm-lock.yaml",
      "packages/paperclip-runner/package.json",
      "packages/paperclip-runner/src",
      "packages/paperclip-runner/runner/crates",
    ] as const;
    const options = {
      repositoryRoot: root,
      inputPaths,
      baseImages: [`example.test/base:1@sha256:${"a".repeat(64)}`],
      frontendDigest: `sha256:${"c".repeat(64)}`,
    } as const;
    try {
      await mkdir(path.join(root, "docker/daytona-runner"), {
        recursive: true,
      });
      await mkdir(path.join(root, "packages/paperclip-runner/src"), {
        recursive: true,
      });
      await mkdir(
        path.join(
          root,
          "packages/paperclip-runner/runner/crates/runner-core/src",
        ),
        { recursive: true },
      );
      await writeFile(
        path.join(root, "docker/daytona-runner/Dockerfile"),
        "FROM pinned\n",
      );
      await writeFile(path.join(root, "package.json"), '{"private":true}\n');
      await writeFile(
        path.join(root, "pnpm-lock.yaml"),
        "lockfileVersion: 9\n",
      );
      await writeFile(
        path.join(root, "packages/paperclip-runner/package.json"),
        '{"name":"@paperclipai/paperclip-runner"}\n',
      );
      await writeFile(
        path.join(root, "packages/paperclip-runner/src/runner.ts"),
        "version one\n",
      );
      await writeFile(
        path.join(
          root,
          "packages/paperclip-runner/runner/crates/runner-core/src/lib.rs",
        ),
        'pub const VERSION: &str = "one";\n',
      );
      const baseline = await computeDaytonaImageContentId(options);
      expect(
        await computeDaytonaImageContentId({
          ...options,
          baseImages: [`example.test/base:1@sha256:${"b".repeat(64)}`],
        }),
      ).not.toBe(baseline);
      expect(
        await computeDaytonaImageContentId({
          ...options,
          baseImages: [`example.test/base:1@sha256:${"a".repeat(64)}`],
          frontendDigest: `sha256:${"d".repeat(64)}`,
        }),
      ).not.toBe(baseline);

      await writeFile(
        path.join(root, "unrelated.txt"),
        "does not enter the image\n",
      );
      expect(await computeDaytonaImageContentId(options)).toBe(baseline);

      for (const relativePath of [
        "docker/daytona-runner/Dockerfile",
        "package.json",
        "pnpm-lock.yaml",
        "packages/paperclip-runner/package.json",
        "packages/paperclip-runner/src/runner.ts",
        "packages/paperclip-runner/runner/crates/runner-core/src/lib.rs",
      ]) {
        const absolutePath = path.join(root, relativePath);
        const original = await readFile(absolutePath, "utf8");
        await writeFile(absolutePath, `${original}changed\n`);
        expect(await computeDaytonaImageContentId(options)).not.toBe(baseline);
        await writeFile(absolutePath, original);
      }
      expect(
        await computeDaytonaImageContentId({
          ...options,
          platform: "linux/arm64",
        }),
      ).not.toBe(baseline);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses the image for runner-only tests and documentation", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "paperclip-daytona-runner-development-inputs-"),
    );
    const options = {
      repositoryRoot: root,
      inputPaths: ["packages/paperclip-runner"],
      baseImages: [`example.test/base:1@sha256:${"a".repeat(64)}`],
      frontendDigest: `sha256:${"c".repeat(64)}`,
    } as const;
    try {
      const runnerRoot = path.join(root, "packages/paperclip-runner");
      await mkdir(path.join(runnerRoot, "src/live"), { recursive: true });
      await mkdir(path.join(runnerRoot, "docs"), { recursive: true });
      await mkdir(path.join(runnerRoot, "spec"), { recursive: true });
      await mkdir(path.join(runnerRoot, "scripts"), { recursive: true });
      await mkdir(path.join(runnerRoot, "test-fixtures"), { recursive: true });
      await mkdir(path.join(runnerRoot, "runner/crates/runner-core/src"), {
        recursive: true,
      });
      await mkdir(path.join(runnerRoot, "runner/crates/runner-core/tests"), {
        recursive: true,
      });
      await writeFile(
        path.join(runnerRoot, "src/live/transport.ts"),
        "export const runtime = 'one';\n",
      );
      await writeFile(
        path.join(runnerRoot, "runner/crates/runner-core/src/lib.rs"),
        'pub const RUNTIME: &str = "one";\n',
      );
      await writeFile(path.join(runnerRoot, "README.md"), "first readme\n");
      await writeFile(
        path.join(runnerRoot, "docs/local-runner.md"),
        "first documentation\n",
      );
      await writeFile(
        path.join(runnerRoot, "spec/architecture.md"),
        "first architecture note\n",
      );
      await writeFile(
        path.join(runnerRoot, "src/live/transport.test.ts"),
        "first TypeScript test\n",
      );
      await writeFile(
        path.join(runnerRoot, "test-fixtures/provider.json"),
        '{"fixture":"one"}\n',
      );
      await writeFile(
        path.join(runnerRoot, "scripts/capability-clean-room-smoke.mjs"),
        "first smoke probe\n",
      );
      await writeFile(
        path.join(runnerRoot, "runner/crates/runner-core/tests/recovery.rs"),
        "// first Rust integration test\n",
      );

      const baseline = await computeDaytonaImageContentId(options);
      await mkdir(path.join(runnerRoot, "src/new-test-only-directory"));
      await writeFile(
        path.join(
          runnerRoot,
          "src/new-test-only-directory/transport-edge.test.ts",
        ),
        "new TypeScript test\n",
      );
      await writeFile(path.join(runnerRoot, "README.md"), "second readme\n");
      await writeFile(
        path.join(runnerRoot, "docs/local-runner.md"),
        "second documentation\n",
      );
      await writeFile(
        path.join(runnerRoot, "spec/architecture.md"),
        "second architecture note\n",
      );
      await writeFile(
        path.join(runnerRoot, "src/live/transport.test.ts"),
        "second TypeScript test\n",
      );
      await writeFile(
        path.join(runnerRoot, "test-fixtures/provider.json"),
        '{"fixture":"two"}\n',
      );
      await writeFile(
        path.join(runnerRoot, "scripts/capability-clean-room-smoke.mjs"),
        "second smoke probe\n",
      );
      await writeFile(
        path.join(runnerRoot, "runner/crates/runner-core/tests/recovery.rs"),
        "// second Rust integration test\n",
      );
      expect(await computeDaytonaImageContentId(options)).toBe(baseline);

      await writeFile(
        path.join(runnerRoot, "src/live/transport.ts"),
        "export const runtime = 'two';\n",
      );
      expect(await computeDaytonaImageContentId(options)).not.toBe(baseline);

      await writeFile(
        path.join(runnerRoot, "src/live/transport.ts"),
        "export const runtime = 'one';\n",
      );
      await writeFile(
        path.join(runnerRoot, "runner/crates/runner-core/src/lib.rs"),
        'pub const RUNTIME: &str = "two";\n',
      );
      expect(await computeDaytonaImageContentId(options)).not.toBe(baseline);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects mutable Docker base references", () => {
    expect(() => extractDaytonaBaseImages("FROM node:24-bookworm\n")).toThrow(
      "must use an immutable sha256 digest",
    );
  });

  it("rejects a mutable or missing Dockerfile syntax frontend", async () => {
    expect(() =>
      extractDaytonaDockerfileFrontendDigest(
        "# syntax=docker/dockerfile:1.7\nFROM scratch\n",
      ),
    ).toThrow("must pin its syntax frontend");
    expect(() =>
      extractDaytonaDockerfileFrontendDigest("FROM scratch\n"),
    ).toThrow("must pin its syntax frontend");
    await expect(
      computeDaytonaImageContentId({
        inputPaths: [],
        baseImages: [`example.test/base:1@sha256:${"a".repeat(64)}`],
        frontendDigest: "sha256:mutable",
      }),
    ).rejects.toThrow("must use an immutable sha256 digest");
  });
});
