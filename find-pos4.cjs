const fs = require('fs');

const MIGRATIONS_FOLDER = './packages/db/src/migrations';
const journalPath = './packages/db/src/migrations/meta/_journal.json';
const delimiter = '--> statement-breakpoint';

// Read journal to get ordered list of migration files
const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
const orderedFiles = (journal.entries || [])
  .map(e => `${e.tag}.sql`)
  .filter(f => fs.existsSync(path.join(MIGRATIONS_FOLDER, f)));

// Read and concatenate all migration files in order
let cumulativePos = 0;
const statementMap = []; // {file, stmtIndex, start, end, content}

for (const file of orderedFiles) {
  const filePath = path.join(MIGRATIONS_FOLDER, file);
  const content = fs.readFileSync(filePath, 'utf8');
  const parts = content.split(delimiter).map(s => s.trim()).filter(s => s.length > 0);

  for (let i = 0; i < parts.length; i++) {
    const start = cumulativePos;
    const end = cumulativePos + parts[i].length - 1;
    statementMap.push({ file, stmtIndex: i, start, end, content: parts[i] });
    cumulativePos += parts[i].length;
    // Add delimiter length for cumulative calculation
    cumulativePos += delimiter.length;
  }
}

console.log('Total statements across all migration files:', statementMap.length);

// Find what's at position 1823 (0-indexed) in the full batch
const targetPos = 1823;
for (const entry of statementMap) {
  if (entry.start <= targetPos && targetPos <= entry.end) {
    const localPos = targetPos - entry.start;
    const charAtTarget = entry.content[localPos];
    console.log('\n=== FOUND ===');
    console.log('File:', entry.file);
    console.log('Statement index:', entry.stmtIndex);
    console.log('Statement start:', entry.start, 'end:', entry.end);
    console.log('Local position:', localPos);
    console.log('Char at target:', JSON.stringify(charAtTarget));
    console.log('Context (local ' + (localPos - 30) + ' to ' + (localPos + 30) + '):');
    console.log(JSON.stringify(entry.content.substring(Math.max(0, localPos - 30), localPos + 31)));
    console.log('\nFull statement content:');
    console.log(entry.content);
    break;
  }
}

console.log('\n=== Statements near position 1823 ===');
for (let i = 0; i < statementMap.length; i++) {
  const e = statementMap[i];
  if (e.start - 100 <= targetPos && targetPos <= e.end + 100) {
    console.log('Stmt ' + i + ' (' + e.file + '): bytes ' + e.start + '-' + e.end + ' len=' + e.content.length);
    console.log('  First 80:', JSON.stringify(e.content.substring(0, 80)));
  }
}