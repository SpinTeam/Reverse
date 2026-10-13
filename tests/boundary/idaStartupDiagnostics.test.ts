import { describe, expect, it } from "vitest";
import { createIdaMcpConnection } from "../../src/ida/IdaMcpConnection.js";

describe("IDA startup diagnostics", () => {
  it("preserves the failing launcher's stderr instead of reporting only a closed transport", async () => {
    const connection = createIdaMcpConnection(
      {
        command: process.execPath,
        args: [
          "-e",
          'process.stderr.write("FATAL: IDA runtime initialization failed\\n", () => process.exit(2));',
        ],
        env: {},
        mode: "headless",
        timeoutMs: 1000,
      },
      {},
    );
    try {
      await expect(connection.connect()).rejects.toMatchObject({
        _tag: "ProviderAdapterError",
        capturedOutput: {
          stderr: expect.stringContaining("IDA runtime initialization failed"),
          truncated: false,
        },
      });
    } finally {
      await connection.close();
    }
  });

  it("retains only the bounded stderr tail and reports the original byte count", async () => {
    const connection = createIdaMcpConnection(
      {
        command: process.execPath,
        args: [
          "-e",
          'process.stderr.write("x".repeat(20000) + "FATAL-END", () => process.exit(2));',
        ],
        env: {},
        mode: "headless",
        timeoutMs: 1000,
      },
      {},
    );
    try {
      await expect(connection.connect()).rejects.toMatchObject({
        _tag: "ProviderAdapterError",
        capturedOutput: {
          stderr: "x".repeat(16384 - "FATAL-END".length) + "FATAL-END",
          stderr_bytes: 20000 + "FATAL-END".length,
          truncated: true,
        },
      });
    } finally {
      await connection.close();
    }
  });
});
