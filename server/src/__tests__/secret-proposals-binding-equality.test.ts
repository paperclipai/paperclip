import { describe, expect, it } from "vitest";
import { canonicalizeBinding } from "../services/secrets.js";
import { bindingAlreadyApplied } from "../services/secret-proposals.js";

/**
 * The env-binding identity check that guards a rebinding on an occupied agent config path.
 *
 * A stored binding is the canonical (defaulted) five-key form, while a proposal carries the
 * three-key form, so a string comparison reads every identical rebinding as a conflict. jsonb
 * decides the stored key order (shorter key first, then bytewise), which is why the check has to
 * compare semantics and why a differently ordered object cannot be staged through a real write.
 */

const SECRET_ID = "811341ef-0000-4000-8000-000000000001";
const OTHER_SECRET_ID = "811341ef-0000-4000-8000-000000000002";

const proposedSecretRef = () =>
  canonicalizeBinding({ type: "secret_ref", secretId: SECRET_ID, version: "latest" });

const storedSecretRef = (overrides: Record<string, unknown> = {}) => ({
  type: "secret_ref",
  secretId: SECRET_ID,
  version: "latest",
  projectionClass: "unclassified",
  projectionAllowlistKey: null,
  ...overrides,
});

describe("bindingAlreadyApplied", () => {
  it("treats a three-key proposal as already applied to the canonical stored form", () => {
    expect(bindingAlreadyApplied(storedSecretRef(), proposedSecretRef())).toBe(true);
  });

  it("treats the same binding with the keys in another order as already applied", () => {
    const reordered = {
      projectionAllowlistKey: null,
      projectionClass: "unclassified",
      version: "latest",
      secretId: SECRET_ID,
      type: "secret_ref",
    };
    expect(bindingAlreadyApplied(reordered, proposedSecretRef())).toBe(true);
    expect(Object.keys(reordered)).not.toEqual(Object.keys(storedSecretRef()));
  });

  it("treats a stored binding that omits the defaulted fields as already applied", () => {
    expect(bindingAlreadyApplied({ type: "secret_ref", secretId: SECRET_ID }, proposedSecretRef()))
      .toBe(true);
  });

  it("still reports a different secret, version, or type as not applied", () => {
    expect(bindingAlreadyApplied(
      storedSecretRef({ secretId: OTHER_SECRET_ID }),
      proposedSecretRef(),
    )).toBe(false);
    expect(bindingAlreadyApplied(storedSecretRef({ version: 3 }), proposedSecretRef())).toBe(false);
    expect(bindingAlreadyApplied(
      { type: "user_secret_ref", key: "other.user.key" },
      proposedSecretRef(),
    )).toBe(false);
  });

  it("still reports a legacy plain value or an unreadable value as not applied", () => {
    expect(bindingAlreadyApplied("inline-secret", proposedSecretRef())).toBe(false);
    expect(bindingAlreadyApplied({ type: "secret_ref" }, proposedSecretRef())).toBe(false);
    expect(bindingAlreadyApplied(undefined, proposedSecretRef())).toBe(false);
  });

  it("compares user secret refs on the same canonical terms", () => {
    const proposedUserRef = canonicalizeBinding({
      type: "user_secret_ref",
      key: "some.user.key",
      version: "latest",
      required: true,
      allowMissingOverride: false,
    });
    expect(bindingAlreadyApplied(
      { allowMissingOverride: false, required: true, version: "latest", key: "some.user.key", type: "user_secret_ref" },
      proposedUserRef,
    )).toBe(true);
    expect(bindingAlreadyApplied(
      { type: "user_secret_ref", key: "some.user.key", required: false, allowMissingOverride: false, version: "latest" },
      proposedUserRef,
    )).toBe(false);
  });
});
