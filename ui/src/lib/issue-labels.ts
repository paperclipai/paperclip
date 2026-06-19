type IssueLabelInput = {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
};

function cleanLabelValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function buildIssueLabelParts(issue: IssueLabelInput, fallbackIdentifier?: string | null) {
  const shortId = cleanLabelValue(issue.identifier)
    ?? cleanLabelValue(fallbackIdentifier)
    ?? (issue.id ? issue.id.slice(0, 8) : null);
  const rawTitle = cleanLabelValue(issue.title);
  const hasDistinctTitle = Boolean(rawTitle && shortId && rawTitle !== shortId);
  const title = hasDistinctTitle ? rawTitle! : (rawTitle ?? shortId ?? "Issue");
  const identifierSuffix = hasDistinctTitle ? shortId : null;

  return {
    title,
    identifierSuffix,
    text: identifierSuffix ? `${title} ${identifierSuffix}` : title,
    ariaLabel: identifierSuffix ? `Issue ${title} ${identifierSuffix}` : `Issue ${title}`,
  };
}
