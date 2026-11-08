import { t } from "@/i18n";

export function localizedOptions<const Key extends string>(options: readonly (readonly [Key, string])[]): readonly [Key, string][] {
  return options.map(([value, messageKey]) => {
    const option: [Key, string] = [value, messageKey];
    Object.defineProperty(option, 1, { enumerable: true, get: () => t(`display:${messageKey}`) });
    return option;
  });
}
