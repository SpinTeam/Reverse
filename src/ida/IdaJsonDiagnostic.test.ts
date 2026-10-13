import { describe, expect, it } from "vitest";
import { createIdaDiagnosticRedactor } from "./IdaDiagnosticRedactor.js";

const marker = "[redacted transport credential]";
const forCredential = (credential: string) =>
  createIdaDiagnosticRedactor({
    url: "http://127.0.0.1:12345/mcp",
    headers: { Authorization: `Custom ${credential}` },
    mode: "attached",
    timeoutMs: 1000,
  });

describe("IDA JSON diagnostic source preservation", () => {
  it("matches equivalent JSON encodings without enumerating credential spellings", () => {
    const redactor = forCredential("<s/>");
    const encodings = [
      ["<", String.raw`\u003c`, String.raw`\u003C`],
      ["s", String.raw`\u0073`],
      ["/", String.raw`\/`, String.raw`\u002f`, String.raw`\u002F`],
      [">", String.raw`\u003e`, String.raw`\u003E`],
    ].reduce<string[]>(
      (prefixes, units) =>
        prefixes.flatMap((prefix) => units.map((unit) => prefix + unit)),
      [""],
    );
    for (const encoded of encodings)
      expect(redactor.json(`{"reason":"${encoded}"}`)).toBe(
        `{"reason":"${marker}"}`,
      );
  });

  it("preserves unrelated spelling inside a matching string", () => {
    const source = String.raw`{"reason":"\u003cpublic\u003e\/asset \u003csecret\u003e \ud83d\uDE00"}`;
    expect(forCredential("<secret>").json(source)).toBe(
      String.raw`{"reason":"\u003cpublic\u003e\/asset ` +
        marker +
        String.raw` \ud83d\uDE00"}`,
    );
  });

  it("retains duplicate fields, whitespace and exact numeric lexemes", () => {
    const source =
      '{\n  "\\u003csecret\\u003e": 9007199254740993, "n": -0, "n": 1.00e+03, "value": "<secret>"\n}';
    expect(forCredential("<secret>").json(source)).toBe(
      `{\n  "${marker}": 9007199254740993, "n": -0, "n": 1.00e+03, "value": "${marker}"\n}`,
    );
  });

  it.each([
    { credential: "a😀b", encoded: String.raw`a\ud83d\uDE00b` },
    { credential: "a\ud800b", encoded: String.raw`a\uD800b` },
    { credential: "a\nb", encoded: String.raw`a\nb` },
    { credential: 'a"b', encoded: String.raw`a\u0022b` },
  ])("maps UTF-16 source spans for $encoded", ({ credential, encoded }) => {
    expect(forCredential(credential).json(`"before ${encoded} after"`)).toBe(
      `"before ${marker} after"`,
    );
  });

  it.each([
    {
      source: String.raw`{broken: "\u003csecret\u003e",`,
      expected: `{broken: "${marker}",`,
    },
    {
      source: String.raw`{"x":"\u003csecret\u003e`,
      expected: `{"x":"${marker}`,
    },
    {
      source: String.raw`{"x":"\u003csecret\u003e\q"}`,
      expected: `{"x":"${marker}\\q"}`,
    },
  ])(
    "preserves malformed source around known complete characters: $source",
    ({ source, expected }) => {
      expect(forCredential("<secret>").json(source)).toBe(expected);
    },
  );

  it("does not join decoded fragments across invalid escapes", () => {
    const source = String.raw`{"x":"<sec\qret>"}`;
    expect(forCredential("<secret>").json(source)).toBe(source);
  });

  it("retains literal matches crossing invalid JSON units", () => {
    expect(
      forCredential(String.raw`foo\qbar`).json(String.raw`{"x":"foo\qbar"}`),
    ).toBe(`{"x":"${marker}"}`);
  });

  it("uses decoded values instead of matching unrelated escape syntax", () => {
    const source = String.raw`{"x":"\u003cpublic\u003e","y":"u003c"}`;
    expect(forCredential("u003c").json(source)).toBe(
      String.raw`{"x":"\u003cpublic\u003e","y":"` + marker + '"}',
    );
  });

  it("retains literal opaque matches spanning quoted fragments in plain bodies", () => {
    const credential = 'prefix"quoted"suffix';
    expect(
      forCredential(credential).json(
        `Auth Custom ${credential}; payload ${credential}; path /caller/input`,
      ),
    ).toBe(`Auth ${marker}; payload ${marker}; path /caller/input`);
  });

  it("replaces adjacent matches once without rescanning the marker", () => {
    expect(
      forCredential("redacted").json(String.raw`"redacted\u0072edacted"`),
    ).toBe(`"${marker}${marker}"`);
  });

  it("decodes unquoted fragments only for a known malformed JSON body", () => {
    const source = String.raw`\u003csecret\u003e`;
    const redactor = forCredential("<secret>");
    expect(redactor.json(source)).toBe(source);
    expect(redactor.json(source, { malformed: true })).toBe(marker);
    const invalid = String.raw`<sec\qret>`;
    expect(redactor.json(invalid, { malformed: true })).toBe(invalid);
    const unrelated = String.raw`\u003cpublic\u003e`;
    expect(forCredential("u003c").json(unrelated, { malformed: true })).toBe(
      unrelated,
    );
  });
  it("leaves ordinary text diagnostics and credential-free configurations unchanged", () => {
    const source = String.raw`{"x":"\u003csecret\u003e"}`;
    expect(forCredential("<secret>").text(source)).toBe(source);
    const redactor = createIdaDiagnosticRedactor({
      headers: {},
      url: "http://127.0.0.1:12345/mcp",
      mode: "attached",
      timeoutMs: 1000,
    });
    expect(redactor.json(source)).toBe(source);
  });
});
