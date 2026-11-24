#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$HOME/.local/share/mintrip/venv"

echo "1/4 Installiere Linux-Mint-Systempakete (GTK3, libcdio, SWIG, cdparanoia, FLAC, LAME, FFmpeg)..."
sudo apt-get update
sudo apt-get install -y \
  python3-gi \
  python3-gi-cairo \
  gir1.2-gtk-3.0 \
  python3-venv \
  python3-dev \
  python3-mutagen \
  python3-musicbrainzngs \
  libcdio-dev \
  libiso9660-dev \
  libcdio-paranoia-dev \
  swig \
  pkg-config \
  build-essential \
  cdparanoia \
  flac \
  lame \
  ffmpeg \
  zbar-tools

echo "2/4 Erstelle lokales Python-Environment mit System-GTK3-Anbindung..."
mkdir -p "$(dirname "$VENV_DIR")"
python3 -m venv --system-site-packages "$VENV_DIR"
"$VENV_DIR/bin/pip" install --upgrade pip wheel setuptools

echo "3/4 Kompiliere und installiere pycdio sowie Python-Abhängigkeiten..."
"$VENV_DIR/bin/pip" install -r "$APP_DIR/requirements.txt"

echo "4/4 Richte Starter und Desktop-Verknüpfung ein..."
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"

cat > "$HOME/.local/bin/mintrip" <<EOF
#!/usr/bin/env bash
exec "$VENV_DIR/bin/python3" "$APP_DIR/main.py" "\$@"
EOF
chmod +x "$HOME/.local/bin/mintrip" "$APP_DIR/main.py"

cp "$APP_DIR/mintrip.desktop" "$HOME/.local/share/applications/mintrip.desktop"
sed -i "s|EXEC_PATH|$HOME/.local/bin/mintrip|g" "$HOME/.local/share/applications/mintrip.desktop"

echo ""
echo "Installation erfolgreich abgeschlossen!"
echo "Starten über das Anwendungsmenü ('MintRip Studio') oder im Terminal mit:"
echo "  $VENV_DIR/bin/python3 $APP_DIR/main.py"
