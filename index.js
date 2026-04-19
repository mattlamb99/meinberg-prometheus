require('dotenv').config();
const snmp = require('net-snmp');
const client = require('prom-client');

const CLOCK_HOSTS    = (process.env.CLOCK_HOSTS || 'ntp1,ntp2').split(',').map(h => h.trim());
const SNMP_COMMUNITY = process.env.SNMP_COMMUNITY || 'public';
const PUSHGATEWAY_URL = process.env.PUSHGATEWAY_URL;
const POLL_INTERVAL  = parseInt(process.env.POLL_INTERVAL || '60000');

if (!PUSHGATEWAY_URL) {
  console.error('Missing required environment variable: PUSHGATEWAY_URL');
  process.exit(1);
}

// ── OID definitions ──────────────────────────────────────────────────────────

// LANTIME NG MIB (firmware 6+, e.g. M300/M1000) — enterprise .5597.30
const OIDS_NG = {
  sysUpTime:        '1.3.6.1.2.1.1.3.0',
  refclockState:    '1.3.6.1.4.1.5597.30.0.1.2.1.4.1',
  refclockSubstate: '1.3.6.1.4.1.5597.30.0.1.2.1.5.1',
  refclockUsage:    '1.3.6.1.4.1.5597.30.0.1.2.1.3.1',
  goodSatellites:   '1.3.6.1.4.1.5597.30.0.1.2.1.6.1',  // statusA
  totalSatellites:  '1.3.6.1.4.1.5597.30.0.1.2.1.7.1',  // maxStatusA
  gpsAltitude:      '1.3.6.1.4.1.5597.30.0.1.3.1.4.1',
  gpsTdop:          '1.3.6.1.4.1.5597.30.0.1.3.1.5.1',
  gpsPdop:          '1.3.6.1.4.1.5597.30.0.1.3.1.6.1',
  gpsUtcOffset:     '1.3.6.1.4.1.5597.30.0.1.3.1.7.1',
  ntpState:         '1.3.6.1.4.1.5597.30.0.2.1.0',
  ntpStratum:       '1.3.6.1.4.1.5597.30.0.2.2.0',
  ntpOffset:        '1.3.6.1.4.1.5597.30.0.2.4.0',
};

// Meinberg OS MIB (e.g. RX801) — enterprise .5597.7 (mbgOsObjects = .7.2)
// mbgOsNtp      = .7.2.1  mbgOsReceiver = .7.2.3
const OIDS_RX801 = {
  sysUpTime:        '1.3.6.1.2.1.1.3.0',
  // NTP system state (mbgOsNtpSysState = .7.2.1.2.1)
  ntpState:         '1.3.6.1.4.1.5597.7.2.1.2.1.1.0',   // 0=init 1=sync 2=notSync 3=stopped
  ntpStratum:       '1.3.6.1.4.1.5597.7.2.1.2.1.3.0',   // stratum 1..16
  // NTP refclock offset (mbgOsNtpRefclkStateTable row 1, col 8) — nanoseconds
  ntpRefclkOffset:  '1.3.6.1.4.1.5597.7.2.1.2.2.1.1.8.1',
  // Receiver/GPS table (mbgOsReceiverTable = .7.2.3.1.1, row index 1)
  receiverState:    '1.3.6.1.4.1.5597.7.2.3.1.1.3.1',   // 0=noData 1=waitingForData 2=coldBoot 3=warmBoot 4=synchronized
  gpsPosition:      '1.3.6.1.4.1.5597.7.2.3.1.1.5.1',   // "Lat.: ... Alt.: 42m"
  goodSatellites:   '1.3.6.1.4.1.5597.7.2.3.1.1.6.1',
  totalSatellites:  '1.3.6.1.4.1.5597.7.2.3.1.1.7.1',
  antennaState:     '1.3.6.1.4.1.5597.7.2.3.1.1.10.1',  // 0=noData 1=connected 2=disconnected 3=shortCircuit
  oscillatorState:  '1.3.6.1.4.1.5597.7.2.3.1.1.11.1',  // -1=noData 0=notAdjusted 1=adjusted
};

// OID used to distinguish NG from Meinberg OS (RX801)
const NG_PROBE_OID = '1.3.6.1.4.1.5597.30.0.0.2.0';

// Meinberg OS receiver state → substate string (maps to NG substate label convention)
const RX801_RECEIVER_STATE = {
  0: 'notAvailable',
  1: 'gpsTracking',
  2: 'gpsColdBoot',
  3: 'gpsWarmBoot',
  4: 'gpsSync',
};

// Meinberg OS antenna state
const RX801_ANTENNA_STATE = {
  0: 'noData', 1: 'connected', 2: 'disconnected', 3: 'shortCircuit',
};

// ── Enum maps (LANTIME NG) ───────────────────────────────────────────────────

const REFCLOCK_STATE = {
  0: 'notAvailable', 1: 'synchronized', 2: 'notSynchronized',
};

const REFCLOCK_SUBSTATE = {
  '-1': 'mrsRefNone', 0: 'notAvailable', 1: 'gpsSync', 2: 'gpsTracking',
  3: 'gpsAntennaDisconnected', 4: 'gpsWarmBoot', 5: 'gpsColdBoot',
  6: 'gpsAntennaShortCircuit', 50: 'lwNeverSync', 51: 'lwNotSync', 52: 'lwSync',
  100: 'tcrNotSync', 101: 'tcrSync', 149: 'mrsIntOscSync', 150: 'mrsGpsSync',
  151: 'mrs10MhzSync', 152: 'mrsPpsInSync', 153: 'mrs10MhzPpsInSync',
  154: 'mrsIrigSync', 155: 'mrsNtpSync', 156: 'mrsPtpIeee1588Sync',
  157: 'mrsPtpOverE1Sync', 158: 'mrsFixedFreqInSync', 159: 'mrsPpsStringSync',
  160: 'mrsVarFreqGpioSync', 161: 'mrsReserved', 162: 'mrsDcf77PzfSync',
  163: 'mrsLongwaveSync', 164: 'mrsGlonassGpsSync', 165: 'mrsHavequickSync',
  166: 'mrsExtOscSync', 167: 'mrsSyncE', 168: 'mrsVideoInSync',
  169: 'mrsLtcSync', 170: 'mrsOscSync',
};

const REFCLOCK_USAGE = {
  0: 'notAvailable', 1: 'secondary', 2: 'compare', 3: 'primary',
};

const NTP_STATE = {
  0: 'notAvailable', 1: 'notSynchronized', 2: 'synchronized',
};

// ── SNMP helpers ─────────────────────────────────────────────────────────────

// net-snmp returns DisplayString values as Buffers
function str(val) {
  return Buffer.isBuffer(val) ? val.toString() : String(val);
}

function snmpGet(host, oidMap) {
  return new Promise((resolve, reject) => {
    const session = snmp.createSession(host, SNMP_COMMUNITY, { version: snmp.Version2c });
    const oids = Object.values(oidMap);
    session.get(oids, (error, varbinds) => {
      session.close();
      if (error) return reject(error);
      const result = {};
      Object.keys(oidMap).forEach((key, i) => {
        if (snmp.isVarbindError(varbinds[i])) {
          // leave key absent so callers can detect missing data
        } else {
          result[key] = varbinds[i].value;
        }
      });
      resolve(result);
    });
  });
}

// Parse altitude in metres from position string, e.g. "...Alt.: 42m"
function parseAltitude(posStr) {
  const m = str(posStr).match(/Alt\.: (-?\d+)m/);
  return m ? parseInt(m[1]) : null;
}

// ── Model auto-detection ─────────────────────────────────────────────────────

const modelCache = {};

async function detectModel(host) {
  if (modelCache[host]) return modelCache[host];
  try {
    const result = await snmpGet(host, { probe: NG_PROBE_OID });
    if ('probe' in result) {
      modelCache[host] = 'lantime-ng';
    } else {
      modelCache[host] = 'rx801';
    }
  } catch {
    modelCache[host] = 'rx801';
  }
  console.log(`[${host}] detected model: ${modelCache[host]}`);
  return modelCache[host];
}

// ── Prometheus metrics ────────────────────────────────────────────────────────

function createMetrics(register) {
  const g = (name, help, labelNames) =>
    new client.Gauge({ name, help, labelNames, registers: [register] });

  return {
    uptime:          g('meinberg_uptime_seconds',          'System uptime in seconds',                                          ['host', 'model']),
    refclockState:   g('meinberg_refclock_state',          'Refclock state: 1=synchronized 2=notSynchronized 0=notAvailable',   ['host', 'model', 'state', 'substate', 'usage']),
    goodSatellites:  g('meinberg_gps_satellites_good',     'Good GPS satellites in view',                                       ['host', 'model']),
    totalSatellites: g('meinberg_gps_satellites_visible',  'Total GPS satellites in view',                                      ['host', 'model']),
    gpsAltitude:     g('meinberg_gps_altitude_meters',     'GPS antenna altitude in metres',                                    ['host', 'model']),
    gpsTdop:         g('meinberg_gps_tdop',                'GPS timing dilution of precision (LANTIME NG only)',                ['host', 'model']),
    gpsPdop:         g('meinberg_gps_pdop',                'GPS positional dilution of precision (LANTIME NG only)',            ['host', 'model']),
    gpsUtcOffset:    g('meinberg_gps_utc_offset_seconds',  'GPS UTC offset in seconds / leap second count (LANTIME NG only)',   ['host', 'model']),
    ntpState:        g('meinberg_ntp_state',               'NTP state: 2=synchronized 1=notSynchronized 0=notAvailable',       ['host', 'model', 'state']),
    ntpStratum:      g('meinberg_ntp_stratum',             'NTP stratum level (LANTIME NG only)',                               ['host', 'model']),
    ntpOffset:       g('meinberg_ntp_offset_milliseconds', 'NTP time offset in milliseconds (LANTIME NG only)',                 ['host', 'model']),
  };
}

// ── Per-model poll functions ──────────────────────────────────────────────────

async function pollLantimeNg(host, metrics) {
  const data = await snmpGet(host, OIDS_NG);
  const labels = { host, model: 'lantime-ng' };

  const stateVal    = data.refclockState    ?? 0;
  const substateVal = data.refclockSubstate ?? 0;
  const usageVal    = data.refclockUsage    ?? 0;
  const ntpStateVal = data.ntpState         ?? 0;

  const stateStr    = REFCLOCK_STATE[stateVal]       ?? String(stateVal);
  const substateStr = REFCLOCK_SUBSTATE[substateVal] ?? String(substateVal);
  const usageStr    = REFCLOCK_USAGE[usageVal]       ?? String(usageVal);
  const ntpStateStr = NTP_STATE[ntpStateVal]         ?? String(ntpStateVal);

  metrics.uptime.set(labels, (data.sysUpTime ?? 0) / 100);
  metrics.refclockState.set({ ...labels, state: stateStr, substate: substateStr, usage: usageStr }, stateVal);
  metrics.goodSatellites.set(labels, data.goodSatellites  ?? 0);
  metrics.totalSatellites.set(labels, data.totalSatellites ?? 0);
  metrics.gpsAltitude.set(labels, data.gpsAltitude        ?? 0);
  metrics.gpsTdop.set(labels, parseFloat(str(data.gpsTdop)) || 0);
  metrics.gpsPdop.set(labels, parseFloat(str(data.gpsPdop)) || 0);
  metrics.gpsUtcOffset.set(labels, data.gpsUtcOffset       ?? 0);
  metrics.ntpState.set({ ...labels, state: ntpStateStr }, ntpStateVal);
  metrics.ntpStratum.set(labels, data.ntpStratum ?? 0);
  metrics.ntpOffset.set(labels, parseFloat(str(data.ntpOffset)) || 0);

  console.log(`[${host}] lantime-ng state=${stateStr} substate=${substateStr} satellites=${data.goodSatellites ?? '?'}/${data.totalSatellites ?? '?'} stratum=${data.ntpStratum ?? '?'}`);
}

async function pollRx801(host, metrics) {
  const data = await snmpGet(host, OIDS_RX801);
  const labels = { host, model: 'rx801' };

  // Receiver state: 4=synchronized, 0=noData, 1=waitingForData, 2=coldBoot, 3=warmBoot
  const receiverStateRaw = data.receiverState ?? 0;
  const stateVal         = receiverStateRaw === 4 ? 1 : (receiverStateRaw === 0 ? 0 : 2);
  const stateStr         = REFCLOCK_STATE[stateVal] ?? String(stateVal);

  // Use antenna disconnected/short as substate if not connected, else use receiver state
  const antennaRaw  = data.antennaState ?? 0;
  const substateStr = antennaRaw >= 2
    ? RX801_ANTENNA_STATE[antennaRaw]               // disconnected / shortCircuit
    : (RX801_RECEIVER_STATE[receiverStateRaw] ?? String(receiverStateRaw));

  // NTP state: MIB uses 0=init 1=sync 2=notSync 3=stopped → remap to NG scale (1=sync 2=notSync 0=notAvail)
  const ntpRaw      = data.ntpState ?? 0;
  const ntpStateVal = ntpRaw === 1 ? 2 : (ntpRaw === 2 ? 1 : 0);
  const ntpStateStr = NTP_STATE[ntpStateVal] ?? String(ntpStateVal);

  // NTP refclock offset is in nanoseconds; metric is in milliseconds
  const ntpOffsetMs = (data.ntpRefclkOffset ?? 0) / 1_000_000;

  const altitude = data.gpsPosition ? parseAltitude(data.gpsPosition) : null;

  metrics.uptime.set(labels, (data.sysUpTime ?? 0) / 100);
  metrics.refclockState.set({ ...labels, state: stateStr, substate: substateStr, usage: 'primary' }, stateVal);
  metrics.goodSatellites.set(labels, data.goodSatellites   ?? 0);
  metrics.totalSatellites.set(labels, data.totalSatellites  ?? 0);
  if (altitude !== null) metrics.gpsAltitude.set(labels, altitude);
  metrics.ntpState.set({ ...labels, state: ntpStateStr }, ntpStateVal);
  metrics.ntpStratum.set(labels, data.ntpStratum           ?? 0);
  metrics.ntpOffset.set(labels, ntpOffsetMs);
  // TDOP, PDOP, GPS UTC offset not exposed in Meinberg OS MIB

  console.log(`[${host}] rx801 state=${stateStr} substate=${substateStr} antenna=${RX801_ANTENNA_STATE[antennaRaw] ?? antennaRaw} satellites=${data.goodSatellites ?? '?'}/${data.totalSatellites ?? '?'} stratum=${data.ntpStratum ?? '?'} offset=${ntpOffsetMs.toFixed(4)}ms alt=${altitude ?? '?'}m`);
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollHost(host, metrics) {
  const model = await detectModel(host);
  if (model === 'lantime-ng') {
    await pollLantimeNg(host, metrics);
  } else {
    await pollRx801(host, metrics);
  }
}

async function poll() {
  // Fresh registry each cycle — prevents stale label combinations in Pushgateway
  const register = new client.Registry();
  const metrics = createMetrics(register);

  const results = await Promise.allSettled(CLOCK_HOSTS.map(host => pollHost(host, metrics)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[${CLOCK_HOSTS[i]}] poll failed:`, r.reason.message);
    }
  });

  const gateway = new client.Pushgateway(PUSHGATEWAY_URL, [], register);
  try {
    // push (not pushAdd) replaces all metrics for this job — no stale series
    await gateway.push({ jobName: 'meinberg_clock' });
    console.log('Metrics pushed at', new Date().toISOString());
  } catch (err) {
    console.error('Pushgateway push failed:', err.message);
  }
}

poll();
setInterval(poll, POLL_INTERVAL);

process.on('SIGINT', () => {
  console.log('Shutting down');
  process.exit(0);
});
