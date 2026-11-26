// The board answers "Use <marker>."; agents may save the instruction or only the
// reference, so a document passes when it holds the complete marker token.
export const submittedReferencePattern = (marker: string) => {
  if (!marker) throw new Error("A submitted reference marker is required");
  // "_" may be Markdown emphasis (_X_ or __X__) but not a joined word (old_X, X_extra).
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9-])(?<![A-Za-z0-9-]_+)${escaped}(?![A-Za-z0-9-])(?!_+[A-Za-z0-9-])`);
};
export const includesSubmittedReference = (body: unknown, marker: string) =>
  !!marker && typeof body === "string" && submittedReferencePattern(marker).test(body);
