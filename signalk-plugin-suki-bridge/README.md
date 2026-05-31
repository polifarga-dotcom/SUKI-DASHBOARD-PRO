# signalk-plugin-suki-bridge

A [SignalK](https://signalk.org/) server plugin that streams live NMEA data (GPS, wind, depth, battery, engine, tanks, solar) to **SUKI Dashboard Pro** via a Supabase Edge Function.

## Install

Install from the **SignalK Appstore** (search for *SUKI*), or via npm:

```bash
npm install signalk-plugin-suki-bridge
```

## Setup

1. Open your **SUKI Dashboard Pro** → **Settings** → **SignalK Bridge**
2. Copy the **Ingest URL** and **API Key**
3. In the SignalK server UI, go to **Server → Plugin Config → SUKI Dashboard Bridge**
4. Paste the URL and API key, then enable the plugin

## What it sends

| SignalK Path | Column | Unit |
|---|---|---|
| `navigation.position.latitude/longitude` | `nav_lat` / `nav_lon` | degrees |
| `navigation.headingTrue` | `nav_hdg_rad` | radians |
| `navigation.speedOverGround` | `nav_sog_ms` | m/s |
| `navigation.speedThroughWater` | `nav_stw_ms` | m/s |
| `environment.depth.belowKeel` | `env_depth_m` | m |
| `environment.wind.angleApparent` | `env_awa_rad` | radians |
| `environment.wind.speedApparent` | `env_aws_ms` | m/s |
| `environment.wind.angleTrueWater` | `env_twa_rad` | radians |
| `environment.wind.speedTrue` | `env_tws_ms` | m/s |
| `environment.outside.pressure` | `env_pressure_pa` | Pa |
| `electrical.batteries.0.*` | `batt_main_*` | V / A / W / ratio |
| `electrical.batteries.1.*` | `batt_eng_*` | V / A |
| `propulsion.main.*` / `propulsion.port.*` | `eng_*` | rpm / s / K / V |
| `tanks.freshWater.0.currentLevel` | `tank_fw` | ratio (0–1) |
| `tanks.diesel.0.currentLevel` | `tank_dsl` | ratio (0–1) |
| `electrical.chargers.0.panelPower` | `solar_total_w` | W |
| `steering.rudderAngle` | `rudder_rad` | radians |
| `rigging.port.tension` | `rig_port` | N |
| `rigging.starboard.tension` | `rig_sb` | N |

Data is batched and sent every 5 seconds (configurable).

## Configuration

| Field | Description | Default |
|---|---|---|
| `api_key` | API Key from SUKI Dashboard Settings | *(required)* |
| `endpoint` | Ingest URL from SUKI Dashboard Settings | `https://mtcmxrmykvthybwrlnvz.supabase.co/functions/v1/signalk-ingest` |
| `interval_ms` | Send interval in milliseconds | `5000` |

## License

MIT
