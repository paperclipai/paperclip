const { resolveMigrationConnection } = require('./dist/client.js');
const { readFileSync } = require('fs');
const path = require('path');

async function main() {
  const conn = await resolveMigrationConnection();
  console.log('Connected to', conn.source);
  
  const sql = require('postgres')(conn.connectionString);
  
  // Read first migration file
  const files = [
    '0000_mature_masked_marvel.sql',
    '0001_fast_northstar.sql'
  ];
  
  for (const file of files) {
    const filePath = path.join(__dirname, 'src/migrations', file);
    const content = readFileSync(filePath, 'utf8');
    const statements = content.split('--> statement-breakpoint').map(s => s.trim()).filter(s => s.length > 0);
    console.log(`File ${file}: ${statements.length} statements`);
    
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      if (stmt.length < 1800 || stmt.length > 2000) continue;
      console.log(`Statement ${i} length: ${stmt.length}, checking...`);
      try {
        await sql.unsafe(stmt);
        console.log(`  OK`);
      } catch (e) {
        console.log(`  ERROR: ${e.message}`);
        console.log(`  Position: ${e.position}`);
        if (stmt.length > 1820 && stmt.length < 1830) {
          console.log(`  CHARS 1810-1840: "${stmt.substring(1810, 30)}"`);
        }
      }
    }
  }
  
  await sql.end();
  await conn.stop();
}

main().catch(console.error);
