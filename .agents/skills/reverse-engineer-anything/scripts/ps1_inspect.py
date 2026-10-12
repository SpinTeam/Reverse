#!/usr/bin/env python3
"""Inspect local PS1 CUE/BIN, ISO and PS-X EXE declarations. Python 3.10+ stdlib."""
# MIT License
#
# Copyright (c) 2026 Elliot
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import sys
import tempfile

VERSION = "0.2.0"
BLOCK = 2048
SYNC = b"\0" + b"\xff" * 10 + b"\0"
MODES = {"MODE1/2048": 2048, "MODE1/2352": 2352,
         "MODE2/2352": 2352, "MODE2/2336": 2336}


class InspectionError(ValueError):
    """A source is malformed or outside supported formats and resource budgets."""


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def source_record(path):
    path = Path(path).resolve()
    def identity():
        observed = path.stat()
        return {"device": observed.st_dev, "inode": observed.st_ino,
                "mtime_ns": observed.st_mtime_ns, "bytes": observed.st_size}
    before = identity()
    digest = sha256_file(path)
    if identity() != before:
        raise InspectionError("source changed while hashing")
    return {"path": str(path), "bytes": before["bytes"], "sha256": digest,
            "local_identity": before}


def write_new_bytes(path, data):
    """Atomically publish a new local file; never overwrite an existing path."""
    path = Path(path).absolute()
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".ps1-output-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, path)
    finally:
        os.unlink(temporary)


def safe_track_reference(name):
    if not name or "\\" in name or "\0" in name or name != name.strip():
        raise InspectionError(f"unsafe CUE track path: {name!r}")
    if name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        raise InspectionError(f"absolute CUE track path: {name!r}")
    parts = name.rstrip("/").split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise InspectionError(f"unsafe CUE track path: {name!r}")
    if len(parts) > 32 or len(name) > 1024:
        raise InspectionError("CUE track path exceeds inspection limits")
    return PurePosixPath(*parts)


def parse_exe(data):
    if len(data) < BLOCK:
        raise InspectionError("truncated PS-X EXE header (requires 2048 bytes)")
    if data[:8] != b"PS-X EXE":
        raise InspectionError("boot executable has no PS-X EXE signature")
    values = struct.unpack_from("<10I", data, 0x10)
    pc, gp, address, length, data_addr, data_size, bss_addr, bss_size, stack, stack_offset = values
    if length == 0:
        raise InspectionError("empty PS-X EXE payload")
    if length > len(data) - BLOCK:
        raise InspectionError("truncated PS-X EXE payload")
    if address + length > 2**32 or bss_addr + bss_size > 2**32:
        raise InspectionError("PS-X EXE memory range overflows 32 bits")
    warnings = []
    if length % BLOCK:
        warnings.append("Declared payload length is not a multiple of 2048 bytes.")
    if pc % 4 or address % 4:
        warnings.append("Initial PC or load address is not word aligned.")
    if not address <= pc < address + length:
        warnings.append("Initial PC is outside the directly loaded range; investigate address aliases or startup code.")
    if (address & 0x1fffffff) + length > 0x200000:
        warnings.append("Declared payload does not fit original PS1 2 MiB main RAM; no valid load is established.")
    if stack and stack + stack_offset > 0xffffffff:
        warnings.append("Declared stack pointer overflows 32 bits; wrapped display is not a valid stack setup.")
    return {"format": "PS-X EXE", "header_bytes": BLOCK,
            "initial_pc": f"0x{pc:08x}", "initial_gp": f"0x{gp:08x}",
            "load_address": f"0x{address:08x}", "payload_bytes": length,
            "load_end_exclusive": f"0x{address + length:08x}",
            "data_address": f"0x{data_addr:08x}", "data_bytes": data_size,
            "bss_address": f"0x{bss_addr:08x}", "bss_bytes": bss_size,
            "stack_base": f"0x{stack:08x}", "stack_offset": stack_offset,
            "initial_stack_pointer": f"0x{(stack + stack_offset) & 0xffffffff:08x}" if stack else None,
            "file_sha256": hashlib.sha256(data).hexdigest(),
            "payload_sha256": hashlib.sha256(data[BLOCK:BLOCK + length]).hexdigest(),
            "trailing_bytes": len(data) - BLOCK - length, "warnings": warnings}


def parse_cue(path):
    path = Path(path).resolve()
    if path.stat().st_size > 1024 * 1024:
        raise InspectionError("CUE exceeds inspection limit")
    tracks, current_file, current = [], None, None
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        match = re.fullmatch(r'FILE\s+(?:"([^"]+)"|(\S+))\s+(\S+)', line, re.I)
        if match:
            if match[3].upper() != "BINARY":
                raise InspectionError("only BINARY CUE files are supported")
            relative = match[1] or match[2]
            # Accept ordinary Windows separators in local CUE references, never traversal.
            member = safe_track_reference(relative.replace("\\", "/"))
            current_file = path.parent.joinpath(*member.parts).resolve()
            if not current_file.is_relative_to(path.parent):
                raise InspectionError("CUE file reference escapes its directory")
            if not current_file.is_file():
                raise InspectionError(f"missing CUE companion: {relative}")
            current = None
        elif (match := re.fullmatch(r"TRACK\s+(\d+)\s+(\S+)", line, re.I)):
            if current_file is None:
                raise InspectionError("CUE TRACK has no FILE")
            current = {"number": int(match[1]), "mode": match[2].upper(),
                       "file": str(current_file), "indexes": {}}
            if current["mode"] not in MODES and current["mode"] != "AUDIO":
                raise InspectionError(f"unsupported CUE track mode: {current['mode']}")
            tracks.append(current)
        elif (match := re.fullmatch(r"INDEX\s+(\d+)\s+(\d+):(\d+):(\d+)", line, re.I)):
            if current is None or int(match[3]) >= 60 or int(match[4]) >= 75:
                raise InspectionError("invalid CUE INDEX")
            index = int(match[1])
            if index in current["indexes"]:
                raise InspectionError("duplicate CUE INDEX")
            current["indexes"][index] = int(match[2]) * 4500 + int(match[3]) * 75 + int(match[4])
        elif line.upper().startswith(("FILE ", "TRACK ", "INDEX ")):
            raise InspectionError("malformed CUE structural directive")
    if not tracks or any(1 not in track["indexes"] for track in tracks):
        raise InspectionError("CUE must declare INDEX 01 for every track")
    numbers = [track["number"] for track in tracks]
    if numbers != sorted(set(numbers)):
        raise InspectionError("CUE track numbers must increase without duplicates")
    for idx, track in enumerate(tracks):
        stride = MODES.get(track["mode"], 2352)
        size = Path(track["file"]).stat().st_size
        if size % stride:
            raise InspectionError("CUE companion has a truncated physical sector")
        start = track["indexes"][1]
        end = size // stride
        if 0 in track["indexes"] and track["indexes"][0] > start:
            raise InspectionError("CUE INDEX 00 follows INDEX 01")
        if idx + 1 < len(tracks) and tracks[idx + 1]["file"] == track["file"]:
            following = tracks[idx + 1]
            if MODES.get(following["mode"], 2352) != stride:
                raise InspectionError("mixed sector strides in one CUE file are unsupported")
            end = following["indexes"].get(0, following["indexes"][1])
        if not 0 <= start < end <= size // stride:
            raise InspectionError("CUE indexes lie outside track bounds")
        track["start_sector_in_file"], track["end_sector_in_file"] = start, end
    return tracks


class DiscReader:
    def __init__(self, path, mode=None, start=0, end=None):
        self.path = Path(path).resolve()
        self.file = self.path.open("rb")
        self.size = self.path.stat().st_size
        try:
            self.mode = mode or self.detect()
            self.stride = MODES[self.mode]
            if self.size % self.stride:
                raise InspectionError("disc image has a truncated physical sector")
            self.start = start
            self.end = end if end is not None else self.size // self.stride
            if not 0 <= self.start < self.end <= self.size // self.stride:
                raise InspectionError("invalid data track bounds")
            self.sectors = self.end - self.start
        except Exception:
            self.file.close()
            raise

    def detect(self):
        matches = []
        for mode, stride in MODES.items():
            offset = {"MODE1/2048": 0, "MODE1/2352": 16,
                      "MODE2/2352": 24, "MODE2/2336": 8}[mode]
            self.file.seek(16 * stride + offset)
            if self.file.read(7) == b"\x01CD001\x01":
                matches.append(mode)
        if len(matches) != 1:
            raise InspectionError("no unique ISO9660 data layout; provide the original CUE for pregaps/multitrack images")
        return matches[0]

    def sector(self, lba):
        if not 0 <= lba < self.sectors:
            raise InspectionError("ISO extent points outside the data track")
        self.file.seek((self.start + lba) * self.stride)
        raw = self.file.read(self.stride)
        if len(raw) != self.stride:
            raise InspectionError("truncated physical sector")
        if self.mode == "MODE1/2048":
            return raw
        if self.stride == 2352:
            expected = 1 if self.mode == "MODE1/2352" else 2
            if raw[:12] != SYNC or raw[15] != expected:
                raise InspectionError(f"invalid raw sector sync/mode at LBA {lba}")
            if expected == 1:
                return raw[16:16 + BLOCK]
            raw = raw[16:]
        if raw[:4] != raw[4:8]:
            raise InspectionError(f"Mode2 subheader copies differ at LBA {lba}")
        if raw[2] & 0x20:
            raise InspectionError(f"Mode2 Form2 cannot hold an ISO9660 logical block at LBA {lba}")
        return raw[8:8 + BLOCK]

    def extent(self, lba, length, limit=64 * 1024**2):
        if length < 0 or length > limit or lba + (length + BLOCK - 1) // BLOCK > self.sectors:
            raise InspectionError("ISO extent is outside bounds or exceeds inspection limit")
        return b"".join(self.sector(lba + idx) for idx in range((length + BLOCK - 1) // BLOCK))[:length]

    def close(self):
        self.file.close()


def both32(data, offset):
    left, right = struct.unpack_from("<I", data, offset)[0], struct.unpack_from(">I", data, offset + 4)[0]
    if left != right:
        raise InspectionError("ISO9660 little/big-endian copies disagree")
    return left


def directory_record(data):
    if len(data) < 34 or data[0] != len(data) or 33 + data[32] > len(data):
        raise InspectionError("malformed ISO9660 directory record")
    if data[1] or data[26] or data[27] or data[25] & 0x80:
        raise InspectionError("ISO extended attributes, interleaving or multi-extent entries are unsupported")
    name_bytes = data[33:33 + data[32]]
    if name_bytes in (b"\0", b"\x01"):
        name = "." if name_bytes == b"\0" else ".."
    else:
        try:
            name = name_bytes.decode("ascii")
        except UnicodeDecodeError as error:
            raise InspectionError("non-ASCII ISO9660 identifiers are unsupported") from error
        if any(char in name for char in "/\\\0"):
            raise InspectionError("unsafe ISO9660 identifier")
    return {"name": name, "lba": both32(data, 2), "bytes": both32(data, 10),
            "directory": bool(data[25] & 2)}


def iso_index(reader):
    pvd = reader.sector(16)
    if pvd[:7] != b"\x01CD001\x01":
        raise InspectionError("missing ISO9660 primary volume descriptor")
    volume_blocks = both32(pvd, 80)
    if not 17 <= volume_blocks <= reader.sectors:
        raise InspectionError("ISO9660 volume exceeds available data track")
    if struct.unpack_from("<H", pvd, 128)[0] != BLOCK or struct.unpack_from(">H", pvd, 130)[0] != BLOCK:
        raise InspectionError("ISO9660 logical block size must be 2048")
    root = directory_record(pvd[156:156 + pvd[156]])
    if not root["directory"]:
        raise InspectionError("ISO9660 root is not a directory")
    if root["lba"] + (root["bytes"] + BLOCK - 1) // BLOCK > volume_blocks:
        raise InspectionError("ISO9660 root exceeds declared volume")
    queue, seen_dirs, seen_paths, entries = [("", root, 0)], set(), set(), []
    while queue:
        prefix, directory, depth = queue.pop(0)
        if depth > 16 or len(entries) > 20000:
            raise InspectionError("ISO directory tree exceeds inspection limits")
        identity = (directory["lba"], directory["bytes"])
        if identity in seen_dirs:
            raise InspectionError("ISO directory cycle or alias is unsupported")
        seen_dirs.add(identity)
        raw = reader.extent(*identity, limit=16 * 1024**2)
        cursor = 0
        while cursor < len(raw):
            size = raw[cursor]
            if size == 0:
                cursor = (cursor // BLOCK + 1) * BLOCK
                continue
            if cursor + size > len(raw) or cursor % BLOCK + size > BLOCK:
                raise InspectionError("ISO directory record crosses its block/extent")
            entry = directory_record(raw[cursor:cursor + size])
            cursor += size
            if entry["lba"] + (entry["bytes"] + BLOCK - 1) // BLOCK > volume_blocks:
                raise InspectionError("ISO directory entry exceeds declared volume")
            if entry["name"] in (".", ".."):
                continue
            entry["path"] = prefix + entry["name"]
            path_key = entry["path"].casefold()
            if path_key in seen_paths:
                raise InspectionError("duplicate ISO9660 path")
            seen_paths.add(path_key)
            entries.append(entry)
            if len(entries) > 20000:
                raise InspectionError("ISO directory tree exceeds inspection limits")
            if entry["directory"]:
                queue.append((entry["path"] + "/", entry, depth + 1))
    return {"volume_id": pvd[40:72].decode("ascii", errors="replace").rstrip(),
            "volume_blocks": volume_blocks, "entries": entries}


def normalize_iso_path(path):
    return "/".join(re.sub(r";\d+$", "", part).upper() for part in path.replace("\\", "/").lstrip("/").split("/"))


def inspect_disc(path, boot_out=None, source=None):
    path = Path(path).resolve()
    # Capture the CUE before interpreting it, not after reading its directives.
    source = source or source_record(path)
    tracks = parse_cue(path) if path.suffix.lower() == ".cue" else None
    if tracks is not None and source_record(path) != source:
        raise InspectionError("disc source changed during inspection; discard this run")
    if tracks:
        data_tracks = [track for track in tracks if track["mode"] != "AUDIO"]
        if len(data_tracks) != 1:
            raise InspectionError("exactly one data track is supported")
        track = data_tracks[0]
        sources = [source] + [source_record(name) for name in dict.fromkeys(track["file"] for track in tracks)]
        reader = DiscReader(track["file"], track["mode"], track["start_sector_in_file"], track["end_sector_in_file"])
    else:
        sources = [source]
        reader = DiscReader(path)
    try:
        opened = os.fstat(reader.file.fileno())
        opened_identity = {"device": opened.st_dev, "inode": opened.st_ino,
                           "mtime_ns": opened.st_mtime_ns, "bytes": opened.st_size}
        expected = next(item for item in sources if item["path"] == str(reader.path))
        if opened_identity != expected["local_identity"]:
            raise InspectionError("disc source changed during inspection; discard this run")
        index = iso_index(reader)
        files = {normalize_iso_path(entry["path"]): entry for entry in index["entries"] if not entry["directory"]}
        if len(files) != sum(not entry["directory"] for entry in index["entries"]):
            raise InspectionError("ambiguous versioned ISO9660 paths")
        config = files.get("SYSTEM.CNF")
        warnings = []
        cnf = None
        if config:
            cnf_bytes = reader.extent(config["lba"], config["bytes"], limit=65536)
            try:
                cnf = cnf_bytes.decode("ascii").rstrip("\0")
            except UnicodeDecodeError as error:
                raise InspectionError("SYSTEM.CNF is not ASCII text") from error
            matches = re.findall(r"^\s*BOOT\s*=\s*cdrom\d?:\s*([^\r\n]+)", cnf, re.I | re.M)
            if len(matches) != 1:
                raise InspectionError("SYSTEM.CNF needs one unambiguous BOOT=cdrom path")
            boot = normalize_iso_path(matches[0].strip().strip('"'))
            if any(part in ("", ".", "..") for part in boot.split("/")):
                raise InspectionError("unsafe SYSTEM.CNF boot path")
        else:
            boot = "PSX.EXE"
            warnings.append("SYSTEM.CNF absent; using documented PSX.EXE fallback.")
        if boot not in files:
            raise InspectionError(f"boot executable not found in ISO9660: {boot}")
        entry = files[boot]
        exe_bytes = reader.extent(entry["lba"], entry["bytes"])
        exe = parse_exe(exe_bytes)
        if any(source_record(source["path"]) != source for source in sources):
            raise InspectionError("disc source changed during inspection; discard this run")
        if boot_out is not None:
            write_new_bytes(boot_out, exe_bytes)
            if sha256_file(boot_out) != exe["file_sha256"]:
                raise InspectionError("preserved boot executable hash does not match inspected bytes")
        return {"schema": "ps1-disc-evidence-v1", "inspector_version": VERSION,
                "sources": sources, "tracks": tracks, "data_layout": {
                    "mode": reader.mode, "physical_sector_bytes": reader.stride,
                    "start_sector_in_file": reader.start, "data_track_sectors": reader.sectors},
                "iso9660": index, "system_cnf": cnf, "boot_path": entry["path"],
                "boot_source": {"path": str(reader.path), "sha256": expected["sha256"],
                                "logical_lba": entry["lba"], "bytes": entry["bytes"],
                                "first_physical_sector_offset": (reader.start + entry["lba"]) * reader.stride,
                                "physical_sector_stride": reader.stride,
                                "logical_block_bytes": BLOCK,
                                "data_offset_in_sector": {"MODE1/2048": 0, "MODE1/2352": 16,
                                                          "MODE2/2352": 24, "MODE2/2336": 8}[reader.mode]},
                "boot_executable": exe, "warnings": warnings,
                "preserved_boot_executable": str(Path(boot_out).absolute()) if boot_out else None,
                "limits": ["Structural inspection only; no game code execution or compatibility claim.",
                           "Raw sector EDC/ECC and complete audio/XA stream integrity are not verified.",
                           "ISO9660 single extents only; UDF/Joliet, CHD/PBP/ECM and mixed-stride CUE files are unsupported."]}
    finally:
        reader.close()


def summarize_report(report, output=None):
    """Keep boot answers inline; retain the full directory inventory on request."""
    summary = dict(report)
    if "iso9660" in report:
        inventory = report["iso9660"]
        summary["schema"] = "ps1-disc-summary-v1"
        summary["iso9660"] = {"volume_id": inventory["volume_id"],
                              "volume_blocks": inventory["volume_blocks"],
                              "entry_count": len(inventory["entries"]),
                              "entries_omitted": True}
    summary["report_path"] = str(Path(output).absolute()) if output else None
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, help="local CUE/BIN, ISO or complete PS-X EXE")
    parser.add_argument("--out", type=Path, help="write inspection JSON to a new file")
    parser.add_argument("--full", action="store_true", help="include the complete directory inventory on stdout")
    parser.add_argument("--boot-out", type=Path, help="preserve the full boot executable at a new path")
    args = parser.parse_args(argv)
    try:
        before = source_record(args.path)
        with args.path.open("rb") as source:
            magic = source.read(8)
        if magic == b"PS-X EXE":
            if before["bytes"] > 64 * 1024**2:
                raise InspectionError("standalone executable exceeds 64 MiB inspection limit")
            exe_bytes = args.path.read_bytes()
            result = {"schema": "ps1-exe-evidence-v1", "source": before,
                      "executable": parse_exe(exe_bytes)}
            if source_record(args.path) != before:
                raise InspectionError("executable source changed during inspection")
            if args.boot_out:
                write_new_bytes(args.boot_out, exe_bytes)
        else:
            result = inspect_disc(args.path, boot_out=args.boot_out, source=before)
        if args.out:
            write_new_bytes(args.out, (json.dumps(result, indent=2) + "\n").encode())
        print(json.dumps(result if args.full else summarize_report(result, args.out), indent=2))
        return 0
    except (InspectionError, OSError, UnicodeError, struct.error) as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
