"""Schlüssellose Shazam- Musikerkennung (Audio-Fingerprinting & Katalog-Brücke) für MintRip Studio.

Unterstützt zwei kombinierte Verfahren komplett OHNE API-Schlüssel:
1. Akustischer Shazam-Audio-Fingerabdruck (`data:audio/vnd.shazam.sig;base64,...`)
   - Extrahiert per FFmpeg bis zu 4 energie-gewichtete, bis zu 24 Sekunden lange
     16-kHz-Mono-PCM-Fenster (`s16le`) inkl. Pegelnormalisierung.
   - Berechnet die Shazam-Frequenzspitzen-Signatur über den nativen `ShazamSignatureGenerator`.
   - Verifiziert Treffer über Mehr-Fenster-Konsens am offiziellen Endpunkt
     `https://amp.shazam.com/discovery/v5/de-DE/DE/iphone/-/tag/<UUID1>/<UUID2>`.
2. Schlüssellose Shazam-Katalog-Brücke (`iTunes Search -> Shazam a2st -> discovery/v5/track/<Key>`)
   - Falls keine Audiodatei vorliegt (z. B. reine CD-TOC vor dem Rippen) oder das Audio-Sample keinen
     direkten Treffer liefert, wird über den Apple/iTunes-Katalog (inkl. Spieldauer- und Tracknummer-Abgleich)
     die Track-ID ermittelt, über `https://www.shazam.com/services/sd/s/a2st/US/en-US/<AppleID>` in den
     Shazam-Track-Key übersetzt und anschließend über
     `https://amp.shazam.com/discovery/v5/de-DE/DE/iphone/-/track/<ShazamKey>` vollständig aufgelöst.
"""

from __future__ import annotations

import base64
import binascii
import json
import math
import os
import random
import re
import shutil
import struct
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Callable, Optional

from .models import AlbumMetadata, DEFAULT_SHAZAM_SAMPLE_SIZE, TrackMetadata, normalize_shazam_sample_size

SHAZAM_TAG_URL = (
    "https://amp.shazam.com/discovery/v5/{language}/{country}/iphone/-/tag/{uuid1}/{uuid2}"
    "?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3"
    "&sharehub=true&hubv5minorversion=v5.1&hidelb=true&video=v3"
)
SHAZAM_TRACK_URL = (
    "https://amp.shazam.com/discovery/v5/{language}/{country}/iphone/-/track/{track_key}"
    "?shazamapiversion=v3&video=v3"
)
SHAZAM_A2ST_URL = "https://www.shazam.com/services/sd/s/a2st/US/en-US/{apple_id}"
ITUNES_SEARCH_URL = "https://itunes.apple.com/search"

_IPHONE_USER_AGENTS = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
    "Dalvik/2.1.0 (Linux; U; Android 13; Pixel 7 Build/TQ3A.230805.001)",
)

_DATA_URI_PREFIX = "data:audio/vnd.shazam.sig;base64,"

# Vorberechnetes 2048-Punkt-Hanning-Fenster (exakt passend zur Shazam-Signatur-Spezifikation)
_HANNING_2048 = [
    0.5 * (1.0 - math.cos(2.0 * math.pi * i / 2047.0))
    for i in range(2048)
]

# Vorberechnete Bit-Reversal-Tabelle und Twiddle-Faktoren für 2048-Punkt-Radix-2-FFT
_FFT_N = 2048
_BIT_REV_2048 = [0] * _FFT_N
for _i in range(_FFT_N):
    _b = 0
    _x = _i
    for _ in range(11):
        _b = (_b << 1) | (_x & 1)
        _x >>= 1
    _BIT_REV_2048[_i] = _b

_FFT_STAGES: list[tuple[int, int, list[complex]]] = []
_step = 2
while _step <= _FFT_N:
    _half = _step // 2
    _ang = -2.0 * math.pi / _step
    _FFT_STAGES.append(
        (_step, _half, [complex(math.cos(_ang * k), math.sin(_ang * k)) for k in range(_half)])
    )
    _step <<= 1


def _log(msg: str, on_log: Optional[Callable[[str], None]] = None) -> None:
    if on_log:
        try:
            on_log(msg)
        except Exception:
            pass


def _shazam_headers(language: str = "de-DE") -> dict[str, str]:
    return {
        "X-Shazam-Platform": "IPHONE",
        "X-Shazam-AppVersion": "14.1.0",
        "Accept": "*/*",
        "Content-Type": "application/json",
        "Accept-Language": language,
        "User-Agent": random.choice(_IPHONE_USER_AGENTS),
    }


def _http_request_json(
    url: str,
    method: str = "GET",
    body_bytes: Optional[bytes] = None,
    headers: Optional[dict[str, str]] = None,
    timeout: int = 12,
    max_retries: int = 3,
    on_log: Optional[Callable[[str], None]] = None,
    label: str = "Shazam",
) -> Optional[dict]:
    req_headers = headers or _shazam_headers()
    for attempt in range(max_retries + 1):
        req = urllib.request.Request(url, data=body_bytes, headers=req_headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                return json.loads(raw)
        except urllib.error.HTTPError as http_exc:
            if http_exc.code in (429, 502, 503, 504) and attempt < max_retries:
                wait_s = 1.2 * (2 ** attempt)
                _log(
                    f"[{label}] HTTP {http_exc.code} – automatischer Wiederholungsversuch "
                    f"{attempt + 1}/{max_retries} in {wait_s:.1f}s...",
                    on_log,
                )
                time.sleep(wait_s)
                continue
            return None
        except Exception as exc:
            if attempt < max_retries:
                wait_s = 1.0 * (2 ** attempt)
                _log(
                    f"[{label}] Netzwerkfehler ({exc}) – Wiederholungsversuch {attempt + 1}/{max_retries}...",
                    on_log,
                )
                time.sleep(wait_s)
                continue
            return None
    return None


def _rfft_power_2048(windowed_samples: list[float]) -> list[float]:
    """Berechnet die 1025 Spektralleistungen |(FFT[k])|^2 / 2^17 eines 2048-Sample-Fensters."""
    try:
        import numpy as np  # type: ignore

        arr = np.asarray(windowed_samples, dtype=np.float64)
        spec = np.fft.rfft(arr)
        power = ((spec.real * spec.real) + (spec.imag * spec.imag)) / float(1 << 17)
        power = np.maximum(power, 1e-10)
        return power.tolist()
    except ImportError:
        pass

    # Reiner Python-Fallback: Zwei reelle 1024-FFTs über eine komplexe 1024-FFT oder 2048-Radix-2
    a = [complex(windowed_samples[_BIT_REV_2048[i]], 0.0) for i in range(_FFT_N)]
    for step, half, tw in _FFT_STAGES:
        for i in range(0, _FFT_N, step):
            for k in range(half):
                t = tw[k] * a[i + k + half]
                u = a[i + k]
                a[i + k] = u + t
                a[i + k + half] = u - t

    scale = float(1 << 17)
    out = [0.0] * 1025
    for k in range(1025):
        c = a[k]
        p = (c.real * c.real + c.imag * c.imag) / scale
        out[k] = p if p > 1e-10 else 1e-10
    return out


class ShazamSignatureGenerator:
    """Erzeugt aus 16-kHz-16-Bit-Mono-PCM-Samples (`s16le`) eine `data:audio/vnd.shazam.sig;base64,...`-URI."""

    def __init__(self) -> None:
        self._reset()

    def _reset(self) -> None:
        self.ring_buffer = [0] * 2048
        self.ring_pos = 0
        self.fft_outputs = [[0.0] * 1025 for _ in range(256)]
        self.fft_pos = 0
        self.spread_outputs = [[0.0] * 1025 for _ in range(256)]
        self.spread_pos = 0
        self.num_spread_done = 0
        self.num_samples = 0
        # Frequenzbänder: 0 (250-520 Hz), 1 (520-1450 Hz), 2 (1450-3500 Hz), 3 (3500-5500 Hz)
        self.band_peaks: dict[int, list[tuple[int, int, int]]] = {}

    def generate_signature_uri(
        self,
        s16le_samples: list[int],
        max_seconds: int = 24,
        max_samples: Optional[int] = None,
    ) -> tuple[str, int]:
        self._reset()
        target_samples = (
            max(80000, min(384000, int(max_samples)))
            if max_samples is not None
            else max(5, int(max_seconds)) * 16000
        )
        if len(s16le_samples) > target_samples:
            mid = len(s16le_samples) // 2
            s16le_samples = s16le_samples[mid - target_samples // 2 : mid + target_samples // 2]

        usable_len = len(s16le_samples) - (len(s16le_samples) % 128)
        self.num_samples = usable_len
        for idx in range(0, usable_len, 128):
            batch = s16le_samples[idx : idx + 128]
            self._do_fft(batch)
            self._do_peak_spreading()
            self.num_spread_done += 1
            if self.num_spread_done >= 46:
                self._do_peak_recognition()

        uri = self._encode_to_uri()
        sample_ms = max(1, round(self.num_samples / 16000.0 * 1000.0))
        return uri, sample_ms

    def _do_fft(self, batch_128: list[int]) -> None:
        pos = self.ring_pos
        for s in batch_128:
            self.ring_buffer[pos] = s
            pos = (pos + 1) & 2047
        self.ring_pos = pos

        windowed = [
            float(self.ring_buffer[(pos + i) & 2047]) * _HANNING_2048[i]
            for i in range(2048)
        ]
        power = _rfft_power_2048(windowed)
        self.fft_outputs[self.fft_pos & 255] = power
        self.fft_pos += 1

    def _do_peak_spreading(self) -> None:
        orig = self.fft_outputs[(self.fft_pos - 1) & 255]
        spread = list(orig)
        for p in range(1023):
            m = spread[p]
            if spread[p + 1] > m:
                m = spread[p + 1]
            if spread[p + 2] > m:
                m = spread[p + 2]
            spread[p] = m

        cur_spread_idx = self.spread_pos
        self.spread_outputs[cur_spread_idx & 255] = spread
        for offset in (-1, -3, -6):
            former = self.spread_outputs[(cur_spread_idx + offset) & 255]
            for p in range(1025):
                if spread[p] > former[p]:
                    former[p] = spread[p]
        self.spread_pos += 1

    def _do_peak_recognition(self) -> None:
        fft_46 = self.fft_outputs[(self.fft_pos - 46) & 255]
        spread_49 = self.spread_outputs[(self.spread_pos - 49) & 255]
        min_peak = 1.0 / 64.0

        for bin_pos in range(10, 1015):
            val = fft_46[bin_pos]
            if val < min_peak or val < spread_49[bin_pos - 1]:
                continue

            max_nb = 0.0
            for nb_off in (-10, -7, -4, -3, 1, 2, 5, 8):
                cand = spread_49[bin_pos + nb_off]
                if cand > max_nb:
                    max_nb = cand
            if val <= max_nb:
                continue

            max_adj = max_nb
            for other_off in (-53, -45, 165, 172, 179, 186, 193, 200, 214, 221, 228, 235, 242, 249):
                cand = self.spread_outputs[(self.spread_pos + other_off) & 255][bin_pos - 1]
                if cand > max_adj:
                    max_adj = cand
            if val <= max_adj:
                continue

            fft_num = self.num_spread_done - 46
            mag = math.log(max(min_peak, val)) * 1477.3 + 6144.0
            mag_before = math.log(max(min_peak, fft_46[bin_pos - 1])) * 1477.3 + 6144.0
            mag_after = math.log(max(min_peak, fft_46[bin_pos + 1])) * 1477.3 + 6144.0

            var1 = mag * 2.0 - mag_before - mag_after
            if var1 <= 0:
                continue
            var2 = (mag_after - mag_before) * 32.0 / var1
            corrected_bin = int(round(bin_pos * 64.0 + var2)) & 0xFFFF
            freq_hz = corrected_bin * (16000.0 / 2.0 / 1024.0 / 64.0)

            if freq_hz < 250.0 or freq_hz > 5500.0:
                continue
            elif freq_hz < 520.0:
                band = 0
            elif freq_hz < 1450.0:
                band = 1
            elif freq_hz < 3500.0:
                band = 2
            else:
                band = 3

            peak_mag_int = int(round(mag)) & 0xFFFF
            self.band_peaks.setdefault(band, []).append((fft_num, peak_mag_int, corrected_bin))

    def _encode_to_uri(self) -> str:
        contents = bytearray()
        for band in sorted(self.band_peaks.keys()):
            peaks = self.band_peaks[band]
            peaks_buf = bytearray()
            last_pass = 0
            for fft_num, peak_mag, corr_bin in peaks:
                if fft_num - last_pass >= 0xFF:
                    peaks_buf.append(0xFF)
                    peaks_buf.extend(struct.pack("<I", fft_num))
                    last_pass = fft_num
                peaks_buf.append(fft_num - last_pass)
                peaks_buf.extend(struct.pack("<H", max(0, peak_mag - 1) & 0xFFFF))
                peaks_buf.extend(struct.pack("<H", max(0, corr_bin - 1) & 0xFFFF))
                last_pass = fft_num

            contents.extend(struct.pack("<I", 0x60030040 + band))
            contents.extend(struct.pack("<I", len(peaks_buf)))
            contents.extend(peaks_buf)
            pad = (4 - (len(peaks_buf) % 4)) % 4
            if pad:
                contents.extend(b"\x00" * pad)

        size_minus_header = len(contents) + 8
        shifted_sr_id = 3 << 27  # SampleRate._16000 == 3
        fixed_val = (15 << 19) + 0x40000
        num_samples_plus = int(round(self.num_samples + 16000 * 0.24))

        def pack_header(crc_val: int) -> bytes:
            return struct.pack(
                "<12I",
                0xCAFE2580,
                crc_val & 0xFFFFFFFF,
                size_minus_header,
                0x94119C00,
                0,
                0,
                0,
                shifted_sr_id,
                0,
                0,
                num_samples_plus,
                fixed_val,
            )

        body_after_header = struct.pack("<II", 0x40000000, size_minus_header) + bytes(contents)
        temp_header = pack_header(0)
        crc = binascii.crc32(temp_header[8:] + body_after_header) & 0xFFFFFFFF
        final_bytes = pack_header(crc) + body_after_header
        return _DATA_URI_PREFIX + base64.b64encode(final_bytes).decode("ascii")


def _probe_audio_duration_seconds(file_path: str) -> float:
    ffprobe_bin = shutil.which("ffprobe")
    if not ffprobe_bin or not file_path:
        return 0.0
    try:
        out = subprocess.check_output(
            [
                ffprobe_bin,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                file_path,
            ],
            timeout=6,
        )
        return max(0.0, float(out.decode("utf-8", errors="ignore").strip()))
    except Exception:
        return 0.0


def _decode_pcm16_window(ffmpeg_bin: str, file_path: str, start_sec: float, window_seconds: int) -> list[int]:
    cmd = [
        ffmpeg_bin,
        "-loglevel",
        "quiet",
        "-ss",
        f"{max(0.0, start_sec):.1f}",
        "-t",
        str(window_seconds),
        "-i",
        file_path,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "s16le",
        "-",
    ]
    try:
        raw = subprocess.check_output(cmd, timeout=20)
        count = len(raw) // 2
        if count == 0:
            return []
        return list(struct.unpack(f"<{count}h", raw[: count * 2]))
    except Exception:
        return []


def normalize_pcm16_samples(raw_samples: list[int]) -> list[int]:
    """Hebt sehr leise Aufnahmen behutsam auf optimalen Fingerabdruck-Pegel an (ohne Clipping)."""
    if not raw_samples:
        return raw_samples
    peak = max((abs(s) for s in raw_samples), default=0)
    if peak < 64:
        return raw_samples
    rms = math.sqrt(sum(s * s for s in raw_samples) / float(len(raw_samples)))
    gain = 1.0
    if rms > 0.0 and rms < 4800.0:
        gain = min(8.0, 4800.0 / rms)
    elif peak < 24000:
        gain = min(4.0, 24000.0 / float(peak))
    gain = min(gain, 28000.0 / float(peak))
    if gain <= 1.08:
        return raw_samples
    return [
        32767 if v > 32767 else (-32768 if v < -32768 else v)
        for v in (int(round(s * gain)) for s in raw_samples)
    ]


def extract_pcm16_windows_from_file(
    file_path: str,
    duration_seconds: int = 0,
    window_seconds: int = 24,
    sample_size: Optional[int] = None,
) -> list[list[int]]:
    """Extrahiert ein 16-kHz-Mono-PCM-Sample aus der Track-Mitte (bei 50 % der Gesamtdauer) via FFmpeg."""
    if not file_path or not os.path.isfile(file_path):
        return []
    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        return []

    target_samples = (
        max(80000, min(384000, int(sample_size)))
        if sample_size is not None
        else max(5, min(24, int(window_seconds))) * 16000
    )
    win_sec = target_samples / 16000.0
    dur = float(duration_seconds) if duration_seconds > 0 else _probe_audio_duration_seconds(file_path)

    max_start = max(0.0, dur - win_sec) if dur > 0 else 0.0
    mid_start = 0.0 if dur <= win_sec else max(0.0, min(max_start, dur * 0.5 - win_sec * 0.5))

    decode_sec = max(1, int(math.ceil(win_sec)))
    mid_samples = _decode_pcm16_window(ffmpeg_bin, file_path, mid_start, decode_sec)[:target_samples]
    if len(mid_samples) < 16000 and mid_start > 0.0:
        mid_samples = _decode_pcm16_window(ffmpeg_bin, file_path, 0.0, decode_sec)[:target_samples]
    if len(mid_samples) < 16000:
        return []

    mid_rms = math.sqrt(sum(s * s for s in mid_samples) / float(len(mid_samples)))
    if mid_rms >= 120.0 or max_start <= 1.0:
        return [mid_samples]

    # Nur falls genau bei 50 % digitale Stille herrscht, leicht versetzte Mittenfenster (40 % / 60 %) prüfen
    best_samples = mid_samples
    best_rms = mid_rms
    for ratio in (0.40, 0.60):
        cand_start = max(0.0, min(max_start, dur * ratio - win_sec * 0.5))
        if abs(cand_start - mid_start) < 2.0:
            continue
        cand = _decode_pcm16_window(ffmpeg_bin, file_path, cand_start, decode_sec)[:target_samples]
        if len(cand) < 16000:
            continue
        c_rms = math.sqrt(sum(s * s for s in cand) / float(len(cand)))
        if c_rms > best_rms:
            best_rms = c_rms
            best_samples = cand
    return [best_samples]


def extract_pcm16_mono_from_file(
    file_path: str,
    duration_seconds: int = 0,
    window_seconds: int = 24,
    sample_size: Optional[int] = None,
) -> list[int]:
    """Dekodiert ein 16-kHz-Mono-PCM-Fenster aus der Track-Mitte (50 %) via FFmpeg."""
    windows = extract_pcm16_windows_from_file(
        file_path=file_path,
        duration_seconds=duration_seconds,
        window_seconds=window_seconds,
        sample_size=sample_size,
    )
    return windows[0] if windows else []


def extract_pcm16_midpoint_from_cd(
    device_path: str,
    track_number: int,
    duration_seconds: int,
    sample_size: int = DEFAULT_SHAZAM_SAMPLE_SIZE,
) -> list[int]:
    """Extrahiert für physische Audio-CDs das Shazam-Sample zentriert bei 50 % der Trackdauer per cdparanoia."""
    if not device_path or not os.path.exists(device_path) or track_number < 1 or duration_seconds <= 1:
        return []
    cdparanoia_bin = shutil.which("cdparanoia")
    if not cdparanoia_bin:
        return []

    target_samples = max(80000, min(384000, int(sample_size)))
    sample_sec = target_samples / 16000.0
    dur = float(duration_seconds)
    start_sec = (
        0.0
        if dur <= sample_sec
        else max(0.0, min(max(0.0, dur - sample_sec - 0.1), dur * 0.5 - sample_sec * 0.5))
    )
    end_sec = min(max(start_sec + 1.0, dur - 0.05), start_sec + sample_sec)

    def _fmt_span(sec_val: float) -> str:
        total_frames = max(0, int(round(sec_val * 75.0)))
        ff = total_frames % 75
        whole = total_frames // 75
        ss = whole % 60
        mm_total = whole // 60
        hh = mm_total // 60
        mm = mm_total % 60
        base = f"{mm:02d}:{ss:02d}.{ff:02d}"
        return f"{hh}:{base}" if hh > 0 else base

    real_dev = os.path.realpath(device_path)
    span_arg = f"{track_number}[{_fmt_span(start_sec)}]-{track_number}[{_fmt_span(end_sec)}]"

    try:
        from .cd_reader import set_cd_read_speed
    except Exception:
        set_cd_read_speed = None  # type: ignore[assignment]

    if set_cd_read_speed is not None:
        set_cd_read_speed(real_dev, 2)
    try:
        raw_wav = b""
        for cmd in (
            [cdparanoia_bin, "-d", real_dev, "-S", "2", "-Z", "-q", span_arg, "-"],
            [cdparanoia_bin, "-d", real_dev, "-Z", "-q", span_arg, "-"],
        ):
            try:
                out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, timeout=25)
                if out and len(out) > 44 and out[:4] == b"RIFF":
                    raw_wav = out
                    break
            except Exception:
                continue
        if len(raw_wav) <= 44:
            return []

        data_offset = 44
        data_len = len(raw_wav) - 44
        pos = 12
        while pos + 8 <= len(raw_wav):
            cid = raw_wav[pos : pos + 4]
            csize = struct.unpack_from("<I", raw_wav, pos + 4)[0]
            if cid == b"data":
                data_offset = pos + 8
                data_len = min(csize, len(raw_wav) - data_offset)
                break
            pos += 8 + csize + (csize % 2)

        frame_count = data_len // 4
        if frame_count < 44100:
            return []
        stereo = struct.unpack_from(f"<{frame_count * 2}h", raw_wav, data_offset)
        mono = [(stereo[i * 2] + stereo[i * 2 + 1]) * 0.5 for i in range(frame_count)]
        step = 44100.0 / 16000.0
        out_count = min(target_samples, int((frame_count - 1) / step))
        if out_count < 16000:
            return []
        resampled: list[int] = []
        for k in range(out_count):
            src_pos = k * step
            idx = int(src_pos)
            frac = src_pos - idx
            val = int(round(mono[idx] * (1.0 - frac) + mono[idx + 1] * frac))
            resampled.append(32767 if val > 32767 else (-32768 if val < -32768 else val))
        return resampled
    finally:
        if set_cd_read_speed is not None:
            set_cd_read_speed(real_dev, 0)


def parse_shazam_track_payload(track_obj: dict, method_label: str = "Shazam") -> dict:
    """Extrahiert alle relevanten Metadaten (Titel, Interpret, ISRC, Album, Jahr, Label, Genre, Cover) aus einem Shazam-Track."""
    key = str(track_obj.get("key") or "").strip()
    title = str(track_obj.get("title") or "").strip()
    artist = str(track_obj.get("subtitle") or "").strip()
    isrc = str(track_obj.get("isrc") or "").strip()
    shazam_url = str(track_obj.get("url") or track_obj.get("share", {}).get("href") or "").strip()

    genres_obj = track_obj.get("genres") or {}
    genre = str(genres_obj.get("primary") or "").strip()

    images_obj = track_obj.get("images") or {}
    cover_url = str(
        images_obj.get("coverarthq")
        or images_obj.get("coverart")
        or track_obj.get("share", {}).get("image")
        or ""
    ).strip()

    album_name = ""
    label_name = ""
    released_year = ""

    for sec in track_obj.get("sections") or []:
        if not isinstance(sec, dict):
            continue
        if sec.get("type") == "SONG":
            for meta in sec.get("metadata") or []:
                if not isinstance(meta, dict):
                    continue
                m_title = str(meta.get("title") or "").strip().lower().rstrip(":")
                m_text = str(meta.get("text") or "").strip()
                if not m_text:
                    continue
                if m_title in ("album",):
                    album_name = m_text
                elif m_title in ("label",):
                    label_name = m_text
                elif m_title in ("released", "veröffentlicht", "erscheinungsjahr"):
                    m_yr = re.search(r"\b(19\d{2}|20\d{2})\b", m_text)
                    released_year = m_yr.group(1) if m_yr else m_text[:4]

    return {
        "shazam_key": key,
        "title": title,
        "artist": artist,
        "album": album_name,
        "label": label_name,
        "year": released_year,
        "genre": genre,
        "isrc": isrc,
        "cover_url": cover_url,
        "shazam_url": shazam_url,
        "method": method_label,
    }


def _query_shazam_tag_once(
    s16le_samples: list[int],
    max_seconds: int = 24,
    language: str = "de-DE",
    country: str = "DE",
    on_log: Optional[Callable[[str], None]] = None,
    max_samples: Optional[int] = None,
) -> Optional[dict]:
    gen = ShazamSignatureGenerator()
    sig_uri, sample_ms = gen.generate_signature_uri(
        s16le_samples,
        max_seconds=max_seconds,
        max_samples=max_samples,
    )
    url = SHAZAM_TAG_URL.format(
        language=language,
        country=country,
        uuid1=str(uuid.uuid4()).upper(),
        uuid2=str(uuid.uuid4()).upper(),
    )
    payload = {
        "timezone": "Europe/Berlin",
        "signature": {
            "uri": sig_uri,
            "samplems": sample_ms,
        },
        "timestamp": int(time.time() * 1000),
        "context": {},
        "geolocation": {},
    }
    body_bytes = json.dumps(payload).encode("utf-8")
    resp = _http_request_json(
        url,
        method="POST",
        body_bytes=body_bytes,
        headers=_shazam_headers(language),
        on_log=on_log,
        label="Shazam Audio-Tag",
    )
    if not resp:
        return None
    matches = resp.get("matches") or []
    track_obj = resp.get("track")
    if not matches or not isinstance(track_obj, dict):
        return None
    parsed = parse_shazam_track_payload(track_obj, method_label="Shazam Audio-Fingerprint")
    parsed["match_strength"] = len(matches)
    return parsed


def recognize_samples_via_shazam_tag(
    s16le_samples: list[int],
    language: str = "de-DE",
    country: str = "DE",
    on_log: Optional[Callable[[str], None]] = None,
    sample_size: int = DEFAULT_SHAZAM_SAMPLE_SIZE,
) -> Optional[dict]:
    """Sendet einen Fingerabdruck (gewählte Samplegröße) an `amp.shazam.com/discovery/v5/.../tag/...`."""
    if len(s16le_samples) < 16000:
        return None
    target_samples = max(80000, min(384000, int(sample_size)))
    samples = normalize_pcm16_samples(s16le_samples)
    primary = _query_shazam_tag_once(
        samples,
        max_samples=target_samples,
        language=language,
        country=country,
        on_log=on_log,
    )
    if primary:
        return primary
    if len(samples) > 14 * 16000 and target_samples > 14 * 16000:
        return _query_shazam_tag_once(
            samples,
            max_samples=12 * 16000,
            language=language,
            country=country,
            on_log=on_log,
        )
    return None


def lookup_shazam_via_catalog_bridge(
    artist: str,
    album_title: str,
    track_title: str,
    track_number: int = 0,
    duration_seconds: int = 0,
    language: str = "de-DE",
    country: str = "DE",
    on_log: Optional[Callable[[str], None]] = None,
    audio_attempted: bool = False,
) -> Optional[dict]:
    """Schlüssellose Shazam-Auflösung über iTunes-Index -> Shazam a2st Bridge -> discovery/v5/track/<Key>."""
    generic_re = re.compile(r"^(?:track|titel|audio|spur|song|unbekannt)\s*\d*$", re.IGNORECASE)
    clean_title = "" if generic_re.match(track_title.strip()) else track_title.strip()
    clean_artist = "" if artist.strip() in ("", "Unbekannter Künstler") else artist.strip()
    clean_album = (
        ""
        if album_title.strip()
        in (
            "",
            "Unbekanntes Album",
            "Audio-CD (Lokal ausgelesen)",
            "Lokaler Datei-Import (Virtuelle TOC)",
        )
        else album_title.strip()
    )

    search_terms: list[str] = []
    if clean_artist and clean_title:
        search_terms.append(f"{clean_artist} {clean_title}")
    if clean_artist and clean_album:
        search_terms.append(f"{clean_artist} {clean_album}")
    elif clean_title:
        search_terms.append(clean_title)
    elif clean_album:
        search_terms.append(clean_album)

    if not search_terms:
        return None

    candidates: list[dict] = []
    for term in search_terms[:2]:
        q_params = urllib.parse.urlencode(
            {
                "term": term,
                "entity": "song",
                "limit": 25,
                "country": country,
            }
        )
        data = _http_request_json(
            f"{ITUNES_SEARCH_URL}?{q_params}",
            headers={"User-Agent": random.choice(_IPHONE_USER_AGENTS), "Accept": "application/json"},
            on_log=on_log,
            label="Shazam Katalog-Index",
        )
        if data and isinstance(data.get("results"), list) and data["results"]:
            candidates.extend(data["results"])
            break

    if not candidates:
        return None

    def _fold(val: str) -> str:
        s = re.sub(r"\s*\((?:feat|ft|featuring)\b[^)]*\)", "", str(val or ""), flags=re.IGNORECASE)
        s = re.sub(r"[^\w\s]", " ", s, flags=re.UNICODE)
        return re.sub(r"\s+", " ", s).strip().lower()

    q_title_f = _fold(clean_title)
    q_artist_f = _fold(clean_artist.split(";")[0]) if clean_artist else ""
    q_album_f = _fold(clean_album)
    junk_re = re.compile(
        r"\b(?:karaoke|tribute|ringtone|lullaby|8-bit|made famous by|originally performed)\b",
        re.IGNORECASE,
    )

    def score_itunes_item(item: dict) -> float:
        s = 0.0
        raw_item_title = str(item.get("trackName") or "")
        item_title = _fold(raw_item_title)
        item_artist = _fold(str(item.get("artistName") or ""))
        item_album = _fold(str(item.get("collectionName") or ""))
        item_tnum = int(item.get("trackNumber") or 0)
        item_dur_s = round(int(item.get("trackTimeMillis") or 0) / 1000.0)

        if q_title_f:
            if item_title == q_title_f:
                s += 55.0
            elif q_title_f in item_title or item_title in q_title_f:
                s += 38.0
        if q_artist_f:
            if item_artist == q_artist_f:
                s += 40.0
            elif q_artist_f in item_artist or item_artist in q_artist_f:
                s += 26.0
        if q_album_f and (q_album_f in item_album or item_album in q_album_f):
            s += 25.0
        if track_number > 0 and item_tnum == track_number:
            s += 20.0
        if duration_seconds > 0 and item_dur_s > 0:
            diff = abs(item_dur_s - duration_seconds)
            if diff <= 2:
                s += 40.0
            elif diff <= 5:
                s += 24.0
            elif diff <= 10:
                s += 8.0
            else:
                s -= diff * 2.0
        if junk_re.search(raw_item_title) and not junk_re.search(clean_title):
            s -= 80.0
        return s

    ranked = sorted(
        [(score_itunes_item(cand), cand) for cand in candidates],
        key=lambda pair: pair[0],
        reverse=True,
    )
    min_score = 45.0 if audio_attempted else 22.0
    for score, cand in ranked[:5]:
        if audio_attempted and not clean_title and not clean_album:
            continue
        if (q_title_f or q_artist_f) and score < min_score:
            continue
        apple_id = cand.get("trackId")
        if not apple_id:
            continue
        a2st_url = SHAZAM_A2ST_URL.format(apple_id=apple_id)
        mapping = _http_request_json(
            a2st_url,
            headers={
                "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 13; Pixel 7 Build/TQ3A.230805.001)",
                "Accept": "*/*",
            },
            on_log=on_log,
            label="Shazam a2st-Bridge",
        )
        shazam_key = ""
        if isinstance(mapping, dict) and "error" not in mapping:
            shazam_key = str(mapping.get(str(apple_id)) or next(iter(mapping.values()), "")).strip()

        if shazam_key:
            track_url = SHAZAM_TRACK_URL.format(
                language=language,
                country=country,
                track_key=shazam_key,
            )
            track_data = _http_request_json(
                track_url,
                headers=_shazam_headers(language),
                on_log=on_log,
                label="Shazam Track-Details",
            )
            if isinstance(track_data, dict) and track_data.get("title"):
                return parse_shazam_track_payload(track_data, method_label=f"Shazam (#{shazam_key})")

        # Falls a2st für diese ID keinen Key liefert, aber eine Preview-URL existiert: vollen 24s Audio-Fingerprint ausführen!
        preview_url = str(cand.get("previewUrl") or "").strip()
        if preview_url and shutil.which("ffmpeg"):
            try:
                cmd = [
                    shutil.which("ffmpeg") or "ffmpeg",
                    "-loglevel",
                    "quiet",
                    "-t",
                    "24",
                    "-i",
                    preview_url,
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-f",
                    "s16le",
                    "-",
                ]
                raw_pcm = subprocess.check_output(cmd, timeout=18)
                cnt = len(raw_pcm) // 2
                if cnt >= 16000:
                    samples = list(struct.unpack(f"<{cnt}h", raw_pcm[: cnt * 2]))
                    fp_res = recognize_samples_via_shazam_tag(samples, language=language, country=country, on_log=on_log)
                    if fp_res:
                        return fp_res
            except Exception:
                pass

    return None


def _shazam_consensus_key(hit: dict) -> str:
    skey = str(hit.get("shazam_key") or "").strip()
    if skey:
        return f"key:{skey}"
    def _norm(val: str) -> str:
        s = re.sub(r"\s*\([^)]*\)", "", str(val or ""))
        s = re.sub(r"[^\w\s]", " ", s, flags=re.UNICODE)
        return re.sub(r"\s+", " ", s).strip().lower()
    return f"txt:{_norm(hit.get('artist') or '')}|{_norm(hit.get('title') or '')}"


def recognize_track_with_shazam(
    track: TrackMetadata,
    album: Optional[AlbumMetadata] = None,
    on_log: Optional[Callable[[str], None]] = None,
    cancel_event: Optional[threading.Event] = None,
    sample_size: int = DEFAULT_SHAZAM_SAMPLE_SIZE,
    device_path: Optional[str] = None,
) -> Optional[dict]:
    """Führt für einen einzelnen Track eine schlüssellose Shazam-Abfrage (1. 50%-Mitten-Audio-Fingerprint -> 2. Katalog-Brücke) durch."""
    if cancel_event is not None and cancel_event.is_set():
        return None
    target_samples = normalize_shazam_sample_size(sample_size)
    sample_sec = target_samples / 16000.0
    t_num = track.track_number
    _log(
        f"[Shazam] Starte schlüssellose Shazam-Abfrage für Track #{t_num:02d} („{track.title}“, Samplegröße: {target_samples} Samples / {sample_sec:.1f}s)...",
        on_log,
    )

    # 1. Akustischer Audio-Fingerabdruck exakt aus Track-Mitte (50 % der Gesamtdauer)
    windows: list[list[int]] = []
    if track.source_file and os.path.isfile(track.source_file):
        if cancel_event is not None and cancel_event.is_set():
            return None
        _log(
            f"[Shazam] Extrahiere Audio-Sample aus Track-Mitte (50 %, {target_samples} Samples / {sample_sec:.1f}s @ 16 kHz Mono PCM) aus „{os.path.basename(track.source_file)}“...",
            on_log,
        )
        windows = extract_pcm16_windows_from_file(
            track.source_file,
            duration_seconds=track.duration_seconds,
            sample_size=target_samples,
        )
    elif device_path and os.path.exists(device_path) and track.duration_seconds > 1:
        if cancel_event is not None and cancel_event.is_set():
            return None
        _log(
            f"[Shazam] Extrahiere CD-Audio-Sample aus Track-Mitte (50 %, {target_samples} Samples / {sample_sec:.1f}s) für Track #{t_num:02d}...",
            on_log,
        )
        phys_t_num = int(getattr(track, "toc_track_number", 0) or 0) or t_num
        cd_mid = extract_pcm16_midpoint_from_cd(
            device_path=device_path,
            track_number=phys_t_num,
            duration_seconds=track.duration_seconds,
            sample_size=target_samples,
        )
        if len(cd_mid) >= 16000:
            windows = [cd_mid]

    windows_checked = bool(windows)
    if windows:
        candidates: dict[str, dict] = {}
        confirmed_hit: Optional[dict] = None

        for w_idx, samples in enumerate(windows, start=1):
            if cancel_event is not None and cancel_event.is_set():
                return None
            eff_len = min(len(samples), target_samples)
            sec_dur = eff_len / 16000.0
            _log(
                f"[Shazam] Sende akustischen Fingerabdruck aus Track-Mitte (50 %, {sec_dur:.1f}s / {eff_len} Samples) an amp.shazam.com/discovery/v5...",
                on_log,
            )
            res = recognize_samples_via_shazam_tag(
                samples,
                on_log=on_log,
                sample_size=target_samples,
            )
            if cancel_event is not None and cancel_event.is_set():
                return None
            if not res or not res.get("title"):
                continue

            ckey = _shazam_consensus_key(res)
            entry = candidates.get(ckey)
            if entry is not None:
                entry["votes"] += 1
                entry["strength_sum"] += int(res.get("match_strength") or 1)
                confirmed_hit = entry["hit"]
                break
            else:
                candidates[ckey] = {
                    "hit": res,
                    "votes": 1,
                    "strength_sum": int(res.get("match_strength") or 1),
                    "first_idx": w_idx,
                }
                _log(
                    f"[Shazam] Audio-Fingerprint-Treffer für Track #{t_num:02d}: "
                    f"{res.get('artist')} – {res.get('title')} (Shazam-Key #{res.get('shazam_key')}, ISRC: {res.get('isrc') or '—'}).",
                    on_log,
                )

        if cancel_event is not None and cancel_event.is_set():
            return None

        if confirmed_hit is None and candidates:
            ranked = sorted(
                candidates.values(),
                key=lambda e: (-e["votes"], -e["strength_sum"], e["first_idx"]),
            )
            confirmed_hit = ranked[0]["hit"]

        if confirmed_hit is not None:
            confirmed_hit.pop("match_strength", None)
            return confirmed_hit

        _log(
            f"[Shazam] Kein direkter Audio-Fingerprint-Treffer für Track #{t_num:02d} – prüfe Shazam-Katalog-Brücke...",
            on_log,
        )

    if cancel_event is not None and cancel_event.is_set():
        return None

    # 2. Schlüssellose Shazam-Katalog-Brücke (für CD-Tracks ohne lokale Datei oder als Fallback)
    album_artist = (album.album_artist or album.artist if album else "") or track.artist
    album_title = album.title if album else ""
    res_cat = lookup_shazam_via_catalog_bridge(
        artist=track.artist or album_artist,
        album_title=album_title,
        track_title=track.title,
        track_number=track.track_number,
        duration_seconds=track.duration_seconds,
        on_log=on_log,
        audio_attempted=windows_checked,
    )
    if cancel_event is not None and cancel_event.is_set():
        return None
    if res_cat and res_cat.get("title"):
        _log(
            f"[Shazam] Katalog-Treffer für Track #{t_num:02d}: {res_cat.get('artist')} – {res_cat.get('title')} "
            f"(Shazam-Key #{res_cat.get('shazam_key')}, ISRC: {res_cat.get('isrc') or '—'}).",
            on_log,
        )
        return res_cat

    _log(f"[Shazam] Kein Treffer für Track #{t_num:02d} („{track.title}“) gefunden.", on_log)
    return None
