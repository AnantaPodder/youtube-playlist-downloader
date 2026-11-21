# Playlist Downloader

A small desktop-style app for Ubuntu that downloads YouTube playlists in 1080p with
[yt-dlp](https://github.com/yt-dlp/yt-dlp). It runs locally: a standard-library Python
server drives the `yt-dlp` command line, and a Tailwind UI opens in a Chrome app window.

- Paste a playlist (or single video) link to preview it, then tick the videos you want.
- Pick a quality preset. Each one maps to the yt-dlp flags from the setup notes:

  | Preset | yt-dlp flags |
  | --- | --- |
  | **1080p or higher** (default) | `-f "bv*[height>=1080]+ba/bv*+ba/b"` |
  | **Strict 1080p+** (skip videos without it) | `-i -f "bv*[height>=1080]+ba"` |
  | **Up to 1080p** | `-S "res:1080"` |

  All presets add `--merge-output-format mp4` and save to
  `<folder>/<playlist title>/001 - <title>.mp4`.
- Downloads run one after another. Each one shows live progress, speed and ETA, the
  status of every video, and the full yt-dlp log.
- Cancel keeps the partial files. Retry picks up where the download stopped and skips
  videos that are already finished.
- The **Update yt-dlp** button runs `pipx upgrade yt-dlp` (or `uv tool upgrade yt-dlp`).
  Use it when downloads suddenly start failing.

## 1. Install the tools

Skip the apt version of yt-dlp. Ubuntu's repositories lag behind, and old versions stop working on YouTube quickly.

```bash
# ffmpeg (needed to merge 1080p video + audio)
sudo apt update
sudo apt install ffmpeg pipx
pipx ensurepath

# yt-dlp (latest version, with extras for YouTube)
pipx install "yt-dlp[default]"

# Deno (JavaScript runtime yt-dlp now needs for YouTube)
curl -fsSL https://deno.land/install.sh | sh
```

The app looks in `~/.local/bin` and `~/.deno/bin` on its own, so you don't have to edit
your PATH for it. Its setup panel shows what's still missing and can install yt-dlp for you
when pipx or uv is available.

## 2. Run it

```bash
python3 app.py            # starts the server and opens the app window
python3 app.py --stop     # stops it
```

It runs at <http://127.0.0.1:8765> (use `--port` to change that). Running it again while it's
already open just brings the window back.

To add it to the Ubuntu app grid:

```bash
./install-desktop.sh
```

## Development

Python 3.9+ and nothing else is needed at runtime. `web/app.css` is prebuilt. Rebuild it
after you change Tailwind classes in `web/index.html` or `web/app.js`:

```bash
npm install
npm run build:css     # or: npm run watch:css
```

| Path | What it does |
| --- | --- |
| `app.py` | Launcher: starts the server, opens the window, handles a single instance |
| `backend/server.py` | HTTP API and static files (localhost only, with Host/Origin checks) |
| `backend/downloader.py` | Job queue, yt-dlp command building, progress parsing |
| `backend/system.py` | Finds yt-dlp/ffmpeg/deno, runs install/update, folder picker |
| `web/` | UI: `index.html`, `app.js`, Tailwind source in `src/input.css` |

To point the app at a specific yt-dlp binary, set `YTPD_YT_DLP=/path/to/yt-dlp`.
`YTPD_FFMPEG` and `YTPD_DENO` work the same way.
