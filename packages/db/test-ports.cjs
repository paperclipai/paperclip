const postgres = require('postgres');
(async () => {
  for (const port of [5432, 54329, 54330]) {
    try {
      const sql = postgres(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, { ssl: false, max: 1, connect_timeout: 5 });
      await sql`SELECT 1`;
      console.log(`Port ${port}: WORKS`);
      await sql.end();
    } catch (e) {
      console.log(`Port ${port}: FAILED - ${e.message.slice(0, 80)}`);
    }
  }
})();