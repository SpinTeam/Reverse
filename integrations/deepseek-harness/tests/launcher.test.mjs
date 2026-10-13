import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, resolveReaLauncher } from "../launcher.mjs";

function withFixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "rea-dsh-"));
  const launcher = join(dir, "rea.mjs");
  writeFileSync(launcher, "#!/usr/bin/env node\n");
  try {
    return fn(launcher);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("launches a packaged REA using the active Node without shell or network install", () =>
  withFixture((launcher) => {
    const result = resolveReaLauncher({
      env: {},
      execPath: "/usr/local/bin/node",
      resolvePackage: (specifier) => {
        assert.equal(specifier, "rea-agents/scripts/rea.mjs");
        return launcher;
      },
    });
    assert.deepEqual(result, {
      command: "/usr/local/bin/node",
      args: [launcher, "mcp"],
      env: { REA_MCP_INPUT_SCHEMA_PROFILE: "compact" },
    });
    assert(Object.isFrozen(result));
    assert(Object.isFrozen(result.args));
  }));

test("explicit local fork launcher takes precedence without npm resolution", () =>
  withFixture((launcher) => {
    const result = resolveReaLauncher({
      env: { REA_DSH_ENTRYPOINT: launcher, REA_DSH_SCHEMA_PROFILE: "full" },
      resolvePackage: () => {
        throw new Error("should never resolve npm");
      },
    });
    assert.deepEqual(result.args, [launcher, "mcp"]);
    assert.deepEqual(result.env, { REA_MCP_INPUT_SCHEMA_PROFILE: "full" });
  }));

test("rejects absent/relative overrides, bad schemas, and missing npm runtime", () => {
  assert.throws(
    () =>
      resolveReaLauncher({ env: { REA_DSH_ENTRYPOINT: "scripts/rea.mjs" } }),
    /absolute path/,
  );
  assert.throws(
    () =>
      resolveReaLauncher({ env: { REA_DSH_ENTRYPOINT: "/missing/no.mjs" } }),
    /not a regular file/,
  );
  assert.throws(
    () =>
      resolveReaLauncher({
        env: {},
        resolvePackage: () => {
          throw Error("not found");
        },
      }),
    /runtime is unavailable/,
  );
  withFixture((launcher) => {
    assert.throws(
      () =>
        resolveReaLauncher({
          env: {
            REA_DSH_ENTRYPOINT: launcher,
            REA_DSH_SCHEMA_PROFILE: "random",
          },
        }),
      /either compact or full/,
    );
  });
});

test("does not pass ambient credentials into the generated MCP env", () =>
  withFixture((launcher) => {
    const result = resolveReaLauncher({
      env: {
        REA_DSH_ENTRYPOINT: launcher,
        AWS_SECRET_ACCESS_KEY: "sentinel",
        OPENAI_API_KEY: "sentinel",
      },
    });
    assert.deepEqual(Object.keys(result.env), ["REA_MCP_INPUT_SCHEMA_PROFILE"]);
  }));

test("the Cordis adapter provides its owned service", () =>
  withFixture((launcher) => {
    const previous = process.env.REA_DSH_ENTRYPOINT;
    process.env.REA_DSH_ENTRYPOINT = launcher;
    try {
      const calls = [];
      apply({ provide: (name, value) => calls.push([name, value]) });
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], "reaLauncher");
      assert.deepEqual(calls[0][1].args, [launcher, "mcp"]);
    } finally {
      if (previous === undefined) delete process.env.REA_DSH_ENTRYPOINT;
      else process.env.REA_DSH_ENTRYPOINT = previous;
    }
  }));
