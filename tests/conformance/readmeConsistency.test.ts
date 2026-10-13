import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { PRODUCT_IDENTITY } from "../../src/identity.js";

const translatedReadmes = [
  "docs/readmes/README_zh.md",
  "docs/readmes/README_zh-TW.md",
  "docs/readmes/README_ja.md",
  "docs/readmes/README_ko.md",
  "docs/readmes/README_tr.md",
  "docs/readmes/README_ru.md",
  "docs/readmes/README_vi.md",
  "docs/readmes/README_th.md",
  "docs/readmes/README_de.md",
  "docs/readmes/README_es.md",
  "docs/readmes/README_fr.md",
  "docs/readmes/README_uk.md",
  "docs/readmes/README_pl.md",
  "docs/readmes/README_pt-BR.md",
  "docs/readmes/README_ar.md",
  "docs/readmes/README_fa.md",
  "docs/readmes/README_id.md",
] as const;

const jsonExamples = (content: string): unknown[] =>
  [...content.matchAll(/```json\s*([\s\S]*?)```/gu)].map((match): unknown =>
    JSON.parse(match[1] ?? ""),
  );

const shellExamples = (content: string): string[] =>
  [...content.matchAll(/```bash\s*([\s\S]*?)```/gu)].map((match) =>
    (match[1] ?? "").trim(),
  );

describe("onboarding documentation product facts", () => {
  it("keeps the installation MCP example aligned with the package registration command", async () => {
    const content = await readFile(resolve("docs/installation.md"), "utf8");
    expect(jsonExamples(content)).toContainEqual(
      expect.objectContaining({
        mcpServers: expect.objectContaining({
          rea: expect.objectContaining({
            command: "npx",
            args: ["-y", PRODUCT_IDENTITY.registrationPackageSpecifier, "mcp"],
          }),
        }),
      }),
    );
  });

  it("keeps translated onboarding commands aligned with the English examples", async () => {
    const english = shellExamples(await readFile(resolve("README.md"), "utf8"));
    for (const path of translatedReadmes)
      expect(
        shellExamples(await readFile(resolve(path), "utf8")),
        path,
      ).toEqual(english);
  });
});
