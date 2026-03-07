import { PolyticianMCPClient, type MCPServerConfig } from './mcp-client.js';

export interface EnrichmentConfig {
  mcpServer: MCPServerConfig;
  maxContextLength?: number;
  topK?: number;
  minRelevanceScore?: number;
}

export interface EnrichmentResult {
  enrichedPrompt: string;
  conceptsUsed: ConceptReference[];
  contextLength: number;
  truncated: boolean;
}

export interface ConceptReference {
  id: string;
  name: string;
  relevanceScore?: number;
}

interface SearchConceptsResult {
  concepts: Array<{
    id: string;
    name: string;
    score?: number;
  }>;
}

interface ReadConceptResult {
  id: string;
  name: string;
  content: string;
  representation?: string;
  metadata?: Record<string, unknown>;
}

export async function enrichWithPolyticianContext(
  prompt: string,
  config: EnrichmentConfig
): Promise<EnrichmentResult> {
  const { mcpServer, maxContextLength = 8000, topK = 5, minRelevanceScore = 0.3 } = config;

  const client = new PolyticianMCPClient(mcpServer);
  const conceptsUsed: ConceptReference[] = [];

  try {
    await client.connect();

    const searchResult = await client.callTool('search_concepts', {
      query: prompt,
      limit: topK,
      min_score: minRelevanceScore,
    });

    const searchData = searchResult.content[0]?.data as SearchConceptsResult | undefined;
    const matchedConcepts = searchData?.concepts ?? [];

    if (matchedConcepts.length === 0) {
      return {
        enrichedPrompt: prompt,
        conceptsUsed: [],
        contextLength: prompt.length,
        truncated: false,
      };
    }

    const conceptContexts: string[] = [];
    let totalContextLength = 0;

    for (const concept of matchedConcepts.slice(0, topK)) {
      try {
        const readResult = await client.callTool('read_concept', {
          id: concept.id,
        });

        const conceptData = readResult.content[0]?.data as ReadConceptResult | undefined;
        
        if (conceptData?.content) {
          const conceptBlock = formatConceptBlock(conceptData);
          const blockLength = conceptBlock.length;

          if (totalContextLength + blockLength > maxContextLength - prompt.length - 500) {
            break;
          }

          conceptContexts.push(conceptBlock);
          totalContextLength += blockLength;
          conceptsUsed.push({
            id: concept.id,
            name: concept.name,
            relevanceScore: concept.score,
          });
        }
      } catch {
        // Skip concepts that fail to read
      }
    }

    await client.disconnect();

    if (conceptContexts.length === 0) {
      return {
        enrichedPrompt: prompt,
        conceptsUsed: [],
        contextLength: prompt.length,
        truncated: false,
      };
    }

    const contextHeader = `## Semantic Memory Context\n\nThe following concepts from the knowledge base are relevant to your task:\n\n`;
    const contextFooter = `\n---\n\n## Task\n\n`;
    
    let enrichedPrompt = contextHeader + conceptContexts.join('\n\n') + contextFooter + prompt;

    const truncated = enrichedPrompt.length > maxContextLength;
    if (truncated) {
      enrichedPrompt = enrichedPrompt.slice(0, maxContextLength - 3) + '...';
    }

    return {
      enrichedPrompt,
      conceptsUsed,
      contextLength: enrichedPrompt.length,
      truncated,
    };
  } catch (error) {
    await client.disconnect();
    throw error;
  }
}

function formatConceptBlock(concept: ReadConceptResult): string {
  const lines: string[] = [];
  
  lines.push(`### ${concept.name || 'Unnamed Concept'}`);
  lines.push(`ID: ${concept.id}`);
  
  if (concept.representation) {
    lines.push(`Type: ${concept.representation}`);
  }
  
  lines.push('');
  
  const contentPreview = concept.content.length > 1000
    ? concept.content.slice(0, 1000) + '...'
    : concept.content;
  lines.push(contentPreview);
  
  return lines.join('\n');
}

export async function saveConceptFromOrchestration(
  sessionId: string,
  task: string,
  result: string,
  filesChanged: string[],
  mcpServer: MCPServerConfig
): Promise<string | null> {
  const client = new PolyticianMCPClient(mcpServer);

  try {
    await client.connect();

    const conceptContent = buildConceptContent(sessionId, task, result, filesChanged);

    const saveResult = await client.callTool('save_concept', {
      name: `orchestration-${sessionId}`,
      content: conceptContent,
      representation: 'orchestration_result',
      metadata: {
        sessionId,
        timestamp: new Date().toISOString(),
        filesChangedCount: filesChanged.length,
      },
    });

    await client.disconnect();

    const savedData = saveResult.content[0]?.data as { id?: string } | undefined;
    return savedData?.id ?? null;
  } catch {
    await client.disconnect();
    return null;
  }
}

function buildConceptContent(
  sessionId: string,
  task: string,
  result: string,
  filesChanged: string[]
): string {
  const lines: string[] = [
    `# Orchestration Result: ${sessionId}`,
    '',
    `## Task`,
    task,
    '',
    `## Files Changed`,
    ...filesChanged.map(f => `- ${f}`),
    '',
    `## Result`,
    result.slice(0, 4000),
  ];

  return lines.join('\n');
}
