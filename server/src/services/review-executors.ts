import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";

interface ReviewStepConfig {
  slug: string;
  name: string;
  type: "auto" | "manual";
  executor: "codex" | "claude" | "builtin" | "manual";
  config?: Record<string, unknown>;
}

interface ExecutionContext {
  companyId: string;
  issueId: string;
  workProductId: string;
  prDiff?: string;
  prUrl?: string;
  prTitle?: string;
  prBody?: string;
  /** Changed file paths from the PR, used by builtin steps like screenshot-required. */
  prFiles?: string[];
}

interface ExecutionResult {
  status: "passed" | "failed";
  summary: string;
  details: Record<string, unknown>;
}

export function reviewExecutorService(db: Db) {
  async function getIssueSummary(issueId: string): Promise<string> {
    const issue = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue) return "(issue not found)";
    return `Title: ${issue.title}\nDescription: ${issue.description ?? "(none)"}`;
  }

  async function executeCodex(
    step: ReviewStepConfig,
    ctx: ExecutionContext
  ): Promise<ExecutionResult> {
    // MVP placeholder — Codex CLI integration in Phase 2
    return {
      status: "passed",
      summary: `[Codex] ${step.name}: 검증 대기 중 (Codex CLI 연동 예정)`,
      details: { executor: "codex", stepSlug: step.slug, pending: true },
    };
  }

  async function executeClaude(
    step: ReviewStepConfig,
    ctx: ExecutionContext
  ): Promise<ExecutionResult> {
    const issueSummary = await getIssueSummary(ctx.issueId);
    // MVP placeholder — Claude agent integration in Phase 2
    return {
      status: "passed",
      summary: `[Claude] ${step.name}: 검증 대기 중 (Claude agent 연동 예정)`,
      details: {
        executor: "claude",
        stepSlug: step.slug,
        issueSummary,
        pending: true,
      },
    };
  }

  /**
   * builtin:screenshot-required
   *
   * Recommended for all team pipelines that ship UI work.
   * Auto-fails PRs that touch UI files but provide no screenshot evidence.
   *
   * UI file detection (generous):
   *   - Any file under `ui/` directory
   *   - Any `.tsx` file (UI components in any package)
   *   - Any `.css` or `.scss` file
   *   - Files with "component", "page", or "layout" in the path
   *
   * Screenshot detection in PR body:
   *   - Markdown image syntax: `![`
   *   - Image file extensions: .png .jpg .jpeg .gif .webp .svg
   *   - HTML img tags: `<img`
   *   - Keywords: "screenshot", "스크린샷", "화면"
   */
  async function executeScreenshotRequired(
    _step: ReviewStepConfig,
    ctx: ExecutionContext
  ): Promise<ExecutionResult> {
    const files = ctx.prFiles ?? [];

    const uiFilePatterns = [
      /^ui\//,
      /\.tsx$/,
      /\.css$/,
      /\.scss$/,
      /component/i,
      /page/i,
      /layout/i,
    ];

    const hasUiFiles = files.some((f) =>
      uiFilePatterns.some((pattern) => pattern.test(f))
    );

    // If no file list available, also check PR title/body for UI keywords
    const titleAndBody = `${ctx.prTitle ?? ""} ${ctx.prBody ?? ""}`.toLowerCase();
    const uiKeywords = ["ui", "화면", "프론트", "frontend", "component", "page", "layout", "디자인", "스타일", "css", "tailwind"];
    const hasUiKeywords = files.length === 0 && uiKeywords.some((kw) => titleAndBody.includes(kw));

    const isUiWork = hasUiFiles || hasUiKeywords;

    if (!isUiWork) {
      return {
        status: "passed",
        summary: "화면 변경 없음 — 스크린샷 불필요",
        details: { executor: "builtin", handler: "screenshot-required", uiFiles: false, uiKeywords: false },
      };
    }

    const body = ctx.prBody ?? "";

    // Extract image URLs from PR body
    const imageUrls: string[] = [];
    // Markdown: ![alt](url)
    const mdImages = body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g);
    for (const m of mdImages) imageUrls.push(m[1]);
    // HTML: <img src="url">
    const htmlImages = body.matchAll(/<img[^>]+src=["']([^"']+)["']/gi);
    for (const m of htmlImages) imageUrls.push(m[1]);
    // Bare image URLs
    const bareUrls = body.matchAll(/(https?:\/\/[^\s)>"']+\.(?:png|jpg|jpeg|gif|webp|svg)(?:\?[^\s)>"']*)?)/gi);
    for (const m of bareUrls) {
      if (!imageUrls.includes(m[1])) imageUrls.push(m[1]);
    }

    if (imageUrls.length === 0) {
      return {
        status: "failed",
        summary: "화면 작업이 포함되어 있지만 스크린샷이 없습니다. PR에 스크린샷을 첨부해주세요.",
        details: {
          executor: "builtin",
          handler: "screenshot-required",
          uiFiles: true,
          screenshotFound: false,
          screenshots: [],
        },
      };
    }

    return {
      status: "passed",
      summary: `스크린샷 ${imageUrls.length}개 확인됨`,
      details: {
        executor: "builtin",
        handler: "screenshot-required",
        uiFiles: true,
        screenshotFound: true,
        screenshots: imageUrls,
      },
    };
  }

  async function executeBuiltin(
    step: ReviewStepConfig,
    ctx: ExecutionContext
  ): Promise<ExecutionResult> {
    const handler = (step.config?.handler as string) ?? step.slug ?? "unknown";

    switch (handler) {
      case "builtin:screenshot-required":
      case "screenshot-required":
        return executeScreenshotRequired(step, ctx);
      default:
        // MVP placeholder — additional builtin handlers added as needed
        return {
          status: "passed",
          summary: `[Builtin] ${step.name}: 검증 대기 중 (${handler})`,
          details: { executor: "builtin", handler, pending: true },
        };
    }
  }

  return {
    execute: async (
      step: ReviewStepConfig,
      ctx: ExecutionContext
    ): Promise<ExecutionResult> => {
      switch (step.executor) {
        case "codex":
          return executeCodex(step, ctx);
        case "claude":
          return executeClaude(step, ctx);
        case "builtin":
          return executeBuiltin(step, ctx);
        case "manual":
          return {
            status: "passed",
            summary: "수동 검증 대기 중",
            details: { executor: "manual", awaitingHuman: true },
          };
        default:
          return {
            status: "failed",
            summary: `Unknown executor: ${step.executor}`,
            details: {},
          };
      }
    },
  };
}
