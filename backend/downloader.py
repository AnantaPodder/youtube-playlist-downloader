"""Download jobs: build the yt-dlp command, run it, and turn its output into progress state."""

import json
import os
import queue
import re
import signal
import subprocess
import threading
import time
import uuid
from collections import deque
from pathlib import Path

from . import system

# The three variants from the setup notes.
PRESETS = {
    # 1080p or higher, falling back to the best available.
    "best": ["-f", "bv*[height>=1080]+ba/bv*+ba/b"],
    # Only 1080p or higher; videos without it are skipped (-i keeps the playlist going).
    "strict": ["-f", "bv*[height>=1080]+ba", "-i"],
    # Best quality up to 1080p.
    "cap": ["-S", "res:1080"],
}

PLAYLIST_OUTPUT = "%(playlist_title)s/%(playlist_index)03d - %(title)s.%(ext)s"
SINGLE_OUTPUT = "%(title)s.%(ext)s"

# Machine-readable markers we ask yt-dlp to print next to its normal log.
PROGRESS_TEMPLATE = ("download:@@P|%(info.playlist_index)s|%(info.id)s|%(info.vcodec)s|%(progress.status)s|"
                     "%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|"
                     "%(progress.speed)s|%(progress.eta)s")
START_TEMPLATE = "before_dl:@@START|%(playlist_index)s|%(id)s|%(title)s"
DONE_TEMPLATE = "after_move:@@DONE|%(playlist_index)s|%(id)s|%(filepath)s"

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
ERROR_LINE = re.compile(r"^ERROR: (?:\[[^\]]+\] )?(?:([\w-]{6,}): )?(.*)$")
UNAVAILABLE_TITLE = re.compile(r"^\[(private|deleted|unavailable) video\]$", re.I)


class InspectError(Exception):
    pass


def _num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _thumbnail(entry):
    if entry.get("ie_key") == "Youtube" or "youtube.com" in (entry.get("url") or ""):
        if entry.get("id"):
            return f"https://i.ytimg.com/vi/{entry['id']}/mqdefault.jpg"
    if entry.get("thumbnail"):
        return entry["thumbnail"]
    thumbs = entry.get("thumbnails") or []
    return thumbs[-1]["url"] if thumbs and thumbs[-1].get("url") else None


def _entry(index, e):
    title = e.get("title") or e.get("id") or f"Item {index}"
    return {
        "index": index,
        "id": e.get("id"),
        "title": title,
        "duration": e.get("duration"),
        "thumbnail": _thumbnail(e),
        "available": not UNAVAILABLE_TITLE.match(title),
    }


def inspect(url):
    """List a playlist (or single video) without downloading anything."""
    ytdlp = system.which("yt-dlp")
    if not ytdlp:
        raise InspectError("yt-dlp is not installed.")
    try:
        proc = subprocess.run([ytdlp, "--flat-playlist", "-J", "--no-warnings", "--", url],
                              capture_output=True, text=True, timeout=300, env=system.tool_env())
    except subprocess.TimeoutExpired:
        raise InspectError("yt-dlp took too long to read this link.")
    if proc.returncode != 0 or not proc.stdout.strip():
        errors = [l for l in proc.stderr.splitlines() if l.startswith("ERROR")]
        raise InspectError(ANSI.sub("", errors[-1] if errors else proc.stderr.strip() or "yt-dlp could not read this link."))
    data = json.loads(proc.stdout)

    if data.get("_type") == "playlist":
        entries = [_entry(i, e) for i, e in enumerate(data.get("entries") or [], 1) if e]
        return {
            "url": url,
            "isPlaylist": True,
            "title": data.get("title") or "Playlist",
            "uploader": data.get("uploader") or data.get("channel"),
            "entries": entries,
        }
    entry = _entry(1, data)
    return {"url": url, "isPlaylist": False, "title": entry["title"],
            "uploader": data.get("uploader") or data.get("channel"), "entries": [entry]}


def _ranges(indices):
    """[1, 2, 3, 7, 9, 10] -> '1-3,7,9-10' for --playlist-items."""
    out, nums = [], sorted(set(indices))
    i = 0
    while i < len(nums):
        j = i
        while j + 1 < len(nums) and nums[j + 1] == nums[j] + 1:
            j += 1
        out.append(str(nums[i]) if i == j else f"{nums[i]}-{nums[j]}")
        i = j + 1
    return ",".join(out)


class Job:
    def __init__(self, store, url, preset, outdir, selected=None, info=None):
        self.store = store
        self.id = uuid.uuid4().hex[:10]
        self.url = url
        self.preset = preset
        self.outdir = str(Path(outdir).expanduser())
        self.selected = selected  # playlist indices, or None for everything
        self.info = info
        self.status = "queued"   # queued | preparing | running | done | partial | failed | cancelled
        self.message = None
        self.notice = None
        self.created = time.time()
        self.started = self.finished = None
        self.items = []
        self.current = None      # the item being downloaded
        self.bytes_done = 0
        self.folder = None
        self.command = None
        self.log = deque(maxlen=600)
        self.proc = None
        self.cancel_requested = False

    # ----- state helpers (call with store.lock held) -----

    def _load_items(self):
        entries = self.info["entries"]
        if self.selected:
            wanted = set(self.selected)
            entries = [e for e in entries if e["index"] in wanted]
        self.items = [dict(e, status="pending", percent=0, progress=0, stream=None, speed=None, eta=None,
                           error=None, file=None) for e in entries]

    def _find_item(self, idx, vid):
        idx = int(idx) if idx and idx.isdigit() else None
        for item in self.items:
            if item["id"] == vid and (idx is None or item["index"] == idx):
                return item
        for item in self.items:
            if vid and item["id"] == vid:
                return item
        if not self.info["isPlaylist"] and self.items:
            return self.items[0]
        # Something we did not see while listing (e.g. a channel URL with nested tabs).
        item = {"index": idx or len(self.items) + 1, "id": vid, "title": vid or "Unknown", "duration": None,
                "thumbnail": None, "available": True, "status": "pending", "percent": 0, "progress": 0, "stream": None,
                "speed": None, "eta": None, "error": None, "file": None}
        self.items.append(item)
        return item

    def snapshot(self, with_log=False):
        counts = {s: 0 for s in ("pending", "downloading", "done", "skipped", "failed")}
        for item in self.items:
            key = "downloading" if item["status"] in ("downloading", "merging") else item["status"]
            counts[key] = counts.get(key, 0) + 1
        finished = counts["done"] + counts["skipped"] + counts["failed"]
        partial = sum(i["progress"] for i in self.items if i["status"] in ("downloading", "merging")) / 100
        total = len(self.items)
        data = {
            "id": self.id, "url": self.url, "preset": self.preset, "outdir": self.outdir,
            "folder": self.folder or self.outdir,
            "status": self.status, "message": self.message, "notice": self.notice,
            "title": self.info["title"] if self.info else None,
            "uploader": self.info.get("uploader") if self.info else None,
            "isPlaylist": self.info["isPlaylist"] if self.info else None,
            "created": self.created, "started": self.started, "finished": self.finished,
            "counts": counts, "total": total,
            "progress": (finished + partial) / total if total else 0,
            "bytesDone": self.bytes_done + (self.current or {}).get("_bytes", 0),
            "current": {k: v for k, v in self.current.items() if not k.startswith("_")} if self.current else None,
            "items": [{k: v for k, v in i.items() if not k.startswith("_")} for i in self.items],
            "command": self.command,
        }
        if with_log:
            data["log"] = list(self.log)
        return data

    # ----- running -----

    def build_command(self, ytdlp):
        cmd = [ytdlp, *PRESETS[self.preset], "--merge-output-format", "mp4",
               "-P", self.outdir,
               "-o", PLAYLIST_OUTPUT if self.info["isPlaylist"] else SINGLE_OUTPUT,
               "--newline", "--no-quiet", "--progress", "--progress-delta", "0.5",
               "--progress-template", PROGRESS_TEMPLATE,
               "--print", START_TEMPLATE, "--print", DONE_TEMPLATE]
        if self.info["isPlaylist"] and self.selected:
            cmd += ["--playlist-items", _ranges(self.selected)]
        return cmd + ["--", self.url]

    def run(self):
        lock = self.store.lock
        ytdlp = system.which("yt-dlp")
        with lock:
            if self.cancel_requested:
                return
            self.started = time.time()
            if not ytdlp:
                self._finish("failed", "yt-dlp is not installed.")
            elif not self.info:
                self.status = "preparing"
        self.store.changed()
        if self.status == "failed":
            return

        if not self.info:
            try:
                info = inspect(self.url)
            except (InspectError, ValueError) as exc:
                with lock:
                    self._finish("failed", str(exc))
                return self.store.changed()
            with lock:
                self.info = info

        with lock:
            if self.cancel_requested:
                self._finish("cancelled", None)
                return self.store.changed()
            self._load_items()
            try:
                Path(self.outdir).mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                self._finish("failed", f"Can't create {self.outdir}: {exc.strerror or exc}")
                return self.store.changed()
            cmd = self.build_command(ytdlp)
            # A copy-pasteable version for the log, in the same shape as the setup notes.
            self.command = " ".join(["yt-dlp"] + [_quote(a) for a in cmd[1:]])
            self.log.append("$ " + self.command)
            self.status = "running"
            self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                         encoding="utf-8", errors="replace", bufsize=1,
                                         env=system.tool_env(), start_new_session=True)
        self.store.changed()

        for raw in self.proc.stdout:
            line = ANSI.sub("", raw.rstrip("\r\n"))
            if not line:
                continue
            with lock:
                self._handle(line)
            self.store.changed()

        code = self.proc.wait()
        with lock:
            self._settle(code)
        self.store.changed()

    def _handle(self, line):
        if line.startswith("@@P|"):
            return self._on_progress(line.split("|"))
        if line.startswith("@@START|"):
            _, idx, vid, title = line.split("|", 3)
            item = self._find_item(idx, vid)
            item.update(status="downloading", percent=0, progress=0, title=title or item["title"], _already=False)
            self.current = item
            self.log.append(f"[app] Starting #{item['index']}: {item['title']}")
            return
        if line.startswith("@@DONE|"):
            _, idx, vid, path = line.split("|", 3)
            item = self._find_item(idx, vid)
            item.update(status="skipped" if item.get("_already") else "done", percent=100, progress=100, file=path,
                        speed=None, eta=None, stream=None)
            if item["status"] == "skipped":
                item["error"] = "Already downloaded"
            if path and path != "NA":
                self.folder = str(Path(path).parent)
            if self.current is item:
                self.bytes_done += item.pop("_bytes", 0) or 0
                self.current = None
            return

        self.log.append(line)
        if line.startswith("[Merger]") and self.current:
            self.current.update(status="merging", progress=99, stream=None, speed=None, eta=None, _already=False)
        elif line.startswith("[download]") and "has already been downloaded" in line and self.current:
            self.current["_already"] = True
        elif "No supported JavaScript runtime" in line:
            self.notice = "Deno was not found, so some YouTube formats (often 1080p) may be missing."
        elif line.startswith("ERROR:"):
            m = ERROR_LINE.match(line)
            vid, msg = (m.group(1), m.group(2)) if m else (None, line)
            item = None
            if vid:
                item = next((i for i in self.items if i["id"] == vid), None)
            item = item or (self.current if self.current and self.current["status"] != "done" else None)
            if item:
                skipped = "Requested format is not available" in msg
                item.update(status="skipped" if skipped else "failed", speed=None, eta=None, stream=None,
                            error="No 1080p+ version" if skipped and self.preset == "strict" else msg)
                if self.current is item:
                    self.current = None
            else:
                self.message = msg

    def _on_progress(self, parts):
        if len(parts) < 10:
            return
        _, idx, vid, vcodec, status, done, total, estimate, speed, eta = parts[:10]
        item = self._find_item(idx, vid)
        if item["status"] not in ("downloading", "merging"):
            item["status"] = "downloading"
        self.current = item
        done_b, total_b = _num(done) or 0, _num(total) or _num(estimate)
        stream = "audio" if vcodec == "none" else "video"
        if status == "finished":
            # A stream is complete; video and audio are fetched separately then merged.
            self.bytes_done += total_b or done_b
            item["_bytes"] = 0
        else:
            item["_bytes"] = done_b
            item["_already"] = False  # only a leftover stream was "already downloaded"
        percent = 100.0 if status == "finished" else (min(99.9, done_b / total_b * 100) if total_b else item["percent"])
        # Video comes first and is most of the bytes; weighting keeps the bar from jumping back for audio.
        progress = percent * 0.9 if stream == "video" else 90 + percent * 0.1
        item.update(stream=stream, speed=_num(speed), eta=_num(eta), percent=percent,
                    progress=max(item["progress"], progress))

    def _settle(self, code):
        if self.cancel_requested:
            for item in self.items:
                if item["status"] in ("downloading", "merging"):
                    item.update(status="pending", speed=None, eta=None, stream=None)
            return self._finish("cancelled", "Cancelled. Partial files are kept, so a retry resumes them.")
        for item in self.items:
            if item["status"] in ("downloading", "merging"):
                item.update(status="failed", error=item["error"] or "Stopped unexpectedly")
            elif item["status"] == "pending":
                item.update(status="failed" if code else "skipped",
                            error=item["error"] or ("Not downloaded" if code else "Skipped by yt-dlp"))
        ok = sum(1 for i in self.items if i["status"] in ("done", "skipped"))
        failed = sum(1 for i in self.items if i["status"] == "failed")
        if self.items and failed == 0:
            self._finish("done", None)
        elif ok:
            self._finish("partial", f"{failed} of {len(self.items)} videos failed.")
        else:
            self._finish("failed", self.message or f"yt-dlp exited with code {code}.")

    def _finish(self, status, message):
        self.status = status
        self.message = message
        self.finished = time.time()
        self.current = None
        self.proc = None

    def cancel(self):
        with self.store.lock:
            self.cancel_requested = True
            proc = self.proc
            if self.status == "queued":
                self._finish("cancelled", None)
        if proc and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)   # also stops ffmpeg children
            except ProcessLookupError:
                pass
            threading.Timer(8, _force_kill, args=(proc,)).start()
        self.store.changed()


def _force_kill(proc):
    if proc.poll() is None:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def _quote(arg):
    return arg if re.fullmatch(r"[\w@%+=:,./-]+", arg) else '"' + arg.replace('"', '\\"') + '"'


class Store:
    """All jobs plus a revision counter that long-polling clients wait on."""

    def __init__(self):
        self.lock = threading.RLock()
        self.cond = threading.Condition(self.lock)
        self.rev = 0
        self.jobs = {}
        self.inspected = {}   # url -> inspect() result, reused when the job starts
        self.queue = queue.Queue()
        threading.Thread(target=self._worker, daemon=True).start()

    def changed(self):
        with self.cond:
            self.rev += 1
            self.cond.notify_all()

    def wait(self, rev, timeout):
        with self.cond:
            self.cond.wait_for(lambda: self.rev != rev, timeout)
            return self.rev

    def inspect(self, url):
        info = inspect(url)
        with self.lock:
            self.inspected[url] = info
        return info

    def add(self, url, preset, outdir, selected):
        with self.lock:
            job = Job(self, url, preset, outdir, selected, self.inspected.get(url))
            self.jobs[job.id] = job
        self.queue.put(job)
        self.changed()
        return job

    def retry(self, job_id):
        old = self.jobs[job_id]
        return self.add(old.url, old.preset, old.outdir, old.selected)

    def remove(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            if job and job.status not in ("queued", "preparing", "running"):
                del self.jobs[job_id]
        self.changed()

    def snapshot(self, with_logs=()):
        with self.lock:
            return {"rev": self.rev,
                    "jobs": [j.snapshot(j.id in with_logs) for j in reversed(list(self.jobs.values()))]}

    def _worker(self):
        # One job at a time: YouTube throttles parallel playlist downloads anyway.
        while True:
            job = self.queue.get()
            if job.status == "cancelled":
                continue
            try:
                job.run()
            except Exception as exc:  # keep the queue alive no matter what
                with self.lock:
                    job.log.append(f"[app] Internal error: {exc!r}")
                    job._finish("failed", f"Internal error: {exc}")
                self.changed()
