import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeJavaScriptApplication } from "../../support/javascriptApplicationScope.js";
import { parseApplicationGraphEvidence } from "../../../src/application/javascript/JavaScriptApplicationEvidenceGraph.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const analyze = async (root: string) => {
  const result = await analyzeJavaScriptApplication({
    input_path: root,
    format: "directory",
  });
  if (!result.ok) throw result.error;
  const parsed = parseApplicationGraphEvidence(result.value);
  if (!parsed.ok) throw new Error("Analysis Evidence must parse");
  const authenticated = parsed.value;
  return {
    graph: authenticated.graph,
    result: javascriptApplicationAnalysisResultSchema.parse(
      authenticated.evidence.normalized_result,
    ),
  };
};

describe("literal CommonJS paths in application graphs", () => {
  it("agrees with Node for both require projections while preserving ESM suffixes", async () => {
    const root = await createTestTempDirectory("rea-literal-require-");
    const specifier = "./dep.cjs#literal.cjs";
    await Promise.all([
      writeFile(
        join(root, "main.cjs"),
        `const value = require(${JSON.stringify(specifier)}); module.exports = value;`,
      ),
      writeFile(
        join(root, "imports.mjs"),
        `import value from ${JSON.stringify(specifier)}; export { value };`,
      ),
      writeFile(join(root, "dep.cjs"), "module.exports = 'stripped';"),
      writeFile(
        join(root, "dep.cjs#literal.cjs"),
        "module.exports = 'literal';",
      ),
    ]);
    const expected = relative(
      root,
      createRequire(join(root, "main.cjs")).resolve(specifier),
    )
      .split(sep)
      .join("/");
    expect(expected).toBe("dep.cjs#literal.cjs");
    const { graph } = await analyze(root);
    const properties = graph.edges
      .filter((edge) => edge.properties.specifier === specifier)
      .map((edge) => edge.properties);
    expect(properties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          module_link_kind: "require",
          resolved_path: expected,
        }),
        expect.objectContaining({ kind: "require", resolved_path: expected }),
        expect.objectContaining({
          module_link_kind: "import",
          resolved_path: "dep.cjs",
        }),
        expect.objectContaining({
          kind: "static-import",
          resolved_path: "dep.cjs",
        }),
      ]),
    );
    expect(graph.coverage.status).toBe("complete");
  });

  it.each(["literal", "stripped", "both"] as const)(
    "keeps native graph/count projections aligned with %s files",
    async (layout) => {
      const root = await createTestTempDirectory("rea-literal-native-");
      const specifier = "./addon.node#literal.node";
      await Promise.all([
        writeFile(
          join(root, "main.cjs"),
          `const addon = require(${JSON.stringify(specifier)}); module.exports = require(${JSON.stringify(specifier)}); throw new Error('must not execute');`,
        ),
        writeFile(
          join(root, "imports.mjs"),
          `import addon from ${JSON.stringify(specifier)}; export { default } from ${JSON.stringify(specifier)}; throw new Error('must not execute');`,
        ),
        ...(layout !== "stripped"
          ? [
              writeFile(
                join(root, "addon.node#literal.node"),
                Buffer.from([0, 1, 2, 3]),
              ),
            ]
          : []),
        ...(layout !== "literal"
          ? [writeFile(join(root, "addon.node"), Buffer.from([0, 4, 5, 6]))]
          : []),
      ]);
      const { graph, result } = await analyze(root);
      const bindings = graph.nodes
        .filter(({ kind }) => kind === "native-export")
        .flatMap(({ observations }) => observations)
        .map((observation) => ({
          source:
            observation.evidence.location.available &&
            observation.evidence.location.value.kind === "source-range"
              ? observation.evidence.location.value.source
              : null,
          binding: observation.properties.binding_kind,
          path: observation.properties.resolved_path,
        }));
      const required = layout !== "stripped" ? "addon.node#literal.node" : null;
      const imported = layout !== "literal" ? "addon.node" : null;
      expect(bindings).toHaveLength(4);
      expect(bindings).toEqual(
        expect.arrayContaining([
          { source: "main.cjs", binding: "require", path: required },
          { source: "main.cjs", binding: "re-export", path: required },
          { source: "imports.mjs", binding: "import", path: imported },
          { source: "imports.mjs", binding: "re-export", path: imported },
        ]),
      );
      expect(result.summary).toMatchObject({
        native_addon_bindings: 4,
        resolved_native_addon_bindings: layout === "both" ? 4 : 2,
      });
    },
  );
});

describe("present require targets outside the JavaScript projection", () => {
  it("reports an existing bytenode .jsc target as unavailable, not as absent", async () => {
    const present = await createTestTempDirectory("rea-unanalyzed-present-");
    const absent = await createTestTempDirectory("rea-unanalyzed-absent-");
    const main =
      'require("bytenode");\nconst core = require("./core.jsc");\nmodule.exports = { core };';
    // Bytes stand in for V8 bytecode; the projection never reads them.
    const bytecode = Buffer.from([0xde, 0xc0, 0x17, 0x0b, 0x00, 0x01, 0x02]);
    await Promise.all([
      writeFile(join(present, "main.cjs"), main),
      writeFile(join(present, "core.jsc"), bytecode),
      writeFile(join(absent, "main.cjs"), main),
    ]);
    const edgeFor = async (root: string) => {
      const { graph } = await analyze(root);
      const edge = graph.edges.find(
        ({ properties }) =>
          properties.specifier === "./core.jsc" &&
          properties.module_link_kind === "require",
      );
      expect(edge).toBeDefined();
      return edge!;
    };

    const presentEdge = await edgeFor(present);
    expect(presentEdge.properties).toMatchObject({
      resolution_status: "unavailable",
      resolved_path: null,
    });
    const sha256 = createHash("sha256").update(bytecode).digest("hex");
    expect(presentEdge.evidence.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `core.jsc exists in the inventoried artifact container (sha256 ${sha256}, ${String(bytecode.length)} bytes)`,
        ),
      ]),
    );

    const absentEdge = await edgeFor(absent);
    expect(absentEdge.properties).toMatchObject({
      resolution_status: "not-found",
      resolved_path: null,
    });
  });
});
