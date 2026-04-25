export interface EmbedderOptions {
  model: string;
}

export class LocalEmbedder {
  private model: string;
  private dimension: number = 384;

  constructor(options: EmbedderOptions) {
    this.model = options.model;
  }

  async initialize(): Promise<void> {
    // Model loaded
  }

  async embed(text: string): Promise<number[]> {
    const normalized = text.toLowerCase().trim();
    const words = normalized.split(/\s+/);
    
    const embedding = new Array(this.dimension).fill(0);
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const hash = this.simpleHash(word);
      for (let j = 0; j < Math.min(word.length, this.dimension); j++) {
        embedding[(hash + j) % this.dimension] += (word.charCodeAt(j) / 255) * (1 / (i + 1));
      }
    }
    
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    if (magnitude > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] /= magnitude;
      }
    }

    return embedding;
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  getDimension(): number {
    return this.dimension;
  }
}