export interface ChunkOptions {
  chunkSize: number;
  overlap: number;
}

export class TextChunker {
  private chunkSize: number;
  private overlap: number;

  constructor(options: ChunkOptions) {
    this.chunkSize = options.chunkSize;
    this.overlap = options.overlap;
  }

  chunk(text: string): string[] {
    if (!text || text.length === 0) return [];

    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      let end = start + this.chunkSize;
      
      if (end >= text.length) {
        chunks.push(text.slice(start));
        break;
      }

      const periodIndex = text.indexOf(".", end);
      const commaIndex = text.indexOf(",", end);
      const newlineIndex = text.indexOf("\n", end);
      
      let breakIndex = end;
      
      const breakPoints = [periodIndex, commaIndex, newlineIndex].filter(i => i !== -1 && i > start + this.chunkSize / 2);
      
      if (breakPoints.length > 0) {
        breakIndex = Math.min(...breakPoints) + 1;
      }

      chunks.push(text.slice(start, breakIndex));
      start = breakIndex - this.overlap;
      
      if (start <= chunks[chunks.length - 1]?.length) {
        start = chunks[chunks.length - 1]?.length || start;
        break;
      }
    }

    return chunks.filter(c => c.length > 50);
  }
}