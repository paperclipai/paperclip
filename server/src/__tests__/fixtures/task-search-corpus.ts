// Authored relevance judgments, independent of the ranker's scoring constants.
export const taskSearchCorpus = [
  { key: "id", identifier: "PAP-42", title: "Repair callback state", status: "done" },
  { key: "id-mention", title: "PAP-42 follow-up discussion" },
  { key: "id-neighbor", identifier: "PAP-420", title: "Repair callback state later" },
  { key: "oauth", title: "Fix GitHub OAuth callback", status: "done" },
  { key: "oauth-noise", title: "GitHub release checklist", comments: ["OAuth is mentioned in an unrelated weekly update."] },
  { key: "oauth-partial", title: "GitHub repository badges" },
  { key: "oauth-body", title: "Repair the connection flow", description: "GitHub OAuth callback loses state on redirect." },
  { key: "oauth-comment", title: "Investigate sign-in", comments: ["The GitHub OAuth callback loses state on redirect."] },
  { key: "oauth-doc", title: "Connection investigation", document: { title: "GitHub OAuth callback findings", body: "State is lost on redirect." } },
  { key: "search", title: "Improve search performance" },
  { key: "search-noise", title: "Improve exports", description: "A search for performance numbers was included in the meeting." },
  { key: "search-partial", title: "Search typography" },
  { key: "mobile", title: "Polish mobile navigation" },
  { key: "mobile-api", title: "Build mobile API" },
  { key: "mobile-ui", title: "Build mobile UI" },
  { key: "onboarding", title: "Onboarding wizard polish" },
  { key: "quoted", title: "Repair connection timeout handling" },
  { key: "quoted-scattered", title: "Connection retry after timeout" },
  { key: "cross", title: "Checkout ownership", comments: ["A concurrency race needs a regression test."] },
  { key: "cross-partial", title: "Checkout style guide" },
  { key: "document", title: "Adapter investigation", document: { title: "Hermes parser plan", body: "Discover plugins from their package manifest." } },
  { key: "percentage", title: "Release 100% checklist" },
  { key: "percentage-decoy", title: "Release 1000 checklist" },
  { key: "path", title: "Fix foo_bar lookup" },
  { key: "path-decoy", title: "Fix fooXbar lookup" },
  { key: "unicode", title: "Réparer navigation mobile" },
  { key: "identifier-code", title: "Document heartbeat_run_events retention" },
  { key: "word", title: "Fix API authentication" },
  { key: "word-decoy", title: "Capistrano migration", description: "API details appear here.", comments: ["API is an incidental mention."] },
  { key: "freshness", title: "Reconcile billing ledger", status: "done" },
  { key: "freshness-noise", title: "Weekly financial update", comments: ["Reconcile billing ledger was one of many completed projects."] },
] as const;

export type TaskSearchCase = {
  name: string;
  q: string;
  relevant: Record<string, number>; // 3 = intended task; 2 = useful; 1 = incidental; absent = irrelevant
  first?: string;
  absent?: string[];
  scope?: "all" | "issues" | "comments" | "documents";
};
export const taskSearchCases: TaskSearchCase[] = [
  { name: "exact identifier", q: "PAP-42", relevant: { id: 3, "id-mention": 1, "id-neighbor": 1 }, first: "id" },
  { name: "identifier case", q: "pap-42", relevant: { id: 3, "id-mention": 1, "id-neighbor": 1 }, first: "id" },
  { name: "compact identifier", q: "pap42", relevant: { id: 3, "id-neighbor": 1 }, first: "id" },
  { name: "spaced identifier", q: "PAP 42", relevant: { id: 3, "id-mention": 1, "id-neighbor": 1 }, first: "id" },
  { name: "title phrase", q: "GitHub OAuth", relevant: { oauth: 3, "oauth-body": 2, "oauth-comment": 2, "oauth-doc": 2, "oauth-noise": 1 }, first: "oauth", absent: ["oauth-partial"] },
  { name: "reordered title words", q: "OAuth GitHub callback", relevant: { oauth: 3, "oauth-body": 2, "oauth-comment": 2, "oauth-doc": 2 }, first: "oauth", absent: ["oauth-partial", "oauth-noise"] },
  { name: "title beats body chatter", q: "performance search", relevant: { search: 3, "search-noise": 1 }, first: "search", absent: ["search-partial"] },
  { name: "title beats incidental comment", q: "billing ledger", relevant: { freshness: 3, "freshness-noise": 1 }, first: "freshness" },
  { name: "filler words", q: "the GitHub OAuth callback", relevant: { oauth: 3, "oauth-body": 2, "oauth-comment": 2, "oauth-doc": 2 }, first: "oauth", absent: ["oauth-noise"] },
  { name: "quoted phrase", q: '"connection timeout"', relevant: { quoted: 3 }, first: "quoted", absent: ["quoted-scattered"] },
  { name: "quoted phrase plus term", q: 'repair "connection timeout"', relevant: { quoted: 3 }, first: "quoted", absent: ["quoted-scattered"] },
  { name: "transposition", q: "serach", relevant: { search: 3, "search-partial": 3 } },
  { name: "substitution", q: "mibile navigation", relevant: { mobile: 3, unicode: 3 }, absent: ["mobile-api", "mobile-ui"] },
  { name: "two missing letters", q: "onbordng wizard", relevant: { onboarding: 3 }, first: "onboarding" },
  { name: "short token constrains typo", q: "mibile api", relevant: { "mobile-api": 3 }, first: "mobile-api", absent: ["mobile", "mobile-ui"] },
  { name: "cross-field thread", q: "checkout concurrency", relevant: { cross: 3 }, first: "cross", absent: ["cross-partial"] },
  { name: "document title", q: "Hermes parser", relevant: { document: 3 }, first: "document" },
  { name: "document body", q: "plugins manifest", relevant: { document: 3 }, first: "document" },
  { name: "literal percent", q: "100%", relevant: { percentage: 3 }, first: "percentage", absent: ["percentage-decoy"] },
  { name: "literal underscore", q: "foo_bar", relevant: { path: 3 }, first: "path", absent: ["path-decoy"] },
  { name: "code identifier", q: "heartbeat_run_events", relevant: { "identifier-code": 3 }, first: "identifier-code" },
  { name: "unicode", q: "réparer mobile", relevant: { unicode: 3 }, first: "unicode" },
  { name: "whole word title", q: "api", relevant: { word: 3, "mobile-api": 3, "word-decoy": 1 } },
  { name: "no result", q: "quasarxylophone", relevant: {} },
];

export function searchQualityMetrics(keys: string[], relevant: Record<string, number>) {
  const gain = (grade: number, index: number) => (2 ** grade - 1) / Math.log2(index + 2);
  const dcg = keys.slice(0, 5).reduce((sum, key, index) => sum + gain(relevant[key] ?? 0, index), 0);
  const ideal = Object.values(relevant).sort((a, b) => b - a).slice(0, 5).reduce((sum, grade, index) => sum + gain(grade, index), 0);
  const rank = keys.findIndex((key) => relevant[key] === 3);
  return { ndcg5: ideal === 0 ? Number(keys.length === 0) : dcg / ideal, reciprocalRank: rank < 0 ? 0 : 1 / (rank + 1) };
}
