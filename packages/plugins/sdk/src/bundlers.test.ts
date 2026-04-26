import { describe, expect, it } from "vitest";
import { createPluginBundlerPresets } from "./bundlers.js";

// ============================================================================
// createPluginBundlerPresets — default configuration
// ============================================================================

describe("createPluginBundlerPresets — defaults", () => {
  it("returns both esbuild and rollup presets", () => {
    const presets = createPluginBundlerPresets();
    expect(presets).toHaveProperty("esbuild");
    expect(presets).toHaveProperty("rollup");
  });

  it("defaults outdir to 'dist'", () => {
    const presets = createPluginBundlerPresets();
    expect(presets.esbuild.worker.outdir).toBe("dist");
    expect(presets.rollup.worker.output.dir).toBe("dist");
  });

  it("defaults workerEntry to 'src/worker.ts'", () => {
    const presets = createPluginBundlerPresets();
    expect(presets.esbuild.worker.entryPoints).toEqual(["src/worker.ts"]);
    expect(presets.rollup.worker.input).toBe("src/worker.ts");
  });

  it("defaults manifestEntry to 'src/manifest.ts'", () => {
    const presets = createPluginBundlerPresets();
    expect(presets.esbuild.manifest.entryPoints).toEqual(["src/manifest.ts"]);
    expect(presets.rollup.manifest.input).toBe("src/manifest.ts");
  });

  it("defaults sourcemap to true", () => {
    const presets = createPluginBundlerPresets();
    expect(presets.esbuild.worker.sourcemap).toBe(true);
    expect(presets.esbuild.manifest.sourcemap).toBe(true);
    expect(presets.rollup.worker.output.sourcemap).toBe(true);
    expect(presets.rollup.manifest.output.sourcemap).toBe(true);
  });

  it("defaults minify to false on worker", () => {
    const presets = createPluginBundlerPresets();
    expect(presets.esbuild.worker.minify).toBe(false);
  });

  it("does not include ui preset when uiEntry is not provided", () => {
    const presets = createPluginBundlerPresets();
    expect(presets.esbuild.ui).toBeUndefined();
    expect(presets.rollup.ui).toBeUndefined();
  });
});

// ============================================================================
// createPluginBundlerPresets — custom configuration
// ============================================================================

describe("createPluginBundlerPresets — custom configuration", () => {
  it("respects custom outdir", () => {
    const presets = createPluginBundlerPresets({ outdir: "build" });
    expect(presets.esbuild.worker.outdir).toBe("build");
    expect(presets.rollup.worker.output.dir).toBe("build");
  });

  it("respects custom workerEntry", () => {
    const presets = createPluginBundlerPresets({ workerEntry: "custom/worker.ts" });
    expect(presets.esbuild.worker.entryPoints).toEqual(["custom/worker.ts"]);
    expect(presets.rollup.worker.input).toBe("custom/worker.ts");
  });

  it("respects custom manifestEntry", () => {
    const presets = createPluginBundlerPresets({ manifestEntry: "custom/manifest.ts" });
    expect(presets.esbuild.manifest.entryPoints).toEqual(["custom/manifest.ts"]);
    expect(presets.rollup.manifest.input).toBe("custom/manifest.ts");
  });

  it("sets sourcemap=false when specified", () => {
    const presets = createPluginBundlerPresets({ sourcemap: false });
    expect(presets.esbuild.worker.sourcemap).toBe(false);
    expect(presets.rollup.worker.output.sourcemap).toBe(false);
  });

  it("sets minify=true when specified", () => {
    const presets = createPluginBundlerPresets({ minify: true });
    expect(presets.esbuild.worker.minify).toBe(true);
  });

  it("includes ui preset when uiEntry is provided", () => {
    const presets = createPluginBundlerPresets({ uiEntry: "src/ui.tsx" });
    expect(presets.esbuild.ui).toBeDefined();
    expect(presets.rollup.ui).toBeDefined();
  });

  it("sets ui outdir to outdir/ui when uiEntry is provided", () => {
    const presets = createPluginBundlerPresets({ uiEntry: "src/ui.tsx", outdir: "dist" });
    expect(presets.esbuild.ui?.outdir).toBe("dist/ui");
    expect(presets.rollup.ui?.output.dir).toBe("dist/ui");
  });

  it("sets ui entryPoints to uiEntry", () => {
    const presets = createPluginBundlerPresets({ uiEntry: "src/ui.tsx" });
    expect(presets.esbuild.ui?.entryPoints).toEqual(["src/ui.tsx"]);
    expect(presets.rollup.ui?.input).toBe("src/ui.tsx");
  });

  it("applies all custom options together", () => {
    const presets = createPluginBundlerPresets({
      outdir: "output",
      workerEntry: "lib/worker.ts",
      manifestEntry: "lib/manifest.ts",
      uiEntry: "lib/ui.tsx",
      sourcemap: false,
      minify: true,
    });
    expect(presets.esbuild.worker.outdir).toBe("output");
    expect(presets.esbuild.worker.entryPoints).toEqual(["lib/worker.ts"]);
    expect(presets.esbuild.manifest.entryPoints).toEqual(["lib/manifest.ts"]);
    expect(presets.esbuild.ui).toBeDefined();
    expect(presets.esbuild.worker.sourcemap).toBe(false);
    expect(presets.esbuild.worker.minify).toBe(true);
  });
});

// ============================================================================
// createPluginBundlerPresets — esbuild config details
// ============================================================================

describe("createPluginBundlerPresets — esbuild config details", () => {
  it("worker uses ESM format on node platform", () => {
    const presets = createPluginBundlerPresets();
    expect(presets.esbuild.worker.format).toBe("esm");
    expect(presets.esbuild.worker.platform).toBe("node");
  });

  it("worker target is node20", () => {
    const presets = createPluginBundlerPresets();
    expect(presets.esbuild.worker.target).toBe("node20");
  });

  it("worker has bundle=true", () => {
    const presets = createPluginBundlerPresets();
    expect(presets.esbuild.worker.bundle).toBe(true);
  });

  it("manifest has bundle=false", () => {
    const presets = createPluginBundlerPresets();
    expect(presets.esbuild.manifest.bundle).toBe(false);
  });

  it("ui uses browser platform with ESM format", () => {
    const presets = createPluginBundlerPresets({ uiEntry: "src/ui.tsx" });
    expect(presets.esbuild.ui?.format).toBe("esm");
    expect(presets.esbuild.ui?.platform).toBe("browser");
  });

  it("ui externalizes React and SDK packages", () => {
    const presets = createPluginBundlerPresets({ uiEntry: "src/ui.tsx" });
    const ext = presets.esbuild.ui?.external ?? [];
    expect(ext).toContain("react");
    expect(ext).toContain("react-dom");
    expect(ext).toContain("@paperclipai/plugin-sdk/ui");
  });

  it("worker externalizes react and react-dom", () => {
    const presets = createPluginBundlerPresets();
    expect(presets.esbuild.worker.external).toContain("react");
    expect(presets.esbuild.worker.external).toContain("react-dom");
  });
});

// ============================================================================
// createPluginBundlerPresets — rollup config details
// ============================================================================

describe("createPluginBundlerPresets — rollup config details", () => {
  it("worker output format is 'es'", () => {
    const presets = createPluginBundlerPresets();
    expect(presets.rollup.worker.output.format).toBe("es");
  });

  it("worker output entryFileNames is worker.js", () => {
    const presets = createPluginBundlerPresets();
    expect(presets.rollup.worker.output.entryFileNames).toBe("worker.js");
  });

  it("manifest output entryFileNames is manifest.js", () => {
    const presets = createPluginBundlerPresets();
    expect(presets.rollup.manifest.output.entryFileNames).toBe("manifest.js");
  });

  it("ui output entryFileNames is index.js", () => {
    const presets = createPluginBundlerPresets({ uiEntry: "src/ui.tsx" });
    expect(presets.rollup.ui?.output.entryFileNames).toBe("index.js");
  });

  it("worker externalizes react and react-dom", () => {
    const presets = createPluginBundlerPresets();
    expect(presets.rollup.worker.external).toContain("react");
    expect(presets.rollup.worker.external).toContain("react-dom");
  });

  it("manifest externalizes @paperclipai/plugin-sdk", () => {
    const presets = createPluginBundlerPresets();
    expect(presets.rollup.manifest.external).toContain("@paperclipai/plugin-sdk");
  });

  it("ui externalizes React and SDK packages", () => {
    const presets = createPluginBundlerPresets({ uiEntry: "src/ui.tsx" });
    const ext = presets.rollup.ui?.external ?? [];
    expect(ext).toContain("react");
    expect(ext).toContain("@paperclipai/plugin-sdk/ui");
  });
});

// ============================================================================
// createPluginBundlerPresets — works with empty input object
// ============================================================================

describe("createPluginBundlerPresets — empty input", () => {
  it("works when called with empty object", () => {
    expect(() => createPluginBundlerPresets({})).not.toThrow();
  });

  it("works when called with no arguments", () => {
    expect(() => createPluginBundlerPresets()).not.toThrow();
  });
});
