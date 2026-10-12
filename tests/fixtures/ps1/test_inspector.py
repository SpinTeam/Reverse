"""Source-owned synthetic fixtures. No commercial discs, BIOS, SDK or executable."""
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[3] / ".agents/skills/reverse-engineer-anything/scripts/ps1_inspect.py"
spec = importlib.util.spec_from_file_location("ps1_inspect", SCRIPT)
ps1 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ps1)


def exe_fixture():
    data = bytearray(4096)
    data[:8] = b"PS-X EXE"
    fields = [0x80010040, 0x80010800, 0x80010000, 2048,
              0, 0, 0x80011000, 64, 0x801fff00, 0xf0]
    struct.pack_into("<10I", data, 0x10, *fields)
    struct.pack_into("<3I", data, 0x840, 0x24820001, 0x03e00008, 0)
    return bytes(data)


def both32(value):
    return struct.pack("<I", value) + struct.pack(">I", value)


def record(name, lba, length, directory=False):
    name = name if isinstance(name, bytes) else name.encode("ascii")
    size = 33 + len(name) + (len(name) % 2 == 0)
    data = bytearray(size)
    data[0] = size
    data[2:10] = both32(lba)
    data[10:18] = both32(length)
    data[25] = 2 if directory else 0
    data[28:32] = b"\x01\0\0\x01"
    data[32] = len(name)
    data[33:33 + len(name)] = name
    return bytes(data)


def iso_fixture(*, nested=False, no_cnf=False):
    data = bytearray(32 * 2048)
    pvd = bytearray(2048)
    pvd[:7] = b"\x01CD001\x01"
    pvd[40:72] = b"SOURCE-OWNED-SYNTHETIC".ljust(32)
    pvd[80:88] = both32(32)
    pvd[128:132] = b"\0\x08\x08\0"
    pvd[156:190] = record(b"\0", 20, 2048, True)
    data[16 * 2048:17 * 2048] = pvd
    data[17 * 2048:17 * 2048 + 7] = b"\xffCD001\x01"
    cnf = b"BOOT = cdrom:\\EXE\\DEMO_000.01;1\r\n" if nested else b"BOOT = cdrom:\\DEMO_000.01;1\r\n"
    root = record(b"\0", 20, 2048, True) + record(b"\x01", 20, 2048, True)
    if no_cnf:
        root += record("PSX.EXE;1", 23, 4096)
    else:
        root += record("SYSTEM.CNF;1", 22, len(cnf))
        root += record("EXE", 21, 2048, True) if nested else record("DEMO_000.01;1", 23, 4096)
    data[20 * 2048:20 * 2048 + len(root)] = root
    if nested:
        directory = record(b"\0", 21, 2048, True) + record(b"\x01", 20, 2048, True) + record("DEMO_000.01;1", 23, 4096)
        data[21 * 2048:21 * 2048 + len(directory)] = directory
    data[22 * 2048:22 * 2048 + len(cnf)] = cnf
    data[23 * 2048:25 * 2048] = exe_fixture()
    return bytes(data)


def raw_fixture(cooked, mode="MODE2/2352"):
    result = bytearray()
    for offset in range(0, len(cooked), 2048):
        block = cooked[offset:offset + 2048]
        if mode == "MODE1/2352":
            sector = ps1.SYNC + b"\0\0\0\x01" + block + bytes(2352 - 16 - 2048)
        else:
            xa = b"\0\0\x08\0" * 2 + block + bytes(2336 - 8 - 2048)
            sector = ps1.SYNC + b"\0\0\0\x02" + xa if mode == "MODE2/2352" else xa
        result.extend(sector)
    return bytes(result)


class InspectorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def write(self, name, data):
        path = self.root / name
        path.write_bytes(data)
        return path


    def test_executable_pc_and_load_address_are_distinct(self):
        report = ps1.parse_exe(exe_fixture())
        self.assertEqual(report["initial_pc"], "0x80010040")
        self.assertEqual(report["load_address"], "0x80010000")
        self.assertEqual(report["initial_stack_pointer"], "0x801ffff0")
        self.assertEqual(report["payload_bytes"], 2048)

    def test_truncated_executable_header_and_payload_are_rejected(self):
        for size in [7, 2047, 4095]:
            with self.subTest(size=size), self.assertRaisesRegex(ps1.InspectionError, "truncated"):
                ps1.parse_exe(exe_fixture()[:size])

    def test_executable_overflow_and_invalid_signature(self):
        data = bytearray(exe_fixture())
        struct.pack_into("<I", data, 0x18, 0xfffffff0)
        with self.assertRaisesRegex(ps1.InspectionError, "overflows"):
            ps1.parse_exe(data)
        data[:8] = b"NOT EXE!"
        with self.assertRaisesRegex(ps1.InspectionError, "signature"):
            ps1.parse_exe(data)

    def test_empty_executable_payload_is_rejected(self):
        data = bytearray(exe_fixture())
        struct.pack_into("<I", data, 0x1c, 0)
        with self.assertRaisesRegex(ps1.InspectionError, "empty"):
            ps1.parse_exe(data)

    def test_cooked_iso_inspection_preserves_source_and_boot_hash(self):
        source = self.write("disc.iso", iso_fixture())
        report = ps1.inspect_disc(source)
        self.assertEqual(report["boot_path"], "DEMO_000.01;1")
        self.assertEqual(report["boot_executable"]["file_sha256"], hashlib.sha256(exe_fixture()).hexdigest())
        self.assertEqual(report["data_layout"]["mode"], "MODE1/2048")
        self.assertEqual(source.read_bytes(), iso_fixture())

    def test_nested_system_cnf_boot_path(self):
        source = self.write("disc.iso", iso_fixture(nested=True))
        self.assertEqual(ps1.inspect_disc(source)["boot_path"], "EXE/DEMO_000.01;1")

    def test_default_psx_exe_without_system_cnf(self):
        source = self.write("disc.iso", iso_fixture(no_cnf=True))
        report = ps1.inspect_disc(source)
        self.assertEqual(report["boot_path"], "PSX.EXE;1")
        self.assertTrue(report["warnings"])

    def test_raw_mode1_and_mode2_form1_layouts(self):
        for mode in ["MODE1/2352", "MODE2/2352", "MODE2/2336"]:
            with self.subTest(mode=mode):
                source = self.write("disc.bin", raw_fixture(iso_fixture(), mode))
                report = ps1.inspect_disc(source)
                self.assertEqual(report["data_layout"]["mode"], mode)
                self.assertEqual(report["boot_executable"]["initial_pc"], "0x80010040")

    def test_mode2_form2_iso_block_is_rejected(self):
        data = bytearray(raw_fixture(iso_fixture()))
        for offset in [18, 22]:
            data[23 * 2352 + offset] |= 0x20
        source = self.write("disc.bin", data)
        with self.assertRaisesRegex(ps1.InspectionError, "Form2"):
            ps1.inspect_disc(source)

    def test_raw_sector_subheader_and_sync_damage(self):
        for position in [23 * 2352 + 20, 23 * 2352]:
            data = bytearray(raw_fixture(iso_fixture()))
            data[position] ^= 1
            source = self.write("disc.bin", data)
            with self.subTest(position=position), self.assertRaises(ps1.InspectionError):
                ps1.inspect_disc(source)

    def test_cue_index01_pregap_and_audio_boundaries(self):
        data = bytes(150 * 2352) + raw_fixture(iso_fixture()) + bytes(8 * 2352)
        self.write("disc.bin", data)
        cue = self.write("disc.cue", b'FILE "disc.bin" BINARY\nTRACK 01 MODE2/2352\nINDEX 00 00:00:00\nINDEX 01 00:02:00\nTRACK 02 AUDIO\nINDEX 01 00:02:32\n')
        report = ps1.inspect_disc(cue)
        self.assertEqual(report["data_layout"]["start_sector_in_file"], 150)
        self.assertEqual(report["data_layout"]["data_track_sectors"], 32)
        self.assertEqual(len(report["tracks"]), 2)
        self.assertEqual(len(report["sources"]), 2)

    def test_cue_missing_companion_and_escape_are_rejected(self):
        for filename in ["missing.bin", "../outside.bin"]:
            cue = self.write("disc.cue", f'FILE "{filename}" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:00:00\n'.encode())
            with self.subTest(filename=filename), self.assertRaises(ps1.InspectionError):
                ps1.parse_cue(cue)

    def test_invalid_cue_indexes_and_sector_truncation(self):
        self.write("disc.bin", raw_fixture(iso_fixture()))
        for index in ["00:60:00", "00:00:75", "00:03:00"]:
            cue = self.write("disc.cue", f'FILE "disc.bin" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 {index}\n'.encode())
            with self.subTest(index=index), self.assertRaises(ps1.InspectionError):
                ps1.parse_cue(cue)
        self.write("disc.bin", raw_fixture(iso_fixture())[:-1])
        cue = self.write("disc.cue", b'FILE "disc.bin" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:00:00\n')
        with self.assertRaisesRegex(ps1.InspectionError, "truncated"):
            ps1.parse_cue(cue)

    def test_iso_endian_extent_and_volume_truncation(self):
        for position in [16 * 2048 + 84, 20 * 2048 + 6]:
            data = bytearray(iso_fixture())
            data[position] ^= 1
            with self.subTest(position=position), self.assertRaisesRegex(ps1.InspectionError, "endian"):
                ps1.inspect_disc(self.write("disc.iso", data))
        with self.assertRaisesRegex(ps1.InspectionError, "volume"):
            ps1.inspect_disc(self.write("disc.iso", iso_fixture()[:-2048]))


    def test_disc_mutation_during_inspection_never_produces_evidence_or_boot_copy(self):
        source = self.write("disc.iso", iso_fixture())
        real_index = ps1.iso_index
        def mutate(reader):
            index = real_index(reader)
            changed = bytearray(source.read_bytes())
            changed[23 * 2048 + 0x850] ^= 1
            source.write_bytes(changed)
            return index
        destination = self.root / "boot.exe"
        with patch.object(ps1, "iso_index", side_effect=mutate):
            with self.assertRaisesRegex(ps1.InspectionError, "changed during"):
                ps1.inspect_disc(source, boot_out=destination)
        self.assertFalse(destination.exists())

    def test_boot_preservation_retains_header_payload_and_hash_without_overwrite(self):
        source = self.write("disc.iso", iso_fixture())
        output = self.root / "boot.exe"
        report = ps1.inspect_disc(source, boot_out=output)
        self.assertEqual(output.read_bytes(), exe_fixture())
        self.assertEqual(ps1.sha256_file(output), report["boot_executable"]["file_sha256"])
        self.assertEqual(report["preserved_boot_executable"], str(output))
        with self.assertRaises(FileExistsError):
            ps1.inspect_disc(source, boot_out=output)
        self.assertEqual(output.read_bytes(), exe_fixture())

    def test_cli_preserves_full_boot_and_maps_every_byte_to_original_sectors(self):
        raw = bytes(150 * 2352) + raw_fixture(iso_fixture())
        track = self.write("disc.bin", raw)
        cue = self.write("disc.cue", b'FILE "disc.bin" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:02:00\n')
        boot, output = self.root / "boot.psx", self.root / "disc.json"
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), str(cue),
                                 "--out", str(output), "--boot-out", str(boot)],
                                cwd=self.root, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(output.read_text())
        summary = json.loads(result.stdout)
        self.assertEqual(summary["schema"], "ps1-disc-summary-v1")
        self.assertEqual(summary["report_path"], str(output))
        self.assertEqual(summary["iso9660"]["entry_count"], len(report["iso9660"]["entries"]))
        self.assertTrue(summary["iso9660"]["entries_omitted"])
        self.assertNotIn("entries", summary["iso9660"])
        self.assertEqual(summary["boot_source"], report["boot_source"])
        self.assertEqual(boot.read_bytes(), exe_fixture())
        mapping = report["boot_source"]
        self.assertEqual(mapping["path"], str(track.resolve()))
        self.assertEqual(mapping["sha256"], hashlib.sha256(raw).hexdigest())
        reconstructed = bytes(raw[mapping["first_physical_sector_offset"]
                                  + n // mapping["logical_block_bytes"] * mapping["physical_sector_stride"]
                                  + mapping["data_offset_in_sector"] + n % mapping["logical_block_bytes"]]
                              for n in range(mapping["bytes"]))
        self.assertEqual(reconstructed, boot.read_bytes())
        again = subprocess.run([sys.executable, "-B", str(SCRIPT), str(cue), "--out", str(output)],
                               capture_output=True, text=True, timeout=10)
        self.assertEqual(again.returncode, 2)
        self.assertEqual(again.stdout, "")
        self.assertFalse(json.loads(again.stderr)["ok"])
        self.assertEqual(json.loads(output.read_text()), report)

    def test_full_stdout_can_retain_the_complete_inventory_without_writing(self):
        source = self.write("disc.iso", iso_fixture())
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), str(source), "--full"],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["schema"], "ps1-disc-evidence-v1")
        self.assertEqual(len(report["iso9660"]["entries"]), 2)
        self.assertEqual(list(self.root.iterdir()), [source])

    def test_cue_mutation_while_parsing_is_rejected_before_outputs(self):
        self.write("disc.bin", raw_fixture(iso_fixture()))
        cue = self.write("disc.cue", b'FILE "disc.bin" BINARY\nTRACK 01 MODE2/2352\nINDEX 01 00:00:00\n')
        real_parse = ps1.parse_cue
        def mutate(path):
            tracks = real_parse(path)
            path.write_bytes(path.read_bytes() + b'REM changed\n')
            return tracks
        boot = self.root / "boot.psx"
        with patch.object(ps1, "parse_cue", side_effect=mutate):
            with self.assertRaisesRegex(ps1.InspectionError, "changed during"):
                ps1.inspect_disc(cue, boot_out=boot)
        self.assertFalse(boot.exists())

    def test_root_extent_cannot_escape_declared_volume(self):
        data = bytearray(iso_fixture())
        data[16 * 2048 + 156 + 2:16 * 2048 + 156 + 10] = both32(32)
        with self.assertRaisesRegex(ps1.InspectionError, "root exceeds"):
            ps1.inspect_disc(self.write("disc.iso", data))

    def test_duplicate_and_version_ambiguous_boot_paths_are_rejected(self):
        for name, error in [("demo_000.01;1", "duplicate ISO9660 path"),
                            ("DEMO_000.01;2", "ambiguous versioned")]:
            data = bytearray(iso_fixture())
            root_offset = 20 * 2048
            cursor = root_offset
            while data[cursor]:
                cursor += data[cursor]
            extra = record(name, 23, 4096)
            data[cursor:cursor + len(extra)] = extra
            with self.subTest(name=name), self.assertRaisesRegex(ps1.InspectionError, error):
                ps1.inspect_disc(self.write("disc.iso", data))

    def test_standalone_cli_distinguishes_header_inspection_from_disc_admission(self):
        source = self.write("boot.psx", exe_fixture())
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), str(source)],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["schema"], "ps1-exe-evidence-v1")
        self.assertEqual(report["source"]["sha256"], hashlib.sha256(exe_fixture()).hexdigest())
        self.assertEqual(report["executable"]["load_address"], "0x80010000")
        self.assertEqual(report["executable"]["initial_pc"], "0x80010040")

    def test_high_bit_signature_is_rejected(self):
        data = bytearray(exe_fixture())
        data[0] = 0xd0
        with self.assertRaisesRegex(ps1.InspectionError, "signature"):
            ps1.parse_exe(data)


if __name__ == "__main__":
    unittest.main()
