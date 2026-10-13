import { createHash } from "node:crypto";
import { expect } from "vitest";
import type { analyzeJavaScriptDirectory } from "../support/cli/javascriptApplication.js";

const inlineSource = [
  'type Imported = import("cts-package", { with: { "resolution-mode": "import" } }).ImportOnly;',
  'type Required = import("cts-package", { with: { "resolution-mode": "require" } }).RequireOnly;',
  'type Nested = import("cts-package", { with: { "resolution-mode": "import" } }).Shapes.ImportOnly;',
  'const nested: Nested = { source: "nested-import" };',
  'type ExportedNamespace = import("./reexport.cjs").Types.ImportOnly;',
  'const namespace: ExportedNamespace = { source: "import" };',
  'const first: Imported = { source: "import" };',
  'const second: Required = { source: "require" };',
  "console.log(JSON.stringify([first.source, second.source, nested.source, namespace.source]));",
].join("\n");
const recoveredSource = [
  'type Valid = import("cts-package", { with: { "resolution-mode": "import" } }).ImportOnly;',
  "type Broken = import(Unknown).T;",
].join("\n");
const sameSource = [
  'import type { SameType as First } from "same-mode" with { "resolution-mode": "import" };',
  'import type { SameType as Second } from "same-mode" with { "resolution-mode": "require" };',
].join("\n");
const unresolvedSource = [
  'import type { Missing as First } from "missing-mode" with { "resolution-mode": "import" };',
  'import type { Missing as Second } from "missing-mode" with { "resolution-mode": "require" };',
].join("\n");
const nativeSource = [
  'import type { NativeMode as Required } from "native-mode/addon.node" with { "resolution-mode": "require" };',
  'import type { NativeMode as Imported } from "native-mode/addon.node" with { "resolution-mode": "import" };',
  'export type { NativeMode as NativeReexport } from "native-mode/addon.node" with { "resolution-mode": "require" };',
  'export type * from "native-mode/addon.node" with { "resolution-mode": "import" };',
  'type InlineRequired = import("native-mode/addon.node", { with: { "resolution-mode": "require" } }).NativeMode;',
  'type InlineImported = import("native-mode/addon.node", { with: { "resolution-mode": "import" } }).NativeMode;',
  'type NestedNative = import("native-mode/addon.node", { with: { "resolution-mode": "import" } }).Shapes.NativeMode;',
  'type NativeNamespace = typeof import("native-mode/addon.node", { with: { "resolution-mode": "require" } });',
  'const first: Required = { source: "require" };',
  'const second: Imported = { source: "import" };',
  'const third: InlineRequired = { source: "require" };',
  'const fourth: InlineImported = { source: "import" };',
  'const nested: NestedNative = { source: "import" };',
  "const namespace: NativeNamespace = {}; void namespace;",
  "console.log(JSON.stringify([first.source, second.source, third.source, fourth.source, nested.source]));",
].join("\n");
const nativeDefaultSource = (mode: "import" | "require") =>
  [
    'type DefaultNative = import("native-mode/addon.node").NativeMode;',
    `const value: DefaultNative = { source: "${mode}" };`,
    "console.log(JSON.stringify(value.source));",
  ].join("\n");

const nativeMixedSource = [
  'import { type NativeMode as NativeType, NativeMode as runtimeNative } from "native-mixed/addon.node";',
  'export { type NativeMode as NativeTypeExport, NativeMode as runtimeNativeExport } from "native-mixed/addon.node";',
  "console.log(runtimeNative);",
].join("\n");
const nativeInlineOnlySource = [
  'import { type NativeMode } from "native-mixed/addon.node";',
  'export { type NativeMode as NativeTypeExport } from "native-mixed/addon.node";',
].join("\n");
const nativeImportEqualsSource = [
  'import type Native = require("native-mode/addon.node");',
  'const value: Native.NativeMode = { source: "require" };',
  "console.log(JSON.stringify(value.source));",
].join("\n");
const nativeIndexedSource = [
  'type Plain = (typeof import("native-mixed/addon.node"))["NativeMode"];',
  'type Punctuated = (typeof import("native-mixed/addon.node"))["Native.Mode"];',
  'type Empty = (typeof import("native-mixed/addon.node"))[""];',
  'const first: Plain = { source: "import" };',
  'const second: Punctuated = { source: "import" };',
  'const third: Empty = { source: "import" };',
  "console.log(JSON.stringify([first.source, second.source, third.source]));",
].join("\n");

export const modeSourceFiles = {
  "cts/inline.cts": inlineSource,
  "cts/script.ts": inlineSource,
  "cts/same.cts": sameSource,
  "cts/unresolved.cts": unresolvedSource,
  "cts/native.mts": nativeSource,
  "cts/recovered.cts": recoveredSource,
  "cts/native-default.cts": nativeDefaultSource("require"),
  "cts/native-default.mts": nativeDefaultSource("import"),
  "cts/native-default.ts": nativeDefaultSource("require"),
  "cts/native-mixed.mts": nativeMixedSource,
  "cts/native-inline-only.mts": nativeInlineOnlySource,
  "cts/native-import-equals.cts": nativeImportEqualsSource,
  "cts/native-import-equals.mts": nativeImportEqualsSource,
  "cts/native-indexed.mts": nativeIndexedSource,
};

export const modePackageFiles = {
  "node_modules/native-mixed/package.json": JSON.stringify({
    exports: {
      "./addon.node": {
        import: { types: "./addon.d.mts", default: "./addon.node" },
      },
    },
  }),
  "node_modules/native-mixed/addon.d.mts":
    'export interface NativeMode { source: "import"; } export const NativeMode: NativeMode; export { NativeMode as "Native.Mode", NativeMode as "" };',
  "node_modules/native-mixed/addon.node": "source-owned native placeholder",
  "node_modules/same-mode/package.json": JSON.stringify({
    exports: { import: "./both.js", require: "./both.js" },
  }),
  "node_modules/same-mode/both.js": "module.exports = {};",
  "node_modules/same-mode/both.d.ts": "export interface SameType {}",
  "node_modules/native-mode/package.json": JSON.stringify({
    exports: {
      "./addon.node": {
        require: { types: "./require.d.cts", default: "./require.node" },
        import: { types: "./import.d.mts", default: "./import.node" },
      },
    },
  }),
  "node_modules/native-mode/require.d.cts":
    'export interface NativeMode { source: "require"; } export namespace Shapes { interface NativeMode { source: "require"; } }',
  "node_modules/native-mode/import.d.mts":
    'export interface NativeMode { source: "import"; } export namespace Shapes { interface NativeMode { source: "import"; } }',
  // Opaque inventory fixtures: resolve their paths, never execute native code.
  "node_modules/native-mode/require.node": "source-owned native placeholder",
  "node_modules/native-mode/import.node": "source-owned native placeholder",
};

export const expectReviewModeEvidence = (
  graph: Awaited<ReturnType<typeof analyzeJavaScriptDirectory>>["graph"],
): void => {
  for (const [source, text] of [
    ["cts/same.cts", sameSource],
    ["cts/unresolved.cts", unresolvedSource],
  ] as const) {
    expect
      .soft(
        graph.edges.filter(
          ({ relation, evidence }) =>
            (relation === "imports" || relation === "loads") &&
            evidence.location.available &&
            evidence.location.value.kind === "source-range" &&
            evidence.location.value.source === source,
        ),
      )
      .toEqual([]);
    expect
      .soft(graph.nodes.flatMap(({ observations }) => observations))
      .toContainEqual(
        expect.objectContaining({
          properties: expect.objectContaining({
            semantic_role: "source-module",
            path: source,
            import_relationships: 0,
            type_relationships: 2,
          }),
          evidence: expect.objectContaining({
            artifact: expect.objectContaining({
              sha256: createHash("sha256").update(text).digest("hex"),
            }),
          }),
        }),
      );
  }
  for (const source of [
    "cts/native.mts",
    "cts/native-default.cts",
    "cts/native-default.mts",
    "cts/native-default.ts",
    "cts/native-import-equals.cts",
    "cts/native-import-equals.mts",
    "cts/native-indexed.mts",
  ])
    expect
      .soft(
        graph.edges.filter(
          ({ relation, evidence }) =>
            (relation === "imports" ||
              relation === "exposes" ||
              relation === "loads") &&
            evidence.location.available &&
            evidence.location.value.kind === "source-range" &&
            evidence.location.value.source === source,
        ),
      )
      .toEqual([]);
  expectNativeMixedEvidence(graph);
  expectNativeTypeSelections(graph);
  expectInlineTypeEvidence(graph);
  expectNativeDefaultEvidence(graph);
  expectRecoveredTypeEvidence(graph);
  expect(
    graph.nodes.flatMap(({ observations }) => observations),
  ).toContainEqual(
    expect.objectContaining({
      properties: expect.objectContaining({
        specifier: "native-mode/addon.node",
        module_kind: "compiler-dependent",
        type_only: true,
        resolved_path: null,
        conditional_resolutions: expect.arrayContaining([
          expect.objectContaining({
            mode: "import",
            resolution_status: "resolved",
            resolved_path: "node_modules/native-mode/import.node",
          }),
          expect.objectContaining({
            mode: "require",
            resolution_status: "resolved",
            resolved_path: "node_modules/native-mode/require.node",
          }),
        ]),
        requested_members: ["NativeMode"],
      }),
      evidence: expect.objectContaining({
        location: expect.objectContaining({
          value: expect.objectContaining({ source: "cts/native-default.ts" }),
        }),
      }),
    }),
  );
  const native = graph.nodes
    .flatMap(({ observations }) => observations)
    .filter(
      ({ properties, evidence }) =>
        properties.specifier === "native-mode/addon.node" &&
        "native_export_verification" in properties &&
        evidence.location.available &&
        evidence.location.value.kind === "source-range" &&
        evidence.location.value.source === "cts/native.mts",
    );
  for (const [line, mode] of [
    [1, "require"],
    [2, "import"],
    [3, "require"],
    [4, "import"],
    [5, "require"],
    [6, "import"],
    [7, "import"],
    [8, "require"],
  ] as const)
    expect.soft(native).toContainEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          resolved_path: `node_modules/native-mode/${mode}.node`,
          native_export_verification: "not-performed",
          type_only: true,
          module_kind: mode,
          ...nativeQualifierProperties(line),
        }),
        evidence: expect.objectContaining({
          artifact: expect.objectContaining({
            sha256: createHash("sha256").update(nativeSource).digest("hex"),
          }),
          location: expect.objectContaining({
            value: expect.objectContaining({
              start: expect.objectContaining({ line }),
            }),
          }),
        }),
      }),
    );
};

const expectNativeDefaultEvidence = (
  graph: Awaited<ReturnType<typeof analyzeJavaScriptDirectory>>["graph"],
): void => {
  for (const [file, mode] of [
    ["native-default.cts", "require"],
    ["native-default.mts", "import"],
  ] as const) {
    const observations = graph.nodes
      .flatMap(({ observations }) => observations)
      .filter(
        ({ properties, evidence }) =>
          properties.specifier === "native-mode/addon.node" &&
          "native_export_verification" in properties &&
          evidence.location.available &&
          evidence.location.value.kind === "source-range" &&
          evidence.location.value.source === `cts/${file}`,
      );
    expect.soft(observations).toMatchObject([
      {
        properties: {
          resolved_path: `node_modules/native-mode/${mode}.node`,
          requested_members: ["NativeMode"],
          native_export_verification: "not-performed",
          type_only: true,
          module_kind: mode,
        },
        evidence: {
          artifact: {
            sha256: createHash("sha256")
              .update(nativeDefaultSource(mode))
              .digest("hex"),
          },
          location: { value: { start: { line: 1 } } },
        },
      },
    ]);
  }
};

const nativeQualifierProperties = (line: number) => {
  if (line === 5 || line === 6) return { requested_members: ["NativeMode"] };
  if (line === 7)
    return { requested_members: ["Shapes"], namespace_access: false };
  if (line === 8) return { requested_members: [], namespace_access: true };
  return {};
};

const expectInlineTypeEvidence = (
  graph: Awaited<ReturnType<typeof analyzeJavaScriptDirectory>>["graph"],
): void => {
  for (const source of ["cts/inline.cts", "cts/script.ts"])
    expect
      .soft(
        graph.edges.filter(
          ({ relation, evidence }) =>
            (relation === "imports" || relation === "loads") &&
            evidence.location.available &&
            evidence.location.value.kind === "source-range" &&
            evidence.location.value.source === source,
        ),
      )
      .toEqual([]);
};

const expectRecoveredTypeEvidence = (
  graph: Awaited<ReturnType<typeof analyzeJavaScriptDirectory>>["graph"],
): void => {
  expect.soft(graph.coverage.status).toBe("partial");
  expect
    .soft(graph.nodes.flatMap(({ observations }) => observations))
    .toContainEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          path: "cts/recovered.cts",
          parse_status: "partial",
        }),
      }),
    );
  expect
    .soft(
      graph.edges.filter(
        ({ relation, evidence }) =>
          (relation === "imports" || relation === "loads") &&
          evidence.location.available &&
          evidence.location.value.kind === "source-range" &&
          evidence.location.value.source === "cts/recovered.cts",
      ),
    )
    .toEqual([]);
};

const expectNativeMixedEvidence = (
  graph: Awaited<ReturnType<typeof analyzeJavaScriptDirectory>>["graph"],
): void => {
  const nativeObservations = (source: string) =>
    graph.nodes
      .flatMap(({ observations }) => observations)
      .filter(
        ({ properties, evidence }) =>
          "native_export_verification" in properties &&
          evidence.location.available &&
          evidence.location.value.kind === "source-range" &&
          evidence.location.value.source === source,
      );
  const nativeEdges = (source: string) =>
    graph.edges.filter(
      ({ properties, evidence }) =>
        "requested_members" in properties &&
        evidence.location.available &&
        evidence.location.value.kind === "source-range" &&
        evidence.location.value.source === source,
    );
  const mixed = nativeObservations("cts/native-mixed.mts");
  expect(mixed).toHaveLength(4);
  expect(
    mixed.filter(({ properties }) => properties.type_only === true),
  ).toHaveLength(2);
  expect(
    mixed.filter(({ properties }) => properties.type_only === false),
  ).toHaveLength(2);
  const runtime = nativeEdges("cts/native-mixed.mts");
  expect(runtime).toHaveLength(4);
  expect(
    runtime.every(({ properties }) => properties.type_only === false),
  ).toBe(true);
  expect(runtime.map(({ properties }) => properties.requested_members)).toEqual(
    [["NativeMode"], ["NativeMode"], ["NativeMode"], ["NativeMode"]],
  );
  const inline = nativeObservations("cts/native-inline-only.mts");
  expect(inline).toHaveLength(2);
  expect(inline.every(({ properties }) => properties.type_only === true)).toBe(
    true,
  );
  expect(nativeEdges("cts/native-inline-only.mts")).toEqual([]);
  // Compiler options are unavailable: keep the two possible module side effects.
  expect(
    graph.edges.filter(
      ({ relation, evidence }) =>
        relation === "loads" &&
        evidence.location.available &&
        evidence.location.value.kind === "source-range" &&
        evidence.location.value.source === "cts/native-inline-only.mts",
    ),
  ).toHaveLength(2);
};

const expectNativeTypeSelections = (
  graph: Awaited<ReturnType<typeof analyzeJavaScriptDirectory>>["graph"],
): void => {
  for (const member of ["NativeMode", "Native.Mode", ""])
    expect(
      graph.nodes.flatMap(({ observations }) => observations),
    ).toContainEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          specifier: "native-mixed/addon.node",
          requested_members: [member],
          namespace_access: false,
          dynamic_member_access: false,
          type_only: true,
        }),
        evidence: expect.objectContaining({
          location: expect.objectContaining({
            value: expect.objectContaining({
              source: "cts/native-indexed.mts",
            }),
          }),
        }),
      }),
    );
  expect(
    graph.nodes.flatMap(({ observations }) => observations),
  ).toContainEqual(
    expect.objectContaining({
      properties: expect.objectContaining({
        specifier: "native-mode/addon.node",
        module_kind: "require",
        type_only: true,
        requested_members: [],
        namespace_access: true,
        resolved_path: "node_modules/native-mode/require.node",
      }),
      evidence: expect.objectContaining({
        location: expect.objectContaining({
          value: expect.objectContaining({
            source: "cts/native-import-equals.cts",
          }),
        }),
      }),
    }),
  );
};
