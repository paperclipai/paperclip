// Classifies whether a migration can be applied while the previous release's
// application code is still reading and writing the same database.
//
// This file is loaded with Node's built-in type stripping by the release and
// policy scripts, which run before dependencies are installed. Keep it free of
// imports and of TypeScript syntax that needs transpiling (enums, namespaces,
// parameter properties).

export type MigrationCompatibility = "online_compatible" | "requires_staging" | "unknown";

export const MIGRATION_COMPATIBILITY_VALUES: readonly MigrationCompatibility[] = [
  "online_compatible",
  "requires_staging",
  "unknown",
];

export const MIGRATION_COMPAT_DIRECTIVE = "paperclip:migration-compat";
export const MIGRATION_COMPAT_MIN_JUSTIFICATION_LENGTH = 10;

type ReasonDefinition = {
  readonly compatibility: MigrationCompatibility;
  readonly message: string;
};

// Codes that start with `lock_hazard_` mark statements whose only known problem
// is how long they hold a lock that blocks the old release. They classify as
// `unknown`, not as compatible with a warning: a deployer that may not pause
// must not start a statement whose duration grows with table size.
const REASONS = {
  create_table: { compatibility: "online_compatible", message: "Creates a table the previous release does not use." },
  create_table_if_not_exists: { compatibility: "online_compatible", message: "Creates a table only when it is missing. It may already exist, so later statements on it are judged as changes to an existing table." },
  create_temp_table: { compatibility: "online_compatible", message: "Creates a temporary table visible only to the migration session." },
  alter_new_table: { compatibility: "online_compatible", message: "Changes a table created earlier in this migration." },
  create_index_new_table: { compatibility: "online_compatible", message: "Builds an index on a table created earlier in this migration." },
  create_index_concurrently: { compatibility: "online_compatible", message: "Builds a non-unique index without blocking writes." },
  add_column: { compatibility: "online_compatible", message: "Adds a column that is nullable or has a constant default." },
  add_constraint_not_valid: { compatibility: "online_compatible", message: "Adds a NOT VALID constraint, which does not scan existing rows." },
  drop_not_null: { compatibility: "online_compatible", message: "Relaxes a NOT NULL column." },
  create_type: { compatibility: "online_compatible", message: "Creates a type the previous release does not use." },
  add_enum_value: { compatibility: "online_compatible", message: "Adds a value to an enum type." },
  create_sequence: { compatibility: "online_compatible", message: "Creates a sequence the previous release does not use." },
  create_extension: { compatibility: "online_compatible", message: "Installs an extension." },
  create_function: { compatibility: "online_compatible", message: "Creates a function that did not exist before." },
  create_view: { compatibility: "online_compatible", message: "Creates a view that did not exist before." },
  create_trigger_new_table: { compatibility: "online_compatible", message: "Creates a trigger on a table created earlier in this migration." },
  comment: { compatibility: "online_compatible", message: "Sets a catalog comment." },
  create_statistics: { compatibility: "online_compatible", message: "Creates extended planner statistics without blocking reads or writes." },
  analyze: { compatibility: "online_compatible", message: "Refreshes planner statistics without blocking reads or writes." },
  no_op: { compatibility: "online_compatible", message: "Has no effect on the schema or data." },
  seed_new_table: { compatibility: "online_compatible", message: "Writes rows to a table created earlier in this migration." },

  drop_table: { compatibility: "requires_staging", message: "Drops a table the previous release may still use." },
  drop_column: { compatibility: "requires_staging", message: "Drops a column the previous release may still read or write." },
  rename_table: { compatibility: "requires_staging", message: "Renames a table the previous release still addresses by its old name." },
  rename_column: { compatibility: "requires_staging", message: "Renames a column the previous release still addresses by its old name." },
  alter_column_type: { compatibility: "requires_staging", message: "Changes a column type, which rewrites the table and can reject the previous release's values." },
  set_not_null: { compatibility: "requires_staging", message: "Sets NOT NULL on a column the previous release may still leave empty." },
  add_not_null_column_without_default: { compatibility: "requires_staging", message: "Adds a NOT NULL column without a default; inserts from the previous release fail." },
  drop_default: { compatibility: "requires_staging", message: "Drops a default the previous release may rely on when it inserts." },
  add_validated_check: { compatibility: "requires_staging", message: "Adds a validated CHECK constraint that the previous release's writes could violate." },
  add_unique_constraint: { compatibility: "requires_staging", message: "Adds a UNIQUE or PRIMARY KEY constraint to an existing table that the previous release's writes could violate." },
  create_unique_index_existing_table: { compatibility: "requires_staging", message: "Adds a unique index to an existing table that the previous release's writes could violate." },
  drop_type: { compatibility: "requires_staging", message: "Drops a type the previous release may still use." },
  rename_type: { compatibility: "requires_staging", message: "Renames a type or enum value the previous release still uses." },
  truncate: { compatibility: "requires_staging", message: "Truncates a table the previous release is using." },
  delete_rows: { compatibility: "requires_staging", message: "Deletes rows from a table the previous release is using." },

  lock_hazard_create_index: { compatibility: "unknown", message: "Builds an index on an existing table without CONCURRENTLY, blocking writes for the whole build." },
  lock_hazard_validated_foreign_key: { compatibility: "unknown", message: "Adds a validated foreign key to an existing table, scanning it while writes are blocked. Add it NOT VALID instead." },
  lock_hazard_validate_constraint: { compatibility: "unknown", message: "Validates a constraint by scanning the whole table." },
  lock_hazard_set_not_null: { compatibility: "unknown", message: "Sets NOT NULL on a column added in this migration, scanning the table under an exclusive lock." },
  lock_hazard_table_rewrite: { compatibility: "unknown", message: "Adds a column whose default, identity, or generated expression rewrites the whole table under an exclusive lock." },
  lock_hazard_add_column_constraint: { compatibility: "unknown", message: "Adds a column with an inline constraint, which scans or indexes the table under an exclusive lock." },
  lock_hazard_data_backfill: { compatibility: "unknown", message: "Rewrites rows of an existing table; duration and row locks grow with table size, and the previous release keeps writing the old shape." },
  lock_hazard_copy_into_new_table: { compatibility: "unknown", message: "Copies rows from live tables into a new table; duration grows with the source while this migration's locks are held." },
  lock_hazard_lock_table: { compatibility: "unknown", message: "Takes an explicit table lock." },

  data_change_existing_table: { compatibility: "unknown", message: "Inserts rows into a table the previous release is using." },
  set_default: { compatibility: "unknown", message: "Changes the default the previous release receives when it inserts." },
  drop_constraint: { compatibility: "unknown", message: "Drops a constraint; the previous release may rely on it for upserts or cascades." },
  drop_index: { compatibility: "unknown", message: "Drops an index; the previous release may rely on it for upserts or for query speed." },
  drop_object: { compatibility: "unknown", message: "Drops a database object the previous release may depend on." },
  add_constraint_other: { compatibility: "unknown", message: "Adds a constraint the classifier cannot prove safe." },
  replace_function: { compatibility: "unknown", message: "Replaces a function, which can change behaviour the previous release depends on." },
  replace_view: { compatibility: "unknown", message: "Replaces or materializes a view." },
  create_trigger_existing_table: { compatibility: "unknown", message: "Adds a trigger to an existing table, changing what the previous release's writes do." },
  create_table_as: { compatibility: "unknown", message: "Creates a table from a query; its duration grows with the source tables." },
  do_block_procedural: { compatibility: "unknown", message: "Runs a procedural DO block the classifier does not interpret." },
  unrecognized_alter_table_action: { compatibility: "unknown", message: "Uses an ALTER TABLE action the classifier does not recognize." },
  unrecognized_statement: { compatibility: "unknown", message: "Uses a statement the classifier does not recognize." },
  no_statements: { compatibility: "unknown", message: "Contains no SQL statements." },
  invalid_override: { compatibility: "unknown", message: "Has a malformed migration-compat override." },
} as const satisfies Record<string, ReasonDefinition>;

export type MigrationCompatReasonCode = keyof typeof REASONS;

export const MIGRATION_COMPAT_REASON_CODES = Object.keys(REASONS) as MigrationCompatReasonCode[];

export type MigrationCompatReason = {
  readonly code: MigrationCompatReasonCode;
  readonly compatibility: MigrationCompatibility;
  readonly message: string;
  /** 1-based positions of the top-level statements that produced this reason. */
  readonly statements: readonly number[];
};

export type MigrationCompatOverride = {
  readonly compatibility: Exclude<MigrationCompatibility, "unknown">;
  readonly justification: string;
};

export type MigrationCompatResult = {
  /** The verdict a deployer acts on: the override when one is present and valid. */
  readonly compatibility: MigrationCompatibility;
  /** The classifier's own verdict, before any override. */
  readonly classified: MigrationCompatibility;
  readonly reasons: readonly MigrationCompatReason[];
  readonly override: MigrationCompatOverride | null;
  /** Set when the file carries an override directive that cannot be honoured. */
  readonly overrideError: string | null;
  /** True when a statement uses CONCURRENTLY, which cannot run in a transaction. */
  readonly usesConcurrently: boolean;
};

export type MigrationCompatOptions = {
  /**
   * Tables created by the migrations that apply before this one. Without it,
   * CREATE TABLE IF NOT EXISTS is never proof that a table is new.
   */
  readonly existingTables?: ReadonlySet<string>;
};

type Statement = {
  /** Lowercase, comments removed, literals masked as '?', dollar bodies as $?$. */
  readonly text: string;
  readonly dollarBodies: readonly string[];
};

type Context = {
  readonly existingTables: ReadonlySet<string> | null;
  readonly createdTables: Set<string>;
  readonly addedColumns: Set<string>;
};

const IDENT = String.raw`(?:"[^"]+"|[a-z_][a-z0-9_$]*)`;
const QUALIFIED = String.raw`(?:${IDENT}\.)?${IDENT}`;

function dollarTagAt(sql: string, index: number): string | null {
  const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index, index + 130));
  return match ? match[0] : null;
}

/** Splits SQL into statements and normalizes each for keyword matching. */
function parseStatements(sql: string): Statement[] {
  const statements: Statement[] = [];
  let text = "";
  let dollarBodies: string[] = [];
  const flush = () => {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized) statements.push({ text: normalized, dollarBodies });
    text = "";
    dollarBodies = [];
  };
  for (let i = 0; i < sql.length;) {
    const char = sql[i];
    const next = sql[i + 1];
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      const comment = sql.slice(i, end === -1 ? sql.length : end);
      // Drizzle's separator is a comment; it always ends a statement.
      if (/^-->\s*statement-breakpoint/.test(comment)) flush();
      else text += " ";
      i = end === -1 ? sql.length : end;
    } else if (char === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth += 1; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth -= 1; i += 2; }
        else i += 1;
      }
      text += " ";
    } else if (char === "'") {
      // E'...' strings escape quotes with a backslash.
      const escapes = /(?:^|[^a-z0-9_$])e$/.test(text);
      i += 1;
      while (i < sql.length) {
        if (escapes && sql[i] === "\\") i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") break;
        else i += 1;
      }
      i += 1;
      text += "'?'";
    } else if (char === '"') {
      // A doubled quote is a literal quote inside the identifier.
      let name = "";
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') { name += '"'; i += 2; }
        else if (sql[i] === '"') break;
        else { name += sql[i]; i += 1; }
      }
      i += 1;
      // Plain lowercase names are equivalent quoted or not. Any other name
      // stays quoted, with its own quotes encoded so it remains one token.
      text += /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll("%", "%25").replaceAll('"', "%22")}"`;
    } else if (char === "$" && dollarTagAt(sql, i)) {
      const tag = dollarTagAt(sql, i)!;
      const end = sql.indexOf(tag, i + tag.length);
      dollarBodies.push(sql.slice(i + tag.length, end === -1 ? sql.length : end));
      text += " $?$ ";
      i = end === -1 ? sql.length : end + tag.length;
    } else if (char === ";") {
      flush();
      i += 1;
    } else {
      text += char.toLowerCase();
      i += 1;
    }
  }
  flush();
  return statements;
}

function tableName(name: string): string {
  return name.replace(/^only /, "").replace(/^public\./, "");
}

/** Returns the index after the parenthesis group that opens at `start`, or -1. */
function closingParen(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// A default that PostgreSQL stores in the catalog without rewriting the table:
// a literal, or a non-volatile timestamp function.
const CONSTANT_DEFAULT = new RegExp(
  String.raw`^\(?(?:'\?'|-?\d+(?:\.\d+)?|true|false|null|now\(\)|current_timestamp|array\[\])\)?` +
  String.raw`(?:::[a-z_][a-z0-9_ ]*(?:\(\d+(?:, ?\d+)?\))?(?:\[\])?)*$`,
);

function classifyAddColumn(table: string, column: string, definition: string, context: Context): MigrationCompatReasonCode {
  if (/\bgenerated\b|\b(?:small|big)?serial\b/.test(definition)) return "lock_hazard_table_rewrite";
  if (/\b(?:references|unique|primary key|check|exclude)\b/.test(definition)) return "lock_hazard_add_column_constraint";
  const notNull = /\bnot null\b/.test(definition);
  const defaultMatch = /\bdefault (.+?)(?: not null| null)?$/.exec(definition);
  if (defaultMatch && !CONSTANT_DEFAULT.test(defaultMatch[1].trim())) return "lock_hazard_table_rewrite";
  if (notNull && !defaultMatch) return "add_not_null_column_without_default";
  context.addedColumns.add(`${table}.${column}`);
  return "add_column";
}

function classifyAlterTableAction(table: string, action: string, context: Context): MigrationCompatReasonCode {
  let match: RegExpExecArray | null;
  if ((match = new RegExp(String.raw`^add (?:constraint ${IDENT} )?(foreign key|check|unique|primary key|exclude)\b(.*)$`).exec(action))) {
    if (/\bnot valid$/.test(match[2])) return "add_constraint_not_valid";
    if (match[1] === "foreign key") return "lock_hazard_validated_foreign_key";
    if (match[1] === "check") return "add_validated_check";
    if (match[1] === "exclude" || /\busing index\b/.test(match[2])) return "add_constraint_other";
    return "add_unique_constraint";
  }
  if (/^add constraint\b/.test(action)) return "add_constraint_other";
  if ((match = new RegExp(String.raw`^add (?:column )?(?:if not exists )?(${IDENT}) (.+)$`).exec(action))) {
    return classifyAddColumn(table, match[1], match[2], context);
  }
  if (/^drop constraint\b/.test(action)) return "drop_constraint";
  if (/^drop\b/.test(action)) return "drop_column";
  if (/^rename constraint\b/.test(action)) return "unrecognized_alter_table_action";
  if (/^rename to\b/.test(action)) return "rename_table";
  if (/^rename\b/.test(action)) return "rename_column";
  if (/^validate constraint\b/.test(action)) return "lock_hazard_validate_constraint";
  if ((match = new RegExp(String.raw`^alter (?:column )?(${IDENT}) (.+)$`).exec(action))) {
    const change = match[2];
    if (/^(?:set data )?type\b/.test(change)) return "alter_column_type";
    if (change === "set not null") {
      return context.addedColumns.has(`${table}.${match[1]}`) ? "lock_hazard_set_not_null" : "set_not_null";
    }
    if (change === "drop not null") return "drop_not_null";
    if (/^set default\b/.test(change)) return "set_default";
    if (change === "drop default") return "drop_default";
  }
  return "unrecognized_alter_table_action";
}

function classifyDoBlock(statement: Statement, context: Context, nested: boolean): MigrationCompatReasonCode[] {
  if (nested || statement.dollarBodies.length !== 1 || !/^do (?:language plpgsql )?\$\?\$(?: language plpgsql)?$/.test(statement.text)) {
    return ["do_block_procedural"];
  }
  const pieces = parseStatements(statement.dollarBodies[0]);
  const procedural = pieces.length === 0 || !/^begin\b/.test(pieces[0].text) ||
    pieces.some((piece) => /^(?:begin )?(?:declare|loop|for|foreach|while|execute|perform|raise|return|else|elsif)\b/.test(piece.text) ||
      /(?:^| )then (?:execute|perform|raise|return|loop|for|foreach|while)\b/.test(piece.text));
  if (procedural) {
    const codes: MigrationCompatReasonCode[] = ["do_block_procedural"];
    if (pieces.some((piece) => /\b(?:update|insert into|delete from)\b/.test(piece.text))) codes.push("lock_hazard_data_backfill");
    return codes;
  }

  // What remains is a guarded sequence: BEGIN <sql>; ... [EXCEPTION WHEN ...
  // THEN NULL;] END, where <sql> may sit inside IF [NOT] EXISTS (...) THEN ...
  // END IF. A guard only makes a statement conditional, so the statement is
  // classified as if it always runs.
  const codes: MigrationCompatReasonCode[] = [];
  let depth = 0;
  let closed = false;
  for (let index = 0; index < pieces.length; index += 1) {
    let text = pieces[index].text;
    if (index === 0) text = text.replace(/^begin\b ?/, "");
    if (closed) return ["do_block_procedural"];
    while (/^if\b/.test(text)) {
      let conditionEnd = -1;
      const exists = /^if (?:not )?exists ?\(/.exec(text);
      const regclass = /^if to_regclass\('\?'\) is (?:not )?null/.exec(text);
      if (exists) conditionEnd = closingParen(text, exists[0].length - 1);
      else if (regclass) conditionEnd = regclass[0].length;
      if (conditionEnd === -1 || !text.slice(conditionEnd).startsWith(" then ")) return ["do_block_procedural"];
      text = text.slice(conditionEnd + " then ".length);
      depth += 1;
    }
    if (text === "" || text === "null") continue;
    if (text === "end if") {
      depth -= 1;
      if (depth < 0) return ["do_block_procedural"];
    } else if (text === "end") {
      if (depth !== 0 || index !== pieces.length - 1) return ["do_block_procedural"];
      closed = true;
    } else if (/^exception when [a-z_ ]+ then null$/.test(text)) {
      if (depth !== 0) return ["do_block_procedural"];
    } else {
      codes.push(...classifyStatement({ text, dollarBodies: pieces[index].dollarBodies }, context, true));
    }
  }
  if (!closed || codes.length === 0) return ["do_block_procedural"];
  return codes;
}

function classifyStatement(statement: Statement, context: Context, nested = false): MigrationCompatReasonCode[] {
  const text = statement.text;
  const isNew = (name: string) => context.createdTables.has(tableName(name));
  let match: RegExpExecArray | null;

  if (/^do\b/.test(text)) return classifyDoBlock(statement, context, nested);

  if ((match = new RegExp(String.raw`^create (?:(?:global |local )?(temp|temporary) |unlogged )?table (if not exists )?(${QUALIFIED})(.*)$`).exec(text))) {
    const temporary = Boolean(match[1]);
    const name = tableName(match[3]);
    // Plain CREATE TABLE fails when the table exists, and a temporary table
    // belongs to this session. IF NOT EXISTS proves nothing by itself: the
    // table is new only when no earlier migration created it.
    const provenNew = temporary || !match[2] || (context.existingTables !== null && !context.existingTables.has(name));
    let rest = match[4].trim();
    if (rest.startsWith("(")) {
      const end = closingParen(rest, 0);
      rest = end === -1 ? rest : rest.slice(end);
    }
    if (/\b(?:partition of|inherits|like)\b/.test(rest)) return ["unrecognized_statement"];
    if (/\bas (?:select|with|values|table)\b/.test(rest)) {
      // A temporary copy only reads; it is still registered as migration-owned.
      if (temporary) context.createdTables.add(name);
      return ["create_table_as"];
    }
    if (!provenNew) return ["create_table_if_not_exists"];
    context.createdTables.add(name);
    return [temporary ? "create_temp_table" : "create_table"];
  }

  if ((match = new RegExp(String.raw`^create (unique )?index (concurrently )?(?:if not exists )?(?:${IDENT} )?on (?:only )?(${QUALIFIED})[ (]`).exec(text))) {
    if (isNew(match[3])) return ["create_index_new_table"];
    if (match[1]) return ["create_unique_index_existing_table"];
    return [match[2] ? "create_index_concurrently" : "lock_hazard_create_index"];
  }

  if ((match = new RegExp(String.raw`^alter table (?:if exists )?(?:only )?(${QUALIFIED}) (.+)$`).exec(text))) {
    if (isNew(match[1])) return ["alter_new_table"];
    const table = tableName(match[1]);
    return splitTopLevelCommas(match[2]).map((action) => classifyAlterTableAction(table, action, context));
  }

  if ((match = new RegExp(String.raw`^drop table (?:if exists )?(.+?)(?: cascade| restrict)?$`).exec(text))) {
    return splitTopLevelCommas(match[1]).every(isNew) ? ["alter_new_table"] : ["drop_table"];
  }
  if (/^drop index\b/.test(text)) return ["drop_index"];
  if (/^drop (?:type|domain)\b/.test(text)) return ["drop_type"];
  if (/^drop\b/.test(text)) return ["drop_object"];
  if (/^truncate\b/.test(text)) return ["truncate"];

  if ((match = new RegExp(String.raw`^delete from (?:only )?(${QUALIFIED})\b`).exec(text))) {
    return [isNew(match[1]) ? "seed_new_table" : "delete_rows"];
  }
  if ((match = new RegExp(String.raw`^update (?:only )?(${QUALIFIED})\b`).exec(text))) {
    return [isNew(match[1]) ? "seed_new_table" : "lock_hazard_data_backfill"];
  }
  if ((match = new RegExp(String.raw`^insert into (${QUALIFIED})\b(.*)$`).exec(text))) {
    if (!isNew(match[1])) return ["data_change_existing_table"];
    // Copying from live tables can run long while this migration's locks are held.
    return [/\b(?:select|with|table)\b/.test(match[2]) ? "lock_hazard_copy_into_new_table" : "seed_new_table"];
  }
  if (/^with\b/.test(text)) {
    if (/\bdelete from\b/.test(text)) return ["delete_rows"];
    if (/\b(?:update|insert into)\b/.test(text)) return ["lock_hazard_data_backfill"];
    return ["unrecognized_statement"];
  }

  if (/^create type\b/.test(text)) return ["create_type"];
  if (new RegExp(String.raw`^alter type ${QUALIFIED} add value\b`).test(text)) return ["add_enum_value"];
  if (new RegExp(String.raw`^alter type ${QUALIFIED} rename\b`).test(text)) return ["rename_type"];
  if (/^create (?:temp |temporary )?sequence\b/.test(text)) return ["create_sequence"];
  if (/^create extension\b/.test(text)) return ["create_extension"];
  if (/^create (?:function|procedure)\b/.test(text)) return ["create_function"];
  if (/^create or replace (?:function|procedure)\b/.test(text)) return ["replace_function"];
  if (/^create (?:temp |temporary )?view\b/.test(text)) return ["create_view"];
  if (/^create (?:or replace |materialized )(?:temp |temporary )?view\b/.test(text)) return ["replace_view"];
  if ((match = new RegExp(String.raw`^create (?:or replace )?(?:constraint )?trigger ${IDENT} .*? on (?:only )?(${QUALIFIED})\b`).exec(text))) {
    return [isNew(match[1]) && !/^create or replace\b/.test(text) ? "create_trigger_new_table" : "create_trigger_existing_table"];
  }
  if (/^comment on\b/.test(text)) return ["comment"];
  if (/^create statistics\b/.test(text)) return ["create_statistics"];
  if (/^analyze\b/.test(text)) return ["analyze"];
  if (text === "select 1") return ["no_op"];
  if (/^lock (?:table )?/.test(text)) return ["lock_hazard_lock_table"];
  return ["unrecognized_statement"];
}

function worst(values: readonly MigrationCompatibility[]): MigrationCompatibility {
  if (values.includes("requires_staging")) return "requires_staging";
  if (values.includes("unknown")) return "unknown";
  return "online_compatible";
}

type OverrideParse = { readonly override: MigrationCompatOverride | null; readonly error: string | null };

/**
 * Reads the override directive from the migration file's leading comment block.
 * Nothing outside the file can supply or change an override.
 */
export function parseMigrationCompatOverride(sql: string): OverrideParse {
  const lines = sql.split(/\r?\n/);
  const directive = new RegExp(String.raw`^\s*--\s*${MIGRATION_COMPAT_DIRECTIVE}(?![\w-])(.*)$`);
  const found: string[] = [];
  let leading = true;
  let misplaced = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (leading && trimmed !== "" && (!trimmed.startsWith("--") || trimmed.startsWith("-->"))) leading = false;
    if (!line.includes(MIGRATION_COMPAT_DIRECTIVE)) continue;
    const match = leading ? directive.exec(line) : null;
    if (match) found.push(match[1]);
    else misplaced = true;
  }
  const usage = `Write it as the file's first lines: "-- ${MIGRATION_COMPAT_DIRECTIVE} online_compatible: <why this is safe>" (or requires_staging).`;
  if (misplaced) return { override: null, error: `The ${MIGRATION_COMPAT_DIRECTIVE} directive must be a "--" comment in the leading comment block, before any SQL. ${usage}` };
  if (found.length === 0) return { override: null, error: null };
  if (found.length > 1) return { override: null, error: `The file has more than one ${MIGRATION_COMPAT_DIRECTIVE} directive. ${usage}` };
  const match = /^\s+([a-z_]+)\s*(?::\s*(.*))?$/.exec(found[0]);
  const compatibility = match?.[1];
  if (!match || (compatibility !== "online_compatible" && compatibility !== "requires_staging")) {
    return { override: null, error: `The ${MIGRATION_COMPAT_DIRECTIVE} directive must name online_compatible or requires_staging. ${usage}` };
  }
  const justification = (match[2] ?? "").trim();
  if (justification.length < MIGRATION_COMPAT_MIN_JUSTIFICATION_LENGTH) {
    return { override: null, error: `The ${MIGRATION_COMPAT_DIRECTIVE} directive needs a justification of at least ${MIGRATION_COMPAT_MIN_JUSTIFICATION_LENGTH} characters after the colon. ${usage}` };
  }
  return { override: { compatibility, justification }, error: null };
}

/**
 * Decides whether a migration can be applied while the previous release's app
 * code is still reading and writing the database, without breaking that code
 * and without long blocking locks. Anything the classifier does not positively
 * recognize is `unknown`.
 */
export function classifyMigrationSql(sql: string, options: MigrationCompatOptions = {}): MigrationCompatResult {
  const context: Context = { existingTables: options.existingTables ?? null, createdTables: new Set(), addedColumns: new Set() };
  const statementsByCode = new Map<MigrationCompatReasonCode, number[]>();
  const record = (code: MigrationCompatReasonCode, position: number) => {
    const positions = statementsByCode.get(code) ?? [];
    if (!positions.includes(position)) positions.push(position);
    statementsByCode.set(code, positions);
  };

  const statements = parseStatements(sql);
  if (statements.length === 0) record("no_statements", 0);
  statements.forEach((statement, index) => {
    for (const code of classifyStatement(statement, context)) record(code, index + 1);
  });
  const { override, error } = parseMigrationCompatOverride(sql);
  if (error) record("invalid_override", 0);

  const reasons: MigrationCompatReason[] = [...statementsByCode].map(([code, positions]) => ({
    code,
    compatibility: REASONS[code].compatibility,
    message: code === "invalid_override" && error ? error : REASONS[code].message,
    statements: positions.filter((position) => position > 0),
  }));
  const classified = worst(reasons.filter((reason) => reason.code !== "invalid_override").map((reason) => reason.compatibility));
  return {
    compatibility: override ? override.compatibility : worst(reasons.map((reason) => reason.compatibility)),
    classified,
    reasons,
    override,
    overrideError: error,
    usesConcurrently: statements.some((statement) => /\bconcurrently\b/.test(statement.text)),
  };
}

/** Names of the tables a migration creates or renames to, including inside DO blocks. */
export function collectCreatedTables(sql: string): string[] {
  const names: string[] = [];
  const created = new RegExp(String.raw`\bcreate (?:unlogged )?table (?:if not exists )?(${QUALIFIED})`, "g");
  const renamed = new RegExp(String.raw`\brename to (${IDENT})`, "g");
  const visit = (statements: Statement[]) => {
    for (const statement of statements) {
      for (const match of statement.text.matchAll(created)) names.push(tableName(match[1]));
      for (const match of statement.text.matchAll(renamed)) names.push(tableName(match[1]));
      for (const body of statement.dollarBodies) visit(parseStatements(body));
    }
  };
  visit(parseStatements(sql));
  return names;
}

/**
 * Classifies migrations in apply order. Each one is judged knowing the tables
 * that `priorSql` and the earlier entries of `sqls` created.
 */
export function classifyMigrationSequence(sqls: readonly string[], priorSql: readonly string[] = []): MigrationCompatResult[] {
  const existingTables = new Set<string>(priorSql.flatMap(collectCreatedTables));
  return sqls.map((sql) => {
    const result = classifyMigrationSql(sql, { existingTables });
    for (const table of collectCreatedTables(sql)) existingTables.add(table);
    return result;
  });
}

/**
 * Reads, from the source of packages/db/src/client.ts, the migration files the
 * migrator runs outside a transaction. Returns null when the list is not found.
 */
export function parseNonTransactionalMigrations(executorSource: string): Set<string> | null {
  const match = /MIGRATIONS_WITH_TOP_LEVEL_STATEMENTS\s*=\s*new Set(?:<[^>]*>)?\(\[([\s\S]*?)\]\)/.exec(executorSource);
  if (!match) return null;
  return new Set([...match[1].matchAll(/"([^"]+\.sql)"/g)].map((entry) => entry[1]));
}

export type MigrationCompatInput = { readonly fileName: string; readonly sql: string };

export type MigrationCompatGuardResult = {
  readonly passed: boolean;
  /** One entry per migration that blocks the pull request. */
  readonly errors: readonly string[];
  /** Informational lines: staged migrations and accepted overrides. */
  readonly notices: readonly string[];
  readonly results: readonly { readonly fileName: string; readonly result: MigrationCompatResult }[];
};

function describeReasons(result: MigrationCompatResult, compatibility: MigrationCompatibility): string[] {
  return result.reasons
    .filter((reason) => reason.compatibility === compatibility)
    .map((reason) => `    - ${reason.code}${reason.statements.length ? ` (statement ${reason.statements.join(", ")})` : ""}: ${reason.message}`);
}

export type MigrationCompatGuardOptions = {
  /**
   * SQL of every migration that applies before the new ones. Without it,
   * CREATE TABLE IF NOT EXISTS never counts as creating a new table.
   */
  readonly priorMigrationSql?: readonly string[];
  /**
   * File names the migrator runs outside a transaction (see
   * parseNonTransactionalMigrations). When given, a new migration that uses
   * CONCURRENTLY must be in it.
   */
  readonly nonTransactionalMigrations?: ReadonlySet<string>;
};

/**
 * The pull-request guard for migrations a change adds, in apply order.
 * `unknown` without a valid override fails. `requires_staging` passes with a
 * notice until deployers enforce staging.
 */
export function checkNewMigrationCompatibility(
  migrations: readonly MigrationCompatInput[],
  options: MigrationCompatGuardOptions = {},
): MigrationCompatGuardResult {
  const errors: string[] = [];
  const notices: string[] = [];
  const sqls = migrations.map((migration) => migration.sql);
  const classified = options.priorMigrationSql
    ? classifyMigrationSequence(sqls, options.priorMigrationSql)
    : sqls.map((sql) => classifyMigrationSql(sql));
  const results = migrations.map(({ fileName }, index) => ({ fileName, result: classified[index] }));
  for (const { fileName, result } of results) {
    const baseName = fileName.split("/").pop() ?? fileName;
    if (result.usesConcurrently && options.nonTransactionalMigrations && !options.nonTransactionalMigrations.has(baseName)) {
      errors.push([
        `${fileName}: uses CONCURRENTLY, which PostgreSQL rejects inside a transaction, and the migrator runs each file in one transaction.`,
        `  Add "${baseName}" to MIGRATIONS_WITH_TOP_LEVEL_STATEMENTS in packages/db/src/client.ts.`,
        "  Make every statement in the file idempotent (IF NOT EXISTS), because a failed run starts again from the first statement.",
      ].join("\n"));
    }
    if (result.overrideError) {
      errors.push(`${fileName}: ${result.overrideError}`);
    } else if (result.compatibility === "unknown") {
      errors.push([
        `${fileName}: cannot tell whether this migration is safe to apply while the previous release is still running.`,
        ...describeReasons(result, "unknown"),
        "  Do one of the following:",
        "    1. Rewrite it so every statement is recognized as compatible, for example CREATE INDEX CONCURRENTLY,",
        "       ADD CONSTRAINT ... NOT VALID, or a nullable column or constant default.",
        "    2. Split it into an expand migration now and a contract migration in a later release.",
        "    3. If you have verified it yourself, make these the first lines of the file:",
        `         -- ${MIGRATION_COMPAT_DIRECTIVE} online_compatible: <why the previous release keeps working and no lock is held long>`,
        `       or, if the previous release cannot run against it:`,
        `         -- ${MIGRATION_COMPAT_DIRECTIVE} requires_staging: <what has to ship first>`,
        "  See \"Migration compatibility with the running release\" in doc/DATABASE.md.",
      ].join("\n"));
    } else if (result.compatibility === "requires_staging") {
      notices.push([
        `${fileName}: requires_staging. The previous release cannot keep running against this migration, so a deployer that may not pause will hold it back.`,
        ...(result.override ? [`    - override: ${result.override.justification}`] : describeReasons(result, "requires_staging")),
        "  This does not fail the check yet. Prefer an expand migration now and the contract migration in a later release.",
      ].join("\n"));
    } else if (result.override) {
      notices.push(`${fileName}: online_compatible by override (classifier said ${result.classified}): ${result.override.justification}`);
    }
  }
  return { passed: errors.length === 0, errors, notices, results };
}

export type MigrationCompatSummary = {
  readonly total: number;
  readonly byCompatibility: Record<MigrationCompatibility, number>;
  readonly overrides: number;
  /** Migrations per blocking reason code, most frequent first. */
  readonly blockingReasons: readonly { readonly code: MigrationCompatReasonCode; readonly compatibility: MigrationCompatibility; readonly migrations: number }[];
};

export function summarizeMigrationCompatibility(results: readonly MigrationCompatResult[]): MigrationCompatSummary {
  const byCompatibility: Record<MigrationCompatibility, number> = { online_compatible: 0, requires_staging: 0, unknown: 0 };
  const counts = new Map<MigrationCompatReasonCode, number>();
  for (const result of results) {
    byCompatibility[result.compatibility] += 1;
    for (const reason of result.reasons) {
      if (reason.compatibility !== "online_compatible") counts.set(reason.code, (counts.get(reason.code) ?? 0) + 1);
    }
  }
  return {
    total: results.length,
    byCompatibility,
    overrides: results.filter((result) => result.override).length,
    blockingReasons: [...counts]
      .map(([code, migrations]) => ({ code, compatibility: REASONS[code].compatibility, migrations }))
      .sort((left, right) => right.migrations - left.migrations || left.code.localeCompare(right.code)),
  };
}
