import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { computeBuildInputsDigest } from "../../../packages/paperclip-runner/scripts/build-inputs.mjs";
import {
  RUNNER_IMAGE_CONTEXT_INPUTS,
  RUNNER_IMAGE_INPUTS_SCHEMA,
  computeContextTreeDigest,
  computeRunnerImageIdentity,
} from "../../../scripts/runner-image-identity.mjs";

/**
 * The Runner image is named after its identity. An identity that misses an
 * input gives a changed Runner the name of an older one.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, relative: string, content: string) {
  const file = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

/** A repository with the real Dockerfile and one small file for every kind of input. */
function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "runner-image-identity-"));
  roots.push(root);
  write(root, "Dockerfile", dockerfile);
  write(root, ".dockerignore", "node_modules\n");
  for (const input of RUNNER_IMAGE_CONTEXT_INPUTS) {
    if (!input.startsWith("packages/paperclip-") && input !== "patches") write(root, input, `input ${input}\n`);
  }
  write(root, "packages/paperclip-runner/package.json", "{}\n");
  write(root, "packages/paperclip-runner/src/index.ts", "export const runner = 1;\n");
  write(root, "packages/paperclip-runner/runner/crates/runner-core/src/lib.rs", "pub fn runner() {}\n");
  write(root, "packages/paperclip-eval-kernel/src/index.ts", "export const kernel = 1;\n");
  write(root, "patches/acpx@0.22.0.patch", "patch\n");
  write(root, "ui/src/App.tsx", "export const app = 1;\n");
  write(root, "server/src/index.ts", "export const server = 1;\n");
  write(root, "packages/shared/src/index.ts", "export const shared = 1;\n");
  return root;
}

const digestOf = (root: string) => computeRunnerImageIdentity(root).digest as string;

describe("Runner image identity", () => {
  it("reports the tag, the context tree, the Dockerfile and the Runner build inputs", () => {
    const identity = computeRunnerImageIdentity(repository());
    expect(identity.schema).toBe(RUNNER_IMAGE_INPUTS_SCHEMA);
    expect(identity.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.tag).toBe(`inputs-${identity.digest}`);
    expect(identity.image).toBe("ghcr.io/paperclipai/paperclip-runner");
    expect(identity.platforms).toEqual(["linux/amd64", "linux/arm64"]);
    expect(identity.context.inputs).toEqual(RUNNER_IMAGE_CONTEXT_INPUTS);
    expect(identity.context.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.dockerfile.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.buildInputs.schema).toBe("paperclip.runner-build-inputs.v2");
  });

  it("is the same for the same tree", () => {
    const root = repository();
    expect(digestOf(root)).toBe(digestOf(root));
    expect(digestOf(repository())).toBe(digestOf(root));
  });

  it.each([
    ["a Runner TypeScript source file", "packages/paperclip-runner/src/index.ts"],
    ["a Runner Rust source file", "packages/paperclip-runner/runner/crates/runner-core/src/lib.rs"],
    ["the eval kernel the Runner builds first", "packages/paperclip-eval-kernel/src/index.ts"],
    ["a dependency patch", "patches/acpx@0.22.0.patch"],
    ["the lockfile", "pnpm-lock.yaml"],
    ["the root manifest", "package.json"],
    ["the pnpm configuration", ".npmrc"],
    ["the pack archive script", "scripts/create-provider-pack-archive.mjs"],
    ["the layout script", "scripts/runner-image-layout.mjs"],
    ["the contract copy that build:typescript checks", "packages/shared/src/provider-failure.generated.ts"],
    ["the Dockerfile, in a stage the Runner is not built from", "Dockerfile"],
  ])("changes when %s changes", (_label, file) => {
    const root = repository();
    const before = digestOf(root);
    write(root, file, file === "Dockerfile" ? dockerfile.replace("FROM base AS production\n", "FROM base AS production\nRUN true\n") : "changed\n");
    expect(digestOf(root)).not.toBe(before);
  });

  it.each([
    ["a UI source file", "ui/src/App.tsx"],
    ["a server source file", "server/src/index.ts"],
    ["another package's source file", "packages/shared/src/index.ts"],
    ["a new file outside the Runner's inputs", "server/src/services/new-service.ts"],
  ])("does not change when %s changes", (_label, file) => {
    const root = repository();
    const before = digestOf(root);
    write(root, file, "changed\n");
    expect(digestOf(root)).toBe(before);
  });

  it("refuses an input that is missing from the build context", () => {
    const root = repository();
    rmSync(path.join(root, "scripts/create-provider-pack-archive.mjs"));
    expect(() => computeRunnerImageIdentity(root)).toThrow(/scripts\/create-provider-pack-archive\.mjs, which is missing/);
  });

  describe("context tree", () => {
    // The Runner's build-input digest skips dot-directories and any directory
    // named dist, and it does not read file modes. The image build copies
    // those paths and modes all the same, so the identity must see them.
    it.each([
      ["a file in a dot-directory", "packages/paperclip-runner/runner/.cargo/config.toml"],
      ["a file in a directory named dist", "packages/paperclip-runner/src/vendor/dist/bundle.js"],
    ])("changes for %s, which the Runner build-input digest does not read", (_label, file) => {
      const root = repository();
      const before = computeRunnerImageIdentity(root);
      write(root, file, "[build]\n");
      const after = computeRunnerImageIdentity(root);
      expect(after.buildInputs.digest).toBe(before.buildInputs.digest);
      expect(after.digest).not.toBe(before.digest);
    });

    it("changes when only the executable bit of a file changes", () => {
      const root = repository();
      const file = write(root, "packages/paperclip-runner/scripts/provision.sh", "#!/bin/sh\n");
      chmodSync(file, 0o644);
      const before = computeRunnerImageIdentity(root);
      chmodSync(file, 0o755);
      expect(computeBuildInputsDigest(root).digest).toBe(before.buildInputs.digest);
      expect(digestOf(root)).not.toBe(before.digest);
    });

    it("records a symbolic link by its target and does not follow it", () => {
      const root = repository();
      const link = path.join(root, "packages/paperclip-runner/current");
      symlinkSync("src", link);
      const before = digestOf(root);
      rmSync(link);
      symlinkSync("../../server/src", link);
      const after = digestOf(root);
      expect(after).not.toBe(before);
      write(root, "server/src/index.ts", "changed\n");
      expect(digestOf(root)).toBe(after);
    });

    it("changes when a file is added or removed, and not with the order of a directory listing", () => {
      const root = repository();
      const before = digestOf(root);
      write(root, "packages/paperclip-eval-kernel/src/extra.ts", "export {};\n");
      expect(digestOf(root)).not.toBe(before);
      rmSync(path.join(root, "packages/paperclip-eval-kernel/src/extra.ts"));
      expect(digestOf(root)).toBe(before);
      const other = repository();
      for (const name of ["b.ts", "Z.ts", "a.ts", "_c.ts"]) write(root, `packages/paperclip-runner/src/${name}`, "x\n");
      for (const name of ["_c.ts", "a.ts", "Z.ts", "b.ts"]) write(other, `packages/paperclip-runner/src/${name}`, "x\n");
      expect(computeContextTreeDigest(root)).toEqual(computeContextTreeDigest(other));
    });
  });

  describe(".dockerignore", () => {
    // Its rules decide which files the build receives, and nothing else. The
    // identity is computed inside the build, from the files it received.
    it("does not change the identity when its text changes and the received files do not", () => {
      const root = repository();
      const before = digestOf(root);
      write(root, ".dockerignore", "node_modules\nui/dist\nserver/tmp\n");
      expect(digestOf(root)).toBe(before);
    });

    it("changes the identity when a rule removes a file from the Runner's context", () => {
      const root = repository();
      write(root, "packages/paperclip-runner/styles.css", "body {}\n");
      const before = digestOf(root);
      // What a new `packages/paperclip-runner/styles.css` rule does to the build context.
      rmSync(path.join(root, "packages/paperclip-runner/styles.css"));
      expect(digestOf(root)).not.toBe(before);
    });

    it("keeps out of the build context every directory a build script or a Vite configuration of a package among the identity's inputs writes its output into, so a tree with a local build and a clean checkout of one commit give the build the same files", () => {
      const rules = readFileSync(path.join(repoRoot, ".dockerignore"), "utf8").split(/\r?\n/).filter((rule) => rule && !rule.startsWith("#"));
      const lastRuleFor = (target: string) => rules.filter((rule) => target.split("/").some((_, index, segments) =>
        path.matchesGlob(segments.slice(0, index + 1).join("/"), rule.replace(/^!/, "").replace(/^\//, "")))).at(-1);
      const outputs = RUNNER_IMAGE_CONTEXT_INPUTS.filter((input) => existsSync(path.join(repoRoot, input, "package.json"))).flatMap((input) => {
        const manifest = JSON.parse(readFileSync(path.join(repoRoot, input, "package.json"), "utf8"));
        const scripts = Object.values(manifest.scripts as Record<string, string>).join("\n");
        const emitted = [...scripts.matchAll(/\btsc -p (\S+)(?!\S| --noEmit)/g)].map((match) =>
          JSON.parse(readFileSync(path.join(repoRoot, input, match[1]), "utf8")).compilerOptions.outDir as string);
        const compiled = [...scripts.matchAll(/--manifest-path (\S+)\/Cargo\.toml/g)].map((match) => `${match[1]}/target`);
        const bundled = readdirSync(path.join(repoRoot, input)).filter((name) => /^vite\..*config\.[cm]?[jt]s$/.test(name)).flatMap((name) =>
          [...readFileSync(path.join(repoRoot, input, name), "utf8").matchAll(/\boutDir:\s*(?:resolve\(packageRoot,\s*)?"([^"]+)"/g)].map((match) => match[1]));
        return [...emitted, ...compiled, ...bundled].map((output) => path.posix.join(input, output));
      });
      expect(outputs).toEqual(expect.arrayContaining([
        "packages/paperclip-eval-kernel/dist",
        "packages/paperclip-runner/dist",
        "packages/paperclip-runner/dist-browser",
        "packages/paperclip-runner/dist-issue-thread",
        "packages/paperclip-runner/dist-scenarios",
        "packages/paperclip-runner/dist-sdk",
        "packages/paperclip-runner/dist-standalone",
        "packages/paperclip-runner/runner/target",
      ]));
      for (const output of new Set(outputs)) expect(lastRuleFor(output)?.startsWith("!"), output).toBe(false);
    });
  });
});

/**
 * The identity hashes the whole Dockerfile and the context inputs. That is
 * the whole of what the build reads only while these three rules hold.
 */
describe("Runner image stages", () => {
  // BuildKit accepts an instruction in any case and with any indentation, and
  // FROM with flags. A stage starts wherever BuildKit starts one; the first
  // rule below then allows only the spelling the other rules can read.
  const stagesOf = (text: string) => [...text.matchAll(/^[ \t]*from[ \t].*$/gim)].map((match, index, all) => ({
    from: /^FROM (\S+)(?: AS \S+)?$/.exec(match[0])?.[1] ?? "",
    // The name BuildKit gives the stage, however the line is spelt.
    name: (/\sas\s+(\S+)\s*$/i.exec(match[0])?.[1] ?? "").toLowerCase(),
    lines: text.slice(match.index, all[index + 1]?.index ?? text.length).split("\n").filter((line) => !/^\s*#/.test(line)),
  }));
  type Stage = ReturnType<typeof stagesOf>[number];
  /** The lines of a stage that read something and are not in the one spelling these rules read. */
  const misspelt = (stage: Stage) => stage.lines.filter((line, index) => (index === 0
    // No lowercase keyword, no indentation, no flag on FROM.
    ? !/^FROM \S+ AS runner-artifacts[a-z-]*$/.test(line)
    // No ADD or ONBUILD, no other flag, and no source on a continuation line.
    : /^\s*(?:from|copy|add|onbuild)(?:\s|$)/i.test(line)
      && !/^COPY (?:--link )?(?:--from=runner-artifacts[a-z-]* )?[^-\s]\S*(?: [^\s\\]+)+$/.test(line)));
  const stages = stagesOf(dockerfile);
  const names = stages.map((stage) => stage.name);
  const runner = stages.filter((stage) => stage.name.startsWith("runner-artifacts"));
  const copies = (stage: Stage) => stage.lines.filter((line) => /^COPY\s/.test(line));

  it("spell every FROM and COPY the one way these rules read, and use no ADD or ONBUILD", () => {
    expect(runner.length).toBeGreaterThan(3);
    for (const stage of runner) expect(misspelt(stage), stage.name).toEqual([]);
  });

  it.each([
    ["a lowercase stage keyword", "FROM scratch as runner-artifacts-extra\nCOPY secrets /\n"],
    ["a lowercase from", "from scratch AS runner-artifacts-extra\n"],
    ["a flag on FROM", "FROM --platform=linux/amd64 node:24 AS runner-artifacts-extra\n"],
    ["a lowercase copy", "FROM scratch AS runner-artifacts-extra\ncopy secrets /\n"],
    ["an indented COPY", "FROM scratch AS runner-artifacts-extra\n  COPY secrets /\n"],
    ["an ADD in any case", "FROM scratch AS runner-artifacts-extra\n add secrets /\n"],
    ["a COPY continued on the next line", "FROM scratch AS runner-artifacts-extra\nCOPY package.json \\\n  secrets /\n"],
    ["a COPY with another flag", "FROM scratch AS runner-artifacts-extra\nCOPY --parents secrets /\n"],
    ["an ONBUILD trigger", "FROM scratch AS runner-artifacts-extra\nONBUILD COPY secrets /\n"],
  ])("would catch %s in a stage BuildKit reads as one of the Runner's", (_label, text) => {
    const added = stagesOf(text).filter((stage) => stage.name.startsWith("runner-artifacts"));
    expect(added).toHaveLength(1);
    expect(misspelt(added[0])).not.toEqual([]);
  });

  it("start only from each other, from scratch, or from an image pinned by digest", () => {
    for (const stage of runner) {
      if (stage.from === "scratch" || names.includes(stage.from)) {
        expect(stage.from === "scratch" || stage.from.startsWith("runner-artifacts"), stage.name).toBe(true);
      } else {
        expect(stage.from, stage.name).toMatch(/@sha256:[0-9a-f]{64}$/);
      }
      for (const line of copies(stage)) {
        const source = /--from=(\S+)/.exec(line)?.[1];
        if (source) expect(source, line).toMatch(/^runner-artifacts/);
      }
    }
  });

  it("read the build context only through runner-artifacts-context", () => {
    for (const stage of runner) {
      const text = stage.lines.join("\n");
      expect(text, stage.name).not.toMatch(/^ADD\s/m);
      expect(text, stage.name).not.toMatch(/--mount=/);
      expect(text, stage.name).not.toMatch(/<</);
      if (stage.name === "runner-artifacts-context") continue;
      const fromContext = copies(stage).filter((line) => !line.includes("--from="));
      // The identity stage copies the Dockerfile itself, whose text the identity covers.
      expect(fromContext, stage.name).toEqual(stage.name === "runner-artifacts-identity-compute" ? ["COPY Dockerfile ./"] : []);
    }
  });

  it("copy into runner-artifacts-context exactly the paths the identity hashes", () => {
    const context = runner.find((stage) => stage.name === "runner-artifacts-context")!;
    const sources = copies(context).flatMap((line) => line.split(/\s+/).slice(1, -1));
    expect(sources.filter((source) => source.startsWith("--"))).toEqual([]);
    expect([...sources].sort()).toEqual([...RUNNER_IMAGE_CONTEXT_INPUTS].sort());
  });

  it("end in two file trees, the full one being the slim one plus the transport layers", () => {
    // Each COPY --link is one layer that does not depend on the layers under
    // it. The slim variant is the first two; the full variant starts from it,
    // so it has the same two layers and then the transport archives.
    const slim = runner.find((stage) => stage.name === "runner-artifacts-slim")!;
    const full = runner.find((stage) => stage.name === "runner-artifacts")!;
    const instructions = (stage: typeof slim) => stage.lines.filter((line) => /^[A-Z]+\s/.test(line)).slice(1);
    expect(slim.from).toBe("scratch");
    expect(instructions(slim)).toEqual([
      "COPY --link --from=runner-artifacts-build /out-large/ /",
      "COPY --link --from=runner-artifacts-build /out/ /",
    ]);
    expect(full.from).toBe("runner-artifacts-slim");
    expect(instructions(full)).toEqual([
      "COPY --link --from=runner-artifacts-build /out-archives/ /",
      "COPY --link --from=runner-artifacts-build /out-transport/ /",
    ]);
    // `docker build .` builds the last stage.
    expect(names.at(-1)).toBe("cloud");
    for (const stage of stages) {
      if (!stage.name.startsWith("runner-artifacts")) expect(stage.lines.join("\n"), stage.name).not.toMatch(/runner-artifacts/);
    }
  });

  it("name the published image in the pack only for a publication build, which is off by default", () => {
    const build = runner.find((stage) => stage.name === "runner-artifacts-build")!.lines.join("\n");
    expect(build).toContain('ARG PAPERCLIP_RUNNER_IMAGE_PUBLICATION=""\n');
    expect(build).toContain('publication="${PAPERCLIP_RUNNER_IMAGE_PUBLICATION}";');
    // The pack builder reads the variable from the environment. It is set in
    // one place, inside the branch that tests for a publication build.
    expect(build.match(/PAPERCLIP_RUNNER_INPUTS_DIGEST=/g)).toHaveLength(1);
    expect(build).toMatch(/if \[ -n "\$publication" \]; then \\\n\s+PAPERCLIP_RUNNER_INPUTS_DIGEST="\$\(node -p /);
    expect(build).not.toMatch(/^ENV .*PAPERCLIP_RUNNER_INPUTS_DIGEST/m);
  });

  it("run every output step of the Runner's own build, and know every other step", () => {
    // The image build runs the steps of the Runner's `build` script that write
    // output, between the two that record the build stamp. This list is the
    // whole script: a new step fails here until someone decides whether the
    // image build must run it too.
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, "packages/paperclip-runner/package.json"), "utf8"));
    expect((manifest.scripts.build as string).split(" && ")).toEqual([
      "node scripts/record-build-inputs.mjs --begin",
      "pnpm run check:protocol-manifest",
      "pnpm run build:typescript",
      "pnpm run check:capability-contract",
      "pnpm run check:capability-inventory",
      "pnpm run check:protocol-coverage",
      "node scripts/generate-semantic-contracts.mjs --check",
      "node scripts/check-runner-workflow-traceability.mjs",
      "pnpm run build:binary",
      "node scripts/generate-replay-goldens.mjs --check",
      "node scripts/generate-semantic-action-catalog.mjs --check",
      "node scripts/record-build-inputs.mjs --finish",
    ]);
    const build = runner.find((stage) => stage.name === "runner-artifacts-build")!.lines.join("\n");
    for (const step of ["node scripts/record-build-inputs.mjs --begin;", "pnpm run build:typescript;", "pnpm run build:binary;",
      "node scripts/record-build-inputs.mjs --finish;", "pnpm install --frozen-lockfile --filter '@paperclipai/paperclip-runner...'"]) {
      expect(build).toContain(step);
    }
  });
});
