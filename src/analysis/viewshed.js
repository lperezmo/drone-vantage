// Radial line-of-sight viewshed for a drone flying ABOVE the terrain.
//
// The pilot eye/antenna sits at ground + antennaHeight. The thing we want to keep
// in sight (and in control/video signal range) is the DRONE, flying at
// ground + droneAGL above each cell. A sightline is blocked by the occluder
// surface `zc`: bare terrain always, plus the tree canopy ONLY when the FPV
// signal is treated as line-of-sight (signalThruTrees). Classic R2 sweep: march
// each ray outward tracking the running max elevation angle of the occluders,
// and test the drone-altitude target against it.

const TWO_PI = Math.PI * 2;

// Scalar score of a candidate pilot position. Accumulates, over every cell where
// the drone (at droneAGL) stays visible within range:
//   visArea - near-weighted count (closer flight area is more usable signal)
//   cells - raw covered cell count (for the coverage-% reason string)
export function observeScore(g, ox, oy, p) {
  const { gridW, gridH, heights, zc, metersPerPx } = g;
  const eyeZ = heights[oy * gridW + ox] + p.antennaHeight;
  const rangeCells = p.maxRange / metersPerPx;
  const nRays = p.rays;

  let visArea = 0, cells = 0;

  for (let a = 0; a < nRays; a++) {
    const ang = (a / nRays) * TWO_PI;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    let maxSlope = -Infinity;
    for (let t = 1; t <= rangeCells; t++) {
      const fx = ox + dx * t, fy = oy + dy * t;
      const ix = fx | 0, iy = fy | 0;
      if (ix < 0 || iy < 0 || ix >= gridW || iy >= gridH) break;
      const idx = iy * gridW + ix;
      const dist = t * metersPerPx;
      // target is the drone hovering droneAGL above this cell's ground
      const targetSlope = (heights[idx] + p.droneAGL - eyeZ) / dist;
      if (targetSlope >= maxSlope) {
        const near = 1 - t / rangeCells;
        visArea += near;
        cells++;
      }
      // occluder rises from the bare terrain (+ canopy when signal is LOS)
      const occSlope = (zc[idx] - eyeZ) / dist;
      if (occSlope > maxSlope) maxSlope = occSlope;
    }
  }

  return { visArea, cells };
}

// Accurate covered-cell footprint for a single pilot position (for the map
// overlay) plus the covered fraction of the in-range disc. Unlike the radial
// sweep above (fast, fine for relative ranking), this tests EVERY cell in the
// disc with its own line-of-sight march to the drone-altitude target, so the
// footprint is dense and the percentage is real. Only run for the winning spots.
export function observeFootprint(g, ox, oy, p) {
  const { gridW, gridH, heights, zc, metersPerPx } = g;
  const eyeZ = heights[oy * gridW + ox] + p.antennaHeight;
  const rangeCells = p.maxRange / metersPerPx;
  const r2 = rangeCells * rangeCells;
  const vis = new Uint8Array(gridW * gridH);
  const rc = Math.ceil(rangeCells);

  let seen = 0, inDisc = 0;
  const c0 = Math.max(0, ox - rc), c1 = Math.min(gridW - 1, ox + rc);
  const r0 = Math.max(0, oy - rc), r1 = Math.min(gridH - 1, oy + rc);

  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const ddx = c - ox, ddy = r - oy;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 > r2) continue;
      inDisc++;
      if (d2 === 0) { vis[r * gridW + c] = 1; seen++; continue; }

      const targetDist = Math.sqrt(d2);
      const steps = Math.max(1, Math.round(targetDist));
      // target = drone at droneAGL above this cell's ground
      const targetSlope = (heights[r * gridW + c] + p.droneAGL - eyeZ) / (targetDist * metersPerPx);
      let blocked = false;
      // walk the intermediate cells; an occluder hides the drone only if it rises
      // above the eye->drone line, measured at the occluder's OWN distance (not
      // the parametric step) so the angle comparison is exact.
      for (let s = 1; s < steps; s++) {
        const fx = ox + (ddx * s) / steps;
        const fy = oy + (ddy * s) / steps;
        const ix = fx | 0, iy = fy | 0;
        const od = Math.hypot(ix - ox, iy - oy);
        if (od < 0.5 || od >= targetDist - 0.5) continue;
        const occSlope = (zc[iy * gridW + ix] - eyeZ) / (od * metersPerPx);
        if (occSlope > targetSlope + 1e-6) { blocked = true; break; }
      }
      if (!blocked) { vis[r * gridW + c] = 1; seen++; }
    }
  }
  return { vis, seen, visiblePercent: inDisc ? seen / inDisc : 0 };
}
