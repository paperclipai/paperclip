/** Project settings come only from the already archive-authenticated source.
 * --config-file prevents uv from merging operator or system configuration.
 * This extraction supports the pinned upstream table layout, not arbitrary TOML.
 */
export function hermesProvisioningConfig(pyproject) {
  const lines = pyproject.split(/\r?\n/);
  const roots = lines.flatMap((line, index) => line === "[tool.uv]" ? [index] : []);
  if (roots.length !== 1) throw new Error("Hermes pinned source must contain one uv configuration table");
  const body = [];
  for (const line of lines.slice(roots[0] + 1)) {
    if (line.startsWith("[")) {
      if (!line.startsWith("[tool.uv.")) break;
      if (!/^\[tool\.uv\.[a-zA-Z][a-zA-Z0-9_.-]*\]$/.test(line)) throw new Error("Hermes pinned uv table layout is unsupported");
      body.push(line.replace("[tool.uv.", "["));
    } else body.push(line);
  }
  return body.join("\n") + "\n";
}
