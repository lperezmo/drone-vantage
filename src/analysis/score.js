// Vantage scoring: turn a built parcel (with the airspace ceiling grid merged
// in) into a ranked set of best drone launch / pilot positions plus a score
// raster for the heatmap. Combines the drone line-of-sight viewshed with the
// legal ceiling, takeoff suitability, local prominence, obstruction clearance,
// and a controlled-airspace safety margin.

import { observeScore, observeFootprint } from './viewshed.js';

const TREE_HEIGHT = 16; // metres of mature canopy

// Effective sight/signal-blocking canopy height for a tree-density 0..1.
// Density-gated so open ground and sparse/scattered cover stay see-through,
// while only closed canopy walls off the line-of-sight.
function effectiveCanopy(density) {
  const t = Math.max(0, Math.min(1, (density - 0.25) / 0.55));
  return t * t * TREE_HEIGHT;
}

// Map a raw airspace ceiling grid value to a usable ceiling in feet:
//   -1 -> 400 (uncontrolled Class G default), 0 -> 0 (no LAANC, controlled no-go),
//   >0 -> the LAANC grid ceiling.
function usableCeiling(v) {
  if (v === -1) return 400;
  if (v <= 0) return 0;
  return v;
}

// Build the derived layers the scorer needs (occlusion surface, summed-area
// table for fast local prominence). The occluder includes canopy only when the
// signal is treated as line-of-sight (FPV through trees blocks it).
function deriveLayers(parcel, signalThruTrees) {
  const { gridW, gridH, heights, forest } = parcel;
  const n = gridW * gridH;
  const zc = new Float32Array(n);

  if (signalThruTrees) {
    for (let i = 0; i < n; i++) zc[i] = heights[i] + effectiveCanopy(forest[i] / 255);
  } else {
    for (let i = 0; i < n; i++) zc[i] = heights[i];
  }

  // summed-area table of heights for O(1) local mean (prominence)
  const sat = new Float64Array((gridW + 1) * (gridH + 1));
  const sw = gridW + 1;
  for (let r = 0; r < gridH; r++) {
    let rowSum = 0;
    for (let c = 0; c < gridW; c++) {
      rowSum += heights[r * gridW + c];
      sat[(r + 1) * sw + (c + 1)] = sat[r * sw + (c + 1)] + rowSum;
    }
  }
  const localMean = (c, r, rad) => {
    const c0 = Math.max(0, c - rad), c1 = Math.min(gridW - 1, c + rad);
    const r0 = Math.max(0, r - rad), r1 = Math.min(gridH - 1, r + rad);
    const area = (c1 - c0 + 1) * (r1 - r0 + 1);
    const s = sat[(r1 + 1) * sw + (c1 + 1)] - sat[r0 * sw + (c1 + 1)] - sat[(r1 + 1) * sw + c0] + sat[r0 * sw + c0];
    return s / area;
  };

  return { zc, localMean };
}

function normalize(arr) {
  let min = Infinity, max = -Infinity;
  for (const v of arr) { if (v < min) min = v; if (v > max) max = v; }
  const span = max - min || 1;
  return (v) => (v - min) / span;
}

// Local terrain slope (degrees) at a grid cell, for takeoff suitability.
function slopeDegAt(heights, gridW, gridH, c, r, mpp) {
  const cl = Math.max(c - 1, 0), cr = Math.min(c + 1, gridW - 1);
  const ru = Math.max(r - 1, 0), rd = Math.min(r + 1, gridH - 1);
  const dx = (heights[r * gridW + cr] - heights[r * gridW + cl]) / ((cr - cl) * mpp);
  const dz = (heights[rd * gridW + c] - heights[ru * gridW + c]) / ((rd - ru) * mpp);
  return (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
}

// Mean canopy density (0..1) in a small box around a launch cell, for clearance.
function localCanopy(forest, gridW, gridH, c, r, rad) {
  const c0 = Math.max(0, c - rad), c1 = Math.min(gridW - 1, c + rad);
  const r0 = Math.max(0, r - rad), r1 = Math.min(gridH - 1, r + rad);
  let sum = 0, n = 0;
  for (let rr = r0; rr <= r1; rr++) {
    for (let cc = c0; cc <= c1; cc++) { sum += forest[rr * gridW + cc]; n++; }
  }
  return n ? sum / n / 255 : 0;
}

export function analyze(parcel, ui) {
  const { gridW, gridH, heights, forest, metersPerPx, bbox } = parcel;
  const ceiling = parcel.ceiling;       // Int16Array merged in by the worker
  const airspace = parcel.airspace || { airports: [], ok: false };
  const signalThruTrees = !!ui.signalThruTrees;
  const { zc, localMean } = deriveLayers(parcel, signalThruTrees);
  const g = { gridW, gridH, heights, zc, metersPerPx };

  // weights (UI gives 0..100; renormalise to sum 1)
  const wRaw = ui.weights;
  const wSum = Object.values(wRaw).reduce((a, b) => a + b, 0) || 1;
  const w = {};
  for (const k in wRaw) w[k] = wRaw[k] / wSum;

  const p = {
    antennaHeight: ui.antennaHeight,
    droneAGL: ui.droneAGL,
    maxRange: ui.maxRange,
    rays: 96,
  };

  // candidate grid (subsampled to keep the work bounded)
  const stride = Math.max(1, Math.round(Math.sqrt((gridW * gridH) / 2600)));
  const cgW = Math.floor((gridW - 1) / stride) + 1;
  const cgH = Math.floor((gridH - 1) / stride) + 1;
  const promRad = Math.min(60, Math.max(6, Math.round(280 / metersPerPx)));
  const clearRad = Math.min(8, Math.max(2, Math.round(40 / metersPerPx)));

  // distance (m) from each candidate to the nearest airport, for the airspace margin
  const airportM = (ox, oy) => {
    if (!airspace.airports || !airspace.airports.length) return Infinity;
    const clon = bbox.west + (gridW <= 1 ? 0 : (ox / (gridW - 1)) * (bbox.east - bbox.west));
    const clat = bbox.north + (gridH <= 1 ? 0 : (oy / (gridH - 1)) * (bbox.south - bbox.north));
    const mPerDegLat = 111_320;
    const mPerDegLon = 111_320 * Math.cos((clat * Math.PI) / 180);
    let best = Infinity;
    for (const a of airspace.airports) {
      const dx = (a.lon - clon) * mPerDegLon;
      const dy = (a.lat - clat) * mPerDegLat;
      const d = Math.hypot(dx, dy);
      if (d < best) best = d;
    }
    return best;
  };

  const losA = new Float32Array(cgW * cgH);
  const ceilA = new Float32Array(cgW * cgH);
  const launchA = new Float32Array(cgW * cgH);
  const promA = new Float32Array(cgW * cgH);
  const clearA = new Float32Array(cgW * cgH);
  const airA = new Float32Array(cgW * cgH);

  for (let cy = 0; cy < cgH; cy++) {
    for (let cx = 0; cx < cgW; cx++) {
      const ox = Math.min(cx * stride, gridW - 1);
      const oy = Math.min(cy * stride, gridH - 1);
      const i = oy * gridW + ox;
      const ci = cy * cgW + cx;

      const o = observeScore(g, ox, oy, p);
      losA[ci] = o.visArea;

      // ceiling: usable legal ceiling at the launch cell (more vertical room).
      // -1 -> 400, 0 -> 0 (bad). Normalised across candidates below.
      const cv = ceiling ? usableCeiling(ceiling[i]) : 400;
      ceilA[ci] = cv;

      // launch: open low-slope ground + low canopy for safe takeoff + GPS lock
      const slope = slopeDegAt(heights, gridW, gridH, ox, oy, metersPerPx);
      const slopeOk = Math.max(0, Math.min(1, (18 - slope) / 18));
      const canopyOpen = 1 - Math.min(1, forest[i] / 255);
      launchA[ci] = 0.55 * slopeOk + 0.45 * canopyOpen;

      // prominence: high ground for a clean antenna sightline
      promA[ci] = heights[i] - localMean(ox, oy, promRad);

      // clearance: low surrounding canopy / no tall immediate occluders
      clearA[ci] = 1 - Math.min(1, localCanopy(forest, gridW, gridH, ox, oy, clearRad) * 1.3);

      // airspace: 0 ceiling is a controlled no-go; penalise proximity to airports.
      // neutral 0.5 everywhere if upstream airspace failed.
      if (!airspace.ok) {
        airA[ci] = 0.5;
      } else {
        let a = cv <= 0 ? 0 : 1;
        const dM = airportM(ox, oy);
        if (dM < 1500) a *= Math.max(0, dM / 1500);
        airA[ci] = a;
      }
    }
  }

  const nLos = normalize(losA), nCeil = normalize(ceilA), nProm = normalize(promA);
  const score = new Float32Array(cgW * cgH);
  for (let i = 0; i < score.length; i++) {
    score[i] =
      w.los * nLos(losA[i]) +
      w.ceiling * nCeil(ceilA[i]) +
      w.launch * launchA[i] +
      w.prom * nProm(promA[i]) +
      w.clearance * clearA[i] +
      w.airspace * airA[i];
  }

  // non-maximum suppression -> distinct top spots
  const spacing = Math.max(2, Math.round(160 / metersPerPx / stride));
  const order = Array.from(score.keys()).sort((a, b) => score[b] - score[a]);
  const picked = [];
  const taken = new Uint8Array(cgW * cgH);
  for (const idx of order) {
    if (picked.length >= 6) break;
    const cx = idx % cgW, cy = (idx / cgW) | 0;
    if (taken[idx]) continue;
    picked.push({ cx, cy, idx, s: score[idx] });
    for (let dy = -spacing; dy <= spacing; dy++) {
      for (let dx = -spacing; dx <= spacing; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && ny >= 0 && nx < cgW && ny < cgH) taken[ny * cgW + nx] = 1;
      }
    }
  }

  // detail pass on the winners: footprint + reasons
  const lon = (col) => bbox.west + (gridW <= 1 ? 0 : (col / (gridW - 1)) * (bbox.east - bbox.west));
  const lat = (row) => bbox.north + (gridH <= 1 ? 0 : (row / (gridH - 1)) * (bbox.south - bbox.north));
  const sMin = picked.length ? picked[picked.length - 1].s : 0;
  const sMax = picked.length ? picked[0].s : 1;

  const spots = picked.map((pk, rank) => {
    const ox = Math.min(pk.cx * stride, gridW - 1);
    const oy = Math.min(pk.cy * stride, gridH - 1);
    const i = oy * gridW + ox;
    const fp = observeFootprint(g, ox, oy, p);
    const prom = heights[i] - localMean(ox, oy, promRad);
    const coverageAcres = Math.round((fp.seen * metersPerPx * metersPerPx) / 4047);
    const rawCeil = ceiling ? ceiling[i] : -1;
    const ceilingFt = usableCeiling(rawCeil);
    const dM = airportM(ox, oy);

    // why-text contributions, ranked by weighted value
    const contrib = [
      { k: 'los', v: w.los * nLos(losA[pk.idx]), t: `keeps line-of-sight over about ${coverageAcres} acres` },
      { k: 'ceiling', v: w.ceiling * nCeil(ceilA[pk.idx]), t: ceilingFt > 0 ? `ceiling up to ${ceilingFt} ft here` : 'no LAANC ceiling here (controlled airspace)' },
      { k: 'launch', v: w.launch * launchA[pk.idx], t: 'open, level pad for takeoff and GPS lock' },
      { k: 'prom', v: w.prom * nProm(promA[pk.idx]), t: prom > 2 ? `sits ${Math.round(prom)} m above the surrounding ground for a clean signal` : 'reads the terrain well for a clean signal' },
      { k: 'clearance', v: w.clearance * clearA[pk.idx], t: 'clear of tall obstructions around the pad' },
      { k: 'airspace', v: w.airspace * airA[pk.idx], t: dM < 1500 ? 'some standoff from nearby airspace' : 'well clear of controlled airspace' },
    ].filter((x) => x.v > 0).sort((a, b) => b.v - a.v);

    const why = capitalize(contrib.slice(0, 3).map((x) => x.t).join(' · '));
    const rel = sMax > sMin ? (pk.s - sMin) / (sMax - sMin) : 1;
    const rating = Math.round(55 + rel * 44); // 55..99 feel-good score

    return {
      rank: rank + 1,
      lon: lon(ox), lat: lat(oy),
      elevation: Math.round(heights[i]),
      rating,
      why,
      coveragePercent: fp.visiblePercent,
      coverageAcres,
      ceilingFt,
      footprint: fp.vis,
      ox, oy,
    };
  });

  // normalised score raster for the heatmap (0..1)
  const nScore = normalize(score);
  const heat = new Float32Array(score.length);
  for (let i = 0; i < score.length; i++) heat[i] = nScore(score[i]);

  return {
    gridW, gridH, cgW, cgH, stride,
    bbox, metersPerPx,
    heat, spots,
    // raw layers returned so the 3D view + overlay can reuse them
    heights, forest,
    ceiling: ceiling || new Int16Array(gridW * gridH).fill(-1),
    demZoom: parcel.demZoom,
    airspace,
  };
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
