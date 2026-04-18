/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** UI locale: `en` | `zh`. Overrides initial language when set at build time. */
  readonly VITE_UI_LOCALE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
