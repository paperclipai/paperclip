import { describe, expect, it } from "vitest";
import { parseTailscaleDevices } from "./devices.js";

describe("Tailscale machine discovery", () => {
  it("uses stable device IDs and preserves offline status without exposing peer metadata", () => {
    expect(parseTailscaleDevices({ BackendState: "Running", Peer: {
      a: { ID: "device-1", HostName: "Home Mac", DNSName: "home.example.ts.net.", TailscaleIPs: ["100.64.0.1"], OS: "macOS", Online: true, UserID: "private-user", PublicKey: "private-peer-metadata" },
      b: { ID: "device-2", HostName: "Workstation", TailscaleIPs: ["100.64.0.2"], OS: "linux", Online: false },
      invalid: { ID: "missing-address", TailscaleIPs: ["; shell command"] },
    } })).toEqual([
      { id: "device-1", name: "Home Mac", hostname: "home.example.ts.net", address: "100.64.0.1", os: "macOS", online: true },
      { id: "device-2", name: "Workstation", hostname: "100.64.0.2", address: "100.64.0.2", os: "linux", online: false },
    ]);
  });
  it("requires a running authenticated connector and never substitutes the host machine's tailnet", () => {
    for (const status of [null, {}, { BackendState: "NeedsLogin" }, { BackendState: "Stopped" }]) {
      expect(() => parseTailscaleDevices(status)).toThrow("Reconnect Tailscale");
    }
    expect(parseTailscaleDevices({ BackendState: "Running" })).toEqual([]);
  });
});
