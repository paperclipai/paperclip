import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./dist/db/schema/*.js",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.BRAIN_DATABASE_URL!,
  },
});
