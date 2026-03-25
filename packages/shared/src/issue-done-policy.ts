type IssueLabelLike = {
  id: string;
  name: string;
};

type IssueAttachmentLike = {
  contentType: string;
};

const GITHUB_COMMIT_OR_PR_LINK_RE =
  /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:commit\/[0-9a-fA-F]{7,40}|pull\/\d+)(?:[/?#][^\s<>)\]}]*)?/;

const PLAYWRIGHT_RE = /\bplaywright\b/i;
const PLAYWRIGHT_PASS_RE = /\b\d+\s+passed\b|\bresult\s*:\s*pass(?:ed)?\b|\bplaywright\b[\s\S]{0,120}\bpassed\b|\bpassed\b[\s\S]{0,120}\bplaywright\b|\bplaywright\b[\s\S]{0,120}\bgreen\b|\bgreen\b[\s\S]{0,120}\bplaywright\b/i;
const PLAYWRIGHT_FAIL_RE = /\b\d+\s+failed\b|\bresult\s*:\s*fail(?:ed)?\b/i;

function normalizedIssueLabelName(name: string | null | undefined) {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

function issueRequiresNamedLabelEvidence(
  input: {
    currentLabels: IssueLabelLike[] | null | undefined;
    nextLabelIds?: string[] | null;
    companyLabels?: IssueLabelLike[] | null | undefined;
  },
  matchesLabelName: (name: string | null | undefined) => boolean,
) {
  if (Array.isArray(input.nextLabelIds)) {
    if (input.nextLabelIds.length === 0) return false;
    const nextLabelIdSet = new Set(input.nextLabelIds);
    return (input.companyLabels ?? []).some(
      (label) => nextLabelIdSet.has(label.id) && matchesLabelName(label.name),
    );
  }
  return (input.currentLabels ?? []).some((label) => matchesLabelName(label.name));
}

export function isCodeLabelName(name: string | null | undefined) {
  return normalizedIssueLabelName(name) === "code";
}

export function isUiLabelName(name: string | null | undefined) {
  return normalizedIssueLabelName(name) === "ui";
}

export function containsGitHubCommitOrPrLink(body: string | null | undefined) {
  if (!body) return false;
  return GITHUB_COMMIT_OR_PR_LINK_RE.test(body);
}

export function containsPassingPlaywrightEvidence(body: string | null | undefined) {
  if (!body) return false;
  if (!PLAYWRIGHT_RE.test(body)) return false;
  if (PLAYWRIGHT_FAIL_RE.test(body)) return false;
  return PLAYWRIGHT_PASS_RE.test(body);
}

export function resolveDoneTransitionEvidenceComment(
  commentBody: string | null | undefined,
  latestExistingCommentBody: string | null | undefined,
) {
  const directComment = commentBody?.trim();
  if (directComment) return directComment;
  const latestComment = latestExistingCommentBody?.trim();
  return latestComment || null;
}

export function issueRequiresCodeDoneEvidence(input: {
  currentLabels: IssueLabelLike[] | null | undefined;
  nextLabelIds?: string[] | null;
  companyLabels?: IssueLabelLike[] | null | undefined;
}) {
  return issueRequiresNamedLabelEvidence(input, isCodeLabelName);
}

export function issueRequiresUiDoneEvidence(input: {
  currentLabels: IssueLabelLike[] | null | undefined;
  nextLabelIds?: string[] | null;
  companyLabels?: IssueLabelLike[] | null | undefined;
}) {
  return issueRequiresNamedLabelEvidence(input, isUiLabelName);
}

export function issueHasImageAttachment(attachments: IssueAttachmentLike[] | null | undefined) {
  return (attachments ?? []).some((attachment) => attachment.contentType.startsWith("image/"));
}
