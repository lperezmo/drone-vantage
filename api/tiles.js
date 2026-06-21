// Vercel serverless function (and Vite dev middleware) that proxies map tiles.
//
// Why a proxy: the analysis reads raw pixel data from elevation + imagery tiles
// (canvas getImageData), which requires CORS-clean responses. This proxy adds
// `Access-Control-Allow-Origin`, edge-caches the tiles, and keeps the upstream
// source swappable without touching the client.
//
//   GET /api/tiles?src=dem|img&z=<z>&x=<x>&y=<y>
//
// Sources (both keyless):
//   dem - AWS Open Data "terrain-tiles", Terrarium-encoded PNG (Mapzen/NASA/USGS)
//   img - Esri World Imagery (note: ArcGIS tile path is /{z}/{y}/{x})

const SOURCES = {
  dem: (z, x, y) =>
    `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
  img: (z, x, y) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
};

const Z_MAX = { dem: 15, img: 19 };

export async function proxyTile(reqUrl, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  let params;
  try {
    params = new URL(reqUrl, 'http://localhost').searchParams;
  } catch {
    res.statusCode = 400;
    res.end('bad url');
    return;
  }

  const src = params.get('src');
  const z = Number(params.get('z'));
  const x = Number(params.get('x'));
  const y = Number(params.get('y'));
  const make = SOURCES[src];

  if (!make || !Number.isFinite(z) || !Number.isFinite(x) || !Number.isFinite(y)) {
    res.statusCode = 400;
    res.end('expected ?src=dem|img&z&x&y');
    return;
  }
  if (z < 0 || z > (Z_MAX[src] ?? 20) || x < 0 || y < 0) {
    res.statusCode = 400;
    res.end('tile out of range');
    return;
  }

  try {
    const upstream = await fetch(make(z, x, y), {
      headers: { 'User-Agent': 'drone-vantage (github.com/lperezmo/drone-vantage)' },
    });
    if (!upstream.ok) {
      res.statusCode = upstream.status;
      res.end(`upstream ${upstream.status}`);
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800, immutable');
    res.statusCode = 200;
    res.end(buf);
  } catch (err) {
    res.statusCode = 502;
    res.end('proxy error: ' + (err?.message || 'unknown'));
  }
}

export default function handler(req, res) {
  return proxyTile(req.url, res);
}
