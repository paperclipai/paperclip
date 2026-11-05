import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type IssueSnapshot } from "../src/contracts.js";
import { collectDeliveryFacts, decideLevel, evaluateIssue, parseRepoSlug } from "../src/evidence.js";

function snapshot(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    issueId: "issue-1",
    companyId: "company-1",
    identifier: "OMA-1",
    title: "Tarea",
    status: "done",
    priority: "high",
    comments: [],
    attachments: [],
    planBody: null,
    ...overrides,
  };
}

describe("gate de entrega", () => {
  it("rechaza un cierre sin ninguna evidencia", () => {
    const result = evaluateIssue(snapshot());
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("none");
    expect(result.missing).toContain("PR");
  });

  it("acepta un PR como entrega", () => {
    const result = evaluateIssue(
      snapshot({
        comments: [
          { id: "c1", body: "Listo: https://github.com/gampify/gampify/pull/91 revisado" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("pull_request");
  });

  it("acepta un parche adjunto", () => {
    const result = evaluateIssue(
      snapshot({ attachments: [{ id: "a1", fileName: "entrega.patch" }] }),
    );
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("patch");
  });

  it("acepta una medición verificada declarada en el plan", () => {
    const result = evaluateIssue(
      snapshot({ planBody: "EGM-VERIFIED: `curl -s https://api/health` -> 200" }),
    );
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("measurement");
  });

  it("acepta una decisión documentada (issue sin código por diseño)", () => {
    const result = evaluateIssue(snapshot({ planBody: "EGM-DELIVERABLE: decision" }));
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("decision");
  });

  it("un plan sin marca de entrega no es evidencia", () => {
    const result = evaluateIssue(
      snapshot({ planBody: "# Plan\n\nHice un análisis XYZ y creo que convendría..." }),
    );
    expect(result.ok).toBe(false);
  });

  it("un PR de otro repo no cuenta como entrega de esta issue", () => {
    const result = evaluateIssue(
      snapshot({
        expectedRepo: "gampify/gampify",
        comments: [{ id: "c1", body: "Listo https://github.com/vicinapp/vicin/pull/37" }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("otro repo");
  });

  it("un PR del repo del proyecto sí cuenta", () => {
    const result = evaluateIssue(
      snapshot({
        expectedRepo: "gampify/gampify",
        comments: [{ id: "c1", body: "Listo https://github.com/gampify/gampify/pull/91" }],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("pull_request");
  });

  it("sin repo conocido, un PR cuenta (no hay contra qué comparar)", () => {
    const result = evaluateIssue(
      snapshot({ comments: [{ id: "c1", body: "https://github.com/gampify/gampify/pull/91" }] }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("parseRepoSlug", () => {
  it("normaliza https, ssh y git@", () => {
    expect(parseRepoSlug("https://github.com/gampify/gampify")).toBe("gampify/gampify");
    expect(parseRepoSlug("https://github.com/gampify/gampify.git")).toBe("gampify/gampify");
    expect(parseRepoSlug("git@github.com:gampify/gampify.git")).toBe("gampify/gampify");
    expect(parseRepoSlug("ssh://git@github.com/gampify/gampify.git")).toBe("gampify/gampify");
    expect(parseRepoSlug("gampify/gampify")).toBe("gampify/gampify");
    expect(parseRepoSlug(null)).toBe(null);
    expect(parseRepoSlug("")).toBe(null);
  });
});

describe("nivel de revisión (EGM sólo cuando hace falta)", () => {
  it("sin entrega no hay revisión", () => {
    expect(decideLevel(collectDeliveryFacts(snapshot()))).toBe("off");
  });

  it("una decisión o una medición no requieren revisión de código", () => {
    const facts = collectDeliveryFacts(snapshot({ planBody: "EGM-VERIFIED: listo" }));
    expect(decideLevel(facts)).toBe("off");
  });

  it("un diff chico es lite", () => {
    const facts = collectDeliveryFacts(
      snapshot({
        comments: [{ id: "c1", body: "https://github.com/gampify/gampify/pull/91" }],
        planBody: "EGM-DIFF: 12 lines 1 files",
      }),
    );
    expect(decideLevel(facts)).toBe("lite");
  });

  it("un diff grande pasa a full", () => {
    const facts = collectDeliveryFacts(
      snapshot({
        comments: [{ id: "c1", body: "https://github.com/gampify/gampify/pull/91" }],
        planBody: "EGM-DIFF: 900 lines 14 files",
      }),
    );
    expect(decideLevel(facts)).toBe("full");
  });

  it("tocar producción exige aprobación humana, no revisión de IA", () => {
    const facts = collectDeliveryFacts(
      snapshot({
        title: "Deploy del worker a producción",
        comments: [{ id: "c1", body: "https://github.com/gampify/gampify/pull/91" }],
      }),
    );
    expect(decideLevel(facts)).toBe("human");
  });

  it("el umbral de full es configurable", () => {
    const facts = collectDeliveryFacts(
      snapshot({
        comments: [{ id: "c1", body: "https://github.com/gampify/gampify/pull/91" }],
        planBody: "EGM-DIFF: 400 lines 2 files",
      }),
    );
    expect(decideLevel(facts, DEFAULT_CONFIG)).toBe("full");
    expect(decideLevel(facts, { ...DEFAULT_CONFIG, fullDiffLines: 1000 })).toBe("lite");
  });
});
