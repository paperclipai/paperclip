import { describe, expect, test } from "vitest";
import path from "path";
import { fileURLToPath } from "url";
import { buildIndex, lintOrganisations } from "../src/index-builder.js";

const HIER = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HIER, "..", "testdata", "vault");

describe("buildIndex", () => {
  test("Index aus Kontakten enthält Dateinamen, Organisationen, Namen", () => {
    const { index, anzahl } = buildIndex({
      vaultPfad: FIXTURE,
      indexOrdner: ["Kontakte"],
      ausgeschlosseneOrdner: ["attachments", ".obsidian", ".trash"],
      minBegrifflaenge: 5,
    });
    const terme = index.map((e) => e.term);
    expect(terme).toContain("mustermann-max");
    expect(terme).toContain("musterfirma ag");
    expect(terme).toContain("mustermann max");
    expect(terme).toContain("meier consulting gmbh");
    expect(anzahl).toBe(index.length);
  });

  test("Index ist nach Laenge absteigend sortiert", () => {
    const { index } = buildIndex({
      vaultPfad: FIXTURE,
      indexOrdner: ["Kontakte"],
      ausgeschlosseneOrdner: [],
      minBegrifflaenge: 5,
    });
    expect(index.length).toBeGreaterThan(1);
    for (let i = 1; i < index.length; i++) {
      expect(
        index[i - 1].term.length,
        `nicht sortiert an Position ${i}`,
      ).toBeGreaterThanOrEqual(index[i].term.length);
    }
  });

  test("respektiert minBegrifflaenge", () => {
    const { index } = buildIndex({
      vaultPfad: FIXTURE,
      indexOrdner: ["Kontakte"],
      ausgeschlosseneOrdner: [],
      minBegrifflaenge: 20,
    });
    expect(index.length).toBeGreaterThan(0);
    for (const e of index) expect(e.term.length).toBeGreaterThanOrEqual(20);
  });

  test("attachments wird nicht indiziert", () => {
    const { index } = buildIndex({
      vaultPfad: FIXTURE,
      indexOrdner: ["attachments"],
      ausgeschlosseneOrdner: ["attachments"],
      minBegrifflaenge: 5,
    });
    expect(index).toHaveLength(0);
  });

  test("Längen-Cap >= 30: lange Terme werden nicht vorzeitig gefiltert", () => {
    const { index } = buildIndex({
      vaultPfad: FIXTURE,
      indexOrdner: ["Kontakte"],
      ausgeschlosseneOrdner: [],
      minBegrifflaenge: 5,
    });
    // "meier consulting gmbh" ist 21 Zeichen und muss den Cap passieren
    expect(index.map((e) => e.term)).toContain("meier consulting gmbh");
  });
});

describe("lintOrganisations", () => {
  test("warnt nicht bei echten Firmennamen im Feld organisation", () => {
    // Mustermann-Max hat organisation "Musterfirma AG" → kein Stoppwort
    // Meier-Anna hat organisation "Meier Consulting GmbH" → kein Stoppwort
    const result = lintOrganisations({
      vaultPfad: FIXTURE,
      indexOrdner: ["Kontakte"],
      ausgeschlosseneOrdner: [],
    });
    expect(result.warnings).toEqual([]);
    expect(result.checked).toBeGreaterThan(0);
  });

  test("warnt bei Berufsbezeichnung im Feld organisation", () => {
    // Berater-Bernd.md trägt organisation "Berater" → Stoppwort
    const result = lintOrganisations({
      vaultPfad: FIXTURE,
      indexOrdner: ["Berufsbezeichnungen"],
      ausgeschlosseneOrdner: [],
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].datei).toBe("Berater-Bernd.md");
    expect(result.warnings[0].organisation).toBe("Berater");
  });
});
