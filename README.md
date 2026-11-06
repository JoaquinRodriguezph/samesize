# Same Size

Same Size compares the land areas of Philippine provinces and cities/municipalities using simplified geoBoundaries shapes. Each shape is drawn in its own azimuthal equal-area projection centered on its centroid. The compared shapes share one scale in both side-by-side and overlay views.

## Run locally

Requires Node.js 20 or newer.

```sh
npm install
npm run dev
```

Vite prints the local URL. To create and preview a production build:

```sh
npm run build
npm run preview
```

## Refresh boundary data

```sh
npm run data
```

The script queries the geoBoundaries current API for each configured country and administrative level, downloads each returned GeoJSON URL to `data/raw/`, computes Turf geodesic areas and centroids from the source geometries, then simplifies the display geometries with mapshaper. Raw downloads are intentionally ignored by Git. The generated index and per-level TopoJSON files are written to `public/data/` and are committed so the site can be built without running the data pipeline.

The current data configuration is in [`scripts/countries.js`](./scripts/countries.js). Add a country object with its ISO 3166-1 alpha-3 code, API levels, feature-name property, output level, and output filename. For ADM3 entries, set `parentLevel: "province"`; the pipeline assigns each feature to the containing ADM2 boundary. Keep output filenames consistent for a level so features from multiple configured countries are combined. Adjust `nameProperty` or `parentLevel` if a country's source fields or administrative hierarchy differ.

The pipeline currently keeps 2% of source vertices during mapshaper simplification. It prints the five largest and smallest ADM2 units and their computed areas after each run as a sanity check.

## Data attribution

Boundary data is from [geoBoundaries](https://www.geoboundaries.org/), Philippines ADM2 and ADM3, representing 2020. geoBoundaries identifies the source data license as [Creative Commons Attribution 3.0 IGO (CC BY 3.0 IGO)](https://creativecommons.org/licenses/by/3.0/igo/). The site credits geoBoundaries in its footer. Areas are computed from the unsimplified source geometries.

## Deploy to GitHub Pages

The GitHub Actions workflow at [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) builds the static site with `npm ci` and `npm run build`, then deploys the `dist/` artifact when changes are pushed to `main` (or when the workflow is manually run). In the repository's **Settings → Pages**, select **GitHub Actions** as the build and deployment source.

Vite's base path is set to `/samesize/` in [`vite.config.js`](./vite.config.js), matching this repository name. Update it if the repository is renamed. No server or runtime API is required.
