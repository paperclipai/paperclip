import { describe, expect, it } from "vitest";
import { codexUserNamespaceProfile } from "./codex-ci-sandbox.js";

describe("Codex CI user namespace profile", () => {
  it("grants namespaces only to the exact pinned executable", () => {
    const binary = "/home/runner/work/repo/node_modules/.pnpm/@openai+codex@1.0/vendor/bin/codex";
    const profile = codexUserNamespaceProfile(binary);
    expect(profile).toContain(`"${binary}" flags=(unconfined)`);
    expect(profile).toContain("userns,");
    expect(profile).not.toContain("*");
    expect(profile).not.toContain("capability,");
  });
  it.each(["relative/codex", "/tmp/*", '/tmp/" { userns, }', "/tmp/\nprofile bad", "/tmp/[ab]"])(
    "rejects attachment or policy injection: %s", (binary) => {
      expect(() => codexUserNamespaceProfile(binary)).toThrow("Unsafe Codex executable path");
    },
  );
});
