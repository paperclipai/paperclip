import { describe, expect, it } from "vitest";

import { resolveInstalledPackageName } from "../services/plugin-loader.js";

/**
 * Regression coverage for NEO-317: the npm branch of `installPlugin` used to
 * treat the install *spec* as the on-disk `node_modules` directory name, which
 * broke `github:`, git, aliased, and `name@version` installs (the package is
 * stored under its real `package.json` name, never the spec). These assert the
 * resolver recovers the true name so the caller can build a valid path.
 */
describe("resolveInstalledPackageName", () => {
  it("resolves a github: spec to the package's real name (v8 converge case)", () => {
    const spec =
      "github:Neoreef/plugin-agent-channels#0c0d47f1aeb3ec6e401aa975a5b43ea1d5220807";
    const name = resolveInstalledPackageName(
      {},
      { "plugin-agent-channels": spec },
      spec,
    );
    expect(name).toBe("plugin-agent-channels");
  });

  it("resolves a name@version spec (npm records a semver range, not the spec)", () => {
    const name = resolveInstalledPackageName(
      {},
      { "some-plugin": "^1.2.3" },
      "some-plugin@1.2.3",
    );
    expect(name).toBe("some-plugin");
  });

  it("resolves a scoped @scope/name spec", () => {
    const name = resolveInstalledPackageName(
      {},
      { "@paperclipai/plugin-foo": "^0.1.0" },
      "@paperclipai/plugin-foo@0.1.0",
    );
    expect(name).toBe("@paperclipai/plugin-foo");
  });

  it("ignores pre-existing sibling dependencies and picks only the changed one", () => {
    const spec = "github:Neoreef/plugin-b#deadbeef";
    const name = resolveInstalledPackageName(
      { "plugin-a": "github:Neoreef/plugin-a#cafebabe" },
      {
        "plugin-a": "github:Neoreef/plugin-a#cafebabe",
        "plugin-b": spec,
      },
      spec,
    );
    expect(name).toBe("plugin-b");
  });

  it("detects a version bump of an already-installed plugin (re-converge to new sha)", () => {
    const newSpec = "github:Neoreef/plugin-agent-channels#newsha";
    const name = resolveInstalledPackageName(
      { "plugin-agent-channels": "github:Neoreef/plugin-agent-channels#oldsha" },
      { "plugin-agent-channels": newSpec },
      newSpec,
    );
    expect(name).toBe("plugin-agent-channels");
  });

  it("resolves an idempotent re-install where nothing changed (spec matches range)", () => {
    const spec = "github:Neoreef/plugin-agent-channels#samesha";
    const deps = {
      "plugin-a": "github:Neoreef/plugin-a#cafebabe",
      "plugin-agent-channels": spec,
    };
    const name = resolveInstalledPackageName(deps, deps, spec);
    expect(name).toBe("plugin-agent-channels");
  });

  it("resolves an idempotent name@version re-install via the dependency key", () => {
    const deps = { "some-plugin": "^1.2.3" };
    const name = resolveInstalledPackageName(deps, deps, "some-plugin@1.2.3");
    expect(name).toBe("some-plugin");
  });

  it("returns null when the installed name cannot be determined", () => {
    const deps = { "unrelated-dep": "^9.9.9" };
    const name = resolveInstalledPackageName(
      deps,
      deps,
      "github:Neoreef/plugin-agent-channels#abc123",
    );
    expect(name).toBeNull();
  });
});
