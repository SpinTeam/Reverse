import { createScanner, type ScanError, type SyntaxKind } from "jsonc-parser";

// jsonc-parser declares ambient const enums, which cannot be imported as values
// under verbatimModuleSyntax. Keep its scanner codes local and type-checked.
const JSON_STRING_LITERAL = 10 satisfies SyntaxKind;
const JSON_EOF = 17 satisfies SyntaxKind;
const JSON_NO_ERROR = 0 satisfies ScanError;

export const IDA_REDACTION_MARKER = "[redacted transport credential]";

type Match = Readonly<{ start: number; end: number }>;
/** Matches are non-overlapping and ordered by their UTF-16 source offsets. */
type Matches = (value: string) => readonly Match[];

// Complete JSON character runs remain meaningful even in an unfinished or
// malformed string. Invalid units separate runs instead of joining their text.
const JSON_CHARACTER_RUN =
  /(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\dA-Fa-f]{4}))+/gu;

const appendStringMatches = (
  encoded: string,
  decoded: string,
  offset: number,
  matches: Matches,
  ranges: Match[],
): void => {
  // Match offsets and JSON escape widths are both UTF-16 units. No source bytes
  // outside a matched value need to be normalized or serialized again.
  let sourceCursor = 0;
  let decodedCursor = 0;
  const sourceOffset = (boundary: number): number => {
    while (decodedCursor < boundary) {
      sourceCursor +=
        encoded[sourceCursor] === "\\"
          ? encoded[sourceCursor + 1] === "u"
            ? 6
            : 2
          : 1;
      decodedCursor++;
    }
    return offset + sourceCursor;
  };
  for (const match of matches(decoded))
    ranges.push({
      start: sourceOffset(match.start),
      end: sourceOffset(match.end),
    });
};

const appendCharacterRunMatches = (
  encoded: string,
  offset: number,
  matches: Matches,
  ranges: Match[],
): readonly Match[] => {
  const decodedRuns: Match[] = [];
  for (const run of encoded.matchAll(JSON_CHARACTER_RUN)) {
    // The run grammar admits only complete JSON characters. JSON.parse owns
    // their decoded meaning; malformed units remain verbatim between runs.
    const decoded: unknown = JSON.parse('"' + run[0] + '"');
    if (typeof decoded !== "string")
      throw new TypeError("A JSON character run did not decode to a string.");
    const start = offset + run.index;
    decodedRuns.push({ start, end: start + run[0].length });
    appendStringMatches(run[0], decoded, start, matches, ranges);
  }
  return decodedRuns;
};

/** Redact diagnostic JSON source without folding duplicate keys or numeric lexemes. */
export const redactIdaJsonDiagnostic = (
  text: string,
  matches: Matches,
  options?: Readonly<{ malformed?: boolean }>,
): string => {
  const ranges: Match[] = [];
  const literalMatches = matches(text);
  let literalIndex = 0;
  const appendLiteralMatches = (
    decodedRuns: readonly Match[],
    end: number,
  ): void => {
    // Only trusted decoded runs supersede literal interpretation. Preserve raw
    // credentials crossing quotes or malformed units; ignore escape syntax
    // matches entirely inside a run whose decoded value owns that meaning.
    let runIndex = 0;
    while (literalIndex < literalMatches.length) {
      const match = literalMatches[literalIndex];
      if (match === undefined || match.start >= end) break;
      while (
        runIndex < decodedRuns.length &&
        (decodedRuns[runIndex]?.end ?? 0) <= match.start
      )
        runIndex++;
      const run = decodedRuns[runIndex];
      if (run === undefined || match.start < run.start || match.end > run.end)
        ranges.push(match);
      literalIndex++;
    }
  };
  let scannedEnd = 0;
  const scanner = createScanner(text);
  while (scanner.scan() !== JSON_EOF) {
    if (scanner.getToken() !== JSON_STRING_LITERAL) continue;
    const start = scanner.getTokenOffset();
    const end = start + scanner.getTokenLength();
    // Only a confirmed JSON decoding failure gives unquoted fragments this
    // interpretation; ordinary HTTP text keeps literal semantics in these gaps.
    if (options?.malformed === true && scannedEnd < start)
      appendLiteralMatches(
        appendCharacterRunMatches(
          text.slice(scannedEnd, start),
          scannedEnd,
          matches,
          ranges,
        ),
        start,
      );
    let decodedRuns: readonly Match[];
    if (scanner.getTokenError() === JSON_NO_ERROR) {
      appendStringMatches(
        text.slice(start + 1, end - 1),
        scanner.getTokenValue(),
        start + 1,
        matches,
        ranges,
      );
      decodedRuns = [{ start, end }];
    } else
      decodedRuns = appendCharacterRunMatches(
        text.slice(start + 1, end),
        start + 1,
        matches,
        ranges,
      );
    appendLiteralMatches(decodedRuns, end);
    scannedEnd = end;
  }
  appendLiteralMatches(
    options?.malformed === true
      ? appendCharacterRunMatches(
          text.slice(scannedEnd),
          scannedEnd,
          matches,
          ranges,
        )
      : [],
    text.length,
  );
  if (ranges.length === 0) return text;
  ranges.sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  const parts: string[] = [];
  let cursor = 0;
  let pending: Match | undefined;
  for (const range of ranges) {
    if (pending !== undefined && range.start < pending.end) {
      pending = { start: pending.start, end: Math.max(pending.end, range.end) };
      continue;
    }
    if (pending !== undefined) {
      parts.push(text.slice(cursor, pending.start), IDA_REDACTION_MARKER);
      cursor = pending.end;
    }
    pending = range;
  }
  if (pending !== undefined) {
    parts.push(text.slice(cursor, pending.start), IDA_REDACTION_MARKER);
    cursor = pending.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
};
