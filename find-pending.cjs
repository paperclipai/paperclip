const fs = require('fs');
const delimiter = '--> statement-breakpoint';
const content = fs.readFileSync('packages/db/src/migrations/0000_mature_masked_marvel.sql', 'utf8');
const parts = content.split(delimiter).map(s => s.trim()).filter(s => s.length > 0);
console.log('Statement count:', parts.length);
for (let i = 0; i < parts.length; i++) {
  const s = parts[i];
  console.log('Stmt ' + i + ': len=' + s.length);
  if (s.includes('pending')) {
    console.log('  -> Contains pending');
    console.log('  Content:', s.substring(0, 300));
  }
}