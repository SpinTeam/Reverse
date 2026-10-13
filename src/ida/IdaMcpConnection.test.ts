import { describe, expect, it } from "vitest";
import { decodeIdaToolResult } from "./IdaMcpConnection.js";
import { createIdaDiagnosticRedactor } from "./IdaDiagnosticRedactor.js";

describe("upstream IDA tool result decoding", () => {
  it("leaves successful legacy, structured, and native evidence unchanged", () => {
    const redact = createIdaDiagnosticRedactor({
      url: "http://127.0.0.1:12345/mcp",
      headers: { Authorization: "Bearer fixture-secret" },
      mode: "attached",
      timeoutMs: 1000,
    }).text;
    const evidence = "Caller-selected fixture-secret evidence";
    expect(
      decodeIdaToolResult(
        { content: [{ type: "text", text: evidence }] },
        undefined,
        redact,
      ),
    ).toBe(evidence);
    expect(
      decodeIdaToolResult(
        { content: [], structuredContent: { evidence } },
        undefined,
        redact,
      ),
    ).toEqual({ evidence });
    expect(
      decodeIdaToolResult(
        { content: [{ type: "text", text: JSON.stringify({ evidence }) }] },
        "native",
        redact,
      ),
    ).toEqual({ evidence });
  });
  it("redacts credentials in truncated-output diagnostics before constructing the error", () => {
    const redact = createIdaDiagnosticRedactor({
      url: "http://127.0.0.1:12345/mcp",
      headers: { Authorization: "Bearer fixture-secret" },
      mode: "attached",
      timeoutMs: 1000,
    }).text;
    expect(() =>
      decodeIdaToolResult(
        {
          content: [],
          _meta: {
            ida_mcp: {
              output_truncated: true,
              download_hint:
                "Download /caller/output?cursor=kept using Bearer fixture-secret",
            },
          },
        },
        undefined,
        redact,
      ),
    ).toThrow(
      "Download /caller/output?cursor=kept using [redacted transport credential]",
    );
  });
  it("decodes scalar wrappers and legacy text without dropping structured dictionaries", () => {
    expect(
      decodeIdaToolResult({
        content: [],
        structuredContent: { result: "code" },
      }),
    ).toBe("code");
    expect(
      decodeIdaToolResult({
        content: [],
        structuredContent: { path: "input", result: "field" },
      }),
    ).toEqual({ path: "input", result: "field" });
    expect(
      decodeIdaToolResult({
        content: [{ type: "text", text: '[{"address":"0x1000"}]' }],
      }),
    ).toEqual([{ address: "0x1000" }]);
    expect(
      decodeIdaToolResult({
        content: [{ type: "text", text: "int main(void);" }],
      }),
    ).toBe("int main(void);");
  });
  it("preserves upstream failures and rejects truncated previews that still satisfy item schemas", () => {
    expect(() => decodeIdaToolResult({ content: [] })).toThrow(
      "empty observation",
    );
    expect(() =>
      decodeIdaToolResult({
        isError: true,
        content: [{ type: "text", text: "Decompiler license is unavailable" }],
      }),
    ).toThrow("Decompiler license is unavailable");
    expect(() =>
      decodeIdaToolResult({
        isError: false,
        structuredContent: {
          result: [{ addr: "0x1000", name: "main", size: "0x20" }],
        },
        content: [{ type: "text", text: "preview" }],
        _meta: {
          ida_mcp: {
            output_truncated: true,
            total_chars: 70000,
            download_hint: "Download the full upstream output",
          },
        },
      }),
    ).toThrow("Download the full upstream output");
  });
});
