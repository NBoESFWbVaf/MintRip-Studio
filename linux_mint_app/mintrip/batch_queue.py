"""Stapelverarbeitung (Batch-Queue) für serielles CD-Ripping & paralleles Encoding."""

from __future__ import annotations

import os
import subprocess
import tempfile
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
import shutil
from typing import Callable

from gi.repository import GLib

from .cd_reader import rip_track_with_cdparanoia
from .encoder import (
    apply_gain_to_wav,
    build_cover_target_path,
    build_target_stem,
    calculate_album_gain_db,
    decode_to_clean_wav,
    encode_to_flac,
    encode_to_mp3,
    ensure_jpeg_cover,
    measure_album_loudness,
    write_tags_to_existing_file,
)
from .models import BatchJob, BatchStage, ExportFormat


class BatchQueueManager:
    """Verwaltet die Stapelverarbeitung mehrerer Tracks und gedroppter Audiodateien."""

    def __init__(self, on_job_update: Callable[[BatchJob], None], max_workers: int = 4) -> None:
        self.jobs: list[BatchJob] = []
        self._submitted_ids: set[str] = set()
        self._on_job_update = on_job_update
        self._drive_lock = threading.Lock()
        self._pause_event = threading.Event()
        self._pause_event.set()
        self._cancel_flag = threading.Event()
        self._max_workers = max(1, min(16, int(max_workers or 4)))
        self._encode_pool_size = self._max_workers
        self._encode_pool = ThreadPoolExecutor(
            max_workers=self._encode_pool_size, thread_name_prefix="mintrip-enc"
        )
        self._rip_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mintrip-rip")

    def set_max_workers(self, max_workers: int) -> None:
        target = max(1, min(16, int(max_workers or 4)))
        self._max_workers = target
        if not self.has_active_jobs() and self._encode_pool_size != target:
            old_pool = self._encode_pool
            self._encode_pool_size = target
            self._encode_pool = ThreadPoolExecutor(
                max_workers=self._encode_pool_size, thread_name_prefix="mintrip-enc"
            )
            try:
                old_pool.shutdown(wait=False)
            except Exception:
                pass

    def enqueue(self, job: BatchJob) -> None:
        self.jobs.append(job)
        self._notify(job)

    def start_all(self, include_retry: bool = False) -> None:
        self._cancel_flag.clear()
        self._pause_event.set()
        if not self.has_active_jobs() and self._encode_pool_size != self._max_workers:
            old_pool = self._encode_pool
            self._encode_pool_size = self._max_workers
            self._encode_pool = ThreadPoolExecutor(
                max_workers=self._encode_pool_size, thread_name_prefix="mintrip-enc"
            )
            try:
                old_pool.shutdown(wait=False)
            except Exception:
                pass
        eligible_stages = (
            (BatchStage.QUEUED, BatchStage.ERROR, BatchStage.CANCELLED)
            if include_retry
            else (BatchStage.QUEUED,)
        )
        pending_jobs: list[BatchJob] = []
        for job in self.jobs:
            if job.job_id in self._submitted_ids:
                continue
            if job.stage in eligible_stages:
                job.stage = BatchStage.QUEUED
                job.progress = 0.0
                job.error_message = ""
                job.status_message = "In Warteschlange"
                self._submitted_ids.add(job.job_id)
                self._notify(job)
                pending_jobs.append(job)

        if not pending_jobs:
            return

        # Jobs mit aktivierter Album-Normalisierung pro Album bündeln (nur für echte Rip-/Kodier-Aufträge, nicht für reines Tag-Schreiben)
        norm_groups: dict[tuple[str, int], list[BatchJob]] = {}
        stream_jobs: list[BatchJob] = []
        for job in pending_jobs:
            if job.tag_only:
                stream_jobs.append(job)
            elif job.settings.normalize_album:
                album_key = (
                    job.album.musicbrainz_release_id or f"{job.album.album_artist}::{job.album.title}",
                    int(job.album.disc_number or 1),
                )
                norm_groups.setdefault(album_key, []).append(job)
            else:
                stream_jobs.append(job)

        for group_jobs in norm_groups.values():
            self._rip_pool.submit(self._process_normalized_album_batch, group_jobs)
        for job in stream_jobs:
            self._rip_pool.submit(self._process_job, job)

    @property
    def is_paused(self) -> bool:
        return not self._pause_event.is_set()

    def has_active_jobs(self) -> bool:
        return any(
            j.stage
            in (
                BatchStage.QUEUED,
                BatchStage.RIPPING,
                BatchStage.ENCODING_FLAC,
                BatchStage.ENCODING_MP3,
                BatchStage.TAGGING,
            )
            for j in self.jobs
        )

    def toggle_pause(self) -> bool:
        if self._pause_event.is_set():
            self._pause_event.clear()
            return True
        self._pause_event.set()
        return False

    def cancel_all(self) -> None:
        self._cancel_flag.set()
        self._pause_event.set()
        for job in self.jobs:
            if job.stage not in (BatchStage.DONE, BatchStage.ERROR):
                job.stage = BatchStage.CANCELLED
                job.status_message = "Abgebrochen"
                self._submitted_ids.discard(job.job_id)
                self._notify(job)

    def clear_finished(self) -> None:
        self.jobs = [j for j in self.jobs if j.stage not in (BatchStage.DONE, BatchStage.CANCELLED)]

    def clear_all(self) -> None:
        self._cancel_flag.set()
        self._pause_event.set()
        self.jobs.clear()
        self._submitted_ids.clear()

    def _notify(self, job: BatchJob) -> None:
        GLib.idle_add(self._on_job_update, job)

    def _wait_if_paused(self) -> None:
        self._pause_event.wait()
        if self._cancel_flag.is_set():
            raise InterruptedError("Stapelverarbeitung abgebrochen")

    def _prepare_wav_for_job(self, job: BatchJob, target_wav: Path, progress_scale: float = 0.55) -> Path:
        if job.track.source_file and job.track.source_file.exists():
            job.stage = BatchStage.RIPPING
            job.status_message = f"Schritt 1/2: Quelle nach WAV umwandeln ({job.track.source_file.name})..."
            job.progress = 0.25
            self._notify(job)
            decode_to_clean_wav(job.track.source_file, target_wav, ffmpeg_threads=1)
            job.progress = progress_scale
            self._notify(job)
            return target_wav

        with self._drive_lock:
            self._wait_if_paused()
            job.stage = BatchStage.RIPPING
            job.status_message = "cdparanoia liest Sektoren..."
            self._notify(job)

            def on_rip_progress(ratio: float, detail: str) -> None:
                job.progress = ratio * progress_scale
                job.status_message = f"Rippen ({detail})"
                self._notify(job)

            rip_track_with_cdparanoia(
                device_path=job.device_path,
                track=job.track,
                output_wav=target_wav,
                paranoia_mode=job.settings.paranoia_mode,
                progress_cb=on_rip_progress,
                cancel_check=self._cancel_flag.is_set,
            )
        return target_wav

    def _process_job(self, job: BatchJob) -> None:
        try:
            self._wait_if_paused()
            if job.tag_only and job.track.source_file and job.track.source_file.exists():
                future = self._encode_pool.submit(self._tag_only_stage, job)
                future.result()
                return

            with tempfile.TemporaryDirectory(prefix="mintrip_") as tmpdir:
                tmp_wav = Path(tmpdir) / f"track_{job.track.track_number:03d}.wav"
                self._prepare_wav_for_job(job, tmp_wav, progress_scale=0.55)
                future = self._encode_pool.submit(self._encode_stage, job, tmp_wav)
                future.result()

        except InterruptedError:
            job.stage = BatchStage.CANCELLED
            job.status_message = "Abgebrochen"
            self._submitted_ids.discard(job.job_id)
            self._notify(job)
        except Exception as exc:
            job.stage = BatchStage.ERROR
            job.error_message = str(exc)
            job.status_message = f"Fehler: {exc}"
            self._submitted_ids.discard(job.job_id)
            self._notify(job)

    def _process_normalized_album_batch(self, group_jobs: list[BatchJob]) -> None:
        """Rippt erst alle Titel des Albums, misst gemeinsame EBU-R128-Lautheit und normalisiert einheitlich."""
        try:
            self._wait_if_paused()
            with tempfile.TemporaryDirectory(prefix="mintrip_album_norm_") as tmpdir:
                tmp_root = Path(tmpdir)
                prepared: list[tuple[BatchJob, Path]] = []

                for idx, job in enumerate(group_jobs):
                    try:
                        self._wait_if_paused()
                        raw_wav = tmp_root / f"raw_{idx:03d}.wav"
                        self._prepare_wav_for_job(job, raw_wav, progress_scale=0.45)
                        job.progress = 0.50
                        job.status_message = "Warte auf Album-Lautheitsanalyse..."
                        self._notify(job)
                        prepared.append((job, raw_wav))
                    except InterruptedError:
                        job.stage = BatchStage.CANCELLED
                        job.status_message = "Abgebrochen"
                        self._submitted_ids.discard(job.job_id)
                        self._notify(job)
                    except Exception as exc:
                        job.stage = BatchStage.ERROR
                        job.error_message = str(exc)
                        job.status_message = f"Fehler: {exc}"
                        self._submitted_ids.discard(job.job_id)
                        self._notify(job)

                if not prepared:
                    return

                ref_settings = prepared[0][0].settings
                target_lufs = ref_settings.normalize_target_lufs
                for job, _wav in prepared:
                    job.progress = 0.56
                    job.status_message = f"Analysiere Album-Lautheit (Ziel: {target_lufs:.1f} LUFS)..."
                    self._notify(job)

                metrics = measure_album_loudness(
                    [wav for _, wav in prepared],
                    true_peak=ref_settings.normalize_true_peak,
                    use_loudest_track=ref_settings.normalize_use_loudest_track,
                    ffmpeg_threads=max(1, self._max_workers),
                )
                measured_lufs = float(metrics["album_lufs"])
                measured_peak = float(metrics["album_peak_dbfs"])
                track_stats: list[tuple[float, float]] = metrics["tracks"]
                gain_db = calculate_album_gain_db(measured_lufs, measured_peak, target_lufs=target_lufs)

                post_album_lufs = measured_lufs + gain_db
                post_album_peak_lin = min(1.0, 10.0 ** ((measured_peak + gain_db) / 20.0))
                album_rg_gain = target_lufs - post_album_lufs

                futures: list[Future] = []
                for idx, (job, raw_wav) in enumerate(prepared):
                    trk_lufs, trk_peak_dbfs = track_stats[idx]
                    post_trk_lufs = trk_lufs + gain_db
                    post_trk_peak_lin = min(1.0, 10.0 ** ((trk_peak_dbfs + gain_db) / 20.0))
                    trk_rg_gain = target_lufs - post_trk_lufs

                    if job.settings.normalize_compute_album_gain:
                        job.track.extra_tags["REPLAYGAIN_ALBUM_GAIN"] = [f"{album_rg_gain:+.2f} dB"]
                        job.track.extra_tags["REPLAYGAIN_ALBUM_PEAK"] = [f"{post_album_peak_lin:.6f}"]
                        job.track.extra_tags["REPLAYGAIN_TRACK_GAIN"] = [f"{trk_rg_gain:+.2f} dB"]
                        job.track.extra_tags["REPLAYGAIN_TRACK_PEAK"] = [f"{post_trk_peak_lin:.6f}"]
                    if job.settings.normalize_write_ref_loudness_tag:
                        job.track.extra_tags["REPLAYGAIN_REFERENCE_LOUDNESS"] = [f"{target_lufs:.2f} LUFS"]

                    norm_wav = tmp_root / f"norm_{idx:03d}.wav"
                    fut = self._encode_pool.submit(
                        self._normalize_and_encode_worker,
                        job,
                        raw_wav,
                        norm_wav,
                        gain_db,
                        measured_lufs,
                    )
                    futures.append(fut)

                for fut in futures:
                    fut.result()
        except InterruptedError:
            for job in group_jobs:
                if job.stage not in (BatchStage.DONE, BatchStage.ERROR):
                    job.stage = BatchStage.CANCELLED
                    job.status_message = "Abgebrochen"
                    self._submitted_ids.discard(job.job_id)
                    self._notify(job)
        except Exception as exc:
            for job in group_jobs:
                if job.stage not in (BatchStage.DONE, BatchStage.CANCELLED):
                    job.stage = BatchStage.ERROR
                    job.error_message = str(exc)
                    job.status_message = f"Normalisierungsfehler: {exc}"
                    self._submitted_ids.discard(job.job_id)
                    self._notify(job)

    def _normalize_and_encode_worker(
        self,
        job: BatchJob,
        raw_wav: Path,
        norm_wav: Path,
        gain_db: float,
        measured_lufs: float,
    ) -> None:
        try:
            self._wait_if_paused()
            job.progress = 0.64
            job.status_message = f"Normalisiere ({measured_lufs:.1f} LUFS, {gain_db:+.1f} dB)..."
            self._notify(job)
            final_wav = apply_gain_to_wav(raw_wav, norm_wav, gain_db, ffmpeg_threads=1)
            self._encode_stage(job, final_wav)
        except InterruptedError:
            job.stage = BatchStage.CANCELLED
            job.status_message = "Abgebrochen"
            self._submitted_ids.discard(job.job_id)
            self._notify(job)
        except Exception as exc:
            job.stage = BatchStage.ERROR
            job.error_message = str(exc)
            job.status_message = f"Fehler: {exc}"
            self._submitted_ids.discard(job.job_id)
            self._notify(job)

    def _tag_only_stage(self, job: BatchJob) -> None:
        self._wait_if_paused()
        if not job.track.source_file or not job.track.source_file.exists():
            raise FileNotFoundError("Importierte Quelldatei für Tag-Schreibvorgang nicht gefunden.")

        job.output_files.clear()
        job.stage = BatchStage.TAGGING
        job.progress = 0.65
        job.status_message = f"Picard-Tags & Cover in {job.track.source_file.name} schreiben..."
        self._notify(job)

        out_path = write_tags_to_existing_file(
            job.track.source_file,
            job.album,
            job.track,
            job.settings,
        )
        job.output_files.append(out_path)
        job.stage = BatchStage.DONE
        job.progress = 1.0
        job.status_message = f"Tags geschrieben ({out_path.name})"
        self._submitted_ids.discard(job.job_id)
        self._notify(job)

    def _encode_stage(self, job: BatchJob, wav_path: Path) -> None:
        self._wait_if_paused()
        stem = build_target_stem(job.album, job.track, job.settings)
        job.output_files.clear()

        if job.album.cover_art_bytes:
            jpg_bytes, jpg_w, jpg_h, orig_fmt, _ = ensure_jpeg_cover(
                job.album.cover_art_bytes, job.album.cover_art_mime
            )
            job.album.cover_art_bytes = jpg_bytes
            job.album.cover_art_mime = "image/jpeg"
            if jpg_w > 0 and jpg_h > 0:
                job.album.cover_art_width = jpg_w
                job.album.cover_art_height = jpg_h
            if not job.album.cover_art_original_format:
                job.album.cover_art_original_format = orig_fmt

        if job.settings.save_folder_cover and job.album.cover_art_bytes:
            cover_file = build_cover_target_path(stem.parent, job.album, job.settings)
            if not cover_file.exists():
                cover_file.write_bytes(job.album.cover_art_bytes)

        fmt = job.settings.export_format
        if fmt == ExportFormat.FLAC:
            job.stage = BatchStage.ENCODING_FLAC
            job.progress = 0.78
            job.status_message = (
                f"Schritt 2/2: WAV → FLAC (Stufe {job.settings.flac_compression_level}) & Tags..."
                if job.track.source_file is not None
                else f"FLAC-Kodierung (Stufe {job.settings.flac_compression_level}) & Vorbis-Tags..."
            )
            self._notify(job)
            target_flac = stem.with_suffix(".flac")
            same_as_src = False
            if job.track.source_file and job.track.source_file.exists():
                try:
                    same_as_src = target_flac.resolve() == job.track.source_file.resolve()
                except Exception:
                    same_as_src = False
            if same_as_src:
                tmp_out = target_flac.with_name(f".{target_flac.stem}.mintrip_tmp.flac")
                encode_to_flac(wav_path, tmp_out, job.album, job.track, job.settings, ffmpeg_threads=1)
                shutil.move(str(tmp_out), str(target_flac))
                out_flac = target_flac
            else:
                out_flac = encode_to_flac(wav_path, target_flac, job.album, job.track, job.settings, ffmpeg_threads=1)
            job.output_files.append(out_flac)
        else:
            self._wait_if_paused()
            job.stage = BatchStage.ENCODING_MP3
            id3_ver = 3 if job.settings.id3v2_version == 3 else 4
            job.progress = 0.78
            job.status_message = f"LAME MP3-Kodierung & ID3v2.{id3_ver}..."
            self._notify(job)
            out_mp3 = encode_to_mp3(wav_path, stem.with_suffix(".mp3"), job.album, job.track, job.settings)
            job.output_files.append(out_mp3)

        job.stage = BatchStage.DONE
        job.progress = 1.0
        job.status_message = "Erfolgreich exportiert"
        self._submitted_ids.discard(job.job_id)
        self._notify(job)

        # CD nur auswerfen, wenn dies der letzte aktive Auftrag war, die Option aktiv ist
        # UND es sich um einen physischen CD-Rip handelt (nicht bei importierten lokalen Audiodateien!)
        is_physical_cd_batch = job.track.source_file is None or any(
            j.track.source_file is None and j.stage == BatchStage.DONE for j in self.jobs
        )
        target_eject_device = job.device_path or next(
            (j.device_path for j in self.jobs if j.track.source_file is None and j.device_path),
            "",
        )
        if (
            job.settings.eject_after_rip
            and is_physical_cd_batch
            and bool(target_eject_device)
            and not any(
                j.stage
                in (
                    BatchStage.QUEUED,
                    BatchStage.RIPPING,
                    BatchStage.ENCODING_FLAC,
                    BatchStage.ENCODING_MP3,
                    BatchStage.TAGGING,
                )
                for j in self.jobs
            )
        ):
            try:
                subprocess.run(["eject", target_eject_device], check=False)
            except Exception:
                pass
