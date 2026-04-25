import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import type { SourceConfig } from "./crawler.js";

export interface SourceDefinition {
  url: string;
  title: string;
  source_type: string;
  allowed_paths: string[];
  disallowed_paths: string[];
  robots_allowed: boolean;
  rate_limit_respect: boolean;
  crawl_frequency_hours: number;
}

export interface TopicDefinition {
  topic: string;
  tier: number;
  description: string;
  refresh_interval_hours: number;
  sources: SourceDefinition[];
  crawler_config?: {
    user_agent: string;
    respect_robots_txt: boolean;
    rate_limit_requests_per_second: number;
    max_pages_per_source: number;
    delay_between_requests_ms: number;
    retry_on_429: boolean;
    retry_backoff_seconds: number;
    timeout_seconds: number;
    extract_depth: number;
  };
}

export class YamlRegistryReader {
  private sourcesDir: string;

  constructor(sourcesDir?: string) {
    this.sourcesDir = sourcesDir || "/home/jakejames/biz-ops/knowledge/sources";
  }

  async getTopicDefinitions(): Promise<TopicDefinition[]> {
    const files = fs.readdirSync(this.sourcesDir).filter(f => f.endsWith(".yaml"));
    const topics: TopicDefinition[] = [];

    for (const file of files) {
      const filePath = path.join(this.sourcesDir, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const topic = yaml.parse(content) as TopicDefinition;
      topics.push(topic);
    }

    return topics;
  }

  async getSourcesForTopic(topicSlug: string): Promise<SourceConfig[]> {
    const topics = await this.getTopicDefinitions();
    const topic = topics.find(t => t.topic === topicSlug);
    if (!topic) return [];
    
    return topic.sources.map((source, index) => ({
      id: `${topic.topic}-${index}`,
      topicId: topic.topic,
      url: source.url,
      title: source.title,
      sourceType: source.source_type,
      allowedPaths: source.allowed_paths,
      disallowedPaths: source.disallowed_paths,
      robotsAllowed: source.robots_allowed,
      rateLimitRespect: source.rate_limit_respect,
      crawlFrequencyHours: source.crawl_frequency_hours,
    }));
  }

  async getCrawlerConfig(topicSlug: string): Promise<TopicDefinition["crawler_config"] | undefined> {
    const topics = await this.getTopicDefinitions();
    const topic = topics.find(t => t.topic === topicSlug);
    return topic?.crawler_config;
  }
}