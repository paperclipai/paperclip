import { describe, expect, it } from "vitest";

import { capabilityTailnetAdmissionFailure } from "./tailnet-gateway.js";

const expectedHost = "paperclip-dev.example.ts.net:4196";
const expectedOrigin = `http://${expectedHost}`;

function mutation(headers: Record<string, string> = {}) {
  return capabilityTailnetAdmissionFailure({
    headers: {
      host: expectedHost,
      origin: expectedOrigin,
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
    pathname: "/api/capability/ui/message",
    expectedHost,
    expectedOrigin,
    capabilityValid: true,
  });
}

describe("Capability tailnet gateway admission", () => {
  it("accepts an exact-origin capability mutation when Fetch Metadata is absent", () => {
    expect(mutation()).toBeNull();
  });

  it("accepts complete same-origin Fetch Metadata", () => {
    expect(
      mutation({
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
      }),
    ).toBeNull();
  });

  it.each([
    ["sec-fetch-site", "cross-site"],
    ["sec-fetch-mode", "no-cors"],
    ["sec-fetch-dest", "document"],
  ])("rejects an explicitly unsafe %s value", (name, value) => {
    expect(mutation({ [name]: value })).toMatchObject({
      status: 403,
      code: "fetch_metadata_denied",
    });
  });

  it("still requires the exact mutation origin", () => {
    expect(mutation({ origin: "http://attacker.example" })).toMatchObject({
      status: 403,
      code: "origin_denied",
    });
  });

  it("still requires the preview capability", () => {
    expect(
      capabilityTailnetAdmissionFailure({
        headers: { host: expectedHost, origin: expectedOrigin, "content-type": "application/json" },
        method: "POST",
        pathname: "/api/capability/ui/message",
        expectedHost,
        expectedOrigin,
        capabilityValid: false,
      }),
    ).toMatchObject({ status: 403, code: "capability_denied" });
  });
});
