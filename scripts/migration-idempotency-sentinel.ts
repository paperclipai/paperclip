#!/usr/bin/env tsx
/**
 * migration-idempotency-sentinel.ts
 * Scans new drizzle migrations for non-idempotent / MySQL-invalid DDL.
 * Fails CI if violations found. Emits GitHub Actions annotations.
 *
 * Usage: npx tsx scripts/migration-idempotency-sentinel.ts --base origin/main
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

interface Violation {
  file: string;
  line: number;
  message: string;
}

const args = process.argv.slice(2);
let base = 'origin/main';
let migrationsDir = 'packages/db/src/migrations';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--base' && args[i + 1]) {
    base = args[i + 1];
    i++;
  }
  if (args[i] === '--migrations-dir' && args[i + 1]) {
    migrationsDir = args[i + 1];
    i++;
  }
}

function getNewMigrationFiles(): string[] {
  try {
    const diff = execSync(
      `git diff --name-only --diff-filter=AM ${base}...HEAD -- ${migrationsDir}`,
      { encoding: 'utf8' }
    );
    return diff.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function tokenizeStatements(sql: string): { statement: string; line: number }[] {
  const lines = sql.split('\n');
  const statements: { statement: string; line: number }[] = [];
  let current = '';
  let startLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    current += line + '\n';
    if (line.includes('--> statement-breakpoint') || line.trim().endsWith(';')) {
      const stmt = current.trim().replace(/-->.*/g, '').trim();
      if (stmt) {
        statements.push({ statement: stmt, line: startLine });
      }
      current = '';
      startLine = i + 2;
    }
  }
  if (current.trim()) {
    statements.push({ statement: current.trim(), line: startLine });
  }
  return statements;
}

function checkViolations(file: string, sql: string): Violation[] {
  const violations: Violation[] = [];
  const statements = tokenizeStatements(sql);
  const fileName = path.basename(file);

  let hasCreateTableFor: Set<string> = new Set();

  for (const { statement, line } of statements) {
    const upper = statement.toUpperCase();

    // Track CREATE TABLE
    const createMatch = upper.match(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?`?(\w+)`?/);
    if (createMatch) {
      hasCreateTableFor.add(createMatch[1].toLowerCase());
    }

    // 1. ADD COLUMN without guard
    if (upper.includes('ALTER TABLE') && upper.includes('ADD COLUMN')) {
      const tableMatch = upper.match(/ALTER TABLE\s+`?(\w+)`?/);
      const colMatch = upper.match(/ADD COLUMN\s+(?:IF NOT EXISTS\s+)?`?(\w+)`?/);
      if (tableMatch && colMatch) {
        const table = tableMatch[1].toLowerCase();
        const col = colMatch[1].toLowerCase();
        const hasCreate = hasCreateTableFor.has(table);
        const hasInfoSchema = upper.includes('INFORMATION_SCHEMA.COLUMNS');
        if (!hasCreate && !hasInfoSchema) {
          violations.push({
            file: fileName,
            line,
            message: `ADD COLUMN ${col} on ${table} without INFORMATION_SCHEMA guard or same-migration CREATE TABLE`,
          });
        }
      }
    }

    // 2. CREATE INDEX IF NOT EXISTS (invalid MySQL)
    if (upper.includes('CREATE INDEX IF NOT EXISTS')) {
      violations.push({
        file: fileName,
        line,
        message: 'CREATE INDEX IF NOT EXISTS is invalid MySQL syntax',
      });
    }

    // 3. ALTER TABLE ADD COLUMN IF NOT EXISTS (invalid MySQL)
    if (upper.includes('ADD COLUMN IF NOT EXISTS')) {
      violations.push({
        file: fileName,
        line,
        message: 'ALTER TABLE ADD COLUMN IF NOT EXISTS is invalid MySQL syntax',
      });
    }

    // 4. DROP COLUMN without guard
    if (upper.includes('ALTER TABLE') && upper.includes('DROP COLUMN')) {
      const tableMatch = upper.match(/ALTER TABLE\s+`?(\w+)`?/);
      const colMatch = upper.match(/DROP COLUMN\s+`?(\w+)`?/);
      if (tableMatch && colMatch) {
        const hasInfoSchema = upper.includes('INFORMATION_SCHEMA.COLUMNS');
        if (!hasInfoSchema) {
          violations.push({
            file: fileName,
            line,
            message: `DROP COLUMN without INFORMATION_SCHEMA.COLUMNS existence check`,
          });
        }
      }
    }
  }

  return violations;
}

function main() {
  const newFiles = getNewMigrationFiles();
  if (newFiles.length === 0) {
    console.log('No new migration files in diff.');
    process.exit(0);
  }

  let allViolations: Violation[] = [];

  for (const file of newFiles) {
    if (!file.endsWith('.sql')) continue;
    const fullPath = path.join(process.cwd(), file);
    if (!fs.existsSync(fullPath)) continue;
    const sql = fs.readFileSync(fullPath, 'utf8');
    const violations = checkViolations(file, sql);
    allViolations.push(...violations);
  }

  if (allViolations.length > 0) {
    for (const v of allViolations) {
      console.error(`::error file=${v.file},line=${v.line}::${v.message}`);
    }
    console.error(`\n${allViolations.length} migration idempotency violation(s) found.`);
    process.exit(1);
  }

  console.log('All new migrations passed idempotency checks.');
  process.exit(0);
}

main();
