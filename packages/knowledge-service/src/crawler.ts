import * as cheerio from "cheerio";

export interface CrawlerOptions {
  userAgent: string;
  delayMs: number;
  maxDepth: number;
  respectRobotsTxt: boolean;
}

export interface CrawlResult {
  url: string;
  urlPath: string;
  title: string;
  content: string;
  heading?: string;
  section?: string;
}

export interface SourceConfig {
  id: string;
  topicId: string;
  url: string;
  title: string;
  sourceType: string;
  allowedPaths: string[];
  disallowedPaths: string[];
  robotsAllowed: boolean;
  rateLimitRespect: boolean;
  crawlFrequencyHours: number;
}

export class KnowledgeCrawler {
  private options: CrawlerOptions;
  private robotsCache: Map<string, { allowed: boolean; cachedAt: number }> = new Map();
  private rateLimiter: Map<string, number> = new Map();

  constructor(options: CrawlerOptions) {
    this.options = options;
  }

  async crawl(source: SourceConfig): Promise<CrawlResult[]> {
    const results: CrawlResult[] = [];
    
      if (!await this.canCrawl(source.url, source)) {
      return results;
    }

    try {
      const html = await this.fetch(source.url);
      const $ = cheerio.load(html);
      
      $("script, style, nav, footer, header, aside").remove();
      
      const title = $("title").text().trim() || source.title;
      const content = $("main, article, .content, #content").text().trim() || 
                      $("body").text().trim();
      
      results.push({
        url: source.url,
        urlPath: new URL(source.url).pathname,
        title,
        content: this.cleanText(content),
        section: this.extractSection($),
      });

      const links = this.extractLinks($, source);
      for (const link of links.slice(0, 20)) {
        await this.delay();
        
        if (await this.canCrawl(link, source)) {
          try {
            const subHtml = await this.fetch(link);
            const sub$ = cheerio.load(subHtml);
            sub$("script, style, nav, footer, header, aside").remove();
            
            const subContent = sub$("main, article, .content, #content").text().trim() ||
                              sub$("body").text().trim();
            
            results.push({
              url: link,
              urlPath: new URL(link).pathname,
              title: sub$("title").text().trim() || title,
              content: this.cleanText(subContent),
              section: this.extractSection(sub$),
            });
          } catch {
            // Skip failed sub-pages
          }
        }
      }
    } catch (error) {
      console.error(`Error crawling ${source.url}:`, error);
    }

    return results;
  }

  private async canCrawl(url: string, source: SourceConfig): Promise<boolean> {
    if (!this.options.respectRobotsTxt) return true;
    
    const robotsUrl = new URL("/robots.txt", url).href;
    
    if (!source.robotsAllowed) return false;
    
    const cached = this.robotsCache.get(robotsUrl);
    if (cached && Date.now() - cached.cachedAt < 3600000) {
      return cached.allowed;
    }

    try {
      const response = await fetch(robotsUrl, {
        headers: { "User-Agent": this.options.userAgent },
        signal: AbortSignal.timeout(5000),
      });
      
      if (!response.ok) {
        this.robotsCache.set(robotsUrl, { allowed: true, cachedAt: Date.now() });
        return true;
      }

      const robotsTxt = await response.text();
      const allowed = this.parseRobotsTxt(robotsTxt, this.options.userAgent, new URL(url).pathname);
      this.robotsCache.set(robotsUrl, { allowed, cachedAt: Date.now() });
      return allowed;
    } catch {
      return true;
    }
  }

  private parseRobotsTxt(robotsTxt: string, userAgent: string, path: string): boolean {
    const lines = robotsTxt.split("\n");
    let userAgentBlock: string | null = null;
    let allowPath = true;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.toLowerCase().startsWith("user-agent:")) {
        const ua = trimmed.substring(11).trim();
        if (ua === "*" || ua.toLowerCase() === userAgent.toLowerCase()) {
          userAgentBlock = ua;
        } else if (userAgentBlock) {
          break;
        }
      } else if (userAgentBlock && (trimmed.startsWith("Allow:") || trimmed.startsWith("Disallow:"))) {
        const directive = trimmed.startsWith("Allow:") ? "allow" : "disallow";
        const rulePath = trimmed.substring(directive.length + 1).trim();
        if (this.pathMatches(path, rulePath)) {
          allowPath = directive === "allow";
        }
      }
    }

    return allowPath;
  }

  private pathMatches(path: string, pattern: string): boolean {
    if (pattern === "/") return true;
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      return path.startsWith(prefix);
    }
    return path.startsWith(pattern);
  }

  private async fetch(url: string): Promise<string> {
    this.checkRateLimit(url);
    
    const response = await fetch(url, {
      headers: {
        "User-Agent": this.options.userAgent,
        "Accept": "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.text();
  }

  private checkRateLimit(url: string): void {
    const domain = new URL(url).hostname;
    const lastRequest = this.rateLimiter.get(domain) || 0;
    const now = Date.now();
    
    if (now - lastRequest < this.options.delayMs) {
      const waitTime = this.options.delayMs - (now - lastRequest);
    }
    
    this.rateLimiter.set(domain, now);
  }

  private delay(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, this.options.delayMs));
  }

  private extractLinks($: cheerio.CheerioAPI, source: SourceConfig): string[] {
    const links: string[] = [];
    const baseUrl = new URL(source.url).origin;
    
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      
      try {
        const url = new URL(href, baseUrl);
        if (url.origin === baseUrl && this.isAllowedPath(url.pathname, source)) {
          links.push(url.href);
        }
      } catch {}
    });

    return [...new Set(links)];
  }

  private isAllowedPath(path: string, source: SourceConfig): boolean {
    for (const disallowed of source.disallowedPaths) {
      if (path.startsWith(disallowed)) return false;
    }
    
    for (const allowed of source.allowedPaths) {
      if (path.startsWith(allowed)) return true;
    }
    
    return source.allowedPaths.length === 0;
  }

  private extractSection($: cheerio.CheerioAPI): string | undefined {
    const h2 = $("h2").first().text().trim();
    return h2 || undefined;
  }

  private cleanText(text: string): string {
    return text
      .replace(/\s+/g, " ")
      .replace(/\n+/g, "\n")
      .trim();
  }
}