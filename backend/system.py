"""Finds yt-dlp / ffmpeg / deno on this machine and runs install/update commands."""

import datetime as dt
import os
import re
import shutil
import subprocess
from pathlib import Path

HOME = Path.home()

# Tools installed by pipx, uv and the Deno installer live here. A desktop launcher
# often starts us without these on PATH, so always add them for child processes.
EXTRA_PATHS = [HOME / ".local" / "bin", HOME / ".deno" / "bin"]


def tool_env():
    env = os.environ.copy()
    parts = [p for p in env.get("PATH", "").split(os.pathsep) if p]
    for extra in reversed(EXTRA_PATHS):
        if str(extra) not in parts:
            parts.insert(0, str(extra))
    env["PATH"] = os.pathsep.join(parts)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"
    return env


def which(name):
    """Locate a tool. YTPD_YT_DLP=/path/to/yt-dlp style env vars override the lookup."""
    override = os.environ.get("YTPD_" + name.upper().replace("-", "_"))
    if override:
        return override if os.path.exists(override) else None
    return shutil.which(name, path=tool_env()["PATH"])


def _first_output(cmd):
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=15, env=tool_env())
    except (OSError, subprocess.TimeoutExpired):
        return None
    out = (proc.stdout or proc.stderr).strip()
    return out.splitlines()[0] if out else None


def _install_method(path):
    real = os.path.realpath(path)
    if "/pipx/venvs/" in real:
        return "pipx"
    if "/uv/tools/" in real:
        return "uv"
    if real.startswith("/usr/bin/") or real.startswith("/bin/"):
        return "apt"
    return "other"


def _ytdlp_info():
    path = which("yt-dlp")
    if not path:
        return {"found": False}
    version = _first_output([path, "--version"])
    info = {"found": bool(version), "path": path, "version": version, "via": _install_method(path)}
    # yt-dlp versions are release dates (2026.10.26); old builds stop working on YouTube.
    m = re.match(r"(\d{4})\.(\d{2})\.(\d{2})", version or "")
    if m:
        released = dt.date(*map(int, m.groups()))
        info["age_days"] = (dt.date.today() - released).days
    return info


def _simple_info(name, args, pattern):
    path = which(name)
    if not path:
        return {"found": False}
    line = _first_output([path, *args])
    m = re.search(pattern, line or "")
    return {"found": bool(line), "path": path, "version": m.group(1) if m else line}


def default_download_dir():
    try:
        videos = subprocess.run(["xdg-user-dir", "VIDEOS"], capture_output=True, text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        videos = ""
    base = Path(videos) if videos and Path(videos).is_dir() and Path(videos) != HOME else HOME / "Videos"
    return str(base / "YouTube")


def status():
    return {
        "ytdlp": _ytdlp_info(),
        "ffmpeg": _simple_info("ffmpeg", ["-version"], r"ffmpeg version (\S+)"),
        "deno": _simple_info("deno", ["--version"], r"deno (\S+)"),
        "pipx": _simple_info("pipx", ["--version"], r"(\S+)"),
        "uv": _simple_info("uv", ["--version"], r"uv (\S+)"),
        "defaultDir": default_download_dir(),
    }


def _ytdlp_command(action):
    """The command that installs or updates yt-dlp, or an explanation of why we can't."""
    have_pipx, have_uv = which("pipx"), which("uv")
    if action == "install":
        if have_pipx:
            return ["pipx", "install", "yt-dlp[default]"], None
        if have_uv:
            return ["uv", "tool", "install", "yt-dlp[default]"], None
        return None, "Install pipx first:  sudo apt install pipx && pipx ensurepath"

    info = _ytdlp_info()
    if not info["found"]:
        return _ytdlp_command("install")
    via = info["via"]
    if via == "pipx" and have_pipx:
        return ["pipx", "upgrade", "yt-dlp"], None
    if via == "uv" and have_uv:
        return ["uv", "tool", "upgrade", "yt-dlp"], None
    if via == "apt":
        return None, ("This yt-dlp comes from apt and is too old for YouTube. Remove it "
                      "(sudo apt remove yt-dlp) and install the latest with pipx.")
    return [info["path"], "-U"], None


def run_maintenance(action):
    cmd, problem = _ytdlp_command(action)
    if problem:
        return {"ok": False, "command": None, "output": problem}
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600, env=tool_env())
        output, ok = (proc.stdout + proc.stderr).strip(), proc.returncode == 0
    except (OSError, subprocess.TimeoutExpired) as exc:
        output, ok = str(exc), False
    return {"ok": ok, "command": " ".join(cmd), "output": output, "ytdlp": _ytdlp_info()}


def pick_folder(start):
    """Native GNOME folder chooser. Returns the chosen path, or None if cancelled."""
    if not shutil.which("zenity"):
        raise RuntimeError("zenity is not installed (sudo apt install zenity)")
    start_dir = Path(start).expanduser() if start else HOME
    while not start_dir.is_dir() and start_dir != start_dir.parent:
        start_dir = start_dir.parent
    proc = subprocess.run(
        ["zenity", "--file-selection", "--directory", "--title=Choose download folder",
         f"--filename={start_dir}/"],
        capture_output=True, text=True,
    )
    chosen = proc.stdout.strip()
    return chosen if proc.returncode == 0 and chosen else None


def open_folder(path):
    target = Path(path).expanduser()
    while not target.exists() and target != target.parent:
        target = target.parent
    subprocess.Popen(["xdg-open", str(target)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)
    return str(target)
