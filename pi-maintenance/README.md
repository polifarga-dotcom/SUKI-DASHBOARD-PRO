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

## Alarm-Summer (SignalK-Pi .100)

Aktiver Piezo SFM-27 (3–24 V) an **GPIO17 = Pin 11 (+, rot)** und **GND = Pin 9 (−, schwarz)**. Der Dienst `suki-buzzer`
folgt dem Alarmton von Node-RED (`state.beep`, gleicher Takt wie das Mini Dash: voll 0,5 s an/aus, nachts kurzer Piep alle 2 s).
Quittieren am Display macht ihn still; „Sound“ aus in den Mini-Dash-Settings schaltet ihn mit ab.
Direkt am Pin läuft der Summer mit 3,3 V (leiser); lauter mit 12 V über ein kleines MOSFET-Modul, das GPIO17 schaltet.

```bash
scp suki-buzzer suki-buzzer.service admin@192.168.0.100:/tmp/
ssh admin@192.168.0.100 'sudo install -m 755 /tmp/suki-buzzer /usr/local/bin/ && sudo install -m 644 /tmp/suki-buzzer.service /etc/systemd/system/ \
  && sudo systemctl daemon-reload && sudo systemctl enable --now suki-buzzer'
```

Probeton (2 s): `sudo systemctl stop suki-buzzer; suki-buzzer --test; sudo systemctl start suki-buzzer`
