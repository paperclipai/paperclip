import path from "path";
import { defineConfig } from "vitest/config";

// Absolute paths to lexical dev builds. Using dev builds directly (not barrels)
// prevents the barrel from eagerly loading both dev and prod builds simultaneously.
// When the two builds coexist in the same process, identity checks like
//   klass === ElementNode
// fail across module instances, causing Lexical error #64 in tests.
const lexicalDevMjs = path.resolve(
  __dirname,
  "../node_modules/.pnpm/lexical@0.35.0/node_modules/lexical/Lexical.dev.mjs",
);
const lexicalLinkDevMjs = path.resolve(
  __dirname,
  "../node_modules/.pnpm/@lexical+link@0.35.0/node_modules/@lexical/link/LexicalLink.dev.mjs",
);

export default defineConfig({
  define: {
    // Ensure React's development build (which exports `act`) is used during tests.
    // Without this, Vite may resolve NODE_ENV to "production" and load the production
    // React bundle, which does not export the `act` test utility.
    "process.env.NODE_ENV": JSON.stringify("test"),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Point lexical directly at the dev build to bypass the barrel that loads
      // both dev and prod builds at once. The server.deps.inline list below ensures
      // that transitive imports within @lexical/* also go through this alias.
      lexical: lexicalDevMjs,
      // Same for @lexical/link: bypass LexicalLink.mjs barrel.
      "@lexical/link": lexicalLinkDevMjs,
    },
  },
  test: {
    environment: "node",
    env: {
      NODE_ENV: "test",
    },
    // Inline all lexical packages so that resolve.alias is applied to their
    // internal imports (e.g. LexicalLink.dev.mjs importing 'lexical').
    // Without this, node_modules files are served as-is and their 'lexical'
    // imports go through Node.js native resolution, hitting the barrel and
    // loading Lexical.prod.mjs as a side-effect.
    server: {
      deps: {
        inline: [/lexical/, /^@lexical\//],
      },
    },
    globalSetup: "./vitest-global-setup.ts",
    setupFiles: ["./vitest-setup.ts"],
  },
});
