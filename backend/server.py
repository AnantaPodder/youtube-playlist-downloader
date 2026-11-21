"""Tiny local HTTP API + static file server. Standard library only."""

import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import system
from .downloader import PRESETS, InspectError, Store

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    "/favicon.svg": ("favicon.svg", "image/svg+xml"),
}
JOB_ACTION = re.compile(r"^/api/jobs/([0-9a-f]+)/(cancel|retry|remove)$")


class Handler(BaseHTTPRequestHandler):
    server_version = "PlaylistDownloader/1.0"
    store: Store = None
    httpd = None
    allowed_hosts = set()

    def log_message(self, fmt, *args):  # keep the terminal quiet; errors still surface in the UI
        pass

    # ----- plumbing -----

    def _send(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, data, code=200):
        self._send(code, json.dumps(data).encode())

    def _error(self, message, code=400):
        self._json({"error": message}, code)

    def _trusted(self):
        # Only answer requests addressed to us (blocks DNS rebinding) and, for writes,
        # only from our own page (blocks other websites poking the local API).
        if self.headers.get("Host") not in self.allowed_hosts:
            return False
        if self.command == "POST":
            origin = self.headers.get("Origin")
            if origin and urlparse(origin).netloc not in self.allowed_hosts:
                return False
            if not (self.headers.get("Content-Type") or "").startswith("application/json"):
                return False
        return True

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(min(length, 1_000_000)) or b"{}")

    # ----- routes -----

    def do_GET(self):
        if not self._trusted():
            return self._error("Forbidden", 403)
        url = urlparse(self.path)
        if url.path in STATIC:
            name, ctype = STATIC[url.path]
            try:
                return self._send(200, (WEB_DIR / name).read_bytes(), ctype)
            except FileNotFoundError:
                return self._error(f"Missing web/{name}. Run: npm run build:css", 500)
        if url.path == "/api/health":
            return self._json({"ok": True})
        if url.path == "/api/status":
            return self._json(system.status())
        if url.path == "/api/jobs":
            q = parse_qs(url.query)
            rev = q.get("rev", ["-1"])[0]
            rev = int(rev) if rev.lstrip("-").isdigit() else -1
            logs = set(filter(None, q.get("logs", [""])[0].split(",")))
            self.store.wait(rev, timeout=20)
            return self._json(self.store.snapshot(logs))
        self._error("Not found", 404)

    def do_POST(self):
        if not self._trusted():
            return self._error("Forbidden", 403)
        path = urlparse(self.path).path
        try:
            body = self._body()
        except (ValueError, json.JSONDecodeError):
            return self._error("Invalid JSON")

        if path == "/api/inspect":
            url = _clean_url(body.get("url"))
            if not url:
                return self._error("Paste a YouTube playlist or video link.")
            try:
                return self._json(self.store.inspect(url))
            except InspectError as exc:
                return self._error(str(exc), 422)

        if path == "/api/jobs":
            url = _clean_url(body.get("url"))
            preset = body.get("preset", "best")
            outdir = (body.get("outdir") or "").strip() or system.default_download_dir()
            selected = body.get("selected")
            if not url:
                return self._error("Paste a YouTube playlist or video link.")
            if preset not in PRESETS:
                return self._error("Unknown quality preset.")
            if selected is not None and not (isinstance(selected, list) and selected
                                             and all(isinstance(i, int) and i > 0 for i in selected)):
                return self._error("Select at least one video.")
            job = self.store.add(url, preset, outdir, selected)
            return self._json({"id": job.id})

        m = JOB_ACTION.match(path)
        if m:
            job_id, action = m.groups()
            if job_id not in self.store.jobs:
                return self._error("No such download.", 404)
            if action == "cancel":
                self.store.jobs[job_id].cancel()
            elif action == "retry":
                return self._json({"id": self.store.retry(job_id).id})
            else:
                self.store.remove(job_id)
            return self._json({"ok": True})

        if path == "/api/quit":
            for job in list(self.store.jobs.values()):
                if job.status in ("preparing", "running"):
                    job.cancel()
            self._json({"ok": True})
            return threading.Thread(target=self.httpd.shutdown, daemon=True).start()

        if path == "/api/clear":
            for job_id in list(self.store.jobs):
                self.store.remove(job_id)
            return self._json({"ok": True})

        if path == "/api/maintenance":
            action = body.get("action")
            if action not in ("install", "update"):
                return self._error("Unknown action.")
            return self._json(system.run_maintenance(action))

        if path == "/api/pick-folder":
            try:
                return self._json({"path": system.pick_folder(body.get("start"))})
            except RuntimeError as exc:
                return self._error(str(exc), 422)

        if path == "/api/open-folder":
            target = body.get("path")
            if not target:
                return self._error("No folder given.")
            return self._json({"opened": system.open_folder(target)})

        self._error("Not found", 404)


def _clean_url(value):
    url = (value or "").strip()
    # yt-dlp only gets real web links; never anything that could look like an option.
    return url if re.match(r"^https?://\S+$", url) else None


def serve(host, port):
    Handler.store = Store()
    Handler.allowed_hosts = {f"{h}:{port}" for h in ("127.0.0.1", "localhost", host)}
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    Handler.httpd = httpd
    return httpd
