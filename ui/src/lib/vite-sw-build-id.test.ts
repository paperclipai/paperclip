import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SERVICE_WORKER_BUILD_ID_PLACEHOLDER,
  deriveBuildIdFromEntryFileName,
  embedServiceWorkerOfflineStyles,
  embedServiceWorkerOfflineAnimation,
  stampServiceWorkerBuildId,
} from "./vite-sw-build-id";

const swSource = () =>
  `const BUILD_ID = "${SERVICE_WORKER_BUILD_ID_PLACEHOLDER}";\n` +
  "const CACHE_NAME = `paperclip-${BUILD_ID}`;\n";

describe("embedServiceWorkerOfflineAnimation", () => {
  it("embeds the complete media bytes without an external asset request", () => {
    const bytes = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 255]);
    const source = 'return "__PAPERCLIP_OFFLINE_ANIMATION__";';
    const dataUrl = new Function(embedServiceWorkerOfflineAnimation(source, bytes))();
    expect(dataUrl).toMatch(/^data:video\/webm;base64,/);
    expect(Buffer.from(dataUrl.split(",")[1], "base64")).toEqual(Buffer.from(bytes));
    expect(() => embedServiceWorkerOfflineAnimation(source, new Uint8Array())).toThrow(/missing/);
    expect(() => embedServiceWorkerOfflineAnimation("", bytes)).toThrow(/missing/);
  });
});

describe("embedServiceWorkerOfflineStyles", () => {
  it("embeds CSS as a safe JavaScript string, preserving quotes and newlines", () => {
    const css = '.paperclip-offline {\n  font-family: "Segoe UI", sans-serif;\n}';
    const source = 'return "__PAPERCLIP_OFFLINE_STYLES__";';
    const embedded = embedServiceWorkerOfflineStyles(
      source, `/* offline-recovery:start */${css}/* offline-recovery:end */`,
    );
    expect(new Function(embedded)()).toBe(css);
  });

  it("fails the build if either side of the embedding contract is missing", () => {
    expect(() => embedServiceWorkerOfflineStyles('"__PAPERCLIP_OFFLINE_STYLES__"', ""))
      .toThrow(/missing/);
    expect(() => embedServiceWorkerOfflineStyles("", "/* offline-recovery:start */body {}/* offline-recovery:end */"))
      .toThrow(/missing/);
  });
});

describe("stampServiceWorkerBuildId", () => {
  it("replaces the placeholder with the build id and leaves no placeholder", () => {
    const out = stampServiceWorkerBuildId(swSource(), "index-abc123");
    expect(out).toContain("index-abc123");
    expect(out).not.toContain(SERVICE_WORKER_BUILD_ID_PLACEHOLDER);
  });

  it("produces different worker bytes for different build ids", () => {
    // This is the whole point: a new bundle -> a new sw.js -> a new worker ->
    // parked tabs reload. Identical build ids must stay byte-identical so the
    // worker does not churn when the app did not change.
    const a = stampServiceWorkerBuildId(swSource(), "index-aaaaaa");
    const b = stampServiceWorkerBuildId(swSource(), "index-bbbbbb");
    const again = stampServiceWorkerBuildId(swSource(), "index-aaaaaa");
    expect(a).not.toEqual(b);
    expect(a).toEqual(again);
  });

  it("throws when the placeholder is missing so a drifted worker fails the build", () => {
    expect(() => stampServiceWorkerBuildId("const CACHE_NAME = 'paperclip';", "x")).toThrow(
      /placeholder/,
    );
  });

  it("throws on an empty build id rather than shipping a nameless cache", () => {
    expect(() => stampServiceWorkerBuildId(swSource(), "")).toThrow();
  });
});

describe("deriveBuildIdFromEntryFileName", () => {
  it("uses the content-hashed entry file name", () => {
    expect(deriveBuildIdFromEntryFileName("assets/index-BHbrFFmp.js")).toBe("index-BHbrFFmp");
  });

  it("sanitizes characters that are unsafe in a cache name", () => {
    expect(deriveBuildIdFromEntryFileName("assets/index @weird!.js")).toBe("index--weird-");
  });
});

describe("public/sw.js contract", () => {
  it("still contains the placeholder the plugin rewrites", () => {
    const swPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../public/sw.js",
    );
    const source = fs.readFileSync(swPath, "utf8");
    expect(source).toContain(SERVICE_WORKER_BUILD_ID_PLACEHOLDER);
  });
});
