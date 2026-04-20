/**
 * i18next TypeScript augmentation for Paperclip.
 *
 * Loose typing to support dynamic keys (status labels, provider names, etc.).
 */
import "i18next";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    returnNull: false;
  }
}
