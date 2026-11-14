import { describe, expect, it } from "vitest";
import { createDisplayTranslator, displayText, getDisplayLocale, resolveDisplayLocale } from "./display-text";

describe("createDisplayTranslator", () => {
  const translate = createDisplayTranslator({
    "New Agent": "Nouvel agent",
    "Found {{v0}} agents": "{{v0}} agents trouvés",
    "Broken {{v0}} marker": "Marqueur cassé",
  });

  it("translates known text and keeps surrounding whitespace", () => {
    expect(translate("New Agent")).toBe("Nouvel agent");
    expect(translate(" New Agent ")).toBe(" Nouvel agent ");
    expect(translate("Unlisted text")).toBe("Unlisted text");
  });

  it("interpolates values without translating them", () => {
    expect(translate("Found {{v0}} agents", { v0: "<b>New Agent</b>" })).toBe("<b>New Agent</b> agents trouvés");
    expect(translate("Found {{v0}} agents", { v0: "Ada" })).toBe("Ada agents trouvés");
    expect(translate("Found {{v0}} agents", { v0: 3 })).toBe("3 agents trouvés");
  });

  it("shows a value that is itself a short catalog label in the display language", () => {
    expect(translate("Found {{v0}} agents", { v0: "New Agent" })).toBe("Nouvel agent agents trouvés");
    expect(translate("{{v0}} {{v1}}", { v0: "New Agent", v1: "Box" })).toBe("Nouvel agent Box");
    expect(translate("Found {{v0}} agents", { v0: "Found {{v0}} agents" })).toBe("Found {{v0}} agents agents trouvés");
    expect(translate("Found {{v0}} agents", { v0: `New Agent ${"x".repeat(60)}` })).toBe(`New Agent ${"x".repeat(60)} agents trouvés`);
  });

  it("falls back to the source text when a translation loses a placeholder", () => {
    expect(translate("Broken {{v0}} marker", { v0: 2 })).toBe("Broken 2 marker");
  });
});

describe("displayText before a display language is loaded", () => {
  it("returns the English source unchanged", () => {
    expect(getDisplayLocale()).toBe("en");
    expect(displayText("New Agent")).toBe("New Agent");
    expect(displayText(" Leading and trailing ")).toBe(" Leading and trailing ");
    expect(displayText("{{v0}}m ago", { v0: 5 })).toBe("5m ago");
  });
});

describe("resolveDisplayLocale", () => {
  it("prefers a saved choice", () => {
    expect(resolveDisplayLocale("en", ["fr-FR"])).toBe("en");
    expect(resolveDisplayLocale("fr", ["en-US"])).toBe("fr");
  });

  it("follows the first supported browser language", () => {
    expect(resolveDisplayLocale(null, ["fr-FR", "en-US"])).toBe("fr");
    expect(resolveDisplayLocale(null, ["fr-CA"])).toBe("fr");
    expect(resolveDisplayLocale(null, ["en-GB", "fr-FR"])).toBe("en");
    expect(resolveDisplayLocale(null, ["de-DE", "fr"])).toBe("fr");
  });

  it("falls back to English", () => {
    expect(resolveDisplayLocale(null, [])).toBe("en");
    expect(resolveDisplayLocale("unknown", ["de-DE"])).toBe("en");
    expect(resolveDisplayLocale(null, ["frisian"])).toBe("en");
  });
});
