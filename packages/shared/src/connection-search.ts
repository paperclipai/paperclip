/** Retrieval only. A fuzzy match is never evidence of authorization or consent. */
export function normalizeConnectionSearch(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/['’]s\b/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const STOP_WORDS = new Set("a an and are as at be by can connect connection connections do find for from get help i in is it me my need not of on or our please real service services so some that the their them there this to tool tools use want we with would you your".split(" "));
const GENERIC_NAMES = new Set([...STOP_WORDS, "contacts", "email"]);

/** Reuse normalized words and deduplicated name windows across a catalog scan. */
export function prepareConnectionSearch(query: string) {
  const normalized = normalizeConnectionSearch(query);
  const words = normalized ? normalized.split(" ") : [];
  const phrases = new Set<string>();
  const phrasesByLength = new Map<number, Set<string>>();
  for (let start = 0; start < words.length; start++) {
    let phrase = "";
    for (let size = 1; size <= 6 && start + size <= words.length; size++) {
      phrase += words[start + size - 1];
      phrases.add(phrase);
      const bucket = phrasesByLength.get(phrase.length) ?? new Set<string>();
      bucket.add(phrase);
      phrasesByLength.set(phrase.length, bucket);
    }
  }
  return { normalized, compact: words.join(""), phrases, phrasesByLength,
    terms: [...new Set(words.filter(word => word.length > 1 && !STOP_WORDS.has(word)))],
  };
}

function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  if (a.length === b.length) {
    return a.slice(i + 1) === b.slice(i + 1)
      || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

export function scoreConnectionSearch(query: string | ReturnType<typeof prepareConnectionSearch>, names: readonly string[], description = "") {
  const prepared = typeof query === "string" ? prepareConnectionSearch(query) : query;
  const { normalized } = prepared;
  if (!normalized) return { score: 1, nameScore: 0 };
  let nameScore = 0;
  for (const name of names) {
    const normalizedName = normalizeConnectionSearch(name);
    const compact = normalizedName.replaceAll(" ", "");
    if (!compact) continue;
    if (compact === prepared.compact) {
      nameScore = 1000;
      break;
    }
    if (normalizedName.split(" ").every(word => GENERIC_NAMES.has(word))) continue;
    if (prepared.phrases.has(compact)) {
      nameScore = Math.max(nameScore, 500 + compact.length);
      continue;
    }
    if (compact.length >= 5 && nameScore < 500) {
      const fuzzy = [compact.length - 1, compact.length, compact.length + 1].some(length =>
        length >= 5 && [...(prepared.phrasesByLength.get(length) ?? [])].some(phrase => oneEditApart(phrase, compact)));
      if (fuzzy) nameScore = Math.max(nameScore, 200 + compact.length);
    }
    if (prepared.compact.length >= 4 && compact.startsWith(prepared.compact)) {
      nameScore = Math.max(nameScore, 100 + prepared.compact.length);
    }
  }
  const haystack = new Set(normalizeConnectionSearch(description).split(" "));
  const matched = prepared.terms.filter(term => haystack.has(term)
    || (term.length >= 4 && [...haystack].some(word => word.startsWith(term) || (word.length >= 4 && term.startsWith(word)))));
  return { nameScore, score: nameScore + Math.min(80, matched.length * 5) };
}
