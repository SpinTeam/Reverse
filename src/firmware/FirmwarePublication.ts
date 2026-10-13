import { createReadStream } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { SafeOutputTree } from "../artifacts/SafeOutputTree.js";
import { SafeOutputTreeCreationFailure } from "../artifacts/SafeOutputTreeCreationFailure.js";
import { AnalysisOutputError } from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { firmwareResultSchemas } from "../domain/firmware/firmwareAnalysis.js";
import { hashFirmwareFile, type FirmwareEntry } from "./FirmwareFiles.js";
import type { normalizeUnblobReport } from "./FirmwareReports.js";
import type { extractionGap } from "../domain/firmware/firmwareAnalysis.js";

type ExtractionGap = z.infer<typeof extractionGap>;

/** Static, truthful continuations that use already configured capabilities. */
const GAP_CONTINUATIONS: Record<ExtractionGap["kind"], string> = {
  "missing-extractor-dependency":
    "REA installs nothing. Add the named dependency to your own environment and rerun extract_firmware on the same immutable input to re-evaluate the affected region; otherwise it stays unextracted.",
  "unknown-chunk-handler":
    "Run inspect_firmware_regions on the same input for signature hypotheses, or select a narrower range with extract_firmware; the region is not decoded content.",
  "encrypted-chunk":
    "No static extraction continues past encryption; treat the region as unexamined rather than empty or corrupt.",
  "extractor-failure":
    "The producer retained this chunk's extraction problem in diagnostics. Review the reported failure, then rerun extract_firmware on the same immutable input; the region is not decoded content.",
  "depth-limited":
    "Rerun extract_firmware with a higher max_depth (up to 10) to descend into this path.",
  "unpublished-entry":
    "The entry is retained as metadata; only regular files are published, without executable permission bits.",
};

import { FIRMWARE_LIMITS } from "./FirmwareRelease.js";

/** The depth ceiling cannot be raised past the input schema maximum. */
const MAX_EXTRACTION_DEPTH = 10;

const depthContinuation = (
  maxDepth: number,
  hasUsableChild: boolean,
): string =>
  maxDepth < MAX_EXTRACTION_DEPTH
    ? GAP_CONTINUATIONS["depth-limited"]
    : hasUsableChild
      ? "This extraction already ran at the lane's maximum depth. To continue below this path, rerun extract_firmware with path set to the published child extracted here (its files[].path entry under this task); a fresh run on that child restarts the depth budget."
      : `This extraction already ran at the lane's maximum depth, and no published child under this path is both nonempty and within the ${FIRMWARE_LIMITS.inputBytes}-byte firmware input limit, so the depth budget cannot be restarted from this output. Treat the region below this path as unexamined.`;

// A nested unknown chunk reruns only through its published child, and a
// fresh firmware input must actually accept that child.
const nestedUnknownContinuation = (
  inputPath: string,
  size: number | undefined,
): string => {
  const base = `This unknown chunk was carved from a nested extraction, so its range is relative to the published child at ${inputPath.slice("$output/".length)} under the output directory, not to the original input.`;
  return size !== undefined && size > 0 && size <= FIRMWARE_LIMITS.inputBytes
    ? `${base} Rerun extract_firmware with that published file as the input to evaluate the region.`
    : `${base} That published child is not a nonempty file within the ${FIRMWARE_LIMITS.inputBytes}-byte firmware input limit, so extract_firmware cannot accept it as a fresh input; treat the region as unexamined.`;
};

const emptyGap = {
  relative_path: null,
  handler: null,
  provider_id: null,
  range: null,
  root_file_range: null,
  dependencies: [],
};

const gapSortKey = (gap: ExtractionGap): string =>
  [
    gap.input_path,
    gap.kind,
    gap.provider_id ?? "",
    gap.relative_path ?? "",
  ].join("\u0000");

/** Publish verified regular files, preserving links as metadata and rolling back failed writes. */
export const publishFirmwareExtraction = async (context: {
  outputDirectory: string;
  entries: readonly FirmwareEntry[];
  normalized: ReturnType<typeof normalizeUnblobReport>;
  selection: { offset: number; length: number; sha256: string };
  /** Caller-selected extraction depth, for boundary-aware continuations. */
  maxDepth: number;
  engine: z.infer<typeof firmwareResultSchemas.extract_firmware>["engine"];
  signal: AbortSignal;
  retainCleanup: (tree: SafeOutputTree) => void;
}) => {
  let tree: SafeOutputTree | undefined;
  let result:
    | z.infer<typeof firmwareResultSchemas.extract_firmware>
    | undefined;
  try {
    const materialized = new Set(
      context.entries
        .filter((entry) => entry.kind === "file")
        .map((entry) => `$output/${entry.relativePath}`),
    );
    for (const path of context.normalized.files.keys()) {
      if (path !== "$input" && !materialized.has(path))
        throw new AnalysisOutputError(
          "extract_firmware",
          `Reported regular file is absent from materialized output: ${path}`,
        );
    }
    const files = [];
    const unpublished = [];
    tree = await SafeOutputTree.create(context.outputDirectory);
    for (const entry of context.entries) {
      if (entry.kind !== "file") {
        unpublished.push({
          relative_path: entry.relativePath,
          kind: entry.kind,
          link_target: entry.linkTarget,
        });
        continue;
      }
      const logicalPath = `$output/${entry.relativePath}`;
      const reported = context.normalized.files.get(logicalPath);
      const sha256 = await hashFirmwareFile(entry.path, context.signal);
      if (
        (reported?.sha256 !== null &&
          reported?.sha256 !== undefined &&
          reported.sha256 !== sha256) ||
        (context.normalized.sizes.has(logicalPath) &&
          context.normalized.sizes.get(logicalPath) !== entry.size)
      )
        throw new AnalysisOutputError(
          "extract_firmware",
          `Extracted bytes disagree with provider report: ${entry.relativePath}`,
        );
      await tree.write(
        entry.relativePath,
        createReadStream(entry.path),
        { sha256, bytes: entry.size },
        context.signal,
      );
      files.push({
        relative_path: entry.relativePath,
        path: join(tree.outputRoot, entry.relativePath),
        size: entry.size,
        sha256,
        reported_sha256: reported?.sha256 ?? null,
        mime_type: reported?.mimeType ?? null,
        analysis_depth: reported?.depth ?? null,
        runtime_address: null,
        original_file_range: null,
      });
    }
    result = firmwareResultSchemas.extract_firmware.parse({
      engine: context.engine,
      selection: context.selection,
      output_directory: tree.outputRoot,
      coverage:
        unpublished.length > 0 ? "partial" : context.normalized.coverage,
      files,
      unpublished_entries: unpublished,
      chunks: context.normalized.chunks,
      derivations: context.normalized.derivations,
      depth_limited_paths: context.normalized.depth_limited_paths,
      diagnostics: context.normalized.diagnostics,
      extraction_gaps: extractionGaps(
        unpublished,
        context.normalized,
        context.maxDepth,
      ),
      published_bytes: files.reduce((sum, file) => sum + file.size, 0),
    });
    context.signal.throwIfAborted();
    await tree.commit(context.signal);
    return result;
  } catch (cause: unknown) {
    if (cause instanceof SafeOutputTreeCreationFailure) tree = cause.tree;
    try {
      await tree?.rollback();
    } catch (cleanupCause: unknown) {
      if (tree !== undefined) context.retainCleanup(tree);
      const publishedResult =
        tree?.published === true && result !== undefined
          ? {
              kind: "firmware" as const,
              result: jsonValueSchema.parse(result),
            }
          : undefined;
      throw new ProviderCleanupError(
        "unblob",
        [context.outputDirectory],
        {
          reason:
            cleanupCause instanceof Error
              ? cleanupCause.message
              : String(cleanupCause),
          previous_error:
            cause instanceof Error ? cause.message : String(cause),
        },
        {
          cause: cleanupCause,
          operation: "extract_firmware",
          ...(publishedResult === undefined
            ? {}
            : { partialObservation: publishedResult }),
        },
      );
    }
    if (tree?.published === true && result !== undefined) return result;
    throw cause;
  }
};

/** Derive explicit recovery rows from retained report facts; no new claims. */
/** Gap rows for missing-dependency reports: chunk-nested rows keep their owning chunk. */
const dependencyExtractionGaps = (
  normalized: ReturnType<typeof normalizeUnblobReport>,
): ExtractionGap[] => {
  // Chunk-nested dependency reports name the chunk that could not extract;
  // task-wide reports (standalone or multi-file) attach to the task.
  // One index over the chunk list keeps dependency-row resolution linear.
  const chunksByKey = new Map(
    normalized.chunks.map((chunk) => [
      JSON.stringify([chunk.input_path, chunk.provider_id]),
      chunk,
    ]),
  );
  // The owning multi-file stage names the extractor behind a task-wide
  // dependency; chunk identity and ranges stay unset because the producer
  // names no chunk.
  const stageHandlers = new Map(
    normalized.failed_extraction_stages.map(({ input_path, handler }) => [
      input_path,
      handler,
    ]),
  );
  return [
    ...normalized.chunk_missing_dependencies.flatMap(
      ({ input_path, provider_id, dependencies }): ExtractionGap[] => {
        const affected = chunksByKey.get(
          JSON.stringify([input_path, provider_id]),
        );
        return [
          {
            kind: "missing-extractor-dependency",
            input_path,
            ...emptyGap,
            ...(affected === undefined
              ? {}
              : {
                  handler: affected.handler,
                  provider_id,
                  range: affected.range,
                  root_file_range: affected.root_file_range,
                }),
            dependencies,
            continuation: GAP_CONTINUATIONS["missing-extractor-dependency"],
          },
        ];
      },
    ),
    // A task-wide report ties the failure to the task, not to a region, so
    // chunk identity and ranges stay unset; the producer names no chunk. The
    // owning multi-file stage still names the extractor on the gap itself.
    ...normalized.missing_dependencies.map(
      ({ input_path, dependencies }): ExtractionGap => ({
        kind: "missing-extractor-dependency",
        input_path,
        ...emptyGap,
        handler: stageHandlers.get(input_path) ?? null,
        dependencies,
        continuation: GAP_CONTINUATIONS["missing-extractor-dependency"],
      }),
    ),
  ];
};

const extractionGaps = (
  unpublished: z.infer<
    typeof firmwareResultSchemas.extract_firmware
  >["unpublished_entries"],
  normalized: ReturnType<typeof normalizeUnblobReport>,
  maxDepth: number,
): ExtractionGap[] => {
  const dependencyGaps: ExtractionGap[] = dependencyExtractionGaps(normalized);
  const chunkGaps = (
    kind: ExtractionGap["kind"],
    matches: (chunk: (typeof normalized.chunks)[number]) => boolean,
  ): ExtractionGap[] =>
    normalized.chunks.filter(matches).map((chunk) => ({
      kind,
      input_path: chunk.input_path,
      ...emptyGap,
      handler: chunk.handler,
      provider_id: chunk.provider_id,
      range: chunk.range,
      root_file_range: chunk.root_file_range,
      dependencies: [],
      continuation:
        kind === "unknown-chunk-handler" &&
        chunk.input_path.startsWith("$output/")
          ? nestedUnknownContinuation(
              chunk.input_path,
              normalized.sizes.get(chunk.input_path),
            )
          : GAP_CONTINUATIONS[kind],
    }));
  // Chunks whose failure a dependency row already covers stay out of the
  // generic extractor-failure emission.
  const dependencyChunkKeys = new Set(
    normalized.chunk_missing_dependencies.map(({ input_path, provider_id }) =>
      JSON.stringify([input_path, provider_id]),
    ),
  );
  const taskDependencyPaths = new Set(
    normalized.missing_dependencies.map(({ input_path }) => input_path),
  );
  // A depth ceiling can only be re-rooted through a published child that a
  // fresh firmware input could actually accept; the index is only needed
  // when a depth row will actually consult it.
  const ceilingReached =
    maxDepth >= MAX_EXTRACTION_DEPTH &&
    normalized.depth_limited_paths.length > 0;
  const reRootablePaths = new Set<string>();
  if (ceilingReached)
    for (const [filePath] of normalized.files) {
      const size = normalized.sizes.get(filePath) ?? 0;
      if (size <= 0 || size > FIRMWARE_LIMITS.inputBytes) continue;
      // The published file itself can re-root a fresh run; so can every
      // directory containing it.
      const segments = filePath.split("/");
      while (segments.length > 1) {
        reRootablePaths.add(segments.join("/"));
        segments.pop();
      }
    }
  const gaps: ExtractionGap[] = [
    ...dependencyGaps,
    ...normalized.failed_extraction_stages
      .filter(({ input_path }) => !taskDependencyPaths.has(input_path))
      .map(({ input_path, handler }): ExtractionGap => ({
        kind: "extractor-failure",
        input_path,
        ...emptyGap,
        handler,
        dependencies: [],
        continuation: GAP_CONTINUATIONS["extractor-failure"],
      })),
    ...chunkGaps("unknown-chunk-handler", (chunk) => chunk.handler === null),
    ...chunkGaps("encrypted-chunk", (chunk) => chunk.encrypted === true),
    ...chunkGaps(
      "extractor-failure",
      (chunk) =>
        chunk.extraction_failed === true &&
        chunk.handler !== null &&
        chunk.encrypted !== true &&
        // The chunk's own dependency row already carries its recovery; a
        // task-wide dependency names no region and replaces nothing.
        !dependencyChunkKeys.has(
          JSON.stringify([chunk.input_path, chunk.provider_id]),
        ),
    ),
    ...normalized.depth_limited_paths.map((input_path): ExtractionGap => ({
      kind: "depth-limited",
      input_path,
      ...emptyGap,
      dependencies: [],
      continuation: depthContinuation(
        maxDepth,
        reRootablePaths.has(input_path),
      ),
    })),
    ...unpublished.map((entry): ExtractionGap => ({
      kind: "unpublished-entry",
      input_path: `$output/${entry.relative_path}`,
      ...emptyGap,
      relative_path: entry.relative_path,
      dependencies: [],
      continuation: GAP_CONTINUATIONS["unpublished-entry"],
    })),
  ];
  return gaps.sort((left, right) =>
    gapSortKey(left) < gapSortKey(right)
      ? -1
      : gapSortKey(left) > gapSortKey(right)
        ? 1
        : 0,
  );
};
