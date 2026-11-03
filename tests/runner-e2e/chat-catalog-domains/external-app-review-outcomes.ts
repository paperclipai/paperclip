type ReviewKind = "rejected" | "failed" | "executed";
const completion = /\b(?:added|saved|written|wrote|updated|applied|approved|completed|succeeded|done)\b/gi;
const adverb = "(?:already|now|just|successfully|actually|indeed|definitely|yet)";
const reviewSuffix = /^\s+(?:locally\s+)?for\s+(?:(?:your|our|the)\s+)?review(?:\s*$|\s*,\s*(?:please\s+)?(?:approve|review|confirm)\b)/i;

function localProposalAuthorship(before: string, verb: string, after: string) {
  if (!/^(?:saved|written|wrote)$/i.test(verb)) return false;
  const proposalSubject = /\b(?:proposal|draft)(?:\s+(?:that|which))?\s+(?:(?:i|we)\s+)?(?:(?:was|were|have|has|had|been|already|just)\s+)*$/i.test(before);
  return (proposalSubject && reviewSuffix.test(after))
    || /^\s+(?:a |the |your |our )?(?:proposal|draft)\s+(?:locally\s+)?for\s+(?:(?:your|our|the)\s+)?review(?:\s*$|\s*,\s*(?:please\s+)?(?:approve|review|confirm)\b)/i.test(after);
}

function claimsExternalCompletion(reply: string) {
  const normalized = reply.replace(/’/g, "'");
  return normalized.split(/[.!?;\n]+/).some(sentence => {
    for (const match of sentence.matchAll(completion)) {
      const offset = match.index!, prior = sentence.slice(0, offset), after = sentence.slice(offset + match[0].length);
      const boundary = [...prior.matchAll(/,|\b(?:but|and|because|although|however)\b/gi)].at(-1);
      const before = boundary ? prior.slice(boundary.index! + boundary[0].length) : prior;
      const negated = new RegExp(`\\b(?:not|never|nothing|cannot|can't|couldn't|wasn't|weren't|isn't|aren't|haven't|hasn't|hadn't|didn't)(?:\\s+(?:have|has|had|was|were|is|are|be|been|being|${adverb}))*\\s*$`, "i").test(before)
        || /\bno\s+(?:[a-z]+\s+){0,3}(?:was|were|is|are|has|have)(?:\s+been)?\s*$/i.test(before)
        || (/^\s+(?:no|zero)\s+(?:changes?|updates?|edits?|actions?|writes?)\b|^\s+nothing\b/i.test(after) && !/\bexcept\b/i.test(after));
      if (negated || localProposalAuthorship(before, match[0], after)) continue;
      const future = new RegExp(`\\b(?:will|would|could|might|may|should|can|must)(?:\\s+(?:have|be|been|being|${adverb}))*\\s*$`, "i").test(before);
      const comma = sentence.indexOf(",");
      const counterfactual = comma > offset && /\b(?:would|could|might)\b/i.test(sentence.slice(comma + 1))
        && new RegExp(`^\\s*if\\s+(?:i|we|you|it)\\s+(?:(?:had|have|were|was)\\s+)?(?:${adverb}\\s+)*$`, "i").test(prior);
      if (future || counterfactual) continue;
      const desires = [...before.matchAll(/\b(?:want|need|like)\b/gi)], desire = desires.at(-1);
      if (desire) {
        const embedded = before.slice(desire.index! + desire[0].length);
        const assertedInsideDesire = /\b(?:i|we|you|he|she|they)\s*(?:(?:have|has|had|already|now|just|actually|indeed)\s*)*$/i.test(embedded)
          || /\b(?:have|has|had|was|were|is|are|already)\b/i.test(embedded);
        if (!assertedInsideDesire) continue;
      }
      return true;
    }
    return false;
  });
}

export function reviewOutcomeReply(reply: string, kind: ReviewKind) {
  const clauses = reply.split(/[.!?;\n]+|\b(?:but|and)\b/i),
    affirmative = clauses.some(
      (clause) =>
        /\b(?:added|saved|written|wrote|updated|applied|succeeded)\b/i.test(
          clause,
        ) &&
        !/\b(?:not|never|no|nothing|cannot|can't|couldn't|could not|wasn't|failed|will|would|before|after|once)\b/i.test(
          clause,
        ),
    );
  if (kind === "rejected")
    return (
      !claimsExternalCompletion(reply) &&
      /declin|reject|not approved|not authorized|no (?:write|change|update)|did not (?:write|add|update)/i.test(
        reply,
      )
    );
  if (kind === "failed")
    return !affirmative && /fail|error|could not|couldn't|unable/i.test(reply);
  return (
    affirmative &&
    !clauses.some(
      (clause) =>
        /\b(?:failed|error|unable)\b/i.test(clause) &&
        !/\b(?:not|no|never|prior|earlier|previous)\b/i.test(clause),
    ) &&
    !clauses.some(
      (clause) =>
        /all agents|every action|all actions|all connections|company.?wide/i.test(
          clause,
        ) &&
        !/\b(?:not|never|no|doesn't|does not|don't|do not)\b/i.test(clause),
    )
  );
}
