import { describe, expect, it } from "vitest";
import {
  channelForVersion,
  collectChannelState,
  RELEASE_CHANNELS,
} from "../commands/channels.js";
import type { CommandRunner } from "../commands/install.js";

describe("channelForVersion", () => {
  it("maps published versions to their lane", () => {
    expect(channelForVersion("2026.811.0")).toBe("stable");
    expect(channelForVersion("2026.811.0-beta.0")).toBe("beta");
    expect(channelForVersion("2026.811.0-nightly.0")).toBe("nightly");
    expect(channelForVersion("2026.811.0-canary.3")).toBe("canary");
  });

  it("treats non-CalVer versions as unknown instead of guessing", () => {
    expect(channelForVersion("0.3.1")).toBe("unknown");
    expect(channelForVersion("2026.811.0-rc.1")).toBe("unknown");
    expect(channelForVersion("garbage")).toBe("unknown");
  });
});

describe("collectChannelState", () => {
  const versionsByTag: Record<string, string> = {
    latest: "2026.722.0",
    beta: "2026.811.0-beta.0",
    nightly: "2026.811.0-nightly.0",
    canary: "2026.811.0-canary.3",
  };

  const fakeRunner: CommandRunner = async (_command, args) => {
    const spec = (args ?? []).find((arg) => arg.startsWith("paperclipai@"));
    const tag = spec?.slice("paperclipai@".length) ?? "";
    const version = versionsByTag[tag];
    if (!version) throw new Error(`unexpected dist-tag: ${tag}`);
    return { stdout: JSON.stringify(version), stderr: "" };
  };

  it("resolves every channel's dist-tag from the registry", async () => {
    const state = await collectChannelState(fakeRunner);

    expect(state.map((entry) => entry.channel)).toEqual([
      "stable",
      "beta",
      "nightly",
      "canary",
    ]);
    expect(state.map((entry) => entry.version)).toEqual([
      "2026.722.0",
      "2026.811.0-beta.0",
      "2026.811.0-nightly.0",
      "2026.811.0-canary.3",
    ]);
  });

  it("degrades a single unavailable channel to null without failing the rest", async () => {
    const flakyRunner: CommandRunner = async (command, args, options) => {
      const spec = (args ?? []).find((arg) => arg.startsWith("paperclipai@"));
      if (spec === "paperclipai@nightly") throw new Error("registry timeout");
      return fakeRunner(command, args, options);
    };

    const state = await collectChannelState(flakyRunner);
    const byChannel = Object.fromEntries(state.map((entry) => [entry.channel, entry.version]));

    expect(byChannel.nightly).toBeNull();
    expect(byChannel.stable).toBe("2026.722.0");
    expect(byChannel.beta).toBe("2026.811.0-beta.0");
    expect(byChannel.canary).toBe("2026.811.0-canary.3");
  });

  it("keeps the channel table and dist-tags in sync", () => {
    expect(RELEASE_CHANNELS.map((entry) => entry.distTag)).toEqual([
      "latest",
      "beta",
      "nightly",
      "canary",
    ]);
  });
});
