/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies are a code smell",
      from: {},
      to: { circular: true }
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment: "Orphan modules are possibly dead code",
      from: { orphan: true, pathNot: ["\\.d\\.ts$", "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$"] },
      to: {}
    },
    {
      name: "no-cross-package-private",
      severity: "error",
      comment: "Don't import from deep internal paths of other packages",
      from: { path: "^packages/([^/]+)/" },
      to: { path: "^packages/([^/]+)/src/", pathNot: "^packages/$1/" }
    }
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"]
    }
  }
}
