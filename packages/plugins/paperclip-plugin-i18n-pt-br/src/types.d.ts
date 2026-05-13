declare module "@paperclipai/plugin-sdk/i18n" {
  export interface Language {
    code: string;
    label: string;
    flag: string;
  }
  export function registerLanguage(lang: Language, translations: any): void;
}
