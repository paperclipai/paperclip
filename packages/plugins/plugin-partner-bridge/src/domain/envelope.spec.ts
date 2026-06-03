import { describe, expect, it } from "vitest";
import { bridgeMsgId, buildEnvelope, bridgeOriginMarker, isBridgeAuthored } from "./envelope.js";
import type { ChannelItem } from "../types.js";

const item = (over: Partial<ChannelItem> = {}): ChannelItem => ({
  id: "c1", companyId: "A", issueId: "iss-A", kind: "msg", body: "hi", ts: "2026-06-03T10:00:00Z", ...over,
});

describe("envelope", () => {
  it("bridgeMsgId is unique-ish and stable string", () => {
    expect(bridgeMsgId()).not.toBe(bridgeMsgId());
    expect(typeof bridgeMsgId()).toBe("string");
  });
  it("buildEnvelope captures provenance", () => {
    const env = buildEnvelope(item(), "commitment", "BMID");
    expect(env).toMatchObject({ bridgeMsgId: "BMID", sourceCompanyId: "A", sourceItemId: "c1", kind: "msg", classification: "commitment" });
  });
  it("bridgeOriginMarker + isBridgeAuthored round-trip", () => {
    const meta = bridgeOriginMarker("peer-company-B");
    expect(isBridgeAuthored(item({ metadata: meta }))).toBe(true);
    expect(isBridgeAuthored(item({ metadata: {} }))).toBe(false);
    expect(isBridgeAuthored(item())).toBe(false);
  });
});
