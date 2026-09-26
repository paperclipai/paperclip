# ESLint Security SAST Configuration

> Reference for SKILL.md. Use when checking or scaffolding the SAST step in CI/CD (Section 3 of the audit).

## Why a Separate Config

Keep dev lint fast and security lint strict. Two configs, two purposes:

```
eslint.config.js       → developer lint (fast, local)
eslint.security.js     → SAST CI scan (strict, security-focused)
```

## Install

```bash
npm install -D eslint eslint-plugin-security eslint-plugin-no-unsanitized \
  @typescript-eslint/parser @typescript-eslint/eslint-plugin
```

## Add Scripts

```json
{
  "scripts": {
    "lint": "eslint \"src/**/*.ts\"",
    "lint:security": "eslint --config eslint.security.js \"src/**/*.ts\""
  }
}
```

## `eslint.security.js` Template (Flat Config)

> If your `package.json` has `"type": "module"`, save this file as `eslint.security.cjs`
> (and reference `.cjs` in the script), or convert to ESM: replace `require(...)` with
> `import ... from '...'` and `module.exports = [...]` with `export default [...]`.

```javascript
const baseConfig = require('./eslint.config.js');
const security = require('eslint-plugin-security');
const noUnsanitized = require('eslint-plugin-no-unsanitized');

module.exports = [
  ...baseConfig,
  security.configs.recommended,
  {
    files: ['src/**/*.ts'],
    plugins: { 'no-unsanitized': noUnsanitized },
    rules: {
      // Code injection
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',

      // XSS protection
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',

      // Weak randomness — Math.random in auth/verification code
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message:
            'Math.random is not cryptographically secure. Use crypto.randomInt() for security-sensitive values.',
        },
      ],

      // Regex DoS
      'security/detect-unsafe-regex': 'warn',
      'security/detect-non-literal-regexp': 'warn',

      // Node injection
      'security/detect-child-process': 'warn',
      'security/detect-non-literal-fs-filename': 'warn',
      'security/detect-non-literal-require': 'warn',

      // Pseudorandom bytes
      'security/detect-pseudoRandomBytes': 'warn',

      // Buffer safety
      'security/detect-buffer-noassert': 'warn',
      'security/detect-new-buffer': 'warn',

      // Timing attacks
      'security/detect-possible-timing-attacks': 'warn',

      // Object injection — too noisy with bracket notation, off
      'security/detect-object-injection': 'off',
    },
  },
];
```

## GitHub Actions Workflow

`.github/workflows/security-lint.yml`:

```yaml
name: Security SAST Lint

on:
  pull_request:
    branches: [master, development, staging]

jobs:
  security-lint:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2

      - name: Setup Node.js
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version-file: '.nvmrc'   # or pin: e.g. node-version: '22'
          cache: 'yarn'

      - name: Install dependencies
        run: yarn install --frozen-lockfile

      - name: Run ESLint security SAST scan
        run: yarn lint:security
```

## Rules Table

| Category | Rule | Severity |
|----------|------|----------|
| Code injection | `no-eval`, `no-implied-eval`, `no-new-func` | error |
| XSS | `no-unsanitized/method`, `no-unsanitized/property` | error |
| Weak randomness | `no-restricted-properties` on `Math.random` | error |
| Regex DoS | `security/detect-unsafe-regex`, `security/detect-non-literal-regexp` | warn |
| Node injection | `security/detect-child-process`, `security/detect-non-literal-fs-filename` | warn |
| Buffer safety | `security/detect-buffer-noassert`, `security/detect-new-buffer` | warn |
| Timing attacks | `security/detect-possible-timing-attacks` | warn |
| Object injection | `security/detect-object-injection` | off (too noisy) |

## Tuning

1. Run `yarn lint:security` on the codebase
2. Turn off rules with too many false positives (start with `detect-object-injection` off)
3. Promote real findings to `error` (e.g. `Math.random` in auth code)
4. Keep speculative rules at `warn`
5. Add project-specific rules with `no-restricted-properties` or `no-restricted-syntax` for patterns unique to your codebase
