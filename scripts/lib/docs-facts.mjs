import { readFile, readdir, stat } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";

const readmeEditionPattern =
  /^(?:docs\/readmes\/)?README(?:_[A-Za-z0-9-]+)?\.md$/u;

/** Resolve a local link against the README that contains it, so editions in docs/readmes compare with the root README. */
const rootRelativeTarget = (from, target) => {
  const hash = target.indexOf("#");
  const file = hash === -1 ? target : target.slice(0, hash);
  if (file === "") return target;
  return (
    posix.normalize(posix.join(posix.dirname(from), file)) +
    (hash === -1 ? "" : target.slice(hash))
  );
};

const readmeLinkTargets = (from, content, language = "en") =>
  [...content.matchAll(/\]\(([^)\s]+)\)/gu)]
    .map((match) => match[1] ?? "")
    .filter((target) => !target.startsWith("#"))
    .filter(
      (target) =>
        URL.canParse(target) ||
        !readmeEditionPattern.test(rootRelativeTarget(from, target)),
    )
    .map((target) =>
      URL.canParse(target) ? target : rootRelativeTarget(from, target),
    )
    .map((target) => {
      if (language === "en" || !URL.canParse(target)) return target;
      const url = new URL(target);
      const prefix = `/${language}/`;
      if (
        url.origin !== "https://rea.tools" ||
        !url.pathname.startsWith(prefix)
      )
        return target;
      url.pathname = url.pathname.slice(prefix.length - 1);
      return url.href;
    })
    .sort();

const requireText = (issues, path, content, expected) => {
  if (!content.includes(expected)) issues.push(`${path}: missing ${expected}`);
};

/** Check that local Markdown references travel with an installed skill bundle. */
export const skillReferenceIssues = async (skillRoot) => {
  const issues = [];
  const paths = (await readdir(skillRoot, { recursive: true }))
    .filter((path) => path.endsWith(".md"))
    .sort();
  for (const path of paths) {
    const content = await readFile(join(skillRoot, path), "utf8");
    for (const match of content.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/gu)) {
      const destination = match[1];
      if (/^(?:https?:\/\/|mailto:|#)/u.test(destination)) continue;
      const target = resolve(
        dirname(join(skillRoot, path)),
        destination.split("#")[0],
      );
      const withinBundle = relative(resolve(skillRoot), target);
      if (
        withinBundle === ".." ||
        withinBundle.startsWith(`..${sep}`) ||
        isAbsolute(withinBundle)
      ) {
        issues.push(
          `${path}: reference escapes installed skill bundle: ${destination}`,
        );
        continue;
      }
      try {
        if (!(await stat(target)).isFile())
          issues.push(`${path}: reference is not a file: ${destination}`);
      } catch (cause) {
        if (cause?.code !== "ENOENT") throw cause;
        issues.push(`${path}: missing skill reference: ${destination}`);
      }
    }
  }
  return issues;
};

/** Return every caller-visible documentation mismatch against canonical facts. */
export const documentationFactIssues = async (root, catalog) => {
  const issues = await skillReferenceIssues(
    join(root, "skills/reverse-engineer-anything"),
  );
  const translatedReadmes = (await readdir(join(root, "docs/readmes")))
    .filter((path) => /^README_[A-Za-z0-9-]+\.md$/u.test(path))
    .map((path) => `docs/readmes/${path}`);
  const readmePaths = ["README.md", ...translatedReadmes].sort();
  const readmes = new Map();
  for (const path of readmePaths) {
    const content = await readFile(join(root, path), "utf8");
    readmes.set(path, content);
    requireText(issues, path, content, "MCP-tool_catalog");
    if (path === "README.md") {
      requireText(
        issues,
        path,
        content,
        "(docs/installation.md#supported-agents)",
      );
      requireText(issues, path, content, "(docs/installation.md#mcp-registry)");
      requireText(
        issues,
        path,
        content,
        "(docs/mcp-contracts.md#generated-catalog)",
      );
    }
  }
  const canonicalLinks = readmeLinkTargets(
    "README.md",
    readmes.get("README.md") ?? "",
  );
  const languageInventory = JSON.parse(
    await readFile(join(root, "website/locales/languages.json"), "utf8"),
  );
  const readmeLanguages = new Map(
    languageInventory.map(({ readme, code }) => [readme, code]),
  );
  for (const path of readmePaths.filter((path) => path !== "README.md"))
    if (
      JSON.stringify(
        readmeLinkTargets(
          path,
          readmes.get(path) ?? "",
          readmeLanguages.get(path),
        ),
      ) !== JSON.stringify(canonicalLinks)
    )
      issues.push(`${path}: documentation links differ from README.md`);

  const installationPath = "docs/installation.md";
  const installation = await readFile(join(root, installationPath), "utf8");
  for (const client of catalog.setup_clients)
    requireText(issues, installationPath, installation, client.display_name);

  const agents = await readFile(join(root, "AGENTS.md"), "utf8");
  requireText(issues, "AGENTS.md", agents, "docs/public/product-catalog.json");

  const templatePath = ".github/pull_request_template.md";
  const template = await readFile(join(root, templatePath), "utf8");
  requireText(
    issues,
    templatePath,
    template,
    "docs/public/product-catalog.json",
  );

  return issues;
};

/** Fail once with all documentation fact mismatches. */
export const assertDocumentationFacts = async (root, catalog) => {
  const issues = await documentationFactIssues(root, catalog);
  if (issues.length > 0)
    throw new Error(`Documentation facts drifted:\n- ${issues.join("\n- ")}`);
};
