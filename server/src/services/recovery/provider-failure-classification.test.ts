import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  ADAPTER_FAILURE_RECOVERY_ERROR_CODES,
  INTENTIONALLY_UNCLASSIFIED_ADAPTER_FAILURE_ERROR_CODES,
  PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS,
  classifyAdapterFailureForRecovery,
} from "./service.js";

function discoverAdapterEntrypoints(rootDirs: string[]) {
  const entrypoints: string[] = [];

  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && entry.name === "execute.ts") {
        entrypoints.push(entryPath);
      }
    }
  };

  for (const rootDir of rootDirs) visit(rootDir);
  return entrypoints.sort();
}

function extractEmittedErrorCodes(filePath: string) {
  const sourceText = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const variableInitializers = new Map<string, ts.Expression[]>();
  const errorCodeAssignments: ts.Expression[] = [];

  const indexSource = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializers = variableInitializers.get(node.name.text) ?? [];
      initializers.push(node.initializer);
      variableInitializers.set(node.name.text, initializers);
    }
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === "errorCode") ||
        (ts.isStringLiteral(node.name) && node.name.text === "errorCode"))
    ) {
      errorCodeAssignments.push(node.initializer);
    }
    ts.forEachChild(node, indexSource);
  };
  indexSource(sourceFile);

  const codes = new Set<string>();
  const visited = new Set<ts.Expression>();
  const collectPossibleValues = (expression: ts.Expression) => {
    if (visited.has(expression)) return;
    visited.add(expression);

    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      if (/^[a-z][a-z0-9_]+$/.test(expression.text)) codes.add(expression.text);
      return;
    }
    if (ts.isConditionalExpression(expression)) {
      collectPossibleValues(expression.whenTrue);
      collectPossibleValues(expression.whenFalse);
      return;
    }
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isNonNullExpression(expression)
    ) {
      collectPossibleValues(expression.expression);
      return;
    }
    if (
      ts.isBinaryExpression(expression) &&
      (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      collectPossibleValues(expression.left);
      collectPossibleValues(expression.right);
      return;
    }
    if (ts.isIdentifier(expression)) {
      for (const initializer of variableInitializers.get(expression.text) ?? []) {
        collectPossibleValues(initializer);
      }
      return;
    }
    if (ts.isCallExpression(expression)) {
      let calledExpression: ts.Expression = expression.expression;
      while (ts.isParenthesizedExpression(calledExpression)) calledExpression = calledExpression.expression;
      if (ts.isArrowFunction(calledExpression) || ts.isFunctionExpression(calledExpression)) {
        const collectReturns = (node: ts.Node) => {
          if (ts.isReturnStatement(node) && node.expression) {
            collectPossibleValues(node.expression);
            return;
          }
          if (node !== calledExpression && ts.isFunctionLike(node)) return;
          ts.forEachChild(node, collectReturns);
        };
        collectReturns(calledExpression.body);
      }
    }
  };

  for (const expression of errorCodeAssignments) collectPossibleValues(expression);
  return { codes, errorCodeAssignmentCount: errorCodeAssignments.length };
}

describe("classifyAdapterFailureForRecovery", () => {
  it("classifies usage-limit messages and parses the provider reset time", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit for GPT-5. Try again at 4:30 PM (America/Chicago).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("uses the default recovery backoff when quota reset time is absent", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Provider quota exceeded for this model.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date(now.getTime() + PROVIDER_QUOTA_RECOVERY_DEFAULT_BACKOFF_MS),
      parsedResetTime: false,
    });
  });

  it("treats timezone-less provider reset clocks as UTC", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 4:30 PM.",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-16T16:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it("parses provider reset clocks in 24-hour format", () => {
    const now = new Date("2026-07-15T20:00:00.000Z");
    const classification = classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit. Try again at 21:30 (UTC).",
      resultJson: null,
    }, now);

    expect(classification).toEqual({
      kind: "provider_quota",
      retryAt: new Date("2026-07-15T21:30:00.000Z"),
      parsedResetTime: true,
    });
  });

  it.each([
    "model_not_found: requested model does not exist",
    "No API credentials were found for this provider",
    "API key is not set",
  ])("classifies configuration failures: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })).toEqual({ kind: "configuration_incomplete" });
  });

  it("ignores quota-like text from non-adapter failures", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "timeout",
      error: "Provider quota exceeded while waiting for a downstream service.",
      resultJson: null,
    })).toBeNull();
  });

  it("does not treat a generic capacity limit as provider quota", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });

  it.each([
    "You've hit your session limit",
    "You've hit your weekly limit",
    "Weekly limit reached",
    "You've hit your monthly spend limit",
  ])("classifies live quota vocabulary with a positive control: %s", (error) => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error,
      resultJson: null,
    })?.kind).toBe("provider_quota");

    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "You've hit your usage limit",
      resultJson: null,
    })?.kind).toBe("provider_quota");

    expect(classifyAdapterFailureForRecovery({
      errorCode: "adapter_failed",
      error: "Workspace storage capacity limit reached.",
      resultJson: null,
    })).toBeNull();
  });

  it.each(["acpx_turn_failed", "process_lost"])(
    "classifies live failure code %s with two-sided controls",
    (errorCode) => {
      expect(classifyAdapterFailureForRecovery({
        errorCode,
        error: "synthetic emitted transient failure",
        resultJson: null,
      })).toEqual({ kind: "transient_infra" });

      expect(classifyAdapterFailureForRecovery({
        errorCode: "adapter_failed",
        error: "You've hit your usage limit",
        resultJson: null,
      })?.kind).toBe("provider_quota");

      expect(classifyAdapterFailureForRecovery({
        errorCode: "timeout",
        error: "synthetic emitted transient failure",
        resultJson: null,
      })).toBeNull();
    },
  );

  it("classifies the emitted quota and transient retry families", () => {
    expect(classifyAdapterFailureForRecovery({
      errorCode: "acpx_turn_failed",
      error: "You've hit your monthly spend limit · raise it at claude.ai/settings/usage",
      resultJson: null,
    })?.kind).toBe("provider_quota");

    for (const errorCode of [
      "acpx_turn_failed",
      "acpx_session_init_failed",
      "acpx_stream_idle_timeout",
      "paperclip_control_plane_unreachable",
      "process_lost",
    ]) {
      expect(classifyAdapterFailureForRecovery({
        errorCode,
        error: "synthetic emitted transient failure",
        resultJson: null,
      })).toEqual({ kind: "transient_infra" });
    }
  });

  it("source-derives emitted failure codes and requires classification or explicit exclusion", () => {
    const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const entrypoints = discoverAdapterEntrypoints([
      path.join(repoRoot, "packages/adapters"),
      path.join(repoRoot, "packages/adapter-utils/src"),
      path.join(repoRoot, "server/src/adapters"),
    ]);
    const producerFiles = entrypoints.filter(
      (filePath) => extractEmittedErrorCodes(filePath).errorCodeAssignmentCount > 0,
    );

    expect(producerFiles.length, "adapter errorCode producer discovery must not be empty").toBeGreaterThan(0);
    const derivedCodes = new Set<string>();
    for (const filePath of producerFiles) {
      const { codes } = extractEmittedErrorCodes(filePath);
      expect(codes.size, `${path.relative(repoRoot, filePath)} must yield at least one error code`).toBeGreaterThan(0);
      for (const code of codes) derivedCodes.add(code);
    }

    expect(derivedCodes.size).toBeGreaterThan(0);
    for (const errorCode of derivedCodes) {
      expect(
        ADAPTER_FAILURE_RECOVERY_ERROR_CODES.has(errorCode) ||
          INTENTIONALLY_UNCLASSIFIED_ADAPTER_FAILURE_ERROR_CODES.has(errorCode),
        `${errorCode} must be classified or intentionally excluded`,
      ).toBe(true);
    }
  });
});
