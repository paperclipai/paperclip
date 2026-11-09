import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeBloat, findContentDuplicates, parseDeepScanOutput } from "./image-bloat-detect.mjs";

describe("analyzeBloat", () => {
  const base = {
    sizeBytes: 10_000_000_000,
    history: [
      { sizeBytes: 0, createdBy: "CMD [...]" },
      { sizeBytes: 587 * 1024 * 1024, createdBy: "/bin/sh -c chmod -R a+rX /opt/paperclip-runner/provider-pack && ..." },
      { sizeBytes: 3 * 1024 * 1024, createdBy: "/bin/sh -c chmod +x /usr/local/bin/docker-entrypoint.sh" },
    ],
    manifest: {
      global: [
        { name: "@openai/codex", version: "0.163.0", sizeBytes: 411 * 1024 * 1024 },
        { name: "opencode-ai", version: "1.19.2", sizeBytes: 355 * 1024 * 1024 },
      ],
      pnpm: [
        { name: "@openai/codex", version: "0.160.0-linux-x64", sizeBytes: 427 * 1024 * 1024, dir: "@openai+codex@0.160.0-linux-x64" },
        { name: "opencode-ai", version: "1.18.34", sizeBytes: 178 * 1024 * 1024, dir: "opencode-ai@1.18.34" },
        { name: "@anthropic-ai/claude-agent-sdk-linux-x64-musl", version: "0.3.286", sizeBytes: 225 * 1024 * 1024, dir: "@anthropic-ai+claude-agent-sdk-linux-x64-musl@0.3.286" },
        { name: "@anthropic-ai/claude-agent-sdk-linux-x64", version: "0.3.286", sizeBytes: 231 * 1024 * 1024, dir: "@anthropic-ai+claude-agent-sdk-linux-x64@0.3.286" },
        { name: "opencode-linux-x64-baseline-musl", version: "1.18.34", sizeBytes: 187 * 1024 * 1024, dir: "opencode-linux-x64-baseline-musl@1.18.34" },
        { name: "opencode-linux-x64-baseline", version: "1.18.34", sizeBytes: 178 * 1024 * 1024, dir: "opencode-linux-x64-baseline@1.18.34" },
        { name: "@img/sharp-libvips-linuxmusl-x64", version: "1.3.3", sizeBytes: 19 * 1024 * 1024, dir: "@img+sharp-libvips-linuxmusl-x64@1.3.3" },
        { name: "unrelated-linux-x64", version: "1.0.0", sizeBytes: 5 * 1024 * 1024, dir: "unrelated-linux-x64@1.0.0" },
      ],
      providerPack: [
        { name: "@openai/codex", version: "0.160.0", sizeBytes: 427 * 1024 * 1024 },
      ],
    },
  };

  it("flags large chmod -R layers as mode-rewrite waste", () => {
    const report = analyzeBloat(base);
    assert.equal(report.modeRewriteLayers.length, 1);
    assert.match(report.modeRewriteLayers[0].createdBy, /chmod -R/);
  });

  it("flags musl/darwin/other-libc platform packages but keeps glibc x64", () => {
    const report = analyzeBloat(base);
    const names = report.nonTargetPlatformPackages.map((p) => p.name).sort();
    assert.deepEqual(names, [
      "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
      "@img/sharp-libvips-linuxmusl-x64",
      "opencode-linux-x64-baseline-musl",
    ]);
    assert.ok(!names.includes("@anthropic-ai/claude-agent-sdk-linux-x64"));
    assert.ok(!names.includes("opencode-linux-x64-baseline"));
    assert.ok(!names.includes("unrelated-linux-x64"));
  });

  it("detects the same package across node_modules trees, ignoring platform version suffix", () => {
    const report = analyzeBloat(base);
    const dup = report.duplicatePackagesAcrossTrees.map((d) => d.name).sort();
    assert.deepEqual(dup, ["@openai/codex", "opencode-ai"]);
    const codex = report.duplicatePackagesAcrossTrees.find((d) => d.name === "@openai/codex");
    assert.equal(new Set(codex.locations.map((l) => l.tree)).size, 3); // global + pnpm + providerPack
  });

  it("passes a budget identical to the current report", () => {
    const report = analyzeBloat(base);
    const recheck = analyzeBloat({ ...base, budget: report });
    assert.deepEqual(recheck.budgetViolations, []);
  });

  it("fails a budget on size growth", () => {
    const report = analyzeBloat(base);
    const grown = analyzeBloat({ ...base, sizeBytes: base.sizeBytes * 1.10, budget: report });
    assert.ok(grown.budgetViolations.some((v) => v.includes("image grew")));
  });

  it("fails a budget on a newly-introduced non-target platform package", () => {
    const report = analyzeBloat(base);
    const pnpm = [
      ...base.manifest.pnpm,
      { name: "new-pkg-linux-x64-musl", version: "2.0.0", sizeBytes: 10 * 1024 * 1024, dir: "new-pkg-linux-x64-musl@2.0.0" },
    ];
    const changed = analyzeBloat({ ...base, manifest: { ...base.manifest, pnpm }, budget: report });
    assert.ok(changed.budgetViolations.some((v) => v.includes("new non-target platform package: new-pkg-linux-x64-musl")));
  });

  it("fails a budget on a newly-duplicated package across trees", () => {
    const report = analyzeBloat(base);
    const global = [...base.manifest.global, { name: "brand-new-cli", version: "3.0.0", sizeBytes: 10 * 1024 * 1024 }];
    const pnpm = [...base.manifest.pnpm, { name: "brand-new-cli", version: "3.0.0", sizeBytes: 10 * 1024 * 1024, dir: "brand-new-cli@3.0.0" }];
    const changed = analyzeBloat({ ...base, manifest: { ...base.manifest, global, pnpm }, budget: report });
    assert.ok(changed.budgetViolations.some((v) => v.includes("new duplicate package across trees: brand-new-cli")));
  });

  it("reports nothing about content duplicates unless --deep is selected", () => {
    assert.equal(analyzeBloat(base).contentDuplicates, null);
  });

  it("groups identical file content across paths when --deep is selected", () => {
    const contentHashes = [
      { hash: "a1".repeat(32), path: "/app/node_modules/pkg/dist/bundle.js" },
      { hash: "a1".repeat(32), path: "/usr/local/lib/node_modules/pkg/dist bundle.js" },
      { hash: "b2".repeat(32), path: "/opt/paperclip-runner/unique.js" },
    ];
    const report = analyzeBloat({ ...base, deep: true, contentHashes });
    assert.deepEqual(report.contentDuplicates, [
      {
        hash: "a1".repeat(32),
        paths: [
          "/app/node_modules/pkg/dist/bundle.js",
          "/usr/local/lib/node_modules/pkg/dist bundle.js",
        ],
      },
    ]);
  });
});

describe("deep content scan parsing", () => {
  it("parses sha256sum output, keeps paths with spaces, skips stray lines", () => {
    const entries = parseDeepScanOutput(
      ["abc123  /app/node_modules/a bundle.js", "def456  /app/b.js", "not a hash line", ""].join("\n"),
    );
    assert.deepEqual(entries, []);
    const real = parseDeepScanOutput(
      [
        `${"a1".repeat(32)}  /app/node_modules/pkg/dist/bundle.js`,
        `${"a1".repeat(32)}  /usr/local/lib/node_modules/pkg/dist bundle.js`,
        "warning: /missing: No such file or directory",
      ].join("\n"),
    );
    assert.deepEqual(real, [
      { hash: "a1".repeat(32), path: "/app/node_modules/pkg/dist/bundle.js" },
      { hash: "a1".repeat(32), path: "/usr/local/lib/node_modules/pkg/dist bundle.js" },
    ]);
  });

  it("groups duplicates only when the same hash spans more than one path", () => {
    assert.deepEqual(
      findContentDuplicates([
        { hash: "h1", path: "/a.js" },
        { hash: "h2", path: "/b.js" },
      ]),
      [],
    );
    assert.deepEqual(
      findContentDuplicates([
        { hash: "h1", path: "/a.js" },
        { hash: "h1", path: "/b.js" },
      ]),
      [{ hash: "h1", paths: ["/a.js", "/b.js"] }],
    );
  });
});
