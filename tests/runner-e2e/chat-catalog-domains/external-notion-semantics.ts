export interface NotionFact { subjectAliases: string[]; valueAliases: string[] }
export function parseNotionFact(value: string | undefined): NotionFact {
  let fact: NotionFact;
  try { fact = JSON.parse(value ?? "") as NotionFact; } catch { throw new Error("Setup blocker: bounded Notion fact reference is missing or invalid"); }
  if (!fact || Object.keys(fact).some(key => !["subjectAliases", "valueAliases"].includes(key))
    || ![fact.subjectAliases, fact.valueAliases].every(aliases => Array.isArray(aliases) && aliases.length > 0 && aliases.length <= 8
      && aliases.every(alias => typeof alias === "string" && alias.trim().length >= 2 && alias.length <= 100 && !/[\r\n]/.test(alias)))) throw new Error("Setup blocker: bounded Notion fact aliases are invalid");
  return fact;
}
const normalize = (text: string) => text.toLocaleLowerCase("en-US").normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** A fact is the same approved subject/value relation in a bounded passage;
 * aliases represent fixture semantics, never an arbitrary prose verdict. */
export function notionFactSpan(text: string, fact: NotionFact): { start: number; end: number } | undefined {
  const subjectWords = fact.subjectAliases.map(normalize), valueWords = fact.valueAliases.map(normalize);
  for (let start = 0; start < text.length; start += 1) {
    if (start && /[\p{L}\p{N}]/u.test(text[start - 1]!)) continue;
    const passage = text.slice(start, start + 240).split(/\n\s*\n/)[0]!;
    const normalized = ` ${normalize(passage)} `;
    if (subjectWords.some(word => normalized.includes(` ${word} `)) && valueWords.some(word => normalized.includes(` ${word} `))) return { start, end: start + passage.length };
  }
}
export function notionPageIdentityMatches(href: string, pageId: string): boolean {
  try {
    const url = new URL(href); if (url.protocol !== "https:" || !/(^|\.)notion\.(?:so|site)$/.test(url.hostname)) return false;
    const wanted = pageId.replaceAll("-", "").toLowerCase(); if (!/^[a-f0-9]{32}$/.test(wanted)) return false;
    return decodeURIComponent(url.pathname).split("/").some(segment => {
      const match = segment.match(/(?:^|-)([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
      return match?.[1]?.replaceAll("-", "").toLowerCase() === wanted;
    });
  } catch { return false; }
}
const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function notionDateMentioned(text: string, iso: string): boolean {
  const date = new Date(iso); if (!Number.isFinite(date.getTime())) return false;
  const year = date.getUTCFullYear(), month = date.getUTCMonth(), day = date.getUTCDate();
  if (new RegExp(`\\b${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}\\b`).test(text)) return true;
  const name = months[month]!, monthPattern = `${name}|${name.slice(0, 3)}\\.?`;
  const patterns = [new RegExp(`\\b(?:${monthPattern})\\s*${day}(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?(?!\\d)`, "gi"),
    new RegExp(`\\b${day}(?:st|nd|rd|th)?\\s+(?:${monthPattern})(?:\\s*,?\\s*(\\d{4}))?(?!\\d)`, "gi")];
  return patterns.some(pattern => [...text.matchAll(pattern)].some(match => !match[1] || Number(match[1]) === year));
}
