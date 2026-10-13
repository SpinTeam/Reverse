import {
  IDA_REDACTION_MARKER,
  redactIdaJsonDiagnostic,
} from "./IdaJsonDiagnostic.js";
import type { IdaConfiguration } from "./IdaConfiguration.js";

/** RFC 9110 credentials: any scheme, followed by opaque data or auth-params. */
const authorizationPayloads = (header: string): readonly string[] => {
  const payload = header.match(
    /^[!#$%&'*+.^_`|~\dA-Za-z-]+[ \t]+([\s\S]+)$/u,
  )?.[1];
  if (payload === undefined) return [];
  const values = [payload];
  // A sticky parse cannot reinterpret commas inside an incomplete quoted value.
  // Keep complete parameters preceding malformed input; the opaque payload above
  // remains a known credential even when the parameter grammar is not satisfied.
  const parameter =
    /[ \t,]*[!#$%&'*+.^_`|~\dA-Za-z-]+[ \t]*=[ \t]*("(?:[^"\\\r\n]|\\[^\r\n])*"|[!#$%&'*+.^_`|~\dA-Za-z-]+)[ \t]*(?:,|$)/uy;
  let cursor = 0;
  while (cursor < payload.length) {
    parameter.lastIndex = cursor;
    const match = parameter.exec(payload);
    if (match === null) break;
    cursor = parameter.lastIndex;
    const value = match[1] ?? "";
    if (!value.startsWith('"')) {
      values.push(value);
      continue;
    }
    const quoted = value.slice(1, -1);
    if (quoted.length > 0)
      values.push(value, quoted, quoted.replace(/\\([^\r\n])/gu, "$1"));
  }
  return values;
};

/** RFC 6265 cookie-pairs: retain duplicates and '=' inside values. */
const cookiePayloads = (header: string): readonly string[] =>
  header.split(";").flatMap((pair) => {
    const value = pair.match(
      /^[ \t]*[!#$%&'*+.^_`|~\dA-Za-z-]+[ \t]*=[ \t]*(.*?)[ \t]*$/u,
    )?.[1];
    if (value === undefined) return [];
    const payload =
      value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
    // Cookie quotes wrap cookie-octets; they do not introduce escape syntax.
    if (!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/u.test(payload))
      return [];
    return [value, payload];
  });

/** Own configured credential interpretation for all IDA error diagnostics. */
export const createIdaDiagnosticRedactor = (
  config: IdaConfiguration,
): Readonly<{
  text(message: string): string;
  json(message: string, options?: Readonly<{ malformed?: boolean }>): string;
}> => {
  const headers = "headers" in config ? Object.entries(config.headers) : [];
  const values = headers.flatMap(([name, value]) => {
    if (!/^(?:authorization|proxy-authorization|cookie)$/iu.test(name))
      return [];
    // Fetch normalizes surrounding HTTP whitespace before sending headers.
    const normalized = value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, "");
    if (normalized.length === 0) return [];
    return [
      value,
      normalized,
      ...(name.toLowerCase() === "cookie"
        ? cookiePayloads(normalized)
        : authorizationPayloads(normalized)),
    ];
  });
  const secrets = [...new Set(values.filter((value) => value.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  if (secrets.length === 0)
    return { text: (message) => message, json: (message) => message };
  const pattern = new RegExp(
    secrets
      .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join("|"),
    "gu",
  );
  return {
    text: (message) => message.replace(pattern, IDA_REDACTION_MARKER),
    json: (message, options) =>
      redactIdaJsonDiagnostic(
        message,
        (value) =>
          [...value.matchAll(pattern)].map((match) => ({
            start: match.index,
            end: match.index + match[0].length,
          })),
        options,
      ),
  };
};
