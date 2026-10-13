import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";

const resolvedPatterns = [
  ["#internal/util", "src/util.mjs"],
  ["#exact", "exact.cjs"],
  ["fixture/other", "node_modules/fixture/dist/other.js"],
  // The exact key wins even though the pattern target also exists on disk.
  ["fixture/feature", "node_modules/fixture/exact-feature.js"],
] as const;

const requireSource = [
  'const util = require("#internal/util");',
  'const exact = require("#exact");',
  'const other = require("fixture/other");',
  'const feature = require("fixture/feature");',
  'const escape = require("#internal/../escape");',
  "module.exports = 1;",
].join("\n");
const importSource = [
  'import util from "#internal/util";',
  'import exact from "#exact";',
  'import other from "fixture/other";',
  'import feature from "fixture/feature";',
  'import escape from "#internal/../escape";',
  "export default 1;",
].join("\n");

const createPatternFixture = async () => {
  const root = await createTestTempDirectory("rea-package-pattern-keys-");
  const files = {
    "package.json": JSON.stringify({
      name: "app",
      imports: {
        "#exact": "./exact.cjs",
        "#internal/*": "./src/*.mjs",
      },
    }),
    "main.cjs": requireSource,
    "main.mjs": importSource,
    "exact.cjs": "module.exports = 'exact';",
    "src/util.mjs": "export default 'util';",
    "node_modules/fixture/package.json": JSON.stringify({
      name: "fixture",
      exports: {
        "./feature": "./exact-feature.js",
        "./*": "./dist/*.js",
      },
    }),
    "node_modules/fixture/exact-feature.js":
      "module.exports = 'exact-feature';",
    "node_modules/fixture/dist/feature.js": "module.exports = 'shadowed';",
    "node_modules/fixture/dist/other.js": "module.exports = 'other';",
  };
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const absolute = join(root, path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    }),
  );
  return root;
};

// Windows needs the bundled native controls for JavaScript analysis, and that
// artifact is cross-built on Linux; CI runs the full lane there.
cliTest.skipIf(process.platform === "win32").for(["CLI", "stdio MCP"] as const)(
  "resolves package wildcard pattern keys through %s",
  async (surface, { cli }) => {
    const root = await createPatternFixture();
    const nativeRequire = createRequire(join(root, "main.cjs"));
    for (const [specifier, resolved] of resolvedPatterns)
      expect(
        relative(root, nativeRequire.resolve(specifier)).replaceAll("\\", "/"),
      ).toBe(resolved);
    expect(() => nativeRequire.resolve("#internal/../escape")).toThrow();

    const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
    for (const [specifier, resolved] of resolvedPatterns)
      for (const moduleKind of ["require", "import"] as const)
        expect(graph.edges).toContainEqual(
          expect.objectContaining({
            properties: expect.objectContaining({
              module_link_kind: moduleKind,
              specifier,
              resolved_path: resolved,
              resolution_status: "resolved",
            }),
          }),
        );
    for (const moduleKind of ["require", "import"] as const)
      expect(graph.edges).toContainEqual(
        expect.objectContaining({
          properties: expect.objectContaining({
            module_link_kind: moduleKind,
            specifier: "#internal/../escape",
            resolved_path: null,
            resolution_status: "rejected",
          }),
        }),
      );
  },
);
