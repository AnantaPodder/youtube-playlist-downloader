#!/usr/bin/env bash
# Adds "Playlist Downloader" to the Ubuntu app grid so it launches like any other app.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
FILE="$APPS/youtube-playlist-downloader.desktop"

mkdir -p "$APPS"
cat > "$FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Playlist Downloader
Comment=Download YouTube playlists in 1080p with yt-dlp
Exec=python3 "$DIR/app.py"
Icon=$DIR/web/favicon.svg
Terminal=false
Categories=AudioVideo;Video;Network;
StartupNotify=false
EOF
chmod +x "$FILE"
update-desktop-database "$APPS" >/dev/null 2>&1 || true

echo "Installed $FILE"
echo "Open Activities and search for \"Playlist Downloader\"."
