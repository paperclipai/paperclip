export interface EstimationInput {
  description: string | null;
  comments?: Array<{ body: string }> | null;
  documents?: Array<{ latestBody: string }> | null;
  attachments?: Array<{ byteSize: number }> | null;
}

export function estimateCtxAndDiff(input: EstimationInput): { estCtx: number; estDiff: number } {
  const desc = input.description ?? "";
  const comments = input.comments ?? [];
  const docs = input.documents ?? [];
  const atts = input.attachments ?? [];

  // 1. Check for explicit overrides in description or comments
  let estCtx: number | null = null;
  let estDiff: number | null = null;

  const ctxRegex = /(?:est[-_]ctx|est[-_]tokens|context[-_]size)\s*[:=]\s*(\d+)/i;
  const diffRegex = /(?:est[-_]diff|diff[-_]size)\s*[:=]\s*(\d+)/i;

  // Search description
  const descCtxMatch = desc.match(ctxRegex);
  if (descCtxMatch) {
    estCtx = parseInt(descCtxMatch[1], 10);
  }
  const descDiffMatch = desc.match(diffRegex);
  if (descDiffMatch) {
    estDiff = parseInt(descDiffMatch[1], 10);
  }

  // Search comments
  for (const comment of comments) {
    if (estCtx === null) {
      const commCtxMatch = comment.body.match(ctxRegex);
      if (commCtxMatch) {
        estCtx = parseInt(commCtxMatch[1], 10);
      }
    }
    if (estDiff === null) {
      const commDiffMatch = comment.body.match(diffRegex);
      if (commDiffMatch) {
        estDiff = parseInt(commDiffMatch[1], 10);
      }
    }
  }

  // 2. Fall back to heuristic calculations if overrides are not present
  if (estCtx === null) {
    let totalChars = desc.length;
    for (const comment of comments) {
      totalChars += comment.body.length;
    }
    for (const doc of docs) {
      totalChars += doc.latestBody.length;
    }
    for (const att of atts) {
      totalChars += att.byteSize;
    }
    estCtx = Math.ceil(totalChars / 4);
  }

  if (estDiff === null) {
    // Check if the task touches code
    const isCodeRelated = 
      /(\.ts|\.js|\.py|\.go|\.json|\.java|\.cpp|\.cs|\.sh|\.yml|\.yaml|code|patch|PR|refactor|compile|build|test|drizzle|schema|api)/i.test(desc) ||
      desc.indexOf("```") !== -1;
    
    if (isCodeRelated) {
      // Guess a routine diff size of 1000 tokens as a safe heuristic baseline,
      // or scale slightly with description complexity up to a limit.
      estDiff = Math.min(5000, Math.max(500, Math.ceil(desc.length / 10)));
    } else {
      estDiff = 0;
    }
  }

  return { estCtx, estDiff };
}
