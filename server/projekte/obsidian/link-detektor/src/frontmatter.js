/**
 * Simple YAML frontmatter parser for Obsidian notes.
 * Parses the YAML between --- delimiters and returns the parsed object and body.
 * @param {string} raw - The raw markdown content with optional frontmatter
 * @returns {{ frontmatter: Record<string, unknown>; body: string }} - Parsed frontmatter and body
 */
export function parseFM(raw) {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const closing = normalized.indexOf('\n---\n', 4);
  if (closing < 0) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const frontmatterRaw = normalized.slice(4, closing).trim();
  const body = normalized.slice(closing + 5).trim();

  try {
    const frontmatter = parseYaml(frontmatterRaw);
    return { frontmatter: frontmatter || {}, body };
  } catch (e) {
    // If YAML parsing fails, return empty frontmatter
    return { frontmatter: {}, body };
  }
}

/**
 * Simple YAML parser for basic Obsidian frontmatter.
 * Handles strings, numbers, booleans, arrays, and nested objects.
 */
function parseYaml(yamlStr) {
  const lines = yamlStr.split('\n');
  const result = {};
  let currentKey = null;
  let currentArray = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Check for array item
    if (trimmed.startsWith('- ')) {
      if (currentArray !== null) {
        currentArray.push(parseValue(trimmed.slice(2)));
      }
      continue;
    }

    // Parse key: value
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      const key = trimmed.substring(0, colonIndex).trim();
      let value = trimmed.substring(colonIndex + 1).trim();

      // Check for inline array [item1, item2]
      if (value.startsWith('[') && value.endsWith(']')) {
        const itemsStr = value.slice(1, -1);
        currentArray = null;
        result[key] = itemsStr.split(',').map(item => parseValue(item.trim()));
        continue;
      }

      // Check for nested object (indented content follows)
      if (value === '' || value === '|' || value === '>') {
        // This might be a multi-line string or nested object
        currentKey = key;
        result[key] = '';
        currentArray = null;
        continue;
      }

      currentArray = null;
      result[key] = parseValue(value);
    } else if (currentKey && line.startsWith('  ')) {
      // Multi-line value continuation
      result[currentKey] += '\n' + line;
    }
  }

  return result;
}

/**
 * Parse a YAML value into JavaScript type.
 */
function parseValue(value) {
  if (!value) return '';

  // Remove quotes
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  // Boolean
  if (value === 'true') return true;
  if (value === 'false') return false;

  // Number
  if (!isNaN(value) && value !== '') {
    const num = Number(value);
    if (!isNaN(num)) return num;
  }

  // Null/none
  if (value === 'null' || value === '~' || value === 'None') return null;

  return value;
}
