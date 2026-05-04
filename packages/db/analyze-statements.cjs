// No DB needed - just find statements >= 1824 chars
const fs = require('fs');
const path = require('path');

const migrationsDir = './dist/migrations';
const delimiter = '--> statement-breakpoint';

const journal = JSON.parse(fs.readFileSync('./dist/migrations/meta/_journal.json', 'utf8'));
const entries = (journal.entries || []).filter(e => typeof e?.tag === 'string');

let allContent = '';
for (const entry of entries) {
  const filePath = path.join(migrationsDir, `${entry.tag}.sql`);
  allContent += fs.readFileSync(filePath, 'utf8');
}

const statements = allContent.split(delimiter);
console.log(`Total statements: ${statements.length}`);

const largeStmts = [];
for (let i = 0; i < statements.length; i++) {
  const s = statements[i].trim();
  if (s.length >= 1700) { // threshold near 1824
    largeStmts.push({ index: i, length: s.length, tag: entries[Math.floor(i / 15)]?.tag || 'unknown' });
  }
}

console.log(`\nStatements with length >= 1700 chars:`);
for (const ls of largeStmts) {
  console.log(`  Stmt ${ls.index}: len=${ls.length}, ~${entries[Math.floor(ls.index / 15)]?.tag || 'unknown'}`);
}

// Print the full content of the LARGEST statements
console.log('\n--- Full content of statements >= 1824 chars ---');
for (const ls of largeStmts) {
  if (ls.length >= 1824) {
    console.log(`\n=== STMT ${ls.index} (len=${ls.length}) ===`);
    console.log(statements[ls.index]);
    console.log('=== END ===');
  }
}