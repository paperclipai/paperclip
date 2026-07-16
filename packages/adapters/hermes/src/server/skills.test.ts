import { describe, expect, test } from "vitest";

import path from "node:path";

import { resolveHermesSkillsHome } from "./skills.js";

describe("Hermes skill path resolution", () => {
  test.each([
    ["separate long option", ["--profile", "paco-studio"], "paco-studio"],
    ["separate short option", ["-p", "paco_studio"], "paco_studio"],
    ["equals long option", ["--profile=paco-studio"], "paco-studio"],
    ["equals short option", ["-p=paco_studio"], "paco_studio"],
    ["combined long option", ["--profile paco-studio"], "paco-studio"],
  ])("resolves a valid profile from the %s form", (_label, extraArgs, profile) => {
    expect(
      resolveHermesSkillsHome({
        env: { HERMES_HOME: "/tmp/hermes-home" },
        extraArgs,
      }),
    ).toBe(path.join("/tmp/hermes-home", "profiles", profile, "skills"));
  });

  test("uses the default Hermes skills directory when no profile is set", () => {
    expect(
      resolveHermesSkillsHome({
        env: { HERMES_HOME: "/tmp/hermes-home" },
      }),
    ).toBe(path.join("/tmp/hermes-home", "skills"));
  });

  test.each([
    ["separate long option", ["--profile", "../../outside"]],
    ["separate short option", ["-p", "../outside"]],
    ["equals long option", ["--profile=/tmp/outside"]],
    ["equals short option", ["-p=paco/studio"]],
    ["combined long option", ["--profile paco\\studio"]],
  ])("rejects an unsafe profile from the %s form", (_label, extraArgs) => {
    expect(() =>
      resolveHermesSkillsHome({
        env: { HERMES_HOME: "/tmp/hermes-home" },
        extraArgs,
      }),
    ).toThrow("Invalid Hermes profile name");
  });
});
