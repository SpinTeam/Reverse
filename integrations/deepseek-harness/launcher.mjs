/**
 * Cordis service provider for REA's local stdio MCP launcher.
 *
 * This module is intentionally build-free. Git-based Harness plugin installs
 * receive source files, and pnpm >=10 may block install-time build scripts.
 * Resolve the npm package's shipped executable using Node's package resolver
 * rather than assuming a particular pnpm/desktop node_modules layout.
 */
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";

const require = createRequire(import.meta.url);
const REA_ENTRY = "rea-agents/scripts/rea.mjs";
const PROFILE_VALUES = new Set(["compact", "full"]);

export const name = "rea-launcher";

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * Resolve an explicit local fork checkout, or the pinned prebuilt npm REA.
 * Neither node, a shell, nor npx is looked up on PATH; process.execPath starts
 * the matching Node executable directly and avoids implicit downloads.
 */
export function resolveReaLauncher({
  env = process.env,
  execPath = process.execPath,
  resolvePackage = (specifier) => require.resolve(specifier),
  fileExists = isFile,
} = {}) {
  const override = env.REA_DSH_ENTRYPOINT;
  let entrypoint;
  if (override !== undefined) {
    if (typeof override !== "string" || !isAbsolute(override)) {
      throw new Error(
        "REA_DSH_ENTRYPOINT must be an absolute path to scripts/rea.mjs",
      );
    }
    entrypoint = resolve(override);
  } else {
    try {
      entrypoint = resolvePackage(REA_ENTRY);
    } catch (cause) {
      throw new Error(
        "REA npm runtime is unavailable; install the bundle dependencies or set REA_DSH_ENTRYPOINT",
        { cause },
      );
    }
  }
  if (!fileExists(entrypoint)) {
    throw new Error(`REA launcher is not a regular file: ${entrypoint}`);
  }

  const profile = env.REA_DSH_SCHEMA_PROFILE ?? "compact";
  if (!PROFILE_VALUES.has(profile)) {
    throw new Error("REA_DSH_SCHEMA_PROFILE must be either compact or full");
  }
  // Only explicitly defined REA configuration is forwarded. Harness owns
  // ambient credential filtering and process isolation for the spawned child.
  return Object.freeze({
    command: execPath,
    args: Object.freeze([entrypoint, "mcp"]),
    env: Object.freeze({ REA_MCP_INPUT_SCHEMA_PROFILE: profile }),
  });
}

export function apply(ctx) {
  // Cordis owns the service lifecycle. The MCP client waits for this service
  // through `inject`, then owns its stdio child, tools and reconnect cleanup.
  ctx.provide("reaLauncher", resolveReaLauncher());
}
