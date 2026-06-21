// On-demand parcel builder. Given a user bounding box it fetches Terrarium
// elevation tiles and Esri imagery tiles (through /api/tiles), decodes them into
// a metric heightmap, and classifies a tree-density "forest" mask from the
// imagery. Tree canopy matters here too: it blocks both the visual sightline and
// the 2.4/5.8 GHz control/video signal to the drone.
//
// Runs inside the analysis Web Worker (uses fetch + createImageBitmap + OffscreenCanvas).

import {
  TILE, lon2tile, lat2tile, mercPerPx, metersPerPx,
  decodeTerrarium, pickDemZoom,
} from './geo.js';

const tileUrl = (src, z, x, y) => `/api/tiles?src=${src}&z=${z}&x=${x}&y=${y}`;

async function fetchTileRGBA(src, z, x, y) {
  const r = await fetch(tileUrl(src, z, x, y));
  if (!r.ok) throw new Error(`tile ${src} ${z}/${x}/${y} -> ${r.status}`);
  const bmp = await createImageBitmap(await r.blob());
  const cv = new OffscreenCanvas(TILE, TILE);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, TILE, TILE);
  bmp.close();
  return ctx.getImageData(0, 0, TILE, TILE).data; // Uint8ClampedArray RGBA
}

async function mapLimit(items, limit, fn, onTick) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
        if (onTick) onTick(++done, items.length);
      }
    })
  );
  return out;
}

// Canopy score 0..1 per imagery pixel: classify by green dominance rather than
// brightness; suppress water, voids, and bright meadow/granite.
function canopy(r, g, b) {
  const ratio = g / (r + b + 1);
  let s = Math.min(1, Math.max(0, (ratio - 0.555) * 14));
  if (b > g * 0.78) s *= Math.max(0, 1 - (b / g - 0.78) * 6);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (lum < 7) s = 0;
  if (lum > 135) s *= Math.max(0, 1 - (lum - 135) / 35);
  return s;
}

// Bilinear sample of a single-channel Float32 grid.
function sampleF(grid, w, h, x, y) {
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1;
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1;
  const c = Math.floor(x), r = Math.floor(y);
  const c1 = Math.min(c + 1, w - 1), r1 = Math.min(r + 1, h - 1);
  const fx = x - c, fy = y - r;
  const a = grid[r * w + c], b = grid[r * w + c1];
  const d = grid[r1 * w + c], e = grid[r1 * w + c1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
}

export async function buildParcel(bbox, onProgress = () => {}) {
  const demZoom = pickDemZoom(bbox);
  const latC = (bbox.north + bbox.south) / 2;
  const mpp = metersPerPx(demZoom, latC); // ground metres per output sample

  // --- elevation grid, cropped exactly to the bbox ---
  const pxw = lon2tile(bbox.west, demZoom) * TILE;
  const pxe = lon2tile(bbox.east, demZoom) * TILE;
  const pyn = lat2tile(bbox.north, demZoom) * TILE;
  const pys = lat2tile(bbox.south, demZoom) * TILE;

  const gridW = Math.max(8, Math.round(pxe - pxw));
  const gridH = Math.max(8, Math.round(pys - pyn));

  const tx0 = Math.floor(pxw / TILE), tx1 = Math.ceil(pxe / TILE) - 1;
  const ty0 = Math.floor(pyn / TILE), ty1 = Math.ceil(pys / TILE) - 1;
  const ntx = tx1 - tx0 + 1, nty = ty1 - ty0 + 1;
  const SW = ntx * TILE, SH = nty * TILE;
  const originX = tx0 * TILE, originY = ty0 * TILE;

  onProgress(0.05, 'Fetching elevation...');
  const demStitch = new Float32Array(SW * SH);
  const demTiles = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) demTiles.push({ tx, ty });
  await mapLimit(demTiles, 8, async ({ tx, ty }) => {
    const data = await fetchTileRGBA('dem', demZoom, tx, ty);
    const ox = (tx - tx0) * TILE, oy = (ty - ty0) * TILE;
    for (let py = 0; py < TILE; py++) {
      for (let px = 0; px < TILE; px++) {
        const s = (py * TILE + px) * 4;
        demStitch[(oy + py) * SW + (ox + px)] = decodeTerrarium(data[s], data[s + 1], data[s + 2]);
      }
    }
  }, (d, t) => onProgress(0.05 + 0.35 * (d / t), 'Fetching elevation...'));

  const heights = new Float32Array(gridW * gridH);
  for (let r = 0; r < gridH; r++) {
    const sy = (pyn - originY) + (gridH === 1 ? 0 : (r * (pys - pyn)) / (gridH - 1));
    for (let c = 0; c < gridW; c++) {
      const sx = (pxw - originX) + (gridW === 1 ? 0 : (c * (pxe - pxw)) / (gridW - 1));
      heights[r * gridW + c] = sampleF(demStitch, SW, SH, sx, sy);
    }
  }

  // --- imagery: stitch, classify canopy, keep a cropped texture for 3D ---
  const imgZoom = Math.min(demZoom + 2, 18);
  const factor = 2 ** (imgZoom - demZoom); // imagery px per DEM px
  const ipxw = pxw * factor, ipxe = pxe * factor;
  const ipyn = pyn * factor, ipys = pys * factor;
  const itx0 = Math.floor(ipxw / TILE), itx1 = Math.ceil(ipxe / TILE) - 1;
  const ity0 = Math.floor(ipyn / TILE), ity1 = Math.ceil(ipys / TILE) - 1;
  const intx = itx1 - itx0 + 1, inty = ity1 - ity0 + 1;
  const ISW = intx * TILE, ISH = inty * TILE;
  const iOriginX = itx0 * TILE, iOriginY = ity0 * TILE;

  onProgress(0.42, 'Fetching imagery...');
  const imgStitch = new Uint8ClampedArray(ISW * ISH * 4);
  const imgTiles = [];
  for (let ty = ity0; ty <= ity1; ty++) for (let tx = itx0; tx <= itx1; tx++) imgTiles.push({ tx, ty });
  await mapLimit(imgTiles, 6, async ({ tx, ty }) => {
    const data = await fetchTileRGBA('img', imgZoom, tx, ty);
    const ox = (tx - itx0) * TILE, oy = (ty - ity0) * TILE;
    for (let py = 0; py < TILE; py++) {
      const dst = ((oy + py) * ISW + ox) * 4;
      const src = py * TILE * 4;
      imgStitch.set(data.subarray(src, src + TILE * 4), dst);
    }
  }, (d, t) => onProgress(0.42 + 0.4 * (d / t), 'Fetching imagery...'));

  // canopy per DEM sample: average canopy() over the imagery block it covers
  onProgress(0.84, 'Classifying tree cover...');
  const forest = new Uint8Array(gridW * gridH);
  const block = Math.max(1, Math.round(factor));
  for (let r = 0; r < gridH; r++) {
    const demSrcY = (pyn - originY) + (gridH === 1 ? 0 : (r * (pys - pyn)) / (gridH - 1));
    const iy0 = Math.round((originY + demSrcY) * factor) - iOriginY;
    for (let c = 0; c < gridW; c++) {
      const demSrcX = (pxw - originX) + (gridW === 1 ? 0 : (c * (pxe - pxw)) / (gridW - 1));
      const ix0 = Math.round((originX + demSrcX) * factor) - iOriginX;
      let sum = 0, n = 0;
      for (let j = 0; j < block; j++) {
        const yy = iy0 + j;
        if (yy < 0 || yy >= ISH) continue;
        for (let i = 0; i < block; i++) {
          const xx = ix0 + i;
          if (xx < 0 || xx >= ISW) continue;
          const p = (yy * ISW + xx) * 4;
          sum += canopy(imgStitch[p], imgStitch[p + 1], imgStitch[p + 2]);
          n++;
        }
      }
      forest[r * gridW + c] = n ? Math.round((255 * sum) / n) : 0;
    }
  }

  // suppress canopy on steep slopes (cliff faces)
  for (let r = 0; r < gridH; r++) {
    for (let c = 0; c < gridW; c++) {
      const i = r * gridW + c;
      if (!forest[i]) continue;
      const cl = Math.max(c - 1, 0), cr = Math.min(c + 1, gridW - 1);
      const ru = Math.max(r - 1, 0), rd = Math.min(r + 1, gridH - 1);
      const dx = (heights[r * gridW + cr] - heights[r * gridW + cl]) / ((cr - cl) * mpp);
      const dz = (heights[rd * gridW + c] - heights[ru * gridW + c]) / ((rd - ru) * mpp);
      const slopeDeg = (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
      const f = Math.max(0, Math.min(1, (52 - slopeDeg) / 14));
      forest[i] = Math.round(forest[i] * f);
    }
  }

  // cropped imagery bitmap for the optional 3D drape
  let texBitmap = null, texW = 0, texH = 0;
  try {
    const cropX = Math.max(0, Math.round(ipxw - iOriginX));
    const cropY = Math.max(0, Math.round(ipyn - iOriginY));
    texW = Math.min(ISW - cropX, Math.round(ipxe - ipxw));
    texH = Math.min(ISH - cropY, Math.round(ipys - ipyn));
    if (texW > 8 && texH > 8) {
      const full = new OffscreenCanvas(ISW, ISH);
      full.getContext('2d').putImageData(new ImageData(imgStitch, ISW, ISH), 0, 0);
      const crop = new OffscreenCanvas(texW, texH);
      crop.getContext('2d').drawImage(full, cropX, cropY, texW, texH, 0, 0, texW, texH);
      texBitmap = crop.transferToImageBitmap();
    }
  } catch { /* texture is optional */ }

  onProgress(0.92, 'Analysing...');
  return {
    gridW, gridH, heights, forest,
    metersPerPx: mpp, lat: latC, demZoom, imgZoom,
    bbox, texBitmap, texW, texH,
  };
}
