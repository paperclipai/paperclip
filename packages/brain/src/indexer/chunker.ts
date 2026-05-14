import { encode } from "gpt-tokenizer";

export interface ChunkInput {
  chunkIndex: number;
  headingPath: string[];
  content: string;
  tokenCount: number;
}

export interface ChunkerOpts {
  maxTokens: number;
  overlapTokens: number;
}

interface Block {
  heading: string[];
  content: string;
  tokens: number;
}

function tokenCount(text: string): number {
  return encode(text).length;
}

function splitIntoBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  const headingStack: string[] = [];
  const lines = md.split("\n");
  let buf: string[] = [];

  const flush = () => {
    const content = buf.join("\n").trim();
    if (content.length > 0) {
      blocks.push({
        heading: [...headingStack],
        content,
        tokens: tokenCount(content),
      });
    }
    buf = [];
  };

  let inFence = false;
  for (const line of lines) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    if (!inFence) {
      const h = line.match(/^(#{1,6})\s+(.+)$/);
      if (h) {
        flush();
        const level = h[1]!.length;
        headingStack.splice(level - 1);
        headingStack[level - 1] = h[2]!.trim();
        buf.push(line);
        continue;
      }
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

function splitParagraphsRespectingFences(content: string): string[] {
  const parts: string[] = [];
  const lines = content.split("\n");
  let inFence = false;
  let buf: string[] = [];
  let blanksBeforeBuf = 0;

  for (const line of lines) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    if (!inFence && line.trim() === "") {
      if (buf.length > 0) {
        parts.push(buf.join("\n"));
        buf = [];
      }
      blanksBeforeBuf++;
      continue;
    }
    blanksBeforeBuf = 0;
    buf.push(line);
  }
  if (buf.length > 0) parts.push(buf.join("\n"));
  return parts.filter((p) => p.trim().length > 0);
}

export function chunkMarkdown(md: string, opts: ChunkerOpts): ChunkInput[] {
  if (md.trim().length === 0) return [];

  const blocks = splitIntoBlocks(md);
  const chunks: ChunkInput[] = [];
  let current: { heading: string[]; parts: string[]; tokens: number } | null = null;
  let chunkIndex = 0;

  const pushCurrent = () => {
    if (!current || current.parts.length === 0) return;
    chunks.push({
      chunkIndex: chunkIndex++,
      headingPath: current.heading,
      content: current.parts.join("\n\n"),
      tokenCount: current.tokens,
    });
  };

  const hardSplitParagraph = (p: string): string[] => {
    const words = p.split(/(\s+)/);
    const out: string[] = [];
    let buf: string[] = [];
    let bufTok = 0;
    for (const w of words) {
      const wTok = tokenCount(w);
      if (bufTok + wTok > opts.maxTokens && buf.length > 0) {
        out.push(buf.join(""));
        buf = [w];
        bufTok = wTok;
      } else {
        buf.push(w);
        bufTok += wTok;
      }
    }
    if (buf.length > 0) out.push(buf.join(""));
    return out.map((s) => s.trim()).filter((s) => s.length > 0);
  };

  for (const block of blocks) {
    if (block.tokens > opts.maxTokens) {
      pushCurrent();
      current = null;
      const rawParas = splitParagraphsRespectingFences(block.content);
      const paras: string[] = [];
      for (const p of rawParas) {
        if (tokenCount(p) > opts.maxTokens && !p.includes("```")) {
          paras.push(...hardSplitParagraph(p));
        } else {
          paras.push(p);
        }
      }
      let buf: string[] = [];
      let bufTok = 0;
      for (const p of paras) {
        const pTok = tokenCount(p);
        if (bufTok + pTok > opts.maxTokens && buf.length > 0) {
          chunks.push({
            chunkIndex: chunkIndex++,
            headingPath: block.heading,
            content: buf.join("\n\n"),
            tokenCount: bufTok,
          });
          buf = [p];
          bufTok = pTok;
        } else {
          buf.push(p);
          bufTok += pTok;
        }
      }
      if (buf.length > 0) {
        chunks.push({
          chunkIndex: chunkIndex++,
          headingPath: block.heading,
          content: buf.join("\n\n"),
          tokenCount: bufTok,
        });
      }
      continue;
    }

    if (!current) {
      current = { heading: block.heading, parts: [block.content], tokens: block.tokens };
      continue;
    }

    const sameHeading =
      JSON.stringify(current.heading) === JSON.stringify(block.heading);
    if (current.tokens + block.tokens > opts.maxTokens || !sameHeading) {
      pushCurrent();
      current = { heading: block.heading, parts: [block.content], tokens: block.tokens };
    } else {
      current.parts.push(block.content);
      current.tokens += block.tokens;
    }
  }
  pushCurrent();
  return chunks;
}
