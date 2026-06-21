// Vercel serverless function (and Vite dev middleware) that proxies FAA airspace.
//
// Why a proxy: the analysis worker rasterizes FAA UAS Facility Map ceiling
// polygons onto the parcel grid. The upstream ArcGIS FeatureServer is keyless
// but not CORS-open for arbitrary browser origins, so we fetch it server-side,
// add `Access-Control-Allow-Origin`, trim the payload to what the client needs,
// and edge-cache the result.
//
//   GET /api/airspace?w=<west>&s=<south>&e=<east>&n=<north>   (degrees, EPSG:4326)
//
// Returns: { ok, ceilingFeatures: <GeoJSON FeatureCollection>, airports: [...] }
//
// Upstream (keyless, no token - verified live):
//   FAA UAS Facility Map data, public hosted FeatureServer in the FAA ArcGIS org.
//   Each feature is a small quad polygon carrying CEILING (feet AGL): values like
//   400/300/200/100/50, and 0 = controlled airspace where LAANC is not available.
//   Also carries APT1_NAME / APT1_ICAO / APT1_LAANC / LATITUDE for nearby airports.
//   There is no separate keyless airports service we can rely on, so airport
//   points are derived from these features (grouped by ICAO) below.

const UASFM =
  'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/' +
  'FAA_UAS_FacilityMap_Data_V5/FeatureServer/0/query';

const OUT_FIELDS = 'CEILING,APT1_NAME,APT1_ICAO,APT1_LAANC,LATITUDE,LONGITUDE';
const MAX_RECORDS = 4000; // plenty for a single parcel; guards against huge bboxes

function buildQuery(w, s, e, n) {
  const envelope = `${w},${s},${e},${n}`;
  const q = new URLSearchParams({
    where: '1=1',
    geometry: envelope,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: OUT_FIELDS,
    returnGeometry: 'true',
    f: 'geojson',
    resultRecordCount: String(MAX_RECORDS),
  });
  return `${UASFM}?${q.toString()}`;
}

// Mean longitude of a ceiling feature's outer ring, used to place an airport pin.
function ringMeanLon(geometry) {
  if (!geometry) return null;
  const polys =
    geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  let sum = 0, n = 0;
  for (const poly of polys) {
    const ring = poly && poly[0];
    if (!ring) continue;
    for (const pt of ring) { sum += pt[0]; n++; }
  }
  return n ? sum / n : null;
}

// Derive a small list of airport pins from the ceiling features. The UASFM
// LATITUDE field is the airport reference latitude (constant per airport); the
// longitude is recovered as the centroid of that airport's cells.
function deriveAirports(features) {
  const byApt = new Map();
  for (const f of features) {
    const p = f.properties || {};
    const name = p.APT1_NAME;
    if (!name) continue;
    const key = p.APT1_ICAO || name;
    const lon = ringMeanLon(f.geometry);
    const lat = Number(p.LATITUDE);
    if (lon == null || !Number.isFinite(lat)) continue;
    let a = byApt.get(key);
    if (!a) {
      a = { name, icao: p.APT1_ICAO || null, lat, lonSum: 0, lonN: 0 };
      byApt.set(key, a);
    }
    a.lonSum += lon; a.lonN++;
  }
  const out = [];
  for (const a of byApt.values()) {
    out.push({ name: a.name, icao: a.icao, lon: a.lonSum / a.lonN, lat: a.lat, kind: 'airport' });
  }
  return out.slice(0, 40);
}

export async function proxyAirspace(reqUrl, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  let params;
  try {
    params = new URL(reqUrl, 'http://localhost').searchParams;
  } catch {
    res.statusCode = 400;
    res.end('bad url');
    return;
  }

  const w = Number(params.get('w'));
  const s = Number(params.get('s'));
  const e = Number(params.get('e'));
  const n = Number(params.get('n'));

  if (![w, s, e, n].every(Number.isFinite) || w >= e || s >= n) {
    res.statusCode = 400;
    res.end('expected ?w&s&e&n (degrees) with w<e and s<n');
    return;
  }

  try {
    const upstream = await fetch(buildQuery(w, s, e, n), {
      headers: { 'User-Agent': 'drone-vantage (github.com/lperezmo/drone-vantage)' },
    });

    // Degrade gracefully on any upstream trouble: 200 with ok:false so the
    // client treats the whole parcel as uncontrolled Class G and keeps running.
    if (!upstream.ok) {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: false, reason: `upstream ${upstream.status}` }));
      return;
    }

    const fc = await upstream.json();
    const features = Array.isArray(fc?.features) ? fc.features : [];
    const airports = deriveAirports(features);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: true,
      ceilingFeatures: { type: 'FeatureCollection', features },
      airports,
    }));
  } catch (err) {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: false, reason: err?.message || 'unknown' }));
  }
}

export default function handler(req, res) {
  return proxyAirspace(req.url, res);
}
