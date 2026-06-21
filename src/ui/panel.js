// Results panel: ranked launch-spot cards with a heatmap legend, plus
// GPX and KML waypoint export for the launch spots.

export function renderResults(container, spots, { onSelect, onView3d }) {
  container.innerHTML = '';
  if (!spots || !spots.length) {
    container.innerHTML = '<p class="empty">No launch spots found - try a larger or more varied area.</p>';
    return { select: () => {} };
  }

  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = '<span>poor</span><div class="ramp"></div><span>great</span>';
  container.appendChild(legend);

  const cards = [];
  spots.forEach((s) => {
    const card = document.createElement('div');
    card.className = 'card';
    const ceil = s.ceilingFt === 0
      ? '<span class="no-laanc">ceiling: no LAANC</span>'
      : `ceiling ${s.ceilingFt} ft`;
    card.innerHTML = `
      <div class="rank">
        <span class="badge">${s.rank}</span>
        <strong>Launch ${s.rank}</strong>
      </div>
      <div class="score">score ${s.rating} · ~${s.coverageAcres} ac LOS · ${ceil}</div>
      <p class="why">${s.why}.</p>
      <div class="coords">${s.lat.toFixed(5)}, ${s.lon.toFixed(5)} · ${s.elevation} m</div>
      <button class="view3d">View in 3D</button>`;
    card.addEventListener('click', () => onSelect(s.rank));
    card.querySelector('.view3d').addEventListener('click', (e) => { e.stopPropagation(); onView3d(s.rank); });
    container.appendChild(card);
    cards.push(card);
  });

  const exportRow = document.createElement('div');
  exportRow.className = 'export-row';
  exportRow.style.marginTop = '8px';
  exportRow.style.display = 'flex';
  exportRow.style.gap = '6px';

  const gpxBtn = document.createElement('button');
  gpxBtn.className = 'ghost';
  gpxBtn.style.flex = '1';
  gpxBtn.textContent = 'Export GPX';
  gpxBtn.addEventListener('click', () => downloadGpx(spots));

  const kmlBtn = document.createElement('button');
  kmlBtn.className = 'ghost';
  kmlBtn.style.flex = '1';
  kmlBtn.textContent = 'Export KML';
  kmlBtn.addEventListener('click', () => downloadKml(spots));

  exportRow.appendChild(gpxBtn);
  exportRow.appendChild(kmlBtn);
  container.appendChild(exportRow);

  function select(rank) {
    cards.forEach((c, i) => c.classList.toggle('sel', spots[i].rank === rank));
  }
  return { select };
}

const ceilingLabel = (s) => (s.ceilingFt === 0 ? 'no LAANC (controlled, no-go)' : `${s.ceilingFt} ft`);
const spotDesc = (s) =>
  `Rank ${s.rank} - score ${s.rating} - ~${s.coverageAcres} acres LOS coverage - ceiling ${ceilingLabel(s)}. ${s.why}.`;

function downloadGpx(spots) {
  const pts = spots.map((s) =>
    `  <wpt lat="${s.lat.toFixed(6)}" lon="${s.lon.toFixed(6)}">
    <ele>${s.elevation}</ele>
    <name>Launch ${s.rank} (score ${s.rating})</name>
    <desc>${escapeXml(spotDesc(s))}</desc>
  </wpt>`).join('\n');
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Drone Launch Finder" xmlns="http://www.topografix.com/GPX/1/1">
${pts}
</gpx>`;
  download(gpx, 'application/gpx+xml', 'drone-vantage-launch-spots.gpx');
}

function downloadKml(spots) {
  const placemarks = spots.map((s) =>
    `    <Placemark>
      <name>Launch ${s.rank} (score ${s.rating})</name>
      <description>${escapeXml(spotDesc(s))}</description>
      <Point><coordinates>${s.lon.toFixed(6)},${s.lat.toFixed(6)},${s.elevation}</coordinates></Point>
    </Placemark>`).join('\n');
  const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Drone Launch Finder</name>
${placemarks}
  </Document>
</kml>`;
  download(kml, 'application/vnd.google-earth.kml+xml', 'drone-vantage-launch-spots.kml');
}

function download(text, mime, filename) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

const escapeXml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
