# MintRip Studio Webapp – Step-by-Step Installation in Debian 13 (Trixie) auf Proxmox VE

Diese Anleitung beschreibt Schritt für Schritt, wie die **MintRip Studio Webapp** in einem **frischen (blanken) Debian 13 (Trixie) LXC-Container** unter **Proxmox VE** eingerichtet und dauerhaft betrieben wird.

---

## Überblick: Zwei mögliche Installationswege

1. **Weg A (empfohlen für Proxmox-LXC):** **Direkte Installation mit Node.js 22 + `systemd`-Dienst**  
   Ressourcenschonend, kein Docker-in-LXC nötig, sauberer Autostart beim Container-Boot.
2. **Weg B (Alternative mit Docker):** **Docker Engine + Docker Compose im Debian-13-LXC**  
   Nutzt direkt die mitgelieferte `Dockerfile`- und `docker-compose.yml`-Konfiguration (erfordert aktiviertes **Nesting** in den Proxmox-LXC-Optionen).

---

## Schritt 1: Debian-13-Template laden & LXC-Container in Proxmox anlegen

1. **Container-Template herunterladen** (falls noch nicht vorhanden):
   - In der Proxmox-Weboberfläche: **Node → `local` (Storage) → CT Templates → Templates**.
   - Nach **`debian-13-standard`** suchen und auf **Download** klicken.
2. **Neuen LXC-Container erstellen („Create CT“):**
   - **Allgemein:** Hostname z. B. `mintrip-studio`, Root-Passwort vergeben, **Unprivileged container** aktiviert lassen.
   - **Template:** `debian-13-standard_...` auswählen.
   - **Disk:** `8 GiB` (reicht inklusive Build-Cache aus).
   - **CPU:** `2 Cores`.
   - **Memory:** `2048 MiB` (empfohlen für `npm install` und `vite build`; im laufenden Betrieb benötigt der Server deutlich weniger).
   - **Netzwerk:** Bridge `vmbr0`, **IPv4: DHCP** oder **statische IP** (z. B. `192.168.1.50/24` + Gateway).
   - **DNS:** Host-Einstellungen übernehmen.
3. **Nur bei Weg B (Docker im LXC):**
   - Vor dem ersten Start auf den neuen Container klicken → **Optionen → Features → Bearbeiten** → **`Nesting`** aktivieren.
4. **Container starten** und über **Konsole** (oder auf dem Proxmox-Host per `pct enter <CT-ID>`) als `root` einloggen.

---

## Schritt 2: Grundpakete im blanken Debian-13-Container installieren

In einem frischen Debian-13-LXC fehlen `curl`, `gnupg` und `unzip` meist noch. Als `root` im Container ausführen:

```bash
apt update && apt upgrade -y
apt install -y curl ca-certificates gnupg unzip
```

---

## Schritt 3: Projektpaket in den Container übertragen & entpacken

1. Lade das komplette Webapp-Projekt als ZIP-Datei auf deinen Rechner herunter (z. B. über Export/Download).
2. Im Debian-13-Container das Zielverzeichnis anlegen:
   ```bash
   mkdir -p /opt/mintrip-studio
   ```
3. **ZIP-Datei in den Container übertragen** (eine der beiden Varianten wählen):
   - **Variante 1 (über den Proxmox-Host mit `pct push` – funktioniert auch ohne SSH im Container):**
     1. ZIP-Datei per `scp` auf den Proxmox-Host nach `/tmp/mintrip-studio.zip` kopieren.
     2. Auf der **Proxmox-Host-Shell** (ersetze `105` durch die tatsächliche Container-ID):
        ```bash
        pct push 105 /tmp/mintrip-studio.zip /tmp/mintrip-studio.zip
        ```
   - **Variante 2 (direkt per `scp`, falls SSH im Container aktiviert ist):**
     ```bash
     scp mintrip-studio.zip root@<CONTAINER-IP>:/tmp/mintrip-studio.zip
     ```
4. **Im Container entpacken:**
   ```bash
   unzip /tmp/mintrip-studio.zip -d /opt/mintrip-studio
   cd /opt/mintrip-studio
   ls -la
   ```
   > **Hinweis:** Prüfe mit `ls -la`, ob `package.json` und `server.ts` direkt in `/opt/mintrip-studio/` liegen. Falls das ZIP-Archiv einen zusätzlichen Unterordner enthält, verschiebe dessen Inhalt nach `/opt/mintrip-studio/`.

---

## Schritt 4 – Weg A (empfohlen): Native Installation mit Node.js 22 & `systemd`

> **Wichtig für Debian 13 (Trixie):** Die Standard-Paketquellen von Debian 13 liefern Node.js 20 aus. Der Express-/TypeScript-Server (`node server.ts`) benötigt jedoch **Node.js 22 LTS** mit nativer TypeScript-Ausführung. Daher wird Node.js 22 über das offizielle NodeSource-Repository installiert.

### A1. Node.js 22 installieren

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
```

Version prüfen (muss `v22.x` anzeigen):

```bash
node -v
npm -v
```

### A2. Abhängigkeiten installieren & Produktiv-Build erzeugen

```bash
cd /opt/mintrip-studio
npm install --no-audit --no-fund
npm run build
```

### A3. Kurzer Funktionstest

```bash
NODE_ENV=production npm start
```

Erwartete Ausgabe: `MintRip Studio server listening on http://0.0.0.0:3000`.  
Mit `Strg + C` wieder stoppen.

### A4. `systemd`-Dienst für den automatischen Start einrichten

Dedizierten Systembenutzer anlegen, Berechtigungen setzen und Service-Datei erstellen:

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin mintrip || true
chown -R mintrip:mintrip /opt/mintrip-studio

cat <<'EOF' > /etc/systemd/system/mintrip-studio.service
[Unit]
Description=MintRip Studio Webapp
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mintrip
Group=mintrip
WorkingDirectory=/opt/mintrip-studio
Environment=NODE_ENV=production
# Optional: persönlichen Discogs-API-Token serverseitig setzen
# Environment=DISCOGS_TOKEN=dein_token
ExecStart=/usr/bin/node /opt/mintrip-studio/server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

Dienst aktivieren und sofort starten:

```bash
systemctl daemon-reload
systemctl enable --now mintrip-studio
systemctl status mintrip-studio
```

---

## Schritt 4 – Weg B (Alternative): Installation mit Docker im Debian-13-LXC

> **Voraussetzung:** In Proxmox muss unter **Container → Optionen → Features** das Flag **`Nesting`** aktiviert sein.

### B1. Offizielles Docker-Repository für Debian 13 (`trixie`) einrichten

```bash
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian \
  trixie stable" > /etc/apt/sources.list.d/docker.list

apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Docker-Dienst aktivieren und prüfen:

```bash
systemctl enable --now docker
docker --version
docker compose version
```

### B2. Docker-Container bauen & starten

```bash
cd /opt/mintrip-studio
docker compose up -d --build
```

*(Optional kann in `docker-compose.yml` vorab ein `DISCOGS_TOKEN` eingetragen werden.)*

Status und Logs prüfen:

```bash
docker compose ps
docker compose logs -f
```

*(Mit `Strg + C` verlässt du die Log-Ansicht; der Container läuft weiter und startet dank `restart: unless-stopped` automatisch.)*

---

## Schritt 5: Webapp aufrufen & testen

1. **Container-IP anzeigen** (falls DHCP genutzt wird):
   ```bash
   hostname -I
   ```
2. **Erreichbarkeit lokal im Container prüfen:**
   ```bash
   curl -I http://127.0.0.1:3000
   ```
   *(Erwartet `HTTP/1.1 200 OK`.)*
3. **Im Browser vom PC öffnen:**
   ```text
   http://<CONTAINER-IP>:3000
   ```

---

## Wartung, Logs & Updates

- **Logs live ansehen:**
  - Weg A (`systemd`): `journalctl -u mintrip-studio -f`
  - Weg B (Docker): `cd /opt/mintrip-studio && docker compose logs -f`
- **Nach einem Code-/Paket-Update neu bauen & neu starten:**
  - Weg A:
    ```bash
    cd /opt/mintrip-studio
    npm install --no-audit --no-fund
    npm run build
    chown -R mintrip:mintrip /opt/mintrip-studio
    systemctl restart mintrip-studio
    ```
  - Weg B:
    ```bash
    cd /opt/mintrip-studio
    docker compose up -d --build
    ```
- **Hinweis zu Browser-Funktionen im Heimnetz (`http://` vs. `https://`):**  
  Der Ordner-Import über `Album-Ordner laden` bzw. Drag & Drop sowie Online-Abfragen und Shazam funktionieren auch direkt per `http://<IP>:3000`. Für Browser-Funktionen, die einen sicheren Kontext („Secure Context“) verlangen (z. B. den Kamera-Barcode-Scanner), empfiehlt sich ein HTTPS-Reverse-Proxy (z. B. Nginx Proxy Manager, Caddy oder Traefik) vor dem Container.
