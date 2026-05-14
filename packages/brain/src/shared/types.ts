export interface Note {
  id: string;
  path: string;
  folder: string;
  title: string | null;
  frontmatter: Record<string, unknown>;
  mtime: Date;
  sizeBytes: number;
  checksum: string;
}

export interface ParsedNote {
  path: string;
  folder: string;
  title: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
  mtime: Date;
  sizeBytes: number;
  checksum: string;
}

export interface Chunk {
  noteId: string;
  chunkIndex: number;
  headingPath: string[];
  content: string;
  tokenCount: number;
}

export interface ChunkWithEmbedding extends Chunk {
  embedding: number[];
}

export interface SearchHit {
  path: string;
  title: string | null;
  headingPath: string[];
  content: string;
  score: number;
  folder: string;
  frontmatter: Record<string, unknown>;
}

export interface AclEntry {
  agentId: string;
  allowedFolders: string[];
  description: string | null;
}
