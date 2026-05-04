const fs = require('fs');
const path = require('path');

const migrationsDir = 'C:/Real-Tycoon 2/packages/db/src/migrations';
const delimiter = '--> statement-breakpoint';

const journal = JSON.parse(fs.readFileSync('C:/Real-Tycoon 2/packages/db/src/migrations/meta/_journal.json', 'utf8'));
const orderedFiles = (journal.entries || []).map(e => `${e.tag}.sql`);

let cumulativeOffset = 0;
let found = false;

for (const file of orderedFiles) {
  const filePath = path.join(migrationsDir, file);
  if (!fs.existsSync(filePath)) {
    console.log(`MISSING: ${file}`);
    continue;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const parts = content.split(delimiter).map(s => s.trim()).filter(s => s.length > 0);

  for (let i = 0; i < parts.length; i++) {
    const start = cumulativeOffset;
    cumulativeOffset += parts[i].length;
    const end = cumulativeOffset - 1;

    if (start <= 1822 && 1822 <= end) {
      console.log(`FOUND at cumulative offset ${1822} (1-indexed: ${1823})`);
      console.log(`File: ${file}, statement ${i}`);
      console.log(`Statement start: ${start}, end: ${end}`);
      const localOffset = 1822 - start;
      const ctx = parts[i].substring(Math.max(0, localOffset - 30), localOffset + 50);
      console.log(`Context: "${ctx}"`);
      found = true;
      break;
    }
    cumulativeOffset += delimiter.length;
  }
  if (found) break;
}

if (!found) {
  console.log(`No statement found at cumulative offset 1822`);
  console.log(`Total cumulative after all journal files: ${cumulativeOffset}`);
  // Check if it's in the untracked files (0059-0066)
  const allFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  const journalFiles = new Set(orderedFiles);
  const untracked = allFiles.filter(f => !journalFiles.has(f));
  console.log('Untracked files:', untracked);

  // Check if the offset falls in an untracked file
  for (const file of untracked) {
    const filePath = path.join(migrationsDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    if (cumulativeOffset <= 1822 && 1822 < cumulativeOffset + content.length) {
      console.log(`\nFound in untracked file: ${file}`);
      console.log(`Offset within file: ${1822 - cumulativeOffset}`);
    }
    cumulativeOffset += content.length + (content.split(delimiter).length - 1) * delimiter.length;
  }
  console.log(`Final cumulative: ${cumulativeOffset}`);
}