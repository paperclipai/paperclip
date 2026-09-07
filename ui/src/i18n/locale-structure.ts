/** Shared by runtime validation and the Node 24 catalog maintenance command. */
export function pluralBase(key: string, reference: Record<string, unknown>): string | null {
  const match = /^(.*)_(zero|one|two|few|many|other)$/.exec(key);
  return match && typeof reference[`${match[1]}_other`] === "string" ? match[1] : null;
}

/**
 * Compare semantic messages, not the English set of CLDR suffixes. A group
 * containing only _other is explicitly invariant; i18next expands its fallback.
 */
export function localeKeyReferences(reference: Record<string, unknown>, locale: string) {
  const expected = new Map<string, string>();
  const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  const groups = new Set<string>();
  for (const key of Object.keys(reference)) {
    const base = pluralBase(key, reference);
    if (base === null) expected.set(key, key);
    else groups.add(base);
  }
  for (const base of groups) {
    const inflected = Object.keys(reference).some((key) =>
      key !== `${base}_other` && pluralBase(key, reference) === base,
    );
    for (const category of inflected ? categories : ["other"]) {
      const key = `${base}_${category}`;
      expected.set(key, typeof reference[key] === "string" ? key : `${base}_other`);
    }
    // An exact-zero message is optional in i18next but must not be lost on sync.
    if (typeof reference[`${base}_zero`] === "string") expected.set(`${base}_zero`, `${base}_zero`);
  }
  return expected;
}

export function localeReferenceKey(key: string, reference: Record<string, unknown>): string | null {
  if (Object.hasOwn(reference, key)) return key;
  const base = pluralBase(key, reference);
  return base === null ? null : `${base}_other`;
}
