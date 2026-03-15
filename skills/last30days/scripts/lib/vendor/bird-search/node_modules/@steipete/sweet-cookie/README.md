# @steipete/sweet-cookie

Inline-first browser cookie extraction for local tooling (no native addons).

Supports:
- Inline payloads (JSON / base64 / file) — most reliable path.
- Local browser reads (best effort): Chrome, Edge, Firefox, Safari (macOS).

Install:
```bash
npm i @steipete/sweet-cookie
```

Usage:
```ts
import { getCookies, toCookieHeader } from '@steipete/sweet-cookie';

const { cookies, warnings } = await getCookies({
  url: 'https://example.com/',
  names: ['session', 'csrf'],
  browsers: ['chrome', 'edge', 'firefox', 'safari'],
});

for (const w of warnings) console.warn(w);
const cookieHeader = toCookieHeader(cookies, { dedupeByName: true });
```

Docs + extension exporter: see the repo root README.

