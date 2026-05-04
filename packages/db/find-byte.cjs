// Simulate exactly what drizzle-orm migratePg does:
// concatenate ALL 66 migration files, then split by delimiter,
// and find which statement sits at byte position 1824

const fs = require('fs');
const path = require('path');

const migrationsDir = './dist/migrations';
const delimiter = '--> statement-breakpoint';

// Read journal to get ordered files
const journal = JSON.parse(fs.readFileSync('./dist/migrations/meta/_journal.json', 'utf8'));
const orderedFiles = (journal.entries || [])
  .map(e => `${e.tag}.sql`)
  .filter(f => fs.existsSync(path.join(migrationsDir, f)));

console.log(`Total journal entries: ${journal.entries?.length}`);
console.log(`Ordered files: ${orderedFiles.length}`);

// Read ALL migration files and concatenate (like migratePg does internally)
let allContent = '';
const fileBoundaries = [];
for (const file of orderedFiles) {
  fileBoundaries.push({ file, start: allContent.length, name: file });
  const content = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  allContent += content;
}

console.log(`\nTotal concatenated length: ${allContent.length} bytes`);
console.log(`Target position: 1824 (1-indexed) = byte index 1823 (0-indexed)`);

// Split like splitMigrationStatements does
const statements = allContent
  .split(delimiter)
  .map(s => s.trim())
  .filter(s => s.length > 0);

console.log(`Total statements after split: ${statements.length}`);

// Find which statement contains byte 1823
let charCount = 0;
for (let i = 0; i < statements.length; i++) {
  const stmt = statements[i];
  const stmtStart = charCount;
  const stmtEnd = charCount + stmt.length;

  if (stmtStart <= 1823 && 1823 < stmtEnd) {
    console.log(`\n=== STATEMENT ${i} contains byte 1823 ===`);
    console.log(`Statement starts at byte ${stmtStart}, ends at byte ${stmtEnd - 1} (len=${stmt.length})`);
    console.log(`Statement preview (first 100 chars): ${JSON.stringify(stmt.substring(0, 100))}`);
    console.log(`Statement preview (bytes 1800-1850): ${JSON.stringify(stmt.substring(1800, 1850))}`);
    console.log(`\nFull statement:\n${stmt}`);
    break;
  }
  charCount += stmt.length + delimiter.length; // +delimiter since split removes it
}

// Also show the raw bytes around position 1823
console.log(`\nRaw bytes around position 1823 (1-indexed):`);
for (let i = Math.max(0, 1823 - 30); i < Math.min(allContent.length, 1823 + 30); i++) {
  const c = allContent[i];
  const charCode = allContent.charCodeAt(i);
  const marker = i === 1823 ? ' <-- TARGET' : '';
  console.log(`  byte ${i}: ${charCode} (${c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : JSON.stringify(c)})${marker}`);
}