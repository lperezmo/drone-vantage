# Drone Vantage

Find the best launch and pilot positions for any ground, and see where a drone
can fly while staying in line-of-sight. Draw a box on the map (or search a
place), and the app pulls real elevation and satellite imagery for that ground,
fetches FAA airspace ceilings, runs a line-of-sight analysis, and ranks the spots
that cover the most flyable ground, explained in plain English, with the legal
altitude ceiling overlaid and a 3D view of the parcel.

[![Live on Vercel](https://img.shields.io/badge/Live-drone--vantage.vercel.app-000000?logo=vercel&logoColor=white)](https://drone-vantage.vercel.app)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![Three.js](https://img.shields.io/badge/Three.js-r170-000000?logo=three.js&logoColor=white)](https://threejs.org)
[![MapLibre GL](https://img.shields.io/badge/MapLibre_GL-4-396CB2?logo=maplibre&logoColor=white)](https://maplibre.org)

No API keys. Everything runs on free, keyless data:

- Elevation: Mapzen/AWS Terrain Tiles (Terrarium-encoded PNG, NASA/USGS derived).
- Imagery and tree cover: Esri World Imagery, classified canopy versus open.
- Airspace: FAA UAS Facility Maps (the LAANC ceiling grid, ft AGL per cell) plus
  nearby airports and heliports.
- All fetched on demand through small serverless proxies, decoded in the browser.

## How it works

1. You draw the ground. Search to a location, then drag a rectangle over the area
   you want to fly or map (soft cap about 30 sq km).
2. The app builds the parcel. A Web Worker fetches elevation and imagery tiles,
   decodes a metric heightmap, and classifies a tree-canopy density mask
   (slope-suppressed so cliffs do not read as forest). Canopy matters: it occludes
   both visual line-of-sight and 2.4/5.8 GHz control and video signal.
3. It pulls airspace. The FAA UAS Facility Map ceilings (the LAANC grid) and
   nearby airports are fetched through the serverless proxy and rasterized onto
   the same grid, so every cell knows its published legal ceiling in feet AGL.
4. It scores every spot. For a grid of candidate launch and pilot positions it
   casts radial sightlines, with the pilot eye/antenna at ground plus your antenna
   height and the target being the drone flying at your chosen height above the
   ground. Terrain is the occluder, and the tree canopy is added on top when you
   ask signal to be blocked by trees. It then blends:

   | Factor | What it rewards |
   |---|---|
   | Line-of-sight coverage | sees the most flyable ground within range (drone at your chosen flight height, terrain plus tree canopy as occluders) |
   | Legal ceiling | more usable vertical airspace (higher published LAANC ceiling) |
   | Launch pad quality | open, level ground for a clean takeoff and GPS lock |
   | High ground | local prominence for better antenna line-of-sight |
   | Obstruction clearance | clear of trees and terrain right at the launch point |
   | Airspace safety | clear of controlled no-go cells and nearby airports |

5. You get ranked spots: a launch-suitability heatmap (red poor to cyan/green
   great), numbered pins, each spot's exact line-of-sight coverage footprint and
   the acres of flyable ground reachable from it, the legal ceiling at that spot,
   plain-English reasons, GPX and KML waypoint export, a translucent FAA ceiling
   overlay you can toggle on and off, and a 3D drape of the parcel with the launch
   point marked and a legal-ceiling lid.

Flight-style preset, line-of-sight range, pilot/antenna height, flight height
AGL, whether trees block signal, and the six factor weights are all tunable under
"Tune the analysis". Any drawn area produces a shareable URL (the bbox is encoded
in the link as `?bbox=...`), so you can send a parcel to another pilot and it
re-runs on open.

## Run locally

```sh
npm install
npm run dev
```

Then open the printed localhost URL. `npm run build` produces the static site in
`dist/`. The `/api/tiles` and `/api/airspace` proxies run as Vercel serverless
functions in production and as Vite dev middleware locally (see `vite.config.js`),
so behavior is identical in both.

## Deploy

This repo is connected to Vercel, so pushing to the default branch deploys
automatically. To set it up fresh: import the repo into Vercel (framework preset
Vite), or run `vercel` from the repo root. `vercel.json` pins the build and both
serverless functions (`/api/tiles` and `/api/airspace`).

## Caveats and safety

This tool models line-of-sight and shows PUBLISHED LAANC ceilings from the FAA
UAS Facility Maps. It is informational only.

- It is NOT an FAA authorization. It does not request or grant LAANC approval, and
  it is not a substitute for an FAA-approved app for filing LAANC requests.
- It is NOT a live TFR or NOTAM check, and not a substitute for current
  aeronautical charts. Always check current TFRs and NOTAMs before you fly.
- Airspace data may be stale or unavailable in some areas. Where the FAA service
  cannot be reached, the app degrades to a Class G 400 ft default, which may not
  reflect the real airspace.
- Tree classification is leaf-on and summer-biased, so deciduous winter cover is
  under-counted. Canopy height is an assumption that scales with density. The DEM
  is bare-earth, with trees added as the occluder on top.
- You are the pilot in command. Follow Part 107 or the recreational rules as they
  apply to you, get authorization where it is required, keep clear of airports and
  controlled airspace, and maintain visual line of sight with your aircraft at all
  times.

## Attribution

Elevation: Mapzen/AWS Terrain Tiles. Imagery: Esri, Maxar, Earthstar Geographics.
Airspace: FAA UAS Facility Maps. Geocoding: OpenStreetMap and Nominatim.
