import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { setupMap } from './ui/map.js';
import { renderResults } from './ui/panel.js';
import { bboxAreaKm2 } from './data/geo.js';

const $ = (id) => document.getElementById(id);
const MAX_AREA_KM2 = 30;

const worker = new Worker(new URL('./analysis/worker.js', import.meta.url), { type: 'module' });

let lastResult = null;
let panelCtl = null;
let selectedRank = null;
let running = false;
let airspaceVisible = true;

const map = setupMap((box) => {
  $('analyze-btn').disabled = false;
  $('clear-btn').hidden = false;
  const area = bboxAreaKm2(box);
  $('draw-hint').textContent =
    area > MAX_AREA_KM2
      ? `Heads up: ~${area.toFixed(0)} km2 is large. Analysis is capped at ${MAX_AREA_KM2} km2 and may be coarse. Draw a smaller area for detail.`
      : `Area ~${area.toFixed(1)} km2. Ready - press "Find best launch spots".`;
  endDrawUi();
});

const DEFAULT_HINT = 'Tap "Draw flight area", then drag a box across your ground.';
let drawingMode = false;

function endDrawUi() {
  drawingMode = false;
  document.body.classList.remove('drawing');
  $('draw-btn').classList.remove('active');
  $('draw-btn').textContent = 'Draw flight area';
}

// ---- search ----
async function doSearch() {
  const q = $('search').value.trim();
  if (!q) return;
  $('search-btn').textContent = '...';
  const ok = await map.geocode(q);
  $('search-btn').textContent = 'Go';
  if (!ok) $('draw-hint').textContent = 'Could not find that place. Try lat,lng or a more specific name.';
}
$('search-btn').addEventListener('click', doSearch);
$('search').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

// ---- draw (toggle: tap again to cancel) ----
$('draw-btn').addEventListener('click', () => {
  if (drawingMode) {
    map.cancelDraw();
    endDrawUi();
    $('draw-hint').textContent = DEFAULT_HINT;
    return;
  }
  map.beginDraw();
  drawingMode = true;
  document.body.classList.add('drawing'); // collapses the sidebar on mobile for room
  $('draw-btn').classList.add('active');
  $('draw-btn').textContent = 'Cancel drawing';
  $('draw-hint').textContent = 'Drag a box across your ground - press and drag on the map (touch works).';
});
$('clear-btn').addEventListener('click', () => {
  map.clearAll();
  endDrawUi();
  lastResult = null; selectedRank = null;
  $('results').innerHTML = '';
  $('analyze-btn').disabled = true;
  $('clear-btn').hidden = true;
  $('toggle-airspace').hidden = true;
  $('draw-hint').textContent = DEFAULT_HINT;
});

// ---- airspace overlay toggle ----
$('toggle-airspace').addEventListener('click', () => {
  airspaceVisible = !airspaceVisible;
  map.toggleCeiling(airspaceVisible);
  $('toggle-airspace').textContent = airspaceVisible ? 'Hide airspace ceilings' : 'Show airspace ceilings';
});

// ---- analyze ----
function readUi() {
  return {
    pilotMode: $('pilot-mode').value,
    maxRange: Number($('range').value),
    antennaHeight: Number($('antenna').value),
    droneAGL: Number($('drone-agl').value),
    signalThruTrees: $('thru-trees').checked,
    weights: {
      los: +$('w-los').value, ceiling: +$('w-ceiling').value, launch: +$('w-launch').value,
      prom: +$('w-prom').value, clearance: +$('w-clearance').value, airspace: +$('w-airspace').value,
    },
  };
}

function runAnalysis(box) {
  if (!box || running) return;
  running = true;
  $('analyze-btn').disabled = true;
  $('progress').hidden = false;
  setProgress(0.02, 'Starting...');
  // reflect the area in a shareable URL
  const u = new URL(location.href);
  u.searchParams.set('bbox', [box.west, box.south, box.east, box.north].map((v) => v.toFixed(5)).join(','));
  history.replaceState(null, '', u);
  worker.postMessage({ bbox: box, ui: readUi() });
}

$('analyze-btn').addEventListener('click', () => runAnalysis(map.getBox()));

function setProgress(pct, label) {
  $('progress-fill').style.width = `${Math.round(pct * 100)}%`;
  $('progress-label').textContent = label || '';
}

worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'progress') {
    setProgress(msg.pct, msg.label);
  } else if (msg.type === 'result') {
    running = false;
    $('analyze-btn').disabled = false;
    setTimeout(() => { $('progress').hidden = true; }, 400);
    lastResult = msg.result;
    map.showHeatmap(lastResult);
    map.showCeiling(lastResult);
    airspaceVisible = true;
    map.toggleCeiling(true);
    $('toggle-airspace').hidden = !(lastResult.airspace && lastResult.airspace.ok);
    $('toggle-airspace').textContent = 'Hide airspace ceilings';
    map.addMarkers(lastResult.spots, selectSpot);
    panelCtl = renderResults($('results'), lastResult.spots, {
      onSelect: selectSpot,
      onView3d: open3d,
    });
    if (lastResult.spots.length) selectSpot(1);
  } else if (msg.type === 'error') {
    running = false;
    $('analyze-btn').disabled = false;
    $('progress').hidden = true;
    $('draw-hint').textContent = `Analysis failed: ${msg.message}. Try again or a different area.`;
  }
};

function selectSpot(rank) {
  if (!lastResult) return;
  const spot = lastResult.spots.find((s) => s.rank === rank);
  if (!spot) return;
  selectedRank = rank;
  panelCtl?.select(rank);
  map.showFootprint(lastResult, spot);
  map.flyToSpot(spot);
}

// ---- 3D viewer ----
let view3dMod = null;
async function open3d(rank) {
  if (!lastResult) return;
  const spot = lastResult.spots.find((s) => s.rank === rank);
  if (!spot) return;
  $('viewer').hidden = false;
  $('viewer-title').textContent = `3D coverage view - Launch ${rank}`;
  view3dMod = view3dMod || await import('./scene/view3d.js');
  // give the canvas a frame to lay out before sizing the renderer
  requestAnimationFrame(() => view3dMod.openViewer($('viewer-canvas'), lastResult, spot));
}
$('viewer-close').addEventListener('click', () => {
  $('viewer').hidden = true;
  view3dMod?.disposeViewer();
});

// ---- shareable / deep-link box: ?bbox=west,south,east,north ----
(function initFromUrl() {
  const raw = new URL(location.href).searchParams.get('bbox');
  if (!raw) return;
  const p = raw.split(',').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return;
  const box = { west: p[0], south: p[1], east: p[2], north: p[3] };
  let fired = false;
  const start = () => {
    if (fired) return;
    fired = true;
    map.setBox(box);
    $('analyze-btn').disabled = false;
    $('clear-btn').hidden = false;
    runAnalysis(box);
  };
  // run once the map has loaded so fitBounds + overlays apply cleanly
  if (map.map.loaded()) start();
  else map.map.once('load', start);
})();
