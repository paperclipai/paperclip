import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type IssueSnapshot } from "../src/contracts.js";
import { collectDeliveryFacts, decideLevel, evaluateIssue, issueIsWithinAgentScope, parseRepoSlug } from "../src/evidence.js";

function snapshot(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    issueId: "issue-1",
    companyId: "company-1",
    identifier: "OMA-1",
    title: "Tarea",
    description: null,
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

  it("acepta una medicion verificada declarada en el plan", () => {
    const result = evaluateIssue(
      snapshot({ planBody: "EGM-VERIFIED: `curl -s https://api/health` -> 200" }),
    );
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("measurement");
  });

  it("acepta una decision documentada (issue sin codigo por diseno)", () => {
    const result = evaluateIssue(snapshot({ planBody: "EGM-DELIVERABLE: decision" }));
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("decision");
  });

  it("un plan sin marca de entrega no es evidencia", () => {
    const result = evaluateIssue(
      snapshot({ planBody: "# Plan\n\nHice un analisis XYZ y creo que convendria..." }),
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

  it("un PR del repo del proyecto si cuenta", () => {
    const result = evaluateIssue(
      snapshot({
        expectedRepo: "gampify/gampify",
        comments: [{ id: "c1", body: "Listo https://github.com/gampify/gampify/pull/91" }],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("pull_request");
  });

  it("sin repo conocido, un PR cuenta (no hay contra que comparar)", () => {
    const result = evaluateIssue(
      snapshot({ comments: [{ id: "c1", body: "https://github.com/gampify/gampify/pull/91" }] }),
    );
    expect(result.ok).toBe(true);
  });

  it("un PR ajeno antes que el valido no hiding del valido", () => {
    const result = evaluateIssue(
      snapshot({
        expectedRepo: "gampify/gampify",
        comments: [
          { id: "c1", body: "mira https://github.com/vicinapp/vicin/pull/37 y tambien https://github.com/gampify/gampify/pull/91" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("pull_request");
  });
});

describe("nivel de revision (EGM solo cuando hace falta)", () => {
  it("sin entrega no hay revision", () => {
    expect(decideLevel(collectDeliveryFacts(snapshot()))).toBe("off");
  });

  it("una decision o una medicion no requieren revision de codigo", () => {
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

  it("tocar produccion exige aprobacion de una persona", () => {
    const facts = collectDeliveryFacts(
      snapshot({
        title: "Deploy del worker a produccion",
        comments: [{ id: "c1", body: "https://github.com/gampify/gampify/pull/91" }],
      }),
    );
    expect(decideLevel(facts)).toBe("human");
  });

  it("la descripcion tambien cuenta (no solo el titulo)", () => {
    const facts = collectDeliveryFacts(
      snapshot({
        title: "Actualizar el worker",
        description: "desplegar a produccion el bundle nuevo",
        comments: [{ id: "c1", body: "https://github.com/gampify/gampify/pull/91" }],
      }),
    );
    expect(decideLevel(facts)).toBe("human");
  });

  it("una tarea humana no cierra sin la firma en el plan", () => {
    const sinFirma = evaluateIssue(
      snapshot({
        title: "Deploy a produccion",
        comments: [{ id: "c1", body: "https://github.com/gampify/gampify/pull/91" }],
      }),
    );
    expect(sinFirma.ok).toBe(false);
    expect(sinFirma.missing).toContain("EGM-APPROVED");

    const conFirma = evaluateIssue(
      snapshot({
        title: "Deploy a produccion",
        comments: [{ id: "c1", body: "https://github.com/gampify/gampify/pull/91" }],
        planBody: "EGM-APPROVED: Ana (2026-11-05)",
      }),
    );
    expect(conFirma.ok).toBe(true);
    expect(conFirma.level).toBe("human");
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

describe("frontera del agente (el tool no lee issues ajenas)", () => {
  it("acepta la issue asignada al agente que pregunta", () => {
    expect(
      issueIsWithinAgentScope(
        { projectId: "proj-a", assigneeAgentId: "agent-1" },
        { agentId: "agent-1", projectId: "proj-b" },
      ),
    ).toBe(true);
  });

  it("acepta la issue del proyecto del run del agente", () => {
    expect(
      issueIsWithinAgentScope(
        { projectId: "proj-a", assigneeAgentId: null },
        { agentId: "agent-1", projectId: "proj-a" },
      ),
    ).toBe(true);
  });

  it("RECHAZA una issue de otro proyecto y de otro agente", () => {
    expect(
      issueIsWithinAgentScope(
        { projectId: "proj-b", assigneeAgentId: "agent-2" },
        { agentId: "agent-1", projectId: "proj-a" },
      ),
    ).toBe(false);
  });

  it("rechaza cuando no hay contexto de agente (no se puede afirmar nada)", () => {
    expect(issueIsWithinAgentScope({ projectId: "proj-a", assigneeAgentId: null }, {})).toBe(false);
    expect(
      issueIsWithinAgentScope({ projectId: "proj-a", assigneeAgentId: null }, { agentId: "agent-1" }),
    ).toBe(false);
  });

  it("una issue sin proyecto solo pasa si esta asignada al agente", () => {
    expect(
      issueIsWithinAgentScope({ projectId: null, assigneeAgentId: "agent-1" }, { agentId: "agent-1" }),
    ).toBe(true);
    expect(
      issueIsWithinAgentScope({ projectId: null, assigneeAgentId: null }, { agentId: "agent-1", projectId: "proj-a" }),
    ).toBe(false);
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
