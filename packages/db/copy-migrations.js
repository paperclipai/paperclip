import fs from "node:fs";

fs.cpSync("src/migrations", "dist/migrations", { recursive: true });
