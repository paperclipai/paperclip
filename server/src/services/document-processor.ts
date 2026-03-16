/**
 * DocumentProcessor - Parse documents and create semantic chunks
 * Supports: PDF, TXT, Markdown
 */

import { logger } from "../middleware/logger.js";

export interface DocumentChunk {
  index: number;
  content: string;
  tokens: number;
  metadata?: Record<string, unknown>;
}

export interface ProcessedDocument {
  fileName: string;
  contentType: string;
  chunks: DocumentChunk[];
  totalChunks: number;
  totalTokens: number;
}

export class DocumentProcessor {
  private maxChunkSize = 1000; // tokens per chunk
  private chunkOverlap = 100; // tokens of overlap
  private minChunkSize = 50; // minimum tokens

  /**
   * Process a document from buffer
   */
  async processDocument(
    buffer: Buffer,
    fileName: string,
    contentType: string,
  ): Promise<ProcessedDocument> {
    try {
      let text: string;

      // Parse based on content type
      if (contentType === "application/pdf") {
        text = await this.parsePdf(buffer);
      } else if (contentType === "text/plain") {
        text = buffer.toString("utf-8");
      } else if (contentType === "text/markdown") {
        text = buffer.toString("utf-8");
      } else {
        throw new Error(`Unsupported content type: ${contentType}`);
      }

      // Validate extracted text
      if (!text || text.trim().length === 0) {
        throw new Error("Document is empty or could not be parsed");
      }

      // Create semantic chunks
      const chunks = await this.createChunks(text, contentType);

      if (chunks.length === 0) {
        throw new Error("No valid chunks created from document");
      }

      return {
        fileName,
        contentType,
        chunks,
        totalChunks: chunks.length,
        totalTokens: chunks.reduce((sum, c) => sum + c.tokens, 0),
      };
    } catch (error: any) {
      logger.error(`Error processing document ${fileName}: ${error?.message}`);
      throw error;
    }
  }

  /**
   * Parse PDF using a simple text extraction approach
   * In production, use: pdfjs-dist, pdf2json, or similar
   */
  private async parsePdf(buffer: Buffer): Promise<string> {
    // For MVP, we'll implement basic PDF text extraction
    // Production implementation would use pdfjs-dist or pdf-parse
    try {
      // Try to extract text as UTF-8
      let text = buffer.toString("utf-8", 0, buffer.length);

      // Remove binary markers and clean up
      text = text
        .replace(/[^\x20-\x7E\n\r\t]/g, " ") // Remove non-ASCII except whitespace
        .replace(/\s+/g, " ") // Collapse whitespace
        .trim();

      return text;
    } catch (error) {
      throw new Error("Failed to parse PDF file");
    }
  }

  /**
   * Create semantic chunks with overlap
   */
  private async createChunks(text: string, contentType: string): Promise<DocumentChunk[]> {
    const chunks: DocumentChunk[] = [];

    // Split into paragraphs for semantic awareness
    const paragraphs =
      contentType === "text/markdown" ? this.splitMarkdown(text) : this.splitParagraphs(text);

    let currentChunk = "";
    let currentTokens = 0;
    let chunkIndex = 0;

    for (const paragraph of paragraphs) {
      const paragraphTokens = this.estimateTokens(paragraph);

      // If adding this paragraph exceeds max, start a new chunk
      if (currentTokens + paragraphTokens > this.maxChunkSize && currentChunk.length > 0) {
        // Save current chunk
        chunks.push({
          index: chunkIndex,
          content: currentChunk.trim(),
          tokens: currentTokens,
          metadata: {
            type: "semantic",
            hasOverlap: chunkIndex > 0,
          },
        });

        chunkIndex++;

        // Keep overlap
        const overlapTokens = Math.min(currentTokens, this.chunkOverlap);
        const overlapText = this.extractOverlap(currentChunk, overlapTokens);
        currentChunk = overlapText + "\n\n" + paragraph;
        currentTokens = this.estimateTokens(currentChunk);
      } else {
        // Add to current chunk
        if (currentChunk) {
          currentChunk += "\n\n" + paragraph;
        } else {
          currentChunk = paragraph;
        }
        currentTokens += paragraphTokens;
      }
    }

    // Add final chunk
    if (currentChunk.trim().length > 0 && currentTokens >= this.minChunkSize) {
      chunks.push({
        index: chunkIndex,
        content: currentChunk.trim(),
        tokens: currentTokens,
        metadata: {
          type: "semantic",
          hasOverlap: chunkIndex > 0,
        },
      });
    }

    return chunks;
  }

  /**
   * Split text into paragraphs (double newline)
   */
  private splitParagraphs(text: string): string[] {
    return text
      .split(/\n\s*\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }

  /**
   * Split Markdown preserving structure
   */
  private splitMarkdown(text: string): string[] {
    const sections: string[] = [];
    const lines = text.split("\n");

    let currentSection = "";

    for (const line of lines) {
      // Headers start new sections
      if (line.startsWith("#")) {
        if (currentSection) {
          sections.push(currentSection.trim());
        }
        currentSection = line;
      } else if (line.trim().length === 0) {
        // Preserve paragraph breaks
        if (currentSection) {
          currentSection += "\n" + line;
        }
      } else {
        currentSection += "\n" + line;
      }
    }

    if (currentSection) {
      sections.push(currentSection.trim());
    }

    return sections.filter((s) => s.length > 0);
  }

  /**
   * Estimate token count (simple heuristic: word count / 1.3)
   * Production would use: js-tiktoken or similar
   */
  private estimateTokens(text: string): number {
    const words = text.split(/\s+/).length;
    return Math.ceil(words / 1.3); // Approximate tokens
  }

  /**
   * Extract overlap text (keep end of chunk for context)
   */
  private extractOverlap(text: string, targetTokens: number): string {
    const sentences = text.split(/(?<=[.!?])\s+/);
    let overlap = "";
    let tokens = 0;

    for (let i = sentences.length - 1; i >= 0 && tokens < targetTokens; i--) {
      overlap = sentences[i] + " " + overlap;
      tokens = this.estimateTokens(overlap);
    }

    return overlap.trim();
  }

  /**
   * Validate document before processing
   */
  validateDocument(
    buffer: Buffer,
    fileName: string,
    contentType: string,
    maxSizeMb = 100,
  ): { valid: boolean; error?: string } {
    // Check file size
    const sizeMb = buffer.length / (1024 * 1024);
    if (sizeMb > maxSizeMb) {
      return { valid: false, error: `File too large: ${sizeMb.toFixed(2)}MB (max ${maxSizeMb}MB)` };
    }

    // Check content type
    const supportedTypes = ["application/pdf", "text/plain", "text/markdown"];
    if (!supportedTypes.includes(contentType)) {
      return { valid: false, error: `Unsupported file type: ${contentType}` };
    }

    // Check file extension
    const ext = fileName.split(".").pop()?.toLowerCase();
    const validExts = ["pdf", "txt", "md"];
    if (!ext || !validExts.includes(ext)) {
      return { valid: false, error: `Unsupported file extension: .${ext}` };
    }

    return { valid: true };
  }
}

/**
 * Singleton instance
 */
export function getDocumentProcessor(): DocumentProcessor {
  return new DocumentProcessor();
}
