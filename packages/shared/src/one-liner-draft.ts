export type OneLinerTaskMode = "solo" | "collab";

export interface OneLinerDraft {
  rawInput: string;
  taskTitle: string;
  todoTitle: string;
  dailyLog: string;
  deliverableTitle: string;
  basePrice: number | null;
  taskMode: OneLinerTaskMode;
  capacity: number;
  warnings: string[];
}

export interface OneLinerRewardEvidence {
  earnedGold: number;
  xp: number;
  rationale: string;
  settlementState: "proposed" | "issued";
}

function splitSegments(rawInput: string) {
  return rawInput
    .split(/\r?\n|;/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function parseExplicitValue(segment: string, labels: string[]) {
  for (const label of labels) {
    const regex = new RegExp(`^${label}\\s*:\\s*(.+)$`, "i");
    const match = segment.match(regex);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function parseBasePrice(value: string | null) {
  if (!value) return null;
  const digits = value.replace(/[^\d]/g, "");
  if (!digits) return null;
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferTaskMode(rawInput: string, explicitValue: string | null): OneLinerTaskMode {
  const normalized = explicitValue?.toLowerCase() ?? "";
  if (normalized === "collab" || normalized === "team") return "collab";
  if (normalized === "solo") return "solo";
  return /\b(collab|together|pair|team)\b/i.test(rawInput) ? "collab" : "solo";
}

function inferCapacity(rawInput: string, taskMode: OneLinerTaskMode, explicitValue: string | null) {
  const explicitDigits = explicitValue?.match(/\d+/)?.[0] ?? null;
  if (explicitDigits) {
    const parsed = Number.parseInt(explicitDigits, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  const inlineMatch = rawInput.match(/\b(?:cap|capacity)\s*:?\s*(\d+)\b/i);
  if (inlineMatch?.[1]) {
    const parsed = Number.parseInt(inlineMatch[1], 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return taskMode === "collab" ? 2 : 1;
}

export function parseOneLinerInput(rawInput: string): OneLinerDraft {
  const segments = splitSegments(rawInput);
  const unmatchedSegments: string[] = [];

  let taskTitle = "";
  let todoTitle = "";
  let dailyLog = "";
  let deliverableTitle = "";
  let explicitBasePrice: string | null = null;
  let explicitMode: string | null = null;
  let explicitCapacity: string | null = null;

  for (const segment of segments) {
    const taskValue = parseExplicitValue(segment, ["task", "work", "title"]);
    if (taskValue) {
      taskTitle = taskValue;
      continue;
    }

    const todoValue = parseExplicitValue(segment, ["todo", "to-do", "next"]);
    if (todoValue) {
      todoTitle = todoValue;
      continue;
    }

    const dailyValue = parseExplicitValue(segment, ["daily", "log", "note", "notes"]);
    if (dailyValue) {
      dailyLog = dailyValue;
      continue;
    }

    const deliverableValue = parseExplicitValue(segment, ["deliverable", "output", "artifact"]);
    if (deliverableValue) {
      deliverableTitle = deliverableValue;
      continue;
    }

    const priceValue = parseExplicitValue(segment, ["price", "base price", "base", "budget"]);
    if (priceValue) {
      explicitBasePrice = priceValue;
      continue;
    }

    const modeValue = parseExplicitValue(segment, ["mode"]);
    if (modeValue) {
      explicitMode = modeValue;
      continue;
    }

    const capacityValue = parseExplicitValue(segment, ["capacity", "cap"]);
    if (capacityValue) {
      explicitCapacity = capacityValue;
      continue;
    }

    unmatchedSegments.push(segment);
  }

  if (!taskTitle && unmatchedSegments.length > 0) {
    taskTitle = unmatchedSegments[0] ?? "";
  }

  if (!dailyLog && unmatchedSegments.length > 1) {
    dailyLog = unmatchedSegments.slice(1).join("\n");
  }

  const taskMode = inferTaskMode(rawInput, explicitMode);
  const capacity = inferCapacity(rawInput, taskMode, explicitCapacity);
  const basePrice = parseBasePrice(explicitBasePrice);

  const warnings: string[] = [];
  if (!taskTitle) warnings.push("Task title could not be derived from the input.");
  if (!deliverableTitle) warnings.push("Deliverable title is still missing.");
  if (basePrice == null) warnings.push("Base price is still missing.");

  return {
    rawInput,
    taskTitle,
    todoTitle,
    dailyLog,
    deliverableTitle,
    basePrice,
    taskMode,
    capacity,
    warnings,
  };
}

export function buildOneLinerTaskDescription(draft: OneLinerDraft) {
  const sections: string[] = [];

  if (draft.dailyLog.trim()) {
    sections.push(`Daily log\n${draft.dailyLog.trim()}`);
  }

  if (draft.todoTitle.trim()) {
    sections.push(`Todo intent\n- ${draft.todoTitle.trim()}`);
  }

  sections.push(`Source input\n${draft.rawInput.trim()}`);

  return sections.join("\n\n");
}

export function buildOneLinerRewardEvidence(input: {
  basePrice: number;
  deliverableCount: number;
  source?: "web" | "floating" | "voice" | "slack" | "teams" | "webhook" | "mobile" | "native";
}): OneLinerRewardEvidence {
  const sourceBonus = input.source && input.source !== "web" ? 10 : 0;
  const deliverableBonus = Math.max(0, input.deliverableCount - 1) * 5;
  const earnedGold = Math.max(1, Math.round(input.basePrice * 0.01) + sourceBonus + deliverableBonus);
  const xp = Math.max(10, Math.round(earnedGold / 2));

  return {
    earnedGold,
    xp,
    settlementState: "proposed",
    rationale: `Base price ${input.basePrice.toLocaleString()} x 1% + capture bonus ${sourceBonus} + deliverable bonus ${deliverableBonus}. Ledger issuance remains governed by quality/review settlement.`,
  };
}
