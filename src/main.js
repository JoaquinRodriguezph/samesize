import { geoAzimuthalEqualArea, geoPath } from "d3-geo";
import Fuse from "fuse.js";
import { feature as topojsonFeature } from "topojson-client";
import "./style.css";

const EARTH_RADIUS_KM = 6371.0088;
const AREA_SQ_MI_FACTOR = 0.386102;
const placesUrl = `${import.meta.env.BASE_URL}data/places.json`;
const geometryFiles = {
  province: "provinces.topojson",
  city: "cities.topojson"
};
const geometryCache = new Map();
const elements = {
  status: document.querySelector("#status-message"),
  shuffle: document.querySelector("#shuffle-button"),
  search: document.querySelector("#place-search"),
  searchResults: document.querySelector("#search-results"),
  filter: document.querySelector("#place-filter"),
  leftName: document.querySelector("#left-name"),
  rightName: document.querySelector("#right-name"),
  rightCardLabel: document.querySelector("#right-card-label"),
  leftParent: document.querySelector("#left-parent"),
  rightParent: document.querySelector("#right-parent"),
  leftArea: document.querySelector("#left-area"),
  rightArea: document.querySelector("#right-area"),
  leftSquareMiles: document.querySelector("#left-square-miles"),
  rightSquareMiles: document.querySelector("#right-square-miles"),
  sizeComparison: document.querySelector("#size-comparison"),
  differenceLabel: document.querySelector("#difference-label"),
  similarList: document.querySelector("#similar-list"),
  stage: document.querySelector("#comparison-stage"),
  overlay: document.querySelector("#overlay-panel"),
  overlayLeftLabel: document.querySelector("#overlay-left-label"),
  overlayRightLabel: document.querySelector("#overlay-right-label"),
  leftCanvas: document.querySelector("#left-canvas"),
  rightCanvas: document.querySelector("#right-canvas"),
  overlayCanvas: document.querySelector("#overlay-canvas")
};

let places = [];
let currentLeft;
let currentRight;
let currentView = "side-by-side";
let renderVersion = 0;
let currentFilter = "both";
let searchMatches = [];
let activeSearchIndex = -1;
let placeSearch;

function formatArea(areaKm2) {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(areaKm2);
}

function fullName(place) {
  return place.level === "city" && place.parentName
    ? `${place.name}, ${place.parentName}`
    : place.name;
}

function setStatus(message = "") {
  elements.status.textContent = message;
}

function updateUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set("a", currentLeft.id);
  url.searchParams.set("b", currentRight.id);
  window.history.replaceState({}, "", url);
}

function closestPlaces(place) {
  return places
    .filter((candidate) => candidate.id !== place.id &&
      (currentFilter === "both" || candidate.level === currentFilter))
    .map((candidate) => ({
      place: candidate,
      difference: Math.abs(candidate.areaKm2 - place.areaKm2)
    }))
    .sort((a, b) => a.difference - b.difference);
}

async function loadGeometry(level) {
  if (!geometryCache.has(level)) {
    const url = `${import.meta.env.BASE_URL}data/${geometryFiles[level]}`;
    const request = fetch(url).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Could not load ${geometryFiles[level]} (${response.status})`);
      }
      const topology = await response.json();
      const object = Object.values(topology.objects)[0];
      if (!object) throw new Error(`No geometry object found in ${geometryFiles[level]}`);
      const collection = topojsonFeature(topology, object);
      return new Map(collection.features.map((item) => [item.properties.id, item]));
    });
    geometryCache.set(level, request);
  }
  return geometryCache.get(level);
}

async function getFeature(place) {
  const map = await loadGeometry(place.level);
  const found = map.get(place.id);
  if (!found) throw new Error(`Could not find boundary geometry for ${place.name}`);
  return found;
}

function getProjection(place, scale = 1, width = 0, height = 0) {
  const [longitude, latitude] = place.centroid;
  return geoAzimuthalEqualArea()
    .rotate([-longitude, -latitude])
    .center([0, 0])
    .clipAngle(180)
    .scale(scale)
    .translate([width / 2, height / 2]);
}

function getProjectedBounds(place, feature) {
  const projection = getProjection(place);
  return geoPath(projection).bounds(feature);
}

function getPanelDimensions() {
  const card = elements.leftCanvas.closest(".place-card");
  const visual = elements.leftCanvas.closest(".shape-visual");
  const cardStyle = window.getComputedStyle(card);
  const visualStyle = window.getComputedStyle(visual);
  const horizontalInsets = [
    cardStyle.paddingLeft,
    cardStyle.paddingRight,
    visualStyle.marginLeft,
    visualStyle.marginRight
  ].reduce((total, value) => total + Number.parseFloat(value), 0);

  return {
    width: Math.max(240, Math.round(card.clientWidth - horizontalInsets)),
    height: Math.max(210, Math.round(Number.parseFloat(visualStyle.height)))
  };
}

function getSharedScale(features, width, height) {
  const bounds = features.map(({ place, feature }) => getProjectedBounds(place, feature));
  const maxWidth = Math.max(...bounds.map((bound) => bound[1][0] - bound[0][0]));
  const maxHeight = Math.max(...bounds.map((bound) => bound[1][1] - bound[0][1]));
  return Math.min((width - 72) / maxWidth, (height - 72) / maxHeight);
}

function niceDistance(targetKm) {
  const magnitude = 10 ** Math.floor(Math.log10(targetKm));
  const factor = targetKm / magnitude;
  const niceFactor = factor >= 5 ? 5 : factor >= 2 ? 2 : 1;
  return niceFactor * magnitude;
}

function appendScaleBar(svg, pixelsPerKm, width, height) {
  const distance = niceDistance(104 / pixelsPerKm);
  const barWidth = distance * pixelsPerKm;
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("class", "scale-bar");
  group.setAttribute("transform", `translate(20 ${height - 22})`);
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", "0");
  line.setAttribute("x2", String(barWidth));
  line.setAttribute("y1", "0");
  line.setAttribute("y2", "0");
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("x", String(barWidth / 2));
  label.setAttribute("y", "-8");
  label.textContent = distance >= 1000 ? `${distance / 1000}k km` : `${distance} km`;
  group.append(line, label);
  svg.append(group);
}

function drawFeature(svg, item, color, scale, width, height) {
  const projection = getProjection(item.place, scale, width, height);
  const path = geoPath(projection);
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute("d", path(item.feature));
  shape.setAttribute("class", "map-shape");
  shape.setAttribute("fill", color);
  shape.setAttribute("aria-label", fullName(item.place));
  svg.append(shape);
}

function drawCanvas(svg, features, options = {}, sharedScale = null) {
  const width = Math.max(240, Math.round(svg.clientWidth));
  const height = Math.max(210, Math.round(svg.clientHeight));
  svg.replaceChildren();
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("aria-label", options.label ?? "Scaled map shapes");
  const scale = sharedScale ?? getSharedScale(features, width, height);

  for (const item of features) {
    drawFeature(svg, item, item.color, scale, width, height);
  }
  appendScaleBar(svg, scale / EARTH_RADIUS_KM, width, height);
}

function renderPlaceDetails(place, side) {
  const name = elements[`${side}Name`];
  const parent = elements[`${side}Parent`];
  const area = elements[`${side}Area`];
  const miles = elements[`${side}SquareMiles`];
  name.textContent = place.name;
  parent.textContent = place.level === "city" ? `in ${place.parentName}` : "Province";
  area.textContent = formatArea(place.areaKm2);
  miles.textContent = `${formatArea(place.areaKm2 * AREA_SQ_MI_FACTOR)} sq mi`;
}

function renderSimilarPlaces() {
  const matches = closestPlaces(currentLeft).slice(0, 5);
  elements.similarList.replaceChildren();
  for (const { place, difference } of matches) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `similar-place${place.id === currentRight.id ? " is-selected" : ""}`;
    button.setAttribute("aria-pressed", String(place.id === currentRight.id));

    const nameGroup = document.createElement("span");
    nameGroup.className = "similar-name-group";
    const name = document.createElement("strong");
    name.textContent = place.name;
    const parent = document.createElement("small");
    parent.textContent = place.level === "city" ? place.parentName : "Province";
    nameGroup.append(name, parent);

    const area = document.createElement("span");
    area.className = "similar-area";
    area.textContent = `${formatArea(place.areaKm2)} km²`;
    const percentage = document.createElement("span");
    percentage.className = "similar-difference";
    percentage.textContent = `${(difference / currentLeft.areaKm2 * 100).toFixed(2)}%`;
    button.append(nameGroup, area, percentage);
    button.addEventListener("click", () => {
      currentRight = place;
      render();
    });
    elements.similarList.append(button);
  }
}

function renderComparisonText() {
  const ratio = currentLeft.areaKm2 / currentRight.areaKm2;
  elements.sizeComparison.textContent =
    `${currentLeft.name} is ${ratio.toFixed(2)}× the size of ${currentRight.name}`;
  const difference = Math.abs(currentLeft.areaKm2 - currentRight.areaKm2);
  const percentage = difference / currentLeft.areaKm2 * 100;
  elements.differenceLabel.textContent =
    `${formatArea(difference)} km² apart · ${percentage.toFixed(2)}% difference`;
}

async function render() {
  if (!currentLeft || !currentRight) return;
  const version = ++renderVersion;
  setStatus("Drawing boundaries…");
  try {
    const [leftFeature, rightFeature] = await Promise.all([
      getFeature(currentLeft),
      getFeature(currentRight)
    ]);
    if (version !== renderVersion) return;
    renderPlaceDetails(currentLeft, "left");
    renderPlaceDetails(currentRight, "right");
    renderSimilarPlaces();
    renderComparisonText();
    elements.overlayLeftLabel.textContent = fullName(currentLeft);
    elements.overlayRightLabel.textContent = fullName(currentRight);
    elements.rightCardLabel.textContent =
        currentRight.id === closestPlaces(currentLeft)[0].place.id
          ? "CLOSEST IN AREA"
          : "COMPARISON PLACE";
    const leftItem = { place: currentLeft, feature: leftFeature, color: "#e5755d" };
    const rightItem = { place: currentRight, feature: rightFeature, color: "#477c92" };
    const { width, height } = getPanelDimensions();
    const sharedScale = getSharedScale([leftItem, rightItem], width, height);
    if (currentView === "overlay") {
      const svg = elements.overlayCanvas;
      drawCanvas(svg, [leftItem, rightItem], { label: "Overlay of two places at the same scale" }, sharedScale);
    } else {
      drawCanvas(elements.leftCanvas, [leftItem], { label: `${currentLeft.name} boundary` }, sharedScale);
      drawCanvas(elements.rightCanvas, [rightItem], { label: `${currentRight.name} boundary` }, sharedScale);
    }
    updateUrl();
    setStatus("");
  } catch (error) {
    setStatus(error.message);
    console.error(error);
  }
}

function setLeftPlace(place) {
  currentLeft = place;
  currentRight = closestPlaces(place)[0].place;
  render();
}

function availablePlaces() {
  return currentFilter === "both"
    ? places
    : places.filter((place) => place.level === currentFilter);
}

function chooseRandomPlace(excludeId = null) {
  const allOptions = availablePlaces();
  const options = allOptions.length > 1
    ? allOptions.filter((place) => place.id !== excludeId)
    : allOptions;
  return options[Math.floor(Math.random() * options.length)];
}

function closeSearch() {
  elements.searchResults.hidden = true;
  elements.search.setAttribute("aria-expanded", "false");
  elements.search.removeAttribute("aria-activedescendant");
  activeSearchIndex = -1;
}

function chooseSearchResult(place) {
  elements.search.value = "";
  closeSearch();
  setLeftPlace(place);
}

function renderSearchResults(query) {
  const resultRows = placeSearch.search(query)
    .map((result) => result.item)
    .filter((place) => currentFilter === "both" || place.level === currentFilter)
    .slice(0, 8);
  searchMatches = resultRows;
  activeSearchIndex = -1;
  elements.searchResults.replaceChildren();

  if (resultRows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "search-empty";
    empty.textContent = "No places found";
    elements.searchResults.append(empty);
  } else {
    for (const [index, place] of resultRows.entries()) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "search-option";
      option.id = `search-option-${index}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      const title = document.createElement("strong");
      title.textContent = place.name;
      const description = document.createElement("small");
      description.textContent = place.level === "city"
        ? `${place.parentName} · City / municipality`
        : "Province";
      option.append(title, description);
      option.addEventListener("click", () => chooseSearchResult(place));
      elements.searchResults.append(option);
    }
  }
  elements.searchResults.hidden = false;
  elements.search.setAttribute("aria-expanded", "true");
}

function setActiveSearchResult(index) {
  if (searchMatches.length === 0) return;
  activeSearchIndex = index < 0 ? searchMatches.length - 1 : index % searchMatches.length;
  const options = elements.searchResults.querySelectorAll(".search-option");
  options.forEach((option, optionIndex) => {
    const active = optionIndex === activeSearchIndex;
    option.classList.toggle("is-active", active);
    option.setAttribute("aria-selected", String(active));
    if (active) option.scrollIntoView({ block: "nearest" });
  });
  elements.search.setAttribute("aria-activedescendant", `search-option-${activeSearchIndex}`);
}

function setView(view) {
  currentView = view;
  elements.stage.classList.toggle("overlay-mode", view === "overlay");
  elements.overlay.hidden = view !== "overlay";
  document.querySelectorAll(".view-button").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  requestAnimationFrame(render);
}

async function start() {
  try {
    const response = await fetch(placesUrl);
    if (!response.ok) throw new Error(`Could not load place index (${response.status})`);
    places = await response.json();
    if (places.length < 2) throw new Error("The place index must contain at least two places.");

    const byId = new Map(places.map((place) => [place.id, place]));
    const params = new URLSearchParams(window.location.search);
    const linkedLeft = byId.get(params.get("a"));
    currentLeft = linkedLeft ?? chooseRandomPlace();
    const linkedRight = byId.get(params.get("b"));
    currentRight = linkedRight && (currentFilter === "both" || linkedRight.level === currentFilter)
      ? linkedRight
      : closestPlaces(currentLeft)[0].place;
    placeSearch = new Fuse(places, {
      keys: [
        { name: "name", weight: 0.8 },
        { name: "parentName", weight: 0.2 }
      ],
      threshold: 0.35,
      minMatchCharLength: 2,
      ignoreLocation: true
    });

    elements.shuffle.addEventListener("click", () => setLeftPlace(chooseRandomPlace(currentLeft.id)));
    elements.search.addEventListener("input", () => {
      const query = elements.search.value.trim();
      if (query.length < 2) closeSearch();
      else renderSearchResults(query);
    });
    elements.search.addEventListener("keydown", (event) => {
      if (elements.searchResults.hidden) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveSearchResult(activeSearchIndex + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveSearchResult(activeSearchIndex - 1);
      } else if (event.key === "Enter" && searchMatches.length > 0) {
        event.preventDefault();
        chooseSearchResult(searchMatches[Math.max(0, activeSearchIndex)]);
      } else if (event.key === "Escape") {
        closeSearch();
      }
    });
    elements.filter.addEventListener("change", () => {
      currentFilter = elements.filter.value;
      if (currentLeft.level !== currentFilter && currentFilter !== "both") {
        currentLeft = chooseRandomPlace();
      }
      if (currentRight.id === currentLeft.id ||
          (currentFilter !== "both" && currentRight.level !== currentFilter)) {
        currentRight = closestPlaces(currentLeft)[0].place;
      }
      if (!elements.searchResults.hidden && elements.search.value.trim().length >= 2) {
        renderSearchResults(elements.search.value.trim());
      }
      render();
    });
    document.addEventListener("pointerdown", (event) => {
      if (!event.target.closest(".search-box")) closeSearch();
    });
    document.querySelectorAll(".view-button").forEach((button) => {
      button.addEventListener("click", () => setView(button.dataset.view));
    });
    window.addEventListener("resize", () => requestAnimationFrame(render));
    await render();
  } catch (error) {
    setStatus(error.message);
    console.error(error);
  }
}

start();
