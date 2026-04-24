// Shared fake data generator for all mockups
// Simulates a realistic EBC-A40L discharge/charge session

const STATES = ['idle', 'd-cc', 'c-cv', 'complete'];

function createFakeDevice() {
  let state = 'idle';
  let voltage = 3.285;
  let current = 0;
  let capacity = 0;
  let energy = 0;
  let elapsed = 0;
  let mode = null;
  let setpoints = {};
  let tick = 0;
  let pendingCommand = null;
  let pendingTimer = null;
  let listeners = [];
  let cellBarcode = null;
  let cellLabel = null;

  // Fake historical runs for comparison views
  const fakeRuns = [
    { id: 1, cell: 'TS-LFP200AHA 00104F02', label: 'Cell #3', mode: 'd-cc', capacity: 198450, date: '2026-04-20 08:12', duration: '5h 02m' },
    { id: 2, cell: 'TS-LFP200AHA 00104F02', label: 'Cell #3', mode: 'c-cv', capacity: 199100, date: '2026-04-20 14:30', duration: '5h 18m' },
    { id: 3, cell: 'TS-LFP200AHA 00104F05', label: 'Cell #7', mode: 'd-cc', capacity: 187200, date: '2026-04-21 09:00', duration: '4h 41m' },
    { id: 4, cell: 'TS-LFP200AHA 00104F05', label: 'Cell #7', mode: 'd-cc', capacity: 186800, date: '2026-04-21 20:15', duration: '4h 40m' },
    { id: 5, cell: 'TS-LFP200AHA 00104F09', label: 'Cell #11', mode: 'd-cc', capacity: 203100, date: '2026-04-22 07:45', duration: '5h 05m' },
    { id: 6, cell: 'TS-LFP200AHA 00104F01', label: 'Cell #1', mode: 'd-cc', capacity: 195600, date: '2026-04-22 14:00', duration: '4h 53m' },
  ];

  const fakeCells = [
    { barcode: 'TS-LFP200AHA 00104F01', label: 'Cell #1', runs: 2, avgCapacity: 195600, lastTest: '2026-04-22' },
    { barcode: 'TS-LFP200AHA 00104F02', label: 'Cell #3', runs: 4, avgCapacity: 198775, lastTest: '2026-04-20' },
    { barcode: 'TS-LFP200AHA 00104F03', label: 'Cell #4', runs: 1, avgCapacity: 201200, lastTest: '2026-04-19' },
    { barcode: 'TS-LFP200AHA 00104F05', label: 'Cell #7', runs: 3, avgCapacity: 187000, lastTest: '2026-04-21' },
    { barcode: 'TS-LFP200AHA 00104F06', label: null, runs: 0, avgCapacity: null, lastTest: null },
    { barcode: 'TS-LFP200AHA 00104F09', label: 'Cell #11', runs: 2, avgCapacity: 203100, lastTest: '2026-04-22' },
  ];

  function emit(type, data) {
    listeners.forEach(fn => fn(type, data));
  }

  function update() {
    tick++;
    if (state === 'd-cc') {
      elapsed += 2;
      voltage -= 0.0003 + Math.random() * 0.0002;
      current = setpoints.current || 40;
      current += (Math.random() - 0.5) * 0.02;
      capacity += current * (2 / 3600) * 1000;
      const power = voltage * current;
      energy += power * (2 / 3600) * 1000;
      if (voltage <= (setpoints.cutoffV || 2.5)) {
        state = 'complete';
        current = 0;
        emit('stateChange', state);
      }
    } else if (state === 'c-cv') {
      elapsed += 2;
      current = setpoints.current || 40;
      if (voltage >= (setpoints.targetV || 3.65) - 0.05) {
        current *= 0.995;
      }
      current += (Math.random() - 0.5) * 0.02;
      voltage += 0.0002 + Math.random() * 0.0001;
      if (voltage > (setpoints.targetV || 3.65)) voltage = setpoints.targetV || 3.65;
      capacity += current * (2 / 3600) * 1000;
      const power = voltage * current;
      energy += power * (2 / 3600) * 1000;
      if (current <= (setpoints.cutoffCurrent || 2.0)) {
        state = 'complete';
        current = 0;
        emit('stateChange', state);
      }
    } else if (state === 'idle') {
      voltage += (Math.random() - 0.5) * 0.001;
      current = 0;
    }
    emit('reading', {
      state, voltage, current, power: voltage * current,
      capacity, energy, elapsed, mode, setpoints,
      cellBarcode, cellLabel,
    });
  }

  setInterval(update, 2000);

  return {
    getState() { return state; },
    getReading() {
      return { state, voltage, current, power: voltage * current, capacity, energy, elapsed, mode, setpoints, cellBarcode, cellLabel };
    },
    getRuns() { return fakeRuns; },
    getCells() { return fakeCells; },
    startTest(m, sp) {
      mode = m;
      setpoints = sp;
      capacity = 0;
      energy = 0;
      elapsed = 0;
      pendingCommand = 'start';
      emit('commandPending', { command: 'start', mode: m });
      pendingTimer = setTimeout(() => {
        state = m;
        if (m === 'd-cc') voltage = 3.35 + Math.random() * 0.02;
        if (m === 'c-cv') voltage = 2.8 + Math.random() * 0.1;
        pendingCommand = null;
        emit('commandConfirmed', { command: 'start', mode: m });
        emit('stateChange', state);
      }, 800);
    },
    stopTest() {
      pendingCommand = 'stop';
      emit('commandPending', { command: 'stop' });
      pendingTimer = setTimeout(() => {
        state = 'idle';
        mode = null;
        current = 0;
        pendingCommand = null;
        emit('commandConfirmed', { command: 'stop' });
        emit('stateChange', state);
      }, 600);
    },
    scanCell(barcode) {
      cellBarcode = barcode;
      const cell = fakeCells.find(c => c.barcode === barcode);
      cellLabel = cell ? cell.label : null;
      emit('cellScanned', { barcode, label: cellLabel });
    },
    isPending() { return pendingCommand !== null; },
    getPendingCommand() { return pendingCommand; },
    on(fn) { listeners.push(fn); },
  };
}

// Format helpers
function fmtV(v) { return v.toFixed(3) + ' V'; }
function fmtA(a) { return Math.abs(a).toFixed(2) + ' A'; }
function fmtW(w) { return Math.abs(w).toFixed(1) + ' W'; }
function fmtAh(mah) { return (mah / 1000).toFixed(2) + ' Ah'; }
function fmtWh(mwh) { return (mwh / 1000).toFixed(1) + ' Wh'; }
function fmtTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

function stateColor(state) {
  switch(state) {
    case 'idle': return '#888';
    case 'd-cc': case 'd-cp': return '#f59e0b';
    case 'c-cv': return '#3b82f6';
    case 'complete': return '#22c55e';
    default: return '#888';
  }
}

function stateLabel(state) {
  switch(state) {
    case 'idle': return 'Idle';
    case 'd-cc': return 'Discharging (CC)';
    case 'd-cp': return 'Discharging (CP)';
    case 'c-cv': return 'Charging (CV)';
    case 'complete': return 'Complete';
    default: return state;
  }
}
