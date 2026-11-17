// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { createDomTranslator, installDisplayDateLocale, startDomTranslation } from "./display-dom";

const catalog = {
  Mine: "À moi",
  "Month to Date": "Mois en cours",
  "updated {{v0}} ago": "mis à jour il y a {{v0}}",
  "{{v0}} running, {{v1}} paused": "{{v0}} en cours, {{v1}} en pause",
  "Search agents": "Rechercher des agents",
  "New Agent": "Nouvel agent",
  "{{v0}} agent": "agent {{v0}}",
  "{{v0}} tasks": "{{v0}} tâches",
  "{{v0}} task": "{{v0}} tâche",
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createDomTranslator", () => {
  it("translates exact labels and rich templates", () => {
    const translate = createDomTranslator(catalog);
    expect(translate("  Mine ")).toBe("  À moi ");
    expect(translate("updated 5 min ago")).toBe("mis à jour il y a 5 min");
    expect(translate("3 running, 1 paused")).toBe("3 en cours, 1 en pause");
  });

  it("does not touch translated output, poor templates or free text", () => {
    const translate = createDomTranslator(catalog);
    expect(translate("Nouvel agent")).toBeNull();
    expect(translate("Research agent")).toBeNull();
    expect(translate("Prepare the client demo")).toBeNull();
  });

  it("translates counted nouns only through catalog entries", () => {
    const translate = createDomTranslator(catalog);
    expect(translate("3 tasks")).toBe("3 tâches");
    expect(translate("1 task")).toBe("1 tâche");
    expect(translate("2 Zenith")).toBeNull();
  });
});

describe("startDomTranslation", () => {
  it("never touches editors, code, inputs or opted-out zones", () => {
    document.body.innerHTML = `
      <nav><button title="Search agents">Mine</button></nav>
      <pre>Mine</pre><code>Mine</code><textarea>Mine</textarea>
      <div contenteditable="true">Mine</div><div data-no-translate>Mine</div>
      <div class="ProseMirror"><p>Mine</p></div><input value="Mine" placeholder="Search agents">
      <select><option>Mine</option></select>`;
    const stop = startDomTranslation(document.body, createDomTranslator(catalog));
    expect(document.querySelector("nav button")?.textContent).toBe("À moi");
    expect(document.querySelector("nav button")?.getAttribute("title")).toBe("Rechercher des agents");
    for (const selector of ["pre", "code", "textarea", "[contenteditable]", "[data-no-translate]", ".ProseMirror p", "option"]) {
      expect(document.querySelector(selector)?.textContent).toBe("Mine");
    }
    expect(document.querySelector("input")?.value).toBe("Mine");
    expect(document.querySelector("input")?.getAttribute("placeholder")).toBe("Rechercher des agents");
    stop();
  });

  it("keeps attributes inside markdown, editors and opted-out zones as written", async () => {
    document.body.innerHTML = `
      <div class="paperclip-markdown"><img alt="New Agent" src="data:,"></div>
      <div data-no-translate><button title="Search agents" aria-label="New Agent">x</button></div>
      <div class="ProseMirror"><input placeholder="Search agents"></div>
      <form><textarea placeholder="Search agents"></textarea></form>`;
    const stop = startDomTranslation(document.body, createDomTranslator(catalog));
    expect(document.querySelector("img")?.getAttribute("alt")).toBe("New Agent");
    expect(document.querySelector("[data-no-translate] button")?.getAttribute("title")).toBe("Search agents");
    expect(document.querySelector("[data-no-translate] button")?.getAttribute("aria-label")).toBe("New Agent");
    expect(document.querySelector(".ProseMirror input")?.getAttribute("placeholder")).toBe("Search agents");
    expect(document.querySelector("form textarea")?.getAttribute("placeholder")).toBe("Rechercher des agents");
    const later = document.createElement("img");
    later.setAttribute("alt", "New Agent");
    document.querySelector(".paperclip-markdown")?.append(later);
    await tick();
    expect(later.getAttribute("alt")).toBe("New Agent");
    stop();
  });

  it("follows later text updates and insertions", async () => {
    document.body.innerHTML = '<span id="label">Mine</span>';
    const stop = startDomTranslation(document.body, createDomTranslator(catalog));
    const label = document.getElementById("label");
    const text = label?.firstChild;
    if (text) text.nodeValue = "Month to Date";
    await tick();
    expect(label?.textContent).toBe("Mois en cours");
    const paragraph = document.createElement("p");
    paragraph.textContent = "2 running, 0 paused";
    document.body.append(paragraph);
    await tick();
    expect(paragraph.textContent).toBe("2 en cours, 0 en pause");
    stop();
  });
});

describe("installDisplayDateLocale", () => {
  it("formats forced en-US dates in the display locale but keeps parts and resolved options", () => {
    installDisplayDateLocale(globalThis, "fr");
    const date = new Date("2026-10-29T12:00:00Z");
    expect(date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })).toBe("29 oct. 2026");
    expect(new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(date)).toBe("octobre");
    const parts = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).formatToParts(date);
    expect(parts.find((part) => part.type === "weekday")?.value).toBe("Thu");
    expect(new Intl.DateTimeFormat("en-US", { timeZone: "UTC" }).resolvedOptions().locale).toBe("en-US");
    expect(new Intl.DateTimeFormat("en-US") instanceof Intl.DateTimeFormat).toBe(true);
    expect(date.toLocaleDateString("de-DE", { timeZone: "UTC" })).toBe("29.10.2026");
  });
});
