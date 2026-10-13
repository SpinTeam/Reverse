import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  buildClassFile,
  buildJar,
  createObfuscatedModJar,
} from "../fixtures/java/classFile.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const writeModJar = async (prefix: string) => {
  const root = await createTestTempDirectory(prefix);
  const path = join(root, "mod.jar");
  await writeFile(path, await createObfuscatedModJar());
  return { root, path };
};

/**
 * Simulated Java launcher standing in for `java -jar vineflower.jar`. It
 * records its arguments and staged inputs, then writes one source file per
 * top-level staged class. This proves staging, identity and cleanup only; it
 * does not establish real Vineflower output.
 */
const createSimulatedJava = async (root: string) => {
  const home = join(root, "jdk");
  await mkdir(join(home, "bin"), { recursive: true });
  const log = join(root, "java-invocation.json");
  const launcher = join(home, "bin", "java");
  await writeFile(
    launcher,
    `#!${process.execPath}
const { mkdirSync, readdirSync, writeFileSync } = require("node:fs");
const { dirname, join, relative } = require("node:path");
const args = process.argv.slice(2);
const output = args.at(-1);
const input = args.at(-2);
const staged = readdirSync(input, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => relative(input, join(entry.parentPath, entry.name)).replaceAll("\\\\", "/"))
  .sort();
writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), staged }));
for (const entry of staged.filter((path) => !path.includes("$"))) {
  const target = join(output, entry.replace(/\\.class$/u, ".java"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "// simulated source for " + entry + "\\n// staged: " + staged.join(",") + "\\n");
}
`,
  );
  await chmod(launcher, 0o755);
  const engine = join(root, "vineflower.jar");
  await writeFile(
    engine,
    await buildJar([
      [
        "META-INF/MANIFEST.MF",
        "Manifest-Version: 1.0\r\nImplementation-Version: 9.9.9-test\r\n\r\n",
      ],
    ]),
  );
  return {
    environment: { JAVA_HOME: home, REA_VINEFLOWER_JAR: engine },
    readInvocation: async () =>
      JSON.parse(await readFile(log, "utf8")) as {
        args: string[];
        cwd: string;
        staged: string[];
      },
  };
};

cliTest(
  "inventories an obfuscated mod JAR with descriptors, packages and paged class rows",
  async ({ cli }) => {
    const { path } = await writeModJar("rea-java-cli-archive-");
    const result = await cli.run({
      arguments: ["inspect-java-archive", path, "--limit", "2", "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("inspect_java_archive").outputSchema.parse(
      result.json,
    );
    expect(evidence).toMatchObject({
      subject: { format: "zip", local_path: path },
      provider: { id: "java-classfile" },
      confidence: "observed",
    });
    const report = evidence.normalized_result;
    expect(report.artifact.container).toBe("jar");
    // Continuation lines join; per-entry sections after the blank line are excluded.
    expect(report.manifest).toEqual({
      attributes: [
        { name: "Manifest-Version", value: "1.0" },
        { name: "Main-Class", value: "com.example.mod.Main" },
      ],
      main_class: "com.example.mod.Main",
    });
    expect(report.metadata_files).toEqual([
      {
        entry: "mcmod.info",
        kind: "forge-mcmod-info",
        text: '[{"modid":"examplemod","version":"1.0"}]',
        truncated: false,
      },
    ]);
    expect(report.entries).toMatchObject({
      classes: 10,
      native_libraries: ["native/linux-x86-64/libhelper.so"],
    });
    expect(report.malformed_classes).toEqual([
      {
        entry: "org/library/broken.class",
        reason: expect.stringContaining("truncated"),
      },
    ]);
    expect(report.bytecode_versions).toEqual([
      { major: 50, java_version: "6", classes: 1 },
      { major: 52, java_version: "8", classes: 8 },
    ]);
    expect(report.packages).toEqual([
      { name: "com.example.mod", classes: 8, short_name_classes: 6 },
      { name: "org.library", classes: 1, short_name_classes: 0 },
    ]);
    expect(report.name_obfuscation).toMatchObject({
      basis: "heuristic",
      assessment: "likely",
      short_class_names: 6,
    });
    expect(report.classes).toMatchObject({
      total_matching: 9,
      next_offset: 2,
      rows: [
        { name: "com/example/mod/Main", source_file: "Main.java", major: 50 },
        { name: "com/example/mod/Main$Inner" },
      ],
    });

    const filtered = await cli.run({
      arguments: [
        "inspect-java-archive",
        path,
        "--query",
        "org.library",
        "--json",
      ],
    });
    expect(filtered.exitCode, filtered.stderr).toBe(0);
    expect(
      toolContract("inspect_java_archive").outputSchema.parse(filtered.json)
        .normalized_result.classes,
    ).toMatchObject({
      query: "org.library",
      total_matching: 1,
      next_offset: null,
      rows: [
        { name: "org/library/Helper", interfaces: ["java/lang/Runnable"] },
      ],
    });
  },
);

cliTest(
  "parses one class from a JAR with annotations, literals and nested entries",
  async ({ cli }) => {
    const { path } = await writeModJar("rea-java-cli-class-");
    const result = await cli.run({
      arguments: ["inspect-java-class", path, "com.example.mod.Main", "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = toolContract("inspect_java_class").outputSchema.parse(
      result.json,
    ).normalized_result;
    expect(report).toMatchObject({
      entry: "com/example/mod/Main.class",
      nested_class_entries: ["com/example/mod/Main$Inner.class"],
      class: {
        annotations: [
          {
            type: "Lnet/minecraftforge/fml/common/Mod;",
            elements: [
              {
                name: "modid",
                value: { kind: "constant", value: "examplemod" },
              },
              { name: "version", value: { kind: "constant", value: "1.0" } },
            ],
          },
        ],
        fields: [
          { name: "VERSION", constant_value: "1.0" },
          { name: "SEED", constant_value: "-2" },
        ],
        methods: [{ name: "preInit", code_bytes: 3 }],
      },
    });
    expect(report.class.string_constants).toContain(
      "Example \u{1F600}\u0000 loaded",
    );

    const missing = await cli.run({
      arguments: ["inspect-java-class", path, "com.example.Missing", "--json"],
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.json).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "inspect_java_class",
        issues: [{ path: ["class_name"], reason: "invalid_value" }],
      },
    });
  },
);

cliTest("rejects non-Java bytes as an unsupported target", async ({ cli }) => {
  const root = await createTestTempDirectory("rea-java-cli-unsupported-");
  const path = join(root, "notes.txt");
  await writeFile(path, "not a class file");
  const result = await cli.run({
    arguments: ["inspect-java-archive", path, "--json"],
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "unsupported_target",
    details: { operation: "inspect_java_archive", path },
  });
});

cliTest(
  "reports the decompiler as unavailable without a configured Vineflower JAR",
  async ({ cli }) => {
    const { path } = await writeModJar("rea-java-cli-unconfigured-");
    const result = await cli.run({
      arguments: [
        "decompile-java-class",
        path,
        "com.example.mod.Main",
        "--json",
      ],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "capability_unavailable",
      details: { provider_id: "vineflower", operation: "decompile_java_class" },
    });
  },
);

cliTest.skipIf(process.platform === "win32")(
  "stages the class and nested entries for a simulated decompiler and removes the private root",
  async ({ cli }) => {
    const { root, path } = await writeModJar("rea-java-cli-decompile-");
    const java = await createSimulatedJava(root);
    const result = await cli.run({
      arguments: [
        "decompile-java-class",
        path,
        "com.example.mod.Main",
        "--json",
      ],
      environment: java.environment,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = toolContract("decompile_java_class").outputSchema.parse(
      result.json,
    );
    expect(evidence).toMatchObject({
      subject: { format: "zip" },
      provider: { id: "vineflower", version: "9.9.9-test" },
      confidence: "derived",
    });
    const report = evidence.normalized_result;
    expect(report.entries).toEqual([
      "com/example/mod/Main.class",
      "com/example/mod/Main$Inner.class",
    ]);
    expect(report.source.text).toBe(
      "// simulated source for com/example/mod/Main.class\n// staged: com/example/mod/Main$Inner.class,com/example/mod/Main.class\n",
    );
    expect(report.tool_profile).toMatchObject({
      implementation_version: "9.9.9-test",
      java_executable: join(java.environment.JAVA_HOME, "bin", "java"),
      arguments: [
        "-jar",
        "<private-root>/engine.jar",
        "-dgs=1",
        "-log=WARN",
        "-e=<private-root>/library.jar",
        "<private-root>/input",
        "<private-root>/output",
      ],
    });
    const invocation = await java.readInvocation();
    expect(invocation.staged).toEqual([
      "com/example/mod/Main$Inner.class",
      "com/example/mod/Main.class",
    ]);
    await expect(access(invocation.cwd)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

cliTest.skipIf(process.platform === "win32")(
  "refuses to stage an archive entry that would escape the private root",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-java-cli-traversal-");
    const path = join(root, "crafted.jar");
    await writeFile(
      path,
      // A forged nested-class name matches the selected class's `$` prefix.
      await buildJar([
        ["p/A.class", buildClassFile({ name: "p/A" })],
        ["p/A$/../../../escape.class", buildClassFile({ name: "p/A$x" })],
      ]),
    );
    const java = await createSimulatedJava(root);
    const result = await cli.run({
      arguments: ["decompile-java-class", path, "p.A", "--json"],
      environment: java.environment,
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "unsupported_target",
      details: { operation: "decompile_java_class" },
    });
    await expect(java.readInvocation()).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      access(join(root, "..", "..", "escape.class")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);
