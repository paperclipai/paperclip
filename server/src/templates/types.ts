import type {
  CompanyPortabilityManifest,
  CompanyTemplateCatalogEntry,
} from "@paperclipai/shared";

export interface BuiltInTemplateMetadata {
  id: string;
  name: string;
  description: string;
  category: string | null;
  maturity: string | null;
  riskProfile: string | null;
  tags: string[];
  useCases: string[];
  recommendedFor: string[];
  recommended: boolean;
  icon: string | null;
}

export interface TemplateRegistryOptions {
  templatesRoot?: string;
}

export interface BuiltInTemplateBundle {
  template: CompanyTemplateCatalogEntry;
  manifest: CompanyPortabilityManifest;
  files: Record<string, string>;
  warnings: string[];
}
