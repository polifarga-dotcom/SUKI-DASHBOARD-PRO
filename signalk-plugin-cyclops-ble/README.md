# signalk-plugin-cyclops-ble

**Read Cyclops Marine smartlink rig load sensors directly via Bluetooth LE — no Cyclops gateway, no WiFi.**

Cyclops smartlink / smartlink² load sensors are built on Mantracourt B24 Bluetooth telemetry hardware. They broadcast their load value in Bluetooth LE advertisements, and any receiver in range can pick these up. This plugin turns your Signal K server (e.g. a Raspberry Pi) into that receiver. It listens passively through BlueZ, decodes the B24 adverts and writes the load into Signal K.

Why:

- The Cyclops gateway is a separate box that has to reach your network over WiFi. If that link is unreliable, polling it gives `Fetch error` / `UND_ERR_CONNECT_TIMEOUT` and gaps in your data.
- With this plugin, the only link is Bluetooth from the sensor to your Signal K host. There's nothing to pair and no cloud or app involved.
- The plugin only listens and never connects to the sensors. It can run next to an existing Cyclops gateway or phone app without interfering.

## Signal K paths

| Path | Unit | Description |
|---|---|---|
| `rigging.<name>.tension` | N | Load (same path as `signalk-cyclops-gateway`, so dashboards keep working) |
| `sensors.cyclops.<name>.rssi` | dBm | Bluetooth signal strength of the last packet |
| `sensors.cyclops.<name>.status` | – | B24 status byte (0 = OK) |
| `sensors.cyclops.<name>.age` | s | Seconds since the last load value, updated every 10 s |

Newtons → tonnes: `value / 9806.65`.

The plugin status in the admin UI shows every sensor with its load, data age, last sign of life and RSSI, for example:
`hci1 · port: 2.24 t (4s, alive 1s, -68 dBm) · starboard: 2.28 t (2s, alive 2s, -64 dBm)`

## Hardware recommendation

A Raspberry Pi's built-in Bluetooth works, but its range is poor, especially inside a metal enclosure or below deck. Cyclops itself quotes about 8 m to the sensors. With the onboard radio at roughly 8 m and −80 dBm we only got one value every 15–60 s. **A USB Bluetooth adapter with an external antenna is strongly recommended.** The plugin automatically prefers a USB adapter over the onboard one.

| | Adapter | Notes |
|---|---|---|
| ✅ Recommended | **TP-Link UB500 Plus** (USB, external high-gain antenna, ~15–20 €) | Realtek RTL8761BU (BT 5.0 version) / RTL8761CU (newer BT 5.3 version). Works with the `firmware-realtek` package (preinstalled on Raspberry Pi OS). |
| ✅ Proven alternative | **Sena UD100** (Class 1, external antenna, ~40–60 €) | CSR chipset, native Linux support without extra firmware, long range. |
| ➕ Accessory | **USB 2.0 extension cable, 2–3 m** | Lets you place the adapter outside the enclosure, away from metal and with a clear view towards the mast/chainplates. Placement usually matters more than the antenna. |
| ❌ Avoid | No-name "Bluetooth 5.3 / 5.4" sticks without a named chipset | Many use Barrot chips, which have no Linux driver. |

To measure what your sensors really send, use a phone app such as **nRF Connect** next to a sensor. The sensors advertise as Mantracourt devices (company ID `0x04C3`), sometimes with the name "Smart Load".

## Installation

1. Install **Cyclops BLE Rig Load** from the Signal K Appstore, or run `npm install signalk-plugin-cyclops-ble` in `~/.signalk`.
2. Allow the Signal K user to talk to BlueZ. On Debian / Raspberry Pi OS only `root` may do so by default. Replace `pi` with the user Signal K runs as (`systemctl show signalk -p User`):

   ```bash
   sudo tee /etc/dbus-1/system.d/signalk-bluez.conf <<'EOF'
   <!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-BUS Bus Configuration 1.0//EN"
    "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
   <busconfig>
     <policy user="pi">
       <allow send_destination="org.bluez"/>
     </policy>
   </busconfig>
   EOF
   sudo systemctl reload dbus
   ```

3. Make sure Bluetooth is not blocked: `rfkill list` (or `cat /sys/class/rfkill/rfkill*/soft`). If it is, run `sudo rfkill unblock bluetooth`.
4. Restart Signal K and enable the plugin. With default settings every B24 sensor in range shows up as `rigging.b24_<tag>.tension`, and its MAC address appears in the plugin status.
5. Optional: map the MAC addresses to names under **Sensors**, e.g. `84:C6:92:EC:ED:21 → port`, `84:C6:92:EC:ED:0F → starboard`. The name chosen in the Cyclops app is not included in the Bluetooth broadcast. Hang a load on one sensor and watch which value changes.

## Configuration

| Option | Default | |
|---|---|---|
| Bluetooth adapter | empty | e.g. `hci1`. Empty = first USB adapter, else `hci0` |
| Auto discover | on | Publish unmapped sensors as `b24_<tag>` |
| B24 view PIN | `0000` | Cyclops sensors use `0000`. Other B24 products may use a custom PIN. |
| Stale after | 120 s | Plugin status turns red when a sensor sent no load value for this long |
| Sensors | – | List of MAC → name |

## Migrating from `signalk-cyclops-gateway`

The paths are identical (`rigging.<name>.tension` in N). Use the same sensor names as before (`port`, `starboard`, …), check the values, then disable `signalk-cyclops-gateway`. You can then remove the gateway's WiFi connection.

## NMEA 2000 backup (experimental)

> **Tested limitation:** on a B&G system (Zeus 3S + Triton) the displays did **not** show the loads sent this way, although the messages were byte-identical to the gateway's and verifiably on the bus. The Cyclops gateway claims a B&G device identity on NMEA 2000, and an interface such as a Yacht Devices USB gateway always transmits under its own identity. The option is therefore off by default. A drop-in replacement that B&G accepts without reconfiguration needs a separate NMEA 2000 node that claims the gateway's identity, e.g. an ESP32 with a CAN transceiver.
>
> With a Yacht Devices USB gateway, Signal K's NMEA 2000 connection also needs **Create device** switched off before anything is transmitted.

The Cyclops gateway also feeds the load to NMEA 2000 displays as PGN 65293 "Diverse Yacht Services: Load Cell", in kg in 10 kg steps. Enable **NMEA 2000 backup** and give each sensor its **n2kInstance** (a Cyclops gateway typically uses 30 = port, 31 = starboard) to make the plugin send exactly the same message through your Signal K NMEA 2000 connection, once per second.

- The plugin only sends for an instance while no other device (e.g. the Cyclops gateway) has sent that instance for 5 s. With the gateway present it stays silent; if the gateway fails or is removed, it takes over automatically.
- It never repeats a stale load (older than *Stale after*).
- The message comes from your NMEA 2000 interface's own source address, not from the gateway's. Some displays may need the load source re-selected.
- State: `sensors.cyclops.n2kBackup` = `sending` / `gateway` / `idle`.
- Requires an NMEA 2000 connection that can transmit (e.g. Yacht Devices, Actisense, SocketCAN).

## How it works

The sensors put an 11-byte Mantracourt manufacturer-data block (company ID `0x04C3`) into every advertisement:

```
01 | tag tag | status units f32 f32 f32 f32 tag tag
     clear   | XOR-encoded with (seed XOR view PIN)
```

The encoding scheme is documented in the Mantracourt B24 Technical Manual ("Decoding Data with View PIN"). The value is an IEEE 754 float, big-endian. Unit code `0x3a` is tonnes, which was verified against a Cyclops gateway. A packet is only accepted when the encoded trailing tag matches the clear-text tag, so a wrong PIN never produces wrong values.

Requirements: Linux with BlueZ 5.x, Node.js ≥ 18, and Signal K server.

## Disclaimer

This is an independent project and is not affiliated with or endorsed by Cyclops Marine or Mantracourt Electronics. Don't rely on it as your only rig-load safety system.

## License

MIT
