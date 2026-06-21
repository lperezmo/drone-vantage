import { defineConfig } from 'vite';
import { proxyTile } from './api/tiles.js';
import { proxyAirspace } from './api/airspace.js';

// Mirror the Vercel serverless functions during `vite dev` so the app behaves
// identically locally and in production:
//   /api/tiles    - keyless DEM + imagery tile proxy (CORS-clean pixels)
//   /api/airspace - FAA UAS Facility Map ceilings + airports proxy
function devApiPlugin() {
  return {
    name: 'dev-api-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith('/api/tiles')) {
          proxyTile(req.url, res).catch(() => { res.statusCode = 502; res.end('proxy error'); });
          return;
        }
        if (req.url && req.url.startsWith('/api/airspace')) {
          proxyAirspace(req.url, res).catch(() => { res.statusCode = 502; res.end('proxy error'); });
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [devApiPlugin()],
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
