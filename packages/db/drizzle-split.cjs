// Exactly reproduce what drizzle's readMigrationFiles does
// and find statement at byte 1824 (1-indexed)

const fs = require('fs');
const path = require('path');

const migrationsDir = './dist/migrations';
const journal = JSON.parse(fs.readFileSync('./dist/migrations/meta/_journal.json', 'utf8'));

const orderedFiles = (journal.entries || []).map(e => `${e.tag}.sql`).filter(f => fs.existsSync(path.join(migrationsDir, f)));

let allContent = '';
for (const file of orderedFiles) {
  const content = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  allContent += content;
}

console.log(`Total concatenated: ${allContent.length} bytes`);

// Drizzle's exact split - NO trimming, NO filtering
const statements = allContent.split('--> statement-breakpoint').map(it => it);

console.log(`Total statements (drizzle split): ${statements.length}`);

// Find statement containing byte 1823 (0-indexed)
let charCount = 0;
for (let i = 0; i < statements.length; i++) {
  const stmt = statements[i];
  const stmtStart = charCount;
  const stmtEnd = charCount + stmt.length;

  if (stmtStart <= 1823 && 1823 < stmtEnd) {
    console.log(`\n=== STATEMENT ${i} (byte ${stmtStart}-${stmtEnd - 1}, len=${stmt.length}) ===`);
    console.log(`Preview (first 80): ${JSON.stringify(stmt.substring(0, 80))}`);
    console.log(`Preview (last 80): ${JSON.stringify(stmt.substring(stmt.length - 80))}`);
    console.log(`Char codes at start: ${[...stmt.substring(0, 20)].map(c => c.charCodeAt(0)).join(', ')}`);

    // Check: does this statement start with whitespace/newlines?
    const firstChar = stmt[0];
    console.log(`\nFirst char: ${firstChar.charCodeAt(0)} (${JSON.stringify(firstChar)})`);
    console.log(`Ends with newline? ${stmt.endsWith('\n')}`);

    // Show exactly what bytes are at the boundary between this and next statement
    if (i + 1 < statements.length) {
      const next = statements[i + 1];
      console.log(`\nNext statement starts with: ${JSON.stringify(next.substring(0, 50))}`);
      console.log(`This+delimiter ends with: ${JSON.stringify(stmt.substring(stmt.length - 20))}`);
    }

    // Check: could this have invisible characters?
    const hasNonPrintable = [...stmt].some(c => c.charCodeAt(0) < 32 && c.charCodeAt(0) !== 9 && c.charCodeAt(0) !== 10 && c.charCodeAt(0) !== 13);
    console.log(`\nHas non-printable chars (except tab/lf/cr)? ${hasNonPrintable}`);
    break;
  }
  charCount += stmt.length + '--> statement-breakpoint'.length;
}

// Also print statements 0-10 with their lengths and first 30 chars
console.log('\n=== Statements 0-10 ===');
for (let i = 0; i < Math.min(11, statements.length); i++) {
  const s = statements[i];
  console.log(`Stmt ${i}: len=${s.length} first30=${JSON.stringify(s.substring(0, 30))}`);
}