import { MIMEType } from "node:util";
import { createIdaDiagnosticRedactor } from "./IdaDiagnosticRedactor.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import {
  Client,
  SdkHttpError,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import type { IdaConfiguration } from "./IdaConfiguration.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import { AnalysisProtocolError } from "../domain/analysisErrorCore.js";

/** Injectable MCP boundary used by the provider and transport conformance tests. */
export interface IdaMcpConnection {
  connect(): Promise<readonly string[]>;
  call(
    name: string,
    args: Readonly<Record<string, JsonValue>>,
  ): Promise<JsonValue>;
  readResource?(uri: string): Promise<JsonValue>;
  serverInfo(): JsonValue;
  close(): Promise<void>;
}

const toolResultSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  content: z.array(
    z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
  ),
  _meta: z
    .object({
      ida_mcp: z
        .object({
          output_truncated: z.boolean().optional(),
          download_hint: z.string().optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .optional(),
});

const parseIdaJsonText = (text: string): JsonValue => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause: unknown) {
    throw new AnalysisProtocolError("IDA MCP returned malformed JSON text.", {
      cause,
    });
  }
  return jsonValueSchema.parse(value);
};

/** Decode Python FastMCP's scalar wrapper without dropping structured dictionaries. */
export const decodeIdaToolResult = (
  input: unknown,
  protocol?: "native",
  redactDiagnostic: (message: string) => string = (message) => message,
): JsonValue => {
  const result = toolResultSchema.parse(input);
  const blocks = result.content.flatMap((block) =>
    block.type === "text" && block.text !== undefined ? [block.text] : [],
  );
  if (result.isError === true) {
    const reason = redactDiagnostic(blocks.join("\n"));
    throw new AnalysisProtocolError(`IDA MCP tool failed: ${reason}`, {
      diagnostics: { reason },
    });
  }
  if (result._meta?.ida_mcp?.output_truncated === true)
    throw new AnalysisProtocolError(
      redactDiagnostic(
        `IDA MCP truncated its output; the preview cannot establish a complete observation. ${result._meta.ida_mcp.download_hint ?? "Use the upstream output download workflow to retrieve the full result."}`,
      ),
    );
  // Native MCP retains the complete JSON text while structuredContent may
  // contain a shortened preview. Parse that producer-owned representation once.
  if (protocol === "native") {
    if (blocks.length !== 1)
      throw new AnalysisProtocolError(
        "Native IDA MCP omitted its complete JSON text result.",
      );
    return parseIdaJsonText(blocks[0] ?? "");
  }
  if (result.structuredContent !== undefined) {
    const value = result.structuredContent;
    return jsonValueSchema.parse(
      Object.keys(value).length === 1 && "result" in value
        ? value.result
        : value,
    );
  }
  if (blocks.length !== 1)
    throw new AnalysisProtocolError(
      "IDA MCP omitted a single structured or text result; unsupported content cannot establish an empty observation.",
    );
  const values = blocks.map((text): JsonValue => {
    try {
      return jsonValueSchema.parse(JSON.parse(text));
    } catch {
      return text;
    }
  });
  return values[0] ?? null;
};

// Preserve the HTTP body at its decoding boundary. Native SyntaxError messages
// add display quoting/truncation and cannot recover the original JSON tokens.
class IdaHttpJsonError extends Error {
  readonly text: string;
  constructor(text: string, cause: unknown) {
    super("IDA MCP returned malformed HTTP JSON.", { cause });
    this.text = text;
  }
}

/** Create a standard SDK connection to an existing upstream registration. */
export const createIdaMcpConnection = (
  config: IdaConfiguration,
  environment: Readonly<NodeJS.ProcessEnv>,
): IdaMcpConnection => {
  const client = new Client({ name: "rea-ida-provider", version: "1" });
  const redactor = createIdaDiagnosticRedactor(config);
  const transportFailure = (cause: unknown): never => {
    if (cause instanceof IdaHttpJsonError)
      throw new Error(
        `${cause.message} Response body: ${redactor.json(cause.text, { malformed: true })}`,
        { cause },
      );
    const message =
      cause instanceof Error
        ? cause.message
        : "Unknown IDA MCP transport failure";
    const body = cause instanceof SdkHttpError ? cause.data.text : undefined;
    // The fetch boundary already sanitized this body using its Content-Type.
    // Redact only the surrounding SDK message; never rescan replacement markers.
    const safeMessage =
      typeof body === "string" && body.length > 0 && message.includes(body)
        ? message.split(body).map(redactor.text).join(body)
        : redactor.text(message);
    throw new Error(safeMessage, { cause });
  };
  const transport =
    "command" in config
      ? new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: {
            // The SDK always merges ambient defaults. Its string-only environment
            // API requires empty values to suppress omitted caller-selected keys.
            ...Object.fromEntries(
              DEFAULT_INHERITED_ENV_VARS.map((key) => [key, ""]),
            ),
            ...Object.fromEntries(
              Object.entries(snapshotEnvironment(environment)).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
            IDA_MCP_MAX_WORKERS: "1",
            ...snapshotEnvironment(config.env),
          },
          stderr: "pipe",
        })
      : new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: { headers: config.headers, redirect: "error" },
          fetch: async (input, init) => {
            const response = await fetch(input, init);
            const readText = response.text.bind(response);
            if (!response.ok) {
              let redactBody = redactor.text;
              const contentType = response.headers.get("content-type");
              if (contentType !== null) {
                try {
                  const { subtype } = new MIMEType(contentType);
                  if (subtype === "json" || subtype.endsWith("+json"))
                    redactBody = redactor.json;
                } catch {
                  // An unknown format provides no JSON interpretation.
                }
              }
              // The SDK retains text but drops response headers when making
              // its HTTP error. Apply the known format before that boundary.
              Object.defineProperty(response, "text", {
                value: async (): Promise<string> =>
                  redactBody(await readText()),
              });
            }
            // Read once, only when the SDK requests JSON. Other response
            // consumers, including SSE, keep their transport semantics.
            Object.defineProperty(response, "json", {
              value: async (): Promise<unknown> => {
                const text = await readText();
                try {
                  const value: unknown = JSON.parse(text);
                  return value;
                } catch (cause: unknown) {
                  throw new IdaHttpJsonError(text, cause);
                }
              },
            });
            return response;
          },
        });
  // Drain proxy diagnostics without persisting ambient environment or transport credentials.
  if (transport instanceof StdioClientTransport)
    transport.stderr?.on("data", () => undefined);
  return {
    async connect() {
      await client
        .connect(transport, { timeout: config.timeoutMs })
        .catch(transportFailure);
      const catalog = await client
        .listTools(undefined, {
          timeout: config.timeoutMs,
        })
        .catch(transportFailure);
      return catalog.tools.map(({ name }) => name);
    },
    async call(name, args) {
      return decodeIdaToolResult(
        await client
          .callTool({ name, arguments: args }, { timeout: config.timeoutMs })
          .catch(transportFailure),
        config.protocol,
        redactor.text,
      );
    },
    async readResource(uri) {
      const response = await client
        .readResource({ uri }, { timeout: config.timeoutMs })
        .catch(transportFailure);
      const resource = z
        .object({
          contents: z
            .array(
              z.object({
                uri: z.literal(uri),
                mimeType: z.literal("application/json"),
                text: z.string(),
              }),
            )
            .length(1),
        })
        .parse(response);
      return parseIdaJsonText(resource.contents[0]?.text ?? "");
    },
    serverInfo: () => jsonValueSchema.parse(client.getServerVersion() ?? null),
    close: () => client.close().catch(transportFailure),
  };
};
