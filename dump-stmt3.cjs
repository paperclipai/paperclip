const fs = require('fs');
const path = require('path');

const filePath = 'C:/Real-Tycoon 2/packages/db/src/migrations/0000_mature_masked_marvel.sql';
const content = fs.readFileSync(filePath, 'utf8');
const delimiter = '--> statement-breakpoint';
const parts = content.split(delimiter).map(s => s.trim()).filter(s => s.length > 0);

console.log('Total parts:', parts.length);
for (let i = 0; i < parts.length; i++) {
  const start = i === 0 ? 0 : parts.slice(0, i).reduce((acc, p) => acc + p.length + delimiter.length, 0);
  console.log(`Statement ${i}: len=${parts[i].length}, start=${start}, end=${start + parts[i].length - 1}`);
  if (i === 3) {
    console.log('\n=== STATEMENT 3 FULL CONTENT ===');
    console.log(parts[i]);
    console.log('\n=== END ===');
  }
}