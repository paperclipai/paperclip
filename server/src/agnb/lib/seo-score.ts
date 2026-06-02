/**
 * Pure-compute SEO scorer for blog drafts — ported from agnb lib/agnb/seo-score.ts.
 * No API calls. Returns 0-100 score + per-check pass/warn/fail breakdown.
 */

export interface SeoCheck {
  key: string;
  label: string;
  status: "pass" | "warn" | "fail";
  message: string;
  weight: number;
}

export interface SeoScore {
  overall: number;
  grade: "A" | "B" | "C" | "D" | "F";
  checks: SeoCheck[];
  blocking_fails: SeoCheck[];
}

interface Input {
  title: string;
  description: string;
  body: string;
  keywords: string[];
}

export function scoreBlogDraft(input: Input): SeoScore {
  const checks: SeoCheck[] = [];
  const body = input.body;
  const wordCount = body.split(/\s+/).filter(Boolean).length;

  // 1. Title length (50-70 chars ideal)
  const tl = input.title.length;
  if (tl === 0) checks.push(c("title", "Title", "fail", "missing", 15));
  else if (tl < 30) checks.push(c("title", "Title", "warn", `${tl} chars (too short, aim 50-70)`, 15));
  else if (tl > 70) checks.push(c("title", "Title", "warn", `${tl} chars (too long, aim 50-70)`, 15));
  else checks.push(c("title", "Title", "pass", `${tl} chars`, 15));

  // 2. Meta description (140-160 chars ideal)
  const dl = input.description.length;
  if (dl === 0) checks.push(c("description", "Meta description", "fail", "missing", 10));
  else if (dl < 120) checks.push(c("description", "Meta description", "warn", `${dl} chars (under 120)`, 10));
  else if (dl > 165) checks.push(c("description", "Meta description", "warn", `${dl} chars (over 165, will truncate in search)`, 10));
  else checks.push(c("description", "Meta description", "pass", `${dl} chars`, 10));

  // 3. Word count (600-2500 ideal)
  if (wordCount === 0) checks.push(c("words", "Body length", "fail", "empty", 15));
  else if (wordCount < 400) checks.push(c("words", "Body length", "fail", `${wordCount} words (too thin, min 400)`, 15));
  else if (wordCount < 700) checks.push(c("words", "Body length", "warn", `${wordCount} words (aim 700+ for SEO)`, 15));
  else if (wordCount > 3000) checks.push(c("words", "Body length", "warn", `${wordCount} words (long — consider splitting)`, 15));
  else checks.push(c("words", "Body length", "pass", `${wordCount} words`, 15));

  // 4. Heading hierarchy
  const h2Count = (body.match(/^##\s/gm) ?? []).length;
  const h3Count = (body.match(/^###\s/gm) ?? []).length;
  if (h2Count === 0) checks.push(c("headings", "H2 sections", "fail", "no H2 headings (need 2+)", 10));
  else if (h2Count < 2) checks.push(c("headings", "H2 sections", "warn", `${h2Count} H2 (aim 3-5)`, 10));
  else if (h2Count > 8) checks.push(c("headings", "H2 sections", "warn", `${h2Count} H2 (too many — consider grouping)`, 10));
  else checks.push(c("headings", "H2 sections", "pass", `${h2Count} H2 · ${h3Count} H3`, 10));

  // 5. Internal links
  const internalLinks = (body.match(/\[[^\]]+\]\(\/[^)]+\)/g) ?? []).length;
  if (internalLinks === 0) checks.push(c("internal_links", "Internal links", "warn", "none (add 2-3 to existing Finn blogs)", 8));
  else if (internalLinks < 2) checks.push(c("internal_links", "Internal links", "warn", `${internalLinks} (add more for authority chain)`, 8));
  else checks.push(c("internal_links", "Internal links", "pass", `${internalLinks} internal`, 8));

  // 6. External links
  const externalLinks = (body.match(/\[[^\]]+\]\(https?:\/\/[^)]+\)/g) ?? []).length;
  if (externalLinks === 0) checks.push(c("external_links", "External links", "warn", "none (cite 1-2 sources for authority)", 5));
  else checks.push(c("external_links", "External links", "pass", `${externalLinks} external`, 5));

  // 7. Keyword presence in title + first paragraph
  const firstPara = body.split(/\n\n/)[0]?.toLowerCase() ?? "";
  const titleLower = input.title.toLowerCase();
  const primaryKw = (input.keywords[0] ?? "").toLowerCase();
  if (!primaryKw) checks.push(c("keyword_presence", "Primary keyword", "warn", "no keywords defined", 8));
  else {
    const inTitle = titleLower.includes(primaryKw);
    const inFirstPara = firstPara.includes(primaryKw);
    if (!inTitle && !inFirstPara) checks.push(c("keyword_presence", "Primary keyword", "fail", `"${primaryKw}" missing from title + first paragraph`, 8));
    else if (!inTitle) checks.push(c("keyword_presence", "Primary keyword", "warn", `"${primaryKw}" not in title`, 8));
    else if (!inFirstPara) checks.push(c("keyword_presence", "Primary keyword", "warn", `"${primaryKw}" not in first paragraph`, 8));
    else checks.push(c("keyword_presence", "Primary keyword", "pass", `"${primaryKw}" in title + first para`, 8));
  }

  // 8. Keyword density
  if (primaryKw && wordCount > 100) {
    const occurrences = (body.toLowerCase().match(new RegExp(escapeRegex(primaryKw), "g")) ?? []).length;
    const density = (occurrences * primaryKw.split(/\s+/).length) / wordCount * 100;
    if (density === 0) checks.push(c("kw_density", "Keyword density", "warn", `"${primaryKw}" not in body`, 6));
    else if (density > 3) checks.push(c("kw_density", "Keyword density", "warn", `${density.toFixed(1)}% (over 3% = stuffing risk)`, 6));
    else if (density < 0.3) checks.push(c("kw_density", "Keyword density", "warn", `${density.toFixed(1)}% (below 0.3%)`, 6));
    else checks.push(c("kw_density", "Keyword density", "pass", `${density.toFixed(1)}%`, 6));
  }

  // 9. Readability (rough)
  const sentences = body.split(/[.!?]+\s/).filter((s) => s.trim().length > 0);
  const avgSentLen = wordCount > 0 ? wordCount / Math.max(1, sentences.length) : 0;
  if (avgSentLen === 0) { /* skip if empty */ }
  else if (avgSentLen > 25) checks.push(c("readability", "Sentence length", "warn", `avg ${avgSentLen.toFixed(0)} words/sentence (aim < 22)`, 6));
  else if (avgSentLen < 8) checks.push(c("readability", "Sentence length", "warn", `avg ${avgSentLen.toFixed(0)} words/sentence (very short, may feel choppy)`, 6));
  else checks.push(c("readability", "Sentence length", "pass", `avg ${avgSentLen.toFixed(0)} words/sentence`, 6));

  // 10. Image presence
  const hasImage = /!\[[^\]]*\]\([^)]+\)|<img\s/.test(body);
  checks.push(c("images", "Inline images", hasImage ? "pass" : "warn", hasImage ? "present" : "no images (consider 1 hero + supporting)", 5));

  const totalWeight = checks.reduce((a, ck) => a + ck.weight, 0);
  const score = checks.reduce((a, ck) => a + ck.weight * (ck.status === "pass" ? 1 : ck.status === "warn" ? 0.5 : 0), 0);
  const overall = Math.round((score / totalWeight) * 100);

  const grade: SeoScore["grade"] =
    overall >= 90 ? "A" : overall >= 75 ? "B" : overall >= 60 ? "C" : overall >= 40 ? "D" : "F";

  return { overall, grade, checks, blocking_fails: checks.filter((ck) => ck.status === "fail") };
}

function c(key: string, label: string, status: SeoCheck["status"], message: string, weight: number): SeoCheck {
  return { key, label, status, message, weight };
}
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
