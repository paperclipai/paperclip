export function buildApprovalDeliverable(draft) {
  if (!draft || typeof draft.body !== "string" || !draft.body.trim()) return null;
  return [
    `To: ${String(draft.to || "").trim()}`,
    `Subject: ${String(draft.subject || "").trim()}`,
    "",
    draft.body.trim(),
  ].join("\n");
}

function revisionId(document) {
  return String(
    document?.latestRevisionId
      ?? document?.latest_revision_id
      ?? document?.document?.latestRevisionId
      ?? "",
  ).trim();
}

/**
 * Save the exact queued copy as the issue deliverable.
 *
 * Paperclip requires optimistic-concurrency metadata when a document already
 * exists. Approval revisions are the common update path, so fetch the current
 * revision first and retry once if another write wins the race.
 */
export async function saveApprovalDeliverable(api, issueId, draft, metadata = {}) {
  const body = buildApprovalDeliverable(draft);
  if (!body) return { saved: false, reason: "empty" };

  const path = `/api/issues/${issueId}/documents/deliverable`;
  const payload = {
    title: metadata.title || "Deliverable",
    format: "markdown",
    body,
    changeSummary: metadata.changeSummary || "runner: approval draft queued",
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await api("GET", path).catch((error) => {
      if (error?.status === 404) return null;
      throw error;
    });
    const baseRevisionId = revisionId(current);
    try {
      const document = await api("PUT", path, {
        ...payload,
        ...(baseRevisionId ? { baseRevisionId } : {}),
      });
      return { saved: true, document };
    } catch (error) {
      if (error?.status !== 409 || attempt === 1) throw error;
    }
  }

  return { saved: false, reason: "conflict" };
}
