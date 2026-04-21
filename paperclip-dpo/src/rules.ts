import { parse } from "yaml";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface Rules {
  tenant: string;
  detect: {
    pii: string[];
    llm: string[];
  };
  block: {
    art_9_categories: boolean;
  };
  confidenceThreshold: {
    block: "low" | "medium" | "high";
    anonymize: "low" | "medium" | "high";
  };
  mapping: {
    ttlSeconds: number;
  };
}

interface YamlShape {
  tenant: string;
  detect: { pii: string[]; llm: string[] };
  block: { art_9_categories: boolean };
  confidence_threshold: { block: string; anonymize: string };
  mapping: { ttl_seconds: number };
}

export function parseRules(yaml: string): Rules {
  const raw = parse(yaml) as YamlShape;
  return {
    tenant: raw.tenant,
    detect: { pii: raw.detect.pii, llm: raw.detect.llm },
    block: { art_9_categories: raw.block.art_9_categories },
    confidenceThreshold: {
      block: raw.confidence_threshold.block as Rules["confidenceThreshold"]["block"],
      anonymize: raw.confidence_threshold.anonymize as Rules["confidenceThreshold"]["anonymize"],
    },
    mapping: { ttlSeconds: raw.mapping.ttl_seconds },
  };
}

export function loadDefaultRules(): Rules {
  const here = dirname(fileURLToPath(import.meta.url));
  const path = join(here, "..", "dpo-rules.default.yaml");
  return parseRules(readFileSync(path, "utf8"));
}
