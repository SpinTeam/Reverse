import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/activate-installed.mjs");

function fixture(fn, options = {}) {
  const home = mkdtempSync(join(tmpdir(), "rea-desktop-activation-"));
  const profile = join(home, "profiles", "desktop");
  const bundleDir = join(profile, "node_modules", "dsh-rea-bundle");
  mkdirSync(bundleDir, { recursive: true });
  const earlier = Array.from({ length: 35 }, (_, n) => n === 34 ? "dsh-prompt-enhancer" : "other-" + n);
  const manifest = join(profile, "package.json");
  const document = {
    dependencies: {
      "another-plugin": "1.0.0",
      ...options.noDependency ? {} : {
        "dsh-rea-bundle": "https://github.com/xxxxxwater/rea/releases/download/dsh-v0.2.0/dsh-rea-bundle-0.2.0.tgz",
      },
    },
    dsh: { profile: { bundles: options.active ? [...earlier, "dsh-rea-bundle"] : earlier } },
    settings: { retain: true },
  };
  writeFileSync(manifest, JSON.stringify(document, null, 2) + "\n");
  if (!options.badPackage) {
    writeFileSync(join(bundleDir, "package.json"), JSON.stringify({
      name: "dsh-rea-bundle",
      version: "0.2.0",
      dsh: { bundle: { patch: "./cordis.patch.yml" } },
    }));
    writeFileSync(join(bundleDir, "cordis.patch.yml"),
      "- insert:\n    - id: rea-launcher\n      name: dsh-rea-bundle/launcher\n"
      + "    - id: rea-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n");
  }
  const run = (args) => spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, DSH_HOME: home },
  });
  try {
    fn({ manifest, profile, document, run });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function backups(profile) {
  return readdirSync(profile).filter((item) => item.startsWith("package.json.rea-backup-"));
}

test("status reports installed-but-disabled without changing the profile", () => {
  fixture(({ manifest, profile, run }) => {
    const original = readFileSync(manifest);
    const result = run([]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Enabled in dsh\.profile\.bundles: NO \(35 bundles\)/);
    assert.deepEqual(readFileSync(manifest), original);
    assert.deepEqual(backups(profile), []);
  });
});

test("activation preserves 35 entries, other dependencies and exact backup; is idempotent", () => {
  fixture(({ manifest, profile, document, run }) => {
    const old = readFileSync(manifest);
    const first = run(["--activate"]);
    assert.equal(first.status, 0, first.stderr);
    const after = JSON.parse(readFileSync(manifest, "utf8"));
    assert.deepEqual(after.dsh.profile.bundles.slice(0, 35), document.dsh.profile.bundles);
    assert.equal(after.dsh.profile.bundles[35], "dsh-rea-bundle");
    assert.deepEqual(after.dependencies, document.dependencies);
    assert.deepEqual(after.settings, document.settings);
    assert.equal(backups(profile).length, 1);
    assert.deepEqual(readFileSync(join(profile, backups(profile)[0])), old);
    const newer = readFileSync(manifest);
    const second = run(["--activate"]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Already enabled/);
    assert.deepEqual(readFileSync(manifest), newer);
    assert.equal(backups(profile).length, 1);
  });
});

test("rejects missing dependency, invalid bundle, and malformed profile without writing", () => {
  for (const options of [{ noDependency: true }, { badPackage: true }]) {
    fixture(({ manifest, profile, run }) => {
      const original = readFileSync(manifest);
      const outcome = run(["--activate"]);
      assert.notEqual(outcome.status, 0);
      assert.deepEqual(readFileSync(manifest), original);
      assert.deepEqual(backups(profile), []);
    }, options);
  }
  fixture(({ manifest, profile, run }) => {
    writeFileSync(manifest, "{ corrupt");
    assert.notEqual(run(["--activate"]).status, 0);
    assert.deepEqual(backups(profile), []);
  });
});

test("post-restart verification distinguishes enabled from actually composed", () => {
  fixture(({ profile, run }) => {
    assert.notEqual(run(["--verify"]).status, 0);
    writeFileSync(join(profile, "cordis.yml"), "- id: something-else\n");
    assert.match(run(["--verify"]).stderr, /lacks rea-launcher/);
    writeFileSync(join(profile, "cordis.yml"),
      "- id: rea-launcher\n- id: rea-mcp\n");
    const final = run(["--verify"]);
    assert.equal(final.status, 0, final.stderr);
    assert.match(final.stdout, /PASS: selected bundle/);
  }, { active: true });
});

test("unknown options and malformed bundle array fail closed", () => {
  fixture(({ manifest, profile, run }) => {
    assert.notEqual(run(["--activate", "--verify"]).status, 0);
    const p = JSON.parse(readFileSync(manifest, "utf8"));
    p.dsh.profile.bundles = "invalid";
    writeFileSync(manifest, JSON.stringify(p));
    assert.notEqual(run(["--activate"]).status, 0);
    assert.deepEqual(backups(profile), []);
  });
});

test("verification rejects stale Cordis output despite matching row IDs", () => {
  fixture(({ manifest, profile, run }) => {
    const compiled = join(profile, "cordis.yml");
    writeFileSync(compiled, "- id: rea-launcher\n- id: rea-mcp\n");
    const now = new Date();
    const stale = new Date(now.getTime() - 10000);
    utimesSync(compiled, stale, stale);
    utimesSync(manifest, now, now);
    const old = run(["--verify"]);
    assert.notEqual(old.status, 0);
    assert.match(old.stderr, /older than the profile change/);
    const fresh = new Date(now.getTime() + 2000);
    utimesSync(compiled, fresh, fresh);
    assert.equal(run(["--verify"]).status, 0);
  }, { active: true });
});

test("duplicate bundle selection is rejected without modifying any file", () => {
  fixture(({ manifest, profile, run }) => {
    const p = JSON.parse(readFileSync(manifest, "utf8"));
    p.dsh.profile.bundles.push("other-2");
    writeFileSync(manifest, JSON.stringify(p) + "\n");
    const before = readFileSync(manifest);
    const outcome = run(["--activate"]);
    assert.notEqual(outcome.status, 0);
    assert.match(outcome.stderr, /duplicates/);
    assert.deepEqual(readFileSync(manifest), before);
    assert.deepEqual(backups(profile), []);
  });
});
