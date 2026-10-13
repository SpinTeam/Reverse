import { describe, expect, it } from "vitest";
import { createIdaDiagnosticRedactor } from "./IdaDiagnosticRedactor.js";

describe("IDA diagnostic credential redaction", () => {
  it.each([false, true])(
    "redacts literal credentials once regardless of header order (reversed: %s)",
    (reversed) => {
      const entries = [
        ["Authorization", "Bearer fixture"],
        ["proxy-AUTHORIZATION", "bAsIc fixture-long.$[token]"],
        ["cOoKiE", "session=fixture-long.$[token]; marker=redacted"],
        ["X-Evidence", "caller-selected-evidence"],
      ];
      const redact = createIdaDiagnosticRedactor({
        url: "http://127.0.0.1:12345/mcp",
        headers: Object.fromEntries(reversed ? entries.reverse() : entries),
        mode: "attached",
        timeoutMs: 1000,
      }).text;
      expect(
        redact(
          "Bearer fixture / fixture / bAsIc fixture-long.$[token] / fixture-long.$[token] / session=fixture-long.$[token]; marker=redacted /caller/input?token=visible API_KEY=visible caller-selected-evidence",
        ),
      ).toBe(
        "[redacted transport credential] / [redacted transport credential] / [redacted transport credential] / [redacted transport credential] / [redacted transport credential] /caller/input?token=visible API_KEY=visible caller-selected-evidence",
      );
    },
  );
  it("redacts configured and HTTP-normalized header values", () => {
    const redact = createIdaDiagnosticRedactor({
      url: "http://127.0.0.1:12345/mcp",
      headers: {
        aUtHoRiZaTiOn: "\r\n \tBearer fixture-secret \t\r\n",
        "pRoXy-AuThOrIzAtIoN": "\tBasic proxy-secret ",
        CoOkIe: " session=cookie-secret\t",
      },
      mode: "attached",
      timeoutMs: 1000,
    }).text;
    expect(
      redact(
        "raw=\r\n \tBearer fixture-secret \t\r\n; wire=Bearer fixture-secret; token=fixture-secret; proxy=Basic proxy-secret; bare=proxy-secret; cookie=session=cookie-secret",
      ),
    ).toBe(
      "raw=[redacted transport credential]; wire=[redacted transport credential]; token=[redacted transport credential]; proxy=[redacted transport credential]; bare=[redacted transport credential]; cookie=[redacted transport credential]",
    );
  });
  it("does not treat empty HTTP authentication as diagnostic content", () => {
    const redact = createIdaDiagnosticRedactor({
      url: "http://127.0.0.1:12345/mcp",
      headers: {
        Authorization: "\r\n \t \r\n",
        "Proxy-Authorization": "",
        Cookie: "\t",
      },
      mode: "attached",
      timeoutMs: 1000,
    }).text;
    const message = "Failed at /caller/input \t with ordinary whitespace";
    expect(redact(message)).toBe(message);
  });
  it("does not reprocess the replacement marker as another credential", () => {
    const redact = createIdaDiagnosticRedactor({
      url: "http://127.0.0.1:12345/mcp",
      headers: { Authorization: "Bearer alpha", Cookie: "redacted" },
      mode: "attached",
      timeoutMs: 1000,
    }).text;
    expect(redact("alpha redacted")).toBe(
      "[redacted transport credential] [redacted transport credential]",
    );
  });
});

const credentialCases: readonly {
  readonly name: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly message: string;
  readonly expected: string;
}[] = [
  {
    name: "duplicate cookie names, quoted values, and equals padding",
    headers: {
      Cookie:
        'session=first-secret; session=second-secret; signed="padded=value=="',
    },
    message: "first-secret / second-secret / padded=value== / session signed",
    expected:
      "[redacted transport credential] / [redacted transport credential] / [redacted transport credential] / session signed",
  },
  {
    name: "empty cookie and auth-param values",
    headers: { Cookie: 'a=; b=""', Authorization: 'Custom empty=""' },
    message: 'Ordinary spaces and "" remain; a b empty are names',
    expected: 'Ordinary spaces and "" remain; a b empty are names',
  },
  {
    name: "opaque token68 and explicit one-character credentials",
    headers: { Authorization: "Negotiate opaque+/==", Cookie: "a=Q" },
    message: "opaque+/== Q Negotiate a",
    expected:
      "[redacted transport credential] [redacted transport credential] Negotiate a",
  },
  {
    name: "auth-param values retain quoted commas and decode quoted pairs",
    headers: {
      Authorization: String.raw`Digest first="nonce,part", response="quote\"part", opaque="back\\part", tail=last-secret`,
    },
    message: String.raw`nonce,part / quote"part / quote\"part / back\part / back\\part / last-secret / Digest first response opaque tail`,
    expected:
      "[redacted transport credential] / [redacted transport credential] / [redacted transport credential] / [redacted transport credential] / [redacted transport credential] / [redacted transport credential] / Digest first response opaque tail",
  },
  {
    name: "complete parameters before a malformed quoted member",
    headers: {
      Authorization:
        'Digest first=known-secret, broken="unterminated, second=visible',
    },
    message: "known-secret visible broken second",
    expected: "[redacted transport credential] visible broken second",
  },
  {
    name: "unclosed quotes do not create parameters from their contents",
    headers: { Authorization: 'Digest broken="unterminated, second=visible' },
    message: "unterminated visible broken second",
    expected: "unterminated visible broken second",
  },
  {
    name: "malformed cookie members do not hide valid later pairs",
    headers: {
      Cookie: 'broken; =not-a-value; malformed="unclosed; session=valid-secret',
    },
    message: "valid-secret broken not-a-value unclosed session",
    expected:
      "[redacted transport credential] broken not-a-value unclosed session",
  },
  {
    name: "cookie octets remain opaque without URL decoding",
    headers: { Cookie: "session=encoded%2Fcredential" },
    message: "encoded%2Fcredential / encoded/credential",
    expected: "[redacted transport credential] / encoded/credential",
  },
];
it.each(credentialCases)(
  "parses $name at the configured credential boundary",
  ({ headers, message, expected }) => {
    const redact = createIdaDiagnosticRedactor({
      url: "http://127.0.0.1:12345/mcp",
      headers,
      mode: "attached",
      timeoutMs: 1000,
    }).text;
    expect(redact(message)).toBe(expected);
  },
);

it("redacts full configured malformed headers without guessing their internal values", () => {
  const header = 'Digest broken="unterminated, second=visible';
  const redactor = createIdaDiagnosticRedactor({
    url: "http://127.0.0.1:12345/mcp",
    headers: { Authorization: header },
    mode: "attached",
    timeoutMs: 1000,
  });
  expect(redactor.text(header)).toBe("[redacted transport credential]");
  expect(redactor.json(JSON.stringify(header))).toBe(
    '"[redacted transport credential]"',
  );
});
