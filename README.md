# Meinberg Clock Monitor

A Node.js application that polls Meinberg LANTIME clocks via SNMP and pushes metrics to a Prometheus Pushgateway. Designed for broadcast facilities using SMPTE-2110 and AES67 networks requiring high-precision time synchronization.

## Overview

Polls one or more Meinberg LANTIME devices using SNMP v2c and exposes GPS receiver health, satellite counts, NTP status, and system uptime as Prometheus metrics. Multiple device models are supported and auto-detected at startup.

## Supported Models

| Model | MIB | Notes |
|---|---|---|
| LANTIME M300, M1000, etc. | LANTIME NG (`.5597.30`) | Full metrics including TDOP/PDOP, UTC offset |
| RX801 and similar | Meinberg OS (`.5597.7`) | GPS/NTP/satellite metrics; TDOP, PDOP, UTC offset not available in this MIB |

Model detection is automatic — the poller probes each host at startup and selects the correct OID set. No configuration is required. The `model` label (`lantime-ng` or `rx801`) is present on every metric.

## Metrics

All metrics carry `host` and `model` labels.

| Metric | LANTIME NG | RX801 | Description |
|---|---|---|---|
| `meinberg_uptime_seconds` | ✓ | ✓ | System uptime — drops to near-zero on reboot |
| `meinberg_refclock_state` | ✓ | ✓ | 1=synchronized, 2=notSynchronized, 0=notAvailable. Labels: `state`, `substate`, `usage` |
| `meinberg_gps_satellites_good` | ✓ | ✓ | Good/usable GPS satellites in view |
| `meinberg_gps_satellites_visible` | ✓ | ✓ | Total GPS satellites in view |
| `meinberg_gps_altitude_meters` | ✓ | ✓ | GPS antenna altitude in metres |
| `meinberg_ntp_state` | ✓ | ✓ | 2=synchronized, 1=notSynchronized, 0=notAvailable. Label: `state` |
| `meinberg_ntp_stratum` | ✓ | ✓ | NTP stratum level |
| `meinberg_ntp_offset_milliseconds` | ✓ | ✓ | NTP time offset in milliseconds |
| `meinberg_gps_tdop` | ✓ | — | Timing dilution of precision |
| `meinberg_gps_pdop` | ✓ | — | Positional dilution of precision |
| `meinberg_gps_utc_offset_seconds` | ✓ | — | Current leap second count |

### Substate values

The `substate` label on `meinberg_refclock_state` surfaces fine-grained receiver state:

- **LANTIME NG:** `mrsGpsSync`, `gpsTracking`, `gpsAntennaDisconnected`, `gpsColdBoot`, `gpsWarmBoot`, `mrsNtpSync`, `mrsPtpIeee1588Sync`, and others from the MRS state machine
- **RX801:** `gpsSync`, `gpsTracking`, `gpsColdBoot`, `gpsWarmBoot`, `notAvailable` — or `disconnected`/`shortCircuit` if an antenna fault is detected

## Prerequisites

- [Node.js](https://nodejs.org/) v20+
- SNMP v2c read access to the clock (community string, typically `public`)
- A running [Prometheus Pushgateway](https://github.com/prometheus/pushgateway)

## Installation

### Local

```bash
git clone https://github.com/yourusername/meinberg-clock-monitor.git
cd meinberg-clock-monitor
npm install
cp .env.example .env
# edit .env with your values
npm start
```

### Docker

```bash
docker build -t meinberg-clock-monitor .

docker run -d \
  -e CLOCK_HOSTS="ntp1,ntp2,10.204.32.251" \
  -e SNMP_COMMUNITY="public" \
  -e PUSHGATEWAY_URL="http://pushgateway:9091" \
  -e POLL_INTERVAL=60000 \
  meinberg-clock-monitor
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CLOCK_HOSTS` | `ntp1,ntp2` | Comma-separated list of clock hostnames or IPs |
| `SNMP_COMMUNITY` | `public` | SNMP v2c community string |
| `PUSHGATEWAY_URL` | *(required)* | Pushgateway base URL, e.g. `http://pushgateway:9091` |
| `POLL_INTERVAL` | `60000` | Poll interval in milliseconds |

## Troubleshooting

- **SNMP timeouts:** Verify the clock is reachable and SNMP v2c is enabled with the correct community string.
- **Pushgateway errors:** Check `PUSHGATEWAY_URL` and that the Pushgateway is running and reachable.
- **Wrong model detected:** Model detection runs once at startup by probing the LANTIME NG OID. Restart the poller if a device was unreachable at startup.
- **Missing TDOP/PDOP/UTC offset:** These are not available in the Meinberg OS MIB used by the RX801 — check the `model` label to confirm which MIB is in use.

## License

MIT
