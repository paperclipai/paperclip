export type OllamaModelLicense = {
  license: string;
  licenseUrl?: string;
  summary: string;
  commercialUse: "allowed" | "restricted" | "prohibited" | "unknown";
};

const MATRIX: Record<string, OllamaModelLicense> = {
  "llama3.1": {
    license: "Llama 3.1 Community License",
    licenseUrl: "https://llama.meta.com/llama3_1/license/",
    summary:
      "Meta community license. Commercial use allowed under 700M MAU; attribution and acceptable-use rules apply.",
    commercialUse: "restricted",
  },
  "llama3.2": {
    license: "Llama 3.2 Community License",
    licenseUrl: "https://llama.meta.com/llama3_2/license/",
    summary:
      "Meta community license with EU restrictions on multimodal variants. Review before shipping.",
    commercialUse: "restricted",
  },
  "qwen2.5": {
    license: "Apache License 2.0",
    licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    summary:
      "Permissive Apache 2.0 license. Commercial use allowed with attribution and patent grant.",
    commercialUse: "allowed",
  },
  "mistral": {
    license: "Apache License 2.0",
    licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
    summary:
      "Permissive Apache 2.0 license for the mistral base model family.",
    commercialUse: "allowed",
  },
  "phi3": {
    license: "MIT License",
    licenseUrl: "https://opensource.org/licenses/MIT",
    summary: "Permissive MIT license.",
    commercialUse: "allowed",
  },
  "gemma2": {
    license: "Gemma Terms of Use",
    licenseUrl: "https://ai.google.dev/gemma/terms",
    summary:
      "Google Gemma Terms of Use. Commercial use permitted subject to prohibited-use policy.",
    commercialUse: "restricted",
  },
};

export function resolveLicense(modelName: string): OllamaModelLicense | null {
  const base = modelName.split(":")[0].toLowerCase();
  return MATRIX[base] ?? null;
}

export function listKnownFamilies(): string[] {
  return Object.keys(MATRIX);
}
