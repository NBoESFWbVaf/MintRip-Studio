"""CD-Laufwerkszugriff, TOC-Auslesung, DiscID-Berechnung (PyCdio) & cdparanoia-Runner."""

from __future__ import annotations

import base64
from collections import deque
import ctypes
import fcntl
import hashlib
import os
import re
import shutil
import struct
import subprocess
import threading
import time
from pathlib import Path
from typing import Callable, Optional

try:
    import cdio  # type: ignore
    import pycdio  # type: ignore
except Exception:
    cdio = None  # type: ignore[assignment]
    pycdio = None  # type: ignore[assignment]

from .encoder import inspect_cover_image
from .models import AlbumMetadata, TrackMetadata

FRAMES_PER_SECOND = 75
PREGAP_OFFSET = 150
CD_EXTRA_SESSION_GAP_SECTORS = 11400  # Blue Book Multi-Session-Lücke (1:30 Lead-Out + 1:00 Lead-In + 0:02 Pregap)
PARANOIA_PROGRESS_RE = re.compile(r"##:\s*-?\d+\s+\[wrote\]\s+@\s+(\d+)")
_CDPARANOIA_TOC_LINE_RE = re.compile(
    r"^\s*(\d+)\.\s+(\d+)\s+\[[^\]]+\]\s+(\d+)\s+\[[^\]]+\]"
)


def detect_optical_drives() -> list[str]:
    """Erkennt alle verfügbaren optischen Laufwerke (inkl. Misch-CDs, CD-Extra / Enhanced-CD & Bilder-CDs)."""
    found: list[str] = []
    seen_real: set[str] = set()

    def _add_candidate(dev: str) -> None:
        clean = str(dev or "").strip()
        if not clean or not Path(clean).exists():
            return
        try:
            real = os.path.realpath(clean)
        except Exception:
            real = clean
        if real in seen_real:
            return
        seen_real.add(real)
        found.append(clean)

    # 1. Alle optischen Laufwerke über libcdio (ohne Einschränkung auf reine FS_AUDIO-Discs)
    if cdio is not None:
        try:
            all_drives = cdio.get_devices()
            if all_drives:
                for dev in all_drives:
                    _add_candidate(dev)
        except Exception:
            pass
        if pycdio is not None:
            try:
                audio_drives = cdio.get_devices_with_cap(pycdio.FS_AUDIO, False)
                if audio_drives:
                    for dev in audio_drives:
                        _add_candidate(dev)
            except Exception:
                pass

    # 2. Standard-Linux-Gerätepfade ergänzen (erkennt Laufwerke auch bei gemounteter Bilder-/Daten-Session)
    for dev in (
        "/dev/sr0",
        "/dev/sr1",
        "/dev/sr2",
        "/dev/sr3",
        "/dev/cdrom",
        "/dev/dvd",
    ):
        _add_candidate(dev)

    return found


def _cddb_sum(n: int) -> int:
    total = 0
    while n > 0:
        total += n % 10
        n //= 10
    return total


def calculate_cddb_disc_id(offsets_frames: list[int], total_seconds: int) -> str:
    """Berechnet die klassische 8-stellige Hex-CDDB-DiscID aus den Track-Offsets."""
    if not offsets_frames:
        return ""
    checksum = sum(_cddb_sum(offset // FRAMES_PER_SECOND) for offset in offsets_frames)
    num_tracks = len(offsets_frames)
    disc_id = ((checksum % 0xFF) << 24) | (total_seconds << 8) | num_tracks
    return f"{disc_id:08x}"


def calculate_musicbrainz_disc_id(
    first_track: int,
    last_track: int,
    leadout_offset: int,
    track_offsets: list[int],
) -> str:
    """Berechnet die offizielle 28-stellige MusicBrainz-DiscID (SHA-1 + modifiziertes Base64)."""
    if not track_offsets or leadout_offset <= 0:
        return ""

    slots = [leadout_offset] + list(track_offsets) + [0] * (99 - len(track_offsets))
    raw = f"{first_track:02X}{last_track:02X}" + "".join(f"{val:08X}" for val in slots[:100])
    digest = hashlib.sha1(raw.encode("ascii")).digest()
    encoded = base64.b64encode(digest).decode("ascii")
    return encoded.replace("+", ".").replace("/", "_").replace("=", "-")


def _build_album_from_toc_entries(
    entries: list[tuple[int, int, bool]],
    disc_leadout_lsn: int,
    is_multisession: bool = False,
    last_session_first_track: Optional[int] = None,
    last_session_start_lsn: Optional[int] = None,
    source_label: str = "Lokal (CDROM TOC)",
    device_path: str = "/dev/cdrom",
) -> AlbumMetadata:
    """Erstellt aus beliebigen CD-TOC-Einträgen (reine Audio-CD, CD-Extra/Enhanced-CD, Bilder-CD oder Mixed-Mode) die Audio-Metadaten."""
    sorted_entries = sorted(entries, key=lambda item: item[0])
    audio_entries = [e for e in sorted_entries if e[2]]
    data_entries = [e for e in sorted_entries if not e[2]]

    if not audio_entries:
        raise RuntimeError(f"Keine Audio-Tracks auf der CD in {device_path} gefunden.")

    last_audio_num = audio_entries[-1][0]
    last_audio_lsn = audio_entries[-1][1]
    trailing_data = [e for e in data_entries if e[0] > last_audio_num]
    first_trailing_data = trailing_data[0] if trailing_data else None

    # Audio-Leadout gemäß Red-Book / Blue-Book (CD-Extra / libdiscid) bestimmen
    if first_trailing_data is not None:
        first_data_num, first_data_lsn, _ = first_trailing_data
        is_second_session_data = bool(
            is_multisession
            or (last_session_first_track is not None and first_data_num >= last_session_first_track)
            or (
                last_session_start_lsn is not None
                and last_session_start_lsn > 0
                and first_data_lsn >= last_session_start_lsn
            )
        )
        if is_second_session_data and (first_data_lsn - CD_EXTRA_SESSION_GAP_SECTORS) > last_audio_lsn:
            audio_leadout_lsn = first_data_lsn - CD_EXTRA_SESSION_GAP_SECTORS
        else:
            audio_leadout_lsn = first_data_lsn
    else:
        audio_leadout_lsn = disc_leadout_lsn

    if audio_leadout_lsn <= last_audio_lsn:
        audio_leadout_lsn = max(disc_leadout_lsn, last_audio_lsn + FRAMES_PER_SECOND)

    # Nächster TOC-Eintrag je Track für exakte End-Sektoren
    next_lsn_by_track: dict[int, int] = {}
    for pos, (t_num, _t_lsn, _t_audio) in enumerate(sorted_entries):
        if pos + 1 < len(sorted_entries):
            next_lsn_by_track[t_num] = sorted_entries[pos + 1][1]
        else:
            next_lsn_by_track[t_num] = disc_leadout_lsn

    tracks: list[TrackMetadata] = []
    frame_offsets: list[int] = []
    for t_num, start_lsn, _is_audio in audio_entries:
        if t_num == last_audio_num:
            end_lsn = max(start_lsn, audio_leadout_lsn - 1)
        else:
            next_lsn = next_lsn_by_track.get(t_num, audio_leadout_lsn)
            end_lsn = max(start_lsn, next_lsn - 1)
        sector_count = max(1, end_lsn - start_lsn + 1)
        duration_seconds = max(1, round(sector_count / FRAMES_PER_SECOND))
        frame_offsets.append(start_lsn + PREGAP_OFFSET)
        tracks.append(
            TrackMetadata(
                track_number=t_num,
                title=f"Titel {t_num:02d}",
                duration_seconds=duration_seconds,
                start_lsn=start_lsn,
                end_lsn=end_lsn,
                toc_track_number=t_num,
            )
        )

    audio_first = tracks[0].track_number
    audio_last = tracks[-1].track_number
    leadout_offset = audio_leadout_lsn + PREGAP_OFFSET
    first_offset_sec = frame_offsets[0] // FRAMES_PER_SECOND
    leadout_sec = leadout_offset // FRAMES_PER_SECOND

    cddb_id = calculate_cddb_disc_id(frame_offsets, max(1, leadout_sec - first_offset_sec))
    mb_disc_id = calculate_musicbrainz_disc_id(audio_first, audio_last, leadout_offset, frame_offsets)
    mb_toc = f"{audio_first} {audio_last} {leadout_offset} " + " ".join(str(o) for o in frame_offsets)

    meta_source = source_label
    if data_entries:
        kind_tag = "Enhanced-CD / Misch-CD" if first_trailing_data is not None else "Mixed-Mode-CD"
        meta_source = f"{source_label} · {kind_tag} ({len(tracks)} Audio, {len(data_entries)} Daten)"

    return AlbumMetadata(
        title="Audio-CD (Lokal ausgelesen)",
        artist="Unbekannter Künstler",
        cddb_id=cddb_id,
        musicbrainz_disc_id=mb_disc_id,
        musicbrainz_toc=mb_toc,
        track_offsets=frame_offsets,
        leadout_offset=leadout_offset,
        metadata_source=meta_source,
        tracks=tracks,
    )


def _query_scsi_multisession_info(fd: int) -> tuple[bool, Optional[int], Optional[int]]:
    """Fragt per SCSI MMC READ TOC Format 1 (Session Info) ab, ob eine Multi-Session-CD (CD-Extra / Bilder-CD) eingelegt ist."""
    ok, status, host_st, drv_st, data, _sense = _sg_io_command(
        fd,
        bytes([0x43, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0C, 0x00]),
        dxfer_len=12,
        timeout_ms=3000,
    )
    if ok and status == 0 and host_st == 0 and drv_st == 0 and len(data) >= 12:
        first_session = data[2]
        last_session = data[3]
        last_session_first_track = data[6]
        last_session_start_lba = struct.unpack(">i", data[8:12])[0]
        is_ms = last_session > first_session and last_session >= 2
        return (
            is_ms,
            int(last_session_first_track) if is_ms else None,
            max(0, int(last_session_start_lba)) if is_ms else None,
        )
    return False, None, None


def _read_raw_toc_via_scsi(fd: int) -> Optional[tuple[list[tuple[int, int, bool]], int]]:
    """Liest die komplette CD-TOC direkt über SCSI MMC READ TOC Format 0 (LBA) unabhängig vom Kernel-Dateisystemtreiber."""
    ok, status, host_st, drv_st, data, _sense = _sg_io_command(
        fd,
        bytes([0x43, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x24, 0x00]),
        dxfer_len=804,
        timeout_ms=4000,
    )
    if not (ok and status == 0 and host_st == 0 and drv_st == 0 and len(data) >= 12):
        return None
    data_len = (data[0] << 8) | data[1]
    total_len = min(len(data), data_len + 2)
    entries: list[tuple[int, int, bool]] = []
    leadout_lsn = 0
    pos = 4
    while pos + 8 <= total_len:
        adr_ctrl = data[pos + 1]
        track_no = data[pos + 2]
        start_lba = max(0, struct.unpack(">i", data[pos + 4 : pos + 8])[0])
        if track_no == _CDROM_LEADOUT:
            leadout_lsn = start_lba
        elif 1 <= track_no <= 99:
            is_audio = (adr_ctrl & _CDROM_DATA_TRACK) == 0
            entries.append((int(track_no), int(start_lba), is_audio))
        pos += 8
    if not entries or leadout_lsn <= 0:
        return None
    return entries, leadout_lsn


def _read_toc_via_linux_ioctl(device_path: str) -> AlbumMetadata:
    """Liest die CD-TOC direkt über Linux-Kernel-IOCTLs (wie Asunder) + SCSI Multi-Session-Erkennung (funktioniert auch bei gemounteter Bilder-/Daten-CD)."""
    clean_dev = (device_path or "").strip() or "/dev/cdrom"
    if not Path(clean_dev).exists():
        raise RuntimeError(f"Optisches Laufwerk {clean_dev} nicht gefunden.")
    real_dev = os.path.realpath(clean_dev)
    fd = os.open(real_dev, os.O_RDONLY | os.O_NONBLOCK)
    try:
        # Multi-Session-Status (Enhanced-CD / CD-Extra / Bilder-CD) ermitteln
        is_ms, ms_first_track, ms_start_lba = _query_scsi_multisession_info(fd)
        if not is_ms:
            try:
                ms_struct = _CdromMultiSession()
                ms_struct.addr_format = _CDROM_LBA
                fcntl.ioctl(fd, _CDROMMULTISESSION, ms_struct)
                if ms_struct.xa_flag and ms_struct.addr_lba > 0:
                    is_ms = True
                    ms_start_lba = int(ms_struct.addr_lba)
            except Exception:
                pass

        entries: list[tuple[int, int, bool]] = []
        leadout_lsn = 0
        source_label = "Lokal (Linux CDROM TOC)"

        # 1. Linux CDROMREADTOCHDR + CDROMREADTOCENTRY (mit kurzem Spin-up-Retry)
        tochdr = _CdromTocHdr()
        hdr_ok = False
        for attempt in range(3):
            try:
                fcntl.ioctl(fd, _CDROMREADTOCHDR, tochdr)
                hdr_ok = True
                break
            except OSError:
                if attempt < 2:
                    time.sleep(0.25)

        if hdr_ok and tochdr.cdth_trk0 >= 1 and tochdr.cdth_trk1 >= tochdr.cdth_trk0:
            for t_num in range(int(tochdr.cdth_trk0), int(tochdr.cdth_trk1) + 1):
                entry = _CdromTocEntry()
                entry.cdte_track = t_num
                entry.cdte_format = _CDROM_LBA
                try:
                    fcntl.ioctl(fd, _CDROMREADTOCENTRY, entry)
                    is_audio = (int(entry.cdte_ctrl) & _CDROM_DATA_TRACK) == 0
                    entries.append((t_num, max(0, int(entry.cdte_lba)), is_audio))
                except OSError:
                    continue

            lead_entry = _CdromTocEntry()
            lead_entry.cdte_track = _CDROM_LEADOUT
            lead_entry.cdte_format = _CDROM_LBA
            try:
                fcntl.ioctl(fd, _CDROMREADTOCENTRY, lead_entry)
                leadout_lsn = max(0, int(lead_entry.cdte_lba))
            except OSError:
                leadout_lsn = 0

        # 2. Direktes SCSI MMC READ TOC Format 0 falls Kernel-IOCTL keine Audio-Tracks lieferte
        if not any(e[2] for e in entries) or leadout_lsn <= 0:
            scsi_toc = _read_raw_toc_via_scsi(fd)
            if scsi_toc is not None:
                entries, leadout_lsn = scsi_toc
                source_label = "Lokal (SCSI MMC TOC)"

        if not entries:
            raise RuntimeError(f"Keine lesbare CD-TOC im Laufwerk {device_path} gefunden.")

        return _build_album_from_toc_entries(
            entries=entries,
            disc_leadout_lsn=leadout_lsn,
            is_multisession=is_ms,
            last_session_first_track=ms_first_track,
            last_session_start_lsn=ms_start_lba,
            source_label=source_label,
            device_path=device_path,
        )
    finally:
        try:
            os.close(fd)
        except Exception:
            pass


def _read_toc_via_cdparanoia(device_path: str) -> AlbumMetadata:
    """Liest Audio-Tracks über 'cdparanoia -Q' aus (erkennt Misch-CDs, CD-Extra & Bilder-CDs genau wie Asunder)."""
    cdparanoia_bin = shutil.which("cdparanoia")
    if not cdparanoia_bin:
        raise RuntimeError("cdparanoia nicht installiert.")
    clean_dev = (device_path or "").strip() or "/dev/cdrom"
    real_dev = os.path.realpath(clean_dev) if Path(clean_dev).exists() else clean_dev
    proc = subprocess.run(
        [cdparanoia_bin, "-Q", "-d", real_dev],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=15,
        check=False,
    )
    combined = f"{proc.stdout or ''}\n{proc.stderr or ''}"
    tracks: list[TrackMetadata] = []
    frame_offsets: list[int] = []
    for line in combined.splitlines():
        m = _CDPARANOIA_TOC_LINE_RE.match(line)
        if not m:
            continue
        t_num = int(m.group(1))
        length_sectors = max(1, int(m.group(2)))
        start_lsn = max(0, int(m.group(3)))
        end_lsn = start_lsn + length_sectors - 1
        duration_seconds = max(1, round(length_sectors / FRAMES_PER_SECOND))
        frame_offsets.append(start_lsn + PREGAP_OFFSET)
        tracks.append(
            TrackMetadata(
                track_number=t_num,
                title=f"Titel {t_num:02d}",
                duration_seconds=duration_seconds,
                start_lsn=start_lsn,
                end_lsn=end_lsn,
                toc_track_number=t_num,
            )
        )
    if not tracks:
        raise RuntimeError(f"cdparanoia -Q fand keine Audio-Tracks in {device_path}.")

    audio_first = tracks[0].track_number
    audio_last = tracks[-1].track_number
    audio_leadout_lsn = tracks[-1].end_lsn + 1
    leadout_offset = audio_leadout_lsn + PREGAP_OFFSET
    first_offset_sec = frame_offsets[0] // FRAMES_PER_SECOND
    leadout_sec = leadout_offset // FRAMES_PER_SECOND

    cddb_id = calculate_cddb_disc_id(frame_offsets, max(1, leadout_sec - first_offset_sec))
    mb_disc_id = calculate_musicbrainz_disc_id(audio_first, audio_last, leadout_offset, frame_offsets)
    mb_toc = f"{audio_first} {audio_last} {leadout_offset} " + " ".join(str(o) for o in frame_offsets)

    return AlbumMetadata(
        title="Audio-CD (Lokal ausgelesen)",
        artist="Unbekannter Künstler",
        cddb_id=cddb_id,
        musicbrainz_disc_id=mb_disc_id,
        musicbrainz_toc=mb_toc,
        track_offsets=frame_offsets,
        leadout_offset=leadout_offset,
        metadata_source="Lokal (cdparanoia TOC)",
        tracks=tracks,
    )


def _read_toc_via_pycdio(device_path: str) -> AlbumMetadata:
    """Fallback-TOC-Auslesung mittels PyCdio (inkl. Unterstützung für Misch-CDs / CD-Extra)."""
    if cdio is None or pycdio is None:
        raise RuntimeError("PyCdio nicht verfügbar.")
    device = cdio.Device(device_path)
    try:
        first_track_obj = device.get_first_track()
        if first_track_obj is None:
            raise RuntimeError(f"Keine Audio-CD im Laufwerk {device_path} eingelegt.")

        first_track = (
            first_track_obj.track
            if hasattr(first_track_obj, "track")
            else pycdio.get_first_track_num(device.cd)
        )
        num_tracks = device.get_num_tracks()
        last_lsn = device.get_disc_last_lsn()

        if first_track == pycdio.INVALID_TRACK or num_tracks <= 0:
            raise RuntimeError(f"Keine gültige Audio-CD im Laufwerk {device_path} gefunden.")

        entries: list[tuple[int, int, bool]] = []
        for idx in range(num_tracks):
            track_num = first_track + idx
            track_obj = device.get_track(track_num)
            if track_obj is None:
                continue
            try:
                track_format = str(track_obj.get_format() or "").strip().lower()
            except Exception:
                track_format = ""
            is_audio = "audio" in track_format
            start_lsn = max(0, int(track_obj.get_lsn()))
            entries.append((track_num, start_lsn, is_audio))

        is_ms = False
        try:
            disc_mode = str(device.get_disc_mode() or "").upper()
            if any(tok in disc_mode for tok in ("MIXED", "XA", "EXTRA", "MULTI")):
                is_ms = True
        except Exception:
            pass

        return _build_album_from_toc_entries(
            entries=entries,
            disc_leadout_lsn=max(0, int(last_lsn)),
            is_multisession=is_ms,
            source_label="Lokal (PyCdio TOC)",
            device_path=device_path,
        )
    finally:
        device.close()


def read_audio_cd_toc(device_path: str = "/dev/cdrom") -> AlbumMetadata:
    """Liest die Inhaltsverzeichnis-Struktur (TOC) einer Audio-, Misch-, CD-Extra- oder Bilder-CD zuverlässig aus."""
    errors: list[str] = []
    for reader_fn in (
        _read_toc_via_linux_ioctl,
        _read_toc_via_cdparanoia,
        _read_toc_via_pycdio,
    ):
        try:
            return reader_fn(device_path)
        except Exception as exc:
            errors.append(str(exc))

    detail = " | ".join(dict.fromkeys(e for e in errors if e))
    raise RuntimeError(
        f"Keine Audio-Tracks auf der CD in {device_path} gefunden ({detail})."
        if detail
        else f"Keine Audio-CD im Laufwerk {device_path} eingelegt."
    )


_DISC_CD_PREFIX_TRACK_RE = re.compile(
    r"^\s*(?:cd|disc|disk)\s*0*(\d{1,2})\s*[-._\s]+\s*(\d{1,3})\s*[-._)\s]+\s*(.+)$",
    re.IGNORECASE,
)
_TRACK_FILENAME_RE = re.compile(r"^\s*(?:(\d{1,2})[-.])?(\d{1,3})\s*[-._)\s]+\s*(.+)$", re.IGNORECASE)
_FOLDER_YEAR_PREFIX_RE = re.compile(r"^\s*[\(\[]?((?:19|20)\d{2})[\)\]]?\s*[-–_.]+\s*(.+)$")
_FOLDER_YEAR_SUFFIX_RE = re.compile(r"^(.+?)\s*[\(\[]((?:19|20)\d{2})[\)\]]\s*$")
_DISC_FOLDER_RE = re.compile(r"^(?:cd|disc|disk)\s*0*(\d{1,2})(?:\b|[-_.\s]*(.*))?$", re.IGNORECASE)


def _all_tag_strs(tags: object, keys: tuple[str, ...]) -> list[str]:
    if not tags or not hasattr(tags, "get"):
        return []
    collected: list[str] = []
    seen: set[str] = set()
    for key in keys:
        for variant in (key, key.upper(), key.lower()):
            val = tags.get(variant)
            if val:
                items = list(val) if isinstance(val, (list, tuple)) else [val]
                for entry in items:
                    for part in str(entry).split(";"):
                        cleaned = part.strip()
                        if cleaned and cleaned not in seen:
                            seen.add(cleaned)
                            collected.append(cleaned)
    return collected


def _first_tag_str(tags: object, keys: tuple[str, ...]) -> str:
    return "; ".join(_all_tag_strs(tags, keys))


def _parse_pos_int_prefix(raw: str) -> Optional[int]:
    if not raw:
        return None
    head = raw.split("/")[0].strip()
    m = re.match(r"^0*(\d{1,3})$", head)
    if m:
        val = int(m.group(1))
        return val if val > 0 else None
    return None


def _detect_disc_from_relative_path(file_path: Path, root_dir: Optional[Path]) -> Optional[int]:
    if not root_dir:
        return None
    try:
        rel = file_path.parent.relative_to(root_dir)
    except Exception:
        rel = file_path.parent
    for part in reversed(rel.parts):
        m = _DISC_FOLDER_RE.match(part.strip())
        if m:
            return max(1, int(m.group(1)))
    return None


def find_folder_cover_image(folder_path: Path) -> tuple[Optional[bytes], str, str]:
    """Sucht im Album-Verzeichnis (sowie typischen Artwork- und Disc-Unterordnern) nach vorhandenen Cover-Bilddateien."""
    if not folder_path or not folder_path.exists() or not folder_path.is_dir():
        return None, "image/jpeg", ""

    image_exts = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
    priority_stems = (
        "cover",
        "folder",
        "front",
        "album",
        "albumart",
        "albumartsmall",
        "artwork",
        "booklet",
        "disc",
        "cd",
        "scan",
    )

    search_dirs: list[Path] = [folder_path]
    for sub in ("Artwork", "artwork", "Covers", "covers", "Scans", "scans", "Booklet", "booklet"):
        sub_dir = folder_path / sub
        if sub_dir.is_dir():
            search_dirs.append(sub_dir)
    if _DISC_FOLDER_RE.match(folder_path.name) and folder_path.parent.is_dir():
        search_dirs.append(folder_path.parent)

    try:
        for child in sorted(folder_path.iterdir(), key=lambda p: p.name.lower()):
            if child.is_dir() and child not in search_dirs and _DISC_FOLDER_RE.match(child.name):
                search_dirs.append(child)
    except Exception:
        pass

    candidates: list[Path] = []
    for sdir in search_dirs:
        try:
            for item in sorted(sdir.iterdir(), key=lambda p: p.name.lower()):
                if item.is_file() and item.suffix.lower() in image_exts:
                    candidates.append(item)
        except Exception:
            continue

    if not candidates:
        return None, "image/jpeg", ""

    def score_image(path: Path) -> tuple[int, int]:
        stem_lower = path.stem.lower().strip()
        for rank, prio in enumerate(priority_stems):
            if stem_lower == prio or stem_lower.startswith(prio):
                try:
                    return (rank, -int(path.stat().st_size))
                except Exception:
                    return (rank, 0)
        try:
            return (len(priority_stems) + 1, -int(path.stat().st_size))
        except Exception:
            return (len(priority_stems) + 1, 0)

    candidates.sort(key=score_image)
    best = candidates[0]
    try:
        data = best.read_bytes()
        if len(data) < 64:
            return None, "image/jpeg", ""
        ext = best.suffix.lower()
        mime_map = {
            ".png": "image/png",
            ".webp": "image/webp",
            ".bmp": "image/bmp",
            ".tif": "image/tiff",
            ".tiff": "image/tiff",
        }
        mime = mime_map.get(ext, "image/jpeg")
        return data, mime, best.name
    except Exception:
        return None, "image/jpeg", ""


def parse_cue_or_folder_hints(folder_path: Path) -> dict:
    """Analysiert vorhandene .cue-Dateien sowie die Ordnerstruktur (z. B. 'Künstler - Album (Jahr)') für maximale TOC-Erkennung."""
    hints: dict = {
        "artist": "",
        "album": "",
        "year": "",
        "genre": "",
        "barcode": "",
        "catalog_number": "",
        "cddb_id": "",
        "mb_disc_id": "",
        "disc_number": 1,
        "cue_track_offsets": [],
        "cue_tracks": [],
    }
    if not folder_path or not folder_path.exists():
        return hints

    # 1. Ordnername & Elternordner analysieren (z. B. /Musik/Kraftwerk/1981 - Computerwelt/CD 1)
    target_folder = folder_path
    m_disc = _DISC_FOLDER_RE.match(folder_path.name.strip())
    if m_disc:
        hints["disc_number"] = max(1, int(m_disc.group(1)))
        if folder_path.parent and folder_path.parent != folder_path:
            target_folder = folder_path.parent

    folder_name = target_folder.name.strip()
    parent_name = target_folder.parent.name.strip() if target_folder.parent else ""

    # Jahr am Ende "(1981)" oder Anfang "1981 - " extrahieren
    m_suf = _FOLDER_YEAR_SUFFIX_RE.match(folder_name)
    if m_suf:
        folder_name = m_suf.group(1).strip()
        hints["year"] = m_suf.group(2)
    else:
        m_pre = _FOLDER_YEAR_PREFIX_RE.match(folder_name)
        if m_pre:
            hints["year"] = m_pre.group(1)
            folder_name = m_pre.group(2).strip()

    if " - " in folder_name:
        parts = [p.strip() for p in folder_name.split(" - ") if p.strip()]
        if len(parts) >= 2:
            if re.fullmatch(r"(?:19|20)\d{2}", parts[0]) and len(parts) >= 3:
                hints["year"] = hints["year"] or parts[0]
                hints["artist"] = parts[1]
                hints["album"] = " - ".join(parts[2:])
            elif re.fullmatch(r"(?:19|20)\d{2}", parts[1]) and len(parts) >= 3:
                hints["artist"] = parts[0]
                hints["year"] = hints["year"] or parts[1]
                hints["album"] = " - ".join(parts[2:])
            else:
                hints["artist"] = parts[0]
                hints["album"] = " - ".join(parts[1:])
    else:
        hints["album"] = folder_name
        if parent_name and parent_name.lower() not in (
            "musik",
            "music",
            "alben",
            "albums",
            "downloads",
            "rips",
            "flac",
            "mp3",
            "audio",
            target_folder.anchor.strip("/\\"),
        ):
            hints["artist"] = parent_name

    # 2. CUE-Sheet im Ordner suchen (enthält oft exakte Sektor-Offsets, REM DISCID, CATALOG/Barcode & Tracktitel)
    cue_files = sorted(folder_path.glob("*.cue"))
    if not cue_files and target_folder != folder_path:
        cue_files = sorted(target_folder.glob("*.cue"))

    if cue_files:
        try:
            raw_bytes = cue_files[0].read_bytes()
            try:
                cue_text = raw_bytes.decode("utf-8")
            except UnicodeDecodeError:
                cue_text = raw_bytes.decode("latin-1", errors="replace")

            in_track = False
            current_track: dict = {}
            cue_tracks: list[dict] = []
            offsets: list[int] = []

            for raw_line in cue_text.splitlines():
                line = raw_line.strip()
                if not line:
                    continue
                upper = line.upper()
                if upper.startswith("REM DISCID "):
                    val = line[11:].strip().strip('"').lower()
                    if re.fullmatch(r"[a-f0-9]{8}", val):
                        hints["cddb_id"] = val
                elif upper.startswith("REM MUSICBRAINZ_DISCID "):
                    hints["mb_disc_id"] = line[23:].strip().strip('"')
                elif upper.startswith("REM DATE ") or upper.startswith("REM YEAR "):
                    y_val = line.split(None, 2)[-1].strip().strip('"')
                    if len(y_val) >= 4 and y_val[:4].isdigit():
                        hints["year"] = y_val[:4]
                elif upper.startswith("REM GENRE "):
                    hints["genre"] = line[10:].strip().strip('"')
                elif upper.startswith("CATALOG "):
                    cat_val = line[8:].strip().strip('"')
                    if re.fullmatch(r"\d{8,14}", cat_val):
                        hints["barcode"] = cat_val
                    else:
                        hints["catalog_number"] = cat_val
                elif upper.startswith("PERFORMER ") and not in_track:
                    hints["artist"] = line[10:].strip().strip('"') or hints["artist"]
                elif upper.startswith("TITLE ") and not in_track:
                    hints["album"] = line[6:].strip().strip('"') or hints["album"]
                elif upper.startswith("TRACK "):
                    if current_track:
                        cue_tracks.append(current_track)
                    parts = line.split()
                    t_num = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else len(cue_tracks) + 1
                    current_track = {"track_number": t_num, "title": "", "artist": "", "isrc": ""}
                    in_track = True
                elif in_track and upper.startswith("TITLE "):
                    current_track["title"] = line[6:].strip().strip('"')
                elif in_track and upper.startswith("PERFORMER "):
                    current_track["artist"] = line[10:].strip().strip('"')
                elif in_track and upper.startswith("ISRC "):
                    current_track["isrc"] = line[5:].strip().strip('"')
                elif in_track and upper.startswith("INDEX 01 "):
                    t_str = line[9:].strip()
                    m_idx = re.match(r"^(\d+):(\d{1,2}):(\d{1,2})$", t_str)
                    if m_idx:
                        mm, ss, ff = int(m_idx.group(1)), int(m_idx.group(2)), int(m_idx.group(3))
                        frame = (mm * 60 + ss) * FRAMES_PER_SECOND + ff + PREGAP_OFFSET
                        offsets.append(frame)

            if current_track:
                cue_tracks.append(current_track)
            if offsets:
                hints["cue_track_offsets"] = offsets
            if cue_tracks:
                hints["cue_tracks"] = cue_tracks
        except Exception:
            pass

    return hints


def _add_extra_tag_values(extra_tags: dict[str, list[str]], key: str, values: list[str] | str) -> None:
    clean_key = str(key or "").strip()
    if not clean_key:
        return
    if isinstance(values, (str, bytes)):
        raw_list = [values.decode("utf-8", errors="replace") if isinstance(values, bytes) else values]
    else:
        raw_list = list(values)
    clean_vals = [str(v).strip() for v in raw_list if v is not None and str(v).strip()]
    if not clean_vals:
        return
    bucket = extra_tags.setdefault(clean_key, [])
    for v in clean_vals:
        if v not in bucket:
            bucket.append(v)


def _normalize_generic_extra_key(raw_key: str) -> str:
    k = str(raw_key or "").strip()
    if not k:
        return ""
    up = re.sub(r"[\s\-]+", "_", k.upper())
    alias_map = {
        "INITIALKEY": "KEY",
        "INITIAL_KEY": "KEY",
        "UNSYNCEDLYRICS": "LYRICS",
        "ACOUSTID_ID": "ACOUSTID_ID",
        "ACOUSTID_FINGERPRINT": "ACOUSTID_FINGERPRINT",
        "ACOUSTID_PUID": "ACOUSTID_PUID",
        "REPLAYGAIN_TRACK_GAIN": "REPLAYGAIN_TRACK_GAIN",
        "REPLAYGAIN_TRACK_PEAK": "REPLAYGAIN_TRACK_PEAK",
        "REPLAYGAIN_TRACK_RANGE": "REPLAYGAIN_TRACK_RANGE",
        "REPLAYGAIN_ALBUM_GAIN": "REPLAYGAIN_ALBUM_GAIN",
        "REPLAYGAIN_ALBUM_PEAK": "REPLAYGAIN_ALBUM_PEAK",
        "REPLAYGAIN_ALBUM_RANGE": "REPLAYGAIN_ALBUM_RANGE",
        "REPLAYGAIN_REFERENCE_LOUDNESS": "REPLAYGAIN_REFERENCE_LOUDNESS",
        "REPLAYGAIN_MINMAX": "REPLAYGAIN_MINMAX",
        "REPLAYGAIN_ALBUM_MINMAX": "REPLAYGAIN_ALBUM_MINMAX",
        "REPLAYGAIN_UNDO": "REPLAYGAIN_UNDO",
        "R128_TRACK_GAIN": "R128_TRACK_GAIN",
        "R128_ALBUM_GAIN": "R128_ALBUM_GAIN",
        "MUSICBRAINZ_ORIGINAL_ALBUM_ID": "MUSICBRAINZ_ORIGINALALBUMID",
        "MUSICBRAINZ_ORIGINAL_ARTIST_ID": "MUSICBRAINZ_ORIGINALARTISTID",
    }
    return alias_map.get(up, up)


def extract_local_audio_file_info(file_path: Path, fallback_track_num: int = 1) -> dict:
    """Liest exakte Spieldauer (Sekunden & CD-Sektoren), sämtliche vorhandenen Tags (inkl. ReplayGain, IDs & Custom-Tags) sowie eingebettetes Cover einer lokalen Audiodatei aus."""
    duration_float = 0.0
    title = ""
    artist = ""
    artist_sort = ""
    album_artist = ""
    album_artist_sort = ""
    album_title = ""
    year = ""
    release_date = ""
    original_date = ""
    genre = ""
    isrc = ""
    barcode = ""
    catalog_number = ""
    label = ""
    asin = ""
    country = ""
    status = ""
    release_type = ""
    media_format = ""
    script = ""
    language = ""
    disc_subtitle = ""
    mb_release_id = ""
    mb_release_group_id = ""
    mb_album_artist_id = ""
    mb_disc_id = ""
    mb_recording_id = ""
    mb_track_id = ""
    mb_artist_id = ""
    mb_work_id = ""
    mb_composer_id = ""
    embedded_cover_bytes: Optional[bytes] = None
    embedded_cover_mime = "image/jpeg"
    tag_track_num: Optional[int] = None
    tag_disc_num: Optional[int] = None

    artist_list: list[str] = []
    album_artist_list: list[str] = []
    isrc_list: list[str] = []
    composer = ""
    orchestra = ""
    conductor = ""
    lyricist = ""
    writer = ""
    producer = ""
    work = ""
    extra_tags: dict[str, list[str]] = {}

    def _merge_str_field(current: str, new_vals: list[str]) -> str:
        existing = [p.strip() for p in current.split(";") if p.strip()] if current else []
        for v in new_vals:
            sv = str(v or "").strip()
            if sv and sv not in existing:
                existing.append(sv)
        return "; ".join(existing)

    def _decode_tag_values(raw_val: object) -> list[str]:
        if raw_val is None:
            return []
        items = raw_val if isinstance(raw_val, (list, tuple)) else [raw_val]
        out: list[str] = []
        for item in items:
            if item is None:
                continue
            if isinstance(item, (bytes, bytearray)):
                try:
                    s = bytes(item).decode("utf-8").strip()
                except UnicodeDecodeError:
                    s = bytes(item).decode("latin-1", errors="replace").strip()
            else:
                s = str(item).strip()
            if s and s not in out:
                out.append(s)
        return out

    def _consume_named_tag(raw_key: str, vals: list[str]) -> None:
        nonlocal title, artist, artist_sort, album_artist, album_artist_sort, album_title
        nonlocal year, release_date, original_date, genre, isrc, barcode, catalog_number
        nonlocal label, asin, country, status, release_type, media_format, script, language
        nonlocal disc_subtitle, mb_release_id, mb_release_group_id, mb_album_artist_id
        nonlocal mb_disc_id, mb_recording_id, mb_track_id, mb_artist_id, mb_work_id
        nonlocal mb_composer_id, tag_track_num, tag_disc_num
        nonlocal artist_list, album_artist_list, isrc_list
        nonlocal composer, orchestra, conductor, lyricist, writer, producer, work

        if not vals:
            return
        k_clean = str(raw_key or "").strip()
        if not k_clean:
            return
        k_up = re.sub(r"[\s\-]+", "_", k_clean.upper())
        if k_up in ("METADATA_BLOCK_PICTURE", "COVERART", "COVERARTMIME", "APIC", "COVR"):
            return

        if k_up == "TITLE":
            if not title:
                title = "; ".join(vals)
        elif k_up == "ARTIST":
            if not artist:
                artist = "; ".join(vals)
        elif k_up == "ARTISTS":
            if not artist_list:
                artist_list = list(vals)
        elif k_up in ("ARTISTSORT", "ARTIST_SORT"):
            if not artist_sort:
                artist_sort = "; ".join(vals)
        elif k_up in ("ALBUMARTIST", "ALBUM_ARTIST"):
            if not album_artist:
                album_artist = "; ".join(vals)
        elif k_up in ("ALBUMARTISTS", "ALBUM_ARTISTS"):
            if not album_artist_list:
                album_artist_list = list(vals)
        elif k_up in ("ALBUMARTISTSORT", "ALBUM_ARTIST_SORT"):
            if not album_artist_sort:
                album_artist_sort = "; ".join(vals)
        elif k_up == "ALBUM":
            if not album_title:
                album_title = "; ".join(vals)
        elif k_up in ("TRACKNUMBER", "TRACK"):
            if tag_track_num is None:
                tag_track_num = _parse_pos_int_prefix(vals[0])
        elif k_up in ("DISCNUMBER", "DISC"):
            if tag_disc_num is None:
                tag_disc_num = _parse_pos_int_prefix(vals[0])
        elif k_up in ("TRACKTOTAL", "TOTALTRACKS", "DISCTOTAL", "TOTALDISCS"):
            pass
        elif k_up in ("DISCSUBTITLE", "DISC_SUBTITLE", "SETSUBTITLE"):
            if not disc_subtitle:
                disc_subtitle = "; ".join(vals)
        elif k_up in ("DATE", "YEAR"):
            if not release_date:
                release_date = vals[0]
            if not year and len(vals[0]) >= 4:
                year = vals[0][:4]
        elif k_up in ("ORIGINALDATE", "ORIGINAL_DATE", "ORIGINALYEAR", "ORIGINAL_YEAR"):
            if not original_date:
                original_date = vals[0]
            if not year and len(vals[0]) >= 4:
                year = vals[0][:4]
        elif k_up == "GENRE":
            genre = _merge_str_field(genre, vals)
        elif k_up == "ISRC":
            for iv in vals:
                if iv not in isrc_list:
                    isrc_list.append(iv)
            isrc = "; ".join(isrc_list)
        elif k_up in ("BARCODE", "EAN", "UPC"):
            if not barcode:
                barcode = "; ".join(vals)
        elif k_up in ("CATALOGNUMBER", "CATALOG", "CATALOG_NUMBER"):
            if not catalog_number:
                catalog_number = "; ".join(vals)
        elif k_up in ("LABEL", "PUBLISHER", "ORGANIZATION"):
            if not label:
                label = "; ".join(vals)
        elif k_up == "ASIN":
            if not asin:
                asin = "; ".join(vals)
        elif k_up in ("RELEASECOUNTRY", "MUSICBRAINZ_ALBUM_RELEASE_COUNTRY"):
            if not country:
                country = "; ".join(vals)
        elif k_up in ("RELEASESTATUS", "MUSICBRAINZ_ALBUM_STATUS"):
            if not status:
                status = "; ".join(vals)
        elif k_up in ("RELEASETYPE", "MUSICBRAINZ_ALBUM_TYPE"):
            if not release_type:
                release_type = "; ".join(vals)
        elif k_up == "MEDIA":
            if not media_format:
                media_format = "; ".join(vals)
        elif k_up == "SCRIPT":
            if not script:
                script = "; ".join(vals)
        elif k_up == "LANGUAGE":
            if not language:
                language = "; ".join(vals)
        elif k_up == "COMPOSER":
            composer = _merge_str_field(composer, vals)
        elif k_up in ("ORCHESTRA", "ENSEMBLE"):
            orchestra = _merge_str_field(orchestra, vals)
        elif k_up == "CONDUCTOR":
            conductor = _merge_str_field(conductor, vals)
        elif k_up == "LYRICIST":
            lyricist = _merge_str_field(lyricist, vals)
        elif k_up == "WRITER":
            writer = _merge_str_field(writer, vals)
        elif k_up == "PRODUCER":
            producer = _merge_str_field(producer, vals)
        elif k_up == "WORK":
            work = _merge_str_field(work, vals)
        elif k_up == "PERFORMER":
            orch_cands: list[str] = []
            other_perfs: list[str] = []
            for p_entry in vals:
                m_orch = re.match(
                    r"^\s*(.+?)\s*\((?:orchestra|performing orchestra|ensemble)\)\s*$",
                    p_entry,
                    re.IGNORECASE,
                )
                if m_orch:
                    orch_cands.append(m_orch.group(1).strip())
                else:
                    other_perfs.append(p_entry)
            if orch_cands:
                orchestra = _merge_str_field(orchestra, orch_cands)
            if other_perfs:
                _add_extra_tag_values(extra_tags, "PERFORMER", other_perfs)
        elif k_up in ("MUSICBRAINZ_ALBUMID", "MUSICBRAINZ_ALBUM_ID", "MUSICBRAINZ_RELEASEID", "MUSICBRAINZ_RELEASE_ID"):
            if not mb_release_id:
                mb_release_id = vals[0]
        elif k_up in ("MUSICBRAINZ_RELEASEGROUPID", "MUSICBRAINZ_RELEASE_GROUP_ID"):
            if not mb_release_group_id:
                mb_release_group_id = vals[0]
        elif k_up in ("MUSICBRAINZ_ALBUMARTISTID", "MUSICBRAINZ_ALBUM_ARTIST_ID"):
            if not mb_album_artist_id:
                mb_album_artist_id = "; ".join(vals)
        elif k_up in ("MUSICBRAINZ_DISCID", "MUSICBRAINZ_DISC_ID"):
            if not mb_disc_id:
                mb_disc_id = vals[0]
        elif k_up in ("MUSICBRAINZ_TRACKID", "MUSICBRAINZ_TRACK_ID", "MUSICBRAINZ_RECORDINGID", "MUSICBRAINZ_RECORDING_ID"):
            if not mb_recording_id:
                mb_recording_id = vals[0]
        elif k_up in ("MUSICBRAINZ_RELEASETRACKID", "MUSICBRAINZ_RELEASE_TRACK_ID"):
            if not mb_track_id:
                mb_track_id = vals[0]
        elif k_up in ("MUSICBRAINZ_ARTISTID", "MUSICBRAINZ_ARTIST_ID"):
            mb_artist_id = _merge_str_field(mb_artist_id, vals)
        elif k_up in ("MUSICBRAINZ_WORKID", "MUSICBRAINZ_WORK_ID"):
            mb_work_id = _merge_str_field(mb_work_id, vals)
        elif k_up in ("MUSICBRAINZ_COMPOSERID", "MUSICBRAINZ_COMPOSER_ID"):
            mb_composer_id = _merge_str_field(mb_composer_id, vals)
        else:
            norm_k = (
                f"PERFORMER:{k_clean.split(':', 1)[1].strip()}"
                if k_clean.upper().startswith("PERFORMER:")
                else _normalize_generic_extra_key(k_clean)
            )
            if norm_k:
                _add_extra_tag_values(extra_tags, norm_k, vals)

    # 1. Versuch über mutagen (unterstützt FLAC, MP3, OGG, M4A, AIFF, WAV, OPUS, DSF, TTA, WV, APE)
    try:
        import mutagen  # type: ignore

        mfile = mutagen.File(str(file_path), easy=True)
        if mfile is not None:
            if getattr(mfile, "info", None) and getattr(mfile.info, "length", 0):
                duration_float = float(mfile.info.length)
            tags = getattr(mfile, "tags", None)
            if tags:
                title = _first_tag_str(tags, ("title",))
                artist = _first_tag_str(tags, ("artist",))
                artist_list = _all_tag_strs(tags, ("artists",))
                artist_sort = _first_tag_str(tags, ("artistsort",))
                album_artist = _first_tag_str(tags, ("albumartist", "album artist"))
                album_artist_list = _all_tag_strs(tags, ("albumartists",))
                album_artist_sort = _first_tag_str(tags, ("albumartistsort",))
                album_title = _first_tag_str(tags, ("album",))
                release_date = _first_tag_str(tags, ("date", "year"))
                original_date = _first_tag_str(tags, ("originaldate",))
                year = (release_date or original_date)[:4]
                genre = _first_tag_str(tags, ("genre",))
                isrc_list = _all_tag_strs(tags, ("isrc",))
                isrc = "; ".join(isrc_list)
                barcode = _first_tag_str(tags, ("barcode", "ean", "upc"))
                catalog_number = _first_tag_str(tags, ("catalognumber", "catalog"))
                label = _first_tag_str(tags, ("label", "publisher", "organization"))
                asin = _first_tag_str(tags, ("asin",))
                country = _first_tag_str(tags, ("releasecountry",))
                status = _first_tag_str(tags, ("releasestatus",))
                release_type = _first_tag_str(tags, ("releasetype",))
                media_format = _first_tag_str(tags, ("media",))
                language = _first_tag_str(tags, ("language",))
                disc_subtitle = _first_tag_str(tags, ("discsubtitle",))
                composer = _first_tag_str(tags, ("composer",))
                conductor = _first_tag_str(tags, ("conductor",))
                lyricist = _first_tag_str(tags, ("lyricist",))
                mb_release_id = _first_tag_str(tags, ("musicbrainz_albumid", "musicbrainz album id"))
                mb_release_group_id = _first_tag_str(tags, ("musicbrainz_releasegroupid",))
                mb_album_artist_id = _first_tag_str(tags, ("musicbrainz_albumartistid",))
                mb_disc_id = _first_tag_str(tags, ("musicbrainz_discid",))
                mb_recording_id = _first_tag_str(tags, ("musicbrainz_trackid",))
                mb_track_id = _first_tag_str(tags, ("musicbrainz_releasetrackid",))
                mb_artist_id = _first_tag_str(tags, ("musicbrainz_artistid",))
                mb_work_id = _first_tag_str(tags, ("musicbrainz_workid",))
                tag_track_num = _parse_pos_int_prefix(_first_tag_str(tags, ("tracknumber", "track")))
                tag_disc_num = _parse_pos_int_prefix(_first_tag_str(tags, ("discnumber", "disc", "tpos")))

        # Rohe Tags (Vorbis, ID3v2, MP4/M4A, APEv2) vollständig auslesen
        raw_mfile = mutagen.File(str(file_path), easy=False)
        if raw_mfile is not None:
            if duration_float <= 0.0 and getattr(raw_mfile, "info", None) and getattr(raw_mfile.info, "length", 0):
                duration_float = float(raw_mfile.info.length)
            pics = getattr(raw_mfile, "pictures", None)
            if pics and len(pics) > 0 and getattr(pics[0], "data", None):
                embedded_cover_bytes = bytes(pics[0].data)
                embedded_cover_mime = str(getattr(pics[0], "mime", "image/jpeg") or "image/jpeg")

            rtags = getattr(raw_mfile, "tags", None)
            if rtags is not None and hasattr(rtags, "keys"):
                # Prüfen ob ID3v2, MP4 oder Vorbis/APEv2 vorliegt
                is_id3_like = any(
                    re.match(r"^(?:TIT2|TPE1|TALB|TRCK|TXXX|APIC|UFID|COMM|RVA2)", str(k))
                    for k in list(rtags.keys())[:40]
                ) or type(rtags).__name__.upper().startswith("ID3")
                is_mp4_like = type(rtags).__name__.upper().startswith("MP4") or any(
                    str(k).startswith(("----:", "\xa9")) for k in list(rtags.keys())[:40]
                )

                if is_id3_like:
                    id3_simple_map: dict[str, str] = {
                        "TIT2": "TITLE",
                        "TPE1": "ARTIST",
                        "TPE2": "ALBUMARTIST",
                        "TALB": "ALBUM",
                        "TRCK": "TRACKNUMBER",
                        "TPOS": "DISCNUMBER",
                        "TSST": "DISCSUBTITLE",
                        "TDRC": "DATE",
                        "TYER": "DATE",
                        "TDOR": "ORIGINALDATE",
                        "TORY": "ORIGINALDATE",
                        "TCON": "GENRE",
                        "TPUB": "LABEL",
                        "TCOM": "COMPOSER",
                        "TPE3": "CONDUCTOR",
                        "TPE4": "REMIXER",
                        "TEXT": "LYRICIST",
                        "TMED": "MEDIA",
                        "TLAN": "LANGUAGE",
                        "TSRC": "ISRC",
                        "TSOP": "ARTISTSORT",
                        "TSO2": "ALBUMARTISTSORT",
                        "TSOA": "ALBUMSORT",
                        "TSOT": "TITLESORT",
                        "TSOC": "COMPOSERSORT",
                        "TIT1": "GROUPING",
                        "TIT3": "SUBTITLE",
                        "TCOP": "COPYRIGHT",
                        "TCMP": "COMPILATION",
                        "TBPM": "BPM",
                        "TKEY": "KEY",
                        "TMOO": "MOOD",
                        "TENC": "ENCODEDBY",
                        "TSSE": "ENCODERSETTINGS",
                        "TOFN": "ORIGINALFILENAME",
                        "MVNM": "MOVEMENTNAME",
                        "MVIN": "MOVEMENT",
                    }
                    for k in list(rtags.keys()):
                        ks = str(k)
                        frame = rtags[k]
                        if ks.startswith("APIC") and embedded_cover_bytes is None:
                            if getattr(frame, "data", None):
                                embedded_cover_bytes = bytes(frame.data)
                                embedded_cover_mime = str(getattr(frame, "mime", "image/jpeg") or "image/jpeg")
                        elif ks in id3_simple_map:
                            raw_list = getattr(frame, "text", None)
                            vals = (
                                [str(x).strip() for x in raw_list if str(x).strip()]
                                if raw_list is not None
                                else ([str(frame).strip()] if str(frame).strip() else [])
                            )
                            _consume_named_tag(id3_simple_map[ks], vals)
                        elif ks.startswith("TXXX:"):
                            desc = str(getattr(frame, "desc", ks.split(":", 1)[1]) or "").strip()
                            vals = [str(x).strip() for x in (getattr(frame, "text", []) or []) if str(x).strip()]
                            if desc and vals:
                                _consume_named_tag(desc, vals)
                        elif ks.startswith("UFID"):
                            owner = str(getattr(frame, "owner", "") or "").strip().lower()
                            data = getattr(frame, "data", None)
                            if "musicbrainz.org" in owner and data and not mb_recording_id:
                                try:
                                    mb_recording_id = bytes(data).decode("ascii", errors="ignore").strip()
                                except Exception:
                                    pass
                        elif ks.startswith("RVA2"):
                            ident = str(getattr(frame, "desc", ks.split(":", 1)[1] if ":" in ks else "") or "").strip().lower()
                            gain = getattr(frame, "gain", None)
                            peak = getattr(frame, "peak", None)
                            if ident in ("track", ""):
                                if gain is not None and "REPLAYGAIN_TRACK_GAIN" not in extra_tags:
                                    _add_extra_tag_values(extra_tags, "REPLAYGAIN_TRACK_GAIN", [f"{float(gain):+.2f} dB"])
                                if peak is not None and float(peak) > 0 and "REPLAYGAIN_TRACK_PEAK" not in extra_tags:
                                    _add_extra_tag_values(extra_tags, "REPLAYGAIN_TRACK_PEAK", [f"{float(peak):.6f}"])
                            elif ident == "album":
                                if gain is not None and "REPLAYGAIN_ALBUM_GAIN" not in extra_tags:
                                    _add_extra_tag_values(extra_tags, "REPLAYGAIN_ALBUM_GAIN", [f"{float(gain):+.2f} dB"])
                                if peak is not None and float(peak) > 0 and "REPLAYGAIN_ALBUM_PEAK" not in extra_tags:
                                    _add_extra_tag_values(extra_tags, "REPLAYGAIN_ALBUM_PEAK", [f"{float(peak):.6f}"])
                        elif ks in ("TMCL", "TIPL", "IPLS") and hasattr(frame, "people"):
                            for pair in getattr(frame, "people", []) or []:
                                if len(pair) >= 2:
                                    r_name = str(pair[0] or "").strip()
                                    r_low = r_name.lower()
                                    p_name = str(pair[1] or "").strip()
                                    if not p_name:
                                        continue
                                    if r_low in ("orchestra", "performing orchestra", "ensemble"):
                                        orchestra = _merge_str_field(orchestra, [p_name])
                                    elif r_low == "producer":
                                        producer = _merge_str_field(producer, [p_name])
                                    elif r_low == "arranger":
                                        _add_extra_tag_values(extra_tags, "ARRANGER", [p_name])
                                    elif r_low == "engineer":
                                        _add_extra_tag_values(extra_tags, "ENGINEER", [p_name])
                                    elif r_low in ("mix", "mixer"):
                                        _add_extra_tag_values(extra_tags, "MIXER", [p_name])
                                    elif r_low in ("dj-mix", "djmixer"):
                                        _add_extra_tag_values(extra_tags, "DJMIXER", [p_name])
                                    else:
                                        role_key = f"PERFORMER:{r_name}" if r_name and r_low != "performer" else "PERFORMER"
                                        _add_extra_tag_values(extra_tags, role_key, [p_name])
                        elif ks == "COMM" or ks.startswith("COMM:"):
                            vals = [str(x).strip() for x in (getattr(frame, "text", []) or []) if str(x).strip()]
                            if vals:
                                _add_extra_tag_values(extra_tags, "COMMENT", vals)
                        elif ks == "USLT" or ks.startswith("USLT:"):
                            txt = str(getattr(frame, "text", "") or "").strip()
                            if txt:
                                _add_extra_tag_values(extra_tags, "LYRICS", [txt])
                        elif ks == "WCOP" or ks.startswith("WCOP:"):
                            url_v = str(getattr(frame, "url", "") or "").strip()
                            if url_v:
                                _add_extra_tag_values(extra_tags, "LICENSE", [url_v])
                        elif ks == "WOAR" or ks.startswith("WOAR:"):
                            url_v = str(getattr(frame, "url", "") or "").strip()
                            if url_v:
                                _add_extra_tag_values(extra_tags, "WEBSITE", [url_v])

                elif is_mp4_like:
                    mp4_map: dict[str, str] = {
                        "\xa9nam": "TITLE",
                        "\xa9ART": "ARTIST",
                        "aART": "ALBUMARTIST",
                        "\xa9alb": "ALBUM",
                        "\xa9day": "DATE",
                        "\xa9gen": "GENRE",
                        "\xa9wrt": "COMPOSER",
                        "\xa9cmt": "COMMENT",
                        "\xa9lyr": "LYRICS",
                        "\xa9grp": "GROUPING",
                        "\xa9too": "ENCODEDBY",
                        "cprt": "COPYRIGHT",
                        "soar": "ARTISTSORT",
                        "soaa": "ALBUMARTISTSORT",
                        "soal": "ALBUMSORT",
                        "sonm": "TITLESORT",
                        "soco": "COMPOSERSORT",
                        "\xa9mvn": "MOVEMENTNAME",
                        "\xa9wrk": "WORK",
                    }
                    for k in list(rtags.keys()):
                        ks = str(k)
                        raw_v = rtags[k]
                        if ks == "covr" and raw_v and embedded_cover_bytes is None:
                            embedded_cover_bytes = bytes(raw_v[0])
                            embedded_cover_mime = "image/jpeg"
                        elif ks == "trkn" and raw_v and tag_track_num is None:
                            first_pair = raw_v[0]
                            if isinstance(first_pair, (list, tuple)) and first_pair and first_pair[0]:
                                tag_track_num = int(first_pair[0])
                        elif ks == "disk" and raw_v and tag_disc_num is None:
                            first_pair = raw_v[0]
                            if isinstance(first_pair, (list, tuple)) and first_pair and first_pair[0]:
                                tag_disc_num = int(first_pair[0])
                        elif ks == "tmpo" and raw_v:
                            _add_extra_tag_values(extra_tags, "BPM", [str(raw_v[0])])
                        elif ks == "cpil" and raw_v:
                            _add_extra_tag_values(extra_tags, "COMPILATION", ["1" if raw_v else "0"])
                        elif ks in mp4_map:
                            _consume_named_tag(mp4_map[ks], _decode_tag_values(raw_v))
                        elif ks.startswith("----:"):
                            parts = ks.split(":", 2)
                            desc = parts[2].strip() if len(parts) >= 3 else ks
                            _consume_named_tag(desc, _decode_tag_values(raw_v))

                else:
                    # Vorbis Comments (FLAC, OGG, Opus) & APEv2 (WavPack, APE, MPC) – alle Keys case-insensitiv einlesen
                    for k in list(rtags.keys()):
                        ks = str(k).strip()
                        if not ks or ks.startswith("__"):
                            continue
                        raw_v = rtags[k]
                        # Binäre Cover-Elemente in APEv2 überspringen
                        if getattr(raw_v, "kind", None) == 1:
                            continue
                        vals = _decode_tag_values(raw_v)
                        if vals:
                            _consume_named_tag(ks, vals)

        # Zusätzlich APEv2-Footer-Tags auf MP3/MP2-Dateien prüfen (z. B. von mp3gain / foobar2000 / loudgain geschrieben!)
        if file_path.suffix.lower() in (".mp3", ".mp2", ".mpc", ".wv", ".ape"):
            try:
                from mutagen.apev2 import APEv2  # type: ignore

                ape = APEv2(str(file_path))
                for ak in list(ape.keys()):
                    aks = str(ak).strip()
                    aval = ape[ak]
                    if getattr(aval, "kind", None) == 1:
                        continue
                    avals = _decode_tag_values(aval)
                    if avals:
                        _consume_named_tag(aks, avals)
            except Exception:
                pass
    except Exception:
        pass

    # 2. Fallback für unkomprimierte WAV-Dateien über Standardbibliothek wave
    if duration_float <= 0.0 and file_path.suffix.lower() == ".wav":
        try:
            import wave

            with wave.open(str(file_path), "rb") as wf:
                frames = wf.getnframes()
                rate = wf.getframerate()
                if rate > 0 and frames > 0:
                    duration_float = float(frames) / float(rate)
        except Exception:
            pass

    # 3. Fallback über ffprobe (falls installiert)
    if duration_float <= 0.0:
        try:
            proc = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    str(file_path),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=6,
                text=True,
            )
            out_str = (proc.stdout or "").strip()
            if out_str:
                duration_float = float(out_str)
        except Exception:
            pass

    if duration_float <= 0.0:
        duration_float = 180.0

    # Dateiname analysieren für Tracknummer, Discnummer & Titel-Fallback
    stem = file_path.stem.strip()
    filename_disc_num: Optional[int] = None
    filename_track_num: Optional[int] = None
    parsed_title = ""

    m_cd = _DISC_CD_PREFIX_TRACK_RE.match(stem)
    if m_cd:
        filename_disc_num = max(1, int(m_cd.group(1)))
        filename_track_num = max(1, int(m_cd.group(2)))
        parsed_title = m_cd.group(3).strip()
    else:
        m_num = _TRACK_FILENAME_RE.match(stem)
        if m_num:
            if m_num.group(1):
                filename_disc_num = max(1, int(m_num.group(1)))
            filename_track_num = max(1, int(m_num.group(2)))
            parsed_title = m_num.group(3).strip()

    if not title:
        if parsed_title:
            if " - " in parsed_title and not artist:
                cand_art, _, cand_tit = parsed_title.partition(" - ")
                if cand_art.strip() and cand_tit.strip():
                    artist = cand_art.strip()
                    title = cand_tit.strip()
                else:
                    title = parsed_title
            else:
                title = parsed_title
        else:
            title = stem or f"Titel {fallback_track_num:02d}"

    explicit_track_num = tag_track_num if tag_track_num is not None else filename_track_num
    track_num = explicit_track_num if explicit_track_num is not None else fallback_track_num

    sectors = max(FRAMES_PER_SECOND, int(round(duration_float * FRAMES_PER_SECOND)))
    return {
        "track_number": track_num,
        "has_explicit_track_number": explicit_track_num is not None,
        "tag_disc_number": tag_disc_num,
        "filename_disc_number": filename_disc_num,
        "disc_number": tag_disc_num or filename_disc_num or 1,
        "title": title,
        "artist": artist,
        "artists": artist_list,
        "artist_sort": artist_sort,
        "album_artist": album_artist,
        "album_artists": album_artist_list,
        "album_artist_sort": album_artist_sort,
        "album_title": album_title,
        "year": year,
        "release_date": release_date,
        "original_date": original_date,
        "genre": genre,
        "isrc": isrc,
        "isrcs": isrc_list,
        "barcode": barcode,
        "catalog_number": catalog_number,
        "label": label,
        "asin": asin,
        "country": country,
        "status": status,
        "release_type": release_type,
        "media_format": media_format,
        "script": script,
        "language": language,
        "disc_subtitle": disc_subtitle,
        "composer": composer,
        "orchestra": orchestra,
        "conductor": conductor,
        "lyricist": lyricist,
        "writer": writer,
        "producer": producer,
        "work": work,
        "extra_tags": extra_tags,
        "mb_release_id": mb_release_id,
        "mb_release_group_id": mb_release_group_id,
        "mb_album_artist_id": mb_album_artist_id,
        "mb_disc_id": mb_disc_id,
        "mb_recording_id": mb_recording_id,
        "mb_track_id": mb_track_id,
        "mb_artist_id": mb_artist_id,
        "mb_work_id": mb_work_id,
        "mb_composer_id": mb_composer_id,
        "embedded_cover_bytes": embedded_cover_bytes,
        "embedded_cover_mime": embedded_cover_mime,
        "duration_float": duration_float,
        "duration_seconds": max(1, int(round(duration_float))),
        "sectors": sectors,
    }


def synthesize_toc_from_tracks(
    album: AlbumMetadata,
    exact_sector_counts: Optional[list[int]] = None,
    pregap_frames: int = PREGAP_OFFSET,
    renumber_single_disc: bool = False,
) -> AlbumMetadata:
    """Generiert eine vollständige Red-Book-CD-TOC (Sektor-Offsets, CDDB-ID, MusicBrainz-DiscID & TOC-String) aus Tracks/Dateien ohne physische CD."""
    if not album.tracks:
        album.cddb_id = ""
        album.musicbrainz_disc_id = ""
        album.musicbrainz_toc = ""
        album.track_offsets = []
        album.leadout_offset = 0
        return album

    distinct_discs = {max(1, getattr(t, "disc_number", 1) or 1) for t in album.tracks}
    is_multi_disc = len(distinct_discs) > 1
    frame_offsets: list[int] = []
    current_lsn = 0

    for idx, trk in enumerate(album.tracks):
        trk.disc_number = max(1, getattr(trk, "disc_number", 1) or 1)
        if not is_multi_disc and renumber_single_disc:
            trk.track_number = idx + 1
        elif trk.track_number <= 0:
            trk.track_number = idx + 1
        if exact_sector_counts and idx < len(exact_sector_counts) and exact_sector_counts[idx] > 0:
            sectors = exact_sector_counts[idx]
        elif trk.end_lsn > trk.start_lsn:
            sectors = trk.end_lsn - trk.start_lsn + 1
        elif trk.source_file and trk.source_file.exists():
            info = extract_local_audio_file_info(trk.source_file, fallback_track_num=trk.track_number)
            sectors = info["sectors"]
            if not trk.duration_seconds:
                trk.duration_seconds = info["duration_seconds"]
        else:
            sectors = max(FRAMES_PER_SECOND, int(round(max(1, trk.duration_seconds) * FRAMES_PER_SECOND)))

        trk.start_lsn = current_lsn
        trk.end_lsn = current_lsn + sectors - 1
        frame_offsets.append(current_lsn + pregap_frames)
        current_lsn += sectors

    leadout_offset = current_lsn + pregap_frames
    first_offset_sec = frame_offsets[0] // FRAMES_PER_SECOND
    leadout_sec = leadout_offset // FRAMES_PER_SECOND
    total_disc_seconds = max(1, leadout_sec - first_offset_sec)

    num_tracks = len(album.tracks)
    album.track_offsets = frame_offsets
    album.leadout_offset = leadout_offset
    album.cddb_id = calculate_cddb_disc_id(frame_offsets, total_disc_seconds)
    album.musicbrainz_disc_id = calculate_musicbrainz_disc_id(1, num_tracks, leadout_offset, frame_offsets)
    album.musicbrainz_toc = f"1 {num_tracks} {leadout_offset} " + " ".join(str(o) for o in frame_offsets)
    if not album.metadata_source or album.metadata_source.startswith("Lokal"):
        album.metadata_source = "Lokal (Datei-TOC)"
    return album


def _natural_sort_key(path: Path) -> list:
    parts = re.split(r"(\d+)", path.name.lower())
    return [int(p) if p.isdigit() else p for p in parts]


def _natural_str_key(text: str) -> list:
    parts = re.split(r"(\d+)", str(text or "").lower())
    return [int(p) if p.isdigit() else p for p in parts]


def build_album_from_local_files(
    file_paths: list[Path],
    existing_album: Optional[AlbumMetadata] = None,
    append: bool = False,
) -> AlbumMetadata:
    """Importiert lokale Audiodateien (oder ein komplettes Multi-CD-Album-Verzeichnis), erkennt Bilder & CUE-Sheets und generiert eine virtuelle CD-TOC."""
    valid_exts = {
        ".wav",
        ".flac",
        ".mp3",
        ".mp2",
        ".ogg",
        ".aiff",
        ".aif",
        ".aifc",
        ".dsf",
        ".tta",
        ".m4a",
        ".mp4",
        ".opus",
        ".wv",
    }
    collected_entries: list[tuple[Path, Optional[Path]]] = []
    seen_paths: set[Path] = set()
    primary_folder: Optional[Path] = None

    for p in file_paths:
        if p.is_dir():
            if primary_folder is None:
                primary_folder = p
            for child in sorted(p.rglob("*"), key=lambda c: _natural_str_key(str(c))):
                if child.is_file() and child.suffix.lower() in valid_exts:
                    resolved = child.resolve()
                    if resolved not in seen_paths:
                        seen_paths.add(resolved)
                        collected_entries.append((child, p))
        elif p.is_file() and p.suffix.lower() in valid_exts:
            if primary_folder is None:
                primary_folder = p.parent
            resolved = p.resolve()
            if resolved not in seen_paths:
                seen_paths.add(resolved)
                collected_entries.append((p, p.parent))

    if not collected_entries:
        return existing_album or AlbumMetadata()

    if primary_folder is None:
        primary_folder = collected_entries[0][0].parent

    # Dateien auslesen und nach (CD-Nummer, relativem Unterordner, Titelnummer, Dateiname) sortieren
    scanned_items: list[dict] = []
    for idx, (path, root_dir) in enumerate(collected_entries):
        info = extract_local_audio_file_info(path, fallback_track_num=idx + 1)
        folder_disc = _detect_disc_from_relative_path(path, root_dir)
        resolved_disc = max(
            1,
            folder_disc
            or info.get("tag_disc_number")
            or info.get("filename_disc_number")
            or 1,
        )
        try:
            rel_parent = str(path.parent.relative_to(root_dir)) if root_dir else ""
        except Exception:
            rel_parent = path.parent.name
        sort_track_num = info["track_number"] if info.get("has_explicit_track_number") else 999999
        scanned_items.append(
            {
                "path": path,
                "info": info,
                "disc_number": resolved_disc,
                "rel_parent": rel_parent,
                "sort_track_num": sort_track_num,
            }
        )

    scanned_items.sort(
        key=lambda item: (
            item["disc_number"],
            _natural_str_key(item["rel_parent"]),
            item["sort_track_num"],
            _natural_sort_key(item["path"]),
        )
    )
    audio_files = [item["path"] for item in scanned_items]

    folder_hints = parse_cue_or_folder_hints(primary_folder)
    folder_cover_bytes, folder_cover_mime, folder_cover_name = find_folder_cover_image(primary_folder)

    album = existing_album if (append and existing_album is not None) else AlbumMetadata()
    sector_counts: list[int] = [
        max(
            FRAMES_PER_SECOND,
            (t.end_lsn - t.start_lsn + 1)
            if t.end_lsn > t.start_lsn
            else t.duration_seconds * FRAMES_PER_SECOND,
        )
        for t in album.tracks
    ]

    detected_album_title = ""
    detected_artist = ""
    detected_album_artist = ""
    detected_album_artists: list[str] = []
    detected_album_artist_sort = ""
    detected_composer = ""
    detected_orchestra = ""
    detected_conductor = ""
    detected_year = ""
    detected_release_date = ""
    detected_original_date = ""
    detected_genre = ""
    detected_barcode = ""
    detected_catno = ""
    detected_label = ""
    detected_asin = ""
    detected_country = ""
    detected_status = ""
    detected_release_type = ""
    detected_media_format = ""
    detected_script = ""
    detected_language = ""
    detected_disc_subtitle = ""
    detected_mbid = ""
    detected_mb_rg_id = ""
    detected_mb_aa_id = ""
    detected_mb_disc_id = ""
    embedded_cover: Optional[bytes] = None
    embedded_mime = "image/jpeg"

    cue_tracks = folder_hints.get("cue_tracks") or []
    per_disc_fallback_counters: dict[int, int] = {}
    if append:
        for existing_t in album.tracks:
            d = max(1, getattr(existing_t, "disc_number", 1) or 1)
            per_disc_fallback_counters[d] = max(per_disc_fallback_counters.get(d, 0), existing_t.track_number)

    for offset, item in enumerate(scanned_items):
        path = item["path"]
        info = item["info"]
        disc_num = item["disc_number"]
        per_disc_fallback_counters[disc_num] = per_disc_fallback_counters.get(disc_num, 0) + 1
        trk_num = (
            info["track_number"]
            if info.get("has_explicit_track_number")
            else per_disc_fallback_counters[disc_num]
        )
        per_disc_fallback_counters[disc_num] = max(per_disc_fallback_counters[disc_num], trk_num)

        if not detected_album_title and info["album_title"]:
            detected_album_title = info["album_title"]
        if not detected_artist and info["artist"]:
            detected_artist = info["artist"]
        if not detected_album_artist and info["album_artist"]:
            detected_album_artist = info["album_artist"]
        if not detected_album_artists and info.get("album_artists"):
            detected_album_artists = list(info["album_artists"])
        if not detected_album_artist_sort and info.get("album_artist_sort"):
            detected_album_artist_sort = str(info["album_artist_sort"])
        if not detected_composer and info.get("composer"):
            detected_composer = str(info["composer"])
        if not detected_orchestra and info.get("orchestra"):
            detected_orchestra = str(info["orchestra"])
        if not detected_conductor and info.get("conductor"):
            detected_conductor = str(info["conductor"])
        if not detected_year and info["year"]:
            detected_year = info["year"]
        if not detected_release_date and info.get("release_date"):
            detected_release_date = str(info["release_date"])
        if not detected_original_date and info.get("original_date"):
            detected_original_date = str(info["original_date"])
        if not detected_genre and info["genre"]:
            detected_genre = info["genre"]
        if not detected_barcode and info["barcode"]:
            detected_barcode = info["barcode"]
        if not detected_catno and info["catalog_number"]:
            detected_catno = info["catalog_number"]
        if not detected_label and info["label"]:
            detected_label = info["label"]
        if not detected_asin and info.get("asin"):
            detected_asin = str(info["asin"])
        if not detected_country and info.get("country"):
            detected_country = str(info["country"])
        if not detected_status and info.get("status"):
            detected_status = str(info["status"])
        if not detected_release_type and info.get("release_type"):
            detected_release_type = str(info["release_type"])
        if not detected_media_format and info.get("media_format"):
            detected_media_format = str(info["media_format"])
        if not detected_script and info.get("script"):
            detected_script = str(info["script"])
        if not detected_language and info.get("language"):
            detected_language = str(info["language"])
        if not detected_disc_subtitle and info.get("disc_subtitle"):
            detected_disc_subtitle = str(info["disc_subtitle"])
        if not detected_mbid and info["mb_release_id"]:
            detected_mbid = info["mb_release_id"]
        if not detected_mb_rg_id and info.get("mb_release_group_id"):
            detected_mb_rg_id = str(info["mb_release_group_id"])
        if not detected_mb_aa_id and info.get("mb_album_artist_id"):
            detected_mb_aa_id = str(info["mb_album_artist_id"])
        if not detected_mb_disc_id and info.get("mb_disc_id"):
            detected_mb_disc_id = str(info["mb_disc_id"])
        if embedded_cover is None and info["embedded_cover_bytes"]:
            embedded_cover = info["embedded_cover_bytes"]
            embedded_mime = info["embedded_cover_mime"]

        cue_trk = cue_tracks[offset] if offset < len(cue_tracks) else {}
        trk_title = info["title"]
        if (not trk_title or trk_title.lower().startswith("track") or trk_title.lower().startswith("titel")) and cue_trk.get("title"):
            trk_title = cue_trk["title"]

        trk_artist = info["artist"] or cue_trk.get("artist") or detected_artist or folder_hints.get("artist") or album.artist
        trk_isrc = info["isrc"] or cue_trk.get("isrc") or ""

        sector_counts.append(info["sectors"])
        album.tracks.append(
            TrackMetadata(
                track_number=trk_num,
                title=trk_title,
                artist=trk_artist,
                artists=list(info.get("artists") or []),
                artist_sort=str(info.get("artist_sort") or ""),
                duration_seconds=info["duration_seconds"],
                genre=str(info.get("genre") or ""),
                isrc=trk_isrc,
                isrcs=list(info.get("isrcs") or ([trk_isrc] if trk_isrc else [])),
                composer=str(info.get("composer") or ""),
                orchestra=str(info.get("orchestra") or ""),
                conductor=str(info.get("conductor") or ""),
                lyricist=str(info.get("lyricist") or ""),
                writer=str(info.get("writer") or ""),
                producer=str(info.get("producer") or ""),
                work=str(info.get("work") or ""),
                work_language=str(info.get("language") or ""),
                disc_subtitle=str(info.get("disc_subtitle") or ""),
                musicbrainz_recording_id=str(info.get("mb_recording_id") or ""),
                musicbrainz_track_id=str(info.get("mb_track_id") or ""),
                musicbrainz_artist_id=str(info.get("mb_artist_id") or ""),
                musicbrainz_work_id=str(info.get("mb_work_id") or ""),
                musicbrainz_composer_id=str(info.get("mb_composer_id") or ""),
                extra_tags=dict(info.get("extra_tags") or {}),
                source_file=path,
                metadata_source="Lokal (Ordner-Import)",
                disc_number=disc_num,
            )
        )

    if not append or album.title in ("", "Unbekanntes Album", "Audio-CD (Lokal ausgelesen)"):
        album.title = (
            detected_album_title
            or folder_hints.get("album")
            or (primary_folder.name if primary_folder else "Importiertes Album")
        )
    if not append or album.artist in ("", "Unbekannter Künstler"):
        album.artist = (
            detected_artist
            or detected_album_artist
            or folder_hints.get("artist")
            or "Unbekannter Künstler"
        )
    if not album.album_artist or album.album_artist == "Unbekannter Künstler":
        album.album_artist = detected_album_artist or folder_hints.get("artist") or album.artist
    if detected_album_artists and not album.album_artists:
        album.album_artists = detected_album_artists
    if detected_album_artist_sort and not album.album_artist_sort:
        album.album_artist_sort = detected_album_artist_sort
    if detected_composer and not album.composer:
        album.composer = detected_composer
    if detected_orchestra and not album.orchestra:
        album.orchestra = detected_orchestra
    if detected_conductor and not album.conductor:
        album.conductor = detected_conductor
    if (detected_year or folder_hints.get("year")) and not album.year:
        album.year = detected_year or folder_hints.get("year", "")
    if detected_release_date and not album.release_date:
        album.release_date = detected_release_date
    if detected_original_date and not album.original_date:
        album.original_date = detected_original_date
    if (detected_genre or folder_hints.get("genre")) and not album.genre:
        album.genre = detected_genre or folder_hints.get("genre", "")
    if (detected_barcode or folder_hints.get("barcode")) and not album.barcode:
        album.barcode = detected_barcode or folder_hints.get("barcode", "")
    if (detected_catno or folder_hints.get("catalog_number")) and not album.catalog_number:
        album.catalog_number = detected_catno or folder_hints.get("catalog_number", "")
    if detected_label and not album.label:
        album.label = detected_label
    if detected_asin and not album.asin:
        album.asin = detected_asin
    if detected_country and not album.country:
        album.country = detected_country
    if detected_status and not album.status:
        album.status = detected_status
    if detected_release_type and not album.release_type:
        album.release_type = detected_release_type
    if detected_media_format and not album.media_format:
        album.media_format = detected_media_format
    if detected_script and not album.script:
        album.script = detected_script
    if detected_language and not album.language:
        album.language = detected_language
    if detected_disc_subtitle and not album.disc_subtitle:
        album.disc_subtitle = detected_disc_subtitle
    if detected_mbid and not album.musicbrainz_release_id:
        album.musicbrainz_release_id = detected_mbid
    if detected_mb_rg_id and not album.musicbrainz_release_group_id:
        album.musicbrainz_release_group_id = detected_mb_rg_id
    if detected_mb_aa_id and not album.musicbrainz_album_artist_id:
        album.musicbrainz_album_artist_id = detected_mb_aa_id
    if detected_mb_disc_id and not album.musicbrainz_disc_id:
        album.musicbrainz_disc_id = detected_mb_disc_id

    disc_counts: dict[int, int] = {}
    for trk in album.tracks:
        d = max(1, getattr(trk, "disc_number", 1) or 1)
        disc_counts[d] = disc_counts.get(d, 0) + 1
    distinct_discs = sorted(disc_counts.keys()) or [1]
    album.total_discs = max(album.total_discs, len(distinct_discs), max(distinct_discs))
    if len(distinct_discs) > 1:
        album.available_discs = [
            {"position": d, "title": "", "format": album.media_format or "CD", "track_count": disc_counts[d]}
            for d in distinct_discs
        ]
        album.disc_number = distinct_discs[0]
    elif distinct_discs[0] > 1:
        album.disc_number = distinct_discs[0]
    elif folder_hints.get("disc_number", 1) > 1 and album.disc_number == 1:
        album.disc_number = int(folder_hints["disc_number"])

    # Vorhandene Cover-Bilder im Verzeichnis (oder eingebettetes Cover) im Originalformat für die Vorschau übernehmen
    # (Konvertierung nach JPEG erfolgt erst direkt vor dem Einbetten in die Audiodateien)
    if folder_cover_bytes:
        w, h, orig_fmt = inspect_cover_image(folder_cover_bytes, folder_cover_mime)
        album.cover_art_bytes = folder_cover_bytes
        album.cover_art_mime = folder_cover_mime
        album.cover_art_width = w
        album.cover_art_height = h
        album.cover_art_original_format = orig_fmt
        album.cover_art_source = f"Ordner-Bild ({folder_cover_name})"
    elif embedded_cover and not album.cover_art_bytes:
        w, h, orig_fmt = inspect_cover_image(embedded_cover, embedded_mime)
        album.cover_art_bytes = embedded_cover
        album.cover_art_mime = embedded_mime
        album.cover_art_width = w
        album.cover_art_height = h
        album.cover_art_original_format = orig_fmt
        album.cover_art_source = f"Eingebettetes Cover ({audio_files[0].name})"

    for trk in album.tracks:
        if not trk.artist or trk.artist == "Unbekannter Künstler":
            trk.artist = album.artist

    synthesize_toc_from_tracks(album, exact_sector_counts=sector_counts)

    # Falls eine .cue-Datei im Ordner exakte Frame-Offsets für alle Tracks enthielt, diese übernehmen
    cue_offsets = folder_hints.get("cue_track_offsets") or []
    if not append and len(cue_offsets) == len(album.tracks) and album.leadout_offset > cue_offsets[-1]:
        album.track_offsets = list(cue_offsets)
        first_sec = cue_offsets[0] // FRAMES_PER_SECOND
        leadout_sec = album.leadout_offset // FRAMES_PER_SECOND
        album.cddb_id = folder_hints.get("cddb_id") or calculate_cddb_disc_id(
            cue_offsets, max(1, leadout_sec - first_sec)
        )
        album.musicbrainz_disc_id = folder_hints.get("mb_disc_id") or calculate_musicbrainz_disc_id(
            1, len(album.tracks), album.leadout_offset, cue_offsets
        )
        album.musicbrainz_toc = f"1 {len(album.tracks)} {album.leadout_offset} " + " ".join(
            str(o) for o in cue_offsets
        )

    return album


def build_album_from_directory(
    folder_path: Path,
    existing_album: Optional[AlbumMetadata] = None,
    append: bool = False,
) -> AlbumMetadata:
    """Lädt ein komplettes Album-Verzeichnis (inkl. Audiodateien, Ordner-Cover & CUE-Sheet) und generiert die virtuelle CD-TOC."""
    return build_album_from_local_files([folder_path], existing_album=existing_album, append=append)


def rip_track_with_cdparanoia(
    device_path: str,
    track: TrackMetadata,
    output_wav: Path,
    paranoia_mode: str = "full",
    progress_cb: Optional[Callable[[float, str], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
) -> None:
    """Rippt einen einzelnen CD-Track bitgenau mittels cdparanoia nach WAV."""
    # Vor dem bitgenauen Rippen eventuelle Wiedergabe-Drosselung (2x) wieder auf Auto/Max zurücksetzen
    set_cd_read_speed(device_path, 0)

    real_dev = os.path.realpath(device_path) if Path(device_path).exists() else device_path
    rip_track_num = (
        int(getattr(track, "toc_track_number", 0) or 0)
        if int(getattr(track, "toc_track_number", 0) or 0) > 0
        else int(track.track_number)
    )
    cmd = ["cdparanoia", "-d", real_dev, "-e"]
    if paranoia_mode == "disable-skip":
        cmd.append("-Y")
    elif paranoia_mode == "fast":
        cmd.append("-Z")

    cmd.extend([str(rip_track_num), str(output_wav)])

    process = subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    total_sectors = max(1, (track.end_lsn - track.start_lsn) or (track.duration_seconds * FRAMES_PER_SECOND))
    start_sector = track.start_lsn

    try:
        assert process.stderr is not None
        for line in process.stderr:
            if cancel_check and cancel_check():
                process.terminate()
                process.wait(timeout=5)
                raise InterruptedError("Rip-Vorgang durch Benutzer abgebrochen.")

            match = PARANOIA_PROGRESS_RE.search(line)
            if match and progress_cb:
                current_sector = int(match.group(1))
                ratio = max(0.0, min(1.0, (current_sector - start_sector) / total_sectors))
                progress_cb(ratio, f"Sektor {current_sector}")

        return_code = process.wait()
        if return_code != 0:
            raise RuntimeError(f"cdparanoia beendet mit Exit-Code {return_code}")
    finally:
        if process.poll() is None:
            process.kill()


_CDROMREADTOCHDR = 0x5305
_CDROMREADTOCENTRY = 0x5306
_CDROMEJECT = 0x5309
_CDROMMULTISESSION = 0x5310
_CDROMCLOSETRAY = 0x5319
_CDROM_SELECT_SPEED = 0x5322
_CDROM_DRIVE_STATUS = 0x5326
_CDROM_LOCKDOOR = 0x5329
_CDROM_LBA = 0x01
_CDROM_DATA_TRACK = 0x04
_CDROM_LEADOUT = 0xAA
_CDSL_CURRENT = 0x7FFFFFFF
_SG_IO = 0x2285
_SG_DXFER_NONE = -1
_SG_DXFER_FROM_DEV = -3
_CDS_NO_INFO = 0
_CDS_NO_DISC = 1
_CDS_TRAY_OPEN = 2
_CDS_DRIVE_NOT_READY = 3
_CDS_DISC_OK = 4

CD_PCM_BYTES_PER_SEC = 176400  # 44.1 kHz Stereo 16-Bit = 176.400 Bytes/s


class _CdromTocHdr(ctypes.Structure):
    """Linux struct cdrom_tochdr für CDROMREADTOCHDR (0x5305)."""

    _fields_ = [
        ("cdth_trk0", ctypes.c_ubyte),
        ("cdth_trk1", ctypes.c_ubyte),
    ]


class _CdromTocEntry(ctypes.Structure):
    """Linux struct cdrom_tocentry für CDROMREADTOCENTRY (0x5306) im LBA-Modus."""

    _fields_ = [
        ("cdte_track", ctypes.c_ubyte),
        ("cdte_adr", ctypes.c_ubyte, 4),
        ("cdte_ctrl", ctypes.c_ubyte, 4),
        ("cdte_format", ctypes.c_ubyte),
        ("cdte_lba", ctypes.c_int),
        ("cdte_datamode", ctypes.c_ubyte),
    ]


class _CdromMultiSession(ctypes.Structure):
    """Linux struct cdrom_multisession für CDROMMULTISESSION (0x5310)."""

    _fields_ = [
        ("addr_lba", ctypes.c_int),
        ("xa_flag", ctypes.c_ubyte),
        ("addr_format", ctypes.c_ubyte),
    ]


class _SgIoHdr(ctypes.Structure):
    """Linux sg_io_hdr_t Struktur für direkte SCSI MMC SET CD SPEED (0xBB) IOCTLs."""

    _fields_ = [
        ("interface_id", ctypes.c_int),
        ("dxfer_direction", ctypes.c_int),
        ("cmd_len", ctypes.c_ubyte),
        ("mx_sb_len", ctypes.c_ubyte),
        ("iovec_count", ctypes.c_ushort),
        ("dxfer_len", ctypes.c_uint),
        ("dxferp", ctypes.c_void_p),
        ("cmdp", ctypes.c_void_p),
        ("sbp", ctypes.c_void_p),
        ("timeout", ctypes.c_uint),
        ("flags", ctypes.c_uint),
        ("pack_id", ctypes.c_int),
        ("usr_ptr", ctypes.c_void_p),
        ("status", ctypes.c_ubyte),
        ("masked_status", ctypes.c_ubyte),
        ("msg_status", ctypes.c_ubyte),
        ("sb_len_wr", ctypes.c_ubyte),
        ("host_status", ctypes.c_ushort),
        ("driver_status", ctypes.c_ushort),
        ("resid", ctypes.c_int),
        ("duration", ctypes.c_uint),
        ("info", ctypes.c_uint),
    ]


def set_cd_read_speed(device_path: str = "/dev/cdrom", speed: int = 0) -> bool:
    """Begrenzt die Lesegeschwindigkeit des optischen Laufwerks hart (0 = Auto/Max, Wiedergabe max. 2x per IOCTL + SCSI SET CD SPEED)."""
    clean_dev = (device_path or "").strip() or "/dev/cdrom"
    target = Path(clean_dev)
    if not target.exists():
        return False
    real_dev = os.path.realpath(clean_dev)
    # Im gedrosselten Modus hart auf maximal 2x deckeln (0 = ungedrosselt beim Zurücksetzen)
    clamped = 0 if int(speed) <= 0 else max(1, min(2, int(speed)))
    applied = False
    fd = -1
    try:
        fd = os.open(real_dev, os.O_RDONLY | os.O_NONBLOCK)
        try:
            fcntl.ioctl(fd, _CDROM_SELECT_SPEED, clamped)
            applied = True
        except Exception:
            pass
        try:
            kbps = 0xFFFF if clamped <= 0 else clamped * 176
            cdb = (ctypes.c_ubyte * 12)(
                0xBB,
                0,
                (kbps >> 8) & 0xFF,
                kbps & 0xFF,
                0xFF,
                0xFF,
                0,
                0,
                0,
                0,
                0,
                0,
            )
            sb = (ctypes.c_ubyte * 32)()
            hdr = _SgIoHdr(
                interface_id=ord("S"),
                dxfer_direction=-1,  # SG_DXFER_NONE
                cmd_len=12,
                mx_sb_len=32,
                cmdp=ctypes.addressof(cdb),
                sbp=ctypes.addressof(sb),
                timeout=3000,
            )
            fcntl.ioctl(fd, _SG_IO, hdr)
            applied = True
        except Exception:
            pass
        if applied:
            return True
    except Exception:
        pass
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except Exception:
                pass

    eject_bin = shutil.which("eject")
    if eject_bin:
        try:
            res = subprocess.run(
                [eject_bin, "-x", str(clamped), real_dev],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=2,
            )
            return res.returncode == 0
        except Exception:
            pass
    return False


def patch_wav_header(header_and_data: bytes, expected_pcm_bytes: int) -> bytes:
    """Korrigiert RIFF- und data-Größen im 44-Byte-WAV-Header für ruckelfreies Streaming."""
    if expected_pcm_bytes <= 0 or len(header_and_data) < 44:
        return header_and_data
    if (
        header_and_data[0:4] != b"RIFF"
        or header_and_data[8:12] != b"WAVE"
        or header_and_data[36:40] != b"data"
    ):
        return header_and_data
    safe_data = min(0x7FFFFFD0, max(0, int(expected_pcm_bytes) & ~3))
    safe_riff = safe_data + 36
    patched = bytearray(header_and_data)
    struct.pack_into("<I", patched, 4, safe_riff)
    struct.pack_into("<I", patched, 40, safe_data)
    return bytes(patched)


class BufferedCdPlaybackSession:
    """Gepufferte Echtzeit-CD-Wiedergabe mit harter 2x-Drehzahlbegrenzung, periodischem Speed-Guard und gedrosseltem Ringpuffer."""

    PREBUFFER_BYTES = int(CD_PCM_BYTES_PER_SEC * 2.0)  # ~2,0s Anlauf-Puffer (~1s Füllzeit bei 2x)
    HIGH_WATER_BYTES = int(CD_PCM_BYTES_PER_SEC * 4.5)  # ~4,5s Max-Lookahead
    LOW_WATER_BYTES = int(CD_PCM_BYTES_PER_SEC * 2.5)  # ~2,5s Nachlade-Schwelle
    REFILL_PACE_LOW_BYTES_PER_SEC = int(CD_PCM_BYTES_PER_SEC * 1.20)  # ~1,20x ruhiges Nachladen
    REFILL_PACE_CATCHUP_BYTES_PER_SEC = int(CD_PCM_BYTES_PER_SEC * 1.85)  # max 1,85x Aufholrate
    SPEED_GUARD_INTERVAL_SEC = 2.5
    READ_CHUNK_BYTES = 16384

    def __init__(
        self,
        device_path: str,
        track_number: int,
        expected_pcm_bytes: int = 0,
        read_speed: int = 2,
    ) -> None:
        self.device_path = os.path.realpath(device_path) if os.path.exists(device_path) else device_path
        self.track_number = int(track_number)
        self.expected_pcm_bytes = max(0, int(expected_pcm_bytes))
        self.read_speed = max(1, min(2, int(read_speed)))
        self._cond = threading.Condition()
        self._speed_lock = threading.Lock()
        self._speed_guard_event = threading.Event()
        self._queue: deque[bytes] = deque()
        self._queued_bytes = 0
        self._probe_archive: list[bytes] = []
        self._keep_archive = True
        self._reader_done = False
        self._reader_exit_code: Optional[int] = None
        self._stopped = False
        self._post_spinup_relocked = False
        self._prebuffer_done = False
        self._cdp: Optional[subprocess.Popen] = None
        self._player: Optional[subprocess.Popen] = None
        self._reader_thread: Optional[threading.Thread] = None
        self._writer_thread: Optional[threading.Thread] = None
        self._speed_guard_thread: Optional[threading.Thread] = None
        self._speed_restored = False

    def _spawn_cdparanoia(self, with_speed_flag: bool) -> subprocess.Popen:
        # -Z deaktiviert rückwärts springende Paranoia-Überlappungen beim Vorhören;
        # -S begrenzt die physische Rotationsgeschwindigkeit hart auf 2x.
        cmd = ["cdparanoia", "-d", self.device_path]
        if with_speed_flag:
            cmd.extend(["-S", str(self.read_speed)])
        cmd.extend(["-Z", "-q", str(self.track_number), "-"])
        return subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )

    def _enforce_speed_cap(self) -> None:
        with self._speed_lock:
            if self._stopped or self._speed_restored or self._reader_done:
                return
            set_cd_read_speed(self.device_path, self.read_speed)

    def _speed_guard_loop(self) -> None:
        while not self._stopped and not self._reader_done:
            # Wacht sofort auf nach dem ersten Spin-Up oder erneuert alle 2,5s die 2x-Sperre
            triggered = self._speed_guard_event.wait(timeout=self.SPEED_GUARD_INTERVAL_SEC)
            if triggered:
                self._speed_guard_event.clear()
            if self._stopped or self._reader_done:
                break
            self._enforce_speed_cap()

    def _reader_loop(self) -> None:
        pace_window_started = 0.0
        pace_window_bytes = 0
        try:
            proc = self._spawn_cdparanoia(with_speed_flag=True)
            self._cdp = proc
            produced_any = False
            header_buf = bytearray()
            header_done = False

            while True:
                if self._stopped:
                    break
                stdout = proc.stdout
                if stdout is None:
                    break
                chunk = stdout.read(self.READ_CHUNK_BYTES)
                if not chunk:
                    ret = proc.wait()
                    self._reader_exit_code = ret
                    # Falls `-S <speed>` vom Laufwerk beim Start abgelehnt wurde, nahtlos ohne `-S` erneut starten
                    if not produced_any and ret != 0 and not self._stopped:
                        self._post_spinup_relocked = False
                        proc = self._spawn_cdparanoia(with_speed_flag=False)
                        self._cdp = proc
                        header_buf.clear()
                        header_done = False
                        continue
                    break

                if not produced_any:
                    produced_any = True
                    # Spin-Up abgeschlossen -> 2x-Limit sofort über Guard-Thread erneut sperren
                    if not self._post_spinup_relocked:
                        self._post_spinup_relocked = True
                        self._speed_guard_event.set()

                if not header_done:
                    header_buf.extend(chunk)
                    if len(header_buf) < 44:
                        continue
                    chunk = patch_wav_header(bytes(header_buf), self.expected_pcm_bytes)
                    header_buf.clear()
                    header_done = True

                with self._cond:
                    while (
                        not self._stopped
                        and self._queued_bytes >= self.HIGH_WATER_BYTES
                    ):
                        # High-Watermark erreicht: Warten bis unter Obergrenze
                        self._cond.wait(timeout=0.15)
                    if self._stopped:
                        break
                    self._queue.append(chunk)
                    self._queued_bytes += len(chunk)
                    if not self._prebuffer_done and self._queued_bytes >= self.PREBUFFER_BYTES:
                        self._prebuffer_done = True
                        pace_window_started = time.monotonic()
                        pace_window_bytes = 0
                    cur_queued = self._queued_bytes
                    prebuf_done = self._prebuffer_done
                    self._cond.notify_all()

                # Nach Anlaufpuffer Nachladegeschwindigkeit sanft drosseln (verhindert Laufwerks-Bursts / Spin-Up)
                if prebuf_done and not self._stopped:
                    now = time.monotonic()
                    if pace_window_started == 0.0 or (now - pace_window_started) > 1.2:
                        pace_window_started = now
                        pace_window_bytes = 0
                    pace_window_bytes += len(chunk)
                    target_rate = (
                        self.REFILL_PACE_CATCHUP_BYTES_PER_SEC
                        if cur_queued <= self.LOW_WATER_BYTES
                        else self.REFILL_PACE_LOW_BYTES_PER_SEC
                    )
                    expected_elapsed = pace_window_bytes / float(target_rate)
                    delay_s = expected_elapsed - (now - pace_window_started)
                    if delay_s > 0.012:
                        with self._cond:
                            if not self._stopped and self._queued_bytes > int(CD_PCM_BYTES_PER_SEC * 1.5):
                                self._cond.wait(timeout=min(0.20, delay_s))

            if header_buf and not self._stopped:
                with self._cond:
                    tail = bytes(header_buf)
                    self._queue.append(tail)
                    self._queued_bytes += len(tail)
                    self._cond.notify_all()
        finally:
            with self._cond:
                self._reader_done = True
                self._cond.notify_all()
            self._speed_guard_event.set()

    def _pump_to_player(self, player: subprocess.Popen, replay_archive: bool) -> None:
        stdin = player.stdin
        if stdin is None:
            return
        replay_idx = 0
        try:
            while not self._stopped and player.poll() is None:
                chunk: Optional[bytes] = None
                with self._cond:
                    if replay_archive and replay_idx < len(self._probe_archive):
                        chunk = self._probe_archive[replay_idx]
                        replay_idx += 1
                    else:
                        while not self._queue and not self._reader_done and not self._stopped:
                            self._cond.wait(timeout=0.2)
                        if self._stopped or player.poll() is not None:
                            break
                        if self._queue:
                            chunk = self._queue.popleft()
                            self._queued_bytes = max(0, self._queued_bytes - len(chunk))
                            if self._keep_archive and len(self._probe_archive) < 64:
                                self._probe_archive.append(chunk)
                            if self._queued_bytes < self.HIGH_WATER_BYTES:
                                self._cond.notify_all()
                        elif self._reader_done:
                            break
                if chunk is None:
                    continue
                try:
                    stdin.write(chunk)
                    stdin.flush()
                except (BrokenPipeError, OSError, ValueError):
                    break
        finally:
            try:
                stdin.close()
            except Exception:
                pass

    def start_and_wait(
        self,
        sink_cmds: list[list[str]],
        cancel_check: Optional[Callable[[], bool]] = None,
        on_playing: Optional[Callable[[], None]] = None,
    ) -> bool:
        """Startet gedrosseltes Gepuffertes Auslesen + Audio-Sink und wartet bis Ende oder Abbruch."""
        if not sink_cmds or not shutil.which("cdparanoia"):
            return False

        self._enforce_speed_cap()
        self._speed_guard_thread = threading.Thread(target=self._speed_guard_loop, daemon=True)
        self._speed_guard_thread.start()
        self._reader_thread = threading.Thread(target=self._reader_loop, daemon=True)
        self._reader_thread.start()

        # Pre-Buffer (~2.0s PCM) abwarten, bevor der Audio-Player geöffnet wird
        wait_deadline = time.monotonic() + 6.0
        with self._cond:
            while (
                not self._stopped
                and not self._reader_done
                and self._queued_bytes < self.PREBUFFER_BYTES
                and time.monotonic() < wait_deadline
            ):
                if cancel_check and cancel_check():
                    self.stop()
                    return False
                self._cond.wait(timeout=0.1)

            has_audio = self._queued_bytes > 0
        if not has_audio or self._stopped:
            self.stop()
            return False

        try:
            for sink_idx, sink_cmd in enumerate(sink_cmds):
                if self._stopped or (cancel_check and cancel_check()):
                    self.stop()
                    return False
                replay_needed = sink_idx > 0
                player = subprocess.Popen(
                    sink_cmd,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                self._player = player
                writer = threading.Thread(
                    target=self._pump_to_player,
                    args=(player, replay_needed),
                    daemon=True,
                )
                self._writer_thread = writer
                writer.start()

                # Kurz prüfen, ob Sink-Backend stabil angelaufen ist (0.25s)
                time.sleep(0.25)
                if self._stopped or (cancel_check and cancel_check()):
                    self.stop()
                    return False

                if player.poll() is None:
                    with self._cond:
                        self._keep_archive = False
                        self._probe_archive.clear()
                    if on_playing:
                        on_playing()
                    player.wait()
                    return True

                # Sink ist sofort beendet -> bereinigen & nächstes Audio-Backend über Replay-Archiv versuchen
                try:
                    if player.poll() is None:
                        player.terminate()
                except Exception:
                    pass
                writer.join(timeout=0.5)
                self._player = None
            return False
        finally:
            self.stop()

    def stop(self) -> None:
        with self._cond:
            self._stopped = True
            self._queue.clear()
            self._queued_bytes = 0
            self._probe_archive.clear()
            self._cond.notify_all()
        self._speed_guard_event.set()

        for proc in (self._player, self._cdp):
            if proc is None:
                continue
            try:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=0.4)
                    except Exception:
                        proc.kill()
            except Exception:
                pass

        with self._speed_lock:
            if not self._speed_restored:
                self._speed_restored = True
                set_cd_read_speed(self.device_path, 0)


def _sg_io_command(
    fd: int,
    cdb_bytes: bytes,
    dxfer_len: int = 0,
    timeout_ms: int = 2500,
) -> tuple[bool, int, int, int, bytes, bytes]:
    """Sendet ein einzelnes SCSI-MMC-Kommando über SG_IO und liefert (ok, status, host, driver, data, sense)."""
    try:
        cdb = (ctypes.c_ubyte * len(cdb_bytes))(*cdb_bytes)
        sb = (ctypes.c_ubyte * 32)()
        if dxfer_len > 0:
            data_buf = (ctypes.c_ubyte * dxfer_len)()
            dxferp = ctypes.addressof(data_buf)
            direction = _SG_DXFER_FROM_DEV
        else:
            data_buf = None
            dxferp = 0
            direction = _SG_DXFER_NONE
        hdr = _SgIoHdr(
            interface_id=ord("S"),
            dxfer_direction=direction,
            cmd_len=len(cdb_bytes),
            mx_sb_len=32,
            iovec_count=0,
            dxfer_len=dxfer_len,
            dxferp=dxferp,
            cmdp=ctypes.addressof(cdb),
            sbp=ctypes.addressof(sb),
            timeout=timeout_ms,
            flags=0,
            pack_id=0,
            usr_ptr=0,
            status=0,
            masked_status=0,
            msg_status=0,
            sb_len_wr=0,
            host_status=0,
            driver_status=0,
            resid=0,
            duration=0,
            info=0,
        )
        fcntl.ioctl(fd, _SG_IO, hdr)
        actual_len = max(0, dxfer_len - max(0, int(hdr.resid))) if dxfer_len > 0 else 0
        out_data = bytes(data_buf[:actual_len]) if data_buf is not None else b""
        sense_len = max(0, min(32, int(hdr.sb_len_wr)))
        out_sense = bytes(sb[:sense_len])
        return True, int(hdr.status), int(hdr.host_status), int(hdr.driver_status), out_data, out_sense
    except Exception:
        return False, -1, -1, -1, b"", b""


def _probe_scsi_mmc_tray_state(fd: int) -> Optional[dict]:
    """Fragt den physischen Tür-/Schlitten-Mikroschalter direkt per SCSI MMC (0x4A / 0xBD / 0x00) ab."""
    # 1. SCSI MMC GET EVENT STATUS NOTIFICATION (0x4A), Polled=1, Class=Media (0x10)
    ok, status, host_st, drv_st, data, _sense = _sg_io_command(
        fd,
        bytes([0x4A, 0x01, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x08, 0x00]),
        dxfer_len=8,
    )
    if ok and status == 0 and host_st == 0 and drv_st == 0 and len(data) >= 6:
        evt_data_len = (data[0] << 8) | data[1]
        nea = bool(data[2] & 0x80)
        evt_class = data[2] & 0x07
        if (not nea) and evt_class == 4 and evt_data_len >= 4:
            media_status = data[5]
            door_open = bool(media_status & 0x01)
            media_present = bool(media_status & 0x02) and (not door_open)
            return {
                "tray_open": door_open,
                "disc_present": media_present,
                "reliable": True,
                "source": "scsi_gesn",
            }

    # 2. Fallback: SCSI MMC MECHANISM STATUS (0xBD) -> Byte 1 Bit 4 = Door Open
    ok, status, host_st, drv_st, data, _sense = _sg_io_command(
        fd,
        bytes([0xBD, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00]),
        dxfer_len=8,
    )
    if ok and status == 0 and host_st == 0 and drv_st == 0 and len(data) >= 2:
        door_open = bool(data[1] & 0x10)
        return {
            "tray_open": door_open,
            "disc_present": None,
            "reliable": True,
            "source": "scsi_mech",
        }

    # 3. Fallback: SCSI TEST UNIT READY (0x00) + Sense-Auswertung (ASC 0x3A / ASCQ 0x02=Open, 0x01=Closed)
    ok, status, host_st, drv_st, _data, sense = _sg_io_command(
        fd,
        bytes([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
        dxfer_len=0,
    )
    if ok and host_st == 0:
        if status == 0 and drv_st == 0:
            return {
                "tray_open": False,
                "disc_present": True,
                "reliable": True,
                "source": "scsi_tur",
            }
        if len(sense) >= 4:
            resp_code = sense[0] & 0x7F
            sk = asc = ascq = -1
            if resp_code in (0x70, 0x71) and len(sense) >= 14:
                sk = sense[2] & 0x0F
                asc = sense[12]
                ascq = sense[13]
            elif resp_code in (0x72, 0x73):
                sk = sense[1] & 0x0F
                asc = sense[2]
                ascq = sense[3]
            if sk == 0x02 and asc == 0x3A:
                if ascq == 0x02:
                    return {
                        "tray_open": True,
                        "disc_present": False,
                        "reliable": True,
                        "source": "scsi_tur_sense",
                    }
                if ascq == 0x01:
                    return {
                        "tray_open": False,
                        "disc_present": False,
                        "reliable": True,
                        "source": "scsi_tur_sense",
                    }
    return None


def get_cd_tray_state(device_path: str = "/dev/cdrom") -> dict:
    """Liest den physischen Schlitten-Zustand präzise über CDROM_DRIVE_STATUS(CDSL_CURRENT) + SCSI MMC Door-Sensor aus."""
    clean_dev = (device_path or "").strip() or "/dev/cdrom"
    target = Path(clean_dev)
    if not target.exists():
        return {
            "exists": False,
            "tray_open": False,
            "disc_present": False,
            "status_code": _CDS_NO_INFO,
            "status": "unavailable",
            "reliable": False,
        }
    real_dev = os.path.realpath(clean_dev)
    fd = -1
    try:
        fd = os.open(real_dev, os.O_RDONLY | os.O_NONBLOCK)
        code = _CDS_NO_INFO
        try:
            code = int(fcntl.ioctl(fd, _CDROM_DRIVE_STATUS, _CDSL_CURRENT))
        except Exception:
            try:
                code = int(fcntl.ioctl(fd, _CDROM_DRIVE_STATUS, 0))
            except Exception:
                code = _CDS_NO_INFO

        scsi_probe = _probe_scsi_mmc_tray_state(fd)
        if scsi_probe is not None:
            tray_open = bool(scsi_probe["tray_open"])
            scsi_disc = scsi_probe.get("disc_present")
            if tray_open:
                disc_present = False
                eff_code = _CDS_TRAY_OPEN
                status_str = "open"
            elif scsi_disc is True or code == _CDS_DISC_OK:
                disc_present = True
                eff_code = _CDS_DISC_OK
                status_str = "disc_ok"
            else:
                disc_present = False
                eff_code = _CDS_NO_DISC if code != _CDS_DRIVE_NOT_READY else _CDS_NO_DISC
                status_str = "no_disc"
            return {
                "exists": True,
                "tray_open": tray_open,
                "disc_present": disc_present,
                "status_code": eff_code,
                "status": status_str,
                "reliable": True,
            }

        if code == _CDS_TRAY_OPEN:
            return {
                "exists": True,
                "tray_open": True,
                "disc_present": False,
                "status_code": code,
                "status": "open",
                "reliable": True,
            }
        if code == _CDS_DISC_OK:
            return {
                "exists": True,
                "tray_open": False,
                "disc_present": True,
                "status_code": code,
                "status": "disc_ok",
                "reliable": True,
            }
        if code == _CDS_NO_DISC:
            return {
                "exists": True,
                "tray_open": False,
                "disc_present": False,
                "status_code": code,
                "status": "no_disc",
                "reliable": True,
            }
        if code == _CDS_DRIVE_NOT_READY:
            return {
                "exists": True,
                "tray_open": False,
                "disc_present": False,
                "status_code": code,
                "status": "not_ready",
                "reliable": False,
            }
        return {
            "exists": True,
            "tray_open": False,
            "disc_present": False,
            "status_code": code,
            "status": "closed",
            "reliable": False,
        }
    except Exception:
        return {
            "exists": True,
            "tray_open": False,
            "disc_present": False,
            "status_code": _CDS_NO_INFO,
            "status": "unknown",
            "reliable": False,
        }
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except Exception:
                pass


def toggle_cd_tray(
    device_path: str = "/dev/cdrom",
    current_tray_open: Optional[bool] = None,
) -> tuple[bool, bool, str]:
    """Öffnet oder schließt den CD-Schlitten je nach aktuellem Hardware-Zustand (eject / eject -t + ioctl-Fallback)."""
    clean_dev = (device_path or "").strip() or "/dev/cdrom"
    state = get_cd_tray_state(clean_dev)
    if not state["exists"]:
        prev_open = bool(current_tray_open)
        next_open = not prev_open
        return next_open, False, f"Kein physisches Laufwerk unter {clean_dev} erkannt."

    real_dev = os.path.realpath(clean_dev)
    if state.get("reliable"):
        is_open = bool(state["tray_open"])
    elif current_tray_open is not None:
        is_open = bool(current_tray_open)
    else:
        is_open = False

    should_close = is_open
    eject_bin = shutil.which("eject")
    cmd_ok = False
    if eject_bin:
        cmd = [eject_bin, "-t", real_dev] if should_close else [eject_bin, real_dev]
        res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, check=False)
        cmd_ok = res.returncode == 0

    if not cmd_ok:
        fd = -1
        try:
            fd = os.open(real_dev, os.O_RDONLY | os.O_NONBLOCK)
            if not should_close:
                try:
                    fcntl.ioctl(fd, _CDROM_LOCKDOOR, 0)
                except Exception:
                    pass
            fcntl.ioctl(fd, _CDROMCLOSETRAY if should_close else _CDROMEJECT, 0)
            cmd_ok = True
        except Exception as exc:
            return is_open, True, f"Laufwerkssteuerung fehlgeschlagen: {exc}"
        finally:
            if fd >= 0:
                try:
                    os.close(fd)
                except Exception:
                    pass

    expected_open = not should_close
    after_state = get_cd_tray_state(real_dev)
    # Kurze Nachlauf-Prüfung (bis ~1,5 s), bis sich der Schlitten-Mikroschalter nach dem Motorlauf stabilisiert hat
    for _ in range(6):
        if after_state.get("reliable") and bool(after_state["tray_open"]) == expected_open:
            break
        time.sleep(0.25)
        after_state = get_cd_tray_state(real_dev)

    if after_state.get("reliable"):
        now_open = bool(after_state["tray_open"])
    else:
        now_open = expected_open
    action_msg = (
        f"CD-Schlitten ({clean_dev}) geschlossen / eingefahren."
        if not now_open
        else f"CD-Schlitten ({clean_dev}) ausgeworfen."
    )
    return now_open, True, action_msg

