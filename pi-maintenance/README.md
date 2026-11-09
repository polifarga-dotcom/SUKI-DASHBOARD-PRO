# Pi-Wartung (Winterbetrieb)

Wöchentlicher Neustart beider Pis, nur wenn das Boot still liegt (SOG < 0,5 kn, aktuelle Daten),
keine Ankerwache läuft und kein Alarm ansteht. Sonst wird auf die nächste Woche verschoben.

- OpenCPN-Pi (.112): sonntags 12:00
- SignalK-Pi (.100): sonntags 12:20 (versetzt, damit Tailscale währenddessen über den OpenCPN-Pi läuft)

Installation je Pi (`WHEN` = `Sun 12:00` bzw. `Sun 12:20`):

```bash
scp suki-weekly-reboot suki-weekly-reboot.service admin@PI:/tmp/
ssh admin@PI 'sudo install -m 755 /tmp/suki-weekly-reboot /usr/local/sbin/ && sudo install -m 644 /tmp/suki-weekly-reboot.service /etc/systemd/system/ \
  && printf "[Unit]\nDescription=SUKI weekly reboot timer\n\n[Timer]\nOnCalendar=WHEN\nPersistent=false\n\n[Install]\nWantedBy=timers.target\n" | sudo tee /etc/systemd/system/suki-weekly-reboot.timer \
  && sudo systemctl daemon-reload && sudo systemctl enable --now suki-weekly-reboot.timer'
```

Prüfen: `suki-weekly-reboot --dry-run`, Protokoll: `journalctl -t suki-weekly-reboot`, nächster Lauf: `systemctl list-timers suki-weekly-reboot.timer`.

Hardware-Watchdog: systemd `RuntimeWatchdogSec=1min` ist auf beiden Pis bereits Standard (Debian 13).
Tailscale: beide Pis bieten 192.168.0.0/24 an (.100 primär, .112 Ersatz), Schlüsselablauf abgeschaltet.
