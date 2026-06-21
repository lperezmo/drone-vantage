// MapLibre map: satellite basemap, geocode search, rectangle drawing, and the
// result overlays (launch-suitability heatmap + selected-spot LOS footprint +
// FAA airspace-ceiling choropleth + airport markers + pins).

import maplibregl from 'maplibre-gl';

const SAT_STYLE = {
  version: 8,
  sources: {
    sat: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
      maxzoom: 19,
    },
  },
  layers: [{ id: 'sat', type: 'raster', source: 'sat' }],
};

const corners = (b) => [[b.west, b.north], [b.east, b.north], [b.east, b.south], [b.west, b.south]];

// FAA legal AGL ceiling (ft) -> fill color. 0 = controlled, no LAANC (no-go).
function ceilingColor(ft) {
  if (ft >= 400) return '#22c55e';   // green - lots of vertical room
  if (ft >= 300) return '#a3d34a';   // yellow-green
  if (ft >= 200) return '#f5d04a';   // amber-yellow
  if (ft >= 100) return '#f5a623';   // orange
  if (ft >= 50) return '#f57e23';    // deep orange
  return '#ef4444';                  // red - no LAANC / no-go
}

export function setupMap(onBox) {
  const map = new maplibregl.Map({
    container: 'map',
    style: SAT_STYLE,
    center: [-105.5, 40.3],
    zoom: 11,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'bottom-right');

  let drawing = false;
  let startLngLat = null;
  let box = null;
  const markers = [];
  const airportMarkers = [];
  let ceilingLegendEl = null;

  const heatCanvas = document.createElement('canvas');
  const fpCanvas = document.createElement('canvas');

  map.on('load', () => {
    map.addSource('draw', { type: 'geojson', data: emptyFC() });
    map.addLayer({ id: 'draw-fill', type: 'fill', source: 'draw', paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.12 } });
    map.addLayer({ id: 'draw-line', type: 'line', source: 'draw', paint: { 'line-color': '#38bdf8', 'line-width': 2, 'line-dasharray': [2, 1] } });
  });

  function emptyFC() { return { type: 'FeatureCollection', features: [] }; }
  function rectFeature(b) {
    return {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...corners(b), corners(b)[0]]] } }],
    };
  }
  const norm = (a, b) => ({
    west: Math.min(a.lng, b.lng), east: Math.max(a.lng, b.lng),
    south: Math.min(a.lat, b.lat), north: Math.max(a.lat, b.lat),
  });

  // ---- rectangle drawing (Pointer Events: works for mouse AND touch) ----
  const canvasEl = map.getCanvas();
  let startPt = null;        // {x, y} pixel of the first corner
  let drawPointerId = null;

  function beginDraw() {
    drawing = true;
    canvasEl.style.cursor = 'crosshair';
    canvasEl.style.touchAction = 'none'; // stop the page panning/zooming under the finger
    map.dragPan.disable();
    map.touchZoomRotate.disable();
    map.dragRotate.disable();
    map.doubleClickZoom.disable();
  }
  function cancelDraw() {
    drawing = false;
    canvasEl.style.cursor = '';
    canvasEl.style.touchAction = '';
    startPt = null;
    drawPointerId = null;
    map.dragPan.enable();
    map.touchZoomRotate.enable();
    map.dragRotate.enable();
    map.doubleClickZoom.enable();
  }

  const eventLngLat = (e) => {
    const r = canvasEl.getBoundingClientRect();
    return map.unproject([e.clientX - r.left, e.clientY - r.top]);
  };

  canvasEl.addEventListener('pointerdown', (e) => {
    if (!drawing) return;
    e.preventDefault();
    drawPointerId = e.pointerId;
    startPt = { x: e.clientX, y: e.clientY };
    startLngLat = eventLngLat(e);
    try { canvasEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });

  canvasEl.addEventListener('pointermove', (e) => {
    if (!drawing || !startLngLat || e.pointerId !== drawPointerId) return;
    e.preventDefault();
    map.getSource('draw')?.setData(rectFeature(norm(startLngLat, eventLngLat(e))));
  });

  function finishDraw(e) {
    if (!drawing || !startLngLat) return;
    const moved = startPt ? Math.hypot(e.clientX - startPt.x, e.clientY - startPt.y) : 0;
    // a tap (no real drag) shouldn't create a degenerate box - keep drawing
    if (moved < 12) {
      startLngLat = null;
      map.getSource('draw')?.setData(emptyFC());
      return;
    }
    box = norm(startLngLat, eventLngLat(e));
    cancelDraw();
    map.getSource('draw')?.setData(rectFeature(box));
    onBox(box);
  }
  canvasEl.addEventListener('pointerup', finishDraw);
  canvasEl.addEventListener('pointercancel', () => { startLngLat = null; drawPointerId = null; });

  // ---- overlays ----
  // Run fn once the style is ready (addSource throws otherwise).
  function whenStyle(fn) {
    if (map.isStyleLoaded()) { fn(); return; }
    const h = () => {
      if (map.isStyleLoaded()) { map.off('styledata', h); fn(); }
    };
    map.on('styledata', h);
  }

  // keep the draw box outline above every overlay we add
  function raiseBox() {
    if (map.getLayer('draw-line')) map.moveLayer('draw-line');
  }

  function ensureOverlay(id, canvas, b) {
    if (map.getSource(id)) {
      map.getSource(id).setCoordinates(corners(b));
      map.triggerRepaint();
    } else {
      map.addSource(id, { type: 'canvas', canvas, coordinates: corners(b), animate: false });
      map.addLayer({ id, type: 'raster', source: id, paint: { 'raster-opacity': id === 'heat' ? 0.7 : 0.6, 'raster-resampling': 'linear' } });
    }
  }

  function showHeatmap(result) { whenStyle(() => drawHeatmap(result)); }
  function drawHeatmap(result) {
    const { cgW, cgH, heat } = result;
    heatCanvas.width = cgW; heatCanvas.height = cgH;
    const ctx = heatCanvas.getContext('2d');
    const img = ctx.createImageData(cgW, cgH);
    for (let i = 0; i < heat.length; i++) {
      const [r, g, b] = ramp(heat[i]);
      const a = 40 + heat[i] * 180;
      img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
    ensureOverlay('heat', heatCanvas, result.bbox);
    raiseBox();
  }

  function showFootprint(result, spot) { whenStyle(() => drawFootprint(result, spot)); }
  function drawFootprint(result, spot) {
    const { gridW, gridH } = result;
    fpCanvas.width = gridW; fpCanvas.height = gridH;
    const ctx = fpCanvas.getContext('2d');
    const img = ctx.createImageData(gridW, gridH);
    const fp = spot.footprint;
    for (let i = 0; i < fp.length; i++) {
      // cyan LOS coverage tint
      if (fp[i]) { img.data[i * 4] = 56; img.data[i * 4 + 1] = 211; img.data[i * 4 + 2] = 235; img.data[i * 4 + 3] = 150; }
    }
    ctx.putImageData(img, 0, 0);
    ensureOverlay('fp', fpCanvas, result.bbox);
    raiseBox();
  }

  // ---- FAA airspace ceiling overlay ----
  function showCeiling(result) { whenStyle(() => drawCeiling(result)); }
  function drawCeiling(result) {
    removeCeiling();
    const air = result && result.airspace;
    if (!air || !air.ok || !Array.isArray(air.zones) || !air.zones.length) return;

    const features = [];
    for (const z of air.zones) {
      if (z.kind === 'ceiling' && Array.isArray(z.ring) && z.ring.length >= 3) {
        const ring = [...z.ring];
        const f = ring[0], l = ring[ring.length - 1];
        if (f[0] !== l[0] || f[1] !== l[1]) ring.push(f); // close the ring
        const ft = Number.isFinite(z.ceilingFt) ? z.ceilingFt : 0;
        features.push({
          type: 'Feature',
          properties: { color: ceilingColor(ft), ceilingFt: ft },
          geometry: { type: 'Polygon', coordinates: [ring] },
        });
      }
    }

    if (features.length) {
      map.addSource('ceiling', { type: 'geojson', data: { type: 'FeatureCollection', features } });
      map.addLayer({
        id: 'ceiling-fill', type: 'fill', source: 'ceiling',
        paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.32 },
      });
      map.addLayer({
        id: 'ceiling-line', type: 'line', source: 'ceiling',
        paint: { 'line-color': ['get', 'color'], 'line-width': 1.2, 'line-opacity': 0.8 },
      });
    }

    // airport / heliport symbols
    addAirportMarkers(air);
    ensureCeilingLegend();
    raiseBox();
  }

  function addAirportMarkers(air) {
    clearAirportMarkers();
    const list = (Array.isArray(air.airports) && air.airports.length)
      ? air.airports
      : (air.zones || []).filter((z) => z.kind === 'airport');
    for (const a of list) {
      if (!Number.isFinite(a.lon) || !Number.isFinite(a.lat)) continue;
      const el = document.createElement('div');
      el.className = 'airport-mk';
      el.title = a.name || 'Airport';
      el.textContent = 'A';
      const m = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([a.lon, a.lat]).addTo(map);
      airportMarkers.push(m);
    }
  }

  function ensureCeilingLegend() {
    if (ceilingLegendEl) { ceilingLegendEl.style.display = ''; return; }
    const el = document.createElement('div');
    el.className = 'ceiling-legend';
    el.innerHTML = `
      <span class="cl-title">Legal ceiling (ft AGL)</span>
      <span class="cl-item"><i style="background:#22c55e"></i>400</span>
      <span class="cl-item"><i style="background:#f5d04a"></i>200-300</span>
      <span class="cl-item"><i style="background:#f5a623"></i>50-100</span>
      <span class="cl-item"><i style="background:#ef4444"></i>no LAANC</span>
      <span class="cl-item"><i class="cl-air">A</i>airport</span>`;
    map.getContainer().appendChild(el);
    ceilingLegendEl = el;
  }

  function setCeilingVisibility(visible) {
    const vis = visible ? 'visible' : 'none';
    for (const id of ['ceiling-fill', 'ceiling-line']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    }
    airportMarkers.forEach((m) => { m.getElement().style.display = visible ? '' : 'none'; });
    if (ceilingLegendEl) ceilingLegendEl.style.display = visible ? '' : 'none';
  }

  // robust whether called before or after showCeiling
  function toggleCeiling(visible) { whenStyle(() => setCeilingVisibility(visible)); }

  function clearAirportMarkers() { airportMarkers.forEach((m) => m.remove()); airportMarkers.length = 0; }
  function removeCeiling() {
    for (const id of ['ceiling-fill', 'ceiling-line']) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource('ceiling')) map.removeSource('ceiling');
    clearAirportMarkers();
    if (ceilingLegendEl) { ceilingLegendEl.remove(); ceilingLegendEl = null; }
  }

  function clearMarkers() { markers.forEach((m) => m.remove()); markers.length = 0; }

  function addMarkers(spots, onSelect) {
    clearMarkers();
    spots.forEach((s) => {
      const el = document.createElement('div');
      el.className = 'pin';
      Object.assign(el.style, {
        width: '26px', height: '26px', borderRadius: '50% 50% 50% 0', transform: 'rotate(-45deg)',
        background: '#38bdf8', color: '#08151c', display: 'grid', placeItems: 'center',
        fontWeight: '700', fontSize: '13px', border: '2px solid #08151c', cursor: 'pointer',
        boxShadow: '0 2px 6px rgba(0,0,0,.5)',
      });
      const inner = document.createElement('span');
      inner.textContent = s.rank; inner.style.transform = 'rotate(45deg)';
      el.appendChild(inner);
      el.addEventListener('click', (ev) => { ev.stopPropagation(); onSelect(s.rank); });
      const m = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([s.lon, s.lat]).addTo(map);
      markers.push(m);
    });
  }

  function clearAll() {
    box = null;
    clearMarkers();
    map.getSource('draw')?.setData(emptyFC());
    for (const id of ['heat', 'fp']) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
    removeCeiling();
  }

  async function geocode(q) {
    const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) { const lat = +m[1], lon = +m[2]; map.flyTo({ center: [lon, lat], zoom: 14 }); return true; }
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, {
        headers: { 'Accept-Language': 'en' },
      });
      const data = await r.json();
      if (!data.length) return false;
      const { lat, lon, boundingbox } = data[0];
      if (boundingbox) {
        map.fitBounds([[+boundingbox[2], +boundingbox[0]], [+boundingbox[3], +boundingbox[1]]], { maxZoom: 14, padding: 40 });
      } else {
        map.flyTo({ center: [+lon, +lat], zoom: 14 });
      }
      return true;
    } catch { return false; }
  }

  function setBox(b, { fit = true } = {}) {
    box = b;
    const apply = () => map.getSource('draw')?.setData(rectFeature(b));
    if (map.isStyleLoaded()) apply(); else map.once('load', apply);
    if (fit) map.fitBounds([[b.west, b.south], [b.east, b.north]], { padding: 60, duration: 0 });
  }

  return {
    map, beginDraw, cancelDraw, geocode, setBox,
    showHeatmap, showFootprint, showCeiling, toggleCeiling, addMarkers, clearAll,
    getBox: () => box,
    flyToSpot: (s) => map.flyTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 14.5) }),
  };
}

// score 0..1 -> red(poor) .. amber .. cyan/green(great)
function ramp(t) {
  t = Math.max(0, Math.min(1, t));
  if (t < 0.5) { const u = t / 0.5; return [239, 68 + u * 98, 68 + u * 7]; }   // red -> amber
  const u = (t - 0.5) / 0.5;
  return [237 - u * 203, 166 + u * 45, 75 + u * 160];                          // amber -> cyan/green
}
