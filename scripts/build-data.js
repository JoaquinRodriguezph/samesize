import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import area from "@turf/area";
import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import centroid from "@turf/centroid";
import pointOnFeature from "@turf/point-on-feature";
import { countries } from "./countries.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rawDir = path.join(root, "data", "raw");
const outputDir = path.join(root, "public", "data");
const simplifyPercentage = "1%";

function getId(countryCode, boundaryLevel, properties) {
  const identifier = properties.shapeISO || properties.shapeID || properties.shapeName;
  return `${countryCode.toLowerCase()}-${boundaryLevel.toLowerCase()}-${String(identifier)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
}

async function downloadBoundary(country, level, parentFeatures = []) {
  const apiUrl = `https://www.geoboundaries.org/api/current/gbOpen/${country.code}/${level.boundaryLevel}/`;
  const response = await fetch(apiUrl);
  if (!response.ok) {
    throw new Error(`geoBoundaries API request failed (${response.status}): ${apiUrl}`);
  }
  const metadata = await response.json();
  if (!metadata.gjDownloadURL) {
    throw new Error(`geoBoundaries API did not provide a GeoJSON URL for ${country.code} ${level.boundaryLevel}`);
  }

  const rawPath = path.join(rawDir, `${country.code}-${level.boundaryLevel}.geojson`);
  try {
    await readFile(rawPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const download = await fetch(metadata.gjDownloadURL);
    if (!download.ok) {
      throw new Error(`Boundary download failed (${download.status}): ${metadata.gjDownloadURL}`);
    }
    await writeFile(rawPath, new Uint8Array(await download.arrayBuffer()));
    console.log(`Downloaded ${country.code} ${level.boundaryLevel}`);
  }

  const geojson = JSON.parse(await readFile(rawPath, "utf8"));
  const features = geojson.features.map((feature) => {
    const originalProperties = feature.properties ?? {};
    const name = originalProperties[level.nameProperty];
    if (!name) {
      throw new Error(`Missing ${level.nameProperty} on a ${country.code} ${level.boundaryLevel} feature`);
    }
    const featureCentroid = centroid(feature).geometry.coordinates;
    let parentName = null;
    if (level.parentLevel) {
      const interiorPoint = pointOnFeature(feature);
      const containingParents = parentFeatures.filter((parentFeature) =>
        booleanPointInPolygon(interiorPoint, parentFeature)
      );
      if (containingParents.length === 0) {
        throw new Error(`Could not find a ${level.parentLevel} for ${name} (${country.code})`);
      }
      parentName = containingParents
        .sort((a, b) => area(a) - area(b))[0].properties.name;
    }
    const id = getId(country.code, level.boundaryLevel, originalProperties);

    return {
      feature: {
        type: "Feature",
        id,
        properties: { id, name, parentName, centroid: featureCentroid },
        geometry: feature.geometry
      },
      place: {
        id,
        name,
        parentName,
        level: level.level,
        country: country.code,
        areaKm2: area(feature) / 1_000_000,
        centroid: featureCentroid
      }
    };
  });

  return features;
}

async function simplifyGeoJSON(features, destination) {
  const inputPath = `${destination}.input`;
  const outputPath = `${destination}.simplified`;
  await writeFile(inputPath, JSON.stringify({ type: "FeatureCollection", features }));

  try {
    const mapshaperPath = path.join(root, "node_modules", "mapshaper", "bin", "mapshaper");
    const args = [
      mapshaperPath,
      "-i", inputPath,
      "-simplify", simplifyPercentage, "keep-shapes",
      "-o", "format=topojson", outputPath
    ];
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: root, windowsHide: true });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (output) console.log(output.trim());
        if (code === 0) resolve();
        else reject(new Error(`mapshaper exited with code ${code}`));
      });
    });
    await rename(outputPath, destination);
  } finally {
    await rm(inputPath, { force: true });
    await rm(outputPath, { force: true });
  }
}

await mkdir(rawDir, { recursive: true });
await mkdir(outputDir, { recursive: true });

const places = [];
const geometryByLevel = new Map();
for (const country of countries) {
  const countryFeaturesByLevel = new Map();
  for (const level of country.levels) {
    console.log(`Processing ${country.name} ${level.level === "city" ? "cities" : `${level.level}s`}...`);
    const parents = level.parentLevel ? countryFeaturesByLevel.get(level.parentLevel) ?? [] : [];
    const rows = await downloadBoundary(country, level, parents);
    places.push(...rows.map((row) => row.place));
    countryFeaturesByLevel.set(level.level, rows.map((row) => row.feature));
    geometryByLevel.set(level.level, [
      ...(geometryByLevel.get(level.level) ?? []),
      ...rows.map((row) => row.feature)
    ]);
  }
}

for (const [level, features] of geometryByLevel) {
  const outputFile = countries.flatMap((country) => country.levels)
    .find((levelConfig) => levelConfig.level === level).outputFile;
  const filename = outputFile;
  await simplifyGeoJSON(features, path.join(outputDir, filename));
}

places.sort((a, b) => a.areaKm2 - b.areaKm2);
await writeFile(path.join(outputDir, "places.json"), JSON.stringify(places));

const provinces = places.filter((place) => place.level === "province");
console.log("\n5 largest provinces:");
for (const place of provinces.slice(-5).reverse()) {
  console.log(`  ${place.name}: ${place.areaKm2.toFixed(2)} km²`);
}
console.log("\n5 smallest provinces:");
for (const place of provinces.slice(0, 5)) {
  console.log(`  ${place.name}: ${place.areaKm2.toFixed(2)} km²`);
}
