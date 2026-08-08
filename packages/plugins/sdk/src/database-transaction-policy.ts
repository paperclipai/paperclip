type RuntimeTableRef = {
  schema: string | null;
  table: string;
  keyword: string;
};

export type PluginDatabaseTransactionSqlTarget = {
  schema: string;
  table: string;
  keyword: string;
};

const SAFE_TRANSACTION_SQL_FUNCTIONS = new Set([
  "abs",
  "array_append",
  "array_cat",
  "array_prepend",
  "btrim",
  "ceil",
  "ceiling",
  "char_length",
  "coalesce",
  "concat",
  "concat_ws",
  "date_trunc",
  "decode",
  "encode",
  "floor",
  "gen_random_uuid",
  "greatest",
  "json_build_array",
  "json_build_object",
  "json_strip_nulls",
  "jsonb_build_array",
  "jsonb_build_object",
  "jsonb_insert",
  "jsonb_set",
  "jsonb_strip_nulls",
  "least",
  "length",
  "lower",
  "ltrim",
  "md5",
  "mod",
  "now",
  "nullif",
  "octet_length",
  "power",
  "replace",
  "round",
  "rtrim",
  "sign",
  "sqrt",
  "statement_timestamp",
  "substring",
  "to_json",
  "to_jsonb",
  "transaction_timestamp",
  "trim",
  "trunc",
  "upper",
]);

const TRANSACTION_SQL_PAREN_KEYWORDS = new Set([
  "all",
  "any",
  "cast",
  "conflict",
  "extract",
  "in",
  "position",
  "row",
  "values",
]);

function splitSqlStatements(input: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | "\"" | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    const next = input[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === ";") {
      const statement = input.slice(start, index).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }

  const trailing = input.slice(start).trim();
  if (trailing) statements.push(trailing);
  return statements;
}

function stripSqlForKeywordScan(input: string): string {
  return input
    .replace(/'([^']|'')*'/g, "''")
    .replace(/"([^"]|"")*"/g, "\"\"")
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function normaliseSql(input: string): string {
  return stripSqlForKeywordScan(input).replace(/\s+/g, " ").trim().toLowerCase();
}

function assertNoBannedSql(statement: string): void {
  const normalized = normaliseSql(statement);
  const banned = [
    /\bcreate\s+extension\b/,
    /\bcreate\s+(?:event\s+)?trigger\b/,
    /\bcreate\s+(?:or\s+replace\s+)?function\b/,
    /\bcreate\s+language\b/,
    /\bgrant\b/,
    /\brevoke\b/,
    /\bsecurity\s+definer\b/,
    /\bcopy\b/,
    /\bcall\b/,
    /\bdo\s+(?:\$\$|language\b)/,
  ];
  const matched = banned.find((pattern) => pattern.test(normalized));
  if (matched) {
    throw new Error(`Plugin SQL contains a disallowed statement or clause: ${matched.source}`);
  }
}

function unquoteRuntimeIdentifier(value: string): string {
  return value.startsWith("\"") && value.endsWith("\"")
    ? value.slice(1, -1).replaceAll("\"\"", "\"")
    : value;
}

/**
 * Remove runtime string contents before structural matching and fail closed on
 * comments. Double-quoted identifiers stay intact for namespace validation.
 */
function maskRuntimeSqlForStructure(statement: string): string {
  let masked = "";
  let singleQuoted = false;
  let doubleQuoted = false;

  for (let index = 0; index < statement.length; index += 1) {
    const char = statement[index]!;
    const next = statement[index + 1];

    if (singleQuoted) {
      if (char === "\\") {
        throw new Error(
          "ctx.db.execute runtime mutations must bind backslash-containing strings as parameters",
        );
      }
      masked += char === "\n" ? "\n" : " ";
      if (char === "'" && next === "'") {
        masked += " ";
        index += 1;
      } else if (char === "'") {
        singleQuoted = false;
      }
      continue;
    }
    if (doubleQuoted) {
      masked += char;
      if (char === "\"" && next === "\"") {
        masked += next;
        index += 1;
      } else if (char === "\"") {
        doubleQuoted = false;
      }
      continue;
    }
    if (char === "-" && next === "-") {
      throw new Error("ctx.db.execute runtime mutations cannot contain SQL comments");
    }
    if (char === "/" && next === "*") {
      throw new Error("ctx.db.execute runtime mutations cannot contain SQL comments");
    }
    if (
      ((char === "e" || char === "E") && next === "'")
      || ((char === "u" || char === "U") && next === "&" && statement[index + 2] === "'")
    ) {
      throw new Error(
        "ctx.db.execute runtime mutations must bind escape strings as parameters",
      );
    }
    if (char === "$" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(statement.slice(index))) {
      throw new Error(
        "ctx.db.execute runtime mutations must bind dollar-quoted strings as parameters",
      );
    }
    if (char === "'") {
      singleQuoted = true;
      masked += " ";
      continue;
    }
    if (char === "\"") doubleQuoted = true;
    masked += char;
  }

  return masked;
}

function extractRuntimeTableRefs(statement: string): RuntimeTableRef[] {
  const identifier = `\"(?:[^\"]|\"\")+\"|[A-Za-z_][A-Za-z0-9_]*`;
  const refs: RuntimeTableRef[] = [];
  const addMatch = (keyword: string, first: string, second?: string) => {
    refs.push(second
      ? {
          keyword,
          schema: unquoteRuntimeIdentifier(first),
          table: unquoteRuntimeIdentifier(second),
        }
      : {
          keyword,
          schema: null,
          table: unquoteRuntimeIdentifier(first),
        });
  };

  const updateTargetPattern = new RegExp(
    `^\\s*update\\s+(?:only\\s+)?(${identifier})(?:\\s*\\.\\s*(${identifier}))?`,
    "i",
  );
  const updateTarget = statement.match(updateTargetPattern);
  if (updateTarget) addMatch("update", updateTarget[1]!, updateTarget[2]);

  const relationPattern = new RegExp(
    `\\b(from|join|using|into|table)\\s+(?:only\\s+)?(${identifier})(?:\\s*\\.\\s*(${identifier}))?`,
    "gi",
  );
  for (const match of statement.matchAll(relationPattern)) {
    addMatch(match[1]!.toLowerCase(), match[2]!, match[3]);
  }
  return refs;
}

/**
 * Validate the complete SQL grammar accepted by one atomic plugin database
 * transaction step. The production host and SDK test harness both call this
 * function so a statement cannot pass the harness and fail host policy later.
 */
export function validatePluginDatabaseTransactionSql(
  query: string,
  namespace: string,
): PluginDatabaseTransactionSqlTarget {
  const statements = splitSqlStatements(query);
  if (statements.length !== 1) {
    throw new Error("Plugin runtime SQL must contain exactly one statement");
  }
  const statement = statements[0]!;
  assertNoBannedSql(statement);
  const structuralStatement = maskRuntimeSqlForStructure(statement);
  const normalized = structuralStatement.replace(/\s+/g, " ").trim().toLowerCase();
  if (!/^(insert\s+into|update|delete\s+from)\b/.test(normalized)) {
    throw new Error("ctx.db.execute only allows INSERT, UPDATE, or DELETE");
  }
  if (/\b(alter|create|drop|truncate)\b/.test(normalized)) {
    throw new Error("ctx.db.execute cannot contain DDL keywords");
  }
  if (/\btablesample\b/.test(normalized)) {
    throw new Error("ctx.db.execute does not allow TABLESAMPLE clauses");
  }
  if (/\b(set_config|pg_sleep|pg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)(?:_shared|_all)?)\b/.test(normalized)) {
    throw new Error("ctx.db.execute cannot call timeout or advisory-lock control functions");
  }

  const identifier = `\"(?:[^\"]|\"\")+\"|[A-Za-z_][A-Za-z0-9_]*`;
  const relationListPattern = new RegExp(
    `\\b(from|using)\\s+(?:only\\s+)?(?:${identifier})`
    + `(?:\\s*\\.\\s*(?:${identifier}))?`
    + `(?:\\s+(?:as\\s+)?(?:${identifier}))?\\s*,`,
    "i",
  );
  if (
    relationListPattern.test(structuralStatement)
    || /\b(from|using)\s*\(/i.test(structuralStatement)
  ) {
    throw new Error("ctx.db.execute does not allow comma or derived-table relation lists");
  }

  const refs = extractRuntimeTableRefs(structuralStatement);
  const target = refs.find((ref) => ["into", "update", "from"].includes(ref.keyword));
  if (!target || target.schema !== namespace) {
    throw new Error(`ctx.db.execute target must be inside plugin namespace "${namespace}"`);
  }
  for (const ref of refs) {
    if (ref.schema === null) {
      throw new Error(
        `ctx.db.execute table "${ref.table}" must use the fully qualified plugin namespace`,
      );
    }
    if (ref.schema !== namespace) {
      throw new Error("ctx.db.execute cannot reference public or other non-plugin schemas");
    }
  }

  if (
    refs.length !== 1
    || /\b(select|join|using|table|tablesample|returning|operator)\b/.test(normalized)
  ) {
    throw new Error(
      "ctx.db.executeTransaction steps must be single-table namespace mutations",
    );
  }

  const insertTargetPattern = new RegExp(
    `^\\s*insert\\s+into\\s+(?:only\\s+)?(?:${identifier})`
    + `\\s*\\.\\s*(?:${identifier})`
    + `(?:\\s+(?:as\\s+)?(?:${identifier}))?\\s*(\\()`,
    "i",
  );
  const insertTarget = structuralStatement.match(insertTargetPattern);
  const insertColumnListOffset = insertTarget?.index === undefined
    ? -1
    : insertTarget.index + insertTarget[0].lastIndexOf("(");
  const functionPattern = new RegExp(
    `(?:(?:(${identifier}))\\s*\\.\\s*)?(${identifier})\\s*(\\()`,
    "gi",
  );
  for (const match of structuralStatement.matchAll(functionPattern)) {
    const openParenOffset = match.index + match[0].lastIndexOf("(");
    if (openParenOffset === insertColumnListOffset) continue;
    const schema = match[1] ? unquoteRuntimeIdentifier(match[1]).toLowerCase() : null;
    const functionName = unquoteRuntimeIdentifier(match[2]!).toLowerCase();
    if (TRANSACTION_SQL_PAREN_KEYWORDS.has(functionName)) continue;
    if (schema !== null && schema !== "pg_catalog") {
      throw new Error(
        `ctx.db.executeTransaction function schema "${schema}" is not allowed`,
      );
    }
    if (!SAFE_TRANSACTION_SQL_FUNCTIONS.has(functionName)) {
      throw new Error(
        `ctx.db.executeTransaction function "${functionName}" is not allowed`,
      );
    }
  }

  return {
    schema: target.schema,
    table: target.table,
    keyword: target.keyword,
  };
}
