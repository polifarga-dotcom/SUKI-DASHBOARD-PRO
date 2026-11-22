#!/bin/bash
# SUKI PredictWind Sync für macOS: lädt neue PredictWind-GRIBs (~/Downloads/PredictWind/…) und
# Routen (~/Downloads/Offshore_Route_*.gpx aus der Offshore App, PredictWind_Route_*.gpx aus der Web-App) automatisch auf den Pi der SUKI Radar Station.
#   Einrichten:  curl -fsSL <PI>/pw-sync/install.sh | bash -s <PI>
#   Entfernen:   curl -fsSL <PI>/pw-sync/install.sh | bash -s -- --uninstall
set -e
DIR="$HOME/Library/Application Support/SUKI"
APP="$HOME/Applications/SUKI PredictWind Sync.app"
AGENT="$HOME/Library/LaunchAgents/com.suki.pwsync.plist"
UIDN="$(id -u)"

if [ "$1" = "--uninstall" ]; then
	launchctl bootout "gui/$UIDN" "$AGENT" 2>/dev/null || true
	rm -rf "$AGENT" "$APP" "$DIR/pw-sync.sh" "$DIR/pw-sync.state"
	echo "SUKI PredictWind Sync entfernt. Den Eintrag unter Systemeinstellungen → Datenschutz → Festplattenvollzugriff kannst du löschen."
	exit 0
fi

PI="${1:-http://192.168.0.100:8090}"
PI="${PI%/}"
case "$PI" in http://* | https://*) ;; *) echo "Adresse des Pi fehlt, z. B. http://192.168.0.100:8090" >&2; exit 1 ;; esac
mkdir -p "$DIR" "$HOME/Applications" "$HOME/Library/LaunchAgents"

# ── eigentliches Sync-Skript ──
cat > "$DIR/pw-sync.sh" <<'EOS'
#!/bin/bash
PI="__PI__"
D="$HOME/Downloads"
STATE="$HOME/Library/Application Support/SUKI/pw-sync.state"
HOSTN="$(scutil --get ComputerName 2>/dev/null || hostname)"
HJ="$(printf '%s' "$HOSTN" | sed 's/[\\"]//g')"
report() { curl -s -m 10 -X POST -H 'Content-Type: application/json' -d "{\"host\":\"$HJ\"$1}" "$PI/tiles/api/pw/report" >/dev/null 2>&1; }
# macOS schützt „Downloads“: ohne Festplattenvollzugriff schlägt schon das Auflisten fehl
if ! ls "$D" >/dev/null 2>&1; then report ',"error":"no-access"'; exit 0; fi
touch "$STATE"
while IFS= read -r -d '' f; do
	n="$(basename "$f")"
	# Name + Größe + Dateidatum + ctime: weicht eins ab, wird neu gesendet (Pi überschreibt).
	# ctime, weil die Offshore App das Dateidatum auf die Laufzeit setzt – ein erneuter Download ändert sonst nichts.
	key="$n|$(stat -f '%z|%m|%c' "$f")"
	grep -qxF "$key" "$STATE" && continue
	if curl -fsS -m 300 -X PUT -H "X-Sync-Host: $HOSTN" -H "X-Sync-Auto: 1" --data-binary @"$f" "$PI/tiles/api/pw/upload/$n" >/dev/null 2>&1; then
		echo "$key" >> "$STATE"
	fi
done < <(find "$D/PredictWind" -type f -name '*.grb' -mtime -3 -print0 2>/dev/null; find "$D" -maxdepth 1 -type f \( -name 'PredictWind_Route_*.gpx' -o -name 'Offshore_Route_*.gpx' \) -mtime -14 -print0 2>/dev/null)
tail -n 2000 "$STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"
report ''
EOS
sed -i '' "s|__PI__|$PI|" "$DIR/pw-sync.sh"
chmod +x "$DIR/pw-sync.sh"

# ── kleine App: nur sie bekommt den Festplattenvollzugriff (bleibt beim erneuten Einrichten erhalten) ──
FRESH=0
if [ ! -d "$APP" ]; then
	osacompile -o "$APP" -e "do shell script quoted form of (POSIX path of (path to home folder) & \"Library/Application Support/SUKI/pw-sync.sh\")"
	/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$APP/Contents/Info.plist" 2>/dev/null || true
	codesign --force -s - "$APP" 2>/dev/null || true
	FRESH=1
fi

# ── Hintergrunddienst: bei neuen Downloads und alle 5 min ──
cat > "$AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
	<key>Label</key><string>com.suki.pwsync</string>
	<key>ProgramArguments</key><array><string>$APP/Contents/MacOS/applet</string></array>
	<key>WatchPaths</key><array><string>$HOME/Downloads</string><string>$HOME/Downloads/PredictWind</string></array>
	<key>StartInterval</key><integer>300</integer>
	<key>RunAtLoad</key><true/>
	<key>ThrottleInterval</key><integer>30</integer>
</dict></plist>
EOF
launchctl bootout "gui/$UIDN" "$AGENT" 2>/dev/null || true
launchctl bootstrap "gui/$UIDN" "$AGENT"

echo ""
echo "✓ SUKI PredictWind Sync eingerichtet (Pi: $PI)."
if [ "$FRESH" = 1 ]; then
	echo ""
	echo "Noch ein Schritt: macOS muss den Zugriff auf „Downloads“ erlauben."
	echo "  1. Die Systemeinstellungen öffnen sich bei „Festplattenvollzugriff“."
	echo "  2. Auf „+“ klicken (ggf. mit Passwort/Touch ID entsperren)."
	echo "  3. „SUKI PredictWind Sync“ aus dem Finder-Fenster hineinziehen bzw. auswählen und einschalten."
	echo "Danach zeigt die SUKI-App unter Setup → PredictWind „Automatischer Sync aktiv“."
	open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" 2>/dev/null || true
	open -R "$APP" 2>/dev/null || true
fi
