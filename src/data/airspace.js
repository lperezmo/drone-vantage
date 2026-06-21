// FAA airspace layer - rasterizes the UAS Facility Map (LAANC) ceiling grid onto
// the parcel grid and lists nearby airports. Fetched through /api/airspace, which
// proxies the keyless FAA UASFM FeatureServer and adds CORS headers.
//
// Runs inside the analysis Web Worker (fetch + plain JS only, no DOM). Degrades
// gracefully: if the fetch fails the whole parcel is treated as uncontrolled
// Class G (ceiling -1 -> 400 ft default) so the rest of the app still runs.
//
// Ceiling cell values (Int16Array, feet AGL):
//   >0  LAANC grid ceiling (e.g. 400/300/200/100/50)
//    0  controlled airspace, LAANC not available (no-go without a waiver)
//   -1  uncontrolled (Class G) -> 400 ft default applies

const DEFAULT_CEILING = 400;

// Per-cell geo mapping - MUST match build.js / the shared contract exactly so all
// grids align: row 0 = north edge, last row = south edge.
function cellLon(bbox, gridW, col) {
  return gridW <= 1 ? bbox.west : bbox.west + (col / (gridW - 1)) * (bbox.east - bbox.west);
}
function cellLat(bbox, gridH, row) {
  return gridH <= 1 ? bbox.north : bbox.north + (row / (gridH - 1)) * (bbox.south - bbox.north);
}

// Ray-casting point-in-polygon against a single ring [[lon,lat],...].
function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect =
      (yi > lat) !== (yj > lat) &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Point in a GeoJSON Polygon coordinate array: outer ring minus holes.
function pointInPolygon(lon, lat, rings) {
  if (!rings || !rings.length) return false;
  if (!pointInRing(lon, lat, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) {
    if (pointInRing(lon, lat, rings[h])) return false; // inside a hole
  }
  return true;
}

// Point in a GeoJSON geometry (Polygon or MultiPolygon).
function pointInGeometry(lon, lat, geom) {
  if (!geom) return false;
  if (geom.type === 'Polygon') return pointInPolygon(lon, lat, geom.coordinates);
  if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) {
      if (pointInPolygon(lon, lat, poly)) return true;
    }
    return false;
  }
  return false;
}

// Axis-aligned bbox of a geometry's coordinates, for a cheap reject test.
function geometryBounds(geom) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  for (const poly of polys) {
    const ring = poly && poly[0];
    if (!ring) continue;
    for (const pt of ring) {
      if (pt[0] < minX) minX = pt[0];
      if (pt[0] > maxX) maxX = pt[0];
      if (pt[1] < minY) minY = pt[1];
      if (pt[1] > maxY) maxY = pt[1];
    }
  }
  return { minX, minY, maxX, maxY };
}

// Outer ring of a geometry (first polygon for MultiPolygon) for the legend overlay.
function outerRing(geom) {
  if (!geom) return null;
  const poly = geom.type === 'MultiPolygon' ? geom.coordinates[0] : geom.coordinates;
  return poly && poly[0] ? poly[0] : null;
}

// Everything-is-Class-G fallback grid. Used when the upstream fetch fails.
function classGFallback(gridW, gridH) {
  const ceiling = new Int16Array(gridW * gridH).fill(-1);
  return { ceiling, zones: [], airports: [], maxCeiling: DEFAULT_CEILING, minCeiling: DEFAULT_CEILING, ok: false };
}

export async function fetchAirspaceGrid(bbox, gridW, gridH, onProgress = () => {}) {
  onProgress(0.05, 'Fetching airspace…');

  let payload;
  try {
    const url =
      `/api/airspace?w=${bbox.west}&s=${bbox.south}&e=${bbox.east}&n=${bbox.north}`;
    const r = await fetch(url);
    if (!r.ok) return classGFallback(gridW, gridH);
    payload = await r.json();
  } catch {
    return classGFallback(gridW, gridH);
  }

  if (!payload || payload.ok === false) return classGFallback(gridW, gridH);

  const features = payload.ceilingFeatures?.features || [];
  const apiAirports = Array.isArray(payload.airports) ? payload.airports : [];

  // Precompute each feature's ceiling + bounds once.
  const prepared = [];
  for (const f of features) {
    if (!f || !f.geometry) continue;
    const c = Number(f.properties?.CEILING);
    prepared.push({
      geom: f.geometry,
      ceiling: Number.isFinite(c) ? c : 0,
      bounds: geometryBounds(f.geometry),
    });
  }

  onProgress(0.45, 'Rasterizing ceilings…');

  // Rasterize: every cell defaults to -1 (Class G); a hit on a ceiling polygon
  // takes that polygon's CEILING value. When polygons overlap, keep the lower
  // (more restrictive) ceiling so we never overstate the legal altitude.
  const ceiling = new Int16Array(gridW * gridH).fill(-1);
  for (let row = 0; row < gridH; row++) {
    const lat = cellLat(bbox, gridH, row);
    for (let col = 0; col < gridW; col++) {
      const lon = cellLon(bbox, gridW, col);
      let val = -1;
      for (let k = 0; k < prepared.length; k++) {
        const p = prepared[k];
        const b = p.bounds;
        if (lon < b.minX || lon > b.maxX || lat < b.minY || lat > b.maxY) continue;
        if (pointInGeometry(lon, lat, p.geom)) {
          if (val === -1 || p.ceiling < val) val = p.ceiling;
        }
      }
      ceiling[row * gridW + col] = val;
    }
  }

  // min/max over the parcel - ignore -1 (Class G) and 0 (no-LAANC) for the floor
  // when any real grid ceiling is present, per the contract.
  let maxCeiling = -Infinity, minCeiling = Infinity;
  for (let i = 0; i < ceiling.length; i++) {
    const v = ceiling[i];
    const eff = v === -1 ? DEFAULT_CEILING : v;
    if (eff > maxCeiling) maxCeiling = eff;
    if (v > 0 && v < minCeiling) minCeiling = v;
  }
  if (!Number.isFinite(maxCeiling)) maxCeiling = DEFAULT_CEILING;
  if (!Number.isFinite(minCeiling)) minCeiling = maxCeiling;

  onProgress(0.8, 'Summarizing zones…');

  // zones: keep the overlay small. Take a sample of ceiling polygons (prefer the
  // most restrictive / lowest ceilings first) plus one marker per airport.
  const zones = [];
  const ZONE_LIMIT = 40;
  const sorted = prepared
    .filter((p) => outerRing(p.geom))
    .sort((a, b) => a.ceiling - b.ceiling);
  const step = Math.max(1, Math.ceil(sorted.length / ZONE_LIMIT));
  for (let i = 0; i < sorted.length && zones.length < ZONE_LIMIT; i += step) {
    const ring = outerRing(sorted[i].geom).map((pt) => [pt[0], pt[1]]);
    zones.push({ kind: 'ceiling', ceilingFt: sorted[i].ceiling, ring });
  }

  const airports = [];
  for (const a of apiAirports) {
    if (!Number.isFinite(a.lon) || !Number.isFinite(a.lat)) continue;
    airports.push({ name: a.name, lon: a.lon, lat: a.lat, kind: 'airport' });
    zones.push({ kind: 'airport', name: a.name, lon: a.lon, lat: a.lat });
  }

  onProgress(1, 'Airspace ready');

  return {
    ceiling,
    zones,
    airports,
    maxCeiling: Math.round(maxCeiling),
    minCeiling: Math.round(minCeiling),
    ok: true,
  };
}
