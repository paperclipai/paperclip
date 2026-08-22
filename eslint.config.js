import tseslint from 'typescript-eslint';
import prettierRecommended from 'eslint-plugin-prettier/recommended';

// The Founding Engineer owns the Chimeric Intelligence foundation. For the
// CHIA-3 starter-kit deliverable this config is scoped to the starter kit only,
// so the reviewable diff does not entangle the separate CHI-13.1 Chimera client
// work. The Chimera data layer will opt into lint via its own issue/PR.
const SCOPE = ['packages/starter-kit/src/**/*.{ts,tsx}'];

export default tseslint.config(
  {
    name: 'chimeric/root-ignores',
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/build/**',
      '**/coverage/**',
      '**/*.config.{js,cjs,mjs,ts}',
      '**/*.cjs',
    ],
  },
  {
    name: 'chimeric/lint',
    files: SCOPE,
    extends: tseslint.configs.recommended,
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2023,
    },
    rules: {
      // Surface, but do not fail the gate on, unused locals and `any`.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  // Run Prettier as an ESLint rule (auto-fixable) and disable conflicting rules.
  // Scoped to the same foundation packages so nothing outside CHIA-2 is linted.
  {
    ...prettierRecommended,
    name: 'chimeric/prettier',
    files: SCOPE,
  },
);
