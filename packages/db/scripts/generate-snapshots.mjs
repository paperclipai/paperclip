#!/usr/bin/env node
/**
 * Generate missing Drizzle migration snapshots (0099-0134).
 *
 * 1. Applies 0099 migration schema changes to the stale 0099 snapshot baseline
 * 2. For each migration 0100-0134, parses the SQL, applies schema changes
 *    to the running snapshot, and writes the new snapshot in Drizzle Kit format.
 *
 * Usage: node scripts/generate-snapshots.mjs
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const META_DIR = join(__dirname, '..', 'src', 'migrations', 'meta');
const MIGRATIONS_DIR = join(__dirname, '..', 'src', 'migrations');

// ============================================================
// 1. Utility helpers
// ============================================================

function makeId() {
  return randomUUID();
}

function loadSnapshot(idx) {
  const prefix = String(idx).padStart(4, '0');
  return JSON.parse(readFileSync(join(META_DIR, `${prefix}_snapshot.json`), 'utf-8'));
}

function loadAllMigrationSql(from, to) {
  const entries = readdirSync(MIGRATIONS_DIR).filter(e => e.endsWith('.sql')).sort();
  const sqls = {};
  for (const entry of entries) {
    const m = entry.match(/^(\d{4})_/);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    if (idx >= from && idx <= to) {
      sqls[idx] = readFileSync(join(MIGRATIONS_DIR, entry), 'utf-8');
    }
  }
  return sqls;
}

function tableKey(name) {
  return name.includes('.') ? name : `public.${name}`;
}

// ============================================================
// 2. SQL type → Drizzle type normalisation
// ============================================================

function mapDrizzleType(raw) {
  const t = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (t === 'uuid') return 'uuid';
  if (t === 'text' || t.startsWith('varchar')) return 'text';
  if (t === 'integer' || t === 'int' || t === 'int4') return 'integer';
  if (t === 'bigint' || t === 'int8') return 'bigint';
  if (t === 'bigserial' || t === 'serial8') return 'bigserial';
  if (t === 'smallint' || t === 'smallserial' || t === 'serial2') return 'smallint';
  if (t === 'serial' || t === 'serial4') return 'serial';
  if (t === 'boolean' || t === 'bool') return 'boolean';
  if (t === 'double precision' || t === 'float8' || t.startsWith('float(')) return 'double precision';
  if (t === 'real' || t === 'float4') return 'real';
  if (t === 'date') return 'date';
  if (t.startsWith('timestamp')) return 'timestamp with time zone';
  if (t.startsWith('jsonb')) return 'jsonb';
  if (t === 'json') return 'json';
  if (t === 'text[]') return 'text[]';
  if (t.startsWith('vector')) return 'vector(1536)';
  if (t.startsWith('numeric') || t.startsWith('decimal')) return 'numeric';
  return raw.trim();
}

// ============================================================
// 3. Default value parser
// ============================================================

function parseDefault(val) {
  if (!val || val.trim().toUpperCase() === 'NULL') return undefined;
  const d = val.trim();
  if (d.startsWith("'") && d.endsWith("'") && !d.includes('::')) {
    return `'${d.slice(1, -1).replace(/'/g, "\\'")}'`;
  }
  if (d.toUpperCase() === 'TRUE') return 'true';
  if (d.toUpperCase() === 'FALSE') return 'false';
  if (/^-?\d+(\.\d+)?$/.test(d)) return d;
  if (d.toLowerCase().includes('gen_random_uuid()')) return 'gen_random_uuid()';
  if (d.toLowerCase() === 'now()') return 'now()';
  const jsonbM = d.match(/^(.+)::jsonb\s*$/i);
  if (jsonbM) return jsonbM[1].trim() + '::jsonb';
  const castM = d.match(/^(.+)::(\w+)\s*$/i);
  if (castM) return castM[1].trim() + '::' + castM[2].trim();
  if (d.includes("'")) return d;
  return d;
}

// ============================================================
// 4. Column definition parser
// ============================================================

function parseColumnDef(sql) {
  const m = sql.match(/^"([^"]+)"\s+(.+)$/s);
  if (!m) return null;
  const name = m[1];
  let rest = m[2].trim();
  const typeRe = /^([a-zA-Z_][\w.]*(?:\s*\([^)]*\))?)(.*)$/s;
  const tMatch = rest.match(typeRe);
  if (!tMatch) return null;
  const type = mapDrizzleType(tMatch[1].trim());
  const constraints = tMatch[2];
  const col = { name, type, primaryKey: false, notNull: false };
  if (/primary\s+key/i.test(constraints)) col.primaryKey = true;
  if (/not\s+null/i.test(constraints)) col.notNull = true;
  const defM = constraints.match(/DEFAULT\s+('(?:[^']|'')*'|[^\s,)]+?)(?:\s+(?:NOT\s+NULL|PRIMARY\s+KEY|REFERENCES|UNIQUE|CHECK|CONSTRAINT)\s|$|,\s*$)/i);
  if (defM) {
    const dv = parseDefault(defM[1].trim());
    if (dv !== undefined) col.default = dv;
  }
  return col;
}

// ============================================================
// 5. Extract content between balanced parens
// ============================================================

function extractParens(sql, startPos) {
  let depth = 0, start = -1;
  for (let i = startPos; i < sql.length; i++) {
    if (sql[i] === '(') { if (depth === 0) start = i; depth++; }
    else if (sql[i] === ')') { depth--; if (depth === 0) return sql.substring(start + 1, i); }
  }
  return '';
}

function splitTopLevel(body) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// ============================================================
// 6. CREATE TABLE parser
// ============================================================

function parseCreateTable(sql) {
  const m = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|(\w+))\s*\(/i);
  if (!m) return null;
  const tableName = m[1] || m[2];
  const key = tableKey(tableName);
  const parenStart = sql.indexOf('(', m.index + m[0].length - 1);
  if (parenStart === -1) return null;
  const body = extractParens(sql, parenStart);
  const defs = splitTopLevel(body);
  const columns = {};
  const indexes = {};
  const foreignKeys = {};
  const compositePrimaryKeys = {};
  const uniqueConstraints = {};
  const checkConstraints = {};

  for (const raw of defs) {
    const d = raw.trim();
    if (!d) continue;

    if (/^CONSTRAINT\s+"([^"]+)"\s+FOREIGN\s+KEY/i.test(d)) {
      const cM = d.match(/^CONSTRAINT\s+"([^"]+)"\s+/i);
      const fk = parseInlineForeignKey(d, tableName);
      if (fk) { fk.name = cM[1]; foreignKeys[cM[1]] = fk; }
      continue;
    }
    if (/^CONSTRAINT\s+"([^"]+)"\s+UNIQUE/i.test(d)) {
      const cM = d.match(/^CONSTRAINT\s+"([^"]+)"\s+/i);
      const ukCols = d.match(/UNIQUE\s*\(([^)]+)\)/i);
      if (ukCols) {
        uniqueConstraints[cM[1]] = {
          name: cM[1], columns: ukCols[1].split(',').map(c => c.trim().replace(/"/g, '')), nullsNotDistinct: false,
        };
      }
      continue;
    }
    if (/^CONSTRAINT\s+"([^"]+)"\s+CHECK/i.test(d)) {
      const cM = d.match(/^CONSTRAINT\s+"([^"]+)"\s+/i);
      const checkExpr = d.indexOf('CHECK');
      const openParen = d.indexOf('(', checkExpr);
      checkConstraints[cM[1]] = { name: cM[1], value: extractParens(d, openParen).trim() };
      continue;
    }
    if (/^PRIMARY\s+KEY/i.test(d)) {
      const pkM = d.match(/PRIMARY\s+KEY\s*\(([^)]+)\)/i);
      if (pkM) {
        const pkName = `${tableName}_pkey`;
        compositePrimaryKeys[pkName] = { name: pkName, columns: pkM[1].split(',').map(c => c.trim().replace(/"/g, '')) };
      }
      continue;
    }
    if (/^UNIQUE/i.test(d)) {
      const ukM = d.match(/UNIQUE\s*\(([^)]+)\)/i);
      if (ukM) {
        const ukName = `${tableName}_${ukM[1].replace(/[^a-z0-9_]/gi, '_').replace(/_{2,}/g, '_')}_uq`;
        uniqueConstraints[ukName] = { name: ukName, columns: ukM[1].split(',').map(c => c.trim().replace(/"/g, '')), nullsNotDistinct: false };
      }
      continue;
    }

    const col = parseColumnDef(d);
    if (col) {
      columns[col.name] = col;
      const refM = d.match(/REFERENCES\s+(?:"?public"?\.)?"?([^"(\s]+)"?\s*\(([^)]+)\)/i);
      if (refM) {
        const refTable = refM[1], refCol = refM[2].replace(/"/g, '').trim();
        const fkName = `${tableName}_${col.name}_${refTable}_${refCol}_fk`;
        const fk = {
          name: fkName, tableFrom: tableName, tableTo: refTable,
          columnsFrom: [col.name], columnsTo: [refCol],
          onDelete: 'no action', onUpdate: 'no action',
        };
        const onDelM = d.match(/ON\s+DELETE\s+(\w+(?:\s+\w+)?)/i);
        if (onDelM) fk.onDelete = onDelM[1].toLowerCase();
        const onUpdM = d.match(/ON\s+UPDATE\s+(\w+(?:\s+\w+)?)/i);
        if (onUpdM) fk.onUpdate = onUpdM[1].toLowerCase();
        foreignKeys[fkName] = fk;
      }
    }
  }

  return {
    key,
    table: {
      name: tableName, schema: '',
      columns, indexes, foreignKeys,
      compositePrimaryKeys, uniqueConstraints,
      policies: {}, checkConstraints, isRLSEnabled: false,
    },
  };
}

// ============================================================
// 7. Parse inline FOREIGN KEY
// ============================================================

function parseInlineForeignKey(sql, tableName) {
  const m = sql.match(/FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+(?:"?public"?\.)?"?([^"(\s]+)"?\s*\(([^)]+)\)/i);
  if (!m) return null;
  const fk = {
    name: '', tableFrom: tableName, tableTo: m[2],
    columnsFrom: m[1].split(',').map(c => c.trim().replace(/"/g, '')),
    columnsTo: m[3].split(',').map(c => c.trim().replace(/"/g, '')),
    onDelete: 'no action', onUpdate: 'no action',
  };
  const onDelM = sql.match(/ON\s+DELETE\s+(\w+(?:\s+\w+)?)/i);
  if (onDelM) fk.onDelete = onDelM[1].toLowerCase();
  const onUpdM = sql.match(/ON\s+UPDATE\s+(\w+(?:\s+\w+)?)/i);
  if (onUpdM) fk.onUpdate = onUpdM[1].toLowerCase();
  return fk;
}

// ============================================================
// 8. ALTER TABLE statements
// ============================================================

function parseAlterTableAddColumn(sql) {
  const m = sql.match(/ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(.+)/i);
  if (!m) return null;
  const col = parseColumnDef(m[2].trim());
  return col ? { table: m[1], column: col } : null;
}

function parseAlterTableAlterColumn(sql) {
  const m = sql.match(/ALTER\s+TABLE\s+"([^"]+)"\s+ALTER\s+COLUMN\s+"([^"]+)"\s+(.+)/i);
  if (!m) return null;
  const tbl = m[1], col = m[2], action = m[3].trim();
  if (/^SET\s+DEFAULT\s+/i.test(action)) {
    const defVal = action.substring('SET DEFAULT'.length).trim();
    return { table: tbl, column: col, op: 'set_default', default: parseDefault(defVal) };
  }
  if (/^SET\s+NOT\s+NULL/i.test(action)) return { table: tbl, column: col, op: 'set_not_null' };
  if (/^DROP\s+NOT\s+NULL/i.test(action) || /^DROP\s+NOTNULL/i.test(action)) return { table: tbl, column: col, op: 'drop_not_null' };
  if (/^DROP\s+DEFAULT/i.test(action)) return { table: tbl, column: col, op: 'drop_default' };
  return null;
}

function parseAlterTableDropColumn(sql) {
  const m = sql.match(/ALTER\s+TABLE\s+"([^"]+)"\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(\S+)/i);
  if (!m) return null;
  return { table: m[1], column: m[2].replace(/"/g, '') };
}

function parseAlterTableAddConstraint(sql) {
  const m = sql.match(/ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+CONSTRAINT\s+"([^"]+)"\s+([\s\S]+)$/i);
  if (!m) return null;
  const tableName = m[1], constraintName = m[2], def = m[3];
  if (/FOREIGN\s+KEY/i.test(def)) {
    const fk = parseInlineForeignKey(def, tableName);
    if (fk) { fk.name = constraintName; return { table: tableName, type: 'foreign_key', constraint: fk }; }
  }
  if (/CHECK\s*\(/i.test(def)) {
    const openParen = def.indexOf('(');
    const expr = extractParens(def, openParen);
    return { table: tableName, type: 'check', name: constraintName, value: expr.trim() };
  }
  if (/UNIQUE/i.test(def)) {
    return { table: tableName, type: 'unique', name: constraintName };
  }
  return null;
}

function parseAlterTableDropConstraint(sql) {
  const m = sql.match(/ALTER\s+TABLE\s+"([^"]+)"\s+DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"([^"]+)"/i);
  if (!m) return null;
  return { table: m[1], constraint: m[2] };
}

// ============================================================
// 9. CREATE INDEX — handles partial, expression, operator-class, WITH
// ============================================================

function parseCreateIndex(sql) {
  const m = sql.match(
    /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)")\s+ON\s+(?:"?([^"(\s]+)"?)\s*(?:USING\s+(\w+))?\s*\(([\s\S]+)$/i
  );
  if (!m) return null;

  const isUnique = !!m[1], indexName = m[2], tableName = m[3];
  const method = (m[4] || 'btree').toLowerCase();
  const tail = m[5].trim();

  // Find the closing paren of the column list (balanced parens)
  const parenEnd = findMatchingParen(tail, 0);
  if (parenEnd === -1) return null;

  const columnsRaw = tail.substring(0, parenEnd);
  let rest = tail.substring(parenEnd + 1).trim();

  // Parse WITH params
  const withParams = {};
  const withM = rest.match(/WITH\s*\(([^)]+)\)/i);
  if (withM) {
    withM[1].split(',').forEach(p => {
      const [k, v] = p.trim().split(/\s*=\s*/);
      if (k) withParams[k.trim()] = v ? parseInt(v.trim(), 10) || v.trim() : true;
    });
    rest = rest.replace(withM[0], '');
  }

  // Parse WHERE clause
  let where = undefined;
  const wM = rest.match(/WHERE\s+([\s\S]+)$/i);
  if (wM) where = normalizeWhereClause(wM[1].trim(), tableName);

  // Parse columns
  const cols = splitTopLevel(columnsRaw);
  const columns = cols.map(c => {
    const colStr = c.trim();
    const dirM = colStr.match(/^"?([^"\s]+)"?\s*(ASC|DESC)?\s*(NULLS\s+(FIRST|LAST))?$/i);
    if (dirM && dirM[1].match(/^[a-z_][a-z0-9_]*$/i) && !dirM[3]) {
      return {
        expression: dirM[1].replace(/"/g, ''),
        isExpression: false,
        asc: !dirM[2] || dirM[2].toUpperCase() === 'ASC',
        nulls: dirM[3] && dirM[3].toUpperCase().includes('LAST') ? 'last' : 'last',
      };
    }
    // Expression index (functional, operator class, etc.)
    return {
      expression: colStr,
      isExpression: true,
      asc: true,
      nulls: 'last',
    };
  });

  return {
    table: tableName,
    index: { name: indexName, columns, isUnique, concurrently: false, method, with: withParams, where },
  };
}

/** Find closing paren considering nested parens */
function findMatchingParen(str, start) {
  let depth = 1;
  for (let i = start; i < str.length; i++) {
    if (str[i] === '(') depth++;
    else if (str[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function normalizeWhereClause(where, tableName) {
  if (!where) return undefined;
  const parts = where.split(/('[^']*')/);
  return parts.map(part => {
    if (part.startsWith("'") && part.endsWith("'")) return part;
    return part.replace(/(?<!\.)"([a-z_][a-z0-9_]*)"/gi, (match, id) => `"${tableName}"."${id}"`);
  }).join('');
}

// ============================================================
// 10. DROP INDEX
// ============================================================

function parseDropIndex(sql) {
  const m = sql.match(/DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?(?:"([^"]+)")/i);
  if (!m) return null;
  return { index: m[1] };
}

// ============================================================
// 11. Detect data-only / non-schema statements
// ============================================================

function isDataOnly(sql) {
  const u = sql.trim().toUpperCase();
  if (/^(UPDATE|INSERT\s+INTO|DELETE\s+FROM|WITH\s+)/i.test(u)) return true;
  if (/^\s*DO\s+\$/i.test(u)) return true;
  if (/^\s*CREATE\s+EXTENSION/i.test(u)) return true;
  if (/^\s*--/.test(u)) return true;
  return false;
}

// ============================================================
// 12. Apply statement to snapshot
// ============================================================

function applyStatement(snapshot, stmt) {
  if (isDataOnly(stmt)) return;

  // Unwrap DO block that guards FK ADD CONSTRAINT
  let sql = stmt;
  const doM = stmt.match(/DO\s+\$\$\s*BEGIN\s+(ALTER\s+TABLE.+?);\s*EXCEPTION\s+WHEN\s+duplicate_object\s+THEN\s+null;\s*END\s+\$\$/i);
  if (doM) sql = doM[1];

  let result;

  // CREATE TABLE
  result = parseCreateTable(sql);
  if (result) {
    if (!snapshot.tables[result.key]) {
      snapshot.tables[result.key] = result.table;
      console.log(`  + table ${result.key}`);
    }
    return;
  }

  // ALTER TABLE ADD COLUMN
  result = parseAlterTableAddColumn(sql);
  if (result) {
    const key = tableKey(result.table);
    if (snapshot.tables[key]) {
      if (!snapshot.tables[key].columns[result.column.name]) {
        snapshot.tables[key].columns[result.column.name] = result.column;
        console.log(`  + column ${result.table}.${result.column.name}`);
      }
    }
    return;
  }

  // ALTER TABLE ALTER COLUMN
  result = parseAlterTableAlterColumn(sql);
  if (result) {
    const key = tableKey(result.table);
    if (snapshot.tables[key] && snapshot.tables[key].columns[result.column]) {
      const col = snapshot.tables[key].columns[result.column];
      if (result.op === 'set_default') { col.default = result.default; console.log(`  ~ default ${result.table}.${result.column}`); }
      else if (result.op === 'set_not_null') { col.notNull = true; console.log(`  ~ not-null ${result.table}.${result.column}`); }
      else if (result.op === 'drop_not_null') { col.notNull = false; console.log(`  ~ nullable ${result.table}.${result.column}`); }
      else if (result.op === 'drop_default') { delete col.default; console.log(`  ~ drop-default ${result.table}.${result.column}`); }
    }
    return;
  }

  // ALTER TABLE DROP COLUMN
  result = parseAlterTableDropColumn(sql);
  if (result) {
    const key = tableKey(result.table);
    if (snapshot.tables[key]) { delete snapshot.tables[key].columns[result.column]; console.log(`  - column ${result.table}.${result.column}`); }
    return;
  }

  // ALTER TABLE ADD CONSTRAINT
  result = parseAlterTableAddConstraint(sql);
  if (result) {
    const key = tableKey(result.table);
    if (snapshot.tables[key]) {
      if (result.type === 'foreign_key') {
        snapshot.tables[key].foreignKeys[result.constraint.name] = result.constraint;
        console.log(`  + fk ${result.constraint.name}`);
      } else if (result.type === 'check') {
        snapshot.tables[key].checkConstraints[result.name] = { name: result.name, value: result.value };
        console.log(`  + check ${result.name}`);
      } else if (result.type === 'unique') {
        console.log(`  - constraint ${result.name} (unique)`);
      }
    }
    return;
  }

  // ALTER TABLE DROP CONSTRAINT
  result = parseAlterTableDropConstraint(sql);
  if (result) {
    const key = tableKey(result.table);
    if (snapshot.tables[key]) {
      let dropped = false;
      if (delete snapshot.tables[key].foreignKeys[result.constraint]) dropped = true;
      if (delete snapshot.tables[key].checkConstraints[result.constraint]) dropped = true;
      if (delete snapshot.tables[key].uniqueConstraints[result.constraint]) dropped = true;
      console.log(`  - constraint ${result.constraint}`);
    }
    return;
  }

  // CREATE INDEX
  result = parseCreateIndex(sql);
  if (result) {
    const key = tableKey(result.table);
    if (snapshot.tables[key]) {
      snapshot.tables[key].indexes[result.index.name] = result.index;
      console.log(`  + index ${result.index.name}`);
    }
    return;
  }

  // DROP INDEX
  result = parseDropIndex(sql);
  if (result) {
    for (const [tkey, tdef] of Object.entries(snapshot.tables)) {
      if (tdef.indexes[result.index]) {
        delete tdef.indexes[result.index];
        console.log(`  - index ${result.index}`);
        return;
      }
    }
    console.warn(`  ! index ${result.index} not found`);
    return;
  }

  // Unrecognised
  const firstLine = stmt.trim().substring(0, 100).replace(/\n/g, ' ');
  if (!stmt.trim().startsWith('--')) console.warn(`  ? ${firstLine}`);
}

// ============================================================
// 13. Split SQL statements
// ============================================================

function splitStatements(sql) {
  return sql.split(/--> statement-breakpoint\s*\n?/).map(s => s.trim().replace(/;$/, '')).filter(Boolean);
}

// ============================================================
// 14. Main
// ============================================================

function main() {
  console.log('=== Generate missing Drizzle snapshots ===\n');

  // Parse CLI args: node generate-snapshots.mjs [fromIdx] [toIdx]
  //   - No args:        fix stale 0099 baseline, then generate 0100..0134
  //   - fromIdx only:   generate snapshot for fromIdx (base = fromIdx-1)
  //   - fromIdx toIdx:  generate snapshots fromIdx..toIdx (base = fromIdx-1)
  const argv = process.argv.slice(2);
  const fromArg = argv[0] ? parseInt(argv[0], 10) : 100;
  const toArg = argv[1] ? parseInt(argv[1], 10) : fromArg;

  // Determine base snapshot index
  let baseIdx;
  let currentSnapshot;
  if (fromArg === 100 && toArg === 134 && argv.length === 0) {
    // Legacy full run: fix stale 0099 baseline first
    const snapshot = loadSnapshot(99);
    const prevId = snapshot.prevId; // preserve link to 0098; snapshot.id is being replaced
    console.log(`Base snapshot: 0099 (${snapshot.id}) — ${Object.keys(snapshot.tables).length} tables\n`);

    console.log('--- Step 1: Applying 0099 migration to stale snapshot ---');
    const sql99 = loadAllMigrationSql(99, 99);
    const stmts99 = splitStatements(sql99[99]);
    for (const stmt of stmts99) applyStatement(snapshot, stmt);
    const fixed99Id = makeId();
    const fixed99 = { ...snapshot, id: fixed99Id, prevId, tables: { ...snapshot.tables } };
    writeFileSync(join(META_DIR, '0099_snapshot.json'), JSON.stringify(fixed99, null, 2));
    console.log(`  ✓ Rewrote 0099_snapshot.json (${Object.keys(fixed99.tables).length} tables)\n`);

    currentSnapshot = fixed99;
  } else {
    // Incremental run: use the previous snapshot as-is (it is already up to date)
    baseIdx = fromArg - 1;
    if (baseIdx < 0) {
      console.error(`Invalid base index ${baseIdx}; cannot generate before 0000.`);
      process.exit(1);
    }
    currentSnapshot = loadSnapshot(baseIdx);
    console.log(`Base snapshot: ${String(baseIdx).padStart(4, '0')} (${currentSnapshot.id}) — ${Object.keys(currentSnapshot.tables).length} tables\n`);
  }

  // Generate snapshots for the requested range
  console.log(`--- Generating ${String(fromArg).padStart(4, '0')}..${String(toArg).padStart(4, '0')} ---`);
  const sqls = loadAllMigrationSql(fromArg, toArg);
  const sorted = Object.keys(sqls).map(Number).sort((a, b) => a - b);
  console.log(`Found ${sorted.length} migrations: ${sorted[0]}..${sorted[sorted.length-1]}\n`);

  for (const idx of sorted) {
    const prefix = String(idx).padStart(4, '0');
    const statements = splitStatements(sqls[idx]);
    console.log(`[${prefix}] ${statements.length} stmts`);
    for (const stmt of statements) applyStatement(currentSnapshot, stmt);

    const newId = makeId();
    const outSnapshot = {
      ...currentSnapshot,
      id: newId,
      prevId: currentSnapshot.id,
      tables: { ...currentSnapshot.tables },
    };
    writeFileSync(join(META_DIR, `${prefix}_snapshot.json`), JSON.stringify(outSnapshot, null, 2));
    console.log(`  → ${prefix}_snapshot.json`);
    currentSnapshot = outSnapshot;
  }

  console.log('\n=== Done! ===');
}

main();