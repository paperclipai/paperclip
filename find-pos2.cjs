const fs = require('fs');

const MIGRATIONS_FOLDER = 'C:/Real-Tycoon 2/packages/db/src/migrations';
const delimiter = '--> statement-breakpoint';
const journal = JSON.parse(fs.readFileSync('C:/Real-Tycoon 2/packages/db/src/migrations/meta/_journal.json', 'utf8'));

const orderedFiles = (journal.entries || []).map(e => `${e.tag}.sql`);

let cumOffset = 0;
for (const file of orderedFiles) {
  const filePath = `${MIGRATIONS_FOLDER}/${file}`;
  if (!fs.existsSync(filePath)) {
    console.log(`MISSING FILE: ${file}`);
    cumOffset += 1; // dummy
    continue;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const parts = content.split(delimiter).map(s => s.trim()).filter(s => s.length > 0);

  for (let i = 0; i < parts.length; i++) {
    const start = cumOffset;
    cumOffset += parts[i].length;

    if (start <= 1823 && 1823 < cumOffset) {
      const localPos = 1823 - start;
      console.log(`FOUND! File: ${file}, Stmt ${i}`);
      console.log(`Cumulative: ${start}-${cumOffset - 1}, local: ${localPos}`);
      console.log(`Statement length: ${parts[i].length}`);
      console.log(`Char at pos: '${parts[i][localPos]}' (code: ${parts[i].charCodeAt(localPos)})`);
      console.log(`Context: ${JSON.stringify(parts[i].substring(Math.max(0, localPos - 20), localPos + 40))}`);
      console.log(`\nFULL STATEMENT:`);
      console.log(parts[i]);
    }

    cumOffset += delimiter.length;
  }
}

console.log(`\nTotal cumulative after all: ${cumOffset}`);