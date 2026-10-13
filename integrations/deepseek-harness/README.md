# REA for DeepSeek Harness

中文安装说明：`README.zh-CN.md`

A native **installable Harness bundle** exposing REA's existing local MCP server
as `mcp__rea__*` tools, using the current `dsh.bundle`/Cordis composition API.
The full REA engine remains authoritative; this adapter has no second reverse-
engineering engine or parallel tool schema to keep synchronized.

## Desktop installed the bundle but did not activate it

Symptoms: `~/.dsh/profiles/desktop/package.json` lists
`dsh-rea-bundle` in `dependencies`, but **not** in
`dsh.profile.bundles`. The generated `cordis.yml` has no
`rea-launcher` or `rea-mcp` entries, and there are no `mcp__rea__*` tools.

**Do not reinstall the already working package.** The upstream Harness
plugin manager separates **install** from **enable now**; closing the
post-install dialog without enabling can leave an installed, disabled bundle.
Prefer **Desktop → Plugins → Installed plugins → dsh-rea-bundle → Enable**,
then fully quit and restart Desktop.

If the UI toggle is missing or unusable, use this repository's
[`activate-installed.mjs`](scripts/activate-installed.mjs) recovery script
on your **local Mac only**. It has a read-only default and makes no pnpm,
network, or server calls. Its only opt-in mutation backs up the original
Desktop `package.json` and appends `dsh-rea-bundle` once to the ordered
bundle list; other plugins, dependencies, and lock files remain unchanged.

```sh
# Review the source before executing it.
curl -fL --retry 3 \
  -o "$HOME/Downloads/rea-desktop-activate.mjs" \
  https://raw.githubusercontent.com/xxxxxwater/rea/main/integrations/deepseek-harness/scripts/activate-installed.mjs
node "$HOME/Downloads/rea-desktop-activate.mjs" --status

# Fully quit DeepSeek Harness Desktop first:
node "$HOME/Downloads/rea-desktop-activate.mjs" --activate

# Relaunch Desktop; after cordis.yml is regenerated:
node "$HOME/Downloads/rea-desktop-activate.mjs" --verify
```

Successful activation prints the exact `package.json.rea-backup-...`
backup path. Re-running `--activate` is idempotent. No extra `dsh` CLI
installation or `allowBuilds` change is required. To restore the old
profile, fully quit Desktop and restore the byte-for-byte original backup.
The `--verify` result **only proves selected bundle + generated Cordis
configuration**; confirm that the MCP subprocess starts and that a new
Desktop session exposes `mcp__rea__*` separately. A prior local REA 6.4.0
handshake listed 170 tools, which is **not a universal runtime guarantee**.

## Desktop “Add plugin” — the supported Git installation spec

**Paste this exact URL**, including the `#dsh-plugin-v0.2.0` tag,
into DeepSeek Harness Desktop → **Plugins → Add plugin**:

```text
https://github.com/xxxxxwater/rea#dsh-plugin-v0.2.0
```

Do **not** paste the repository's untagged URL. It resolves to the
build-required `rea-agents` CLI on `main` and triggers
`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`. The **plugin tag** contains only
`dsh-rea-bundle` files at the repository root, including `dsh.bundle`,
and has no install-time scripts. This uses the Git-hosted package support in
the current Desktop plugin manager; it does not require `allowBuilds`.

Alternatively paste the versioned GitHub Release tarball URL directly:

```text
https://github.com/xxxxxwater/rea/releases/download/dsh-v0.2.0/dsh-rea-bundle-0.2.0.tgz
```

The URL is a plugin-install source, not a page to open in the browser.
After installing, enable **dsh-rea-bundle** and fully restart Desktop.
If an earlier mistaken installation created a `rea-agents` Git dependency,
remove only that item (preserving other plugins) before retrying.
For the separate `web` CLI profile, substitute `--profile web` in
`dsh plugin` commands; Desktop uses its own `desktop` profile.

## Requirements

- A DeepSeek Harness installation with the `dsh` CLI and `pnpm` on `PATH`.
- Node.js accepted by REA: `^22.19.0 || ^24.11.0 || >=26.0.0`.
- Optional analysis engines (Ghidra, IDA, JADX, etc.) remain **bring-your-own**.
- Permission to run locally installed code and to analyze the chosen target.

## Install: current DeepSeek Harness CLI (macOS / Linux)

Use a published GitHub Release **tarball** for a reproducible, build-free
install. As of 2026-10-13, npm's `@deepseek-ai/dsh@latest` dist-tag is
`0.2.0-rc.2`; upstream `master` can be newer/experimental. This procedure
uses the current `dsh plugin --profile <name> add ...` syntax and pins
this repository's REA plugin to release `dsh-v0.2.0`.

Prerequisites: a supported Node.js runtime, npm, network access on first
installation, and `pnpm` for plugin management. The bundle does not install
optional Ghidra, IDA or other analysis engines.

```sh
# Node.js: ^22.19, ^24.11, or >=26; macOS/Linux
npm install --global @deepseek-ai/dsh@latest pnpm@11

curl -fL --retry 3 --output dsh-rea-bundle-0.2.0.tgz https://github.com/xxxxxwater/rea/releases/download/dsh-v0.2.0/dsh-rea-bundle-0.2.0.tgz
printf '%s  %s\n' '011e78aebde2b71577286869b65719af83de888e01313445e744999d78844630' 'dsh-rea-bundle-0.2.0.tgz' | shasum -a 256 -c -

dsh plugin --profile web add ./dsh-rea-bundle-0.2.0.tgz
dsh --profile web --dump-config
dsh --profile web
```

The SHA-256 value above is the published GitHub release asset digest.
Do not continue if checksum verification fails. `--dump-config` is
a read-only **composition inspection**, not a successful live model-call test.
It should show a `dsh-rea-bundle` layer and `rea-launcher` / `rea-mcp` rows.
Restart your existing Harness process after installing.

To inspect the CLI version and npm's current distribution tags:

```sh
dsh --version
npm view @deepseek-ai/dsh dist-tags --json
```

### Install from a local checkout (development)

This alternative is for a cloned repository, **not** a GitHub URL with an
unverified subdirectory fragment. Linked packages keep their own
`node_modules`, so install the adapter's dependency before linking:

```sh
git clone https://github.com/xxxxxwater/rea.git
cd rea
npm install --prefix integrations/deepseek-harness --ignore-scripts
dsh plugin --profile web add "$(pwd)/integrations/deepseek-harness"
dsh --profile web --dump-config
```

To run the fork's compiled REA rather than the pinned npm runtime,
follow the instructions in the next section.

### DeepSeek Harness Desktop: fix `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`

**Cause.** If the error names `rea-agents@6.4.0` and downloads a Git archive
like `https://codeload.github.com/xxxxxwater/rea/tar.gz/<commit>`, the
Desktop plugin manager was given the **root REA repository** rather than the
installable `dsh-rea-bundle` package. Root `rea-agents` has a Git
`prepare` script. pnpm deliberately refuses it under its supply-chain
policy, and the root package does not declare `dsh.bundle`. Do **not** add
the root package to `allowBuilds`: it still would not be a Harness bundle.

**Fix with the Desktop UI** (requires no pnpm or npm CLI installation):

```sh
mkdir -p "$HOME/.dsh/plugin-packages"
curl -fL --retry 3 -o "$HOME/.dsh/plugin-packages/dsh-rea-bundle-0.2.0.tgz" \
  https://github.com/xxxxxwater/rea/releases/download/dsh-v0.2.0/dsh-rea-bundle-0.2.0.tgz
printf '%s  %s\n' '011e78aebde2b71577286869b65719af83de888e01313445e744999d78844630' "$HOME/.dsh/plugin-packages/dsh-rea-bundle-0.2.0.tgz" \
  | shasum -a 256 -c -
printf '%s\n' "$HOME/.dsh/plugin-packages/dsh-rea-bundle-0.2.0.tgz"
```

1. Open **DeepSeek Harness Desktop → Plugins → Add plugin** (the sidebar's
   Plugins page), and paste the **absolute local `.tgz` path** printed by
   the final command. Do **not** paste a Git URL or a remote tarball URL.
2. Install and enable **`dsh-rea-bundle`**, then completely quit and
   reopen Desktop. Inspect its plugin list for the `rea-launcher` and
   `rea-mcp` rows. If a prior `rea setup --client dsh` created a
   home-level `rea-mcp` patch, back up the patch and remove only that
   obsolete REA row: home patches override profile bundle configuration.
3. If Desktop's `~/.dsh/profiles/desktop/package.json` contains a direct
   `rea-agents` dependency referencing `xxxxxwater/rea` on GitHub,
   back up the profile, then remove **only that incorrect direct dependency**
   via the Desktop-bundled plugin manager, not by deleting the whole profile
   or editing `allowBuilds`. An installation that failed before saving
   the dependency may have nothing to remove.

**Alternative from a cloned REA checkout:**

```sh
bash integrations/deepseek-harness/scripts/prepare-desktop-install.sh
```

That script downloads the pinned GitHub Release asset, validates SHA-256,
keeps the archive in `$DSH_HOME/plugin-packages` (default `~/.dsh`),
and prints the path to paste into the Desktop installer. It does not mutate
the Desktop profile. After installing Desktop's **own** `dsh` command from
the application menu **Manage dsh Command…**, fully quit Desktop and
optionally run:

```sh
dsh plugin --profile desktop add "$HOME/.dsh/plugin-packages/dsh-rea-bundle-0.2.0.tgz"
```

A standalone `npm install -g @deepseek-ai/dsh` launcher may reject this
with `profile "desktop" is managed exclusively by the Electron application`.
Use the Desktop Plugins UI or its app-bundled CLI, not `dsh --profile
desktop` (which tries to boot the reserved profile).

### Desktop versus CLI

The commands above target the `web` **CLI profile**. A Desktop application
manages its own installed profile; install the same `dsh-rea-bundle-0.2.0.tgz`
through the Desktop application's supported plugin installer when available.
Do **not** run `dsh --profile desktop` (that name is reserved).
Native Desktop installation, including Intel macOS builds, needs validation
in the actual Desktop client and is not established by CLI CI.

### Run this fork's REA implementation

To run the code checked out from **xxxxxwater/rea** rather than upstream npm:

```sh
cd /absolute/path/to/rea
npm ci
npm run build:cached
export REA_DSH_ENTRYPOINT="$(pwd)/scripts/rea.mjs"
dsh --profile web
```

The environment variable must be an **absolute path** to an existing
`scripts/rea.mjs`. The plugin starts it with the Harness host's active
Node executable (`process.execPath`) and argument `mcp`, without `npx`,
shell interpolation, implicit upgrades, or downloads. A missing local
`dist/mcp/main.js` makes REA fail closed with its build instructions.

**Desktop users:** install into the active Desktop plugin profile through
the application/plugin manager, and ensure host-level overrides reach the
Desktop process. Do not assume Desktop runs CLI `--profile web`. In the
latest Harness CLI, `desktop` is a reserved profile name, not a normal
`dsh --profile desktop` target.

## Architecture and behavior

Two plugin rows are contributed to Harness composition:

1. `rea-launcher` provides the scoped Cordis `reaLauncher` service.
2. `rea-mcp` injects that service into the built-in
   `@deepseek-ai/dsh-mcp-client` over local `stdio`, which registers
   tools under `mcp__rea__<tool_name>` and handles disposal/reconnection.

By default the bundle sets `REA_DSH_SCHEMA_PROFILE=compact`. This reduces
model-facing schema bytes; REA still validates canonical full inputs. Set
`REA_DSH_SCHEMA_PROFILE=full` in the Harness host environment to advertise
full tool schemas. Unsupported values fail startup. Tool calls have a
120-second deadline. To tune this, use a later profile-owned Cordis patch
that restates the full `rea-mcp` config.

Example Harness prompt:

> Use REA to analyze the JavaScript application at /absolute/path/app.js;
> identify observations, derivations, and unresolved unknowns with evidence.

REA's local security and authority constraints still apply. Installing the
bundle does not authorize injection, process mutation, privileged operations,
or a target you are not permitted to analyze.

## Migrating from `rea setup --client dsh`

The legacy CLI setup places a `rea-mcp` row in
`$DSH_HOME/cordis.patch.yml`. **Home patch layers win over bundle layers**.
Back up that file, then remove only its legacy `rea-mcp` insertion, preserving
all unrelated configuration. Restart Harness. Keeping the same row ID avoids
creating a second default `rea` MCP namespace, but the legacy row will hide
this bundle until removed.

## Verify, upgrade and uninstall

```sh
# Inspect the effective profile without starting the app
dsh --profile web --dump-config

# Confirm the plugin is installed in this profile
dsh plugin --profile web why dsh-rea-bundle

# Uninstall the plugin and its bundle layer
dsh plugin --profile web remove dsh-rea-bundle
```

To upgrade the REA plugin, download the **new versioned release archive**
and run `dsh plugin --profile web add /absolute/path/to/new-bundle.tgz`.
Re-running `pnpm update` against an old local tarball cannot discover new
GitHub Releases. To upgrade the Harness CLI, use
`npm install --global @deepseek-ai/dsh@latest`, then restart it.

The dump should identify the `dsh-rea-bundle` layer, `rea-launcher`
and `rea-mcp`. If it identifies a home-patch override, migrate as above.
If it says the launcher is missing, check the npm dependency or local
`REA_DSH_ENTRYPOINT`. If REA says `dist/mcp/main.js` is missing, build
the fork checkout. Check target-engine prerequisites separately.

## Versioned GitHub release

GitHub Release `dsh-v0.2.0` is published with the build-free
`dsh-rea-bundle-0.2.0.tgz` file. Later `dsh-v*` releases use separate,
versioned archives. The root REA npm/MCP Registry release process remains
separate and unchanged.

## Tests and verification scope

```sh
node --test integrations/deepseek-harness/tests/*.test.mjs
node integrations/deepseek-harness/scripts/verify-package.mjs
```

GitHub Actions also checks npm pack contents, real packaged REA MCP
initialization/tool discovery, and latest-upstream Harness bundle composition.
A successful config dump alone does **not** establish a live DeepSeek model
API call, a Desktop GUI integration, or access to optional Ghidra/IDA/JEB.
These require separate end-to-end acceptance on the target system.
