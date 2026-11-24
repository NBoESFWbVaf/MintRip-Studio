"""Modul 4 (Musik konvertieren): Einzeldateien & rekursive Ordner mit ffmpeg/Mutagen umwandeln."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from .cd_reader import extract_local_audio_file_info
from .encoder import copy_tags_and_cover_to_flac, probe_audio_pcm_params

SUPPORTED_CONVERTER_INPUT_EXTS = {
    ".wav",
    ".flac",
    ".mp3",
    ".mp2",
    ".aiff",
    ".aif",
    ".aifc",
    ".dsf",
    ".tta",
    ".ogg",
    ".opus",
    ".m4a",
    ".wv",
}

CONVERTER_TARGET_FORMATS: list[tuple[str, str]] = [
    ("flac", "FLAC — Verlustfrei (Vorbis Tags)"),
    ("mp3", "MP3 — LAME (ID3v2.3 / ID3v2.4)"),
    ("wav", "WAV — PCM unkomprimiert (ID3v2)"),
    ("opus", "Opus — Ogg Opus"),
    ("ogg", "Ogg Vorbis"),
    ("m4a", "M4A — AAC"),
    ("aiff", "AIFF — PCM (ID3v2)"),
]


def _natural_str_key(text: str) -> list:
    parts = re.split(r"(\d+)", str(text or "").lower())
    return [int(p) if p.isdigit() else p for p in parts]


def collect_audio_files_for_converter(
    paths: list[Path],
) -> list[tuple[Path, str]]:
    """Sammelt einzelne Audiodateien oder durchsucht Ordner rekursiv unter Erhalt der relativen Pfadstruktur."""
    collected: list[tuple[Path, str]] = []
    seen: set[Path] = set()

    for p in paths:
        if p.is_dir():
            root_name = p.name or "Ordner"
            children = sorted(p.rglob("*"), key=lambda c: _natural_str_key(str(c)))
            for child in children:
                if child.is_file() and child.suffix.lower() in SUPPORTED_CONVERTER_INPUT_EXTS:
                    resolved = child.resolve()
                    if resolved in seen:
                        continue
                    seen.add(resolved)
                    try:
                        rel_inside = child.relative_to(p).as_posix()
                        rel_path = f"{root_name}/{rel_inside}"
                    except Exception:
                        rel_path = child.name
                    collected.append((child, rel_path))
        elif p.is_file() and p.suffix.lower() in SUPPORTED_CONVERTER_INPUT_EXTS:
            resolved = p.resolve()
            if resolved in seen:
                continue
            seen.add(resolved)
            collected.append((p, p.name))

    return collected


@dataclass
class ConverterOptions:
    output_dir: Path
    target_format: str = "flac"
    flac_level: int = 6
    mp3_quality: str = "vbr_v0"
    bitrate_kbps: int = 192
    pcm_bits: int = 16
    id3v2_version: int = 4
    preserve_structure: bool = True
    preserve_tags: bool = True
    normalize_audio: bool = False
    target_lufs: float = -18.0


@dataclass
class ConverterJob:
    source_path: Path
    relative_path: str
    source_ext: str
    size_bytes: int
    duration_seconds: int
    artist: str = ""
    title: str = ""
    album: str = ""
    selected: bool = True
    job_id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])
    stage: str = "ready"
    progress: float = 0.0
    status_message: str = "Bereit"
    output_path: Optional[Path] = None

    def compute_target_path(self, output_dir: Path, target_format: str, preserve_structure: bool) -> Path:
        stem = self.source_path.stem
        rel_obj = Path(self.relative_path)
        if preserve_structure and len(rel_obj.parts) > 1:
            target = output_dir / rel_obj.parent / f"{stem}.{target_format}"
        else:
            target = output_dir / f"{stem}.{target_format}"
        try:
            if target.resolve() == self.source_path.resolve():
                target = target.with_name(f"{stem}_konvertiert.{target_format}")
        except Exception:
            pass
        return target


class ConverterManager:
    """Threadpool-basierte Batch-Konvertierung über ffmpeg unter GTK 3.0."""

    def __init__(self, max_workers: Optional[int] = None) -> None:
        self._max_workers = max(1, min(16, int(max_workers) if max_workers is not None else 4))
        self._executor: Optional[ThreadPoolExecutor] = None
        self._cancel_event = threading.Event()
        self._running_procs: set[subprocess.Popen] = set()
        self._proc_lock = threading.Lock()
        self.jobs: list[ConverterJob] = []
        self.on_job_updated: Optional[Callable[[ConverterJob], None]] = None
        self.on_all_finished: Optional[Callable[[bool], None]] = None
        self.on_log: Optional[Callable[[str], None]] = None
        self._active_futures_count = 0
        self._count_lock = threading.Lock()

    def set_max_workers(self, max_workers: int) -> None:
        self._max_workers = max(1, min(16, int(max_workers or 4)))

    def add_paths(self, paths: list[Path]) -> list[ConverterJob]:
        existing = {j.source_path.resolve() for j in self.jobs if j.source_path.exists()}
        added: list[ConverterJob] = []
        for abs_path, rel_path in collect_audio_files_for_converter(paths):
            resolved = abs_path.resolve()
            if resolved in existing:
                continue
            existing.add(resolved)
            info = extract_local_audio_file_info(abs_path, fallback_track_num=len(self.jobs) + len(added) + 1)
            size_bytes = abs_path.stat().st_size if abs_path.exists() else 0
            job = ConverterJob(
                source_path=abs_path,
                relative_path=rel_path,
                source_ext=abs_path.suffix.lstrip(".").upper() or "AUDIO",
                size_bytes=size_bytes,
                duration_seconds=int(info.get("duration_seconds") or 0),
                artist=str(info.get("artist") or ""),
                title=str(info.get("title") or abs_path.stem),
                album=str(info.get("album") or ""),
                selected=True,
                stage="ready",
                progress=0.0,
                status_message="Bereit zur Konvertierung",
            )
            self.jobs.append(job)
            added.append(job)
        return added

    def start(self, options: ConverterOptions, max_workers: Optional[int] = None) -> int:
        selected = [j for j in self.jobs if j.selected]
        if not selected:
            return 0
        if not shutil.which("ffmpeg"):
            raise RuntimeError(
                "ffmpeg wurde nicht gefunden. Bitte installieren Sie ffmpeg (sudo apt install ffmpeg)."
            )
        if max_workers is not None:
            self.set_max_workers(max_workers)
        self._cancel_event.clear()
        worker_count = max(1, min(self._max_workers, len(selected)))
        ff_threads = max(1, self._max_workers // worker_count)
        self._executor = ThreadPoolExecutor(max_workers=worker_count)
        with self._count_lock:
            self._active_futures_count = len(selected)

        for job in selected:
            job.stage = "queued"
            job.progress = 0.0
            job.status_message = "In Warteschlange..."
            self._emit_update(job)
            self._executor.submit(self._run_job, job, options, ff_threads)
        return len(selected)

    def cancel_all(self) -> None:
        self._cancel_event.set()
        with self._proc_lock:
            for proc in list(self._running_procs):
                try:
                    proc.terminate()
                except Exception:
                    pass
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None
        for job in self.jobs:
            if job.stage in ("queued", "converting"):
                job.stage = "cancelled"
                job.progress = 0.0
                job.status_message = "Abgebrochen"
                self._emit_update(job)

    def clear_finished(self) -> None:
        self.jobs = [j for j in self.jobs if j.stage not in ("done", "cancelled")]

    def clear_all(self) -> None:
        self.cancel_all()
        self.jobs.clear()

    def _emit_update(self, job: ConverterJob) -> None:
        if self.on_job_updated:
            self.on_job_updated(job)

    def _emit_log(self, message: str) -> None:
        if self.on_log:
            self.on_log(message)

    def _run_job(
        self, job: ConverterJob, options: ConverterOptions, ffmpeg_threads: int = 1
    ) -> None:
        cancelled_run = False
        try:
            if self._cancel_event.is_set():
                job.stage = "cancelled"
                job.progress = 0.0
                job.status_message = "Abgebrochen"
                self._emit_update(job)
                cancelled_run = True
                return

            eff_threads = max(1, min(16, int(ffmpeg_threads or 1)))
            fmt = options.target_format.lower()
            out_path = job.compute_target_path(
                options.output_dir, fmt, options.preserve_structure
            )
            out_path.parent.mkdir(parents=True, exist_ok=True)

            job.stage = "converting"
            job.progress = 0.05
            job.status_message = (
                "Schritt 1/2: Quelle nach WAV umwandeln..."
                if fmt == "flac"
                else f"Konvertiere nach {fmt.upper()}..."
            )
            self._emit_update(job)

            if fmt == "flac":
                pcm_codec, sample_rate = probe_audio_pcm_params(job.source_path)
                level = max(0, min(8, options.flac_level))
                with tempfile.TemporaryDirectory(prefix="mintrip_conv_wav_") as tmp_dir:
                    tmp_wav = Path(tmp_dir) / "intermediate.wav"
                    step1_cmd: list[str] = [
                        "ffmpeg",
                        "-y",
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-threads",
                        str(eff_threads),
                        "-filter_threads",
                        str(eff_threads),
                        "-progress",
                        "pipe:1",
                        "-i",
                        str(job.source_path),
                        "-map",
                        "0:a:0",
                        "-vn",
                        "-map_metadata",
                        "-1",
                    ]
                    if options.normalize_audio:
                        step1_cmd.extend(
                            [
                                "-af",
                                f"loudnorm=I={options.target_lufs:.1f}:TP=-1.0:LRA=11",
                                "-ar",
                                str(sample_rate),
                            ]
                        )
                    step1_cmd.extend(["-c:a", pcm_codec, "-threads", str(eff_threads), str(tmp_wav)])

                    proc1 = subprocess.Popen(
                        step1_cmd,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        text=True,
                        bufsize=1,
                    )
                    with self._proc_lock:
                        self._running_procs.add(proc1)
                    total_us = max(1_000_000, int(max(1, job.duration_seconds) * 1_000_000))
                    if proc1.stdout is not None:
                        for line in proc1.stdout:
                            if self._cancel_event.is_set():
                                proc1.terminate()
                                break
                            if line.startswith("out_time_us="):
                                try:
                                    cur_us = int(line.split("=", 1)[1].strip())
                                    frac = max(0.05, min(0.55, 0.05 + 0.50 * (cur_us / total_us)))
                                    job.progress = frac
                                    job.status_message = f"Schritt 1/2: Quelle → WAV ({int(frac * 100)}%)..."
                                    self._emit_update(job)
                                except ValueError:
                                    pass
                    stderr1 = proc1.stderr.read() if proc1.stderr is not None else ""
                    ret1 = proc1.wait()
                    with self._proc_lock:
                        self._running_procs.discard(proc1)

                    if self._cancel_event.is_set():
                        out_path.unlink(missing_ok=True)
                        job.stage = "cancelled"
                        job.progress = 0.0
                        job.status_message = "Abgebrochen"
                        self._emit_update(job)
                        cancelled_run = True
                        return
                    if ret1 != 0 or not tmp_wav.exists():
                        raise RuntimeError((stderr1 or "").strip() or f"WAV-Zwischenschritt Exit-Code {ret1}")

                    job.progress = 0.62
                    job.status_message = f"Schritt 2/2: WAV → FLAC (Stufe {level} · Tags beibehalten)..."
                    self._emit_update(job)

                    if shutil.which("flac"):
                        flac_cmd = [
                            "flac",
                            f"-{level}",
                            "-f",
                            "--silent",
                            "-o",
                            str(out_path),
                            str(tmp_wav),
                        ]
                        proc2 = subprocess.Popen(
                            flac_cmd,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE,
                            text=True,
                        )
                        with self._proc_lock:
                            self._running_procs.add(proc2)
                        stderr2 = proc2.stderr.read() if proc2.stderr is not None else ""
                        ret2 = proc2.wait()
                        with self._proc_lock:
                            self._running_procs.discard(proc2)
                        if self._cancel_event.is_set():
                            out_path.unlink(missing_ok=True)
                            job.stage = "cancelled"
                            job.progress = 0.0
                            job.status_message = "Abgebrochen"
                            self._emit_update(job)
                            cancelled_run = True
                            return
                        if ret2 != 0 or not out_path.exists():
                            raise RuntimeError((stderr2 or "").strip() or f"flac Exit-Code {ret2}")
                        if options.preserve_tags:
                            job.progress = 0.90
                            job.status_message = "Übernehme Tags & Cover..."
                            self._emit_update(job)
                            copy_tags_and_cover_to_flac(job.source_path, out_path)
                    else:
                        step2_cmd: list[str] = [
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
                            str(tmp_wav),
                        ]
                        if options.preserve_tags:
                            step2_cmd.extend(
                                [
                                    "-i",
                                    str(job.source_path),
                                    "-map",
                                    "0:a:0",
                                    "-map",
                                    "1:v?",
                                    "-c:v",
                                    "copy",
                                    "-map_metadata",
                                    "1",
                                    "-map_metadata",
                                    "1:s:a:0",
                                ]
                            )
                        else:
                            step2_cmd.extend(["-map", "0:a:0", "-vn", "-map_metadata", "-1"])
                        step2_cmd.extend(
                            [
                                "-c:a",
                                "flac",
                                "-compression_level",
                                str(level),
                                "-threads",
                                str(eff_threads),
                                str(out_path),
                            ]
                        )
                        proc2 = subprocess.Popen(
                            step2_cmd,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE,
                            text=True,
                        )
                        with self._proc_lock:
                            self._running_procs.add(proc2)
                        stderr2 = proc2.stderr.read() if proc2.stderr is not None else ""
                        ret2 = proc2.wait()
                        with self._proc_lock:
                            self._running_procs.discard(proc2)
                        if self._cancel_event.is_set():
                            out_path.unlink(missing_ok=True)
                            job.stage = "cancelled"
                            job.progress = 0.0
                            job.status_message = "Abgebrochen"
                            self._emit_update(job)
                            cancelled_run = True
                            return
                        if ret2 != 0 or not out_path.exists():
                            raise RuntimeError((stderr2 or "").strip() or f"ffmpeg FLAC Exit-Code {ret2}")
            else:
                cmd: list[str] = [
                    "ffmpeg",
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-threads",
                    str(eff_threads),
                    "-filter_threads",
                    str(eff_threads),
                    "-progress",
                    "pipe:1",
                    "-i",
                    str(job.source_path),
                ]
                if options.normalize_audio:
                    cmd.extend(["-af", f"loudnorm=I={options.target_lufs:.1f}:TP=-1.0:LRA=11"])
                if options.preserve_tags:
                    cmd.extend(["-map_metadata", "0"])
                else:
                    cmd.extend(["-map_metadata", "-1"])

                id3_ver = "3" if options.id3v2_version == 3 else "4"
                if fmt == "mp3":
                    cmd.extend(["-map", "0:a:0"])
                    if options.preserve_tags:
                        cmd.extend(["-map", "0:v?", "-c:v", "copy"])
                    else:
                        cmd.append("-vn")
                    cmd.extend(["-c:a", "libmp3lame"])
                    if options.mp3_quality == "cbr_320":
                        cmd.extend(["-b:a", "320k"])
                    elif options.mp3_quality == "cbr_256":
                        cmd.extend(["-b:a", "256k"])
                    elif options.mp3_quality == "cbr_192":
                        cmd.extend(["-b:a", "192k"])
                    elif options.mp3_quality == "vbr_v2":
                        cmd.extend(["-q:a", "2"])
                    else:
                        cmd.extend(["-q:a", "0"])
                    cmd.extend(["-id3v2_version", id3_ver])
                elif fmt == "wav":
                    cmd.extend(["-map", "0:a:0", "-vn", "-c:a", "pcm_s24le" if options.pcm_bits == 24 else "pcm_s16le"])
                    if options.preserve_tags:
                        cmd.extend(["-write_id3v2", "1", "-id3v2_version", id3_ver])
                elif fmt == "aiff":
                    cmd.extend(["-map", "0:a:0", "-vn", "-c:a", "pcm_s24be" if options.pcm_bits == 24 else "pcm_s16be"])
                    if options.preserve_tags:
                        cmd.extend(["-write_id3v2", "1", "-id3v2_version", id3_ver])
                elif fmt == "opus":
                    cmd.extend(["-map", "0:a:0", "-vn", "-c:a", "libopus", "-b:a", f"{options.bitrate_kbps}k"])
                elif fmt == "ogg":
                    cmd.extend(["-map", "0:a:0", "-vn", "-c:a", "libvorbis", "-b:a", f"{options.bitrate_kbps}k"])
                elif fmt == "m4a":
                    cmd.extend(["-map", "0:a:0", "-vn", "-c:a", "aac", "-b:a", f"{options.bitrate_kbps}k", "-movflags", "+faststart"])

                cmd.extend(["-threads", str(eff_threads), str(out_path)])

                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    bufsize=1,
                )
                with self._proc_lock:
                    self._running_procs.add(proc)

                total_us = max(1_000_000, int(max(1, job.duration_seconds) * 1_000_000))
                if proc.stdout is not None:
                    for line in proc.stdout:
                        if self._cancel_event.is_set():
                            proc.terminate()
                            break
                        if line.startswith("out_time_us="):
                            try:
                                cur_us = int(line.split("=", 1)[1].strip())
                                frac = max(0.05, min(0.96, cur_us / total_us))
                                job.progress = frac
                                job.status_message = f"Konvertiere ({int(frac * 100)}%)..."
                                self._emit_update(job)
                            except ValueError:
                                pass

                stderr_out = proc.stderr.read() if proc.stderr is not None else ""
                ret = proc.wait()
                with self._proc_lock:
                    self._running_procs.discard(proc)

                if self._cancel_event.is_set():
                    out_path.unlink(missing_ok=True)
                    job.stage = "cancelled"
                    job.progress = 0.0
                    job.status_message = "Abgebrochen"
                    self._emit_update(job)
                    cancelled_run = True
                    return

                if ret != 0 or not out_path.exists():
                    raise RuntimeError((stderr_out or "").strip() or f"ffmpeg Exit-Code {ret}")

            job.output_path = out_path
            job.stage = "done"
            job.progress = 1.0
            job.status_message = f"Fertig → {out_path.name}"
            self._emit_update(job)
            self._emit_log(f"[Konverter] Abgeschlossen: {job.relative_path} → {out_path}")
        except Exception as exc:
            job.stage = "error"
            job.progress = 0.0
            job.status_message = f"Fehler: {exc}"
            self._emit_update(job)
            self._emit_log(f"[Konverter] Fehler bei „{job.relative_path}“: {exc}")
        finally:
            finished_now = False
            with self._count_lock:
                self._active_futures_count = max(0, self._active_futures_count - 1)
                if self._active_futures_count == 0:
                    finished_now = True
            if finished_now and self.on_all_finished:
                self.on_all_finished(self._cancel_event.is_set() or cancelled_run)
