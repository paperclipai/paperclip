import type { CompanySecret, EnvBinding } from "@paperclipai/shared";
import type { MyUserSecretEntry } from "../api/secrets";

export interface SavedProviderKey {
  id: string;
  label: string;
  binding: EnvBinding;
}

/** Match the canonical onboarding key and distinct keys created by agent setup. */
export function savedProviderKeys(
  companyId: string,
  envKey: string,
  personal: MyUserSecretEntry[],
  organization: CompanySecret[],
): SavedProviderKey[] {
  const matches = (key: string | null) =>
    key?.toUpperCase() === envKey ||
    key?.toUpperCase().startsWith(`${envKey}.SETUP.`);
  return [
    ...personal.flatMap(({ definition, secret }) =>
      definition.companyId === companyId &&
      definition.status === "active" &&
      secret?.companyId === companyId &&
      secret.status === "active" &&
      matches(definition.key)
        ? [
            {
              id: `user:${definition.id}`,
              label: `${definition.name} (Your key)`,
              binding: {
                type: "user_secret_ref" as const,
                key: definition.key,
                version: "latest" as const,
              },
            },
          ]
        : [],
    ),
    ...organization.flatMap((secret) =>
      secret.companyId === companyId &&
      secret.scope === "company" &&
      secret.status === "active" &&
      matches(secret.key)
        ? [
            {
              id: `company:${secret.id}`,
              label: `${secret.name} (Organization key)`,
              binding: {
                type: "secret_ref" as const,
                secretId: secret.id,
                version: "latest" as const,
              },
            },
          ]
        : [],
    ),
  ];
}

/** Codex device login creates one reusable company secret per account home. */
export function savedCodexSubscriptions(
  companyId: string,
  organization: CompanySecret[],
): SavedProviderKey[] {
  return organization
    .filter(
      (secret) =>
        secret.companyId === companyId &&
        secret.scope === "company" &&
        secret.status === "active" &&
        secret.name.startsWith("CODEX_HOME_"),
    )
    .map((secret) => ({
      id: `company:${secret.id}`,
      label: secret.name.replace("CODEX_HOME_", "ChatGPT account · "),
      binding: { type: "secret_ref", secretId: secret.id, version: "latest" },
    }));
}
