import { describe, expect, it } from "vitest";
import { githubWizardBrowserOrigin } from "./chat-github-wizard.js";

describe("GitHub wizard enrolled browser origin", () => {
  it("uses the already approved loopback spelling on the same port", () => {
    expect(githubWizardBrowserOrigin("http://127.0.0.1:3110", ["http://localhost:3110"]))
      .toBe("http://localhost:3110");
  });

  it("preserves an exactly enrolled origin", () => {
    expect(githubWizardBrowserOrigin("http://127.0.0.1:3110", ["http://localhost:3110", "http://127.0.0.1:3110"]))
      .toBe("http://127.0.0.1:3110");
  });

  it.each([
    ["http://localhost:3109"],
    ["https://unrelated.example"],
  ])("does not substitute another port or a remote instance", (...origins) => {
    expect(githubWizardBrowserOrigin("http://127.0.0.1:3110", origins))
      .toBe("http://127.0.0.1:3110");
  });

  it("preserves the configured public origin", () => {
    expect(githubWizardBrowserOrigin("https://instance.example", ["http://localhost:3110"]))
      .toBe("https://instance.example");
  });

  it.each(["http://user@127.0.0.1:3110", "http://127.0.0.1:3110/path", "http://127.0.0.1:3110?query=1", "http://127.0.0.1:3110#fragment"])("does not normalize away invalid origin evidence: %s", (origin) => {
    expect(githubWizardBrowserOrigin(origin, ["http://localhost:3110"])).toBe(origin);
  });
});
