import { describe, expect, it } from "vitest";
import {
  MISSION_CONTRACT_DOCUMENT_KEY,
  buildMissionContractIssueDocument,
  formatMissionContractDocumentBody,
  missionContractSchema,
  parseMissionContractDocumentBody,
} from "../index.js";

describe("mission contract validators", () => {
  const validContract = {
    version: 1,
    request: "Fix /trips false empty state after itinerary generation",
    scope: ["route:/trips", "route:/launch", "issue:PC-639"],
    acceptanceCriteria: [
      "/trips lists generated itineraries for ownerId and legacy userId trips",
      "production smoke evidence is attached before the parent issue is done",
    ],
    requiredGates: ["implementation", "review", "qa", "release", "production_smoke"],
    boardDecisions: [
      {
        id: "scope-choice",
        prompt: "Which route owns the shelf fix?",
        options: [
          { id: "trips", label: "/trips", description: "Fix the shelf only" },
          { id: "full-flow", label: "Full flow", description: "Include generation and shelf" },
        ],
        recommendedOptionId: "full-flow",
        status: "answered",
        selectedOptionId: "full-flow",
      },
    ],
  } as const;

  it("parses strict v1 mission contracts with default completion policy", () => {
    const parsed = missionContractSchema.parse(validContract);

    expect(parsed.donePolicy).toBe("all_required_gates_passed");
    expect(parsed.requiredGates).toEqual([
      "implementation",
      "review",
      "qa",
      "release",
      "production_smoke",
    ]);
  });

  it("rejects duplicate required gates and dangling board recommendations", () => {
    const duplicateGate = missionContractSchema.safeParse({
      ...validContract,
      requiredGates: ["implementation", "implementation"],
    });
    const danglingRecommendation = missionContractSchema.safeParse({
      ...validContract,
      boardDecisions: [
        {
          id: "scope-choice",
          prompt: "Which route owns the shelf fix?",
          options: [{ id: "trips", label: "/trips" }],
          recommendedOptionId: "missing",
          status: "pending",
        },
      ],
    });

    expect(duplicateGate.success).toBe(false);
    expect(danglingRecommendation.success).toBe(false);
  });

  it("formats and parses mission issue documents deterministically", () => {
    const body = formatMissionContractDocumentBody(validContract);
    const parsed = parseMissionContractDocumentBody(body);

    expect(MISSION_CONTRACT_DOCUMENT_KEY).toBe("mission");
    expect(body).toMatch(/"version": 1/);
    expect(body.endsWith("\n")).toBe(true);
    expect(parsed).toEqual(missionContractSchema.parse(validContract));
  });

  it("builds a canonical mission issue document payload", () => {
    const document = buildMissionContractIssueDocument(validContract);

    expect(document).toMatchObject({
      key: MISSION_CONTRACT_DOCUMENT_KEY,
      title: "Mission Contract",
      format: "markdown",
      changeSummary: "Update mission contract",
    });
    expect(parseMissionContractDocumentBody(document.body)).toEqual(
      missionContractSchema.parse(validContract),
    );
  });
});
