import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { QUALIFIED_ACPX_PROFILES } from "./qualified-profiles.js";
import { verifyCopilotInstallation } from "./copilot-installation.js";
import { isSupportedAcpxProfileVersion } from "./profile-compatibility.js";

const bytes = (name: string) => readFileSync(new URL(`../../../test/fixtures/${name}`, import.meta.url));

describe("published identities after the Cursor Cloud qualification merge", () => {
  it.each([
  [
    "copilot-profile-v72-identity.json",
    "8d10c689a1707e06a5bfc93b37509b9f0b203586ee58c26cb780ab7057081fe7"
  ],
  [
    "copilot-profile-v73-identity.json",
    "ca8256cf778983db0561a0093879c334ae225cc88b75cc25b42459c69e04223f"
  ],
  [
    "copilot-profile-v74-identity.json",
    "2bfb5dc2f7ddac6dcd9229f155706c0f85da55e946e8c1ab60babced3e94201c"
  ],
  [
    "copilot-profile-v81-identity.json",
    "8b9d6b0e7ba3bb34141275f1a62701c3b69e1e917260d3c9984fbaeba6d413b1"
  ],
  [
    "grok-profile-v8-identity.json",
    "164c4e5bf1cd9696c5935fb0010348e575f05c421b4af5496799a7878735bfd9"
  ],
  [
    "grok-profile-v12-identity.json",
    "f43ac83f80fde04d8f184529502d3efc0df1b870d0ac8f863a183ae48eb6b004"
  ]
] as const)("keeps published %s byte-identical", (name, checksum) => {
    expect(createHash("sha256").update(bytes(name)).digest("hex")).toBe(checksum);
  });
});

describe("branch-only Cursor Cloud identities from 157d4119db48eff9de040d3951755e58dcbd1f0a", () => {
  it.each([
  [
    "copilot-profile-v72-cursor-cloud-candidate-historical-identity.json",
    "e119e6206f4450e7d6b79b4a1522215f9848419dbc0b46cae877d7a5ae600b69"
  ],
  [
    "copilot-profile-v73-cursor-cloud-candidate-historical-identity.json",
    "7e6d7841267f1cbc4117ab9a3cea7c1fb0ffe043b63ff640e3aa97859bd4ebb6"
  ],
  [
    "copilot-profile-v74-cursor-cloud-candidate-historical-identity.json",
    "d3868e9fc601e3efb85e1c6da651d920e4f08efd572075ed29e4bbfd9c3d223b"
  ],
  [
    "grok-profile-v8-cursor-cloud-candidate-historical-identity.json",
    "be0f07888a618794a2fe42e8894f42e2ac02d2c2c6a361560ae3d2b829b4c706"
  ]
] as const)("retains %s as qualification history", async (name, checksum) => {
    const retained = bytes(name);
    expect(createHash("sha256").update(retained).digest("hex")).toBe(checksum);
    const identity = JSON.parse(retained.toString("utf8"));
    const agent = name.startsWith("copilot") ? "copilot" : "grok";
    expect(isSupportedAcpxProfileVersion(agent, identity.declaration.agentProfileVersion)).toBe(true);
    expect(identity.commandDigest).not.toBe(QUALIFIED_ACPX_PROFILES[agent].commandDigest);
    if (agent === "copilot") {
      const sorted = Object.fromEntries(Object.entries(identity.declaration).sort(([a], [b]) => a.localeCompare(b)));
      expect(`sha256:${createHash("sha256").update(JSON.stringify(sorted)).digest("hex")}`).toBe(identity.commandDigest);
      await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot,
        agentProfileVersion: identity.declaration.agentProfileVersion, commandDigest: identity.commandDigest })).rejects.toThrow("exact pinned");
    }
  });
});


describe("retained Cursor Cloud core profile before semantic planning", () => {
  it("keeps version 82 byte-identical and decodable without admitting its old launch identity", async () => {
    const retained = bytes("copilot-profile-v82-cursor-cloud-candidate-historical-identity.json");
    expect(createHash("sha256").update(retained).digest("hex")).toBe("350564aceac59083b3009c5915c709549f0a257b0d828314184c28cded33e6a6");
    const identity = JSON.parse(retained.toString("utf8"));
    expect(isSupportedAcpxProfileVersion("copilot", 82)).toBe(true);
    expect(identity.commandDigest).not.toBe(QUALIFIED_ACPX_PROFILES.copilot.commandDigest);
    await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot, agentProfileVersion: 82, commandDigest: identity.commandDigest })).rejects.toThrow("exact pinned");
  });
});


describe("published identities from pinned master 54cc522e864291564bc37ddc6004bfa558c02644", () => {
  it.each([
  [
    "copilot-profile-v82-identity.json",
    "fe04407493a608d4204403d04ef06c79904a206f3c57547a11612c068a55b99f"
  ],
  [
    "copilot-profile-v83-identity.json",
    "31d024e3870f8a7278939f6f1186e2ec6d2bc331d7a89213aceae88c04b40654"
  ],
  [
    "copilot-profile-v84-identity.json",
    "6fe83e309911eb83f8b6e817f0b535329b02fab41ef7749d363f4562af19d4fe"
  ],
  [
    "grok-profile-v13-identity.json",
    "374993b170ea181470f6bc606ec568eb347f987e65338d8b980356d97c97b98b"
  ]
] as const)("preserves published %s byte-identical", (name, checksum) => {
    expect(createHash("sha256").update(bytes(name)).digest("hex")).toBe(checksum);
  });
});

describe("qualified branch-only identities from 0d968b005be9063b8c3806ecef5f75239dc5ce5b", () => {
  it.each([
  [
    "copilot-profile-v82-cursor-cloud-candidate-historical-identity.json",
    "350564aceac59083b3009c5915c709549f0a257b0d828314184c28cded33e6a6"
  ],
  [
    "copilot-profile-v83-cursor-cloud-candidate-historical-identity.json",
    "9b4fa60409fc8e0f85ec61ed6378188ccaeb806684aea3b05ae6cd0c451bb364"
  ],
  [
    "grok-profile-v13-cursor-cloud-candidate-historical-identity.json",
    "2db8e1be2c019e88cf089c2ae344c48d5e67c67b2ff72b2e3a21ff9657306261"
  ]
] as const)("retains %s as read-only qualification history", async (name, checksum) => {
    const retained = bytes(name);
    expect(createHash("sha256").update(retained).digest("hex")).toBe(checksum);
    const identity = JSON.parse(retained.toString("utf8"));
    const agent = name.startsWith("copilot") ? "copilot" : "grok";
    expect(isSupportedAcpxProfileVersion(agent, identity.declaration.agentProfileVersion)).toBe(true);
    expect(identity.commandDigest).not.toBe(QUALIFIED_ACPX_PROFILES[agent].commandDigest);
    if (agent === "copilot") {
      await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot,
        agentProfileVersion: identity.declaration.agentProfileVersion, commandDigest: identity.commandDigest })).rejects.toThrow("exact pinned");
    }
  });
});


describe("published Core041 profile history", () => {
  it("retains v85 bytes without admitting its stale shared bridge", async () => {
    const retained = bytes("copilot-profile-v85-cursor-cloud-qualification-historical-identity.json");
    expect(createHash("sha256").update(retained).digest("hex")).toBe("977d68b327f3964e8337ef8ba00230eb1b1697017db21f8010f664fee3d3c70a");
    const identity = JSON.parse(retained.toString("utf8"));
    expect(isSupportedAcpxProfileVersion("copilot", 85)).toBe(true);
    await expect(verifyCopilotInstallation({ ...QUALIFIED_ACPX_PROFILES.copilot, agentProfileVersion: 85, commandDigest: identity.commandDigest })).rejects.toThrow("exact pinned");
  });
});
