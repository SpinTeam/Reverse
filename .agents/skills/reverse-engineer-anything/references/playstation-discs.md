# PlayStation 1 disc inspection

Use this route to identify a disc's boot executable, preserve its declarations
and trace extracted bytes back to the original sectors. Resolve
`scripts/ps1_inspect.py` relative to this skill directory, independent of the
working directory. Python 3.10+ and its standard library are required only for
this helper; REA setup does not install Python. It performs no network access or
target-code execution and opens no analysis engine.

For ZIP input, first use REA's archive inventory/extraction workflow. Select a
new extraction directory and keep the original CUE and every referenced track.
An archive listing alone does not establish a valid disc or executable.

## Inspect and preserve the boot file

```sh
python3 /path/to/reverse-engineer-anything/scripts/ps1_inspect.py /local/disc.cue \
  --out /local/evidence/disc.json --boot-out /local/evidence/boot.psx
```

Stdout returns boot facts, hashes, source mapping, warnings and an inventory
entry count with explicit omission of the directory entries. `--out` retains
the full JSON report; read selected entries from that file when needed. Use
`--full` only when the complete inventory is useful inline. Omit output paths
for read-only inspection. Every requested output
must use a new path; existing files are refused. Files publish individually;
a later output failure can leave an earlier successful boot copy. Preserve that
copy and report the failed output rather than claiming the entire run succeeded.

The JSON is a helper inspection report, not a REA Evidence envelope. It records
input SHA-256 and file identity, CUE tracks, the ISO9660 index, raw SYSTEM.CNF
text, selected boot path, complete executable/payload hashes and limitations.
Sources are rehashed after inspection; changed sources fail the run. Boot copies
retain the full 2 KiB header, payload and trailing bytes.

`boot_source` binds the boot extent to its track path and digest. For byte `n`
of the complete extracted executable, the physical source offset is:

```text
first_physical_sector_offset
  + floor(n / logical_block_bytes) * physical_sector_stride
  + data_offset_in_sector + (n % logical_block_bytes)
```

Raw-sector file bytes are not contiguous logical executable bytes: exclude sector
headers and trailers using this mapping. `initial_pc` and `load_address` are
separate declarations. Executable file offset `0x800` maps to `load_address`;
the initial PC may lie elsewhere. Header warnings do not establish a valid
engine load, instruction semantics or executed behavior.

## Hand off to REA

Use the preserved **complete** boot executable as the input to `open_binary`,
with a provider that advertises PS-X EXE support. Verify the connected server's
capabilities first when support is unknown: a proposed upstream loader does not
make an older installed release support PS-X EXE. If admission returns
`unsupported binary format` or `target_unavailable`, preserve the inspection
report and use an explicitly mapped external PS-X loader. Do not repeatedly
retry disc images or add MIPS to a generic raw-load contract that cannot express
both load address and entry PC.

Compare the admitted executable digest with `boot_executable.file_sha256` and
retain both the helper report and subsequent REA Evidence. Ghidra pseudocode is
a derived interpretation; identifying overlays, BIOS calls, GTE behavior and
delay slots requires additional analysis. Disc inspection does not prove
emulation, reconstruction or recompilation fidelity. Follow the user's requested
analysis objective; browser gameplay is a separate task when requested.

## Supported layouts and budgets

- Cooked MODE1/2048 ISO, raw MODE1/2352, MODE2/2352 Form1 and MODE2/2336 Form1.
- One data track with optional AUDIO tracks; CUE INDEX 01 is file-relative and
  accounts for a stored pregap. For a bare BIN, a unique PVD layout is required.
- ISO9660 single-extent files, nested SYSTEM.CNF boot paths and PSX.EXE fallback
  when SYSTEM.CNF is absent. Standalone complete PS-X executables are accepted.

The helper caps CUE text at 1 MiB, directories at 16 MiB each, the directory
tree at 20,000 entries/16 levels, and boot or standalone executables at 64 MiB.
These are inspection memory/work budgets, not PS1 format maxima. It hashes
complete input tracks twice to bind the report to unchanged sources; large audio
tracks therefore add I/O even though their streams are not decoded.

CHD/PBP/ECM, UDF/Joliet, multiple data tracks, mixed sector strides in one file,
multi-extent/interleaved files, EDC/ECC and complete XA/CDDA integrity are outside
coverage. Report malformed structures and unsupported boundaries precisely;
neither establishes game incompatibility. Keep private disc and extracted bytes
out of source packages and public review fixtures.
