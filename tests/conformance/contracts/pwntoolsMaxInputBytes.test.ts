import { describe, expect, it, vi } from "vitest";
import { open } from "node:fs/promises";
import { join } from "node:path";

import {
  parsePwntoolsMaxInputBytes,
  pwntoolsMaxInputBytesSchema,
} from "../../../src/config/pwntoolsMaxInputBytes.js";
import { parseEnvironment } from "../../../src/config/environment.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { PWNTOOLS_LIMITS } from "../../../src/native/pwntools/PwntoolsRelease.js";
import { PwntoolsLayoutProvider } from "../../../src/native/pwntools/PwntoolsLayoutProvider.js";
import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

describe("pwntools max input bytes parsing and configuration", () => {
  it("defaults to PWNTOOLS_LIMITS.inputBytes when unset or empty", () => {
    expect(parsePwntoolsMaxInputBytes(undefined)).toEqual({
      ok: true,
      value: PWNTOOLS_LIMITS.inputBytes,
    });
    expect(parsePwntoolsMaxInputBytes("")).toEqual({
      ok: true,
      value: PWNTOOLS_LIMITS.inputBytes,
    });
  });

  it("parses valid positive decimal safe integers", () => {
    // 64 MiB
    expect(parsePwntoolsMaxInputBytes("67108864")).toEqual({
      ok: true,
      value: 67_108_864,
    });
    // 256 MiB
    expect(parsePwntoolsMaxInputBytes("268435456")).toEqual({
      ok: true,
      value: 268_435_456,
    });
    // 1 GiB
    expect(parsePwntoolsMaxInputBytes("1073741824")).toEqual({
      ok: true,
      value: 1_073_741_824,
    });
    // Minimum 1 byte
    expect(parsePwntoolsMaxInputBytes("1")).toEqual({
      ok: true,
      value: 1,
    });
  });

  it.each([
    "0",
    "-1",
    "-1024",
    "1.5",
    "abc",
    "0123",
    "1e8",
    " 33554432",
    "33554432 ",
    "9007199254740992", // > Number.MAX_SAFE_INTEGER
  ])("rejects malformed or unsafe values: %j", (value) => {
    const result = parsePwntoolsMaxInputBytes(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("REA_PWNTOOLS_MAX_INPUT_BYTES");
      expect(result.error.settings).toEqual([
        {
          setting: "REA_PWNTOOLS_MAX_INPUT_BYTES",
          constraint:
            "REA_PWNTOOLS_MAX_INPUT_BYTES must be a positive decimal safe integer.",
        },
      ]);
    }
  });

  it("exports pwntoolsMaxInputBytesSchema for composition in environmentSchema", () => {
    expect(pwntoolsMaxInputBytesSchema.safeParse("268435456").success).toBe(
      true,
    );
    expect(pwntoolsMaxInputBytesSchema.safeParse("0").success).toBe(false);
    expect(pwntoolsMaxInputBytesSchema.safeParse("").success).toBe(true);
  });

  it("integrates with parseEnvironment and parseConfig, accepting empty settings", () => {
    const validEnv = parseEnvironment({
      REA_PWNTOOLS_MAX_INPUT_BYTES: "268435456",
    });
    expect(validEnv.ok).toBe(true);
    if (validEnv.ok) {
      expect(validEnv.value.REA_PWNTOOLS_MAX_INPUT_BYTES).toBe(268_435_456);
    }

    // Empty setting must not fail startup
    const emptyEnv = parseEnvironment({
      REA_PWNTOOLS_MAX_INPUT_BYTES: "",
    });
    expect(emptyEnv.ok).toBe(true);
    if (emptyEnv.ok) {
      expect(emptyEnv.value.REA_PWNTOOLS_MAX_INPUT_BYTES).toBeUndefined();
    }

    const emptyConfig = parseConfig({
      REA_PWNTOOLS_MAX_INPUT_BYTES: "",
    });
    expect(emptyConfig.ok).toBe(true);

    const invalidEnv = parseEnvironment({
      REA_PWNTOOLS_MAX_INPUT_BYTES: "invalid-bytes",
    });
    expect(invalidEnv.ok).toBe(false);
    if (!invalidEnv.ok) {
      expect(invalidEnv.error.settings).toEqual([
        expect.objectContaining({
          setting: "REA_PWNTOOLS_MAX_INPUT_BYTES",
        }),
      ]);
    }

    const configResult = parseConfig({
      REA_PWNTOOLS_MAX_INPUT_BYTES: "536870912", // 512 MiB
    });
    expect(configResult.ok).toBe(true);
  });
});

describe("pwntools decoder artifact read budget", () => {
  it("rejects artifacts larger than the default 32 MiB budget in PwntoolsDecoder", async () => {
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("linux");
    const archSpy = vi.spyOn(process, "arch", "get").mockReturnValue("x64");
    const { root } = await createTestWorkspace("rea-pwntools-default-");
    try {
      const file33Mb = join(root, "artifact_33mb");
      const handle = await open(file33Mb, "w");
      await handle.truncate(33 * 1024 * 1024);
      await handle.close();

      const defaultProvider = new PwntoolsLayoutProvider({
        REA_PWNTOOLS_PYTHON: process.execPath,
      });
      const defaultResult = await defaultProvider.inspect({ path: file33Mb });
      expect(defaultResult.ok).toBe(false);
      if (
        !defaultResult.ok &&
        defaultResult.error instanceof AnalysisInputError
      ) {
        const issue = defaultResult.error.issues[0];
        expect(issue?.reason).toBe("out_of_range");
        expect(issue?.message).toContain(
          "Selected artifact exceeds 33554432 bytes",
        );
      }
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
      await removeTestWorkspace(root);
    }
  });

  it("permits artifacts within the configured override and rejects beyond it", async () => {
    const platformSpy = vi
      .spyOn(process, "platform", "get")
      .mockReturnValue("linux");
    const archSpy = vi.spyOn(process, "arch", "get").mockReturnValue("x64");
    const { root } = await createTestWorkspace("rea-pwntools-override-");
    try {
      const file33Mb = join(root, "artifact_33mb");
      const handle33 = await open(file33Mb, "w");
      await handle33.truncate(33 * 1024 * 1024);
      await handle33.close();

      const overrideProvider = new PwntoolsLayoutProvider({
        REA_PWNTOOLS_PYTHON: process.execPath,
        REA_PWNTOOLS_MAX_INPUT_BYTES: String(64 * 1024 * 1024),
      });

      const overrideResult = await overrideProvider.inspect({ path: file33Mb });
      expect(overrideResult.ok).toBe(false);
      if (
        !overrideResult.ok &&
        overrideResult.error instanceof AnalysisInputError
      ) {
        const issue = overrideResult.error.issues[0];
        expect(issue?.reason).not.toBe("out_of_range");
      }

      const file65Mb = join(root, "artifact_65mb");
      const handle65 = await open(file65Mb, "w");
      await handle65.truncate(65 * 1024 * 1024);
      await handle65.close();

      const overrideResult65 = await overrideProvider.inspect({
        path: file65Mb,
      });
      expect(overrideResult65.ok).toBe(false);
      if (
        !overrideResult65.ok &&
        overrideResult65.error instanceof AnalysisInputError
      ) {
        const issue = overrideResult65.error.issues[0];
        expect(issue?.reason).toBe("out_of_range");
        expect(issue?.message).toContain(
          "Selected artifact exceeds 67108864 bytes",
        );
      }
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
      await removeTestWorkspace(root);
    }
  });
});
