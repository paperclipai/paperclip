/**
 * Global setup for vitest. This runs in the main process before any tests.
 * We set NODE_ENV to "test" here so that Lexical and React use their
 * development builds (which have proper error messages and export `act`).
 */
export function setup() {
  process.env.NODE_ENV = "test";
}
