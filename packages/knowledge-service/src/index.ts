import { KnowledgeCrawler } from "./crawler.js";
import { YamlRegistryReader } from "./yaml-registry.js";
import { TextChunker } from "./chunker.js";
import { LocalEmbedder } from "./embedder.js";
import { KnowledgeDb } from "./db.js";
import { extractUniqueTopicSlugs } from "./stale-detector.js";
import type { KnowledgeTopic } from "@paperclipai/db/src/schema/knowledge.js";

export interface StaleRefreshResult {
  topicSlug: string;
  success: boolean;
  crawlRunId?: string;
  error?: string;
}

export interface StaleRefreshResponse {
  triggered: number;
  results: StaleRefreshResult[];
}

export interface StaleRefreshParams {
  topicSlug: string;
  agentId: string;
  agentName: string;
  issueLink: string;
  companyId: string;
  priority?: string;
}

export class KnowledgeService {
  private crawler: KnowledgeCrawler;
  private registryReader: YamlRegistryReader;
  private chunker: TextChunker;
  private embedder: LocalEmbedder;
  private db: KnowledgeDb;

  constructor() {
    this.db = new KnowledgeDb();
    this.registryReader = new YamlRegistryReader();
    this.crawler = new KnowledgeCrawler({
      userAgent: "Paperclip-KitVentures-Knowledge-Bot/1.0",
      delayMs: 2000,
      maxDepth: 3,
      respectRobotsTxt: true,
    });
    this.chunker = new TextChunker({ chunkSize: 500, overlap: 50 });
    this.embedder = new LocalEmbedder({ model: "all-MiniLM-L6-v2" });
  }

  async initialize(): Promise<void> {
    await this.db.initialize();
    await this.embedder.initialize();
  }

  async crawlTopic(topicSlug: string): Promise<void> {
    const sources = await this.registryReader.getSourcesForTopic(topicSlug);
    
    for (const source of sources) {
      const crawlRun = await this.db.createCrawlRun({
        sourceId: source.id,
        topicId: source.topicId,
        status: "running",
      });

      try {
        const pages = await this.crawler.crawl(source);
        
        for (const page of pages) {
          const chunks = this.chunker.chunk(page.content);
          
          for (let i = 0; i < chunks.length; i++) {
            const embedding = await this.embedder.embed(chunks[i]);
            const contentHash = await this.hashContent(chunks[i]);
            
            await this.db.createChunk({
              sourceId: source.id,
              topicId: source.topicId,
              url: page.url,
              urlPath: page.urlPath,
              title: page.title,
              content: chunks[i],
              contentHash,
              embedding: JSON.stringify(embedding),
              bm25Score: null,
              chunkIndex: i,
              tokenEstimate: this.estimateTokens(chunks[i]),
              heading: page.heading,
              section: page.section,
            });
          }
        }

        await this.db.completeCrawlRun(crawlRun.id, {
          pagesDiscovered: pages.length,
          pagesCrawled: pages.length,
          pagesIndexed: pages.length,
          chunksCreated: pages.reduce((sum, p) => sum + this.chunker.chunk(p.content).length, 0),
        });
      } catch (error) {
        await this.db.failCrawlRun(crawlRun.id, {
          errorMessage: error instanceof Error ? error.message : "Unknown error",
          errorCode: "CRAWL_ERROR",
        });
      }
    }
  }

  async crawlAllTopics(): Promise<void> {
    const topics = await this.db.getActiveTopics();
    
    for (const topic of topics) {
      await this.crawlTopic(topic.slug);
    }
  }

  async triggerStaleRefresh(params: StaleRefreshParams): Promise<StaleRefreshResult> {
    const { topicSlug, agentId, agentName, issueLink, companyId, priority = "medium" } = params;

    const staleReport = await this.db.createStaleReport({
      topicSlug,
      agentId,
      agentName,
      issueLink,
      companyId,
      priority,
      trigger: "agent_stale_report",
    });

    try {
      const topic = await this.db.getTopicBySlug(topicSlug);
      if (!topic) {
        await this.db.resolveStaleReport(staleReport.id, {
          status: "skipped",
          detail: "Topic not found in knowledge_topics table",
        });
        return {
          topicSlug,
          success: false,
          error: "Topic not found in registry",
        };
      }

      const sources = await this.registryReader.getSourcesForTopic(topicSlug);
      
      if (sources.length === 0) {
        await this.db.resolveStaleReport(staleReport.id, {
          status: "skipped",
          detail: "No sources configured for topic in YAML registry",
        });
        return {
          topicSlug,
          success: false,
          error: "Topic has no sources in registry",
        };
      }

      let totalChunksCreated = 0;
      let totalPagesCrawled = 0;

      for (const source of sources) {
        const crawlRun = await this.db.createCrawlRun({
          sourceId: source.id,
          topicId: source.topicId,
          status: "running",
        });

        try {
          const pages = await this.crawler.crawl(source);
          totalPagesCrawled += pages.length;
          
          for (const page of pages) {
            const chunks = this.chunker.chunk(page.content);
            
            for (let i = 0; i < chunks.length; i++) {
              const embedding = await this.embedder.embed(chunks[i]);
              const contentHash = await this.hashContent(chunks[i]);
              
              await this.db.createChunk({
                sourceId: source.id,
                topicId: source.topicId,
                url: page.url,
                urlPath: page.urlPath,
                title: page.title,
                content: chunks[i],
                contentHash,
                embedding: JSON.stringify(embedding),
                bm25Score: null,
                chunkIndex: i,
                tokenEstimate: this.estimateTokens(chunks[i]),
                heading: page.heading,
                section: page.section,
              });
              totalChunksCreated++;
            }
          }

          await this.db.completeCrawlRun(crawlRun.id, {
            pagesDiscovered: pages.length,
            pagesCrawled: pages.length,
            pagesIndexed: pages.length,
            chunksCreated: pages.reduce((sum, p) => sum + this.chunker.chunk(p.content).length, 0),
          });
        } catch (error) {
          await this.db.failCrawlRun(crawlRun.id, {
            errorMessage: error instanceof Error ? error.message : "Unknown error",
            errorCode: "CRAWL_ERROR",
          });
        }
      }

      await this.db.updateTopicLastCrawledAt(topicSlug);

      await this.db.resolveStaleReport(staleReport.id, {
        status: "resolved",
        detail: `Crawled ${totalPagesCrawled} pages, created ${totalChunksCreated} chunks`,
        crawlRunId: undefined,
      });

      return {
        topicSlug,
        success: true,
      };
    } catch (error) {
      await this.db.resolveStaleReport(staleReport.id, {
        status: "failed",
        detail: error instanceof Error ? error.message : "Unknown error",
      });
      return {
        topicSlug,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  private async hashContent(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

export { KnowledgeCrawler } from "./crawler.js";
export { YamlRegistryReader } from "./yaml-registry.js";
export { TextChunker } from "./chunker.js";
export { LocalEmbedder } from "./embedder.js";
export { KnowledgeDb } from "./db.js";
export { extractUniqueTopicSlugs, parseStaleTriggers, hasStaleTrigger } from "./stale-detector.js";