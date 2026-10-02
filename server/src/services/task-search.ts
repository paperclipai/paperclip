import { sql, type SQL } from "drizzle-orm";
import { COMPANY_SEARCH_MAX_QUERY_LENGTH, COMPANY_SEARCH_MAX_TOKENS } from "@paperclipai/shared";
import { visibleIssueCondition } from "./issue-visibility.js";

// Only grammatical filler is ignored, only in multi-term queries, and never
// inside quotes. Keep negation and domain words (API, UI, PR, etc.) meaningful.
const FILLER = new Set(["a", "an", "the", "and", "of", "to", "for", "in", "on", "with"]);
export function escapeTaskSearchPattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function parseTaskSearch(text: string) {
  const normalizedQuery = text.slice(0, COMPANY_SEARCH_MAX_QUERY_LENGTH).trim().replace(/\s+/g, " ").toLowerCase();
  const parsed = Array.from(normalizedQuery.matchAll(/"([^"]+)"|([^\s"]+)/g), (match) => ({
    text: match[1] ?? match[2]!, quoted: match[1] !== undefined,
  }));
  const meaningful = parsed.filter((term) => term.quoted || !FILLER.has(term.text));
  const uniqueTerms = new Map<string, { text: string; quoted: boolean }>();
  for (const term of meaningful.length > 0 ? meaningful : parsed) {
    uniqueTerms.set(term.text, { ...term, quoted: term.quoted || uniqueTerms.get(term.text)?.quoted === true });
  }
  const terms = [...uniqueTerms.values()].slice(0, COMPANY_SEARCH_MAX_TOKENS);
  const tokens = terms.map((term) => term.text);
  const phrase = tokens.join(" ");
  // A copied/typed task identifier is navigation, never a fuzzy number match.
  const identifier = /^([a-z][a-z0-9]*)[- ](\d+)$/i.exec(normalizedQuery) ?? /^([a-z]+)(\d+)$/i.exec(normalizedQuery);
  const identifierQuery = identifier ? `${identifier[1]}-${identifier[2]}` : normalizedQuery;
  const patterns = tokens.map((token) => `%${escapeTaskSearchPattern(token)}%`);
  const containsPattern = `%${escapeTaskSearchPattern(phrase)}%`;
  const startsWithPattern = `${escapeTaskSearchPattern(phrase)}%`;
  return { normalizedQuery, terms, tokens, phrase, identifierQuery, patterns, containsPattern, startsWithPattern };
}
export type TaskSearch = ReturnType<typeof parseTaskSearch>;

function taskSearchAny(field: SQL, search: TaskSearch): SQL<boolean> {
  return search.patterns.length === 0 ? sql`false`
    : sql`(${sql.join(search.patterns.map((pattern) => sql`${field} ILIKE ${pattern}`), sql` OR `)})`;
}
// Short typeahead terms must start a word: UI must not match "build", and
// API must not match "Capistrano". Keep an indexable literal precondition.
export function taskSearchTermMatch(field: SQL, search: TaskSearch, index: number): SQL<boolean> {
  const term = search.tokens[index]!;
  const literal = sql<boolean>`${field} ILIKE ${search.patterns[index]!}`;
  return /^[\p{L}]{1,3}$/u.test(term)
    ? sql`(${literal} AND ${field} ~* ${`(^|[^[:alnum:]])${term}`})`
    : literal;
}
export function taskSearchFieldMatch(field: SQL, search: TaskSearch): SQL<boolean> {
  return search.tokens.length === 0 ? sql`false`
    : sql`(${sql.join(search.tokens.map((_, index) => taskSearchTermMatch(field, search, index)), sql` OR `)})`;
}
function coverage(matches: SQL[]): SQL<number> {
  return matches.length === 0 ? sql`0`
    : sql`(${sql.join(matches.map((match) => sql`CASE WHEN ${match} THEN 1 ELSE 0 END`), sql` + `)})`;
}

// Score bands are deliberately disjoint. Incidental comments, repeated terms,
// status and recency cannot outweigh a stronger kind of match.
export function taskSearchScore(search: TaskSearch): SQL<number> {
  const n = search.tokens.length;
  if (n === 0) return sql`0`;
  return sql`(
    CASE
      WHEN m.ident_exact THEN 8000
      WHEN m.ident_starts THEN 7000
      WHEN m.title_exact THEN 6000
      WHEN m.title_phrase AND m.title_coverage = ${n} THEN 5000
      WHEN m.title_coverage = ${n} THEN 4000
      WHEN m.issue_coverage = ${n} THEN 3000
      WHEN m.token_coverage = ${n} THEN 2000
      WHEN m.fuzzy_title THEN 1000
      ELSE 0
    END
    + m.title_word_coverage * 10
    + CASE WHEN m.title_starts THEN 30 ELSE 0 END
    + CASE m.status WHEN 'done' THEN 0 WHEN 'cancelled' THEN 0 ELSE 10 END
  )::double precision`;
}

/** Shared task retrieval for company search and issue-list/command-palette search.
 * Uses existing pg_trgm indexes and current rows: no derived corpus or worker.
 * The tagged comment/document sets are evaluated once, not once per task.
 */
export function taskSearchCtes(companyId: string, search: TaskSearch, includeContext = true, fallbackFilters?: SQL): SQL {
  const n = search.tokens.length;
  const comments = n === 0 || !includeContext ? sql`SELECT NULL::uuid AS issue_id, 0 AS ord WHERE false`
    : sql.join(search.patterns.map((_, index) => sql`
      SELECT c.issue_id, ${index}::int AS ord FROM issue_comments c
      WHERE c.company_id = ${companyId} AND c.deleted_at IS NULL AND ${taskSearchTermMatch(sql`c.body`, search, index)}
      GROUP BY c.issue_id
    `), sql` UNION ALL `);
  const documents = n === 0 || !includeContext ? sql`SELECT NULL::uuid AS issue_id, 0 AS ord WHERE false`
    : sql.join(search.patterns.map((_, index) => sql`
      SELECT d.issue_id, ${index}::int AS ord FROM issue_documents d
      JOIN documents body ON body.id = d.document_id AND body.company_id = d.company_id
      WHERE d.company_id = ${companyId} AND (${taskSearchTermMatch(sql`body.title`, search, index)} OR ${taskSearchTermMatch(sql`body.latest_body`, search, index)})
      GROUP BY d.issue_id
    `), sql` UNION ALL `);
  const titleTerms = search.patterns.map((_, index) => taskSearchTermMatch(sql`issues.title`, search, index));
  const issueTerms = search.patterns.map((_, index) => sql`(
    ${titleTerms[index]!} OR ${taskSearchTermMatch(sql`issues.identifier`, search, index)}
    OR ${taskSearchTermMatch(sql`issues.description`, search, index)}
  )`);
  const commentTerms = search.patterns.map((_, index) => sql`issues.id IN (SELECT issue_id FROM comment_matches WHERE ord = ${index})`);
  const documentTerms = search.patterns.map((_, index) => sql`issues.id IN (SELECT issue_id FROM document_matches WHERE ord = ${index})`);
  const allTerms = issueTerms.map((term, index) => sql`(${term} OR ${commentTerms[index]!} OR ${documentTerms[index]!})`);
  const phraseMatch = (field: SQL) => n > 0 ? sql`coalesce(${field} ILIKE ${search.containsPattern}, false)` : sql`false`;
  const identExact = n > 0 ? sql`lower(issues.identifier) = ${search.identifierQuery}` : sql`false`;
  const identStarts = n > 0 ? sql`issues.identifier ILIKE ${escapeTaskSearchPattern(search.identifierQuery) + "%"}` : sql`false`;
  const fuzzyAllowed = !search.terms.some((term) => term.quoted)
    && search.terms.some((term) => /^[\p{L}]{4,255}$/u.test(term.text))
    && !/^[a-z][a-z0-9]*[- ]?\d+$/i.test(search.normalizedQuery);
  const fuzzyTerms = search.terms.map((term, index) => {
    if (!/^[\p{L}]{4,255}$/u.test(term.text)) return titleTerms[index]!;
    // Bound both arguments before calling fuzzystrmatch (255-character limit).
    // Cheap length checks prune word pairs before bounded edit-distance work.
    const edits = sql`CASE WHEN least(char_length(word), ${Array.from(term.text).length}) >= 6 THEN 2
      WHEN least(char_length(word), ${Array.from(term.text).length}) >= 5 THEN 1 ELSE 0 END`;
    return sql`(${titleTerms[index]!} OR EXISTS (
      SELECT 1 FROM regexp_split_to_table(lower(issues.title), '[^[:alnum:]]+') AS word
      WHERE CASE WHEN char_length(word) BETWEEN 4 AND 255
        AND abs(char_length(word) - ${Array.from(term.text).length}) <= ${edits}
        THEN levenshtein_less_equal(${term.text}, word, ${edits}) <= ${edits}
        ELSE false END
    ))`;
  });
  const fuzzy = fuzzyAllowed ? sql`CASE WHEN ${coverage(titleTerms)} = ${n} THEN false
    ELSE (${sql.join(fuzzyTerms, sql` AND `)}) END` : sql`false`;
  const wordTerms = search.tokens.map((token) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return sql`issues.title ~* ${`(^|[^[:alnum:]_])${escaped}($|[^[:alnum:]_])`}`;
  });
  // Carry flags, not potentially large bodies, through materialized stages.
  // The search page fetches descriptions only for its result window.
  const flags = (fuzzyMatch: SQL) => sql`
      SELECT issues.id, issues.identifier, issues.title,
        issues.status, issues.priority, issues.assignee_agent_id, issues.assignee_user_id,
        issues.project_id, issues.created_at, issues.updated_at,
        ${identExact} AS ident_exact, ${identStarts} AS ident_starts,
        ${phraseMatch(sql`issues.identifier`)} AS ident_phrase,
        ${taskSearchFieldMatch(sql`issues.identifier`, search)} AS ident_token,
        ${n > 0 ? sql`lower(issues.title) = ${search.phrase}` : sql`false`} AS title_exact,
        ${n > 0 ? sql`issues.title ILIKE ${search.startsWithPattern}` : sql`false`} AS title_starts,
        ${phraseMatch(sql`issues.title`)} AS title_phrase,
        ${taskSearchFieldMatch(sql`issues.title`, search)} AS title_token,
        ${phraseMatch(sql`issues.description`)} AS desc_phrase,
        ${taskSearchFieldMatch(sql`issues.description`, search)} AS desc_token,
        ${coverage(titleTerms)} AS title_coverage,
        ${coverage(wordTerms)} AS title_word_coverage,
        ${coverage(issueTerms)} AS issue_coverage,
        ${coverage(commentTerms)} AS comment_coverage,
        ${coverage(documentTerms)} AS document_coverage,
        ${coverage(allTerms)} AS token_coverage,
        ${fuzzyMatch} AS fuzzy_title,
        issues.id IN (SELECT issue_id FROM comment_matches) AS comment_match,
        issues.id IN (SELECT issue_id FROM document_matches) AS document_match
      FROM issues
  `;
  return sql`
    WITH comment_matches AS MATERIALIZED (${comments}),
    document_matches AS MATERIALIZED (${documents}),
    literal_candidates AS MATERIALIZED (
      SELECT issues.id FROM issues
      WHERE issues.company_id = ${companyId} AND ${visibleIssueCondition()}
        AND ${n === 0 ? sql`${search.normalizedQuery.length === 0}` : sql`(
          ${taskSearchAny(sql`issues.title`, search)}
          OR ${taskSearchAny(sql`issues.identifier`, search)}
          OR ${taskSearchAny(sql`issues.description`, search)}
          OR ${identStarts}
        )`}
      UNION SELECT issue_id FROM comment_matches
      UNION SELECT issue_id FROM document_matches
    ), search_flags AS MATERIALIZED (
      ${flags(sql`false`)}
      WHERE issues.company_id = ${companyId} AND ${visibleIssueCondition()}
        AND issues.id IN (SELECT id FROM literal_candidates)
    ), literal_matches AS MATERIALIZED (
      SELECT * FROM search_flags
      WHERE ${n === 0 ? sql`true` : sql`token_coverage = ${n} OR ident_exact OR ident_starts`}
    ), fuzzy_candidates AS MATERIALIZED (
      SELECT issues.id FROM issues
      WHERE NOT EXISTS (
        SELECT 1 FROM literal_matches literal
        JOIN issues ON issues.id = literal.id
        ${fallbackFilters ? sql`WHERE ${fallbackFilters}` : sql``}
      )
        AND issues.company_id = ${companyId} AND ${visibleIssueCondition()}
        AND ${fuzzy}
    ), matched AS MATERIALIZED (
      SELECT * FROM literal_matches
      UNION ALL
      ${flags(sql`true`)}
      WHERE issues.id IN (SELECT id FROM fuzzy_candidates)
    )
  `;
}
