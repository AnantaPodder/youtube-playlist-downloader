#!/usr/bin/env python3
"""YouTube Playlist Downloader: a local web UI for yt-dlp.

    python3 app.py               start (or focus) the app and open its window
    python3 app.py --no-window   just run the server
    python3 app.py --stop        stop a running instance
"""

import argparse
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import webbrowser

from backend.server import serve


def already_running(url):
    try:
        with urllib.request.urlopen(url + "/api/health", timeout=1) as resp:
            return resp.status == 200
    except OSError:
        return False


def stop(url):
    req = urllib.request.Request(url + "/api/quit", data=b"{}", headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=5)
        print("Stopped.")
    except urllib.error.HTTPError as exc:
        print(f"Couldn't stop it (HTTP {exc.code}). Is something else using {url}?")
    except OSError:
        print("Not running.")


def open_window(url):
    # A Chromium "app" window has no tabs or address bar, so it feels like a desktop app.
    for browser in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser"):
        if shutil.which(browser):
            subprocess.Popen([browser, f"--app={url}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                             start_new_session=True)
            return
    webbrowser.open(url)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-window", action="store_true", help="don't open a browser window")
    parser.add_argument("--stop", action="store_true", help="stop a running instance")
    args = parser.parse_args()
    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '') else args.host}:{args.port}"

    if args.stop:
        return stop(url)

    if already_running(url):
        print(f"Already running at {url}")
        if not args.no_window:
            open_window(url)
        return

    try:
        httpd = serve(args.host, args.port)
    except OSError as exc:
        sys.exit(f"Can't listen on {args.host}:{args.port}: {exc.strerror}. Try --port 8766")

    print(f"Playlist Downloader running at {url}  (Ctrl+C to stop)")
    if not args.no_window:
        open_window(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        # yt-dlp runs in its own session, so stop it explicitly instead of orphaning it.
        for job in list(httpd.RequestHandlerClass.store.jobs.values()):
            if job.status in ("preparing", "running"):
                job.cancel()
        print("\nStopped.")


if __name__ == "__main__":
    main()
