export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface FuzzySearchField {
  text: string | null | undefined;
  weight?: number;
}

function searchWords(value: string): string[] {
  return normalizeSearchText(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function fuzzyWordSubsequenceScore(word: string, token: string): number | null {
  if (token.length < 3) return null;

  let tokenIndex = 0;
  let firstIndex = -1;
  let lastIndex = -1;
  let gaps = 0;

  for (let wordIndex = 0; wordIndex < word.length && tokenIndex < token.length; wordIndex += 1) {
    if (word[wordIndex] !== token[tokenIndex]) continue;
    if (firstIndex === -1) {
      firstIndex = wordIndex;
    } else {
      gaps += wordIndex - lastIndex - 1;
    }
    lastIndex = wordIndex;
    tokenIndex += 1;
  }

  if (tokenIndex !== token.length) return null;

  const spread = lastIndex - firstIndex + 1;
  if (spread > token.length * 2) return null;

  return 32 + gaps * 2 + firstIndex + Math.max(0, word.length - token.length) * 0.5;
}

function scoreTokenAgainstText(text: string, token: string): number | null {
  if (!token) return 0;

  const words = searchWords(text);
  if (words.length === 0) return null;

  let bestScore = Number.POSITIVE_INFINITY;

  words.forEach((word, wordIndex) => {
    let score: number | null = null;
    if (word === token) {
      score = 0;
    } else if (word.startsWith(token)) {
      score = 8 + (word.length - token.length) * 0.25;
    } else {
      const substringIndex = word.indexOf(token);
      if (substringIndex >= 0) {
        score = 16 + substringIndex + (word.length - token.length) * 0.1;
      } else {
        score = fuzzyWordSubsequenceScore(word, token);
      }
    }

    if (score !== null) {
      bestScore = Math.min(bestScore, score + wordIndex * 0.05);
    }
  });

  const compactText = words.join("");
  const compactIndex = compactText.indexOf(token);
  if (compactIndex >= 0) {
    bestScore = Math.min(bestScore, 24 + compactIndex * 0.05);
  }

  const initials = words.map((word) => word[0]).join("");
  if (token.length <= 4) {
    if (initials.startsWith(token)) {
      bestScore = Math.min(bestScore, 28 + (initials.length - token.length) * 0.25);
    } else {
      const initialsIndex = initials.indexOf(token);
      if (initialsIndex >= 0) {
        bestScore = Math.min(bestScore, 36 + initialsIndex);
      }
    }
  }

  return Number.isFinite(bestScore) ? bestScore : null;
}

export function scoreFuzzyTextFields(fields: readonly FuzzySearchField[], query: string): number | null {
  const queryTokens = searchWords(query);
  if (queryTokens.length === 0) return 0;

  let totalScore = 0;

  for (const token of queryTokens) {
    let bestTokenScore = Number.POSITIVE_INFINITY;

    fields.forEach((field, fieldIndex) => {
      const text = field.text ?? "";
      const score = scoreTokenAgainstText(text, token);
      if (score === null) return;
      bestTokenScore = Math.min(bestTokenScore, score + (field.weight ?? fieldIndex * 20));
    });

    if (!Number.isFinite(bestTokenScore)) return null;
    totalScore += bestTokenScore;
  }

  return totalScore;
}

export function scoreFuzzyTextMatch(text: string, query: string): number | null {
  return scoreFuzzyTextFields([{ text }], query);
}

export function fuzzyTextMatchesQuery(text: string, query: string): boolean {
  return scoreFuzzyTextMatch(text, query) !== null;
}
