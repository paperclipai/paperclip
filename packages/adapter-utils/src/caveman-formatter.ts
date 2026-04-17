export interface CavemanOptions {
  intensity: 'lite' | 'full' | 'ultra';
  preserveCodeBlocks: boolean;
  preserveJsonOutput: boolean;
}

export function formatCaveman(
  text: string,
  options: CavemanOptions = { intensity: 'full', preserveCodeBlocks: true, preserveJsonOutput: true }
): string {
  if (options.intensity === 'lite') {
    return formatCavemanLite(text, options);
  } else if (options.intensity === 'ultra') {
    return formatCavemanUltra(text, options);
  } else {
    return formatCavemanFull(text, options);
  }
}

function formatCavemanLite(text: string, options: CavemanOptions): string {
  // Remove obvious fillers only
  // ~30-40% token reduction

  let result = text;

  // Remove conversational fillers
  result = result.replace(/\b(I'd be happy to|I'd be glad to|Sure thing|Sure!|Let me|Feel free to|Certainly|Of course|Absolutely)\b/gi, '');

  // Remove transition phrases
  result = result.replace(/\b(The reason is that|This is happening is likely because|The reason is that|Furthermore|Additionally|In other words|Moreover)\b/gi, '');

  // Clean up spaces
  result = result.replace(/\s+/g, ' ').trim();

  return result;
}

function formatCavemanFull(text: string, options: CavemanOptions): string {
  // Full caveman rules
  // ~60-65% token reduction

  let result = text;

  // Preserve code blocks if requested
  const codeBlocks: string[] = [];
  if (options.preserveCodeBlocks) {
    result = result.replace(/```[\s\S]*?```/g, (match) => {
      codeBlocks.push(match);
      return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
    });
  }

  // Preserve JSON if requested
  const jsonBlocks: string[] = [];
  if (options.preserveJsonOutput) {
    result = result.replace(/\{[\s\S]*?\}/g, (match) => {
      try {
        JSON.parse(match); // Validate it's JSON
        jsonBlocks.push(match);
        return `__JSON_BLOCK_${jsonBlocks.length - 1}__`;
      } catch {
        return match; // Not valid JSON, leave as is
      }
    });
  }

  // Remove conversational fillers
  result = result.replace(/\b(I'd be happy to|I'd be glad to|Sure thing|Sure!|Let me|(Let me )?see|Feel free to|Certainly|Of course|Absolutely)\b/gi, '');

  // Remove transition phrases
  result = result.replace(/\b(The reason is that|This is happening is likely because|This is happening because|The reason is that|Furthermore|Additionally|In other words|Moreover|However|Therefore|Thus|Hence|Consequently)\b/gi, '');

  // Remove articles
  result = result.replace(/\b(a|an|the)\b/gi, '');

  // Replace phrases with symbols
  result = result.replace(/\bleads to\b/gi, '→');
  result = result.replace(/\bresults in\b/gi, '→');
  result = result.replace(/\bcauses\b/gi, '→');
  result = result.replace(/\bdue to\b/gi, '→');
  result = result.replace(/\bbecause of\b/gi, '→');
  result = result.replace(/\bis likely because\b/gi, 'because');
  result = result.replace(/\bshould be\b/gi, 'is');
  result = result.replace(/\bneeds to be\b/gi, 'is');

  // Use abbreviations
  result = result.replace(/\btechnology\b/gi, 'tech');
  result = result.replace(/\bimplementation\b/gi, 'impl');
  result = result.replace(/\bconfiguration\b/gi, 'config');
  result = result.replace(/\benvironment\b/gi, 'env');
  result = result.replace(/\bdevelopment\b/gi, 'dev');
  result = result.replace(/\bproduction\b/gi, 'prod');
  result = result.replace(/\bfunction\b/gi, 'fn');
  result = result.replace(/\bvariable\b/gi, 'var');
  result = result.replace(/\bparameter\b/gi, 'param');

  // Remove explanatory phrases
  result = result.replace(/\bwhich means\b/gi, '');
  result = result.replace(/\bthat means\b/gi, '');
  result = result.replace(/\bthis means\b/gi, '');
  result = result.replace(/\bfor example\b/gi, 'e.g.');
  result = result.replace(/\bthat is\b/gi, 'i.e.');
  result = result.replace(/\bthis is\b/gi, '');
  result = result.replace(/\bthe reason\b/gi, 'reason');
  result = result.replace(/\byou\b/gi, '');

  // Clean up spaces
  result = result.replace(/\s+/g, ' ').trim();

  // Restore code blocks
  codeBlocks.forEach((block, i) => {
    result = result.replace(`__CODE_BLOCK_${i}__`, block);
  });

  // Restore JSON blocks
  jsonBlocks.forEach((block, i) => {
    result = result.replace(`__JSON_BLOCK_${i}__`, block);
  });

  return result;
}

function formatCavemanUltra(text: string, options: CavemanOptions): string {
  // Aggressive compression + symbols
  // ~75% token reduction but less readable

  let result = formatCavemanFull(text, options);

  // Additional aggressive rules
  result = result.replace(/\b(if you)\b/gi, '');
  result = result.replace(/\b(please)\b/gi, '');
  result = result.replace(/\b(can you)\b/gi, '');
  result = result.replace(/\b(would you)\b/gi, '');
  result = result.replace(/\b(could you)\b/gi, '');

  // Use more symbols
  result = result.replace(/\b(done|completed|finished)\b/gi, '✓');
  result = result.replace(/\b(failed|error|failed)\b/gi, '✗');
  result = result.replace(/\b(and)\b/gi, '&');
  result = result.replace(/\b(or)\b/gi, '|');
  result = result.replace(/\b(with)\b/gi, 'w/');
  result = result.replace(/\b(without)\b/gi, 'w/o');

  // Remove more articles and helpers
  result = result.replace(/\b(to|in|on|at|by|for|from|into|onto|upon)\b/gi, '');

  // Clean up again
  result = result.replace(/\s+/g, ' ').trim();

  return result;
}