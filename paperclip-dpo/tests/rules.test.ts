import { describe, it, expect } from "vitest";
import { loadDefaultRules, parseRules } from "../src/rules.js";

describe("loadDefaultRules", () => {
  it("liefert Default-Regelwerk", () => {
    const r = loadDefaultRules();
    expect(r.tenant).toBe("whitestag-internal");
    expect(r.detect.pii).toContain("email");
    expect(r.detect.llm).toContain("person");
    expect(r.block.art_9_categories).toBe(true);
    expect(r.confidenceThreshold.block).toBe("high");
    expect(r.mapping.ttlSeconds).toBe(86400);
  });
});

describe("parseRules", () => {
  it("parst minimales YAML", () => {
    const yaml = `
tenant: t
detect:
  pii: [email]
  llm: [person]
block:
  art_9_categories: false
confidence_threshold:
  block: high
  anonymize: low
mapping:
  ttl_seconds: 60
`;
    const r = parseRules(yaml);
    expect(r.tenant).toBe("t");
    expect(r.detect.pii).toEqual(["email"]);
    expect(r.mapping.ttlSeconds).toBe(60);
  });
});
