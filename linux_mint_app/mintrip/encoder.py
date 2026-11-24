"""Nahtloser FLAC- und MP3-Export inkl. vollständiger MusicBrainz-Tags & Cover-Art."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

from mutagen.flac import FLAC, Picture
from mutagen.id3 import (
    APIC,
    COMM,
    ID3,
    MVIN,
    MVNM,
    TALB,
    TBPM,
    TCMP,
    TCOM,
    TCON,
    TCOP,
    TDOR,
    TDRC,
    TENC,
    TEXT,
    TIPL,
    TIT1,
    TIT2,
    TIT3,
    TKEY,
    TLAN,
    TMCL,
    TMED,
    TMOO,
    TOFN,
    TPE1,
    TPE2,
    TPE3,
    TPE4,
    TPOS,
    TPUB,
    TRCK,
    TSO2,
    TSOA,
    TSOC,
    TSOP,
    TSOT,
    TSRC,
    TSSE,
    TSST,
    TXXX,
    UFID,
    USLT,
    WCOP,
    WOAR,
)

from .models import (
    AlbumMetadata,
    ExportSettings,
    Mp3QualityMode,
    TrackMetadata,
    filter_picard_extra_tags,
    format_index_number,
    normalize_multi_artist,
    split_multi_value,
)


INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def detect_image_format(data: bytes, mime_hint: str = "") -> str:
    """Erkennt das tatsächliche Bildformat anhand der Magic-Bytes oder des MIME-Typs."""
    if len(data) >= 3 and data[:3] == b"\xff\xd8\xff":
        return "JPEG"
    if len(data) >= 8 and data[:8] == b"\x89PNG\r\n\x1a\n":
        return "PNG"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "WEBP"
    if len(data) >= 2 and data[:2] == b"BM":
        return "BMP"
    if len(data) >= 4 and data[:4] == b"GIF8":
        return "GIF"
    if len(data) >= 4 and data[:4] in (b"II*\x00", b"MM\x00*"):
        return "TIFF"
    m = (mime_hint or "").lower()
    if "png" in m:
        return "PNG"
    if "webp" in m:
        return "WEBP"
    if "bmp" in m:
        return "BMP"
    if "gif" in m:
        return "GIF"
    if "tiff" in m or "tif" in m:
        return "TIFF"
    return "JPEG"


def inspect_cover_image(
    cover_bytes: bytes,
    cover_mime: str = "image/jpeg",
) -> tuple[int, int, str]:
    """Ermittelt (width, height, format_name) eines Cover-Bildes ohne Konvertierung."""
    if not cover_bytes:
        return 0, 0, ""
    fmt = detect_image_format(cover_bytes, cover_mime)
    try:
        import gi

        gi.require_version("GdkPixbuf", "2.0")
        from gi.repository import GdkPixbuf

        loader = GdkPixbuf.PixbufLoader()
        loader.write(cover_bytes)
        loader.close()
        pixbuf = loader.get_pixbuf()
        if pixbuf is not None:
            return int(pixbuf.get_width()), int(pixbuf.get_height()), fmt
    except Exception:
        pass
    return 0, 0, fmt


def ensure_jpeg_cover(
    cover_bytes: bytes,
    cover_mime: str = "image/jpeg",
    ffmpeg_threads: int = 1,
) -> tuple[bytes, int, int, str, bool]:
    """Konvertiert ein Cover-Bild bei Bedarf (vor dem Einbetten in Audiodateien) in JPEG und gibt (jpeg_bytes, width, height, orig_fmt, converted) zurück."""
    eff_threads = max(1, min(16, int(ffmpeg_threads or 1)))
    if not cover_bytes:
        return b"", 0, 0, "", False

    orig_fmt = detect_image_format(cover_bytes, cover_mime)
    width = 0
    height = 0
    converted = False
    out_bytes = cover_bytes

    # 1. Versuch über GdkPixbuf (Standard in der Linux Mint GTK3-Umgebung)
    try:
        import gi

        gi.require_version("GdkPixbuf", "2.0")
        from gi.repository import GdkPixbuf

        loader = GdkPixbuf.PixbufLoader()
        loader.write(cover_bytes)
        loader.close()
        pixbuf = loader.get_pixbuf()
        if pixbuf is not None:
            width = int(pixbuf.get_width())
            height = int(pixbuf.get_height())
            if orig_fmt != "JPEG":
                if pixbuf.get_has_alpha():
                    composited = pixbuf.composite_color_simple(
                        width,
                        height,
                        GdkPixbuf.InterpType.BILINEAR,
                        255,
                        16,
                        0xFFFFFF,
                        0xFFFFFF,
                    )
                    if composited is not None:
                        pixbuf = composited
                ok, buf = pixbuf.save_to_bufferv("jpeg", ["quality"], ["92"])
                if ok and buf:
                    out_bytes = bytes(buf)
                    converted = True
            return out_bytes, width, height, orig_fmt, converted
    except Exception:
        pass

    # 2. Fallback über ffmpeg CLI (falls ohne GdkPixbuf im Headless-Betrieb aufgerufen)
    if orig_fmt != "JPEG" and shutil.which("ffmpeg"):
        try:
            proc = subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-threads",
                    str(eff_threads),
                    "-filter_threads",
                    str(eff_threads),
                    "-i",
                    "pipe:0",
                    "-vframes",
                    "1",
                    "-q:v",
                    "2",
                    "-f",
                    "mjpeg",
                    "-threads",
                    str(eff_threads),
                    "pipe:1",
                ],
                input=cover_bytes,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=15,
                check=False,
            )
            if proc.returncode == 0 and len(proc.stdout) > 64 and proc.stdout[:3] == b"\xff\xd8\xff":
                out_bytes = proc.stdout
                converted = True
        except Exception:
            pass

    return out_bytes, width, height, orig_fmt, converted


def sanitize_segment(value: str) -> str:
    cleaned = INVALID_FILENAME_CHARS.sub("_", value.strip())
    return cleaned or "Unbekannt"


_TEMPLATE_TOKEN_RE = re.compile(r"\{([^{}]*)\}")


def _render_template_safe(template: str, mapping: dict[str, str], positional_fallbacks: list[str]) -> str:
    """Ersetzt Platzhalter wie {track}, {track:02d}, {:02d} oder {} sicher ohne str.format()-Ausnahmen."""
    pos_idx = 0

    def _replacer(match: re.Match[str]) -> str:
        nonlocal pos_idx
        raw_inner = match.group(1).strip()
        key_part, sep, fmt_spec = raw_inner.partition(":")
        key_clean = key_part.strip().lower().replace("-", "_")

        if key_clean in mapping:
            return mapping[key_clean]

        # Falls z. B. {:02d}, {:03d}, {} oder {0} eingegeben wurde
        if not key_clean or key_clean.isdigit():
            if fmt_spec.strip().endswith("d") and "track" in mapping:
                return mapping["track"]
            if key_clean.isdigit():
                idx = int(key_clean)
                if 0 <= idx < len(positional_fallbacks):
                    return positional_fallbacks[idx]
            if pos_idx < len(positional_fallbacks):
                val = positional_fallbacks[pos_idx]
                pos_idx += 1
                return val
            return ""

        return sanitize_segment(key_part)

    rendered = _TEMPLATE_TOKEN_RE.sub(_replacer, template)
    # Einzelne verwaiste Klammern bereinigen
    return rendered.replace("{", "").replace("}", "")


def build_target_stem(album: AlbumMetadata, track: TrackMetadata, settings: ExportSettings) -> Path:
    """Erzeugt den Ziel-Dateipfad ohne Dateiendung mit 2- bzw. 3-stelligen Titel- & CD-Nummern."""
    eff_disc = max(1, getattr(track, "disc_number", 0) or album.disc_number or 1)
    disc_tracks = [t for t in album.tracks if (getattr(t, "disc_number", 0) or album.disc_number or 1) == eff_disc]
    total_tracks = len(disc_tracks) if disc_tracks else len(album.tracks)
    track_str = format_index_number(track.track_number, total_tracks)
    disc_str = format_index_number(eff_disc, album.total_discs)
    total_tracks_str = format_index_number(total_tracks, total_tracks)
    total_discs_str = format_index_number(album.total_discs, album.total_discs)

    artist_norm = normalize_multi_artist(track.artist or album.artist)
    album_artist_norm = normalize_multi_artist(album.album_artist or album.artist)
    artist_sort_norm = normalize_multi_artist(
        track.artist_sort or album.album_artist_sort or album.album_artist or album.artist
    )
    artist_clean = sanitize_segment(artist_norm)
    album_artist_clean = sanitize_segment(album_artist_norm)
    artist_sort_clean = sanitize_segment(artist_sort_norm)
    album_clean = sanitize_segment(album.title)
    year_clean = sanitize_segment((album.year or album.release_date[:4] or "0000")[:4])
    orig_year_clean = sanitize_segment((album.original_date[:4] if album.original_date else year_clean) or year_clean)
    date_clean = sanitize_segment(album.release_date or album.year or "0000")
    effective_genre = (getattr(track, "genre", "") or "").strip() or album.genre
    primary_genre = (effective_genre.split(";")[0].strip() if effective_genre else "") or "Audio"
    genre_clean = sanitize_segment(primary_genre)
    genres_clean = sanitize_segment(effective_genre or "Audio")
    label_clean = sanitize_segment((album.label.split(";")[0].strip() if album.label else "") or "Label")
    catno_clean = sanitize_segment((album.catalog_number.split(";")[0].strip() if album.catalog_number else "") or "CatNo")
    barcode_clean = sanitize_segment(album.barcode or "00000000")
    country_clean = sanitize_segment(album.country or "XX")
    media_clean = sanitize_segment(album.media_format or "CD")
    disc_sub_clean = sanitize_segment(getattr(track, "disc_subtitle", "") or album.disc_subtitle or f"CD {disc_str}")
    isrc_clean = sanitize_segment(track.isrc or "ISRC")
    raw_composer = track.composer or album.composer or ""
    raw_orchestra = track.orchestra or album.orchestra or ""
    raw_conductor = track.conductor or album.conductor or ""
    composer_clean = sanitize_segment((raw_composer.split(";")[0].strip() if raw_composer else "") or artist_clean)
    orchestra_clean = sanitize_segment((raw_orchestra.split(";")[0].strip() if raw_orchestra else "") or "Orchester")
    conductor_clean = sanitize_segment((raw_conductor.split(";")[0].strip() if raw_conductor else "") or "Dirigent")
    fmt_clean = sanitize_segment(settings.export_format.value.upper())
    title_clean = sanitize_segment(track.title)

    mapping = {
        "artist": artist_clean,
        "interpret": artist_clean,
        "künstler": artist_clean,
        "artist_sort": artist_sort_clean,
        "album_artist": album_artist_clean,
        "albumartist": album_artist_clean,
        "albuminterpret": album_artist_clean,
        "album": album_clean,
        "albumtitel": album_clean,
        "year": year_clean,
        "jahr": year_clean,
        "original_year": orig_year_clean,
        "orig_year": orig_year_clean,
        "date": date_clean,
        "datum": date_clean,
        "genre": genre_clean,
        "genres": genres_clean,
        "label": label_clean,
        "catno": catno_clean,
        "catalog_number": catno_clean,
        "katalognummer": catno_clean,
        "barcode": barcode_clean,
        "ean": barcode_clean,
        "country": country_clean,
        "land": country_clean,
        "media": media_clean,
        "medium": media_clean,
        "format": fmt_clean,
        "isrc": isrc_clean,
        "composer": composer_clean,
        "komponist": composer_clean,
        "orchestra": orchestra_clean,
        "orchester": orchestra_clean,
        "conductor": conductor_clean,
        "dirigent": conductor_clean,
        "track": track_str,
        "track_padded": track_str,
        "tracknumber": track_str,
        "track_number": track_str,
        "nr": track_str,
        "tracktotal": total_tracks_str,
        "total_tracks": total_tracks_str,
        "disc": disc_str,
        "disc_padded": disc_str,
        "discnumber": disc_str,
        "disc_number": disc_str,
        "cd": disc_str,
        "disctotal": total_discs_str,
        "total_discs": total_discs_str,
        "disc_subtitle": disc_sub_clean,
        "title": title_clean,
        "titel": title_clean,
    }

    raw_tpl = (settings.filename_template or "").strip()
    if not raw_tpl:
        raw_tpl = "{album_artist}/{year} - {album}/{track} - {title}"

    relative = _render_template_safe(
        raw_tpl,
        mapping,
        positional_fallbacks=[track_str, title_clean, album_artist_clean, album_clean],
    )

    # Pfadsegmente einzeln bereinigen, damit keine leeren oder ungültigen Dateinamen entstehen
    parts = [sanitize_segment(p) for p in re.split(r"[/\\]+", relative) if p.strip()]
    if not parts:
        parts = [album_artist_clean, f"{year_clean} - {album_clean}", f"{track_str} - {title_clean}"]
    elif len(parts) == 1 and parts[0] in (album_clean, album_artist_clean):
        parts.append(f"{track_str} - {title_clean}")

    target = settings.output_dir.joinpath(*parts)
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def build_cover_target_path(album_dir: Path, album: AlbumMetadata, settings: ExportSettings) -> Path:
    """Erzeugt den benutzerdefinierten Dateipfad für das Cover-Bild im Album-Ordner (immer als .jpg)."""
    raw_name = (settings.cover_filename or "cover").strip() or "cover"
    disc_str = format_index_number(album.disc_number, album.total_discs)
    total_discs_str = format_index_number(album.total_discs, album.total_discs)
    album_clean = sanitize_segment(album.title)
    artist_clean = sanitize_segment(normalize_multi_artist(album.artist))
    album_artist_clean = sanitize_segment(normalize_multi_artist(album.album_artist or album.artist))
    year_clean = sanitize_segment((album.year or album.release_date[:4] or "0000")[:4])
    label_clean = sanitize_segment((album.label.split(";")[0].strip() if album.label else "") or "Label")
    catno_clean = sanitize_segment((album.catalog_number.split(";")[0].strip() if album.catalog_number else "") or "CatNo")

    mapping = {
        "album": album_clean,
        "albumtitel": album_clean,
        "artist": artist_clean,
        "interpret": artist_clean,
        "album_artist": album_artist_clean,
        "albumartist": album_artist_clean,
        "albuminterpret": album_artist_clean,
        "year": year_clean,
        "date": year_clean,
        "jahr": year_clean,
        "disc": disc_str,
        "cd": disc_str,
        "total_discs": total_discs_str,
        "label": label_clean,
        "catno": catno_clean,
    }
    rendered = _render_template_safe(
        raw_name,
        mapping,
        positional_fallbacks=["cover", album_clean, disc_str],
    ).strip() or "cover"

    lower = rendered.lower()
    if lower.endswith((".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff")):
        stem_part, _ext = rendered.rsplit(".", 1)
        safe_name = f"{sanitize_segment(stem_part)}.jpg"
    else:
        safe_name = f"{sanitize_segment(rendered)}.jpg"
    return album_dir / safe_name


def _parse_ebur128_summary(stderr: str) -> tuple[float, float]:
    summary_idx = stderr.rfind("Summary:")
    tail = stderr[summary_idx:] if summary_idx != -1 else stderr

    lufs_match = re.search(r"I:\s*([+-]?\d+(?:\.\d+)?)\s*LUFS", tail)
    peak_match = re.search(r"Peak:\s*([+-]?\d+(?:\.\d+)?)\s*dBFS", tail)
    if not lufs_match:
        raise RuntimeError("Album-Lautheit (LUFS) konnte mit ffmpeg ebur128 nicht ermittelt werden.")

    integrated_lufs = float(lufs_match.group(1))
    peak_dbfs = float(peak_match.group(1)) if peak_match else -1.0
    return integrated_lufs, peak_dbfs


def measure_track_loudness(
    wav_path: Path, true_peak: bool = True, ffmpeg_threads: int = 1
) -> tuple[float, float]:
    """Misst integrierte Lautheit (LUFS) sowie True Peak bzw. Sample Peak (dBFS) eines Titels."""
    if not shutil.which("ffmpeg"):
        raise RuntimeError(
            "ffmpeg wurde nicht gefunden. Für die Album-Normalisierung bitte 'sudo apt install ffmpeg' ausführen."
        )
    eff_threads = max(1, min(16, int(ffmpeg_threads or 1)))
    peak_mode = "true" if true_peak else "sample"
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-threads",
        str(eff_threads),
        "-filter_threads",
        str(eff_threads),
        "-i",
        str(wav_path),
        "-af",
        f"ebur128=peak={peak_mode}",
        "-f",
        "null",
        "-",
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return _parse_ebur128_summary(res.stderr or "")


def measure_album_loudness(
    wav_paths: list[Path],
    true_peak: bool = True,
    use_loudest_track: bool = True,
    ffmpeg_threads: int = 1,
) -> dict:
    """Misst Track- & Album-Lautheit (LUFS) sowie True-/Sample-Peak per FFmpeg EBU R128."""
    if not wav_paths:
        raise ValueError("Keine WAV-Dateien zur Lautheitsmessung vorhanden.")
    if not shutil.which("ffmpeg"):
        raise RuntimeError(
            "ffmpeg wurde nicht gefunden. Für die Album-Normalisierung bitte 'sudo apt install ffmpeg' ausführen."
        )
    eff_threads = max(1, min(16, int(ffmpeg_threads or 1)))

    track_stats = [
        measure_track_loudness(wav, true_peak=true_peak, ffmpeg_threads=eff_threads)
        for wav in wav_paths
    ]
    if use_loudest_track:
        album_lufs = max(lufs for lufs, _ in track_stats)
        album_peak_dbfs = max(peak for _, peak in track_stats)
    else:
        peak_mode = "true" if true_peak else "sample"
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-threads",
            str(eff_threads),
            "-filter_threads",
            str(eff_threads),
        ]
        for wav in wav_paths:
            cmd.extend(["-i", str(wav)])
        inputs_ref = "".join(f"[{i}:a]" for i in range(len(wav_paths)))
        filter_expr = f"{inputs_ref}concat=n={len(wav_paths)}:v=0:a=1,ebur128=peak={peak_mode}"
        cmd.extend(["-filter_complex", filter_expr, "-f", "null", "-"])
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        album_lufs, album_peak_dbfs = _parse_ebur128_summary(res.stderr or "")

    return {
        "album_lufs": album_lufs,
        "album_peak_dbfs": album_peak_dbfs,
        "tracks": track_stats,
    }


def calculate_album_gain_db(
    measured_lufs: float,
    measured_peak_dbfs: float,
    target_lufs: float = -17.0,
    peak_ceiling_dbfs: float = -1.0,
) -> float:
    """Berechnet den einheitlichen Album-Gain (dB) inkl. True-Peak-Clipping-Schutz."""
    desired_gain = float(target_lufs) - float(measured_lufs)
    max_safe_gain = float(peak_ceiling_dbfs) - float(measured_peak_dbfs)
    return min(desired_gain, max_safe_gain)


def apply_gain_to_wav(
    input_wav: Path, output_wav: Path, gain_db: float, ffmpeg_threads: int = 1
) -> Path:
    """Wendet den berechneten Album-Gain verlustfrei linear auf eine WAV-Datei an."""
    if abs(gain_db) < 0.05:
        if input_wav != output_wav:
            shutil.copy2(input_wav, output_wav)
        return output_wav
    if not shutil.which("ffmpeg"):
        raise RuntimeError(
            "ffmpeg wurde nicht gefunden. Für die Album-Normalisierung bitte 'sudo apt install ffmpeg' ausführen."
        )
    eff_threads = max(1, min(16, int(ffmpeg_threads or 1)))
    cmd = [
        "ffmpeg",
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        str(eff_threads),
        "-filter_threads",
        str(eff_threads),
        "-i",
        str(input_wav),
        "-af",
        f"volume={gain_db:.3f}dB",
        "-c:a",
        "pcm_s16le",
        "-threads",
        str(eff_threads),
        str(output_wav),
    ]
    subprocess.run(cmd, check=True)
    return output_wav


_PERFORMER_ROLE_RE = re.compile(r"^\s*(.+?)\s*\(([^()]+)\)\s*$")


def _parse_performer_entry(raw_entry: str, default_role: str = "") -> tuple[str, str]:
    """Parst 'Künstler (Rolle)' in (rolle, künstler) nach MusicBrainz-Picard-Vorbis-Konvention."""
    cleaned = str(raw_entry or "").strip()
    if not cleaned:
        return ("", "")
    match = _PERFORMER_ROLE_RE.match(cleaned)
    if match:
        artist_name = match.group(1).strip()
        role_name = match.group(2).strip()
        return (role_name or default_role, artist_name)
    return (default_role, cleaned)


def _format_vorbis_performer(artist_name: str, role_name: str = "") -> str:
    name = str(artist_name or "").strip()
    role = str(role_name or "").strip()
    if not name:
        return ""
    return f"{name} ({role})" if role else name


def _merge_multi_values(*values: object) -> list[str]:
    merged: list[str] = []
    seen: set[str] = set()
    for val in values:
        for item in split_multi_value(val):
            if item not in seen:
                seen.add(item)
                merged.append(item)
    return merged


def _build_vorbis_performer_list(
    orchestras: list[str],
    extra_tags: dict[str, list[str]],
) -> list[str]:
    """Erstellt die offizielle Picard-PERFORMER-Liste ('{artist} (instrument/orchestra)')."""
    entries: list[str] = []
    seen: set[str] = set()

    def add_entry(val: str) -> None:
        if val and val not in seen:
            seen.add(val)
            entries.append(val)

    for orch in orchestras:
        role, name = _parse_performer_entry(orch, "orchestra")
        if name:
            add_entry(_format_vorbis_performer(name, role or "orchestra"))

    for key, vals in extra_tags.items():
        upper = key.upper()
        if upper == "PERFORMER":
            for raw_val in vals:
                role, name = _parse_performer_entry(raw_val, "")
                add_entry(_format_vorbis_performer(name, role))
        elif upper.startswith("PERFORMER:"):
            explicit_role = key.split(":", 1)[1].strip()
            for raw_val in vals:
                parsed_role, name = _parse_performer_entry(raw_val, explicit_role)
                add_entry(_format_vorbis_performer(name, parsed_role or explicit_role))

    return entries


def probe_audio_pcm_params(source_path: Path) -> tuple[str, int]:
    """Ermittelt das passende PCM-Sampleformat (pcm_s16le vs. pcm_s24le) und die Original-Abtastrate einer Audiodatei."""
    pcm_codec = "pcm_s16le"
    sample_rate = 44100
    lossless_codecs = {"flac", "alac", "tta", "wavpack", "mlp", "truehd"}

    if shutil.which("ffprobe"):
        try:
            proc = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-select_streams",
                    "a:0",
                    "-show_entries",
                    "stream=codec_name,sample_fmt,bits_per_raw_sample,bits_per_sample,sample_rate",
                    "-of",
                    "json",
                    str(source_path),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=8,
            )
            if proc.returncode == 0 and proc.stdout:
                data = json.loads(proc.stdout)
                streams = data.get("streams") or []
                if streams:
                    st = streams[0]
                    codec = str(st.get("codec_name") or "").lower()
                    sample_fmt = str(st.get("sample_fmt") or "").lower()
                    bits_raw = int(st.get("bits_per_raw_sample") or 0) or int(st.get("bits_per_sample") or 0)
                    sr = int(st.get("sample_rate") or 44100) or 44100
                    if sr > 0:
                        sample_rate = sr
                    if (
                        codec.startswith(("pcm_s24", "pcm_s32", "pcm_f32", "pcm_f64", "dsd_"))
                        or (
                            codec in lossless_codecs
                            and (bits_raw > 16 or sample_fmt.startswith(("s32", "flt")))
                        )
                    ):
                        pcm_codec = "pcm_s24le"
                    return pcm_codec, sample_rate
        except Exception:
            pass

    try:
        import mutagen  # type: ignore

        mfile = mutagen.File(str(source_path))
        if mfile is not None and getattr(mfile, "info", None) is not None:
            sr = int(getattr(mfile.info, "sample_rate", 44100) or 44100)
            if sr > 0:
                sample_rate = sr
            bps = int(getattr(mfile.info, "bits_per_sample", 16) or 16)
            if bps > 16 and source_path.suffix.lower() in {".wav", ".flac", ".aiff", ".aif", ".aifc", ".wv", ".tta", ".dsf", ".m4a"}:
                pcm_codec = "pcm_s24le"
    except Exception:
        pass

    return pcm_codec, sample_rate


def decode_to_clean_wav(
    source_path: Path,
    target_wav: Path,
    normalize: bool = False,
    target_lufs: float = -18.0,
    ffmpeg_threads: int = 1,
) -> Path:
    """Dekodiert beliebige Audiodateien zuerst in eine saubere PCM-WAV-Datei (exakte Bitraten-Basis für FLAC)."""
    ext = source_path.suffix.lower()
    target_wav.parent.mkdir(parents=True, exist_ok=True)
    eff_threads = max(1, min(16, int(ffmpeg_threads or 1)))
    if shutil.which("ffmpeg"):
        pcm_codec, sample_rate = probe_audio_pcm_params(source_path)
        cmd = [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-threads",
            str(eff_threads),
            "-filter_threads",
            str(eff_threads),
            "-i",
            str(source_path),
            "-map",
            "0:a:0",
            "-vn",
            "-map_metadata",
            "-1",
        ]
        if normalize:
            cmd.extend(["-af", f"loudnorm=I={target_lufs:.1f}:TP=-1.0:LRA=11", "-ar", str(sample_rate)])
        cmd.extend(["-c:a", pcm_codec, "-threads", str(eff_threads), str(target_wav)])
        subprocess.run(cmd, check=True)
        return target_wav
    if ext == ".flac" and shutil.which("flac"):
        subprocess.run(
            ["flac", "-d", "-f", "--silent", "-o", str(target_wav), str(source_path)],
            check=True,
        )
        return target_wav
    if ext == ".wav":
        shutil.copy2(source_path, target_wav)
        return target_wav
    raise RuntimeError(f"Format '{ext}' erfordert ffmpeg zur WAV-Zwischenkonvertierung.")


def copy_tags_and_cover_to_flac(source_path: Path, target_flac: Path) -> Path:
    """Überträgt vorhandene Metadaten-Tags und eingebettete Cover-Bilder aus einer Quelldatei in die erzeugte FLAC-Datei."""
    try:
        import mutagen  # type: ignore

        flac_audio = FLAC(str(target_flac))
        copied_any = False

        easy_src = mutagen.File(str(source_path), easy=True)
        if easy_src is not None and getattr(easy_src, "tags", None):
            for k, vals in easy_src.tags.items():
                key_upper = str(k).strip().upper()
                if not key_upper or key_upper.startswith(("__", "ENCODER")):
                    continue
                if isinstance(vals, (list, tuple)):
                    clean_vals = [str(v).strip() for v in vals if str(v).strip()]
                else:
                    clean_vals = [str(vals).strip()] if str(vals).strip() else []
                if clean_vals:
                    flac_audio[key_upper] = clean_vals
                    copied_any = True

        raw_src = mutagen.File(str(source_path), easy=False)
        cover_bytes: bytes | None = None
        cover_mime = "image/jpeg"
        if raw_src is not None:
            pics = getattr(raw_src, "pictures", None)
            if pics:
                first_pic = pics[0]
                if getattr(first_pic, "data", None):
                    cover_bytes = bytes(first_pic.data)
                    cover_mime = str(getattr(first_pic, "mime", "image/jpeg") or "image/jpeg")

            rtags = getattr(raw_src, "tags", None)
            if rtags and hasattr(rtags, "keys"):
                id3_text_map = {
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
                    "TCOP": "COPYRIGHT",
                }
                for raw_key in list(rtags.keys()):
                    ks = str(raw_key)
                    frame = rtags[raw_key]
                    if ks.startswith("APIC") and cover_bytes is None and getattr(frame, "data", None):
                        cover_bytes = bytes(frame.data)
                        cover_mime = str(getattr(frame, "mime", "image/jpeg") or "image/jpeg")
                    elif ks == "covr" and cover_bytes is None and frame:
                        cover_bytes = bytes(frame[0])
                        cover_mime = "image/jpeg"
                    elif ks in id3_text_map:
                        vals = [str(x).strip() for x in (getattr(frame, "text", None) or []) if str(x).strip()]
                        if vals:
                            flac_audio[id3_text_map[ks]] = vals
                            copied_any = True
                    elif ks.startswith("TXXX:"):
                        desc = str(getattr(frame, "desc", ks.split(":", 1)[1])).strip().upper().replace(" ", "_")
                        vals = [str(x).strip() for x in (getattr(frame, "text", None) or []) if str(x).strip()]
                        if desc and vals:
                            flac_audio[desc] = vals
                            copied_any = True
                    elif ks == "COMM" or ks.startswith("COMM:"):
                        vals = [str(x).strip() for x in (getattr(frame, "text", None) or []) if str(x).strip()]
                        if vals:
                            flac_audio["COMMENT"] = vals
                            copied_any = True
                    elif isinstance(frame, (list, tuple)) and ks.upper() not in ("METADATA_BLOCK_PICTURE", "COVERART"):
                        # Vorbis-Kommentare direkt übernehmen (inkl. Multi-Value)
                        vlist = [str(x).strip() for x in frame if str(x).strip()]
                        if vlist and ks.replace("_", "").replace("-", "").isalnum():
                            flac_audio[ks.upper()] = vlist
                            copied_any = True

        if cover_bytes:
            jpg_bytes, jpg_w, jpg_h, _, _ = ensure_jpeg_cover(cover_bytes, cover_mime)
            picture = Picture()
            picture.type = 3
            picture.mime = "image/jpeg"
            picture.desc = "Front Cover"
            if jpg_w > 0 and jpg_h > 0:
                picture.width = jpg_w
                picture.height = jpg_h
                picture.depth = 24
            picture.data = jpg_bytes
            flac_audio.clear_pictures()
            flac_audio.add_picture(picture)
            copied_any = True

        if copied_any:
            flac_audio.save()
    except Exception:
        pass
    return target_flac


def encode_to_flac(
    input_wav: Path,
    output_flac: Path,
    album: AlbumMetadata,
    track: TrackMetadata,
    settings: ExportSettings,
    ffmpeg_threads: int = 1,
) -> Path:
    """Kodiert eine WAV-Datei verlustfrei in FLAC und schreibt ausschließlich offizielle Picard-Vorbis-Tags (inkl. Multi-Value)."""
    level = max(0, min(8, settings.flac_compression_level))
    eff_threads = max(1, min(16, int(ffmpeg_threads or 1)))
    if shutil.which("flac"):
        cmd = [
            "flac",
            f"-{level}",
            "-f",
            "--silent",
        ]
        if settings.flac_verify:
            cmd.append("--verify")
        if settings.flac_replay_gain:
            cmd.append("--replay-gain")
        cmd.extend(["-o", str(output_flac), str(input_wav)])
        subprocess.run(cmd, check=True)
    elif shutil.which("ffmpeg"):
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-threads",
                str(eff_threads),
                "-filter_threads",
                str(eff_threads),
                "-i",
                str(input_wav),
                "-map",
                "0:a:0",
                "-vn",
                "-c:a",
                "flac",
                "-compression_level",
                str(level),
                "-threads",
                str(eff_threads),
                str(output_flac),
            ],
            check=True,
        )
    else:
        raise RuntimeError("Weder 'flac' noch 'ffmpeg' wurde auf dem System gefunden.")
    return write_flac_tags(output_flac, album, track, settings)


def _collect_all_extra_tags(album: AlbumMetadata, track: TrackMetadata) -> dict[str, list[str]]:
    """Kombiniert Album- und Track-Extra-Tags vollständig (inkl. ReplayGain, R128, AcoustID & Custom-Tags), ohne vorhandene Tags zu verwerfen."""
    combined: dict[str, list[str]] = {}
    for source in (getattr(album, "extra_tags", None) or {}, getattr(track, "extra_tags", None) or {}):
        if not isinstance(source, dict):
            continue
        for raw_key, raw_vals in source.items():
            key = str(raw_key or "").strip()
            if not key or key.startswith("__"):
                continue
            vals = split_multi_value(raw_vals)
            if not vals:
                continue
            norm_key = (
                f"PERFORMER:{key.split(':', 1)[1].strip()}"
                if key.upper().startswith("PERFORMER:")
                else key.upper()
            )
            if norm_key in ("METADATA_BLOCK_PICTURE", "COVERART", "COVERARTMIME"):
                continue
            combined[norm_key] = vals
    return combined


def _populate_vorbis_tags_dict(
    audio: object,
    album: AlbumMetadata,
    track: TrackMetadata,
    settings: ExportSettings,
    preserve_existing: bool = True,
) -> None:
    """Aktualisiert Vorbis-/APEv2-Tags gezielt, ohne bereits vorhandene Tags (z. B. ReplayGain, R128, Custom-Tags) zu löschen."""
    eff_disc = max(1, getattr(track, "disc_number", 0) or album.disc_number or 1)
    disc_tracks = [t for t in album.tracks if (getattr(t, "disc_number", 0) or album.disc_number or 1) == eff_disc]
    total_tracks = len(disc_tracks) if disc_tracks else len(album.tracks)
    track_num_str = format_index_number(track.track_number, total_tracks)
    track_total_str = format_index_number(total_tracks, total_tracks)
    disc_num_str = format_index_number(eff_disc, album.total_discs)
    disc_total_str = format_index_number(album.total_discs, album.total_discs)

    merged_extra = _collect_all_extra_tags(album, track)

    track_artist_vals = split_multi_value(normalize_multi_artist(track.artist or album.artist))
    track_artists_vals = _merge_multi_values(track.artists, merged_extra.get("ARTISTS"), track_artist_vals)
    album_artist_vals = split_multi_value(normalize_multi_artist(album.album_artist or album.artist))
    album_artists_vals = _merge_multi_values(album.album_artists, merged_extra.get("ALBUMARTISTS"), album_artist_vals)

    if not preserve_existing and hasattr(audio, "delete"):
        audio.delete()  # type: ignore[attr-defined]

    def _set_if(key: str, vals: list[str]) -> None:
        if vals:
            audio[key] = vals  # type: ignore[index]

    _set_if("TITLE", split_multi_value(track.title) or ([track.title] if track.title else []))
    _set_if("ARTIST", track_artist_vals)
    _set_if("ARTISTS", track_artists_vals)
    if track.artist_sort:
        _set_if("ARTISTSORT", split_multi_value(normalize_multi_artist(track.artist_sort)))
    _set_if("ALBUMARTIST", album_artist_vals)
    _set_if("ALBUMARTISTS", album_artists_vals)
    if album.album_artist_sort:
        _set_if("ALBUMARTISTSORT", split_multi_value(normalize_multi_artist(album.album_artist_sort)))
    _set_if("ALBUM", split_multi_value(album.title) or ([album.title] if album.title else []))
    audio["TRACKNUMBER"] = [track_num_str]  # type: ignore[index]
    audio["TRACKTOTAL"] = [track_total_str]  # type: ignore[index]
    audio["TOTALTRACKS"] = [track_total_str]  # type: ignore[index]
    audio["DISCNUMBER"] = [disc_num_str]  # type: ignore[index]
    audio["DISCTOTAL"] = [disc_total_str]  # type: ignore[index]
    audio["TOTALDISCS"] = [disc_total_str]  # type: ignore[index]

    _set_if("DISCSUBTITLE", split_multi_value(track.disc_subtitle or album.disc_subtitle))
    _set_if("DATE", split_multi_value(album.release_date or album.year))
    orig_date_vals = split_multi_value(album.original_date)
    if orig_date_vals:
        audio["ORIGINALDATE"] = orig_date_vals  # type: ignore[index]
        orig_years = _merge_multi_values([d[:4] for d in orig_date_vals if len(d) >= 4])
        _set_if("ORIGINALYEAR", orig_years)
    _set_if("GENRE", split_multi_value((getattr(track, "genre", "") or "").strip() or album.genre))
    _set_if("LABEL", split_multi_value(album.label))
    _set_if("CATALOGNUMBER", split_multi_value(album.catalog_number))
    _set_if("BARCODE", split_multi_value(album.barcode))
    _set_if("ASIN", split_multi_value(album.asin))
    _set_if("RELEASECOUNTRY", split_multi_value(album.country))
    _set_if("RELEASESTATUS", split_multi_value(album.status))
    _set_if("RELEASETYPE", split_multi_value(album.release_type))
    _set_if("MEDIA", split_multi_value(album.media_format))
    _set_if("SCRIPT", split_multi_value(album.script))
    _set_if("LANGUAGE", _merge_multi_values(album.language, track.work_language))
    _set_if("ISRC", _merge_multi_values(track.isrcs, track.isrc))

    effective_composer = _merge_multi_values(track.composer or album.composer)
    effective_orchestra = _merge_multi_values(track.orchestra or album.orchestra)
    effective_conductor = _merge_multi_values(track.conductor or album.conductor, merged_extra.get("CONDUCTOR"))
    lyricist_vals = _merge_multi_values(track.lyricist, merged_extra.get("LYRICIST"))
    writer_vals = _merge_multi_values(track.writer, merged_extra.get("WRITER"))
    work_vals = _merge_multi_values(track.work, merged_extra.get("WORK"))
    producer_vals = _merge_multi_values(track.producer, merged_extra.get("PRODUCER"))

    _set_if("COMPOSER", effective_composer)
    _set_if("CONDUCTOR", effective_conductor)
    _set_if("LYRICIST", lyricist_vals)
    _set_if("WRITER", writer_vals)
    _set_if("WORK", work_vals)
    _set_if("PRODUCER", producer_vals)

    performer_entries = _build_vorbis_performer_list(effective_orchestra, merged_extra)
    _set_if("PERFORMER", performer_entries)

    # Offizielle MusicBrainz Picard Identifikations-Tags (Multi-Value-fähig)
    if album.musicbrainz_release_id:
        _set_if("MUSICBRAINZ_ALBUMID", split_multi_value(album.musicbrainz_release_id))
    if album.musicbrainz_release_group_id:
        _set_if("MUSICBRAINZ_RELEASEGROUPID", split_multi_value(album.musicbrainz_release_group_id))
    if album.musicbrainz_album_artist_id:
        _set_if("MUSICBRAINZ_ALBUMARTISTID", split_multi_value(album.musicbrainz_album_artist_id))
    if album.musicbrainz_disc_id:
        _set_if("MUSICBRAINZ_DISCID", split_multi_value(album.musicbrainz_disc_id))
    if track.musicbrainz_artist_id:
        _set_if("MUSICBRAINZ_ARTISTID", split_multi_value(track.musicbrainz_artist_id))
    if track.musicbrainz_recording_id:
        _set_if("MUSICBRAINZ_TRACKID", split_multi_value(track.musicbrainz_recording_id))
    if track.musicbrainz_track_id:
        _set_if("MUSICBRAINZ_RELEASETRACKID", split_multi_value(track.musicbrainz_track_id))
    if track.musicbrainz_work_id:
        _set_if("MUSICBRAINZ_WORKID", split_multi_value(track.musicbrainz_work_id))
    composer_id_vals = _merge_multi_values(
        track.musicbrainz_composer_id, merged_extra.get("MUSICBRAINZ_COMPOSERID")
    )
    _set_if("MUSICBRAINZ_COMPOSERID", composer_id_vals)

    handled_vorbis_keys = {
        "ARTISTS",
        "ALBUMARTISTS",
        "CONDUCTOR",
        "LYRICIST",
        "PRODUCER",
        "WORK",
        "WRITER",
        "PERFORMER",
        "MUSICBRAINZ_COMPOSERID",
    }
    for extra_key, extra_vals in merged_extra.items():
        upper_key = extra_key.upper()
        if upper_key in handled_vorbis_keys or upper_key.startswith("PERFORMER:"):
            continue
        if extra_vals:
            try:
                audio[upper_key] = extra_vals  # type: ignore[index]
            except Exception:
                pass


def write_flac_tags(
    output_flac: Path,
    album: AlbumMetadata,
    track: TrackMetadata,
    settings: ExportSettings,
    preserve_existing: bool = True,
) -> Path:
    """Schreibt Picard-Vorbis-Tags (inkl. Multi-Value & Cover-Art) in eine FLAC-Datei und bewahrt bereits vorhandene Tags (z. B. ReplayGain)."""
    audio = FLAC(str(output_flac))
    _populate_vorbis_tags_dict(audio, album, track, settings, preserve_existing=preserve_existing)

    if settings.embed_cover_art and album.cover_art_bytes:
        jpg_bytes, jpg_w, jpg_h, orig_fmt, _ = ensure_jpeg_cover(
            album.cover_art_bytes, album.cover_art_mime
        )
        album.cover_art_bytes = jpg_bytes
        album.cover_art_mime = "image/jpeg"
        if jpg_w > 0 and jpg_h > 0:
            album.cover_art_width = jpg_w
            album.cover_art_height = jpg_h
        if not album.cover_art_original_format:
            album.cover_art_original_format = orig_fmt

        picture = Picture()
        picture.type = 3  # Front Cover
        picture.mime = "image/jpeg"
        picture.desc = "Front Cover"
        if jpg_w > 0 and jpg_h > 0:
            picture.width = jpg_w
            picture.height = jpg_h
            picture.depth = 24
        picture.data = jpg_bytes
        audio.clear_pictures()
        audio.add_picture(picture)

    audio.save()
    return output_flac


_PICARD_ID3_TXXX_MAP: dict[str, str] = {
    "ACOUSTID_ID": "Acoustid Id",
    "ACOUSTID_FINGERPRINT": "Acoustid Fingerprint",
    "ACOUSTID_PUID": "Acoustid Puid",
    "ARTISTS": "Artists",
    "ALBUMARTISTS": "ALBUMARTISTS",
    "DIRECTOR": "DIRECTOR",
    "MUSICBRAINZ_COMPOSERID": "MusicBrainz Composer Id",
    "MUSICBRAINZ_ORIGINALALBUMID": "MusicBrainz Original Album Id",
    "MUSICBRAINZ_ORIGINALARTISTID": "MusicBrainz Original Artist Id",
    "R128_ALBUM_GAIN": "R128_ALBUM_GAIN",
    "R128_TRACK_GAIN": "R128_TRACK_GAIN",
    "REPLAYGAIN_ALBUM_GAIN": "REPLAYGAIN_ALBUM_GAIN",
    "REPLAYGAIN_ALBUM_MINMAX": "REPLAYGAIN_ALBUM_MINMAX",
    "REPLAYGAIN_ALBUM_PEAK": "REPLAYGAIN_ALBUM_PEAK",
    "REPLAYGAIN_ALBUM_RANGE": "REPLAYGAIN_ALBUM_RANGE",
    "REPLAYGAIN_MINMAX": "REPLAYGAIN_MINMAX",
    "REPLAYGAIN_REFERENCE_LOUDNESS": "REPLAYGAIN_REFERENCE_LOUDNESS",
    "REPLAYGAIN_TRACK_GAIN": "REPLAYGAIN_TRACK_GAIN",
    "REPLAYGAIN_TRACK_PEAK": "REPLAYGAIN_TRACK_PEAK",
    "REPLAYGAIN_TRACK_RANGE": "REPLAYGAIN_TRACK_RANGE",
    "REPLAYGAIN_UNDO": "REPLAYGAIN_UNDO",
    "SHOWMOVEMENT": "SHOWMOVEMENT",
    "WORK": "WORK",
    "WRITER": "Writer",
}


def encode_to_mp3(
    input_wav: Path,
    output_mp3: Path,
    album: AlbumMetadata,
    track: TrackMetadata,
    settings: ExportSettings,
) -> Path:
    """Kodiert eine WAV-Datei mit LAME nach MP3 und schreibt Picard-ID3v2-Frames (inkl. Multi-Value)."""
    quality_flags: list[str]
    if settings.mp3_quality == Mp3QualityMode.CBR_320:
        quality_flags = ["-b", "320", "-q", "0"]
    elif settings.mp3_quality == Mp3QualityMode.CBR_256:
        quality_flags = ["-b", "256", "-q", "0"]
    elif settings.mp3_quality == Mp3QualityMode.CBR_192:
        quality_flags = ["-b", "192", "-q", "2"]
    elif settings.mp3_quality == Mp3QualityMode.VBR_V2:
        quality_flags = ["-V", "2", "-q", "0"]
    else:
        quality_flags = ["-V", "0", "-q", "0"]

    cmd = ["lame", "--silent", *quality_flags, str(input_wav), str(output_mp3)]
    subprocess.run(cmd, check=True)
    return write_mp3_tags(output_mp3, album, track, settings)


def _replace_id3_frame(tags: ID3, frame_id: str, frame: object) -> None:
    try:
        tags.delall(frame_id)
    except Exception:
        pass
    tags.add(frame)


def _replace_txxx_frame(tags: ID3, desc: str, vals: list[str]) -> None:
    target_norm = desc.strip().lower()
    for existing_key in list(tags.keys()):
        ks = str(existing_key)
        if ks.startswith("TXXX:"):
            ex_frame = tags.get(existing_key)
            ex_desc = str(getattr(ex_frame, "desc", ks.split(":", 1)[1]) or "").strip().lower()
            if ex_desc == target_norm or ex_desc.replace(" ", "_") == target_norm.replace(" ", "_"):
                try:
                    del tags[existing_key]
                except Exception:
                    pass
    tags.add(TXXX(encoding=3, desc=desc, text=vals))


def _populate_picard_id3_tags(
    tags: ID3,
    album: AlbumMetadata,
    track: TrackMetadata,
    settings: ExportSettings,
    preserve_existing: bool = True,
) -> int:
    """Aktualisiert ein ID3-Objekt nach MusicBrainz-Picard-Spezifikation und bewahrt bei preserve_existing=True alle übrigen vorhandenen Frames (z. B. ReplayGain, RVA2, POPM, Custom-TXXX)."""
    eff_disc = max(1, getattr(track, "disc_number", 0) or album.disc_number or 1)
    disc_tracks = [t for t in album.tracks if (getattr(t, "disc_number", 0) or album.disc_number or 1) == eff_disc]
    total_tracks = len(disc_tracks) if disc_tracks else len(album.tracks)
    track_num_str = format_index_number(track.track_number, total_tracks)
    track_total_str = format_index_number(total_tracks, total_tracks)
    disc_num_str = format_index_number(eff_disc, album.total_discs)
    disc_total_str = format_index_number(album.total_discs, album.total_discs)

    v2_version = 3 if settings.id3v2_version == 3 else 4
    merged_extra = _collect_all_extra_tags(album, track)

    track_artist_vals = split_multi_value(normalize_multi_artist(track.artist or album.artist))
    track_artists_vals = _merge_multi_values(track.artists, merged_extra.get("ARTISTS"), track_artist_vals)
    album_artist_vals = split_multi_value(normalize_multi_artist(album.album_artist or album.artist))
    album_artists_vals = _merge_multi_values(album.album_artists, merged_extra.get("ALBUMARTISTS"), album_artist_vals)

    if not preserve_existing:
        tags.clear()

    title_vals = split_multi_value(track.title) or ([track.title] if track.title else [])
    if title_vals:
        _replace_id3_frame(tags, "TIT2", TIT2(encoding=3, text=title_vals))
    if track_artist_vals:
        _replace_id3_frame(tags, "TPE1", TPE1(encoding=3, text=track_artist_vals))
    if album_artist_vals:
        _replace_id3_frame(tags, "TPE2", TPE2(encoding=3, text=album_artist_vals))
    if track.artist_sort:
        _replace_id3_frame(tags, "TSOP", TSOP(encoding=3, text=split_multi_value(normalize_multi_artist(track.artist_sort))))
    if album.album_artist_sort:
        _replace_id3_frame(tags, "TSO2", TSO2(encoding=3, text=split_multi_value(normalize_multi_artist(album.album_artist_sort))))
    album_title_vals = split_multi_value(album.title) or ([album.title] if album.title else [])
    if album_title_vals:
        _replace_id3_frame(tags, "TALB", TALB(encoding=3, text=album_title_vals))
    _replace_id3_frame(tags, "TRCK", TRCK(encoding=3, text=f"{track_num_str}/{track_total_str}"))
    _replace_id3_frame(tags, "TPOS", TPOS(encoding=3, text=f"{disc_num_str}/{disc_total_str}"))

    date_vals = split_multi_value(album.release_date or album.year)
    if date_vals:
        tags.delall("TYER")
        _replace_id3_frame(tags, "TDRC", TDRC(encoding=3, text=date_vals))
    orig_date_vals = split_multi_value(album.original_date)
    if orig_date_vals:
        tags.delall("TORY")
        _replace_id3_frame(tags, "TDOR", TDOR(encoding=3, text=orig_date_vals))
    genre_vals = split_multi_value((getattr(track, "genre", "") or "").strip() or album.genre)
    if genre_vals:
        _replace_id3_frame(tags, "TCON", TCON(encoding=3, text=genre_vals))
    label_vals = split_multi_value(album.label)
    if label_vals:
        _replace_id3_frame(tags, "TPUB", TPUB(encoding=3, text=label_vals))

    effective_composer = _merge_multi_values(track.composer or album.composer)
    effective_orchestra = _merge_multi_values(track.orchestra or album.orchestra)
    effective_conductor = _merge_multi_values(track.conductor or album.conductor, merged_extra.get("CONDUCTOR"))
    lyricist_vals = _merge_multi_values(track.lyricist, merged_extra.get("LYRICIST"))
    remixer_vals = split_multi_value(merged_extra.get("REMIXER"))
    media_vals = split_multi_value(album.media_format)
    language_vals = _merge_multi_values(album.language, track.work_language)
    isrcs = _merge_multi_values(track.isrcs, track.isrc)

    if effective_composer:
        _replace_id3_frame(tags, "TCOM", TCOM(encoding=3, text=effective_composer))
    if effective_conductor:
        _replace_id3_frame(tags, "TPE3", TPE3(encoding=3, text=effective_conductor))
    if remixer_vals:
        _replace_id3_frame(tags, "TPE4", TPE4(encoding=3, text=remixer_vals))
    if lyricist_vals:
        _replace_id3_frame(tags, "TEXT", TEXT(encoding=3, text=lyricist_vals))
    if media_vals:
        _replace_id3_frame(tags, "TMED", TMED(encoding=3, text=media_vals))
    if language_vals:
        _replace_id3_frame(tags, "TLAN", TLAN(encoding=3, text=language_vals))
    if isrcs:
        _replace_id3_frame(tags, "TSRC", TSRC(encoding=3, text=isrcs))

    # TSST ist gemäß offizieller Picard-Dokumentation ausschließlich ID3v2.4
    if v2_version == 4:
        disc_sub_vals = split_multi_value(track.disc_subtitle or album.disc_subtitle)
        if disc_sub_vals:
            _replace_id3_frame(tags, "TSST", TSST(encoding=3, text=disc_sub_vals))

    # TIPL (ID3v2.4) / IPLS (via update_to_v23 für ID3v2.3): producer, arranger, engineer, mix, DJ-mix
    tipl_people: list[list[str]] = []
    seen_tipl: set[tuple[str, str]] = set()
    for role_label, val_source in (
        ("producer", _merge_multi_values(track.producer, merged_extra.get("PRODUCER"))),
        ("arranger", split_multi_value(merged_extra.get("ARRANGER"))),
        ("engineer", split_multi_value(merged_extra.get("ENGINEER"))),
        ("mix", split_multi_value(merged_extra.get("MIXER"))),
        ("DJ-mix", split_multi_value(merged_extra.get("DJMIXER"))),
    ):
        for person_name in val_source:
            pair = (role_label, person_name)
            if pair not in seen_tipl:
                seen_tipl.add(pair)
                tipl_people.append([role_label, person_name])
    if tipl_people:
        _replace_id3_frame(tags, "TIPL", TIPL(encoding=3, people=tipl_people))

    # TMCL (ID3v2.4) / IPLS (via update_to_v23 für ID3v2.3): performer:<instrument/orchestra>
    tmcl_people: list[list[str]] = []
    seen_tmcl: set[tuple[str, str]] = set()

    def add_tmcl(role_name: str, person_name: str) -> None:
        r_clean = str(role_name or "").strip() or "performer"
        p_clean = str(person_name or "").strip()
        if not p_clean:
            return
        pair = (r_clean, p_clean)
        if pair not in seen_tmcl:
            seen_tmcl.add(pair)
            tmcl_people.append([r_clean, p_clean])

    for orch in effective_orchestra:
        role, name = _parse_performer_entry(orch, "orchestra")
        add_tmcl(role or "orchestra", name)

    for key, vals in merged_extra.items():
        upper_key = key.upper()
        if upper_key == "PERFORMER":
            for raw_val in vals:
                role, name = _parse_performer_entry(raw_val, "performer")
                add_tmcl(role or "performer", name)
        elif upper_key.startswith("PERFORMER:"):
            explicit_role = key.split(":", 1)[1].strip()
            for raw_val in vals:
                parsed_role, name = _parse_performer_entry(raw_val, explicit_role)
                add_tmcl(parsed_role or explicit_role, name)

    if tmcl_people:
        _replace_id3_frame(tags, "TMCL", TMCL(encoding=3, people=tmcl_people))

    # Offizielle MusicBrainz- & Picard-TXXX-Frames (Multi-Value-fähig)
    writer_vals = _merge_multi_values(track.writer, merged_extra.get("WRITER"))
    work_vals = _merge_multi_values(track.work, merged_extra.get("WORK"))
    composer_id_vals = _merge_multi_values(
        track.musicbrainz_composer_id, merged_extra.get("MUSICBRAINZ_COMPOSERID")
    )

    txxx_fields: dict[str, list[str]] = {
        "Artists": track_artists_vals,
        "ALBUMARTISTS": album_artists_vals,
        "CATALOGNUMBER": split_multi_value(album.catalog_number),
        "BARCODE": split_multi_value(album.barcode),
        "ASIN": split_multi_value(album.asin),
        "SCRIPT": split_multi_value(album.script),
        "WORK": work_vals,
        "Writer": writer_vals,
        "MusicBrainz Album Release Country": split_multi_value(album.country),
        "MusicBrainz Album Status": split_multi_value(album.status),
        "MusicBrainz Album Type": split_multi_value(album.release_type),
        "MusicBrainz Album Id": split_multi_value(album.musicbrainz_release_id),
        "MusicBrainz Release Group Id": split_multi_value(album.musicbrainz_release_group_id),
        "MusicBrainz Album Artist Id": split_multi_value(album.musicbrainz_album_artist_id),
        "MusicBrainz Disc Id": split_multi_value(album.musicbrainz_disc_id),
        "MusicBrainz Artist Id": split_multi_value(track.musicbrainz_artist_id),
        "MusicBrainz Release Track Id": split_multi_value(track.musicbrainz_track_id),
        "MusicBrainz Work Id": split_multi_value(track.musicbrainz_work_id),
        "MusicBrainz Composer Id": composer_id_vals,
    }
    for desc, vals in txxx_fields.items():
        if vals:
            _replace_txxx_frame(tags, desc, vals)

    handled_id3_keys = {
        "ARTISTS",
        "ALBUMARTISTS",
        "CONDUCTOR",
        "LYRICIST",
        "PRODUCER",
        "ARRANGER",
        "ENGINEER",
        "MIXER",
        "DJMIXER",
        "REMIXER",
        "PERFORMER",
        "WORK",
        "WRITER",
        "MUSICBRAINZ_COMPOSERID",
    }
    for extra_key, extra_vals in merged_extra.items():
        upper_key = extra_key.upper()
        if not extra_vals or upper_key in handled_id3_keys or upper_key.startswith("PERFORMER:"):
            continue
        if upper_key == "COMPOSERSORT":
            _replace_id3_frame(tags, "TSOC", TSOC(encoding=3, text=extra_vals))
        elif upper_key == "TITLESORT":
            _replace_id3_frame(tags, "TSOT", TSOT(encoding=3, text=extra_vals))
        elif upper_key == "ALBUMSORT":
            _replace_id3_frame(tags, "TSOA", TSOA(encoding=3, text=extra_vals))
        elif upper_key == "SUBTITLE":
            _replace_id3_frame(tags, "TIT3", TIT3(encoding=3, text=extra_vals))
        elif upper_key == "GROUPING":
            _replace_id3_frame(tags, "TIT1", TIT1(encoding=3, text=extra_vals))
        elif upper_key == "COPYRIGHT":
            _replace_id3_frame(tags, "TCOP", TCOP(encoding=3, text=extra_vals))
        elif upper_key == "COMPILATION":
            _replace_id3_frame(tags, "TCMP", TCMP(encoding=3, text=extra_vals))
        elif upper_key == "BPM":
            _replace_id3_frame(tags, "TBPM", TBPM(encoding=3, text=extra_vals))
        elif upper_key in ("KEY", "INITIALKEY"):
            _replace_id3_frame(tags, "TKEY", TKEY(encoding=3, text=extra_vals))
        elif upper_key == "ENCODEDBY":
            _replace_id3_frame(tags, "TENC", TENC(encoding=3, text=extra_vals))
        elif upper_key == "ENCODERSETTINGS":
            _replace_id3_frame(tags, "TSSE", TSSE(encoding=3, text=extra_vals))
        elif upper_key == "ORIGINALFILENAME":
            _replace_id3_frame(tags, "TOFN", TOFN(encoding=3, text=extra_vals))
        elif upper_key == "MOVEMENTNAME":
            _replace_id3_frame(tags, "MVNM", MVNM(encoding=3, text=extra_vals))
        elif upper_key == "MOVEMENT":
            _replace_id3_frame(tags, "MVIN", MVIN(encoding=3, text=extra_vals))
        elif upper_key == "MOOD":
            if v2_version == 4:
                _replace_id3_frame(tags, "TMOO", TMOO(encoding=3, text=extra_vals))
        elif upper_key == "LICENSE":
            if len(extra_vals) == 1 and re.match(r"^https?://", extra_vals[0], re.IGNORECASE):
                _replace_id3_frame(tags, "WCOP", WCOP(url=extra_vals[0]))
            else:
                _replace_txxx_frame(tags, "LICENSE", extra_vals)
        elif upper_key == "WEBSITE":
            tags.delall("WOAR")
            for url_val in extra_vals:
                tags.add(WOAR(url=url_val))
        elif upper_key == "COMMENT":
            _replace_id3_frame(tags, "COMM", COMM(encoding=3, lang="eng", desc="", text=extra_vals))
        elif upper_key == "LYRICS":
            _replace_id3_frame(tags, "USLT", USLT(encoding=3, lang="eng", desc="", text="\n".join(extra_vals)))
        elif upper_key in _PICARD_ID3_TXXX_MAP:
            _replace_txxx_frame(tags, _PICARD_ID3_TXXX_MAP[upper_key], extra_vals)
        else:
            # Alle sonstigen benutzerdefinierten / bereits vorhandenen Extra-Tags als TXXX erhalten
            _replace_txxx_frame(tags, extra_key, extra_vals)

    if track.musicbrainz_recording_id:
        first_rec_id = split_multi_value(track.musicbrainz_recording_id)[0]
        for existing_key in list(tags.keys()):
            if str(existing_key).startswith("UFID:http://musicbrainz.org"):
                try:
                    del tags[existing_key]
                except Exception:
                    pass
        tags.add(UFID(owner="http://musicbrainz.org", data=first_rec_id.encode("ascii")))

    if settings.embed_cover_art and album.cover_art_bytes:
        jpg_bytes, jpg_w, jpg_h, orig_fmt, _ = ensure_jpeg_cover(
            album.cover_art_bytes, album.cover_art_mime
        )
        album.cover_art_bytes = jpg_bytes
        album.cover_art_mime = "image/jpeg"
        if jpg_w > 0 and jpg_h > 0:
            album.cover_art_width = jpg_w
            album.cover_art_height = jpg_h
        if not album.cover_art_original_format:
            album.cover_art_original_format = orig_fmt

        tags.delall("APIC")
        tags.add(
            APIC(
                encoding=3,
                mime="image/jpeg",
                type=3,
                desc="Cover",
                data=jpg_bytes,
            )
        )

    return v2_version


def write_mp3_tags(
    output_mp3: Path,
    album: AlbumMetadata,
    track: TrackMetadata,
    settings: ExportSettings,
    preserve_existing: bool = True,
) -> Path:
    """Schreibt Picard-ID3v2-Frames (inkl. Multi-Value & Cover-Art) in eine MP3-Datei und bewahrt bei preserve_existing=True bereits vorhandene Tags."""
    from mutagen.id3 import ID3NoHeaderError

    if preserve_existing and output_mp3.exists():
        try:
            tags = ID3(str(output_mp3))
        except ID3NoHeaderError:
            tags = ID3()
    else:
        tags = ID3()

    v2_version = _populate_picard_id3_tags(
        tags, album, track, settings, preserve_existing=preserve_existing
    )
    if v2_version == 3:
        tags.update_to_v23()
        tags.save(str(output_mp3), v2_version=3, v23_sep=" / ")
    else:
        tags.save(str(output_mp3), v2_version=4)
    return output_mp3


def _write_mp4_tags_existing(
    file_path: Path,
    album: AlbumMetadata,
    track: TrackMetadata,
    settings: ExportSettings,
) -> Path:
    """Aktualisiert MP4/M4A-Tags nicht-destruktiv, sodass vorhandene iTunes-/ReplayGain-/Custom-Atoms erhalten bleiben."""
    from mutagen.mp4 import MP4, MP4Cover, MP4FreeForm

    audio = MP4(str(file_path))
    if audio.tags is None:
        audio.add_tags()
    tags = audio.tags
    assert tags is not None

    eff_disc = max(1, getattr(track, "disc_number", 0) or album.disc_number or 1)
    disc_tracks = [t for t in album.tracks if (getattr(t, "disc_number", 0) or album.disc_number or 1) == eff_disc]
    total_tracks = len(disc_tracks) if disc_tracks else len(album.tracks)
    merged_extra = _collect_all_extra_tags(album, track)

    track_artist_vals = split_multi_value(normalize_multi_artist(track.artist or album.artist))
    album_artist_vals = split_multi_value(normalize_multi_artist(album.album_artist or album.artist))

    def _set_atom(atom: str, vals: list[str]) -> None:
        if vals:
            tags[atom] = vals

    _set_atom("\xa9nam", split_multi_value(track.title) or ([track.title] if track.title else []))
    _set_atom("\xa9ART", track_artist_vals)
    _set_atom("aART", album_artist_vals)
    _set_atom("\xa9alb", split_multi_value(album.title) or ([album.title] if album.title else []))
    tags["trkn"] = [(int(track.track_number or 1), int(total_tracks or 0))]
    tags["disk"] = [(int(eff_disc), int(album.total_discs or 1))]
    _set_atom("\xa9day", split_multi_value(album.release_date or album.year))
    _set_atom("\xa9gen", split_multi_value((getattr(track, "genre", "") or "").strip() or album.genre))
    _set_atom("\xa9wrt", _merge_multi_values(track.composer or album.composer))
    if track.artist_sort:
        _set_atom("soar", split_multi_value(normalize_multi_artist(track.artist_sort)))
    if album.album_artist_sort:
        _set_atom("soaa", split_multi_value(normalize_multi_artist(album.album_artist_sort)))

    def _set_freeform(name: str, vals: list[str]) -> None:
        if not vals:
            return
        # Vorhandene abweichende Groß-/Kleinschreibung für dasselbe iTunes-Atom ersetzen
        norm = name.strip().lower()
        for ex_k in list(tags.keys()):
            if str(ex_k).startswith("----:com.apple.iTunes:"):
                ex_name = str(ex_k).split(":", 2)[2].strip().lower()
                if ex_name == norm or ex_name.replace(" ", "_") == norm.replace(" ", "_"):
                    if str(ex_k) != f"----:com.apple.iTunes:{name}":
                        del tags[ex_k]
        tags[f"----:com.apple.iTunes:{name}"] = [MP4FreeForm(v.encode("utf-8")) for v in vals]

    _set_freeform("BARCODE", split_multi_value(album.barcode))
    _set_freeform("CATALOGNUMBER", split_multi_value(album.catalog_number))
    _set_freeform("LABEL", split_multi_value(album.label))
    _set_freeform("ISRC", _merge_multi_values(track.isrcs, track.isrc))
    _set_freeform("MusicBrainz Album Id", split_multi_value(album.musicbrainz_release_id))
    _set_freeform("MusicBrainz Release Group Id", split_multi_value(album.musicbrainz_release_group_id))
    _set_freeform("MusicBrainz Album Artist Id", split_multi_value(album.musicbrainz_album_artist_id))
    _set_freeform("MusicBrainz Track Id", split_multi_value(track.musicbrainz_recording_id))
    _set_freeform("MusicBrainz Release Track Id", split_multi_value(track.musicbrainz_track_id))
    _set_freeform("MusicBrainz Artist Id", split_multi_value(track.musicbrainz_artist_id))
    _set_freeform("MusicBrainz Work Id", split_multi_value(track.musicbrainz_work_id))

    for extra_key, extra_vals in merged_extra.items():
        if not extra_vals:
            continue
        upper_key = extra_key.upper()
        if upper_key == "COMMENT":
            _set_atom("\xa9cmt", extra_vals)
        elif upper_key == "LYRICS":
            _set_atom("\xa9lyr", extra_vals)
        elif upper_key == "COPYRIGHT":
            _set_atom("cprt", extra_vals)
        elif upper_key == "GROUPING":
            _set_atom("\xa9grp", extra_vals)
        else:
            _set_freeform(_PICARD_ID3_TXXX_MAP.get(upper_key, extra_key), extra_vals)

    if settings.embed_cover_art and album.cover_art_bytes:
        jpg_bytes, jpg_w, jpg_h, orig_fmt, _ = ensure_jpeg_cover(
            album.cover_art_bytes, album.cover_art_mime
        )
        album.cover_art_bytes = jpg_bytes
        album.cover_art_mime = "image/jpeg"
        if jpg_w > 0 and jpg_h > 0:
            album.cover_art_width = jpg_w
            album.cover_art_height = jpg_h
        if not album.cover_art_original_format:
            album.cover_art_original_format = orig_fmt
        tags["covr"] = [MP4Cover(jpg_bytes, imageformat=MP4Cover.FORMAT_JPEG)]

    audio.save()
    return file_path


def write_tags_to_existing_file(
    file_path: Path,
    album: AlbumMetadata,
    track: TrackMetadata,
    settings: ExportSettings,
) -> Path:
    """Schreibt Picard-Metadaten-Tags und das Cover nicht-destruktiv in eine bereits vorhandene Audiodatei, ohne bestehende Tags (z. B. ReplayGain, AcoustID, Custom-Tags) zu löschen."""
    if not file_path.exists():
        raise FileNotFoundError(f"Audiodatei nicht gefunden: {file_path}")

    if settings.save_folder_cover and album.cover_art_bytes:
        try:
            jpg_bytes, jpg_w, jpg_h, orig_fmt, _ = ensure_jpeg_cover(
                album.cover_art_bytes, album.cover_art_mime
            )
            album.cover_art_bytes = jpg_bytes
            album.cover_art_mime = "image/jpeg"
            if jpg_w > 0 and jpg_h > 0:
                album.cover_art_width = jpg_w
                album.cover_art_height = jpg_h
            if not album.cover_art_original_format:
                album.cover_art_original_format = orig_fmt
            cover_name = (settings.folder_cover_filename or "cover.jpg").strip() or "cover.jpg"
            if not cover_name.lower().endswith((".jpg", ".jpeg")):
                cover_name = f"{Path(cover_name).stem}.jpg"
            folder_cover_path = file_path.parent / cover_name
            folder_cover_path.write_bytes(jpg_bytes)
        except Exception:
            pass

    ext = file_path.suffix.lower()
    if ext == ".flac":
        return write_flac_tags(file_path, album, track, settings, preserve_existing=True)
    if ext in (".mp3", ".mp2"):
        return write_mp3_tags(file_path, album, track, settings, preserve_existing=True)
    if ext in (".m4a", ".mp4"):
        return _write_mp4_tags_existing(file_path, album, track, settings)
    if ext in (".ogg", ".opus", ".wv"):
        import mutagen  # type: ignore

        audio = mutagen.File(str(file_path), easy=False)
        if audio is None:
            raise RuntimeError(f"Audiodatei konnte nicht mit mutagen geöffnet werden: {file_path.name}")
        if getattr(audio, "tags", None) is None and hasattr(audio, "add_tags"):
            audio.add_tags()
        _populate_vorbis_tags_dict(audio, album, track, settings, preserve_existing=True)
        audio.save()
        return file_path

    container_cls = None
    if ext == ".wav":
        from mutagen.wave import WAVE

        container_cls = WAVE
    elif ext in (".aiff", ".aif", ".aifc"):
        from mutagen.aiff import AIFF

        container_cls = AIFF
    elif ext == ".dsf":
        from mutagen.dsf import DSF

        container_cls = DSF
    elif ext == ".tta":
        from mutagen.trueaudio import TrueAudio

        container_cls = TrueAudio

    if container_cls is not None:
        audio = container_cls(str(file_path))
        if getattr(audio, "tags", None) is None:
            audio.add_tags()
        v2_version = _populate_picard_id3_tags(
            audio.tags, album, track, settings, preserve_existing=True
        )
        if v2_version == 3:
            audio.tags.update_to_v23()
            try:
                audio.save(v2_version=3, v23_sep=" / ")
            except TypeError:
                audio.save(v2_version=3)
        else:
            audio.save(v2_version=4)
        return file_path

    raise RuntimeError(
        f"Direktes Tag-Schreiben für Dateiformat '{ext}' wird nicht unterstützt "
        "(unterstützt: .flac, .ogg, .opus, .wv, .m4a, .mp4 sowie ID3v2.3/v2.4-Formate .mp3, .mp2, .wav, .aiff, .aif, .aifc, .dsf, .tta)."
    )


