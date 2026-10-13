import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { assertCleanLinuxHopperRuntime } from "../../../scripts/lib/clean-linux-hopper-runtime.mjs";
import { completeVerifierRun } from "../../../scripts/lib/verifier-run.mjs";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execFileAsync = promisify(execFile);

it.runIf(process.platform === "linux").each([
  ["Xvfb", "Clean Linux runner retained a Hopper demo process"],
  ["Hopper", "Clean Linux runner retained a Hopper demo process"],
  ["python3", "Cannot identify a command-less Python process"],
  ["unrelated", undefined],
] as const)(
  "observes an unreaped %s without signaling or reaping it",
  async (name, refusal) => {
    const directory = await createTestTempDirectory("rea-runtime-zombie-");
    const executable = join(directory, name);
    await copyFile("/usr/bin/true", executable);
    await chmod(executable, 0o700);
    // WNOWAIT observes exit without reaping. The parent keeps the zombie until
    // the test closes its stdin, then waitpid performs the actual cleanup.
    const parent = execFileAsync(
      "/usr/bin/python3",
      [
        "-c",
        `
import os, sys
pid = os.fork()
if pid == 0:
    os.execl(sys.argv[1], sys.argv[1])
try:
    os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)
    print(pid, flush=True)
    sys.stdin.buffer.read(1)
finally:
    os.waitpid(pid, 0)
`,
        executable,
      ],
      { timeout: 10_000 },
    );
    const ready = new Promise<number>((resolve, reject) => {
      parent.child.stdout?.once("data", (data: Buffer) =>
        resolve(Number(data.toString().trim())),
      );
      parent.catch(reject);
    });
    let zombiePid: number | undefined;
    try {
      zombiePid = await ready;
      expect(Number.isSafeInteger(zombiePid)).toBe(true);
      const prefix = `/proc/${String(zombiePid)}`;
      expect(await readFile(`${prefix}/cmdline`, "utf8")).toBe("");
      expect((await readFile(`${prefix}/comm`, "utf8")).trim()).toBe(name);
      const observation = assertCleanLinuxHopperRuntime([]);
      if (refusal === undefined)
        await expect(observation).resolves.toBeUndefined();
      else await expect(observation).rejects.toThrow(refusal);
      expect(await readFile(`${prefix}/stat`, "utf8")).toContain(
        `(${name}) Z `,
      );
    } finally {
      parent.child.stdin?.end("reap");
      await parent;
      if (zombiePid !== undefined)
        await expect(
          readFile(`/proc/${String(zombiePid)}/stat`, "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
    }
  },
);

it.runIf(process.platform === "linux")(
  "does not treat runtime names in another process's arguments as a runtime",
  async () => {
    const observer = new URL(
      "../../../scripts/lib/clean-linux-hopper-runtime.mjs",
      import.meta.url,
    ).href;
    const code = `
      const { assertCleanLinuxHopperRuntime } = await import(${JSON.stringify(observer)});
      await assertCleanLinuxHopperRuntime([]);
      console.log('clean');
    `;
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        code,
        "Xvfb",
        "/opt/hopper/bin/Hopper",
        "hopper-demo-x11.py",
      ],
      { timeout: 10_000 },
    );
    expect(stdout.trim()).toBe("clean");
  },
);

it.runIf(process.platform === "linux")(
  "distinguishes an ordinary Node script with the helper's filename",
  async () => {
    const directory = await createTestTempDirectory("rea-runtime-arguments-");
    const script = join(directory, "hopper-demo-x11.py");
    const observer = new URL(
      "../../../scripts/lib/clean-linux-hopper-runtime.mjs",
      import.meta.url,
    ).href;
    await writeFile(
      script,
      `
      import(${JSON.stringify(observer)}).then(async ({ assertCleanLinuxHopperRuntime }) => {
        await assertCleanLinuxHopperRuntime([]);
        console.log('clean');
      });
    `,
    );
    const { stdout } = await execFileAsync(process.execPath, [script], {
      timeout: 10_000,
    });
    expect(stdout.trim()).toBe("clean");
  },
);

it.runIf(process.platform === "linux").each([
  ["Xvfb-named Node", null, true],
  ["Python helper", [], true],
  ["Python helper with -u", ["-u"], true],
  [
    "Python helper with combined/value options",
    ["-Bu", "-W", "ignore", "-X", "dev", "--check-hash-based-pycs", "always"],
    true,
  ],
  ["Python helper after --", ["--"], true],
  [
    "Python -c script argument",
    ["-c", "import time; print('ready', flush=True); time.sleep(30)"],
    false,
  ],
  ["Python -m script argument", ["-m", "unrelated"], false],
  ["alternate launcher", null, true],
] as const)(
  "classifies a reparented %s without signaling it",
  async (mode, pythonOptions, retained) => {
    const runId = randomUUID();
    const childCode =
      "process.title = 'Xvfb'; setInterval(() => {}, 1000); process.send('ready');";
    const directory = await createTestTempDirectory("rea-clean-runtime-test-");
    const launcher = join(directory, "Hopper");
    const alternate = join(directory, "Hopper-alternate");
    const helper = join(directory, "hopper-demo-x11.py");
    const alternateMode = mode === "alternate launcher";
    const pythonMode = pythonOptions !== null;
    if (alternateMode) {
      await copyFile("/usr/bin/sleep", launcher);
      await chmod(launcher, 0o700);
      await symlink(launcher, alternate);
    }
    if (pythonMode) {
      await writeFile(
        helper,
        "import time\nprint('ready', flush=True)\ntime.sleep(30)\n",
      );
      await copyFile(helper, join(directory, "unrelated.py"));
    }
    const command = alternateMode
      ? alternate
      : pythonMode
        ? "/usr/bin/python3"
        : process.execPath;
    const arguments_ = alternateMode
      ? ["30"]
      : pythonMode
        ? [...pythonOptions, helper]
        : ["-e", childCode];
    const stdio = alternateMode
      ? "ignore"
      : pythonMode
        ? ["ignore", "pipe", "ignore"]
        : ["ignore", "ignore", "ignore", "ipc"];
    const parentCode = `
      const { spawn } = require('node:child_process');
      const child = spawn(${JSON.stringify(command)}, ${JSON.stringify(arguments_)}, {
        detached: true, stdio: ${JSON.stringify(stdio)}, cwd: ${JSON.stringify(directory)}
      });
      child.once('error', () => process.exit(1));
      const ready = () => {
        process.stdout.write(JSON.stringify({ pid: child.pid, parentPid: process.pid }));
        if (child.connected) child.disconnect();
        child.stdout?.destroy();
        child.unref();
      };
      ${pythonMode ? "child.stdout.once('data', ready);" : `child.once(${JSON.stringify(alternateMode ? "spawn" : "message")}, ready);`}
    `;
    const parent = execFileAsync(process.execPath, ["-e", parentCode], {
      env: { ...process.env, REA_PROCESS_RUN_ID: runId },
      timeout: 10_000,
    });
    const parentPid = parent.child.pid;
    if (parentPid === undefined)
      throw new Error("Fixture parent did not spawn");
    let orphanPid: number | undefined;
    try {
      const { stdout } = await parent;
      const { pid } = JSON.parse(stdout) as { pid: number };
      orphanPid = pid;
      const { stdout: coordinates } = await execFileAsync("ps", [
        "-p",
        String(pid),
        "-o",
        "ppid=,pgid=",
      ]);
      const [currentParent, group] = coordinates
        .trim()
        .split(/\s+/u)
        .map(Number);
      expect(currentParent).not.toBe(parentPid);
      expect(group).toBe(pid);

      const lineage = await completeVerifierRun({
        run_id: runId,
        verifier_pid: process.pid,
        parent_pid: process.ppid,
      });
      expect(lineage.process_lineage.status).toBe("verified");
      if (lineage.process_lineage.status === "verified")
        expect(
          lineage.process_lineage.descendants.some((p) => p.pid === pid),
        ).toBe(false);

      if (alternateMode) {
        const commandLine = await readFile(
          `/proc/${String(pid)}/cmdline`,
          "utf8",
        );
        expect(commandLine.split("\0")[0]).toBe(alternate);
        await unlink(alternate);
      }
      if (pythonMode) {
        const commandLine = await readFile(
          `/proc/${String(pid)}/cmdline`,
          "utf8",
        );
        expect(
          commandLine.split("\0").slice(0, pythonOptions.length + 2),
        ).toEqual([command, ...pythonOptions, helper]);
      }
      const observation = assertCleanLinuxHopperRuntime(
        alternateMode ? [launcher] : [],
      );
      if (retained)
        await expect(observation).rejects.toThrow(
          "Clean Linux runner retained a Hopper demo process",
        );
      else await expect(observation).resolves.toBeUndefined();
      // Observation must not terminate the fixture, even though it resembles Xvfb.
      const { stdout: alive } = await execFileAsync("ps", [
        "-p",
        String(pid),
        "-o",
        "stat=",
      ]);
      expect(alive.trim()).not.toMatch(/^Z/u);
    } finally {
      if (orphanPid !== undefined) {
        const cleanup = await cleanupOwnedProcessGroup({
          runId,
          leaderPid: orphanPid,
          processGroupId: orphanPid,
        });
        expect(cleanup.cleaned, JSON.stringify(cleanup)).toBe(true);
      }
    }
  },
);
