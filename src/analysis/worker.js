// Analysis worker: build the parcel, fetch the airspace ceiling grid, merge it
// onto the parcel, run the vantage scoring, and ship the results (with
// transferable buffers) back to the main thread. Keeps all the heavy lifting
// off the UI thread.

import { buildParcel } from '../data/build.js';
import { fetchAirspaceGrid } from '../data/airspace.js';
import { analyze } from './score.js';

self.onmessage = async (e) => {
  const { bbox, ui } = e.data;
  const post = (pct, label) => self.postMessage({ type: 'progress', pct, label });

  try {
    const parcel = await buildParcel(bbox, (pct, label) => post(pct, label));

    post(0.93, 'Checking airspace...');
    const airspace = await fetchAirspaceGrid(bbox, parcel.gridW, parcel.gridH, (pct, label) =>
      post(0.93 + 0.03 * (pct || 0), label || 'Checking airspace...')
    );
    parcel.ceiling = airspace.ceiling;
    parcel.airspace = {
      zones: airspace.zones,
      airports: airspace.airports,
      maxCeiling: airspace.maxCeiling,
      minCeiling: airspace.minCeiling,
      ok: airspace.ok,
    };

    post(0.97, 'Scoring launch spots...');
    const result = analyze(parcel, ui);
    post(1, 'Done');

    // collect transferables
    const transfer = [
      result.heat.buffer,
      result.heights.buffer,
      result.forest.buffer,
      result.ceiling.buffer,
    ];
    for (const s of result.spots) transfer.push(s.footprint.buffer);
    result.texBitmap = parcel.texBitmap || null;
    result.texW = parcel.texW;
    result.texH = parcel.texH;
    if (parcel.texBitmap) transfer.push(parcel.texBitmap);

    self.postMessage({ type: 'result', result }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
};
