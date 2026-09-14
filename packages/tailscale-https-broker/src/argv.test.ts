import { describe, expect, it } from "vitest";
import { buildExposeArgv, buildRemoveArgv, buildStatusArgv } from "./argv.js";

const BIN = "/usr/bin/tailscale";

describe("argv construction", () => {
  it("builds an exact status argv with no shell tokens", () => {
    expect(buildStatusArgv(BIN)).toEqual([BIN, "serve", "status", "--json"]);
  });

  it("builds exact same-number expose/remove argv vectors", () => {
    expect(buildExposeArgv(BIN, 42010)).toEqual([
      BIN,
      "serve",
      "--bg",
      "--https=42010",
      "http://127.0.0.1:42010",
    ]);
    expect(buildRemoveArgv(BIN, 42010)).toEqual([BIN, "serve", "--https=42010", "off"]);
  });

  it("refuses the protected primary port 443 and privileged ports", () => {
    expect(() => buildExposeArgv(BIN, 443)).toThrow(/443/);
    expect(() => buildRemoveArgv(BIN, 443)).toThrow(/443/);
    expect(() => buildExposeArgv(BIN, 80)).toThrow(/privileged/);
    expect(() => buildExposeArgv(BIN, 1023)).toThrow(/privileged/);
  });

  it("refuses non-canonical ports (string, float, overflow)", () => {
    expect(() => buildExposeArgv(BIN, "42010" as unknown as number)).toThrow();
    expect(() => buildExposeArgv(BIN, 42010.5)).toThrow();
    expect(() => buildExposeArgv(BIN, 70000)).toThrow();
  });

  it("refuses a non-absolute or shell-metacharacter binary path", () => {
    expect(() => buildStatusArgv("tailscale")).toThrow(/absolute/);
    expect(() => buildStatusArgv("/usr/bin/tailscale; rm -rf /")).toThrow();
    expect(() => buildStatusArgv("/usr/bin/tail scale")).toThrow();
  });
});
