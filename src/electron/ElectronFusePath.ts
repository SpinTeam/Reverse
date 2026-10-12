import { lstat, readlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { isPathWithinRoot } from "../domain/localPath.js";

const FRAMEWORK_NAME = "Electron Framework.framework";
const BINARY_NAME = "Electron Framework";
const MAX_SYMLINK_HOPS = 32;

/** Caller path plus the regular file whose bytes will be scanned. */
export interface ResolvedElectronFuseTarget {
  readonly selectedPath: string;
  readonly resolvedPath: string;
}

/** A selected path is not an admitted Electron bundle or regular file. */
export class ElectronFusePathFailure extends Error {
  constructor(
    readonly reason: "invalid_value" | "invalid_format",
    message: string,
  ) {
    super(message);
    this.name = "ElectronFusePathFailure";
  }
}

type WalkResult =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "absent" | "escapes" | "not-file" | "loop" };

/**
 * Admit a regular executable, a macOS app bundle, or an Electron Framework
 * binary reached through `Versions/Current` without leaving the framework.
 */
export const resolveElectronFuseTarget = async (
  selectedPath: string,
  signal?: AbortSignal,
): Promise<ResolvedElectronFuseTarget> => {
  signal?.throwIfAborted();
  const metadata = await lstat(selectedPath);
  if (metadata.isSymbolicLink())
    return {
      selectedPath,
      resolvedPath: await resolveFrameworkSymlink(selectedPath, signal),
    };
  if (metadata.isFile())
    return {
      selectedPath,
      // `lstat` follows intermediate links such as `Versions/Current`, so a
      // file inside the framework is re-walked from the framework root.
      resolvedPath:
        frameworkRootOf(selectedPath) === null
          ? selectedPath
          : await resolveFrameworkSymlink(selectedPath, signal),
    };
  if (!metadata.isDirectory())
    throw new ElectronFusePathFailure(
      "invalid_format",
      `Expected a regular file or Electron app bundle: ${selectedPath}`,
    );
  return {
    selectedPath,
    resolvedPath: await resolveBundleBinary(selectedPath, signal),
  };
};

const resolveFrameworkSymlink = async (
  selectedPath: string,
  signal?: AbortSignal,
): Promise<string> => {
  const root = frameworkRootOf(selectedPath);
  if (root === null)
    throw new ElectronFusePathFailure(
      "invalid_format",
      `Expected a regular file without a symlink: ${selectedPath}`,
    );
  await requireRealDirectories(dirname(root), [basename(root)], selectedPath);
  const relativePath = relativeInside(root, selectedPath);
  if (relativePath === null)
    throw new ElectronFusePathFailure(
      "invalid_value",
      `Framework symlink escapes ${FRAMEWORK_NAME}: ${selectedPath}`,
    );
  return requireFile(
    await resolveInside(root, relativePath, signal),
    selectedPath,
  );
};

const resolveBundleBinary = async (
  selectedPath: string,
  signal?: AbortSignal,
): Promise<string> => {
  const name = basename(selectedPath);
  if (name === FRAMEWORK_NAME)
    return resolveKnownBinary(selectedPath, selectedPath, signal);
  if (name.endsWith(".app")) {
    await requireRealDirectories(
      selectedPath,
      ["Contents", "Frameworks", FRAMEWORK_NAME],
      selectedPath,
    );
    return resolveKnownBinary(
      join(selectedPath, "Contents", "Frameworks", FRAMEWORK_NAME),
      selectedPath,
      signal,
    );
  }
  throw new ElectronFusePathFailure(
    "invalid_format",
    `Expected an Electron .app bundle, ${FRAMEWORK_NAME} directory, or executable file: ${selectedPath}`,
  );
};

/** `root` is the framework directory for both an `.app` and a framework selection. */
const resolveKnownBinary = async (
  root: string,
  bundle: string,
  signal: AbortSignal | undefined,
): Promise<string> => {
  const versioned = await resolveInside(
    root,
    `Versions/A/${BINARY_NAME}`,
    signal,
  );
  if (versioned.kind === "file") return versioned.path;
  if (versioned.kind !== "absent")
    throw pathWalkFailure(versioned.kind, bundle);
  const current = await resolveInside(
    root,
    `Versions/Current/${BINARY_NAME}`,
    signal,
  );
  if (current.kind === "file") return current.path;
  if (current.kind === "absent")
    throw new ElectronFusePathFailure(
      "invalid_value",
      `Electron Framework binary was not found inside ${bundle}.`,
    );
  throw pathWalkFailure(current.kind, bundle);
};

const resolveInside = async (
  root: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<WalkResult> => {
  const pending = relativePath.split("/").filter((segment) => segment !== "");
  const resolved: string[] = [];
  let hops = 0;
  let last: "file" | "directory" | undefined;
  while (pending.length > 0) {
    signal?.throwIfAborted();
    const segment = pending.shift() ?? "";
    if (segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0) return { kind: "escapes" };
      resolved.pop();
      last = "directory";
      continue;
    }
    const absolute = join(root, ...resolved, segment);
    if (!isPathWithinRoot(root, absolute)) return { kind: "escapes" };
    let metadata;
    try {
      metadata = await lstat(absolute);
    } catch (cause: unknown) {
      if (isMissing(cause)) return { kind: "absent" };
      throw cause;
    }
    if (metadata.isSymbolicLink()) {
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) return { kind: "loop" };
      const target = await readlink(absolute);
      if (isAbsolute(target)) return { kind: "escapes" };
      pending.unshift(...target.split("/").filter((part) => part !== ""));
      continue;
    }
    if (metadata.isDirectory()) {
      resolved.push(segment);
      last = "directory";
      continue;
    }
    if (!metadata.isFile() || pending.length > 0) return { kind: "not-file" };
    resolved.push(segment);
    last = "file";
  }
  if (last !== "file") return { kind: "not-file" };
  const path = join(root, ...resolved);
  return isPathWithinRoot(root, path)
    ? { kind: "file", path }
    : { kind: "escapes" };
};

/**
 * Each named directory below `anchor` must be a real directory, so the
 * framework root cannot redirect the walk outside the selected bundle.
 */
const requireRealDirectories = async (
  anchor: string,
  segments: readonly string[],
  selectedPath: string,
): Promise<void> => {
  let current = anchor;
  for (const segment of segments) {
    current = join(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (cause: unknown) {
      if (isMissing(cause))
        throw new ElectronFusePathFailure(
          "invalid_value",
          `Electron Framework binary was not found inside ${selectedPath}.`,
        );
      throw cause;
    }
    if (metadata.isSymbolicLink())
      throw pathWalkFailure("escapes", selectedPath);
    if (!metadata.isDirectory())
      throw pathWalkFailure("not-file", selectedPath);
  }
};

const requireFile = (walk: WalkResult, selectedPath: string): string => {
  if (walk.kind === "file") return walk.path;
  if (walk.kind === "absent")
    throw new ElectronFusePathFailure(
      "invalid_value",
      `Electron Framework symlink target was not found: ${selectedPath}`,
    );
  throw pathWalkFailure(walk.kind, selectedPath);
};

const pathWalkFailure = (
  kind: "escapes" | "not-file" | "loop",
  path: string,
): ElectronFusePathFailure =>
  new ElectronFusePathFailure(
    "invalid_value",
    kind === "escapes"
      ? `Framework symlink escapes ${FRAMEWORK_NAME}: ${path}`
      : kind === "loop"
        ? `Framework symlink hop limit exceeded: ${path}`
        : `Electron Framework path is not a regular file: ${path}`,
  );

const frameworkRootOf = (path: string): string | null => {
  let current = dirname(path);
  while (basename(current) !== FRAMEWORK_NAME) {
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
};

const relativeInside = (root: string, path: string): string | null => {
  if (!isPathWithinRoot(root, path)) return null;
  const value = relative(root, path);
  return value === "" ? null : value.split(sep).join("/");
};

const isMissing = (cause: unknown): boolean =>
  cause instanceof Error &&
  "code" in cause &&
  ["ENOENT", "ENOTDIR"].includes(String(cause.code));
