"""Modul 5 (Musik reparieren): Strukturdiagnose (MP3Diags-orientiert) & verlustfreie Audio-Reparatur."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from .cd_reader import extract_local_audio_file_info
from .encoder import copy_tags_and_cover_to_flac, probe_audio_pcm_params

SUPPORTED_REPAIR_EXTS = {
    ".mp3",
    ".mp2",
    ".flac",
    ".wav",
    ".aiff",
    ".aif",
    ".aifc",
    ".ogg",
    ".opus",
    ".m4a",
}


def _natural_str_key(text: str) -> list:
    parts = re.split(r"(\d+)", str(text or "").lower())
    return [int(p) if p.isdigit() else p for p in parts]


def collect_audio_files_for_repair(
    paths: list[Path],
    cancel_event: Optional[threading.Event] = None,
    on_progress: Optional[Callable[[int], None]] = None,
) -> list[tuple[Path, str]]:
    """Sammelt einzelne Audiodateien oder Verzeichnisse rekursiv unter Erhalt der relativen Struktur."""
    collected: list[tuple[Path, str]] = []
    seen: set[Path] = set()
    for p in paths:
        if cancel_event is not None and cancel_event.is_set():
            break
        if p.is_dir():
            root_name = p.name or "Ordner"
            discovered: list[tuple[Path, str]] = []
            for dirpath, dirnames, filenames in os.walk(p):
                if cancel_event is not None and cancel_event.is_set():
                    break
                dirnames.sort(key=_natural_str_key)
                filenames.sort(key=_natural_str_key)
                base_dir = Path(dirpath)
                for fname in filenames:
                    if cancel_event is not None and cancel_event.is_set():
                        break
                    ext = os.path.splitext(fname)[1].lower()
                    if ext not in SUPPORTED_REPAIR_EXTS:
                        continue
                    child = base_dir / fname
                    try:
                        if not child.is_file():
                            continue
                        res = child.resolve()
                    except Exception:
                        continue
                    if res in seen:
                        continue
                    seen.add(res)
                    try:
                        rel_inside = child.relative_to(p).as_posix()
                        rel_path = f"{root_name}/{rel_inside}"
                    except Exception:
                        rel_path = child.name
                    discovered.append((child, rel_path))
                    if on_progress is not None and (len(collected) + len(discovered)) % 25 == 0:
                        on_progress(len(collected) + len(discovered))
            discovered.sort(key=lambda item: _natural_str_key(item[1]))
            collected.extend(discovered)
            if on_progress is not None and discovered:
                on_progress(len(collected))
        elif p.is_file() and p.suffix.lower() in SUPPORTED_REPAIR_EXTS:
            try:
                res = p.resolve()
            except Exception:
                continue
            if res in seen:
                continue
            seen.add(res)
            collected.append((p, p.name))
            if on_progress is not None:
                on_progress(len(collected))
    return collected


@dataclass
class RepairFinding:
    code: str
    severity: str  # "critical" | "warning" | "info"
    category: str  # "header" | "frames" | "tags" | "stream" | "audio"
    title: str
    description: str
    recommended_fix: str
    auto_fixable: bool = True
    stage: str = "fast"  # "fast" | "deep"
    fix_action: Optional[str] = None  # header_strip | remux_faststart | vbr_header_rebuild | cover_optimize | lossless_reencode


@dataclass
class RepairStage1Report:
    passed: bool = True
    duration_ms: int = 0
    issue_count: int = 0
    checks_performed: list[str] = field(default_factory=list)


@dataclass
class RepairStage2Report:
    executed: bool = False
    passed: Optional[bool] = None
    duration_ms: int = 0
    crc_error_count: int = 0
    truncated_detected: bool = False
    seek_table_valid: Optional[bool] = None
    failure_reasons: list[str] = field(default_factory=list)


@dataclass
class RepairPipelineReport:
    stage1_fast_check: RepairStage1Report = field(default_factory=RepairStage1Report)
    stage2_deep_check: RepairStage2Report = field(default_factory=RepairStage2Report)
    recommended_fixes: list[str] = field(default_factory=list)


@dataclass
class RepairStructure:
    codec: str = ""
    container: str = ""
    detected_magic: str = ""
    magic_matches_extension: bool = True
    m4a_moov_position: Optional[str] = None
    sample_rate: int = 44100
    channels: int = 2
    bits_per_sample: int = 16
    sample_fmt: str = ""
    channel_layout: str = ""
    bitrate_kbps: int = 0
    duration_seconds: int = 0
    is_vbr: bool = False
    has_xing_header: bool = False
    xing_frames: int = 0
    actual_frames: int = 0
    id3v2_count: int = 0
    id3v2_versions: list[str] = field(default_factory=list)
    has_id3v1: bool = False
    has_apev2: bool = False
    leading_garbage_bytes: int = 0
    trailing_garbage_bytes: int = 0
    corrupt_sync_gaps: int = 0
    flac_md5_valid: Optional[bool] = None
    flac_md5_status: Optional[str] = None
    flac_has_seektable: Optional[bool] = None
    seek_table_valid: Optional[bool] = None
    flac_is_ogg: Optional[bool] = None
    flac_streaminfo_valid: Optional[bool] = None
    flac_subset_valid: Optional[bool] = None
    flac_min_block_size: Optional[int] = None
    flac_max_block_size: Optional[int] = None
    flac_variable_block_size: Optional[bool] = None
    flac_firefox_compatible: Optional[str] = None
    max_volume_db: Optional[float] = None
    mean_volume_db: Optional[float] = None
    decode_error_count: int = 0
    stream_crc_errors: int = 0
    stream_truncated: bool = False
    has_cover_art: bool = False
    cover_art_mime: str = ""
    cover_art_bytes: int = 0
    cover_art_width: int = 0
    cover_art_height: int = 0
    missing_core_tags: list[str] = field(default_factory=list)
    error_positions: list[dict] = field(default_factory=list)
    pipeline: Optional[RepairPipelineReport] = None


@dataclass
class RepairOptions:
    output_dir: Path
    in_place_backup: bool = False
    deep_scan: bool = True
    fix_vbr_xing: bool = True
    strip_garbage_frames: bool = True
    clean_tags: bool = True
    rebuild_container: bool = True
    write_flac_seektable: bool = True
    optimize_cover: bool = False
    cover_max_dimension: int = 2048
    auto_repair: bool = False
    firefox_compat: bool = False
    id3v2_version: int = 4
    cover_filename: str = "cover"


@dataclass
class RepairJob:
    source_path: Path
    relative_path: str
    source_ext: str
    size_bytes: int
    selected: bool = False
    job_id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])
    health: str = "pending"  # pending | scanning | ok | warning | critical | repaired | error
    findings: list[RepairFinding] = field(default_factory=list)
    structure: Optional[RepairStructure] = None
    pipeline: Optional[RepairPipelineReport] = None
    status_message: str = "Wartet auf Diagnose..."
    progress: float = 0.0
    output_path: Optional[Path] = None
    before_finding_count: Optional[int] = None
    after_finding_count: Optional[int] = None

    def compute_target_path(self, output_dir: Path, in_place_backup: bool) -> Path:
        if in_place_backup:
            return self.source_path
        rel_obj = Path(self.relative_path)
        if len(rel_obj.parts) > 1:
            target = output_dir / rel_obj
        else:
            target = output_dir / self.source_path.name
        try:
            if target.resolve() == self.source_path.resolve():
                target = target.with_name(f"{self.source_path.stem}_repariert{self.source_path.suffix}")
        except Exception:
            pass
        return target


def _parse_mpeg_frame_header(buf: bytes, offset: int) -> Optional[dict]:
    if offset + 4 > len(buf):
        return None
    b0, b1, b2, b3 = buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]
    if b0 != 0xFF or (b1 & 0xE0) != 0xE0:
        return None
    version_bits = (b1 >> 3) & 0x03
    layer_bits = (b1 >> 1) & 0x03
    if version_bits == 1 or layer_bits == 0:
        return None
    bitrate_idx = (b2 >> 4) & 0x0F
    sr_idx = (b2 >> 2) & 0x03
    if bitrate_idx == 0 or bitrate_idx == 15 or sr_idx == 3:
        return None
    padding = (b2 >> 1) & 0x01
    channel_mode = (b3 >> 6) & 0x03
    channels = 1 if channel_mode == 3 else 2

    sr_table = {
        3: (44100, 48000, 32000),
        2: (22050, 24000, 16000),
        0: (11025, 12000, 8000),
    }
    sr_tuple = sr_table.get(version_bits)
    if not sr_tuple:
        return None
    sample_rate = sr_tuple[sr_idx]

    if version_bits == 3:
        if layer_bits == 3:
            bitrate_kbps = (0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448)[bitrate_idx]
        elif layer_bits == 2:
            bitrate_kbps = (0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384)[bitrate_idx]
        else:
            bitrate_kbps = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320)[bitrate_idx]
    else:
        if layer_bits == 3:
            bitrate_kbps = (0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256)[bitrate_idx]
        else:
            bitrate_kbps = (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160)[bitrate_idx]

    if not bitrate_kbps:
        return None

    if layer_bits == 3:
        frame_len = ((12 * bitrate_kbps * 1000) // sample_rate + padding) * 4
    elif layer_bits == 2:
        frame_len = (144 * bitrate_kbps * 1000) // sample_rate + padding
    else:
        coeff = 144 if version_bits == 3 else 72
        frame_len = (coeff * bitrate_kbps * 1000) // sample_rate + padding

    if frame_len < 16 or frame_len > 8192:
        return None
    has_crc = (b1 & 0x01) == 0
    return {
        "frame_len": frame_len,
        "bitrate_kbps": bitrate_kbps,
        "sample_rate": sample_rate,
        "channels": channels,
        "version_id": version_bits,
        "layer_id": layer_bits,
        "channel_mode": channel_mode,
        "has_crc": has_crc,
    }


def _strip_mpeg_trailing_tags(buf: bytes, id3_offset: int) -> tuple[int, bool, bool, bool]:
    """Entfernt gültige End-Tags (ID3v1, Enhanced TAG+, Lyrics3v1/v2, APEv1/v2) sauber vom Stream-Ende.
    Gibt (audio_end, has_id3v1, has_apev2, has_extra_trailer) zurück."""
    audio_end = len(buf)
    has_id3v1 = False
    has_apev2 = False
    has_extra_trailer = False
    for _ in range(5):
        changed = False
        # 1. ID3v1 (128 Bytes, beginnt mit 'TAG', aber nicht 'TAG+')
        if (
            audio_end >= id3_offset + 128
            and buf[audio_end - 128 : audio_end - 125] == b"TAG"
            and buf[audio_end - 128 : audio_end - 124] != b"TAG+"
        ):
            has_id3v1 = True
            audio_end -= 128
            changed = True
            # Optional direkt vorgeschalteter Enhanced-ID3v1-Block ('TAG+', 227 Bytes)
            if audio_end >= id3_offset + 227 and buf[audio_end - 227 : audio_end - 223] == b"TAG+":
                audio_end -= 227
                has_extra_trailer = True
            continue

        # 2. Lyrics3v2 ('LYRICS200' + 6-stellige ASCII-Länge + 'LYRICSBEGIN')
        if audio_end >= id3_offset + 15 and buf[audio_end - 9 : audio_end] == b"LYRICS200":
            len_bytes = buf[audio_end - 15 : audio_end - 9]
            if len_bytes.isdigit():
                lyr_sz = int(len_bytes.decode("ascii"))
                lyr_start = audio_end - 15 - lyr_sz
                if lyr_start >= id3_offset and buf[lyr_start : lyr_start + 11] == b"LYRICSBEGIN":
                    audio_end = lyr_start
                    has_extra_trailer = True
                    changed = True
                    continue

        # 3. Lyrics3v1 ('LYRICSEND', max. 5120 Bytes bis 'LYRICSBEGIN')
        if audio_end >= id3_offset + 20 and buf[audio_end - 9 : audio_end] == b"LYRICSEND":
            search_start = max(id3_offset, audio_end - 5120)
            begin_idx = buf.rfind(b"LYRICSBEGIN", search_start, audio_end - 9)
            if begin_idx >= id3_offset:
                audio_end = begin_idx
                has_extra_trailer = True
                changed = True
                continue

        # 4. APEv2 / APEv1 Footer ('APETAGEX', 32 Bytes)
        # Spezifikation: ape_sz enthält die 32-Byte-Footer-Größe, aber NICHT den optionalen 32-Byte-Header.
        # Der Header ist NUR vorhanden, wenn Version >= 2000 UND Bit 31 (0x80000000) in flags gesetzt ist!
        if audio_end >= id3_offset + 32 and buf[audio_end - 32 : audio_end - 24] == b"APETAGEX":
            ape_ver = int.from_bytes(buf[audio_end - 24 : audio_end - 20], "little")
            ape_sz = int.from_bytes(buf[audio_end - 20 : audio_end - 16], "little")
            ape_flags = int.from_bytes(buf[audio_end - 12 : audio_end - 8], "little")
            has_header_flag = (ape_ver >= 2000) and ((ape_flags & 0x80000000) != 0)
            if ape_sz >= 32 and audio_end - ape_sz >= id3_offset:
                total_ape = ape_sz
                if (
                    has_header_flag
                    and audio_end - ape_sz - 32 >= id3_offset
                    and buf[audio_end - ape_sz - 32 : audio_end - ape_sz - 24] == b"APETAGEX"
                ):
                    total_ape = ape_sz + 32
                has_apev2 = True
                has_extra_trailer = True
                audio_end -= total_ape
                changed = True
                continue

        if not changed:
            break
    return audio_end, has_id3v1, has_apev2, has_extra_trailer


def _extract_clean_mpeg_stream(buf: bytes, id3_offset: int, audio_end: int) -> tuple[bytes, int, int]:
    """Extrahiert ausschließlich gültige, verifizierte MPEG-Audio-Frames (verlustfrei, ohne Müll-Bytes)."""
    first_off = -1
    stream_ver = -1
    stream_layer = -1
    pos = max(0, id3_offset)
    end = min(len(buf), max(pos, audio_end))
    while pos + 4 < end:
        hdr = _parse_mpeg_frame_header(buf, pos)
        if hdr and pos + hdr["frame_len"] + 4 <= end:
            nh = _parse_mpeg_frame_header(buf, pos + hdr["frame_len"])
            if (
                nh
                and nh["version_id"] == hdr["version_id"]
                and nh["layer_id"] == hdr["layer_id"]
                and nh["sample_rate"] == hdr["sample_rate"]
            ):
                first_off = pos
                stream_ver = hdr["version_id"]
                stream_layer = hdr["layer_id"]
                break
        pos += 1

    if first_off < 0:
        return b"", 0, max(0, end - max(0, id3_offset))

    out = bytearray()
    frames_kept = 0
    bytes_skipped = max(0, first_off - max(0, id3_offset))
    scan_pos = first_off
    last_end = first_off

    while scan_pos + 4 <= end:
        hdr = _parse_mpeg_frame_header(buf, scan_pos)
        if (
            hdr
            and hdr["version_id"] == stream_ver
            and hdr["layer_id"] == stream_layer
            and scan_pos + hdr["frame_len"] <= end
        ):
            frame_end = scan_pos + hdr["frame_len"]
            out.extend(buf[scan_pos:frame_end])
            frames_kept += 1
            last_end = frame_end
            scan_pos = frame_end
        else:
            resync = scan_pos + 1
            found = False
            while resync + 4 < end:
                nh = _parse_mpeg_frame_header(buf, resync)
                if (
                    nh
                    and nh["version_id"] == stream_ver
                    and nh["layer_id"] == stream_layer
                    and resync + nh["frame_len"] + 4 <= end
                ):
                    nh2 = _parse_mpeg_frame_header(buf, resync + nh["frame_len"])
                    if (
                        nh2
                        and nh2["version_id"] == stream_ver
                        and nh2["layer_id"] == stream_layer
                        and nh2["sample_rate"] == nh["sample_rate"]
                    ):
                        found = True
                        break
                resync += 1
            if found:
                bytes_skipped += resync - scan_pos
                scan_pos = resync
            else:
                bytes_skipped += max(0, end - last_end)
                break

    return bytes(out), frames_kept, bytes_skipped


def _validate_repaired_audio_output(
    candidate_path: Path,
    pre_findings: list[RepairFinding],
    pre_struct: RepairStructure,
    after_findings: list[RepairFinding],
    after_struct: RepairStructure,
) -> Optional[str]:
    """Prüft die reparierte Datei vor dem Überschreiben/Speichern, um Datenverlust oder Beschädigung auszuschließen."""
    if not candidate_path.exists():
        return "Reparierte Ausgabedatei wurde nicht erzeugt."
    size_bytes = candidate_path.stat().st_size
    if size_bytes <= 128:
        return f"Reparierte Datei ist ungültig klein ({size_bytes} Bytes) — Original bleibt unverändert."

    if pre_struct.duration_seconds >= 2 and after_struct.duration_seconds <= 0:
        return "Reparierte Datei meldet keine gültige Spielzeit — Original bleibt unverändert."

    # Schutz gegen starken Dauerverlust (außer bei VBR-MP3 ohne Xing-Header, wo die Original-Dauer geschätzt/falsch war)
    pre_dur_reliable = not (pre_struct.is_vbr and not pre_struct.has_xing_header)
    if (
        pre_dur_reliable
        and pre_struct.duration_seconds >= 10
        and after_struct.duration_seconds > 0
        and after_struct.duration_seconds < pre_struct.duration_seconds * 0.5
    ):
        return (
            f"Reparierte Datei wäre stark verkürzt ({after_struct.duration_seconds}s statt {pre_struct.duration_seconds}s) "
            "— Sicherheitsabbruch, Original bleibt unverändert."
        )

    pre_codes = {f.code for f in pre_findings}
    fatal_structural_codes = {
        "no_mpeg_sync",
        "flac_missing_marker",
        "flac_invalid_streaminfo",
        "flac_invalid_md5",
        "m4a_missing_moov",
        "wav_invalid_header",
        "aiff_invalid_header",
    }
    newly_introduced_fatal = [
        f.title for f in after_findings if f.code in fatal_structural_codes and f.code not in pre_codes
    ]
    if newly_introduced_fatal:
        return f"Sicherheitsprüfung fehlgeschlagen (neuer Strukturfehler: {newly_introduced_fatal[0]}) — Original bleibt unverändert."

    pre_crit = sum(1 for f in pre_findings if f.severity == "critical")
    after_crit = sum(1 for f in after_findings if f.severity == "critical")
    if after_crit > pre_crit:
        return (
            f"Reparatur würde mehr kritische Befunde erzeugen ({after_crit} statt {pre_crit}) "
            "— Sicherheitsabbruch, Original bleibt unverändert."
        )
    return None


def _detect_magic_signature(buf: bytes, id3_offset: int) -> str:
    payload = buf[max(0, id3_offset) :]
    if len(buf) >= 12:
        if buf[:4] == b"RIFF" and buf[8:12] == b"WAVE":
            return "wav"
        if buf[:4] == b"FORM" and buf[8:12] in (b"AIFF", b"AIFC"):
            return "aiff"
        if buf[4:8] == b"ftyp":
            return "m4a"
    if len(payload) >= 4:
        m4 = payload[:4]
        if m4 == b"fLaC":
            return "flac"
        if m4 == b"OggS":
            return "ogg"
        if m4 == b"RIFF" and len(payload) >= 12 and payload[8:12] == b"WAVE":
            return "wav"
        if m4 == b"FORM" and len(payload) >= 12 and payload[8:12] in (b"AIFF", b"AIFC"):
            return "aiff"
        if len(payload) >= 8 and payload[4:8] == b"ftyp":
            return "m4a"
    limit = min(len(buf) - 4, max(0, id3_offset) + 8192)
    for p in range(max(0, id3_offset), limit):
        hdr = _parse_mpeg_frame_header(buf, p)
        if hdr and p + hdr["frame_len"] + 4 <= len(buf):
            nh = _parse_mpeg_frame_header(buf, p + hdr["frame_len"])
            if (
                nh
                and nh["version_id"] == hdr["version_id"]
                and nh["layer_id"] == hdr["layer_id"]
                and nh["sample_rate"] == hdr["sample_rate"]
            ):
                return "mp2" if hdr["layer_id"] == 2 else "mp3"
    return "unknown"


def _inspect_m4a_moov_atoms(buf: bytes) -> str:
    pos = 0
    moov_off = -1
    mdat_off = -1
    while pos + 8 <= len(buf):
        atom_size = int.from_bytes(buf[pos : pos + 4], "big")
        atom_type = buf[pos + 4 : pos + 8]
        if atom_size == 1 and pos + 16 <= len(buf):
            atom_size = int.from_bytes(buf[pos + 8 : pos + 16], "big")
        elif atom_size == 0:
            atom_size = len(buf) - pos
        if atom_size < 8:
            break
        if atom_type == b"moov" and moov_off < 0:
            moov_off = pos
        if atom_type == b"mdat" and mdat_off < 0:
            mdat_off = pos
        pos += atom_size
    if moov_off < 0:
        return "missing"
    if mdat_off >= 0 and moov_off > mdat_off:
        return "after_mdat"
    return "before_mdat"


def _detect_image_mime_from_magic(img_buf: bytes) -> str:
    if len(img_buf) >= 3 and img_buf[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if len(img_buf) >= 8 and img_buf[0] == 0x89 and img_buf[1:4] == b"PNG":
        return "image/png"
    if len(img_buf) >= 12 and img_buf[:4] == b"RIFF" and img_buf[8:12] == b"WEBP":
        return "image/webp"
    if len(img_buf) >= 4 and img_buf[:4] == b"GIF8":
        return "image/gif"
    if len(img_buf) >= 2 and img_buf[:2] == b"BM":
        return "image/bmp"
    if len(img_buf) >= 4 and img_buf[:4] in (b"II*\x00", b"MM\x00*"):
        return "image/tiff"
    return ""


def _format_pos_time(sec: Optional[int]) -> str:
    if sec is None or sec < 0:
        return ""
    m, s = divmod(int(sec), 60)
    return f"{m:02d}:{s:02d}"


def _build_repair_error_positions(
    findings: list[RepairFinding],
    duration_seconds: int,
    sync_gap_ratios: list[float],
    mixed_sr_ratios: list[float],
    leading_garbage: int,
    trailing_garbage: int,
    stream_truncated: bool,
) -> list[dict]:
    """Ordnet jeden Diagnose-Befund einer visuellen Dateiposition zu (start=Header/Anfang, stream=Audiostrom, end=Ende/Trailer)."""
    start_codes = {
        "leading_garbage",
        "duplicate_id3v2",
        "id3v2_invalid_size",
        "flac_has_id3v2_prefix",
        "flac_missing_marker",
        "flac_invalid_streaminfo",
        "flac_ogg_container",
        "wrong_file_extension",
        "missing_xing_header",
        "xing_frame_mismatch",
        "xing_bytes_mismatch",
        "m4a_missing_moov",
        "wav_invalid_header",
        "aiff_invalid_header",
        "cover_art_oversized",
        "cover_art_resolution_exceeded",
        "cover_art_corrupt",
        "incomplete_tags",
        "flac_no_seektable",
        "flac_invalid_seektable",
        "flac_missing_md5",
        "no_mpeg_sync",
    }
    end_codes = {
        "trailing_garbage",
        "stream_truncated_file",
        "m4a_moov_after_mdat",
        "apev2_tag_present",
    }

    positions: list[dict] = []
    for f in findings:
        code = f.code
        sev = f.severity
        if code == "corrupt_sync_gaps" and sync_gap_ratios:
            for idx_r, r in enumerate(sync_gap_ratios[:12]):
                clamped = max(0.01, min(0.99, float(r)))
                t_sec = round(clamped * duration_seconds) if duration_seconds > 0 else None
                t_txt = f" ~{_format_pos_time(t_sec)}" if t_sec is not None else ""
                positions.append(
                    {
                        "zone": "stream",
                        "ratio": round(clamped, 4),
                        "severity": sev,
                        "code": code,
                        "label": f"Sync-Lücke #{idx_r + 1}{t_txt} ({round(clamped * 100)} %)",
                        "time_seconds": t_sec,
                    }
                )
            continue
        if code == "mixed_samplerate_frames" and mixed_sr_ratios:
            for r in mixed_sr_ratios[:4]:
                clamped = max(0.01, min(0.99, float(r)))
                t_sec = round(clamped * duration_seconds) if duration_seconds > 0 else None
                t_txt = f" ~{_format_pos_time(t_sec)}" if t_sec is not None else ""
                positions.append(
                    {
                        "zone": "stream",
                        "ratio": round(clamped, 4),
                        "severity": sev,
                        "code": code,
                        "label": f"Abtastraten-Wechsel{t_txt} ({round(clamped * 100)} %)",
                        "time_seconds": t_sec,
                    }
                )
            continue
        if code in ("ffmpeg_decode_errors", "stream_crc_errors"):
            if (trailing_garbage > 16 or stream_truncated) and not sync_gap_ratios and leading_garbage <= 4:
                positions.append(
                    {
                        "zone": "end",
                        "ratio": 1.0,
                        "severity": sev,
                        "code": code,
                        "label": f"{f.title} (Dateiende)",
                        "time_seconds": duration_seconds if duration_seconds > 0 else None,
                    }
                )
            elif leading_garbage > 4 and not sync_gap_ratios and trailing_garbage <= 16:
                positions.append(
                    {
                        "zone": "start",
                        "ratio": 0.0,
                        "severity": sev,
                        "code": code,
                        "label": f"{f.title} (Dateianfang)",
                        "time_seconds": 0,
                    }
                )
            elif sync_gap_ratios:
                for r in sync_gap_ratios[:6]:
                    clamped = max(0.01, min(0.99, float(r)))
                    t_sec = round(clamped * duration_seconds) if duration_seconds > 0 else None
                    t_txt = f" ~{_format_pos_time(t_sec)}" if t_sec is not None else ""
                    positions.append(
                        {
                            "zone": "stream",
                            "ratio": round(clamped, 4),
                            "severity": sev,
                            "code": code,
                            "label": f"Dekodierfehler{t_txt} ({round(clamped * 100)} %)",
                            "time_seconds": t_sec,
                        }
                    )
            else:
                positions.append(
                    {
                        "zone": "stream",
                        "ratio": None,
                        "severity": sev,
                        "code": code,
                        "label": f.title,
                        "time_seconds": None,
                    }
                )
            continue
        if code in start_codes or f.category in ("header", "tags"):
            positions.append(
                {
                    "zone": "start",
                    "ratio": 0.0,
                    "severity": sev,
                    "code": code,
                    "label": f.title,
                    "time_seconds": 0,
                }
            )
        elif code in end_codes:
            positions.append(
                {
                    "zone": "end",
                    "ratio": 1.0,
                    "severity": sev,
                    "code": code,
                    "label": f.title,
                    "time_seconds": duration_seconds if duration_seconds > 0 else None,
                }
            )
        else:
            positions.append(
                {
                    "zone": "stream",
                    "ratio": None,
                    "severity": sev,
                    "code": code,
                    "label": f.title,
                    "time_seconds": None,
                }
            )
    return positions


def analyze_audio_file_for_repair(
    file_path: Path,
    deep_scan: bool = True,
    cover_max_dimension: int = 2048,
    ffmpeg_threads: int = 1,
) -> tuple[str, list[RepairFinding], RepairStructure]:
    """Führt zweistufige Prüfung durch (Stufe 1: Fast-Check, Stufe 2: Deep-Check)."""
    max_cover_dim = max(256, min(8192, int(round(float(cover_max_dimension or 2048)))))
    eff_threads = max(1, min(16, int(ffmpeg_threads or 1)))
    fast_start = time.monotonic()
    findings: list[RepairFinding] = []
    buf = file_path.read_bytes()
    file_ext = file_path.suffix.lower()

    # 1. ID3v2 / ID3v1 / APEv2 Kettenprüfung
    id3_offset = 0
    id3v2_count = 0
    id3v2_versions: list[str] = []
    while id3_offset + 10 <= len(buf) and buf[id3_offset : id3_offset + 3] == b"ID3":
        maj_ver = buf[id3_offset + 3]
        rev_ver = buf[id3_offset + 4]
        flags = buf[id3_offset + 5]
        s0, s1, s2, s3 = buf[id3_offset + 6], buf[id3_offset + 7], buf[id3_offset + 8], buf[id3_offset + 9]
        if maj_ver not in (2, 3, 4) or rev_ver == 0xFF or ((s0 | s1 | s2 | s3) & 0x80) != 0:
            break
        tag_size = (s0 << 21) | (s1 << 14) | (s2 << 7) | s3
        footer_len = 10 if (flags & 0x10) else 0
        next_off = id3_offset + 10 + tag_size + footer_len
        id3v2_count += 1
        id3v2_versions.append(f"2.{maj_ver}.{rev_ver}")
        if next_off > len(buf):
            findings.append(
                RepairFinding(
                    code="id3v2_truncated",
                    severity="critical",
                    category="tags",
                    title="Beschädigter / abgeschnittener ID3v2-Header",
                    description=f"Der ID3v2.{maj_ver}-Tag meldet {tag_size} Bytes, überschreitet jedoch das Dateiende.",
                    recommended_fix="Tags bereinigen und ID3v2-Header sauber neu schreiben.",
                    stage="fast",
                    fix_action="header_strip",
                )
            )
            break
        id3_offset = next_off
        if id3v2_count > 6:
            break

    if id3v2_count > 1:
        findings.append(
            RepairFinding(
                code="duplicate_id3v2",
                severity="warning",
                category="tags",
                title=f"Mehrfache ID3v2-Header gestapelt ({id3v2_count}× erkannt)",
                description=(
                    f"Es liegen {id3v2_count} aufeinanderfolgende ID3v2-Blöcke "
                    f"({', '.join(id3v2_versions)}) vor."
                ),
                recommended_fix="Doppelte ID3v2-Blöcke per Header-Strip zu einem einzigen ID3v2-Tag zusammenführen.",
                stage="fast",
                fix_action="header_strip",
            )
        )

    audio_end = len(buf)
    has_id3v1 = False
    has_apev2 = False
    has_extra_trailer = False
    if file_ext in (".mp3", ".mp2"):
        audio_end, has_id3v1, has_apev2, has_extra_trailer = _strip_mpeg_trailing_tags(buf, id3_offset)

    # 2. ffprobe Metadaten & Stream-Parameter
    probe_json: dict = {}
    if shutil.which("ffprobe"):
        res = subprocess.run(
            [
                "ffprobe",
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
                str(file_path),
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if res.returncode == 0 and res.stdout.strip():
            try:
                probe_json = json.loads(res.stdout)
            except Exception:
                probe_json = {}

    streams = probe_json.get("streams") or []
    fmt_info = probe_json.get("format") or {}
    audio_stream = next((s for s in streams if s.get("codec_type") == "audio"), {})
    cover_stream = next(
        (
            s
            for s in streams
            if s.get("codec_type") == "video"
            or int((s.get("disposition") or {}).get("attached_pic") or 0) == 1
        ),
        None,
    )

    codec = str(audio_stream.get("codec_name") or file_ext.lstrip(".") or "audio").lower()
    container = str(fmt_info.get("format_name") or file_ext.lstrip(".")).lower()
    sample_rate = int(audio_stream.get("sample_rate") or 44100)
    channels = int(audio_stream.get("channels") or 2)
    sample_fmt = str(audio_stream.get("sample_fmt") or "").lower()
    channel_layout = str(audio_stream.get("channel_layout") or "").lower()
    bits_per_sample = int(
        audio_stream.get("bits_per_raw_sample")
        or audio_stream.get("bits_per_sample")
        or (
            32
            if ("32" in sample_fmt or "flt" in sample_fmt)
            else (24 if "24" in sample_fmt else (8 if ("u8" in sample_fmt or sample_fmt == "s8") else 16))
        )
    )
    bitrate_kbps = round(int(float(audio_stream.get("bit_rate") or fmt_info.get("bit_rate") or 0)) / 1000)
    duration_seconds = round(float(fmt_info.get("duration") or audio_stream.get("duration") or 0))

    raw_tags: dict[str, str] = {}
    for bag in (fmt_info.get("tags"), audio_stream.get("tags")):
        if isinstance(bag, dict):
            for k, v in bag.items():
                if isinstance(v, str) and v.strip():
                    raw_tags[str(k).lower()] = v.strip()

    missing_tags: list[str] = []
    if not raw_tags.get("title"):
        missing_tags.append("Titel")
    if not raw_tags.get("artist"):
        missing_tags.append("Interpret")
    if not raw_tags.get("album"):
        missing_tags.append("Album")
    if missing_tags and file_ext != ".wav":
        findings.append(
            RepairFinding(
                code="incomplete_tags",
                severity="info",
                category="tags",
                title=f"Fehlende Basis-Tags ({', '.join(missing_tags)})",
                description=f"In den Datei-Metadaten fehlen: {', '.join(missing_tags)}.",
                recommended_fix="Basis-Tags in Modul 3 vervollständigen.",
                auto_fixable=False,
            )
        )

    # Magic-Bytes vs. Dateiendung + Cover-Art-Inspektion (Stufe 1: Fast-Check)
    expected_group = (
        "aiff"
        if file_ext in (".aif", ".aifc")
        else ("ogg" if file_ext == ".opus" else file_ext.lstrip("."))
    )
    detected_magic = _detect_magic_signature(buf, id3_offset)
    magic_matches_extension = (
        True
        if detected_magic == "unknown"
        else (
            expected_group == detected_magic
            or (expected_group == "mp3" and detected_magic == "mp2")
            or (expected_group == "mp2" and detected_magic == "mp3")
        )
    )
    if not magic_matches_extension and not (file_ext == ".flac" and detected_magic == "ogg"):
        findings.append(
            RepairFinding(
                code="extension_magic_mismatch",
                severity="critical",
                category="header",
                title=f"Dateiendung ({file_ext}) widerspricht Magic-Bytes ({detected_magic.upper()})",
                description=(
                    f"Die Datei trägt die Endung „{file_ext}“, die binäre Header-Signatur "
                    f"gehört jedoch zum Containerformat „{detected_magic.upper()}“."
                ),
                recommended_fix=f"Container per Remuxing/Re-Encoding sauber in echtes {expected_group.upper()} überführen.",
                stage="fast",
                fix_action="remux_faststart",
            )
        )

    has_cover_art = cover_stream is not None
    cover_art_mime = ""
    cover_art_bytes = 0
    cover_art_width = int((cover_stream or {}).get("width") or 0) if cover_stream else 0
    cover_art_height = int((cover_stream or {}).get("height") or 0) if cover_stream else 0
    if has_cover_art and shutil.which("ffmpeg"):
        declared_cover_codec = str((cover_stream or {}).get("codec_name") or "").lower()
        try:
            cov_res = subprocess.run(
                [
                    "ffmpeg", "-hide_banner", "-loglevel", "error",
                    "-threads", str(eff_threads), "-filter_threads", str(eff_threads),
                    "-i", str(file_path), "-map", "0:v:0", "-c:v", "copy", "-f", "image2pipe", "-",
                ],
                capture_output=True,
                timeout=10,
            )
            extracted_cover = cov_res.stdout or b""
        except Exception:
            extracted_cover = b""
        cover_art_bytes = len(extracted_cover)
        if cover_art_bytes > 0 and (cover_art_width == 0 or cover_art_height == 0) and shutil.which("ffprobe"):
            try:
                cov_probe = subprocess.run(
                    ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", "-"],
                    input=extracted_cover,
                    capture_output=True,
                    timeout=5,
                )
                if cov_probe.returncode == 0 and cov_probe.stdout:
                    cp_json = json.loads(cov_probe.stdout.decode("utf-8", errors="ignore"))
                    cp_streams = cp_json.get("streams") or []
                    if cp_streams:
                        cover_art_width = int(cp_streams[0].get("width") or cover_art_width or 0)
                        cover_art_height = int(cp_streams[0].get("height") or cover_art_height or 0)
            except Exception:
                pass
        cover_art_mime = _detect_image_mime_from_magic(extracted_cover) or (
            "image/jpeg"
            if declared_cover_codec == "mjpeg"
            else (f"image/{declared_cover_codec}" if declared_cover_codec else "")
        )
        exceeds_dims = cover_art_width > max_cover_dim or cover_art_height > max_cover_dim
        exceeds_size = cover_art_bytes > 1024 * 1024
        if cover_art_mime and cover_art_mime not in ("image/jpeg", "image/png"):
            findings.append(
                RepairFinding(
                    code="cover_art_unsupported_mime",
                    severity="warning",
                    category="tags",
                    title=f"Unübliches Cover-Art-Format ({cover_art_mime})",
                    description=(
                        f"Eingebettetes Cover liegt als „{cover_art_mime}“ vor. Player und Browser erwarten meist JPEG oder PNG."
                    ),
                    recommended_fix=(
                        f"Cover-Optimierung konvertiert nach JPEG und skaliert auf max. {max_cover_dim}×{max_cover_dim} px."
                        if exceeds_dims
                        else (
                            f"Cover-Optimierung konvertiert nach JPEG unter Erhalt der Pixel-Dimensionen ({cover_art_width}×{cover_art_height} px)."
                            if cover_art_width > 0 and cover_art_height > 0
                            else f"Cover-Optimierung konvertiert nach JPEG (max. {max_cover_dim}×{max_cover_dim} px)."
                        )
                    ),
                    stage="fast",
                    fix_action="cover_optimize",
                )
            )
        if exceeds_dims:
            kb = round(cover_art_bytes / 1024)
            findings.append(
                RepairFinding(
                    code="cover_art_oversized",
                    severity="warning",
                    category="tags",
                    title=f"Cover-Auflösung überschreitet Limit ({cover_art_width}×{cover_art_height} px > {max_cover_dim}×{max_cover_dim} px)",
                    description=(
                        f"Eingebettetes Cover ({cover_art_width}×{cover_art_height} px · {kb} KB) überschreitet das konfigurierte Maximum von {max_cover_dim}×{max_cover_dim} px."
                    ),
                    recommended_fix=(
                        f"Cover-Optimierung skaliert proportional auf max. {max_cover_dim}×{max_cover_dim} px"
                        + (" und komprimiert auf ≤ 1 MB." if exceeds_size else ".")
                    ),
                    stage="fast",
                    fix_action="cover_optimize",
                )
            )
        elif exceeds_size:
            kb = round(cover_art_bytes / 1024)
            mb_s = f"{cover_art_bytes / (1024 * 1024):.2f}"
            dim_note = f" · {cover_art_width}×{cover_art_height} px" if cover_art_width > 0 and cover_art_height > 0 else ""
            dim_desc = (
                f" Die Pixel-Dimensionen ({cover_art_width}×{cover_art_height} px) liegen innerhalb des Limits von {max_cover_dim}×{max_cover_dim} px."
                if cover_art_width > 0 and cover_art_height > 0
                else ""
            )
            findings.append(
                RepairFinding(
                    code="cover_art_oversized",
                    severity="warning",
                    category="tags",
                    title=f"Cover-Dateigröße > 1 MB ({mb_s} MB{dim_note})",
                    description=f"Eingebettetes Cover ({kb} KB) ist größer als 1 MB.{dim_desc}",
                    recommended_fix=(
                        f"Cover-Optimierung komprimiert auf ≤ 1 MB — aktuelle Pixel-Dimensionen ({cover_art_width}×{cover_art_height} px) bleiben zwingend erhalten."
                        if cover_art_width > 0 and cover_art_height > 0
                        else "Cover-Optimierung komprimiert auf ≤ 1 MB unter Erhalt der Pixel-Dimensionen."
                    ),
                    stage="fast",
                    fix_action="cover_optimize",
                )
            )

    # 3. Formatspezifische Binärprüfung
    is_vbr = False
    has_xing = False
    xing_frames = 0
    xing_audio_bytes = 0
    actual_frames = 0
    actual_audio_bytes = 0
    sync_gap_ratios: list[float] = []
    mixed_sr_ratios: list[float] = []
    leading_garbage = 0
    trailing_garbage = 0
    corrupt_gaps = 0
    flac_md5_valid: Optional[bool] = None
    flac_md5_status: Optional[str] = None
    flac_has_seektable: Optional[bool] = None
    seek_table_valid: Optional[bool] = None
    flac_is_ogg: Optional[bool] = None
    flac_streaminfo_valid: Optional[bool] = None
    flac_subset_valid: Optional[bool] = None
    flac_min_bs: Optional[int] = None
    flac_max_bs: Optional[int] = None
    flac_var_bs: Optional[bool] = None
    flac_firefox_compat: Optional[str] = None
    m4a_moov_pos: Optional[str] = None
    flac_si_md5_hex: Optional[str] = None
    flac_total_samples_hdr = 0
    flac_eff_bps = bits_per_sample
    flac_eff_sr = sample_rate
    flac_eff_channels = channels

    if codec in ("mp3", "mp2") or file_ext in (".mp3", ".mp2"):
        if file_ext not in (".mp3", ".mp2") and not has_id3v1 and not has_apev2:
            audio_end, has_id3v1, has_apev2, has_extra_trailer = _strip_mpeg_trailing_tags(buf, id3_offset)
        bitrates_seen: set[int] = set()
        srs_seen: set[int] = set()
        first_off = -1
        stream_ver = -1
        stream_layer = -1
        stream_sr = 0
        pos = id3_offset
        while pos + 4 < audio_end:
            hdr = _parse_mpeg_frame_header(buf, pos)
            if hdr and pos + hdr["frame_len"] + 4 <= audio_end:
                nh = _parse_mpeg_frame_header(buf, pos + hdr["frame_len"])
                if (
                    nh
                    and nh["version_id"] == hdr["version_id"]
                    and nh["layer_id"] == hdr["layer_id"]
                    and nh["sample_rate"] == hdr["sample_rate"]
                ):
                    first_off = pos
                    stream_ver = hdr["version_id"]
                    stream_layer = hdr["layer_id"]
                    stream_sr = hdr["sample_rate"]
                    break
            pos += 1

        if first_off < 0:
            findings.append(
                RepairFinding(
                    code="no_mpeg_sync",
                    severity="critical",
                    category="frames",
                    title="Keine gültige MPEG-Audio-Synchronisation gefunden",
                    description="Die Datei enthält keinen gültigen MP3/MPEG-Frame-Strom.",
                    recommended_fix="Stream neu aufbauen oder Originaldatei prüfen.",
                    auto_fixable=False,
                    stage="fast",
                )
            )
        else:
            leading_garbage = max(0, first_off - id3_offset)
            if leading_garbage > 4:
                findings.append(
                    RepairFinding(
                        code="leading_garbage",
                        severity="warning",
                        category="frames",
                        title=f"Fremddaten vor erstem MPEG-Frame ({leading_garbage} Bytes)",
                        description=f"Zwischen Tag-Bereich und erstem Frame liegen {leading_garbage} Müll-Bytes.",
                        recommended_fix="Header-Strip: Defekte Sync-Frames & Müll-Bytes vor dem Stream entfernen.",
                        stage="fast",
                        fix_action="header_strip",
                    )
                )

            fhdr = _parse_mpeg_frame_header(buf, first_off)
            if fhdr:
                crc_len = 2 if fhdr.get("has_crc") else 0
                side_len = (17 if fhdr["channel_mode"] == 3 else 32) if fhdr["version_id"] == 3 else (9 if fhdr["channel_mode"] == 3 else 17)
                xing_off = first_off + 4 + crc_len + side_len
                if xing_off + 16 <= len(buf) and buf[xing_off : xing_off + 4] in (b"Xing", b"Info"):
                    has_xing = True
                    xflags = int.from_bytes(buf[xing_off + 4 : xing_off + 8], "big")
                    cur = xing_off + 8
                    if (xflags & 0x01) and cur + 4 <= len(buf):
                        xing_frames = int.from_bytes(buf[cur : cur + 4], "big")
                        cur += 4
                    if (xflags & 0x02) and cur + 4 <= len(buf):
                        xing_audio_bytes = int.from_bytes(buf[cur : cur + 4], "big")
                for vbri_off in (first_off + 4 + crc_len + 32, first_off + 36):
                    if not has_xing and vbri_off + 18 <= len(buf) and buf[vbri_off : vbri_off + 4] == b"VBRI":
                        has_xing = True
                        xing_audio_bytes = int.from_bytes(buf[vbri_off + 10 : vbri_off + 14], "big")
                        xing_frames = int.from_bytes(buf[vbri_off + 14 : vbri_off + 18], "big")
                        break

            scan_pos = first_off
            last_end = first_off
            while scan_pos + 4 <= audio_end:
                hdr = _parse_mpeg_frame_header(buf, scan_pos)
                if (
                    hdr
                    and hdr["version_id"] == stream_ver
                    and hdr["layer_id"] == stream_layer
                    and scan_pos + hdr["frame_len"] <= audio_end
                ):
                    is_xing_meta_frame = (scan_pos == first_off) and has_xing
                    actual_frames += 1
                    if not is_xing_meta_frame:
                        bitrates_seen.add(hdr["bitrate_kbps"])
                    if hdr["sample_rate"] != stream_sr and len(mixed_sr_ratios) < 8:
                        span = max(1, audio_end - first_off)
                        mixed_sr_ratios.append(max(0.0, min(1.0, (scan_pos - first_off) / span)))
                    srs_seen.add(hdr["sample_rate"])
                    last_end = scan_pos + hdr["frame_len"]
                    scan_pos = last_end
                else:
                    resync = scan_pos + 1
                    found = False
                    while resync + 4 < audio_end:
                        nh = _parse_mpeg_frame_header(buf, resync)
                        if (
                            nh
                            and nh["version_id"] == stream_ver
                            and nh["layer_id"] == stream_layer
                            and resync + nh["frame_len"] + 4 <= audio_end
                        ):
                            nh2 = _parse_mpeg_frame_header(buf, resync + nh["frame_len"])
                            if (
                                nh2
                                and nh2["version_id"] == stream_ver
                                and nh2["layer_id"] == stream_layer
                                and nh2["sample_rate"] == nh["sample_rate"]
                            ):
                                if nh["sample_rate"] == stream_sr:
                                    found = True
                                    break
                                # Bei anderer Abtastrate dritten Bestätigungs-Frame verlangen (verhindert Fehlalarme in Restbytes)
                                third_off = resync + nh["frame_len"] + nh2["frame_len"]
                                if third_off + 4 <= audio_end:
                                    nh3 = _parse_mpeg_frame_header(buf, third_off)
                                    if (
                                        nh3
                                        and nh3["version_id"] == stream_ver
                                        and nh3["layer_id"] == stream_layer
                                        and nh3["sample_rate"] == nh["sample_rate"]
                                    ):
                                        found = True
                                        break
                        resync += 1
                    if found:
                        corrupt_gaps += 1
                        if len(sync_gap_ratios) < 16:
                            span = max(1, audio_end - first_off)
                            sync_gap_ratios.append(max(0.0, min(1.0, (scan_pos - first_off) / span)))
                        scan_pos = resync
                    else:
                        break

            actual_audio_bytes = max(0, last_end - first_off)
            trailing_garbage = max(0, audio_end - last_end)
            is_vbr = len(bitrates_seen) > 1
            seek_table_valid = has_xing if is_vbr else True

            if corrupt_gaps > 0:
                findings.append(
                    RepairFinding(
                        code="corrupt_sync_gaps",
                        severity="critical",
                        category="frames",
                        title=f"{corrupt_gaps} Synchronisationslücke(n) im MPEG-Stream",
                        description=f"Im Audiostrom wurden {corrupt_gaps} defekte Sync-Bereiche gefunden.",
                        recommended_fix="Stream neu muxen und defekte Frame-Lücken bereinigen.",
                        stage="fast",
                        fix_action="remux_faststart",
                    )
                )
            if trailing_garbage > 16:
                findings.append(
                    RepairFinding(
                        code="trailing_garbage",
                        severity="warning",
                        category="frames",
                        title=f"Überhängende Bytes am Dateiende ({trailing_garbage} Bytes)",
                        description=f"Nach dem letzten gültigen Audio-Frame folgen {trailing_garbage} Restbytes.",
                        recommended_fix="Header-Strip: Abgeschnittene Restframes verlustfrei entfernen.",
                        stage="fast",
                        fix_action="header_strip",
                    )
                )
            if len(srs_seen) > 1:
                findings.append(
                    RepairFinding(
                        code="mixed_samplerate_frames",
                        severity="critical",
                        category="frames",
                        title="Wechselnde Abtastraten innerhalb der MP3-Datei",
                        description="Frames mit unterschiedlichen Sample-Raten erkannt.",
                        recommended_fix="VBR-Header-Rebuild: Datei sauber neu aufbauen.",
                        stage="fast",
                        fix_action="vbr_header_rebuild",
                    )
                )
            if is_vbr and not has_xing:
                seek_table_valid = False
                findings.append(
                    RepairFinding(
                        code="missing_xing_header",
                        severity="critical",
                        category="header",
                        title="Fehlender VBR/Xing-Header (falsche Spielzeit-Anzeige)",
                        description=f"VBR-MP3 ({actual_frames} Frames) besitzt keinen Xing-/LAME-Header.",
                        recommended_fix="VBR-Header-Rebuild: Xing / Info-Header verlustfrei neu aufbauen.",
                        stage="fast",
                        fix_action="vbr_header_rebuild",
                    )
                )
            elif has_xing and (
                (
                    xing_frames > 0
                    and actual_frames > 10
                    and min(abs(xing_frames - actual_frames), abs(xing_frames - max(0, actual_frames - 1)))
                    > max(4, round(actual_frames * 0.02))
                )
                or (
                    xing_audio_bytes > 0
                    and actual_audio_bytes > 4096
                    and abs(xing_audio_bytes - actual_audio_bytes) > max(4096, round(actual_audio_bytes * 0.05))
                )
            ):
                seek_table_valid = False
                findings.append(
                    RepairFinding(
                        code="xing_frame_mismatch",
                        severity="warning",
                        category="header",
                        title="Xing/Info-Header widerspricht realer Stream-Größe",
                        description=f"Header meldet {xing_frames} Frames ({xing_audio_bytes} B), real sind {actual_frames} Frames ({actual_audio_bytes} B).",
                        recommended_fix="VBR-Header-Rebuild: Xing / Info-Header & Seek-TOC korrigieren.",
                        stage="fast",
                        fix_action="vbr_header_rebuild",
                    )
                )
            if id3v2_count == 0 and has_id3v1:
                findings.append(
                    RepairFinding(
                        code="id3v1_only",
                        severity="info",
                        category="tags",
                        title="Nur veralteter ID3v1-Tag vorhanden (kein ID3v2)",
                        description="ID3v1 unterstützt max. 30 Zeichen und kein UTF-8.",
                        recommended_fix="Sauberen ID3v2-Header ergänzen.",
                        stage="fast",
                        fix_action="header_strip",
                    )
                )

    elif codec == "flac" or file_ext == ".flac" or "flac" in container:
        std_flac_srs = {
            8000, 11025, 12000, 16000, 22050, 24000,
            32000, 44100, 48000, 88200, 96000, 176400, 192000,
        }
        payload_after_id3 = buf[max(0, id3_offset) :]
        starts_with_ogg = (
            payload_after_id3[:4] == b"OggS"
            or "ogg" in container.split(",")
        )
        flac_is_ogg = starts_with_ogg
        flac_streaminfo_valid = False
        flac_subset_valid = True

        if id3v2_count > 0:
            findings.append(
                RepairFinding(
                    code="flac_has_id3v2_prefix",
                    severity="critical",
                    category="header",
                    title="Vorangestellter ID3v2-Header vor fLaC (Firefox-inkompatibel)",
                    description=(
                        f"FLAC verwendet Vorbis Comments statt ID3v2 ({id3v2_count}× ID3v2 vor Streamstart). "
                        "Strenge Parser wie der Firefox FlacDemuxer lehnen vorangestellte ID3-Header ab."
                    ),
                    recommended_fix="Header-Strip / Remuxing: ID3v2-Präfix entfernen und Metadaten als Vorbis Comments schreiben.",
                    stage="fast",
                    fix_action="header_strip",
                )
            )

        if starts_with_ogg:
            flac_subset_valid = False
            findings.append(
                RepairFinding(
                    code="flac_ogg_container",
                    severity="critical",
                    category="header",
                    title="Ogg-FLAC-Container statt nativem FLAC (Firefox-inkompatibel)",
                    description=(
                        "Die Datei verwendet einen Ogg-Container (OggS) statt des nativen fLaC-Formats. "
                        "Firefox lehnt Ogg-FLAC bei .flac-Dateien ab."
                    ),
                    recommended_fix="Verlustfreies Re-Encoding in einen nativen fLaC-Container.",
                    stage="fast",
                    fix_action="lossless_reencode",
                )
            )
        else:
            direct_magic = payload_after_id3[:4] == b"fLaC"
            search_end = min(len(buf), max(0, id3_offset) + 16384)
            flac_start = (
                max(0, id3_offset)
                if direct_magic
                else buf.find(b"fLaC", max(0, id3_offset), search_end)
            )

            if flac_start >= 0 and flac_start + 4 <= len(buf):
                if flac_start > id3_offset:
                    leading_garbage = flac_start - id3_offset
                    findings.append(
                        RepairFinding(
                            code="flac_leading_garbage",
                            severity="critical",
                            category="header",
                            title=f"Fremdbytes vor fLaC-Signatur ({leading_garbage} Bytes)",
                            description="Die fLaC-Signatur beginnt nicht am Stream-Anfang. Firefox erfordert „fLaC“ exakt an Byte 0.",
                            recommended_fix="Header-Strip: Fremdbytes vor fLaC entfernen und Container neu aufbauen.",
                            stage="fast",
                            fix_action="header_strip",
                        )
                    )

                blk_off = flac_start + 4
                blk_index = 0
                streaminfo_cnt = 0
                first_is_si = False
                has_seek = False
                is_last = False
                seektable_blocks: list[tuple[int, int]] = []
                while not is_last and blk_off + 4 <= len(buf):
                    hdr_b = buf[blk_off]
                    is_last = bool(hdr_b & 0x80)
                    blk_type = hdr_b & 0x7F
                    blk_len = (buf[blk_off + 1] << 16) | (buf[blk_off + 2] << 8) | buf[blk_off + 3]
                    data_off = blk_off + 4
                    if data_off + blk_len > len(buf):
                        findings.append(
                            RepairFinding(
                                code="flac_corrupt_metadata_block",
                                severity="critical",
                                category="header",
                                title="Defekter FLAC-Metadatenblock",
                                description="Die Längenangabe eines FLAC-Metadatenblocks überschreitet das Dateiende.",
                                recommended_fix="Verlustfreies Re-Encoding über 2-Schritt-WAV.",
                                stage="fast",
                                fix_action="lossless_reencode",
                            )
                        )
                        break

                    if blk_type == 0:
                        streaminfo_cnt += 1
                        if blk_index == 0:
                            first_is_si = True
                        if blk_len != 34:
                            findings.append(
                                RepairFinding(
                                    code="flac_invalid_streaminfo",
                                    severity="critical",
                                    category="header",
                                    title=f"Fehlerhafte STREAMINFO-Blockgröße ({blk_len} statt 34 Bytes)",
                                    description="Der FLAC-STREAMINFO-Block muss exakt 34 Bytes umfassen, damit Firefox ihn einlesen kann.",
                                    recommended_fix="Verlustfreies Re-Encoding / STREAMINFO-Neuaufbau.",
                                    stage="fast",
                                    fix_action="lossless_reencode",
                                )
                            )
                        else:
                            min_bs = int.from_bytes(buf[data_off : data_off + 2], "big")
                            max_bs = int.from_bytes(buf[data_off + 2 : data_off + 4], "big")
                            packed = int.from_bytes(buf[data_off + 10 : data_off + 18], "big")
                            si_sr = (packed >> 44) & 0xFFFFF
                            si_ch = ((packed >> 41) & 0x7) + 1
                            si_bps = ((packed >> 36) & 0x1F) + 1
                            si_total = packed & 0xFFFFFFFFF
                            flac_total_samples_hdr = si_total
                            flac_min_bs = min_bs
                            flac_max_bs = max_bs
                            if si_sr > 0:
                                flac_eff_sr = si_sr
                            if si_ch > 0:
                                flac_eff_channels = si_ch
                            if si_bps > 0:
                                flac_eff_bps = si_bps

                            valid_dims = (
                                min_bs >= 16
                                and max_bs >= min_bs
                                and si_sr > 0
                                and 1 <= si_ch <= 8
                                and si_bps >= 4
                            )
                            if blk_index == 0 and streaminfo_cnt == 1 and valid_dims:
                                flac_streaminfo_valid = True
                            elif not valid_dims:
                                findings.append(
                                    RepairFinding(
                                        code="flac_invalid_streaminfo",
                                        severity="critical",
                                        category="header",
                                        title="Ungültige Parameter im FLAC-STREAMINFO-Block",
                                        description=f"Ungültige Basiswerte (Blockgröße: {min_bs}–{max_bs}, {si_sr} Hz, {si_bps}-Bit).",
                                        recommended_fix="FLAC-Header & STREAMINFO verlustfrei neu aufbauen.",
                                        stage="fast",
                                        fix_action="lossless_reencode",
                                    )
                                )

                            if si_total == 0:
                                findings.append(
                                    RepairFinding(
                                        code="flac_unknown_total_samples",
                                        severity="warning",
                                        category="header",
                                        title="STREAMINFO ohne Gesamtlänge (Total Samples = 0)",
                                        description="Ohne Sample-Anzahl im STREAMINFO zeigt Firefox ggf. keine Dauer und Spulen versagt.",
                                        recommended_fix="STREAMINFO mit exakter Sample-Anzahl neu erzeugen.",
                                        stage="fast",
                                        fix_action="lossless_reencode",
                                    )
                                )

                            if audio_stream.get("codec_type") == "audio" and (
                                (si_sr > 0 and abs(si_sr - sample_rate) > 1)
                                or (si_ch > 0 and si_ch != channels)
                            ):
                                findings.append(
                                    RepairFinding(
                                        code="flac_streaminfo_mismatch",
                                        severity="warning",
                                        category="header",
                                        title="STREAMINFO weicht von Audio-Frames ab",
                                        description=f"STREAMINFO meldet {si_sr} Hz / {si_ch}ch, Frames haben {sample_rate} Hz / {channels}ch.",
                                        recommended_fix="FLAC-Container über 2-Schritt-WAV neu aufbauen.",
                                        stage="fast",
                                        fix_action="lossless_reencode",
                                    )
                                )

                            md5_slice = buf[data_off + 18 : data_off + 34]
                            all_zero = all(b == 0 for b in md5_slice)
                            if all_zero:
                                flac_md5_valid = False
                                flac_md5_status = "missing"
                                findings.append(
                                    RepairFinding(
                                        code="flac_zero_md5",
                                        severity="warning",
                                        category="header",
                                        title="FLAC-STREAMINFO enthält keine MD5-Prüfsumme (0000...)",
                                        description="Leere Audio-MD5-Signatur im STREAMINFO-Block.",
                                        recommended_fix="FLAC-Header & MD5 verlustfrei neu schreiben.",
                                        stage="fast",
                                        fix_action="lossless_reencode",
                                    )
                                )
                            else:
                                flac_md5_valid = True
                                flac_md5_status = "unverified"
                                flac_si_md5_hex = md5_slice.hex()
                    elif blk_type == 3:
                        has_seek = True
                        seektable_blocks.append((data_off, blk_len))
                    blk_index += 1
                    blk_off = data_off + blk_len

                if streaminfo_cnt == 0 or not first_is_si:
                    flac_streaminfo_valid = False
                    flac_subset_valid = False
                    findings.append(
                        RepairFinding(
                            code="flac_missing_streaminfo",
                            severity="critical",
                            category="header",
                            title=(
                                "Fehlender FLAC-STREAMINFO-Metadatenblock"
                                if streaminfo_cnt == 0
                                else "STREAMINFO steht nicht als erster Metadatenblock"
                            ),
                            description="Gemäß FLAC-Spezifikation und Firefox FlacDemuxer muss STREAMINFO direkt nach fLaC stehen.",
                            recommended_fix="FLAC-Container über 2-Schritt-WAV neu aufbauen.",
                            stage="fast",
                            fix_action="lossless_reencode",
                        )
                    )
                elif streaminfo_cnt > 1:
                    flac_streaminfo_valid = False
                    flac_subset_valid = False
                    findings.append(
                        RepairFinding(
                            code="flac_duplicate_streaminfo",
                            severity="critical",
                            category="header",
                            title=f"Mehrfache STREAMINFO-Blöcke erkannt ({streaminfo_cnt}×)",
                            description="Eine gültige FLAC-Datei darf nur einen einzigen STREAMINFO-Block enthalten.",
                            recommended_fix="FLAC-Header sauber neu schreiben.",
                            stage="fast",
                            fix_action="lossless_reencode",
                        )
                    )

                # SEEKTABLE strukturell prüfen (18 Bytes pro Punkt, sortiert & innerhalb Stream)
                first_audio_off = blk_off
                if seektable_blocks:
                    seek_table_valid = True
                    seek_err_reason = ""
                    max_rel_off = max(0, len(buf) - first_audio_off)
                    for st_off, st_len in seektable_blocks:
                        if st_len % 18 != 0:
                            seek_table_valid = False
                            seek_err_reason = f"Blockgröße ({st_len} B) kein Vielfaches von 18 Bytes"
                            break
                        prev_smp = -1
                        prev_off = -1
                        for p in range(0, st_len, 18):
                            smp_nr = int.from_bytes(buf[st_off + p : st_off + p + 8], "big")
                            if smp_nr == 0xFFFFFFFFFFFFFFFF:
                                continue
                            rel_off = int.from_bytes(buf[st_off + p + 8 : st_off + p + 16], "big")
                            if smp_nr <= prev_smp or rel_off < prev_off:
                                seek_table_valid = False
                                seek_err_reason = "Seekpoints sind nicht monoton steigend sortiert"
                                break
                            if rel_off >= max_rel_off + 1:
                                seek_table_valid = False
                                seek_err_reason = "Seekpoint verweist hinter das Dateiende"
                                break
                            if flac_total_samples_hdr > 0 and smp_nr >= flac_total_samples_hdr:
                                seek_table_valid = False
                                seek_err_reason = "Seekpoint-Sample liegt außerhalb der Gesamtdauer"
                                break
                            prev_smp = smp_nr
                            prev_off = rel_off
                        if not seek_table_valid:
                            break
                    if not seek_table_valid:
                        findings.append(
                            RepairFinding(
                                code="flac_invalid_seektable",
                                severity="warning",
                                category="header",
                                title="Ungültige FLAC-SEEKTABLE erkannt",
                                description=f"Die Seek-Tabelle ist beschädigt ({seek_err_reason}). Spulen kann fehlschlagen.",
                                recommended_fix="FLAC-Container mit gültiger SEEKTABLE verlustfrei neu aufbauen.",
                                stage="fast",
                                fix_action="lossless_reencode",
                            )
                        )

                frame_var_strategy = False
                frame_ch_assign = -1
                if is_last and blk_off + 4 <= len(buf):
                    fb0, fb1 = buf[blk_off], buf[blk_off + 1]
                    if fb0 == 0xFF and (fb1 & 0xFE) == 0xF8:
                        frame_var_strategy = (fb1 & 0x01) == 1
                        frame_ch_assign = (buf[blk_off + 3] >> 4) & 0x0F

                has_var_bs = (
                    flac_min_bs is not None
                    and flac_max_bs is not None
                    and flac_min_bs > 0
                    and flac_min_bs != flac_max_bs
                ) or frame_var_strategy
                flac_var_bs = has_var_bs

                subset_bs_limit = 4608 if flac_eff_sr <= 48000 else 16384
                if has_var_bs:
                    flac_subset_valid = False
                    findings.append(
                        RepairFinding(
                            code="flac_variable_blocksize",
                            severity="warning",
                            category="stream",
                            title=f"Variable FLAC-Blockgrößen ({flac_min_bs or '?'}–{flac_max_bs or '?'} Samples)",
                            description="Variable Blockgrößen liegen außerhalb des FLAC-Subsets und verursachen in Firefox Seeking-/Dekodierprobleme.",
                            recommended_fix="Verlustfreies Re-Encoding mit konstanter Standard-Blockgröße.",
                            stage="fast",
                            fix_action="lossless_reencode",
                        )
                    )
                elif flac_max_bs is not None and flac_max_bs > subset_bs_limit:
                    flac_subset_valid = False
                    findings.append(
                        RepairFinding(
                            code="flac_oversized_blocksize",
                            severity="warning",
                            category="stream",
                            title=f"FLAC-Blockgröße außerhalb Subset-Limit ({flac_max_bs} > {subset_bs_limit} Samples)",
                            description=f"Bei {flac_eff_sr / 1000:.1f} kHz erlaubt das FLAC-Subset max. {subset_bs_limit} Samples pro Block.",
                            recommended_fix="FLAC mit Standard-Blockgröße (4096/4608) verlustfrei neu kodieren.",
                            stage="fast",
                            fix_action="lossless_reencode",
                        )
                    )

                if frame_ch_assign >= 11:
                    flac_subset_valid = False
                    findings.append(
                        RepairFinding(
                            code="flac_firefox_unusual_channels",
                            severity="warning",
                            category="stream",
                            title=f"Ungültige/reservierte FLAC-Kanalzuordnung (Code {frame_ch_assign})",
                            description="Der erste Audio-Frame verwendet einen reservierten Kanalzuordnungs-Code (11–15).",
                            recommended_fix="FLAC-Stream über WAV sauber neu aufbauen.",
                            stage="fast",
                            fix_action="lossless_reencode",
                        )
                    )

                flac_has_seektable = has_seek
                if not has_seek:
                    findings.append(
                        RepairFinding(
                            code="flac_no_seektable",
                            severity="info",
                            category="header",
                            title="Keine FLAC-SEEKTABLE vorhanden",
                            description="Ohne Seektable kann Spulen verzögert sein.",
                            recommended_fix="Container mit SEEKTABLE neu aufbauen.",
                            stage="fast",
                            fix_action="remux_faststart",
                        )
                    )
            else:
                flac_subset_valid = False
                findings.append(
                    RepairFinding(
                        code="flac_missing_marker",
                        severity="critical",
                        category="header",
                        title="Fehlender fLaC-Container-Header",
                        description="Keine gültige fLaC-Signatur gefunden.",
                        recommended_fix="FLAC-Container verlustfrei reparieren.",
                        stage="fast",
                        fix_action="lossless_reencode",
                    )
                )

        # Firefox- & FLAC-Subset-Kriterien: Abtastrate & Bittiefe
        if flac_eff_sr <= 0:
            flac_subset_valid = False
            findings.append(
                RepairFinding(
                    code="flac_firefox_samplerate_too_high",
                    severity="critical",
                    category="stream",
                    title="Ungültige FLAC-Abtastrate (0 Hz)",
                    description="Im STREAMINFO-Header ist keine gültige Abtastrate hinterlegt.",
                    recommended_fix="Verlustfreies Re-Encoding der FLAC-Datei durchführen.",
                    stage="fast",
                    fix_action="lossless_reencode",
                )
            )
        elif flac_eff_sr > 192000:
            flac_subset_valid = False
            findings.append(
                RepairFinding(
                    code="flac_firefox_samplerate_too_high",
                    severity="warning",
                    category="stream",
                    title=f"Hi-Res-Abtastrate {flac_eff_sr / 1000:.1f} kHz (> 192 kHz — Firefox-inkompatibel)",
                    description="Die FLAC-Datei ist technisch gültig, aber Firefox unterstützt natives FLAC nur bis maximal 192 kHz Abtastrate.",
                    recommended_fix="Nur bei Bedarf für Firefox-Wiedergabe „FLAC-Firefox-Konvertierung“ aktivieren (Resampling auf ≤ 192 kHz).",
                    auto_fixable=False,
                    stage="fast",
                    fix_action="lossless_reencode",
                )
            )
        elif flac_eff_sr not in std_flac_srs:
            flac_subset_valid = False
            findings.append(
                RepairFinding(
                    code="flac_firefox_nonstandard_samplerate",
                    severity="warning",
                    category="stream",
                    title=f"Nicht standardmäßige FLAC-Abtastrate ({flac_eff_sr} Hz)",
                    description="Exotische Abtastraten außerhalb von 8–192 kHz Standardwerten können in Firefox Resampling-Fehler auslösen.",
                    recommended_fix="Mit „FLAC-Firefox-Konvertierung“ auf Standard-Abtastrate umrechnen.",
                    stage="fast",
                    fix_action="lossless_reencode",
                )
            )

        is_float_fmt = sample_fmt in ("flt", "fltp", "dbl", "dblp")
        if flac_eff_bps > 24 or is_float_fmt:
            flac_subset_valid = False
            fmt_note = f" · {sample_fmt}" if sample_fmt else ""
            findings.append(
                RepairFinding(
                    code="flac_firefox_bitdepth_too_high",
                    severity="critical" if is_float_fmt else "warning",
                    category="stream",
                    title=f"Bittiefe > 24-Bit ({flac_eff_bps}-Bit{fmt_note} — Firefox-inkompatibel)",
                    description="Firefox unterstützt im nativen FLAC-Dekoder max. 24-Bit-Integer-PCM. 32-Bit-Integer-FLAC ist zwar nach FLAC 1.4 gültig, wird aber von Firefox abgelehnt.",
                    recommended_fix="Nur bei Bedarf für Firefox-Wiedergabe „FLAC-Firefox-Konvertierung“ aktivieren (24-Bit/16-Bit Integer).",
                    auto_fixable=bool(is_float_fmt),
                    stage="fast",
                    fix_action="lossless_reencode",
                )
            )
        elif flac_eff_bps > 0 and flac_eff_bps not in (16, 24):
            findings.append(
                RepairFinding(
                    code="flac_firefox_nonstandard_bitdepth",
                    severity="warning",
                    category="stream",
                    title=f"Nicht standardmäßige FLAC-Bittiefe ({flac_eff_bps}-Bit)",
                    description=f"Firefox erwartet idealerweise 16-Bit oder 24-Bit statt {flac_eff_bps}-Bit.",
                    recommended_fix="Über 2-Schritt-WAV auf 16-Bit oder 24-Bit normieren.",
                    stage="fast",
                    fix_action="lossless_reencode",
                )
            )

        # Firefox-Kriterien: Kanäle (> 2 / Surround oder unübliche Zuordnung)
        if flac_eff_channels > 2:
            flac_subset_valid = False
            lay_note = f" · {channel_layout}" if channel_layout else ""
            findings.append(
                RepairFinding(
                    code="flac_firefox_multichannel",
                    severity="warning",
                    category="stream",
                    title=f"Mehrkanal-Audio ({flac_eff_channels} Kanäle{lay_note} — Firefox-inkompatibel)",
                    description="Die Mehrkanal-FLAC-Datei ist technisch gültig, aber Firefox gibt natives FLAC zuverlässig nur als Mono (1ch) oder Stereo (2ch) wieder.",
                    recommended_fix="Nur bei Bedarf für Firefox-Wiedergabe „FLAC-Firefox-Konvertierung“ aktivieren (Downmix auf Stereo).",
                    auto_fixable=False,
                    stage="fast",
                    fix_action="lossless_reencode",
                )
            )
        else:
            ch_mask_raw = raw_tags.get("waveformatextensible_channel_mask", "")
            unusual_mask = False
            if ch_mask_raw:
                try:
                    mval = int(ch_mask_raw, 16)
                    if (flac_eff_channels == 1 and mval != 0x4) or (flac_eff_channels == 2 and mval != 0x3):
                        unusual_mask = True
                except Exception:
                    unusual_mask = True
            unusual_layout = bool(channel_layout) and (
                (flac_eff_channels == 1 and channel_layout not in ("mono", "fc"))
                or (flac_eff_channels == 2 and channel_layout != "stereo")
            )
            if unusual_layout or unusual_mask:
                findings.append(
                    RepairFinding(
                        code="flac_firefox_unusual_channels",
                        severity="warning",
                        category="stream",
                        title=f"Unübliche Kanalzuordnung ({channel_layout or ch_mask_raw})",
                        description="Abweichende Kanalmasken oder -zuordnungen können im Firefox-FLAC-Demuxer Störungen verursachen.",
                        recommended_fix="Kanalzuordnung auf Standard Mono/Stereo bereinigen.",
                        stage="fast",
                        fix_action="lossless_reencode",
                    )
                )
    elif file_ext == ".m4a" or detected_magic == "m4a":
        m4a_moov_pos = _inspect_m4a_moov_atoms(buf)
        if m4a_moov_pos == "missing":
            seek_table_valid = False
            findings.append(
                RepairFinding(
                    code="m4a_missing_moov",
                    severity="critical",
                    category="header",
                    title="Fehlendes M4A-moov-Atom (Index fehlt)",
                    description="Im MP4/M4A-Container fehlt das zentrale moov-Metadaten- & Index-Atom.",
                    recommended_fix="Remuxing / Faststart durchführen oder Originaldatei prüfen.",
                    stage="fast",
                    fix_action="remux_faststart",
                )
            )
        elif m4a_moov_pos == "after_mdat":
            seek_table_valid = False
            findings.append(
                RepairFinding(
                    code="m4a_moov_after_mdat",
                    severity="warning",
                    category="header",
                    title="M4A-moov-Atom steht nach mdat (kein Faststart)",
                    description="Der Container-Index (moov) befindet sich am Dateiende nach mdat. Browser müssen erst die gesamte Datei laden.",
                    recommended_fix="Remuxing mit Faststart (-movflags +faststart) schiebt moov an den Anfang.",
                    stage="fast",
                    fix_action="remux_faststart",
                )
            )
        else:
            seek_table_valid = True
    elif file_ext in (".wav", ".aiff", ".aif", ".aifc") and len(buf) >= 12:
        magic = buf[:4]
        if magic == b"RIFF" and buf[8:12] == b"WAVE":
            decl = int.from_bytes(buf[4:8], "little") + 8
            if abs(decl - len(buf)) > 16:
                findings.append(
                    RepairFinding(
                        code="riff_size_mismatch",
                        severity="warning",
                        category="header",
                        title="WAV RIFF-Größenheader weicht von Dateigröße ab",
                        description=f"Header meldet {decl} Bytes, Datei ist {len(buf)} Bytes groß.",
                        recommended_fix="Container / Chunk-Größen per Remuxing verlustfrei neu schreiben.",
                        stage="fast",
                        fix_action="remux_faststart",
                    )
                )
        elif magic == b"FORM" and buf[8:12] in (b"AIFF", b"AIFC"):
            decl = int.from_bytes(buf[4:8], "big") + 8
            if abs(decl - len(buf)) > 16:
                findings.append(
                    RepairFinding(
                        code="aiff_size_mismatch",
                        severity="warning",
                        category="header",
                        title="AIFF FORM-Größenheader weicht von Dateigröße ab",
                        description=f"Header meldet {decl} Bytes, Datei ist {len(buf)} Bytes groß.",
                        recommended_fix="Container / Chunk-Größen per Remuxing verlustfrei neu schreiben.",
                        stage="fast",
                        fix_action="remux_faststart",
                    )
                )

    fast_duration_ms = max(1, round((time.monotonic() - fast_start) * 1000))
    # FFmpeg mp3-Demuxer überspringt ID3v1, aber KEINE gültigen APEv2/Lyrics3/TAG+-End-Tags
    # -> Bei solchen gültigen End-Tags nur den Audioteil bis audio_end an Stufe-2-FFmpeg übergeben!
    stage2_mp3_slice: Optional[bytes] = None
    if (
        deep_scan
        and (codec in ("mp3", "mp2") or file_ext in (".mp3", ".mp2"))
        and has_extra_trailer
        and 0 < audio_end < len(buf)
    ):
        stage2_mp3_slice = buf[:audio_end]
    # Rohdatei-Puffer vor Stufe-2-FFmpeg-Null-Decode freigeben, um Speicherverbrauch bei großen Beständen gering zu halten
    del buf

    # STUFE 2: DEEP-CHECK (Null-Decode auf Frame-CRC-Fehler, abgeschnittene Dateien, Seek-Integrität & MD5)
    decode_errs = 0
    stream_crc_errors = 0
    stream_truncated = False
    max_vol_db: Optional[float] = None
    mean_vol_db: Optional[float] = None
    deep_duration_ms = 0
    if deep_scan and shutil.which("ffmpeg"):
        deep_start = time.monotonic()
        if stage2_mp3_slice is not None:
            dec_raw = subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-v",
                    "error",
                    "-threads",
                    str(eff_threads),
                    "-filter_threads",
                    str(eff_threads),
                    "-err_detect",
                    "+crccheck+bitstream",
                    "-i",
                    "pipe:0",
                    "-map",
                    "0:a:0",
                    "-vn",
                    "-f",
                    "null",
                    "-",
                ],
                input=stage2_mp3_slice,
                capture_output=True,
                timeout=60,
            )
            stage2_mp3_slice = None
            dec_stderr = (dec_raw.stderr or b"").decode("utf-8", errors="replace")
        else:
            dec = subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-v",
                    "error",
                    "-threads",
                    str(eff_threads),
                    "-filter_threads",
                    str(eff_threads),
                    "-err_detect",
                    "+crccheck+bitstream",
                    "-i",
                    str(file_path),
                    "-map",
                    "0:a:0",
                    "-vn",
                    "-f",
                    "null",
                    "-",
                ],
                capture_output=True,
                text=True,
                timeout=60,
            )
            dec_stderr = dec.stderr or ""
        err_lines = [
            ln.strip()
            for ln in dec_stderr.splitlines()
            if ln.strip() and not ln.strip().startswith("Last message repeated")
        ]
        decode_errs = len(err_lines)
        crc_lines = [
            ln for ln in err_lines if re.search(r"\b(?:crc|checksum)\b|crc\s+mismatch", ln, re.I)
        ]
        trunc_lines = [
            ln
            for ln in err_lines
            if re.search(
                r"truncat|end of file|premature|unexpected eof|overread|incomplete|partial",
                ln,
                re.I,
            )
        ]
        stream_crc_errors = len(crc_lines)
        if trunc_lines:
            stream_truncated = True

        stream_fix_action = "lossless_reencode" if codec == "flac" else "remux_faststart"
        if stream_crc_errors > 0:
            findings.append(
                RepairFinding(
                    code="stream_crc_errors",
                    severity="critical",
                    category="stream",
                    title=f"{stream_crc_errors} Frame-CRC-Fehler beim Null-Decode erkannt",
                    description=" · ".join(crc_lines[:2])[:160],
                    recommended_fix=(
                        "Verlustfreies Re-Encoding über WAV (defekte Frames isolieren)."
                        if codec == "flac"
                        else "Stream neu muxen und beschädigte Frames überspringen."
                    ),
                    stage="deep",
                    fix_action=stream_fix_action,
                )
            )
        if stream_truncated:
            findings.append(
                RepairFinding(
                    code="stream_truncated_file",
                    severity="critical",
                    category="stream",
                    title="Abgeschnittener Audiostream / vorzeitiges Dateiende (EOF)",
                    description=" · ".join(trunc_lines[:2])[:160],
                    recommended_fix="Header-Längenangaben & Container durch Remuxing/Re-Encoding an reale Länge anpassen.",
                    stage="deep",
                    fix_action=stream_fix_action,
                )
            )
        other_errs = len(err_lines) - stream_crc_errors - len(trunc_lines)
        if other_errs > 0 or (decode_errs > 0 and stream_crc_errors == 0 and not stream_truncated):
            findings.append(
                RepairFinding(
                    code="ffmpeg_decode_errors",
                    severity="critical",
                    category="stream",
                    title=f"{decode_errs} Dekodierfehler im Audiostrom erkannt",
                    description=" · ".join(err_lines[:2])[:180],
                    recommended_fix="Defekte Frames entfernen und Stream/Container sauber neu aufbauen.",
                    stage="deep",
                    fix_action=stream_fix_action,
                )
            )

        # PCM-Audit (reale dekodierte Sample-Anzahl + MD5-Prüfung) — nur für natives FLAC erforderlich
        total_pcm_bytes = 0
        calc_md5_hex: Optional[str] = None
        bytes_per_sample_frame = max(
            1,
            (1 if flac_eff_bps <= 8 else (2 if flac_eff_bps <= 16 else (3 if flac_eff_bps <= 24 else 4)))
            * max(1, flac_eff_channels),
        )
        if (flac_si_md5_hex or flac_total_samples_hdr > 0) and not flac_is_ogg:
            pcm_out_fmt = (
                "s8"
                if flac_eff_bps <= 8
                else ("s16le" if flac_eff_bps <= 16 else ("s24le" if flac_eff_bps <= 24 else "s32le"))
            )
            try:
                md5_proc = subprocess.Popen(
                    [
                        "ffmpeg", "-hide_banner", "-loglevel", "error",
                        "-threads", str(eff_threads), "-filter_threads", str(eff_threads),
                        "-i", str(file_path), "-map", "0:a:0", "-vn", "-f", pcm_out_fmt, "-",
                    ],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                )
                hasher = hashlib.md5()
                assert md5_proc.stdout is not None
                while True:
                    chunk = md5_proc.stdout.read(65536)
                    if not chunk:
                        break
                    total_pcm_bytes += len(chunk)
                    hasher.update(chunk)
                rc_md5 = md5_proc.wait(timeout=45)
                if rc_md5 == 0 and total_pcm_bytes > 0:
                    calc_md5_hex = hasher.hexdigest().lower()
            except Exception:
                pass

        actual_decoded_samples = total_pcm_bytes // bytes_per_sample_frame
        if (
            not stream_truncated
            and flac_total_samples_hdr > 0
            and actual_decoded_samples > 0
            and (flac_total_samples_hdr - actual_decoded_samples)
            > max(flac_eff_sr, round(flac_total_samples_hdr * 0.03))
        ):
            stream_truncated = True
            findings.append(
                RepairFinding(
                    code="stream_truncated_file",
                    severity="critical",
                    category="stream",
                    title="Abgeschnittene FLAC-Datei (real weniger Samples als in STREAMINFO)",
                    description=f"STREAMINFO erwartet {flac_total_samples_hdr} Samples, Null-Decode lieferte {actual_decoded_samples}.",
                    recommended_fix="Verlustfreies Re-Encoding schreibt STREAMINFO & SEEKTABLE passend zur realen Länge.",
                    stage="deep",
                    fix_action="lossless_reencode",
                )
            )
        elif (
            not stream_truncated
            and has_xing
            and xing_frames > 20
            and actual_frames > 0
            and (xing_frames - actual_frames) > max(10, round(xing_frames * 0.05))
        ):
            stream_truncated = True
            findings.append(
                RepairFinding(
                    code="stream_truncated_file",
                    severity="critical",
                    category="stream",
                    title="Abgeschnittene MP3-Datei (fehlen Frames gegenüber Xing-Header)",
                    description=f"Xing-Header deklariert {xing_frames} Frames, im Stream sind nur {actual_frames} Frames.",
                    recommended_fix="VBR-Header-Rebuild korrigiert den Xing-Header auf die vorhandene Frame-Anzahl.",
                    stage="deep",
                    fix_action="vbr_header_rebuild",
                )
            )

        # Echte PCM-MD5-Verifikation gegen STREAMINFO bei nativem FLAC
        if flac_si_md5_hex and not flac_is_ogg and calc_md5_hex:
            if calc_md5_hex == flac_si_md5_hex.lower():
                flac_md5_valid = True
                flac_md5_status = "valid"
            else:
                flac_md5_valid = False
                flac_md5_status = "mismatch"
                findings.append(
                    RepairFinding(
                        code="flac_invalid_md5",
                        severity="critical",
                        category="header",
                        title="Ungültige FLAC-MD5-Signatur (Prüfsummen-Fehler)",
                        description=(
                            f"STREAMINFO-MD5 ({flac_si_md5_hex[:12]}…) stimmt nicht mit dem dekodierten Audio-PCM ({calc_md5_hex[:12]}…) überein."
                        ),
                        recommended_fix="Verlustfreies Re-Encoding über 2-Schritt-WAV berechnet eine gültige MD5-Signatur.",
                        stage="deep",
                        fix_action="lossless_reencode",
                    )
                )

        vol = subprocess.run(
            [
                "ffmpeg", "-hide_banner",
                "-threads", str(eff_threads), "-filter_threads", str(eff_threads),
                "-i", str(file_path), "-af", "volumedetect", "-f", "null", "-",
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        m_max = re.search(r"max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB", vol.stderr or "", re.I)
        m_mean = re.search(r"mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB", vol.stderr or "", re.I)
        if m_max:
            max_vol_db = float(m_max.group(1))
        if m_mean:
            mean_vol_db = float(m_mean.group(1))
        if mean_vol_db is not None and mean_vol_db <= -70.0:
            findings.append(
                RepairFinding(
                    code="audio_silence",
                    severity="warning",
                    category="audio",
                    title=f"Extrem niedriger Pegel / Stille (Ø {mean_vol_db:.1f} dB)",
                    description="Spur enthält fast nur Stille.",
                    recommended_fix="Datei manuell prüfen.",
                    auto_fixable=False,
                    stage="deep",
                )
            )
        deep_duration_ms = max(1, round((time.monotonic() - deep_start) * 1000))

    if codec == "flac" or file_ext == ".flac" or "flac" in container:
        has_ff_crit = any(
            (
                f.severity == "critical"
                and (
                    f.code.startswith("flac_")
                    or f.code in ("ffmpeg_decode_errors", "stream_crc_errors", "stream_truncated_file")
                )
            )
            or f.code in (
                "flac_firefox_samplerate_too_high",
                "flac_firefox_bitdepth_too_high",
                "flac_firefox_multichannel",
            )
            for f in findings
        )
        has_ff_warn = any(
            f.severity == "warning" and f.code.startswith("flac_") for f in findings
        )
        flac_firefox_compat = (
            "incompatible" if has_ff_crit else ("warning" if has_ff_warn else "compatible")
        )

    fix_action_order = (
        "header_strip",
        "vbr_header_rebuild",
        "remux_faststart",
        "cover_optimize",
        "lossless_reencode",
    )
    rec_fixes_set = {f.fix_action for f in findings if f.auto_fixable and f.fix_action}
    recommended_fixes = [act for act in fix_action_order if act in rec_fixes_set]

    fast_issues = [f for f in findings if f.stage == "fast" and f.severity != "info"]
    deep_integrity_issues = [
        f
        for f in findings
        if f.stage == "deep"
        and f.severity != "info"
        and f.code != "audio_silence"
    ]
    stage2_failure_reasons: list[str] = []
    if stream_crc_errors > 0:
        stage2_failure_reasons.append(f"CRC:{stream_crc_errors}")
    if stream_truncated:
        stage2_failure_reasons.append("Trunc:Ja")
    if any(f.code == "flac_invalid_md5" for f in findings):
        stage2_failure_reasons.append("MD5-Fehler")
    if any(f.code == "ffmpeg_decode_errors" for f in findings):
        stage2_failure_reasons.append(f"Decode-Fehler:{decode_errs}")
    if any(f.code == "audio_silence" for f in findings):
        stage2_failure_reasons.append("Stille")

    pipeline_report = RepairPipelineReport(
        stage1_fast_check=RepairStage1Report(
            passed=len(fast_issues) == 0,
            duration_ms=fast_duration_ms,
            issue_count=len(fast_issues),
            checks_performed=[
                "Magic-Bytes vs. Dateiendung",
                "ID3v2/ID3v1/APEv2-Kette",
                "M4A moov-Position",
                "MP3 Xing/VBR-Header",
                "FLAC STREAMINFO & Subset-Regeln",
                "Cover-Art MIME & Größe",
            ],
        ),
        stage2_deep_check=RepairStage2Report(
            executed=deep_scan,
            passed=(len(deep_integrity_issues) == 0) if deep_scan else None,
            duration_ms=deep_duration_ms,
            crc_error_count=stream_crc_errors,
            truncated_detected=stream_truncated,
            seek_table_valid=seek_table_valid,
            failure_reasons=stage2_failure_reasons,
        ),
        recommended_fixes=recommended_fixes,
    )

    has_crit = any(f.severity == "critical" for f in findings)
    has_warn = any(f.severity == "warning" for f in findings)
    health = "critical" if has_crit else ("warning" if has_warn else "ok")

    struct = RepairStructure(
        codec=codec,
        container=container,
        detected_magic=detected_magic,
        magic_matches_extension=magic_matches_extension,
        m4a_moov_position=m4a_moov_pos,
        sample_rate=flac_eff_sr,
        channels=flac_eff_channels,
        bits_per_sample=flac_eff_bps,
        sample_fmt=sample_fmt,
        channel_layout=channel_layout,
        bitrate_kbps=bitrate_kbps,
        duration_seconds=duration_seconds,
        is_vbr=is_vbr,
        has_xing_header=has_xing,
        xing_frames=xing_frames,
        actual_frames=actual_frames,
        id3v2_count=id3v2_count,
        id3v2_versions=id3v2_versions,
        has_id3v1=has_id3v1,
        has_apev2=has_apev2,
        leading_garbage_bytes=leading_garbage,
        trailing_garbage_bytes=trailing_garbage,
        corrupt_sync_gaps=corrupt_gaps,
        flac_md5_valid=flac_md5_valid,
        flac_md5_status=flac_md5_status,
        flac_has_seektable=flac_has_seektable,
        seek_table_valid=seek_table_valid,
        flac_is_ogg=flac_is_ogg,
        flac_streaminfo_valid=flac_streaminfo_valid,
        flac_subset_valid=flac_subset_valid,
        flac_min_block_size=flac_min_bs,
        flac_max_block_size=flac_max_bs,
        flac_variable_block_size=flac_var_bs,
        flac_firefox_compatible=flac_firefox_compat,
        max_volume_db=max_vol_db,
        mean_volume_db=mean_vol_db,
        decode_error_count=decode_errs,
        stream_crc_errors=stream_crc_errors,
        stream_truncated=stream_truncated,
        has_cover_art=has_cover_art,
        cover_art_mime=cover_art_mime,
        cover_art_bytes=cover_art_bytes,
        cover_art_width=cover_art_width,
        cover_art_height=cover_art_height,
        missing_core_tags=missing_tags,
        error_positions=_build_repair_error_positions(
            findings=findings,
            duration_seconds=duration_seconds,
            sync_gap_ratios=sync_gap_ratios,
            mixed_sr_ratios=mixed_sr_ratios,
            leading_garbage=leading_garbage,
            trailing_garbage=trailing_garbage,
            stream_truncated=stream_truncated,
        ),
        pipeline=pipeline_report,
    )
    return health, findings, struct


def _parse_flac_metadata_layout(
    buf: bytes,
) -> Optional[tuple[bytes, list[tuple[int, bytes]], int]]:
    if len(buf) < 42 or buf[:4] != b"fLaC":
        return None
    off = 4
    streaminfo_payload: Optional[bytes] = None
    other_blocks: list[tuple[int, bytes]] = []
    while off + 4 <= len(buf):
        hdr0 = buf[off]
        is_last = (hdr0 & 0x80) != 0
        btype = hdr0 & 0x7F
        blen = (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]
        data_start = off + 4
        data_end = data_start + blen
        if data_end > len(buf):
            return None
        payload = buf[data_start:data_end]
        if btype == 0 and streaminfo_payload is None and len(payload) == 34:
            streaminfo_payload = payload
        elif btype != 3:
            other_blocks.append((btype, payload))
        off = data_end
        if is_last:
            break
    if streaminfo_payload is None or off >= len(buf):
        return None
    return streaminfo_payload, other_blocks, off


def _write_flac_with_blocks(
    flac_path: Path,
    streaminfo_payload: bytes,
    extra_blocks: list[tuple[int, bytes]],
    audio_tail: bytes,
) -> None:
    blocks = [(0, streaminfo_payload), *extra_blocks]
    out = bytearray(b"fLaC")
    last_idx = len(blocks) - 1
    for idx, (btype, payload) in enumerate(blocks):
        is_last = 0x80 if idx == last_idx else 0x00
        blen = len(payload)
        out.append(is_last | (btype & 0x7F))
        out.append((blen >> 16) & 0xFF)
        out.append((blen >> 8) & 0xFF)
        out.append(blen & 0xFF)
        out.extend(payload)
    out.extend(audio_tail)
    flac_path.write_bytes(bytes(out))


def strip_flac_seektable(flac_path: Path) -> bool:
    if not flac_path.exists():
        return False
    orig_buf = flac_path.read_bytes()
    parsed = _parse_flac_metadata_layout(orig_buf)
    if parsed is None:
        return False
    streaminfo_payload, other_blocks, old_first_audio = parsed
    _write_flac_with_blocks(flac_path, streaminfo_payload, other_blocks, orig_buf[old_first_audio:])
    return True


def insert_flac_seektable(flac_path: Path, fallback_sr: int = 44100) -> int:
    if not flac_path.exists():
        return 0
    orig_buf = flac_path.read_bytes()
    parsed = _parse_flac_metadata_layout(orig_buf)
    if parsed is None:
        return 0
    streaminfo_payload, other_blocks, old_first_audio = parsed
    stream_bytes = len(orig_buf) - old_first_audio
    if stream_bytes <= 0:
        return 0

    si_sr = (
        (streaminfo_payload[10] << 12)
        | (streaminfo_payload[11] << 4)
        | ((streaminfo_payload[12] >> 4) & 0x0F)
    )
    eff_sr = si_sr if si_sr > 0 else max(8000, int(fallback_sr or 44100))
    total_samples_hdr = ((streaminfo_payload[13] & 0x0F) << 32) | int.from_bytes(
        streaminfo_payload[14:18], "big"
    )

    ffprobe_bin = shutil.which("ffprobe")
    if not ffprobe_bin:
        return 0
    try:
        proc = subprocess.run(
            [
                ffprobe_bin,
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "packet=pos,pts,duration",
                "-of",
                "json",
                str(flac_path),
            ],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if proc.returncode != 0:
            return 0
        packets = json.loads(proc.stdout or "{}").get("packets") or []
    except Exception:
        return 0
    if not packets:
        return 0

    step_samples = max(1, eff_sr * 10)
    next_target = 0
    prev_sample = -1
    prev_rel_off = -1
    points: list[tuple[int, int, int]] = []
    for pkt in packets:
        pos_raw = pkt.get("pos")
        pts_raw = pkt.get("pts")
        if pos_raw is None or pts_raw is None:
            continue
        try:
            abs_pos = int(pos_raw)
            sample = max(0, int(pts_raw))
            frame_samples = max(0, min(0xFFFF, int(pkt.get("duration") or 0)))
        except Exception:
            continue
        if abs_pos < old_first_audio or abs_pos + 2 > len(orig_buf):
            continue
        # Echten FLAC-Frame-Sync-Code (0xFFF8 / 0xFFF9) verifizieren
        if orig_buf[abs_pos] != 0xFF or (orig_buf[abs_pos + 1] & 0xFE) != 0xF8:
            continue
        if frame_samples <= 0:
            continue
        rel_off = abs_pos - old_first_audio
        if rel_off >= stream_bytes:
            continue
        if total_samples_hdr > 0 and sample >= total_samples_hdr:
            continue
        if sample < next_target and points:
            continue
        if sample <= prev_sample or rel_off < prev_rel_off:
            continue
        points.append((sample, rel_off, frame_samples))
        prev_sample = sample
        prev_rel_off = rel_off
        next_target = sample + step_samples
        if len(points) * 18 >= 15_000_000:
            break

    if not points:
        return 0

    seek_payload = bytearray()
    for sample, rel_off, frame_samples in points:
        seek_payload.extend(sample.to_bytes(8, "big"))
        seek_payload.extend(rel_off.to_bytes(8, "big"))
        seek_payload.extend(frame_samples.to_bytes(2, "big"))

    _write_flac_with_blocks(
        flac_path,
        streaminfo_payload,
        [(3, bytes(seek_payload)), *other_blocks],
        orig_buf[old_first_audio:],
    )
    return len(points)


class RepairManager:
    """Threadpool-basierte Diagnose & Reparatur für Modul 5 unter GTK 3.0."""

    def __init__(self, max_workers: Optional[int] = None) -> None:
        self._max_workers = max(1, min(16, int(max_workers) if max_workers is not None else 4))
        self._executor: Optional[ThreadPoolExecutor] = None
        self._cancel_event = threading.Event()
        self._running_procs: set[subprocess.Popen] = set()
        self._proc_lock = threading.Lock()
        self.jobs: list[RepairJob] = []
        self.on_job_updated: Optional[Callable[[RepairJob], None]] = None
        self.on_all_finished: Optional[Callable[[str, bool], None]] = None
        self.on_log: Optional[Callable[[str], None]] = None
        self.cover_max_dimension: int = 2048
        self._active_futures = 0
        self._count_lock = threading.Lock()
        self._queue_lock = threading.Lock()
        self._cover_write_lock = threading.Lock()
        self._scan_queue: deque[RepairJob] = deque()
        self._repair_queue: deque[RepairJob] = deque()
        self._loading_active = False

    def set_max_workers(self, max_workers: int) -> None:
        self._max_workers = max(1, min(16, int(max_workers or 4)))

    def set_loading(self, active: bool) -> None:
        self._loading_active = bool(active)

    def is_loading(self) -> bool:
        return self._loading_active

    def build_jobs_for_paths(
        self,
        paths: list[Path],
        cancel_event: Optional[threading.Event] = None,
        on_progress: Optional[Callable[[int], None]] = None,
    ) -> list[RepairJob]:
        """Lädt und bereitet alle Diagnose-Jobs off-thread vor, ohne bereits eine Analyse zu starten."""
        existing = set()
        for j in list(self.jobs):
            try:
                if j.source_path.exists():
                    existing.add(j.source_path.resolve())
            except Exception:
                pass
        prepared: list[RepairJob] = []
        for abs_path, rel_path in collect_audio_files_for_repair(
            paths, cancel_event=cancel_event, on_progress=on_progress
        ):
            if cancel_event is not None and cancel_event.is_set():
                break
            try:
                res = abs_path.resolve()
                if res in existing:
                    continue
                existing.add(res)
                sz = abs_path.stat().st_size if abs_path.exists() else 0
            except Exception:
                continue
            prepared.append(
                RepairJob(
                    source_path=abs_path,
                    relative_path=rel_path,
                    source_ext=abs_path.suffix.lstrip(".").upper() or "AUDIO",
                    size_bytes=sz,
                    health="pending",
                    status_message="Geladen · Wartet auf Diagnose...",
                )
            )
        return prepared

    def commit_loaded_jobs(self, prepared_jobs: list[RepairJob]) -> list[RepairJob]:
        """Übernimmt vollständig geladene Jobs atomar in die Liste (ohne Duplikate)."""
        existing = set()
        for j in self.jobs:
            try:
                if j.source_path.exists():
                    existing.add(j.source_path.resolve())
            except Exception:
                pass
        committed: list[RepairJob] = []
        for job in prepared_jobs:
            try:
                res = job.source_path.resolve()
            except Exception:
                continue
            if res in existing:
                continue
            existing.add(res)
            self.jobs.append(job)
            committed.append(job)
        return committed

    def add_paths(self, paths: list[Path]) -> list[RepairJob]:
        prepared = self.build_jobs_for_paths(paths)
        return self.commit_loaded_jobs(prepared)

    def _shutdown_executor_if_any(self) -> None:
        if self._executor is not None:
            try:
                self._executor.shutdown(wait=False, cancel_futures=True)
            except Exception:
                pass
            self._executor = None

    def start_scan(
        self,
        jobs: list[RepairJob],
        deep_scan: bool,
        cover_max_dimension: Optional[int] = None,
        max_workers: Optional[int] = None,
    ) -> int:
        if self._loading_active:
            return 0
        if not jobs:
            return 0
        if max_workers is not None:
            self.set_max_workers(max_workers)
        if cover_max_dimension is not None:
            self.cover_max_dimension = max(256, min(8192, int(cover_max_dimension)))
        eff_cover_max_dim = self.cover_max_dimension
        self._cancel_event.clear()
        self._shutdown_executor_if_any()
        snapshot = list(jobs)
        for job in snapshot:
            job.selected = False
            job.health = "pending"
            job.progress = 0.0
            job.status_message = "In Diagnose-Warteschlange..."
        with self._queue_lock:
            self._scan_queue = deque(snapshot)
        worker_count = max(1, min(self._max_workers, len(snapshot)))
        ff_threads = max(1, self._max_workers // worker_count)
        with self._count_lock:
            self._active_futures = len(snapshot)
        self._executor = ThreadPoolExecutor(max_workers=worker_count)
        for _ in range(worker_count):
            self._executor.submit(
                self._scan_worker_loop, deep_scan, eff_cover_max_dim, ff_threads
            )
        return len(snapshot)

    def start_repair(
        self, options: RepairOptions, max_workers: Optional[int] = None
    ) -> int:
        if self._loading_active:
            return 0
        selected = [j for j in self.jobs if j.selected]
        if not selected:
            return 0
        if not shutil.which("ffmpeg"):
            raise RuntimeError("ffmpeg nicht gefunden (sudo apt install ffmpeg).")
        if max_workers is not None:
            self.set_max_workers(max_workers)
        self._cancel_event.clear()
        self._shutdown_executor_if_any()
        worker_count = max(1, min(self._max_workers, len(selected)))
        ff_threads = max(1, self._max_workers // worker_count)
        for job in selected:
            job.progress = 0.05
            job.status_message = "In Reparatur-Warteschlange..."
        with self._queue_lock:
            self._repair_queue = deque(selected)
        with self._count_lock:
            self._active_futures = len(selected)
        self._executor = ThreadPoolExecutor(max_workers=worker_count)
        for _ in range(worker_count):
            self._executor.submit(self._repair_worker_loop, options, ff_threads)
        return len(selected)

    def _repair_worker_loop(self, options: RepairOptions, ffmpeg_threads: int = 1) -> None:
        while True:
            if self._cancel_event.is_set():
                with self._queue_lock:
                    rem = list(self._repair_queue)
                    self._repair_queue.clear()
                for skipped in rem:
                    skipped.status_message = "Abgebrochen"
                    self._finish_one("repair")
                return
            with self._queue_lock:
                if not self._repair_queue:
                    return
                job = self._repair_queue.popleft()
            self._run_repair_job(job, options, ffmpeg_threads=ffmpeg_threads)

    def cancel_all(self) -> None:
        self._cancel_event.set()
        with self._queue_lock:
            self._scan_queue.clear()
            self._repair_queue.clear()
        with self._proc_lock:
            for p in list(self._running_procs):
                try:
                    p.terminate()
                except Exception:
                    pass
        self._shutdown_executor_if_any()

    def clear_all(self) -> None:
        self.cancel_all()
        self.jobs.clear()

    def _emit_update(self, job: RepairJob) -> None:
        if self.on_job_updated:
            self.on_job_updated(job)

    def _emit_log(self, msg: str) -> None:
        if self.on_log:
            self.on_log(msg)

    def _run_cmd(self, cmd: list[str]) -> tuple[int, str]:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        with self._proc_lock:
            self._running_procs.add(proc)
        try:
            _out, err = proc.communicate()
            return proc.returncode, err or ""
        finally:
            with self._proc_lock:
                self._running_procs.discard(proc)

    def _finish_one(self, mode: str) -> None:
        finished_all = False
        with self._count_lock:
            self._active_futures -= 1
            if self._active_futures <= 0:
                self._active_futures = 0
                finished_all = True
        if finished_all and self.on_all_finished:
            self.on_all_finished(mode, self._cancel_event.is_set())

    def _scan_worker_loop(
        self, deep_scan: bool, cover_max_dimension: int, ffmpeg_threads: int = 1
    ) -> None:
        while True:
            if self._cancel_event.is_set():
                with self._queue_lock:
                    rem = list(self._scan_queue)
                    self._scan_queue.clear()
                for skipped in rem:
                    skipped.status_message = "Diagnose abgebrochen"
                    self._finish_one("scan")
                return
            with self._queue_lock:
                if not self._scan_queue:
                    return
                job = self._scan_queue.popleft()
            self._run_scan_job(
                job,
                deep_scan,
                cover_max_dimension=cover_max_dimension,
                ffmpeg_threads=ffmpeg_threads,
            )

    def _run_scan_job(
        self,
        job: RepairJob,
        deep_scan: bool,
        cover_max_dimension: int = 2048,
        ffmpeg_threads: int = 1,
    ) -> None:
        try:
            if self._cancel_event.is_set():
                job.status_message = "Diagnose abgebrochen"
                self._emit_update(job)
                return
            job.selected = False
            job.health = "scanning"
            job.progress = 0.15
            job.status_message = "Tiefendiagnose läuft..." if deep_scan else "Header-Prüfung läuft..."
            self._emit_update(job)
            scan_path = (
                job.output_path
                if (job.output_path is not None and job.output_path.exists())
                else job.source_path
            )
            health, findings, struct = analyze_audio_file_for_repair(
                scan_path,
                deep_scan,
                cover_max_dimension=cover_max_dimension,
                ffmpeg_threads=ffmpeg_threads,
            )
            job.selected = False
            job.health = health
            job.findings = findings
            job.structure = struct
            job.pipeline = struct.pipeline
            job.progress = 1.0
            issue_cnt = sum(1 for f in findings if f.severity != "info")
            info_cnt = sum(1 for f in findings if f.severity == "info")
            if health == "ok":
                job.status_message = (
                    f"Technisch OK ({info_cnt} Hinweis)" if info_cnt else "Fehlerfrei · Beide Stufen OK"
                )
            elif health == "warning":
                job.status_message = f"{issue_cnt} Warnung(en)"
            else:
                job.status_message = f"{issue_cnt} Problem(e) · Auto-Repair verfügbar"
            self._emit_update(job)
        except Exception as exc:
            job.health = "error"
            job.progress = 0.0
            job.status_message = f"Analysefehler: {exc}"
            self._emit_update(job)
        finally:
            self._finish_one("scan")

    def _run_repair_job(
        self, job: RepairJob, options: RepairOptions, ffmpeg_threads: int = 1
    ) -> None:
        try:
            if self._cancel_event.is_set():
                job.status_message = "Abgebrochen"
                self._emit_update(job)
                return

            eff_threads = max(1, min(16, int(ffmpeg_threads or 1)))
            max_cover_dim = max(
                256,
                min(
                    8192,
                    int(round(float(getattr(options, "cover_max_dimension", self.cover_max_dimension) or 2048))),
                ),
            )
            if job.structure is None:
                pre_health, pre_findings, pre_struct = analyze_audio_file_for_repair(
                    job.source_path,
                    options.deep_scan,
                    cover_max_dimension=max_cover_dim,
                    ffmpeg_threads=eff_threads,
                )
            else:
                pre_health, pre_findings, pre_struct = job.health, job.findings, job.structure
            job.before_finding_count = len(pre_findings)
            step_logs: list[tuple[str, str, str]] = []
            mode_label = "Auto-Repair" if options.auto_repair else "Manuelle Pipeline"
            step_logs.append((
                "Vorab-Analyse",
                "OK" if (pre_health == "ok" and len(pre_findings) == 0) else "HINWEIS",
                f"{mode_label} · Befunde: {len(pre_findings)} · Basis-Status: {pre_health}",
            ))

            rec_set = set(pre_struct.pipeline.recommended_fixes) if pre_struct.pipeline else set()
            if pre_struct.has_cover_art and (
                pre_struct.cover_art_width > max_cover_dim
                or pre_struct.cover_art_height > max_cover_dim
                or pre_struct.cover_art_bytes > 1024 * 1024
            ):
                rec_set.add("cover_optimize")
            if options.auto_repair:
                do_header_strip = "header_strip" in rec_set
                do_vbr_rebuild = "vbr_header_rebuild" in rec_set
                do_remux_faststart = "remux_faststart" in rec_set
                do_cover_optimize = ("cover_optimize" in rec_set) and pre_struct.has_cover_art
                do_lossless_reencode = "lossless_reencode" in rec_set
            else:
                do_header_strip = options.clean_tags or options.strip_garbage_frames
                do_vbr_rebuild = options.fix_vbr_xing
                do_remux_faststart = options.rebuild_container
                do_cover_optimize = options.optimize_cover and pre_struct.has_cover_art
                do_lossless_reencode = options.rebuild_container or options.firefox_compat
            has_stream_errors = (
                (pre_struct.decode_error_count > 0)
                or (pre_struct.stream_crc_errors > 0)
                or bool(pre_struct.stream_truncated)
            )
            write_flac_seektable = bool(getattr(options, "write_flac_seektable", True))
            other_flac_remux_reasons = (
                any(
                    f.fix_action == "remux_faststart" and f.code != "flac_no_seektable"
                    for f in pre_findings
                )
                or (not options.auto_repair)
            )

            ext = job.source_path.suffix.lower()
            target_path = job.compute_target_path(options.output_dir, options.in_place_backup)
            target_path.parent.mkdir(parents=True, exist_ok=True)

            job.progress = 0.25
            job.status_message = (
                "Auto-Repair nach Fehlerklassen läuft..."
                if options.auto_repair
                else "Repariere Header & Container..."
            )
            self._emit_update(job)

            with tempfile.TemporaryDirectory(prefix="mintrip-repair-") as tmp_str:
                tmp_dir = Path(tmp_str)
                tmp_out = tmp_dir / f"repaired{ext}"
                src_path = job.source_path

                optimized_cover_path: Optional[Path] = None
                if do_cover_optimize:
                    cand_cov = tmp_dir / "cover_opt.jpg"
                    cov_w = pre_struct.cover_art_width or 0
                    cov_h = pre_struct.cover_art_height or 0
                    needs_scale_down = cov_w > max_cover_dim or cov_h > max_cover_dim
                    opt_size_kb = 0
                    for q_val in (3, 5, 7, 9, 12, 16, 22, 28):
                        cov_cmd = [
                            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                            "-threads", str(eff_threads), "-filter_threads", str(eff_threads),
                            "-i", str(src_path), "-map", "0:v:0",
                        ]
                        if needs_scale_down:
                            cov_cmd.extend([
                                "-vf",
                                f"scale='min({max_cover_dim},iw)':'min({max_cover_dim},ih)':force_original_aspect_ratio=decrease",
                            ])
                        cov_cmd.extend([
                            "-vframes", "1", "-pix_fmt", "yuvj420p", "-q:v", str(q_val),
                            "-threads", str(eff_threads), str(cand_cov)
                        ])
                        rc_cov, _err_cov = self._run_cmd(cov_cmd)
                        if rc_cov == 0 and cand_cov.exists():
                            cov_sz = cand_cov.stat().st_size
                            if cov_sz > 64:
                                optimized_cover_path = cand_cov
                                opt_size_kb = round(cov_sz / 1024)
                                if cov_sz <= 1024 * 1024:
                                    break
                    if optimized_cover_path is not None:
                        orig_kb = round((pre_struct.cover_art_bytes or 0) / 1024)
                        step_logs.append((
                            "Cover-Optimierung",
                            "OK",
                            (
                                f"{cov_w}×{cov_h} px ({orig_kb} KB) → max. {max_cover_dim}×{max_cover_dim} px ({opt_size_kb} KB)"
                                if needs_scale_down
                                else f"Pixelmaße {cov_w}×{cov_h} px erhalten · {orig_kb} KB → {opt_size_kb} KB"
                            ),
                        ))
                    else:
                        step_logs.append((
                            "Cover-Optimierung",
                            "HINWEIS",
                            "Kein optimiertes Cover erzeugt — Original-Cover beibehalten",
                        ))

                eff_fmt_mismatch = not pre_struct.magic_matches_extension

                if ext == ".flac":
                    if (
                        eff_fmt_mismatch
                        or do_lossless_reencode
                        or options.firefox_compat
                        or (optimized_cover_path is not None)
                    ):
                        mid_wav = tmp_dir / "repair_mid.wav"
                        pcm_fmt, orig_sr = probe_audio_pcm_params(src_path)
                        target_sr = orig_sr or pre_struct.sample_rate or 44100
                        std_srs = {
                            8000, 11025, 12000, 16000, 22050, 24000,
                            32000, 44100, 48000, 88200, 96000, 176400, 192000,
                        }
                        # Surround-Downmix oder Sample-Rate-Reduktion NUR bei explizit aktivierter Firefox-Kompatibilität
                        needs_ff_params = bool(options.firefox_compat)
                        if needs_ff_params:
                            while target_sr > 192000:
                                target_sr = max(44100, round(target_sr / 2))
                            if target_sr not in std_srs:
                                pool = (44100, 48000, 88200, 96000, 176400, 192000)
                                target_sr = min(pool, key=lambda c: abs(c - target_sr))
                        s1 = [
                            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                            "-threads", str(eff_threads), "-filter_threads", str(eff_threads),
                            "-err_detect", "ignore_err", "-i", str(src_path),
                            "-map", "0:a:0", "-vn", "-map_metadata", "-1",
                        ]
                        if needs_ff_params and (
                            pre_struct.channels > 2
                            or (pre_struct.channel_layout and pre_struct.channel_layout not in ("mono", "stereo"))
                        ):
                            s1.extend(["-ac", "1" if pre_struct.channels == 1 else "2"])
                        if needs_ff_params and target_sr != orig_sr:
                            s1.extend(["-ar", str(target_sr)])
                        s1.extend(["-c:a", pcm_fmt, "-rf64", "auto", "-threads", str(eff_threads), str(mid_wav)])
                        rc, err = self._run_cmd(s1)
                        if rc != 0:
                            raise RuntimeError(err.strip() or "FLAC-WAV-Reparatur fehlgeschlagen")

                        job.progress = 0.65
                        self._emit_update(job)

                        can_use_flac_cli = (
                            shutil.which("flac")
                            and optimized_cover_path is None
                            and not pre_struct.flac_is_ogg
                            and pre_struct.id3v2_count == 0
                            and pre_struct.flac_streaminfo_valid
                            and mid_wav.stat().st_size < (3_900_000_000)
                        )
                        if can_use_flac_cli:
                            rc2, err2 = self._run_cmd([
                                "flac", "-s", "-f", "-6", str(mid_wav), "-o", str(tmp_out)
                            ])
                            if rc2 != 0:
                                raise RuntimeError(err2.strip() or "FLAC-Kodierung fehlgeschlagen")
                            copy_tags_and_cover_to_flac(src_path, tmp_out)
                        else:
                            if optimized_cover_path is not None:
                                s2 = [
                                    "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                                    "-threads", str(eff_threads), "-filter_threads", str(eff_threads),
                                    "-i", str(mid_wav), "-i", str(src_path), "-i", str(optimized_cover_path),
                                    "-map", "0:a:0", "-map", "2:v:0", "-c:v", "copy",
                                    "-disposition:v:0", "attached_pic",
                                    "-map_metadata", "1", "-map_metadata", "1:s:a:0",
                                    "-c:a", "flac", "-compression_level", "6",
                                    "-threads", str(eff_threads), str(tmp_out),
                                ]
                            else:
                                s2 = [
                                    "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                                    "-threads", str(eff_threads), "-filter_threads", str(eff_threads),
                                    "-i", str(mid_wav), "-i", str(src_path),
                                    "-map", "0:a:0", "-map", "1:v?", "-c:v", "copy",
                                    "-map_metadata", "1", "-map_metadata", "1:s:a:0",
                                    "-c:a", "flac", "-compression_level", "6",
                                    "-threads", str(eff_threads), str(tmp_out),
                                ]
                            rc2, err2 = self._run_cmd(s2)
                            if rc2 != 0:
                                raise RuntimeError(err2.strip() or "FLAC-Header-Neuaufbau fehlgeschlagen")
                        step_logs.append((
                            "FLAC 2-Schritt-Neuaufbau",
                            "OK",
                            f"PCM WAV → natives fLaC ({target_sr} Hz, {pre_struct.bits_per_sample}-Bit, MD5 & STREAMINFO erneuert)",
                        ))
                        if needs_ff_params:
                            step_logs.append((
                                "Firefox-FLAC-Anpassung",
                                "OK",
                                f"{orig_sr} Hz / {pre_struct.channels}ch → {target_sr} Hz / {1 if pre_struct.channels == 1 else 2}ch",
                            ))
                        if write_flac_seektable:
                            sp_count = insert_flac_seektable(tmp_out, target_sr)
                            step_logs.append((
                                "FLAC-Seektable",
                                "OK" if sp_count > 0 else "HINWEIS",
                                f"{sp_count} Seekpoint(s) (10s) geschrieben" if sp_count > 0 else "Seektable konnte nicht ergänzt werden",
                            ))
                        else:
                            strip_flac_seektable(tmp_out)
                            step_logs.append((
                                "FLAC-Seektable",
                                "ÜBERSPRUNGEN",
                                "Durch Benutzeroption deaktiviert",
                            ))
                    elif (
                        do_header_strip
                        or (do_remux_faststart and (other_flac_remux_reasons or write_flac_seektable))
                        or ((not options.auto_repair) and write_flac_seektable)
                    ):
                        if pre_struct.id3v2_count > 0 or (other_flac_remux_reasons and (do_header_strip or do_remux_faststart)):
                            # Verlustfreier FLAC-Remux über FFmpeg: entfernt illegale ID3v2-Präfixe sicher
                            # und übernimmt darin enthaltene Tags sauber als Vorbis-Kommentare + erneuert MD5
                            rc2, err2 = self._run_cmd([
                                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                                "-threads", str(eff_threads), "-filter_threads", str(eff_threads),
                                "-i", str(src_path), "-map", "0:a:0", "-map", "0:v?", "-c:v", "copy",
                                "-map_metadata", "0", "-c:a", "flac", "-compression_level", "6",
                                "-threads", str(eff_threads), str(tmp_out),
                            ])
                            if rc2 != 0:
                                raise RuntimeError(err2.strip() or "FLAC-Remux fehlgeschlagen")
                            step_logs.append((
                                "ID3-Header-Strip & FLAC-Remux" if pre_struct.id3v2_count > 0 else "FLAC-Remux",
                                "OK",
                                "ID3v2-Präfix entfernt, Tags als Vorbis-Kommentare & fLaC-Container sauber neu geschrieben"
                                if pre_struct.id3v2_count > 0
                                else "Container & Metadatenblöcke sauber neu geschrieben",
                            ))
                        else:
                            shutil.copy2(src_path, tmp_out)
                            step_logs.append((
                                "FLAC-Stream-Erhalt",
                                "OK",
                                "Audio-Frames & MD5 bit-identisch übernommen",
                            ))
                        if write_flac_seektable:
                            sp_count = insert_flac_seektable(tmp_out, pre_struct.sample_rate or 44100)
                            step_logs.append((
                                "FLAC-Seektable",
                                "OK" if sp_count > 0 else "HINWEIS",
                                f"{sp_count} Seekpoint(s) (10s) in Header eingefügt" if sp_count > 0 else "Seektable konnte nicht ergänzt werden",
                            ))
                        elif not other_flac_remux_reasons and pre_struct.id3v2_count == 0:
                            strip_flac_seektable(tmp_out)
                            step_logs.append((
                                "FLAC-Seektable",
                                "ÜBERSPRUNGEN",
                                "Durch Benutzeroption deaktiviert",
                            ))
                    else:
                        shutil.copy2(src_path, tmp_out)
                        step_logs.append((
                            "FLAC-Prüfung",
                            "ÜBERSPRUNGEN",
                            "Keine strukturelle Änderung erforderlich" if write_flac_seektable else "Seektable-Erzeugung durch Benutzer deaktiviert",
                        ))

                elif ext in (".mp3", ".mp2"):
                    raw_buf = src_path.read_bytes()
                    # ID3v2-Ende & gültiges Audio-Ende exakt bestimmen
                    id3_off_rep = 0
                    id3_cnt_rep = 0
                    while id3_off_rep + 10 <= len(raw_buf) and raw_buf[id3_off_rep : id3_off_rep + 3] == b"ID3":
                        mv, rv = raw_buf[id3_off_rep + 3], raw_buf[id3_off_rep + 4]
                        fl_b = raw_buf[id3_off_rep + 5]
                        b6, b7, b8, b9 = raw_buf[id3_off_rep + 6], raw_buf[id3_off_rep + 7], raw_buf[id3_off_rep + 8], raw_buf[id3_off_rep + 9]
                        if mv not in (2, 3, 4) or rv == 0xFF or ((b6 | b7 | b8 | b9) & 0x80) != 0:
                            break
                        tsz = (b6 << 21) | (b7 << 14) | (b8 << 7) | b9
                        next_o = id3_off_rep + 10 + tsz + (10 if (fl_b & 0x10) else 0)
                        if next_o > len(raw_buf):
                            break
                        id3_off_rep = next_o
                        id3_cnt_rep += 1
                        if id3_cnt_rep > 6:
                            break
                    audio_end_rep, _, _, _ = _strip_mpeg_trailing_tags(raw_buf, id3_off_rep)

                    needs_frame_slice = (
                        (not eff_fmt_mismatch)
                        and (
                            pre_struct.leading_garbage_bytes > 4
                            or pre_struct.trailing_garbage_bytes > 0
                            or pre_struct.corrupt_sync_gaps > 0
                            or pre_struct.id3v2_count > 1
                            or has_stream_errors
                            or do_header_strip
                        )
                    )
                    sliced_mpeg_path: Optional[Path] = None
                    sliced_skipped_bytes = 0
                    if needs_frame_slice:
                        clean_frames, kept_cnt, skipped_b = _extract_clean_mpeg_stream(
                            raw_buf, id3_off_rep, audio_end_rep
                        )
                        if kept_cnt > 0 and len(clean_frames) > 128:
                            cand_slice = tmp_dir / f"clean_frames{ext}"
                            cand_slice.write_bytes(clean_frames)
                            sliced_mpeg_path = cand_slice
                            sliced_skipped_bytes = skipped_b
                            if skipped_b > 0 or pre_struct.id3v2_count > 1:
                                step_logs.append((
                                    "Verlustfreier MPEG-Frame-Schnitt",
                                    "OK",
                                    f"{kept_cnt} gültige Frames isoliert · {skipped_b} Rest-/Müll-Bytes verlustfrei entfernt",
                                ))

                    def _run_mp3_ffmpeg(reencode: bool) -> tuple[int, str]:
                        c: list[str] = [
                            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                            "-threads", str(eff_threads), "-filter_threads", str(eff_threads),
                            "-err_detect", "ignore_err",
                        ]
                        if (not reencode) and sliced_mpeg_path is not None:
                            # Input 0: bereinigte MPEG-Frames (kein Müll), Input 1: Original für Tags & Cover
                            c.extend(["-i", str(sliced_mpeg_path), "-i", str(src_path)])
                            if optimized_cover_path is not None:
                                c.extend([
                                    "-i", str(optimized_cover_path),
                                    "-map", "0:a:0", "-map", "2:v:0", "-c:v", "copy",
                                    "-disposition:v:0", "attached_pic", "-map_metadata", "1",
                                ])
                            else:
                                c.extend(["-map", "0:a:0", "-map", "1:v?", "-c:v", "copy", "-map_metadata", "1"])
                        else:
                            c.extend(["-i", str(src_path)])
                            if optimized_cover_path is not None:
                                c.extend([
                                    "-i", str(optimized_cover_path),
                                    "-map", "0:a:0", "-map", "1:v:0", "-c:v", "copy",
                                    "-disposition:v:0", "attached_pic", "-map_metadata", "0",
                                ])
                            else:
                                # Cover-Art immer erhalten (nie still mit -vn löschen!)
                                c.extend(["-map", "0:a:0", "-map", "0:v?", "-c:v", "copy", "-map_metadata", "0"])
                        if reencode:
                            c.extend(["-c:a", "mp2" if ext == ".mp2" else "libmp3lame", "-q:a", "0"])
                        else:
                            c.extend(["-c:a", "copy"])
                        if ext == ".mp3" and (do_vbr_rebuild or do_remux_faststart or sliced_mpeg_path is not None):
                            c.extend(["-write_xing", "1"])
                        if do_header_strip or options.clean_tags or sliced_mpeg_path is not None:
                            c.extend([
                                "-id3v2_version", "3" if options.id3v2_version == 3 else "4",
                                "-write_id3v1", "1",
                            ])
                        c.extend(["-threads", str(eff_threads), str(tmp_out)])
                        return self._run_cmd(c)

                    def _count_audio_decode_errors(path_to_test: Path) -> int:
                        try:
                            chk = subprocess.run(
                                [
                                    "ffmpeg", "-hide_banner", "-v", "error",
                                    "-threads", str(eff_threads), "-filter_threads", str(eff_threads),
                                    "-err_detect", "+crccheck+bitstream",
                                    "-i", str(path_to_test), "-map", "0:a:0", "-vn", "-f", "null", "-",
                                ],
                                capture_output=True,
                                text=True,
                                timeout=60,
                            )
                            return sum(
                                1
                                for ln in (chk.stderr or "").splitlines()
                                if ln.strip() and not ln.strip().startswith("Last message repeated")
                            )
                        except Exception:
                            return 0

                    will_reencode_mp3 = False
                    if eff_fmt_mismatch:
                        will_reencode_mp3 = True
                        rc, err = _run_mp3_ffmpeg(True)
                    else:
                        # Immer zuerst 100 % verlustfreien Stream-Remux versuchen (verhindert unnötigen Qualitätsverlust!)
                        rc, err = _run_mp3_ffmpeg(False)
                        needs_fallback_reencode = rc != 0 or (
                            has_stream_errors and _count_audio_decode_errors(tmp_out) > 0
                        )
                        if needs_fallback_reencode and (
                            do_remux_faststart or do_lossless_reencode or options.auto_repair or rc != 0
                        ):
                            will_reencode_mp3 = True
                            rc, err = _run_mp3_ffmpeg(True)

                    if rc != 0:
                        raise RuntimeError(err.strip() or "MP3-Reparatur fehlgeschlagen")
                    mp3_details = [
                        "Frames fehlertolerant neu aufgebaut (-q:a 0)" if will_reencode_mp3 else "Audiostream 100 % verlustfrei kopiert (-c:a copy)",
                        "Xing/VBR-Header neu geschrieben" if (ext == ".mp3" and (do_vbr_rebuild or do_remux_faststart or sliced_mpeg_path is not None)) else "",
                        f"ID3v2.{3 if options.id3v2_version == 3 else 4} + ID3v1" if (do_header_strip or options.clean_tags or sliced_mpeg_path is not None) else "",
                        f"{sliced_skipped_bytes} Restbytes entfernt" if (not will_reencode_mp3 and sliced_skipped_bytes > 0) else "",
                    ]
                    step_logs.append((
                        "MP3 Stream-Neuaufbau" if will_reencode_mp3 else "MP3 Verlustfreier Header-/Container-Remux",
                        "OK",
                        " · ".join(d for d in mp3_details if d),
                    ))
                else:
                    supports_attached_pic = ext == ".m4a"

                    def _run_other_ffmpeg(reencode: bool) -> tuple[int, str]:
                        c: list[str] = [
                            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                            "-threads", str(eff_threads), "-filter_threads", str(eff_threads),
                            "-err_detect", "ignore_err", "-i", str(src_path),
                        ]
                        if optimized_cover_path is not None and supports_attached_pic:
                            c.extend([
                                "-i", str(optimized_cover_path),
                                "-map", "0:a:0", "-map", "1:v:0", "-c:v", "copy",
                                "-disposition:v:0", "attached_pic", "-map_metadata", "0",
                            ])
                        elif supports_attached_pic:
                            c.extend(["-map", "0:a:0", "-map", "0:v?", "-c:v", "copy", "-map_metadata", "0"])
                        else:
                            # WAV, AIFF, OGG, OPUS unterstützen keinen Video-/Cover-Stream im FFmpeg-Muxer
                            c.extend(["-map", "0:a:0", "-vn", "-map_metadata", "0"])

                        if reencode:
                            if ext == ".wav":
                                wav_codec = (
                                    "pcm_s32le"
                                    if pre_struct.bits_per_sample > 24
                                    else ("pcm_s24le" if pre_struct.bits_per_sample > 16 else "pcm_s16le")
                                )
                                c.extend(["-c:a", wav_codec])
                            elif ext in (".aiff", ".aif", ".aifc"):
                                aiff_codec = (
                                    "pcm_s32be"
                                    if pre_struct.bits_per_sample > 24
                                    else ("pcm_s24be" if pre_struct.bits_per_sample > 16 else "pcm_s16be")
                                )
                                c.extend(["-c:a", aiff_codec])
                            elif ext == ".m4a":
                                if pre_struct.codec == "alac":
                                    c.extend(["-c:a", "alac"])
                                else:
                                    c.extend(["-c:a", "aac", "-b:a", "256k"])
                            elif ext == ".opus":
                                c.extend(["-c:a", "libopus", "-b:a", "192k"])
                            else:
                                c.extend(["-c:a", "libvorbis", "-b:a", "256k"])
                        else:
                            c.extend(["-c:a", "copy"])

                        if ext == ".wav":
                            # FFmpeg WAV-Muxer unterstützt kein -write_id3v2, aber -rf64 auto für >4GB-Schutz
                            c.extend(["-rf64", "auto"])
                        elif ext in (".aiff", ".aif", ".aifc"):
                            c.extend([
                                "-write_id3v2", "1",
                                "-id3v2_version", "3" if options.id3v2_version == 3 else "4",
                            ])
                        elif ext == ".m4a" and (do_remux_faststart or optimized_cover_path is not None):
                            c.extend(["-movflags", "+faststart"])
                        c.extend(["-threads", str(eff_threads), str(tmp_out)])
                        return self._run_cmd(c)

                    will_reencode_other = False
                    if eff_fmt_mismatch:
                        will_reencode_other = True
                        rc, err = _run_other_ffmpeg(True)
                    else:
                        rc, err = _run_other_ffmpeg(False)
                        if (rc != 0 or has_stream_errors) and (
                            do_remux_faststart or do_lossless_reencode or options.auto_repair or rc != 0
                        ):
                            need_fb = rc != 0
                            if not need_fb and has_stream_errors:
                                try:
                                    chk = subprocess.run(
                                        [
                                            "ffmpeg", "-hide_banner", "-v", "error",
                                            "-threads", str(eff_threads), "-filter_threads", str(eff_threads),
                                            "-err_detect", "+crccheck+bitstream",
                                            "-i", str(tmp_out), "-map", "0:a:0", "-vn", "-f", "null", "-",
                                        ],
                                        capture_output=True,
                                        text=True,
                                        timeout=60,
                                    )
                                    need_fb = any(
                                        ln.strip() and not ln.strip().startswith("Last message repeated")
                                        for ln in (chk.stderr or "").splitlines()
                                    )
                                except Exception:
                                    need_fb = False
                            if need_fb:
                                will_reencode_other = True
                                rc, err = _run_other_ffmpeg(True)

                    if rc != 0:
                        raise RuntimeError(err.strip() or "Container-Reparatur fehlgeschlagen")
                    other_details = [
                        "Audiostrom neu kodiert" if will_reencode_other else "Audiostrom verlustfrei kopiert",
                        "moov +faststart vor mdat" if (ext == ".m4a" and (do_remux_faststart or optimized_cover_path is not None)) else "",
                    ]
                    step_logs.append((
                        "Stream-Neuaufbau" if will_reencode_other else "Container-/Header-Remux",
                        "OK",
                        " · ".join(d for d in other_details if d),
                    ))

                # Sicherheits-Nachprüfung VOR dem Überschreiben / Speichern der Zieldatei!
                ah_status, after_findings, after_struct = analyze_audio_file_for_repair(
                    tmp_out,
                    options.deep_scan,
                    cover_max_dimension=max_cover_dim,
                    ffmpeg_threads=eff_threads,
                )
                validation_err = _validate_repaired_audio_output(
                    tmp_out, pre_findings, pre_struct, after_findings, after_struct
                )
                if validation_err:
                    raise RuntimeError(validation_err)

                if options.in_place_backup:
                    bak_path = src_path.with_name(f"{src_path.name}.bak")
                    if not bak_path.exists():
                        shutil.copy2(src_path, bak_path)
                    staged = src_path.with_name(f".{src_path.name}.mintrip_tmp_{uuid.uuid4().hex[:8]}")
                    shutil.copy2(tmp_out, staged)
                    os.replace(staged, src_path)
                    final_path = src_path
                    step_logs.append(("Backup & In-Place-Sicherung", "OK", f"Atomar ersetzt · Backup: {bak_path.name}"))
                else:
                    staged = target_path.with_name(f".{target_path.name}.mintrip_tmp_{uuid.uuid4().hex[:8]}")
                    shutil.copy2(tmp_out, staged)
                    os.replace(staged, target_path)
                    final_path = target_path

                # Eingebettetes Coverbild im Zielverzeichnis als Bilddatei speichern
                if after_struct.has_cover_art or (optimized_cover_path is not None and optimized_cover_path.exists()):
                    try:
                        raw_cov_name = re.sub(
                            r"\{[^}]*\}",
                            "",
                            str(getattr(options, "cover_filename", "cover") or "cover"),
                        )
                        raw_cov_name = re.sub(
                            r"\.(jpe?g|png|webp|gif|bmp)$", "", raw_cov_name, flags=re.IGNORECASE
                        )
                        cov_stem = re.sub(r'[\\/:*?"<>|]+', "_", raw_cov_name).strip(" ._") or "cover"

                        cov_bytes: Optional[bytes] = None
                        cov_ext = ".jpg"
                        if optimized_cover_path is not None and optimized_cover_path.exists():
                            cov_bytes = optimized_cover_path.read_bytes()
                            cov_ext = ".jpg"
                        else:
                            probe_cov_raw = tmp_dir / "extracted_cover.bin"
                            rc_ex, _ = self._run_cmd([
                                "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                                "-threads", str(eff_threads), "-filter_threads", str(eff_threads),
                                "-i", str(final_path), "-map", "0:v:0", "-c:v", "copy",
                                "-f", "data", str(probe_cov_raw),
                            ])
                            if rc_ex != 0 or not probe_cov_raw.exists() or probe_cov_raw.stat().st_size <= 64:
                                fallback_cov = tmp_dir / "extracted_cover.jpg"
                                rc_ex2, _ = self._run_cmd([
                                    "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                                    "-threads", str(eff_threads), "-filter_threads", str(eff_threads),
                                    "-i", str(final_path), "-map", "0:v:0", "-vframes", "1",
                                    "-pix_fmt", "yuvj420p", "-q:v", "2",
                                    "-threads", str(eff_threads), str(fallback_cov),
                                ])
                                if rc_ex2 == 0 and fallback_cov.exists() and fallback_cov.stat().st_size > 64:
                                    cov_bytes = fallback_cov.read_bytes()
                                    cov_ext = ".jpg"
                            else:
                                cov_bytes = probe_cov_raw.read_bytes()
                                if cov_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
                                    cov_ext = ".png"
                                elif cov_bytes[:4] == b"RIFF" and cov_bytes[8:12] == b"WEBP":
                                    cov_ext = ".webp"
                                elif cov_bytes.startswith(b"\xff\xd8\xff"):
                                    cov_ext = ".jpg"
                                else:
                                    # Unübliches Bildformat (z. B. BMP/TIFF) sauber als JPEG exportieren
                                    fallback_cov = tmp_dir / "extracted_cover.jpg"
                                    rc_ex2, _ = self._run_cmd([
                                        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
                                        "-threads", str(eff_threads), "-filter_threads", str(eff_threads),
                                        "-i", str(final_path), "-map", "0:v:0", "-vframes", "1",
                                        "-pix_fmt", "yuvj420p", "-q:v", "2",
                                        "-threads", str(eff_threads), str(fallback_cov),
                                    ])
                                    if rc_ex2 == 0 and fallback_cov.exists() and fallback_cov.stat().st_size > 64:
                                        cov_bytes = fallback_cov.read_bytes()
                                        cov_ext = ".jpg"

                        if cov_bytes and len(cov_bytes) > 64:
                            cover_dest = final_path.parent / f"{cov_stem}{cov_ext}"
                            with self._cover_write_lock:
                                with tempfile.NamedTemporaryFile(
                                    dir=str(final_path.parent),
                                    prefix=f".{cov_stem}_",
                                    suffix=cov_ext,
                                    delete=False,
                                ) as tf:
                                    tf.write(cov_bytes)
                                    tmp_cov_name = tf.name
                                os.replace(tmp_cov_name, cover_dest)
                            step_logs.append((
                                "Cover-Datei im Zielordner",
                                "OK",
                                f"Eingebettetes Cover gespeichert → {cover_dest.name} ({max(1, round(len(cov_bytes) / 1024))} KB)",
                            ))
                    except Exception as cov_exc:
                        step_logs.append((
                            "Cover-Datei im Zielordner",
                            "HINWEIS",
                            f"Cover-Extraktion übersprungen: {cov_exc}",
                        ))

                after_cnt = sum(1 for f in after_findings if f.severity != "info")
                seek_note = (
                    f" · Seektable: {'Ja' if after_struct.flac_has_seektable else 'Nein'}"
                    if ext == ".flac"
                    else ""
                )
                step_logs.append((
                    f"Nachprüfung ({'Stufe 1+2' if options.deep_scan else 'Stufe 1'})",
                    "OK" if after_cnt == 0 else "HINWEIS",
                    f"Status: {ah_status} · Befunde: {len(pre_findings)} → {len(after_findings)}{seek_note}",
                ))
                job.health = "repaired"
                job.findings = after_findings
                job.structure = after_struct
                job.pipeline = after_struct.pipeline
                job.output_path = final_path
                job.after_finding_count = after_cnt
                job.progress = 1.0
                job.status_message = (
                    "Repariert · Strukturell sauber"
                    if after_cnt == 0
                    else f"Repariert ({after_cnt} Rest-Hinweis)"
                )
                self._emit_update(job)
                for s_name, s_status, s_detail in step_logs:
                    self._emit_log(
                        f"[Reparatur · {job.relative_path}] [{s_status}] {s_name}: {s_detail}"
                    )
                self._emit_log(f"[Reparatur] „{job.relative_path}“ erfolgreich repariert → {final_path}")
        except Exception as exc:
            job.health = "error"
            job.progress = 0.0
            job.status_message = f"Fehler: {exc}"
            self._emit_update(job)
            self._emit_log(f"[Reparatur] Fehler bei „{job.relative_path}“: {exc}")
        finally:
            self._finish_one("repair")
