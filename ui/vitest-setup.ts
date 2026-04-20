/**
 * Vitest setup file. Runs in each test worker before any tests.
 * We explicitly set NODE_ENV to ensure consistent module loading.
 */
// This must be done before any Lexical or React modules are imported.
process.env.NODE_ENV = "test";
