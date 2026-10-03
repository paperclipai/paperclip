// core.autocrlf=true checks out both generated files and generator sources as CRLF.
const toLf = (value) => value.replace(/\r\n/g, "\n");

export function matchesGeneratedContent(current, expected) {
  return toLf(current) === toLf(expected);
}
