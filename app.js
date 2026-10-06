// (the original first line was `code = "use strict";`, which only created a global variable)

/*
 * SwissTopo swissSURFACE3D COPC viewer
 * Potree 1.8
 *
 * Important SWISSIMAGE RGB design:
 * - A 1 km x 1 km SWISSIMAGE at 10 cm/pixel is ~10,000 x 10,000
 *   pixels = ~100 million raster pixels.
 * - A LiDAR tile may contain ~20 million points.
 * - These counts are NOT supposed to match.
 * - Each LiDAR point is transformed to LV95 -> EPSG:3857 and
 *   samples ONE RGB pixel from SWISSIMAGE.
 * - A new normalized Uint8 RGB `color` BufferAttribute is created
 *   with exactly 3 bytes per LiDAR point.
 *
 * Expected external globals:
 *   CONFIG, Potree, THREE (provided by Potree), L, proj4
 */




const EPSG2056_DEF =
    "+proj=somerc " +
    "+lat_0=46.95240555555556 " +
    "+lon_0=7.439583333333333 " +
    "+k_0=1 " +
    "+x_0=2600000 " +
    "+y_0=1200000 " +
    "+ellps=bessel " +
    "+towgs84=674.374,15.056,405.346,0,0,0,0 " +
    "+units=m +no_defs";

if (typeof proj4 === "function") {
    proj4.defs("EPSG:2056", EPSG2056_DEF);
} else {
    console.error("proj4 is not loaded.");
}

/* ============================================================
   GLOBAL STATE
   ============================================================ */

let viewer = null;
let map = null;

let currentPointCloud = null;
let currentTile = null;
let currentTiles = [];
let currentSection = null;

const loadedPointClouds = new Map();
const tileLayers = new Map();

let selectedTileKey = null;
let swissImageProcessRunning = false;
var busyDepth = 0;
var busyCancel = null;
let swissImageColoring = false;

/* ============================================================
   SWISSIMAGE STATE
   ============================================================ */

const SWISSIMAGE_RGB = {
    layer: "ch.swisstopo.swissimage-product",

    /*
     * WMTS zoom level used for the SWISSIMAGE raster. Zoom 20 is
     * about the native 10 cm/pixel. Set from the UI slider
     * (see ui.js); lowered automatically if it would not fit in memory.
     */
    zoom: 19,

    tileSize: 256,

    cache: new Map(),
    raster: null,
    loading: false,

    processTimer: null
};

const swissImageBlockCaches = new WeakMap();

const SWISSIMAGE_BLOCK_SIZE = 256;
const SWISSIMAGE_MAX_CACHED_BLOCKS = 64;
const SWISSIMAGE_BATCH_SIZE = 10000;

/* ============================================================
   DOM / STATUS HELPERS
   ============================================================ */

function getEl(id) {
    return document.getElementById(id);
}

function setStatus(message) {
    const element = getEl("status");

    if (element) {
        element.textContent = message || "";
    }

    // while the app is locked, show the current step in the lock screen too
    if (busyDepth > 0) {
        const text = document.querySelector("#busy-overlay .busy-message");

        if (text) {
            text.textContent = message || "";
        }
    }

    console.log("[swiss-copc]", message);
}

/* ============================================================
   BUSY LOCK
   ============================================================ */

/*
 * While a LAS/LAZ tile is being loaded the whole app is locked: a full-screen
 * overlay blocks the mouse and the app container is made inert (no keyboard
 * or focus either). Otherwise the user could select another tile while the
 * first one is still being decoded and the colours would no longer match.
 *
 * setBusy(true, ...) / setBusy(false) calls nest; always unlock in a finally.
 * An optional cancel callback adds a "Cancel" button (the only way out).
 */
function ensureBusyOverlay() {
    let overlay = document.getElementById("busy-overlay");

    if (overlay) {
        return overlay;
    }

    const style = document.createElement("style");

    style.textContent = `
        #busy-overlay {
            position: fixed;
            inset: 0;
            z-index: 9000;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0, 0, 0, 0.6);
            cursor: progress;
        }
        #busy-overlay[hidden] { display: none; }
        #busy-overlay .busy-card {
            width: min(420px, calc(100vw - 32px));
            padding: 22px 24px;
            border: 1px solid #262626;
            border-radius: 10px;
            background: #050505;
            color: #ececec;
            font: 13px/1.45 var(--font, system-ui, sans-serif);
            text-align: center;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.7);
        }
        #busy-overlay .busy-spinner {
            width: 26px;
            height: 26px;
            margin: 0 auto 12px;
            border: 3px solid #333;
            border-top-color: var(--accent, #2c6fd8);
            border-radius: 50%;
            animation: busy-spin 0.8s linear infinite;
        }
        #busy-overlay .busy-title { font-size: 15px; font-weight: 600; }
        #busy-overlay .busy-message { margin-top: 6px; color: #c4c4c4; min-height: 1.4em; word-break: break-word; }
        #busy-overlay .busy-hint { margin-top: 8px; color: #8c8c8c; font-size: 11px; }
        #busy-overlay .busy-cancel {
            margin-top: 14px;
            height: 32px;
            padding: 0 14px;
            border: 1px solid #2c2c2c;
            border-radius: 5px;
            background: #1f1f1f;
            color: #ececec;
            font: inherit;
            font-weight: 600;
            cursor: pointer;
        }
        #busy-overlay .busy-cancel:hover { background: #2c2c2c; }
        #busy-overlay .busy-cancel[hidden] { display: none; }
        @keyframes busy-spin { to { transform: rotate(360deg); } }
    `;

    document.head.appendChild(style);

    overlay = document.createElement("div");
    overlay.id = "busy-overlay";
    overlay.hidden = true;
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-live", "assertive");
    overlay.setAttribute("aria-label", "Loading, please wait");

    overlay.innerHTML = `
        <div class="busy-card">
            <div class="busy-spinner"></div>
            <div class="busy-title">Please wait</div>
            <div class="busy-message"></div>
            <div class="busy-hint">The app is locked until loading has finished.</div>
            <button type="button" class="busy-cancel" hidden>Cancel loading</button>
        </div>
    `;

    overlay.querySelector(".busy-cancel").addEventListener("click", () => {
        if (typeof busyCancel === "function") {
            busyCancel();
        }
    });

    document.body.appendChild(overlay);

    return overlay;
}

function setBusy(active, message, onCancel) {
    const overlay = ensureBusyOverlay();

    busyDepth = Math.max(0, busyDepth + (active ? 1 : -1));

    const on = busyDepth > 0;

    if (active && typeof onCancel === "function") {
        busyCancel = onCancel;
    }

    if (!on) {
        busyCancel = null;
    }

    overlay.hidden = !on;

    const text = overlay.querySelector(".busy-message");
    const cancel = overlay.querySelector(".busy-cancel");

    if (on && message && text) {
        text.textContent = message;
    }

    if (cancel) {
        cancel.hidden = !(on && busyCancel);
    }

    const app = getEl("app");

    if (app) {
        app.inert = on;
    }
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/* ============================================================
   INITIALIZATION
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {
    initPotree();
    initMap();
    initUI();
    updateControlState();
    setStatus("Ready");
});

/* ============================================================
   POTREE
   ============================================================ */

function initPotree() {
    const renderArea = getEl("potree_render_area");

    if (!renderArea) {
        console.error("Missing #potree_render_area");
        return;
    }

    if (typeof Potree === "undefined") {
        console.error("Potree is not loaded.");
        return;
    }

    viewer = new Potree.Viewer(renderArea);

    try {
        viewer.setBackground("black");
    } catch (error) {
        console.warn("Could not set Potree background:", error);
    }

    viewer.setEDLEnabled(true);
    viewer.setFOV(60);
    viewer.setPointBudget(CONFIG.POINT_BUDGET || 20000000);

    try {
        viewer.setClipTask(Potree.ClipTask.NONE);
    } catch (error) {
        console.warn(error);
    }
}

/* ============================================================
   LEAFLET
   ============================================================ */

function initMap() {
    if (typeof L === "undefined") {
        console.error("Leaflet is not loaded.");
        return;
    }

    map = L.map("map", {
        zoomControl: true,
        attributionControl: true,
        preferCanvas: true
    }).setView(CONFIG.MAP_CENTER, CONFIG.MAP_ZOOM);

    map.createPane("tileFootprints");
    map.getPane("tileFootprints").style.zIndex = 700;

    map.createPane("tileHighlight");
    map.getPane("tileHighlight").style.zIndex = 710;

    const swissTopo = L.tileLayer(
        "https://wmts.geo.admin.ch/1.0.0/" +
        "ch.swisstopo.pixelkarte-farbe/" +
        "default/current/3857/{z}/{x}/{y}.jpeg",
        {
            maxZoom: 20,
            attribution: "© swisstopo"
        }
    );

    const swissTopoGrey = L.tileLayer(
        "https://wmts.geo.admin.ch/1.0.0/" +
        "ch.swisstopo.pixelkarte-grau/" +
        "default/current/3857/{z}/{x}/{y}.jpeg",
        {
            maxZoom: 20,
            attribution: "© swisstopo"
        }
    );

    const swissImage = L.tileLayer(
        "https://wmts.geo.admin.ch/1.0.0/" +
        "ch.swisstopo.swissimage-product/" +
        "default/current/3857/{z}/{x}/{y}.jpeg",
        {
            maxZoom: 20,
            attribution: "© swisstopo"
        }
    );

    swissTopoGrey.addTo(map);

    L.control.layers(
        {
            "SwissTopo": swissTopo,
            "SwissTopo grey": swissTopoGrey,
            "SWISSIMAGE": swissImage
        },
        null,
        {
            collapsed: true,
            position: "topright"
        }
    ).addTo(map);
}

/* ============================================================
   UI
   ============================================================ */

function initUI() {
    getEl("findTilesButton")?.addEventListener(
        "click",
        findTilesFromMap
    );

    getEl("fitButton")?.addEventListener(
        "click",
        fitCurrentPointCloud
    );

    getEl("clearButton")?.addEventListener(
        "click",
        clearAllPointClouds
    );

    getEl("search-button")?.addEventListener(
        "click",
        searchPlace
    );

    getEl("search-input")?.addEventListener(
        "keydown",
        event => {
            if (event.key === "Enter") {
                searchPlace();
            }
        }
    );

    getEl("color-mode")?.addEventListener(
        "change",
        event => {
            if (currentPointCloud) {
                applyColorMode(
                    currentPointCloud,
                    event.target.value
                );
            }
        }
    );

    getEl("horizontal-section-button")?.addEventListener(
        "click",
        () => createSection("horizontal")
    );

    getEl("vertical-section-button")?.addEventListener(
        "click",
        () => createSection("vertical")
    );

    getEl("clear-section-button")?.addEventListener(
        "click",
        clearSection
    );

    getEl("load-button")?.addEventListener(
        "click",
        loadSelectedTile
    );

    getEl("unload-button")?.addEventListener(
        "click",
        unloadCurrentPointCloud
    );

    getEl("download-button")?.addEventListener(
        "click",
        downloadCurrentTile
    );
}

function updateControlState() {
    const hasTile = !!currentTile;
    const hasPointCloud = !!currentPointCloud;
    const hasSection = !!currentSection;

    const loadButton = getEl("load-button");
    const unloadButton = getEl("unload-button");
    const downloadButton = getEl("download-button");
    const horizontalButton = getEl("horizontal-section-button");
    const verticalButton = getEl("vertical-section-button");
    const clearSectionButton = getEl("clear-section-button");
    const colorMode = getEl("color-mode");

    if (loadButton) {
        loadButton.disabled = !hasTile || hasPointCloud;
    }

    if (unloadButton) {
        unloadButton.disabled = !hasPointCloud;
    }

    if (downloadButton) {
        downloadButton.disabled =
            !hasTile || !getCopcUrl(currentTile);
    }

    if (horizontalButton) {
        horizontalButton.disabled = !hasPointCloud;
    }

    if (verticalButton) {
        verticalButton.disabled = !hasPointCloud;
    }

    if (clearSectionButton) {
        clearSectionButton.disabled = !hasSection;
    }

    if (colorMode) {
        colorMode.disabled = !hasPointCloud;
    }

    if (typeof window.updateExportButtons === "function") {
        window.updateExportButtons();
    }

    if (typeof window.updateSwissInfo === "function") {
        window.updateSwissInfo();
    }
}

/* ============================================================
   STAC SEARCH
   ============================================================ */

async function findTilesFromMap() {
    if (!map) {
        setStatus("Map is not available.");
        return;
    }

    const bounds = map.getBounds();

    const bbox = [
        bounds.getWest(),
        bounds.getSouth(),
        bounds.getEast(),
        bounds.getNorth()
    ];

    setStatus("Searching swissSURFACE3D tiles…");

    try {
        const url = new URL(`${CONFIG.STAC_ROOT}/search`);

        url.searchParams.set("collections", CONFIG.COLLECTION);
        url.searchParams.set("bbox", bbox.join(","));
        url.searchParams.set("limit", "100");

        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(
                `STAC request failed: ${response.status}`
            );
        }

        const data = await response.json();

        const found = Array.isArray(data.features)
            ? data.features
            : [];

        const preferred = preferCopcTiles(found);

        currentTiles = preferred.tiles;

        renderTiles();

        setStatus(
            `${currentTiles.length} tile(s) found` +
            (preferred.hidden
                ? ` (${preferred.hidden} older non-COPC version(s) hidden where a COPC file exists)`
                : "") +
            "."
        );
    } catch (error) {
        console.error("Tile search failed:", error);
        setStatus(`Tile search failed: ${error.message}`);
    }
}

/* ============================================================
   TILE RENDERING
   ============================================================ */

function renderTiles() {
    const list = getEl("tile-list");
    const count = getEl("tile-count");

    if (list) {
        list.innerHTML = "";
    }

    if (count) {
        count.textContent = String(currentTiles.length);
    }

    for (const layer of tileLayers.values()) {
        if (map && map.hasLayer(layer)) {
            map.removeLayer(layer);
        }
    }

    tileLayers.clear();
    selectedTileKey = null;

    const footprintLayers = [];

    currentTiles.forEach((tile, index) => {
        const layer = renderTileOnMap(tile, index);

        if (layer) {
            footprintLayers.push(layer);
        }

        renderTileInList(tile, index);
    });

    if (footprintLayers.length && map) {
        const group = L.featureGroup(footprintLayers);
        map.fitBounds(group.getBounds().pad(0.05));
    }
}

function renderTileOnMap(tile, index) {
    const geometry = geometryFromTile(tile);

    if (!geometry) {
        return null;
    }

    const key = tileKey(tile, index);

    const layer = L.geoJSON(geometry, {
        pane: "tileFootprints",
        interactive: true,
        style: {
            color: "#0066ff",
            weight: 3,
            opacity: 1,
            fillColor: "#1683ff",
            fillOpacity: 0.28
        }
    });

    layer.addTo(map);

    layer.on("click", event => {
        L.DomEvent.stopPropagation(event);
        selectTile(tile, index);
    });

    layer.on("mouseover", () => {
        if (selectedTileKey !== key) {
            layer.setStyle({
                color: "#00a8ff",
                weight: 4,
                fillColor: "#1683ff",
                fillOpacity: 0.40
            });
        }

        layer.bringToFront();
    });

    layer.on("mouseout", () => {
        if (selectedTileKey !== key) {
            layer.setStyle({
                color: "#0066ff",
                weight: 3,
                fillColor: "#1683ff",
                fillOpacity: 0.28
            });
        }
    });

    tileLayers.set(key, layer);

    return layer;
}

function geometryFromTile(tile) {
    if (
        Array.isArray(tile?.bbox) &&
        tile.bbox.length >= 4
    ) {
        const [west, south, east, north] = tile.bbox;

        return {
            type: "Polygon",
            coordinates: [[
                [west, south],
                [east, south],
                [east, north],
                [west, north],
                [west, south]
            ]]
        };
    }

    return tile?.geometry || null;
}

function tileKey(tile, index) {
    return (
        tile?.id ||
        tile?.properties?.id ||
        tile?.properties?.title ||
        tile?.properties?.name ||
        `tile-${index}`
    );
}

function renderTileInList(tile, index) {
    const list = getEl("tile-list");

    if (!list) {
        return;
    }

    const item = document.createElement("button");

    item.type = "button";
    item.className = "tile-item";
    item.dataset.key = tileKey(tile, index);

    item.textContent =
        tile?.properties?.title ||
        tile?.id ||
        `Tile ${index + 1}`;

    item.addEventListener(
        "click",
        () => selectTile(tile, index)
    );

    list.appendChild(item);
}

/* ============================================================
   TILE SELECTION
   ============================================================ */

function selectTile(tile, index = 0) {
    const key = tileKey(tile, index);

    if (
        selectedTileKey &&
        tileLayers.has(selectedTileKey)
    ) {
        tileLayers.get(selectedTileKey).setStyle({
            weight: 3,
            color: "#0066ff",
            fillColor: "#1683ff",
            fillOpacity: 0.28
        });
    }

    selectedTileKey = key;

    document.querySelectorAll("#tile-list .tile-item").forEach(el => {
        el.classList.toggle("selected", el.dataset.key === key);
    });

    const layer = tileLayers.get(key);

    if (layer) {
        layer.setStyle({
            weight: 5,
            color: "#ff8c00",
            fillColor: "#ffb000",
            fillOpacity: 0.38
        });

        layer.bringToFront();

        try {
            map.fitBounds(layer.getBounds().pad(0.10));
        } catch (error) {
            console.warn(error);
        }
    }

    if (
        currentPointCloud &&
        currentTile &&
        getCopcUrl(currentTile) !== getCopcUrl(tile)
    ) {
        setStatus(
            "Unload the current point cloud before loading another tile."
        );
        return;
    }

    currentTile = tile;

    if (
        SWISSIMAGE_RGB.raster &&
        SWISSIMAGE_RGB.raster.tileKey !== key
    ) {
        SWISSIMAGE_RGB.raster = null;
    }

    updateSelectedPanel(tile);
    updateControlState();

    loadSelectedTile();
}

function updateSelectedPanel(tile) {
    const title = getEl("selected-title");
    const info = getEl("selected-info");
    const attributes = getEl("asset-list");

    const tileName =
        tile?.properties?.title ||
        tile?.id ||
        "Selected tile";

    if (title) {
        title.textContent = tileName;
    }

    if (info) {
        const bbox = tile?.bbox;

        if (
            Array.isArray(bbox) &&
            bbox.length >= 4
        ) {
            info.textContent =
                `BBOX: ${bbox[0].toFixed(5)}, ` +
                `${bbox[1].toFixed(5)} → ` +
                `${bbox[2].toFixed(5)}, ` +
                `${bbox[3].toFixed(5)}`;
        } else {
            info.textContent = "Tile selected.";
        }
    }

    if (attributes) {
        attributes.innerHTML = "";

        const assets = tile?.assets || {};

        for (const [key, asset] of Object.entries(assets)) {
            const row = document.createElement("div");

            row.className = "attribute-item";

            row.innerHTML =
                `<strong>${escapeHtml(key)}</strong>` +
                `<span>${escapeHtml(asset?.type || "")}</span>`;

            if (asset?.href) {
                row.title = asset.href;
            }

            attributes.appendChild(row);
        }
    }
}

/* ============================================================
   COPC
   ============================================================ */

/*
 * Which file of a STAC item to use. COPC always wins; the older deliveries
 * (.laz, then .las.zip / .las) are only used when the item has no COPC file.
 *
 *   0  file name ends in .copc / .copc.laz
 *   1  (not a zip) key, type or role mentions "copc"
 *   2  plain .laz
 *   3  .las / .las.zip / .laz.zip
 */
function pickTileAsset(tile) {
    if (!tile?.assets) {
        return { href: null, rank: Infinity };
    }

    let bestHref = null;
    let bestRank = Infinity;

    for (const [key, asset] of Object.entries(tile.assets)) {
        const href = asset?.href || "";

        if (!href) {
            continue;
        }

        const roles = Array.isArray(asset?.roles) ? asset.roles : [];

        const text =
            `${key} ${href} ${asset?.type || ""} ${roles.join(" ")}`
                .toLowerCase();

        const isZip = /\.zip($|\?)/i.test(href);

        let rank = Infinity;

        if (/\.copc(\.laz)?($|\?)/i.test(href)) {
            rank = 0;
        } else if (!isZip && text.includes("copc")) {
            rank = 1;
        } else if (/\.laz($|\?)/i.test(href)) {
            rank = 2;
        } else if (/\.la[sz](\.zip)?($|\?)/i.test(href)) {
            rank = 3;
        }

        if (rank < bestRank) {
            bestRank = rank;
            bestHref = href;
        }
    }

    return { href: bestHref, rank: bestRank };
}

function getCopcUrl(tile) {
    return pickTileAsset(tile).href;
}

/* 0 = COPC, 1 = LAZ, 2 = LAS/ZIP, 99 = no point-cloud file */
function tileSourceRank(tile) {
    const { href, rank } = pickTileAsset(tile);

    if (!href) {
        return 99;
    }

    // the same decision that picked the file decides how it is loaded
    return rank <= 1 ? 0 : rank - 1;
}

/* Items of the same 1 km tile (e.g. different years) share a footprint. */
function tileFootprintKey(tile) {
    const bbox = tile?.bbox;

    if (Array.isArray(bbox) && bbox.length >= 4) {
        return bbox.slice(0, 4).map(v => Number(v).toFixed(4)).join(",");
    }

    const match = String(tile?.id || "").match(/(\d{4}-\d{4})/);

    return match ? match[1] : String(tile?.id || Math.random());
}

/*
 * Where a tile exists as COPC, drop the other (older, non-COPC) items of the
 * same footprint. Without this the overlapping footprints on the map can
 * make a click select the old .las.zip item instead of the COPC one.
 */
function preferCopcTiles(tiles) {
    const withCopc = new Set();

    for (const tile of tiles) {
        if (tileSourceRank(tile) === 0) {
            withCopc.add(tileFootprintKey(tile));
        }
    }

    const kept = tiles.filter(tile =>
        tileSourceRank(tile) === 0 ||
        !withCopc.has(tileFootprintKey(tile))
    );

    return { tiles: kept, hidden: tiles.length - kept.length };
}

/* COPC streams through Potree; plain LAZ is decoded by laz.js. */
function isCopcUrl(url) {
    const text = String(url || "");

    return !/\.zip($|\?)/i.test(text) && /copc/i.test(text);
}

async function loadSelectedTile() {
    if (!currentTile) {
        setStatus("Select a tile first.");
        return;
    }

    if (currentPointCloud) {
        updateControlState();
        return;
    }

    const copcUrl = getCopcUrl(currentTile);

    if (!copcUrl) {
        setStatus("No COPC asset was found for this tile.");
        return;
    }

    // Tiles without a COPC asset: plain LAZ file (see laz.js).
    if (tileSourceRank(currentTile) !== 0) {
        if (typeof window.loadLazTile !== "function") {
            setStatus("LAZ support (laz.js) is not loaded.");
            return;
        }

        await window.loadLazTile(copcUrl);
        return;
    }

    setStatus("Loading COPC…");

    if (loadedPointClouds.has(copcUrl)) {
        currentPointCloud = loadedPointClouds.get(copcUrl);

        configurePointCloud(currentPointCloud);
        showPointCloudInfo(currentPointCloud);
        fitCurrentPointCloud();
        updateControlState();

        setStatus("Tile already loaded.");

        return;
    }

    enforcePointCloudLimit();

    try {
        await new Promise((resolve, reject) => {
            Potree.loadPointCloud(
                copcUrl,
                currentTile.id || "swissSURFACE3D",
                event => {
                    if (!event || !event.pointcloud) {
                        reject(
                            new Error(
                                "Potree did not return a point cloud."
                            )
                        );
                        return;
                    }

                    const pointcloud = event.pointcloud;

                    configurePointCloud(pointcloud);
                    viewer.scene.addPointCloud(pointcloud);

                    loadedPointClouds.set(
                        copcUrl,
                        pointcloud
                    );

                    currentPointCloud = pointcloud;

                    showPointCloudInfo(pointcloud);
                    fitCurrentPointCloud();
                    updateControlState();

                    setStatus("COPC loaded.");

                    resolve();
                }
            );
        });
    } catch (error) {
        console.error("COPC loading failed:", error);

        setStatus(
            `COPC loading failed: ${error.message}`
        );

        updateControlState();
    }
}

/* ============================================================
   POINT CLOUD CONFIGURATION
   ============================================================ */

function configurePointCloud(pointcloud) {
    const material = pointcloud?.material;

    if (!material) {
        return;
    }

    if (
        Potree.PointShape &&
        Potree.PointShape.CIRCLE !== undefined
    ) {
        material.shape = Potree.PointShape.CIRCLE;
    }

    material.size = 1.5;

    if (
        Potree.PointSizeType &&
        Potree.PointSizeType.ADAPTIVE !== undefined
    ) {
        material.pointSizeType =
            Potree.PointSizeType.ADAPTIVE;
    }

    if ("intensityRange" in material) {
        material.intensityRange = [0, 65535];
    }

    material.opacity = 1.0;

    installSwissNodeHook(pointcloud);

    applyColorMode(pointcloud, "intensity");
    refreshPointCloudMaterial(pointcloud);

    // Apply the user's appearance settings (point size, shape, opacity, ...).
    if (typeof window.applyAppearance === "function") {
        window.applyAppearance(pointcloud);
    }
}

function refreshPointCloudMaterial(pointcloud) {
    const material = pointcloud?.material;

    if (!material) {
        return;
    }

    try {
        if (
            typeof material.updateShaderSource ===
            "function"
        ) {
            material.updateShaderSource();
        }
    } catch (error) {
        console.warn(
            "Could not refresh Potree shader:",
            error
        );
    }

    material.needsUpdate = true;
}

/* ============================================================
   COLOR MODES
   ============================================================ */

function applyColorMode(pointcloud, mode) {
    // Plain LAZ clouds are rendered by laz.js, not by Potree's material.
    if (pointcloud?.isLaz) {
        stopSwissImageProcessing();
        updateDisplayedColorMode(mode);
        void pointcloud.lazSetColorMode(mode);
        return;
    }

    if (!pointcloud?.material) {
        return;
    }

    const material = pointcloud.material;

    if (mode === "swissimage") {
        material.activeAttributeName = "rgba";

        refreshPointCloudMaterial(pointcloud);
        updateDisplayedColorMode("swissimage");

        if (!SWISSIMAGE_RGB.processTimer) {
            startSwissImageProcessing();
        }

        return;
    }

    /*
     * Stop the SWISSIMAGE worker loop when switching away
     * from SWISSIMAGE. The generated color attribute remains
     * on the geometry and can be reused if SWISSIMAGE is
     * selected again.
     */
    stopSwissImageProcessing();

    material.activeAttributeName = null;

    switch (mode) {
        case "intensity":
            material.activeAttributeName = "intensity";
            material.intensityRange = [0, 65535];
            setPointColorType(material, "INTENSITY");
            break;

        case "intensity-gradient":
            material.activeAttributeName = "intensity";
            material.intensityRange = [0, 65535];
            setPointColorType(material, "INTENSITY_GRADIENT");
            break;

        case "classification":
            material.activeAttributeName = "classification";
            setPointColorType(material, "CLASSIFICATION");
            break;

        case "return-number":
            material.activeAttributeName = "returnNumber";
            setPointColorType(material, "RETURN_NUMBER");
            break;

        case "number-of-returns":
            material.activeAttributeName = "numberOfReturns";
            setPointColorType(material, "NUMBER_OF_RETURNS");
            break;

        case "source-id":
            material.activeAttributeName = "pointSourceID";
            setPointColorType(material, "SOURCE");
            break;

        case "elevation":
        default:
            material.activeAttributeName = null;
            setElevationColorType(material);
            setElevationRange(pointcloud);
            break;
    }

    refreshPointCloudMaterial(pointcloud);
    updateDisplayedColorMode(mode);
}

function setPointColorType(material, name) {
    if (!material) {
        return false;
    }

    /*
     * Potree 1.8 uses the PointColorType constants when
     * available. Some builds expose RGB differently, so
     * handle RGB explicitly.
     */
    if (name === "RGB") {
        material.pointColorType = "RGB";
        material.needsUpdate = true;
        return true;
    }

    if (!Potree.PointColorType) {
        return false;
    }

    if (
        Potree.PointColorType[name] === undefined
    ) {
        console.warn(
            `Potree.PointColorType.${name} is unavailable.`
        );
        return false;
    }

    material.pointColorType =
        Potree.PointColorType[name];

    material.needsUpdate = true;

    return true;
}

function setElevationColorType(material) {
    if (
        Potree.PointColorType?.ELEVATION !==
        undefined
    ) {
        material.pointColorType =
            Potree.PointColorType.ELEVATION;
        return;
    }

    if (
        Potree.PointColorType?.HEIGHT !==
        undefined
    ) {
        material.pointColorType =
            Potree.PointColorType.HEIGHT;
        return;
    }

    console.warn(
        "Potree has no ELEVATION/HEIGHT color mode."
    );
}

function setElevationRange(pointcloud) {
    const material = pointcloud?.material;

    if (!material || !pointcloud.boundingBox) {
        return;
    }

    const minZ = pointcloud.boundingBox.min.z;
    const maxZ = pointcloud.boundingBox.max.z;

    if (
        !Number.isFinite(minZ) ||
        !Number.isFinite(maxZ) ||
        maxZ <= minZ
    ) {
        return;
    }

    if ("elevationRange" in material) {
        material.elevationRange = [minZ, maxZ];
    }
}

function updateDisplayedColorMode(mode) {
    const selector = getEl("color-mode");

    if (selector && selector.value !== mode) {
        selector.value = mode;
    }
}

/* ============================================================
   POINT ATTRIBUTES
   ============================================================ */

function getPointAttributes(pointcloud) {
    const result = [];

    const pointAttributes =
        pointcloud?.pcoGeometry?.pointAttributes;

    if (!pointAttributes) {
        return result;
    }

    if (Array.isArray(pointAttributes.attributes)) {
        for (const attribute of pointAttributes.attributes) {
            if (!attribute) {
                continue;
            }

            result.push({
                name:
                    attribute.name ||
                    attribute.attributeName ||
                    "unknown",

                description:
                    attribute.description || "",

                type:
                    attribute.type || "",

                numElements:
                    attribute.numElements ||
                    attribute.numElementsPerPoint ||
                    ""
            });
        }
    }

    return result;
}

function showPointCloudInfo(pointcloud) {
    const attributes =
        getPointAttributes(pointcloud);

    updateSelectedAttributes(attributes);

    const selectedInfo = getEl("selected-info");

    if (selectedInfo) {
        const names = attributes.map(
            attribute => attribute.name
        );

        selectedInfo.textContent =
            names.length
                ? names.join(", ")
                : "Point cloud loaded";
    }
}

function updateSelectedAttributes(attributes) {
    const list = getEl("attribute-list");

    if (!list) {
        return;
    }

    list.innerHTML = "";

    if (!attributes?.length) {
        const item = document.createElement("div");

        item.className = "attribute-item";
        item.textContent =
            "No attribute metadata available.";

        list.appendChild(item);
        return;
    }

    for (const attribute of attributes) {
        const item = document.createElement("div");

        item.className = "attribute-item";

        const count = attribute.numElements
            ? ` × ${attribute.numElements}`
            : "";

        item.innerHTML =
            `<strong>${escapeHtml(attribute.name)}</strong>` +
            `<span>${escapeHtml(attribute.type)}` +
            `${escapeHtml(count)}</span>`;

        list.appendChild(item);
    }
}

/* ============================================================
   CAMERA / POINT CLOUD MANAGEMENT
   ============================================================ */

function fitCurrentPointCloud() {
    if (!viewer || !currentPointCloud) {
        return;
    }

    if (currentPointCloud.isLaz) {
        currentPointCloud.lazFit();
        return;
    }

    try {
        viewer.fitToScreen(
            0.5,
            500,
            currentPointCloud
        );
    } catch (error) {
        console.warn(
            "fitToScreen failed:",
            error
        );

        try {
            viewer.fitToScreen();
        } catch (secondError) {
            console.warn(
                "Fallback fit failed:",
                secondError
            );
        }
    }
}

function enforcePointCloudLimit() {
    const max =
        CONFIG.MAX_LOADED_POINTCLOUDS || 4;

    while (loadedPointClouds.size >= max) {
        const first =
            loadedPointClouds.entries().next();

        if (first.done) {
            break;
        }

        const [url, pointcloud] = first.value;

        unloadPointCloud(url, pointcloud);
    }
}

function stopSwissImageProcessing() {
    if (SWISSIMAGE_RGB.processTimer) {
        cancelAnimationFrame(SWISSIMAGE_RGB.processTimer);
        SWISSIMAGE_RGB.processTimer = null;
    }

    swissImageProcessRunning = false;
}

function unloadCurrentPointCloud() {
    if (!currentPointCloud) {
        setStatus("No point cloud loaded.");
        return;
    }

    stopSwissImageProcessing();

    let urlToRemove = null;

    for (const [url, pointcloud] of loadedPointClouds) {
        if (pointcloud === currentPointCloud) {
            urlToRemove = url;
            break;
        }
    }

    if (urlToRemove) {
        unloadPointCloud(
            urlToRemove,
            currentPointCloud
        );
    }

    currentPointCloud = null;

    clearSection();
    updateSelectedAttributes([]);
    updateControlState();

    setStatus("Point cloud unloaded.");
}

function unloadPointCloud(url, pointcloud) {
    try {
        if (
            pointcloud?.parent &&
            typeof pointcloud.parent.remove ===
            "function"
        ) {
            pointcloud.parent.remove(pointcloud);
        }
    } catch (error) {
        console.warn(
            "Could not remove point cloud:",
            error
        );
    }

    pointcloud?.lazDispose?.();

    loadedPointClouds.delete(url);

    if (currentPointCloud === pointcloud) {
        currentPointCloud = null;
    }
}

function clearAllPointClouds() {
    stopSwissImageProcessing();
    clearSection();

    for (const pointcloud of loadedPointClouds.values()) {
        try {
            if (
                pointcloud?.parent &&
                typeof pointcloud.parent.remove ===
                "function"
            ) {
                pointcloud.parent.remove(pointcloud);
            }
        } catch (error) {
            console.warn(error);
        }
    }

    for (const pointcloud of loadedPointClouds.values()) {
        pointcloud?.lazDispose?.();
    }

    loadedPointClouds.clear();

    currentPointCloud = null;
    currentTile = null;

    SWISSIMAGE_RGB.raster = null;
    SWISSIMAGE_RGB.cache.clear();

    selectedTileKey = null;

    updateSelectedAttributes([]);

    const selectedTitle =
        getEl("selected-title");

    const selectedInfo =
        getEl("selected-info");

    if (selectedTitle) {
        selectedTitle.textContent =
            "No tile selected";
    }

    if (selectedInfo) {
        selectedInfo.textContent = "";
    }

    updateControlState();

    setStatus("All point clouds cleared.");
}

/* ============================================================
   SECTIONS
   ============================================================ */

function getPointCloudBounds() {
    if (
        !currentPointCloud ||
        !currentPointCloud.boundingBox
    ) {
        return null;
    }

    const box = currentPointCloud.boundingBox;
    const min = box.min.clone();
    const max = box.max.clone();

    return {
        min,
        max,
        size: max.clone().sub(min),
        center: min.clone().add(max).multiplyScalar(0.5)
    };
}


function createSection(type) {
    if (!currentPointCloud) {
        setStatus("Load a point cloud first.");
        return;
    }

    clearSection();

    const bounds = getPointCloudBounds();

    if (!bounds) {
        setStatus(
            "Point-cloud bounds are unavailable."
        );
        return;
    }

    const volume = new Potree.BoxVolume();

    volume.name =
        type === "horizontal"
            ? "Horizontal section"
            : "Vertical section";

    volume.clip = true;
    volume.visible = true;

    const size = bounds.size.clone();

    const minimumThickness =
        Math.max(
            Math.min(size.x, size.y, size.z) * 0.005,
            0.1
        );

    if (type === "horizontal") {
        volume.scale.set(
            Math.max(size.x, minimumThickness),
            Math.max(size.y, minimumThickness),
            Math.max(size.z * 0.02, minimumThickness)
        );
    } else {
        volume.scale.set(
            Math.max(size.x * 0.02, minimumThickness),
            Math.max(size.y, minimumThickness),
            Math.max(size.z, minimumThickness)
        );
    }

    volume.position.set(
        bounds.center.x,
        bounds.center.y,
        bounds.center.z
    );

    viewer.scene.addVolume(volume);

    try {
        viewer.setClipTask(
            Potree.ClipTask.SHOW_INSIDE
        );
    } catch (error) {
        console.warn(
            "Could not set SHOW_INSIDE:",
            error
        );
    }

    currentSection = {
        type,
        volume,
        bounds
    };

    createSectionControls();
    updateSectionInfo();
    updateControlState();

    setStatus(
        type === "horizontal"
            ? "Horizontal section enabled."
            : "Vertical section enabled."
    );

    window.usageCounter?.hit("sections");
}

function createSectionControls() {
    const container = getEl("section-info");

    if (!container || !currentSection) {
        return;
    }

    const bounds = currentSection.bounds;
    const controls =
        document.createElement("div");

    controls.className = "section-control";

    if (currentSection.type === "horizontal") {
        const min = bounds.min.z;
        const max = bounds.max.z;
        const value =
            currentSection.volume.position.z;

        controls.innerHTML = `
            <div class="section-type">
                Horizontal section
            </div>

            <label>
                Height
                <span id="section-position-value">
                    ${value.toFixed(2)} m
                </span>
            </label>

            <input
                id="section-position"
                type="range"
                min="${min}"
                max="${max}"
                step="${Math.max((max - min) / 1000, 0.01)}"
                value="${value}"
            >

            <label>
                Thickness
                <span id="section-thickness-value">
                    ${currentSection.volume.scale.z.toFixed(2)} m
                </span>
            </label>

            <input
                id="section-thickness"
                type="range"
                min="${Math.max((max - min) / 1000, 0.01)}"
                max="${Math.max((max - min) * 0.25, 0.1)}"
                step="${Math.max((max - min) / 1000, 0.01)}"
                value="${currentSection.volume.scale.z}"
            >
        `;
    } else {
        const min = bounds.min.x;
        const max = bounds.max.x;
        const value =
            currentSection.volume.position.x;

        controls.innerHTML = `
            <div class="section-type">
                Vertical section
            </div>

            <label>
                Position X
                <span id="section-position-value">
                    ${value.toFixed(2)} m
                </span>
            </label>

            <input
                id="section-position"
                type="range"
                min="${min}"
                max="${max}"
                step="${Math.max((max - min) / 1000, 0.01)}"
                value="${value}"
            >

            <label>
                Thickness
                <span id="section-thickness-value">
                    ${currentSection.volume.scale.x.toFixed(2)} m
                </span>
            </label>

            <input
                id="section-thickness"
                type="range"
                min="${Math.max((max - min) / 1000, 0.01)}"
                max="${Math.max((max - min) * 0.25, 0.1)}"
                step="${Math.max((max - min) / 1000, 0.01)}"
                value="${currentSection.volume.scale.x}"
            >
        `;
    }

    container.innerHTML = "";
    container.appendChild(controls);

    getEl("section-position")?.addEventListener(
        "input",
        updateSectionFromControls
    );

    getEl("section-thickness")?.addEventListener(
        "input",
        updateSectionFromControls
    );
}

function updateSectionFromControls() {
    if (!currentSection) {
        return;
    }

    const positionSlider =
        getEl("section-position");

    const thicknessSlider =
        getEl("section-thickness");

    if (!positionSlider) {
        return;
    }

    const position =
        Number(positionSlider.value);

    const thickness =
        Number(thicknessSlider?.value || 1);

    const volume =
        currentSection.volume;

    if (currentSection.type === "horizontal") {
        volume.position.z = position;
        volume.scale.z = thickness;
    } else {
        volume.position.x = position;
        volume.scale.x = thickness;
    }

    updateSectionInfo();
}

function updateSectionInfo() {
    if (!currentSection) {
        return;
    }

    const volume =
        currentSection.volume;

    const positionValue =
        getEl("section-position-value");

    const thicknessValue =
        getEl("section-thickness-value");

    if (positionValue) {
        const value =
            currentSection.type === "horizontal"
                ? volume.position.z
                : volume.position.x;

        positionValue.textContent =
            `${value.toFixed(2)} m`;
    }

    if (thicknessValue) {
        const value =
            currentSection.type === "horizontal"
                ? volume.scale.z
                : volume.scale.x;

        thicknessValue.textContent =
            `${value.toFixed(2)} m`;
    }
}

function clearSection() {
    if (!viewer) {
        return;
    }

    if (currentSection?.volume) {
        const volume =
            currentSection.volume;

        try {
            if (
                typeof viewer.scene.removeVolume ===
                "function"
            ) {
                viewer.scene.removeVolume(volume);
            } else if (viewer.scene.volumes) {
                const index =
                    viewer.scene.volumes.indexOf(volume);

                if (index !== -1) {
                    viewer.scene.volumes.splice(index, 1);
                }

                if (volume.parent) {
                    volume.parent.remove(volume);
                }
            }
        } catch (error) {
            console.warn(
                "Could not remove section:",
                error
            );
        }
    }

    currentSection = null;

    try {
        viewer.setClipTask(
            Potree.ClipTask.NONE
        );
    } catch (error) {
        console.warn(error);
    }

    const sectionInfo =
        getEl("section-info");

    if (sectionInfo) {
        sectionInfo.innerHTML =
            "No section active.";
    }

    updateControlState();
}

/* ============================================================
   SWISSIMAGE PROCESSING
   ============================================================ */

/*
 * Colouring runs inside a requestAnimationFrame loop with a small
 * time budget per frame. Each Potree node is coloured in one go
 * (no async pauses), so new nodes get their colour within a frame
 * or two and the viewer stays responsive. Nodes that are loaded
 * but currently outside the view are coloured in the background,
 * so turning the camera does not show uncoloured points.
 */

const SWISSIMAGE_FRAME_BUDGET_MS = 8;

function startSwissImageProcessing() {
    if (!currentPointCloud || !currentTile) {
        return;
    }

    if (SWISSIMAGE_RGB.processTimer) {
        return;
    }

    SWISSIMAGE_RGB.processTimer =
        requestAnimationFrame(swissImageFrameLoop);

    void ensureSwissImageRaster();
}

function swissImageFrameLoop() {
    if (!SWISSIMAGE_RGB.processTimer) {
        return;
    }

    try {
        swissImageFrame();
    } catch (error) {
        console.error("[swiss-copc] SWISSIMAGE RGB failed:", error);
        setStatus(`SWISSIMAGE RGB failed: ${error.message}`);
        SWISSIMAGE_RGB.processTimer = null;
        return;
    }

    SWISSIMAGE_RGB.processTimer =
        requestAnimationFrame(swissImageFrameLoop);
}

function swissImageRasterIsCurrent() {
    const raster = SWISSIMAGE_RGB.raster;

    return !!(
        raster &&
        currentTile &&
        raster.tileKey === tileKey(currentTile, 0) &&
        raster.requestedZoom === SWISSIMAGE_RGB.zoom
    );
}

async function ensureSwissImageRaster() {
    if (swissImageProcessRunning || swissImageRasterIsCurrent()) {
        return;
    }

    swissImageProcessRunning = true;

    try {
        setStatus("Preparing SWISSIMAGE…");
        await prepareSwissImageRaster();
    } catch (error) {
        console.error("[swiss-copc] SWISSIMAGE raster failed:", error);
        setStatus(`SWISSIMAGE RGB failed: ${error.message}`);
        stopSwissImageProcessing();
    } finally {
        swissImageProcessRunning = false;
    }
}

function swissImageFrame() {
    const selector = getEl("color-mode");

    if (
        !currentPointCloud ||
        !currentTile ||
        (selector && selector.value !== "swissimage")
    ) {
        return;
    }

    if (!swissImageRasterIsCurrent()) {
        void ensureSwissImageRaster();
        return;
    }

    const raster = SWISSIMAGE_RGB.raster;
    const mapper = getSwissMapper(raster);
    const start = performance.now();

    let pendingVisible = false;

    // 1. nodes in view first
    const visible = currentPointCloud.visibleNodes;

    if (Array.isArray(visible)) {
        for (const node of visible) {
            const sceneNode = node?.sceneNode;

            if (!swissNodeNeedsColor(sceneNode, raster)) {
                continue;
            }

            if (performance.now() - start > SWISSIMAGE_FRAME_BUDGET_MS) {
                pendingVisible = true;
                break;
            }

            colorNodeSync(sceneNode, raster, mapper, node);
        }
    }

    if (pendingVisible) {
        return;
    }

    // 2. then every other loaded node, once per raster
    if (!raster.treeDone) {
        let pendingOther = false;

        forEachLoadedTreeNode(currentPointCloud, node => {
            const sceneNode = node.sceneNode;

            if (!swissNodeNeedsColor(sceneNode, raster)) {
                return true;
            }

            if (performance.now() - start > SWISSIMAGE_FRAME_BUDGET_MS) {
                pendingOther = true;
                return false;   // stop, continue next frame
            }

            colorNodeSync(sceneNode, raster, mapper, node);
            return true;
        });

        if (!pendingOther) {
            raster.treeDone = true;
        }
    }

    if (!raster.announced) {
        raster.announced = true;

        const stats = raster.stats;
        const outside = stats.points
            ? (100 * stats.outside) / stats.points
            : 0;

        setStatus(
            "SWISSIMAGE RGB applied" +
            (outside > 1
                ? ` (${outside.toFixed(1)} % of points fall outside the raster)`
                : "") +
            swissTileNote(raster) +
            "."
        );
    }
}

function swissTileNote(raster) {
    const parts = [];

    if (raster.fallbackTiles) {
        parts.push(`${raster.fallbackTiles} map tile(s) were taken from a lower zoom`);
    }

    if (raster.failedTiles) {
        parts.push(`${raster.failedTiles} map tile(s) could not be loaded (grey)`);
    }

    return parts.length ? `; ${parts.join(", ")}` : "";
}

/*
 * Potree keeps a node's children in an object keyed by child index
 * (not an array), and entries can still be unloaded geometry nodes.
 * The callback returns false to stop the walk.
 */
function forEachLoadedTreeNode(pointcloud, callback) {
    const stack = [pointcloud?.root];

    while (stack.length) {
        const node = stack.pop();

        if (!node) {
            continue;
        }

        if (node.sceneNode && callback(node) === false) {
            return;
        }

        const children = node.children;

        if (Array.isArray(children)) {
            for (const child of children) {
                if (child) stack.push(child);
            }
        } else if (children && typeof children === "object") {
            for (const child of Object.values(children)) {
                if (child) stack.push(child);
            }
        }
    }
}

/*
 * Colour every Potree node the moment it is created, BEFORE its first
 * render. Points therefore never appear uncoloured, and nothing has to
 * be re-uploaded to the GPU afterwards. The frame loop above is only a
 * safety net (for nodes created while the raster was still loading, or
 * while another colour mode was active).
 */
function installSwissNodeHook(pointcloud) {
    if (
        !pointcloud ||
        pointcloud.__swissNodeHook ||
        typeof pointcloud.toTreeNode !== "function"
    ) {
        return;
    }

    pointcloud.__swissNodeHook = true;

    const original = pointcloud.toTreeNode;

    pointcloud.toTreeNode = function (geometryNode, parent) {
        const node = original.call(this, geometryNode, parent);

        try {
            if (
                pointcloud === currentPointCloud &&
                getEl("color-mode")?.value === "swissimage" &&
                swissImageRasterIsCurrent()
            ) {
                const raster = SWISSIMAGE_RGB.raster;
                const sceneNode = node?.sceneNode;

                if (swissNodeNeedsColor(sceneNode, raster)) {
                    colorNodeSync(sceneNode, raster, getSwissMapper(raster), node);
                }
            }
        } catch (error) {
            console.warn("[swiss-copc] could not colour new node:", error);
        }

        return node;
    };
}

function swissNodeNeedsColor(sceneNode, raster) {
    const geometry = sceneNode?.geometry;
    const position = geometry?.attributes?.position;

    return !!(
        position &&
        position.count > 0 &&
        geometry.userData?.swissImageColoredFor !== raster.id
    );
}

/* ============================================================
   SWISSIMAGE RASTER PREPARATION
   ============================================================ */

async function prepareSwissImageRaster() {
    if (SWISSIMAGE_RGB.loading) {
        while (SWISSIMAGE_RGB.loading) {
            await new Promise(resolve =>
                setTimeout(resolve, 25)
            );
        }
        return;
    }

    if (!currentTile?.bbox) {
        throw new Error("Selected tile has no bbox.");
    }

    if (typeof proj4 !== "function") {
        throw new Error("proj4 is not available.");
    }

    SWISSIMAGE_RGB.loading = true;

    let progressShown = false;

    try {
        const [west, south, east, north] = currentTile.bbox;

        // WGS84 -> LV95 -> Web Mercator
        const sw = proj4("EPSG:4326", "EPSG:2056", [west, south]);
        const ne = proj4("EPSG:4326", "EPSG:2056", [east, north]);

        const sw3857 = proj4("EPSG:2056", "EPSG:3857", sw);
        const ne3857 = proj4("EPSG:2056", "EPSG:3857", ne);

        /*
         * The raster is stored as ONE plain RGB byte array
         * (3 bytes per pixel) instead of a canvas. That avoids
         * browser canvas size limits and makes pixel lookups cheap.
         *
         * Memory: width * height * 3 bytes. The native 10 cm
         * SWISSIMAGE (WMTS zoom 20) is ~10,000 x 10,000 px = ~300 MB.
         * If the requested zoom would exceed MAX_RASTER_PIXELS the
         * zoom is lowered until it fits.
         */
        const MAX_RASTER_PIXELS = 160 * 1024 * 1024;
        const tileSize = SWISSIMAGE_RGB.tileSize;
        const requestedZoom = SWISSIMAGE_RGB.zoom;

        let z = requestedZoom;
        let minX, maxX, minY, maxY, tilesWide, tilesHigh;

        while (true) {
            const minTile = mercatorToTile(sw3857[0], ne3857[1], z);
            const maxTile = mercatorToTile(ne3857[0], sw3857[1], z);

            minX = Math.min(minTile.x, maxTile.x);
            maxX = Math.max(minTile.x, maxTile.x);
            minY = Math.min(minTile.y, maxTile.y);
            maxY = Math.max(minTile.y, maxTile.y);

            tilesWide = maxX - minX + 1;
            tilesHigh = maxY - minY + 1;

            const pixelCount =
                tilesWide * tileSize * tilesHigh * tileSize;

            if (pixelCount <= MAX_RASTER_PIXELS) {
                break;
            }

            if (z <= 0) {
                throw new Error(
                    "SWISSIMAGE raster exceeds the safe browser size limit."
                );
            }

            z--;
        }

        const width = tilesWide * tileSize;
        const height = tilesHigh * tileSize;

        let rgb;

        try {
            rgb = new Uint8Array(width * height * 3);
        } catch (error) {
            throw new Error(
                `Not enough memory for a ${width} x ${height} SWISSIMAGE raster. ` +
                "Lower the SWISSIMAGE resolution."
            );
        }

        // Tiles that cannot be loaded stay neutral grey.
        rgb.fill(128);

        const totalTiles = tilesWide * tilesHigh;

        setStatus(
            `Loading SWISSIMAGE at zoom ${z} ` +
            `(${tilesWide} × ${tilesHigh} tiles, ` +
            `${width.toLocaleString()} × ${height.toLocaleString()} px)…`
        );

        const jobs = [];

        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                jobs.push({ x, y });
            }
        }

        // One small canvas is reused to decode each tile.
        const tileCanvas = document.createElement("canvas");
        tileCanvas.width = tileSize;
        tileCanvas.height = tileSize;

        const tileContext = tileCanvas.getContext(
            "2d",
            { willReadFrequently: true }
        );

        if (!tileContext) {
            throw new Error("Could not create tile canvas.");
        }

        let nextJob = 0;
        let doneTiles = 0;
        let failedTiles = 0;
        let fallbackTiles = 0;

        const worker = async () => {
            while (nextJob < jobs.length) {
                const { x, y } = jobs[nextJob++];
                const key = `${z}/${x}/${y}`;

                let image = null;

                // swisstopo can answer with errors when many tiles are
                // requested at once, so retry with a growing pause.
                for (let attempt = 0; attempt < 5 && !image; attempt++) {
                    try {
                        image = await loadSwissImageTile(z, x, y);
                    } catch (error) {
                        SWISSIMAGE_RGB.cache.delete(key);

                        if (attempt < 4) {
                            await new Promise(resolve =>
                                setTimeout(resolve, 400 * (attempt + 1) * (attempt + 1))
                            );
                        }
                    }
                }

                // No await between draw and copy, so the shared canvas is safe.
                let data = null;

                try {
                    if (image) {
                        tileContext.clearRect(0, 0, tileSize, tileSize);
                        tileContext.drawImage(image, 0, 0, tileSize, tileSize);
                        data = tileContext.getImageData(0, 0, tileSize, tileSize).data;
                    }
                } catch (error) {
                    throw new Error(
                        "SWISSIMAGE pixels cannot be read. " +
                        "The WMTS image may not be CORS-enabled. " +
                        `Original error: ${error.message}`
                    );
                }

                // Still nothing: use the same area from a lower zoom
                // (blurrier, but coloured instead of grey).
                if (!data) {
                    data = await swissTileFromParent(
                        z, x, y, tileContext, tileSize
                    );

                    if (data) {
                        fallbackTiles++;
                    } else {
                        failedTiles++;
                    }
                }

                if (data) {

                    const x0 = (x - minX) * tileSize;
                    const y0 = (y - minY) * tileSize;

                    for (let row = 0; row < tileSize; row++) {
                        let dst = ((y0 + row) * width + x0) * 3;
                        let src = row * tileSize * 4;

                        for (let col = 0; col < tileSize; col++) {
                            rgb[dst++] = data[src];
                            rgb[dst++] = data[src + 1];
                            rgb[dst++] = data[src + 2];
                            src += 4;
                        }
                    }
                }

                // Do not keep decoded images around.
                SWISSIMAGE_RGB.cache.delete(key);

                doneTiles++;

                if (doneTiles % 8 === 0 || doneTiles === totalTiles) {
                    progressShown = true;

                    showSwissImageProgress(
                        doneTiles,
                        totalTiles,
                        "Loading SWISSIMAGE…"
                    );
                }
            }
        };

        const concurrency = Math.min(8, jobs.length);

        await Promise.all(
            Array.from({ length: concurrency }, worker)
        );

        const topLeft = tileToMercator(minX, minY, z);
        const bottomRight = tileToMercator(maxX + 1, maxY + 1, z);

        const key = tileKey(currentTile, 0);

        const raster = {
            tileKey: key,

            // Changes with the zoom, so nodes are recoloured when it changes.
            id: `${key}@z${z}`,

            requestedZoom,
            z,
            rgb,

            minX,
            minY,
            maxX,
            maxY,

            worldMinX: topLeft.x,
            worldMaxY: topLeft.y,
            worldMaxX: bottomRight.x,
            worldMinY: bottomRight.y,

            width,
            height,

            failedTiles,
            fallbackTiles
        };

        SWISSIMAGE_RGB.cache.clear();
        SWISSIMAGE_RGB.raster = raster;

        const metersPerPixel =
            (raster.worldMaxX - raster.worldMinX) / width;

        const lat = (south + north) / 2;
        const groundCm =
            metersPerPixel * Math.cos(lat * Math.PI / 180) * 100;

        setStatus(
            `SWISSIMAGE raster ready: ` +
            `${width.toLocaleString()} × ${height.toLocaleString()} px, ` +
            `~${groundCm.toFixed(0)} cm/px` +
            (z < requestedZoom
                ? ` (zoom lowered from ${requestedZoom} to ${z} to fit memory)`
                : "") +
            swissTileNote(raster) +
            "."
        );
    } finally {
        SWISSIMAGE_RGB.loading = false;

        if (progressShown) {
            hideSwissImageProgress();
        }
    }
}

/* ============================================================
   SWISSIMAGE WMTS
   ============================================================ */

function loadSwissImageTile(z, x, y) {
    const key = `${z}/${x}/${y}`;

    if (SWISSIMAGE_RGB.cache.has(key)) {
        return SWISSIMAGE_RGB.cache.get(key);
    }

    const promise = new Promise(
        (resolve, reject) => {
            const image = new Image();

            image.crossOrigin = "anonymous";

            image.onload = () => resolve(image);

            image.onerror = () => {
                reject(
                    new Error(
                        `SWISSIMAGE tile failed: ${key}`
                    )
                );
            };

            image.src =
                `https://wmts.geo.admin.ch/1.0.0/` +
                `${SWISSIMAGE_RGB.layer}/` +
                `default/current/3857/` +
                `${z}/${x}/${y}.jpeg`;
        }
    );

    SWISSIMAGE_RGB.cache.set(
        key,
        promise
    );

    return promise;
}

/*
 * Pixels (RGBA, tileSize x tileSize) for tile z/x/y taken from the first
 * lower zoom level that can be loaded, or null.
 */
async function swissTileFromParent(z, x, y, context, tileSize) {
    for (let dz = 1; dz <= 4 && z - dz >= 0; dz++) {
        const factor = 1 << dz;
        const px = x >> dz;
        const py = y >> dz;
        const key = `${z - dz}/${px}/${py}`;

        let image = null;

        for (let attempt = 0; attempt < 2 && !image; attempt++) {
            try {
                image = await loadSwissImageTile(z - dz, px, py);
            } catch (error) {
                SWISSIMAGE_RGB.cache.delete(key);
            }
        }

        if (!image) {
            continue;
        }

        const size = tileSize / factor;

        context.clearRect(0, 0, tileSize, tileSize);
        context.drawImage(
            image,
            (x & (factor - 1)) * size,
            (y & (factor - 1)) * size,
            size,
            size,
            0,
            0,
            tileSize,
            tileSize
        );

        SWISSIMAGE_RGB.cache.delete(key);

        return context.getImageData(0, 0, tileSize, tileSize).data;
    }

    return null;
}

/* ============================================================
   WEB MERCATOR TILE MATH
   ============================================================ */

function mercatorToTile(x, y, z) {
    const world = 20037508.342789244;
    const n = Math.pow(2, z);

    let tx = Math.floor(
        ((x + world) / (2 * world)) * n
    );

    let ty = Math.floor(
        ((world - y) / (2 * world)) * n
    );

    /*
     * WMTS XYZ x wraps around. Switzerland is nowhere near the
     * dateline, but clamping y avoids impossible tile requests.
     */
    tx = ((tx % n) + n) % n;
    ty = Math.max(0, Math.min(n - 1, ty));

    return {
        x: tx,
        y: ty
    };
}

function tileToMercator(x, y, z) {
    const world = 20037508.342789244;
    const n = Math.pow(2, z);

    return {
        x:
            (x / n) *
            2 *
            world -
            world,

        y:
            world -
            (y / n) *
            2 *
            world
    };
}

/* ============================================================
   RASTER PIXEL CACHE
   ============================================================ */

const swissImagePixelOut = [128, 128, 128];

/*
 * Returns [r, g, b] for raster pixel (x, y). The returned array is
 * reused for every call - read it immediately, do not store it.
 */
function getSwissImagePixel(raster, x, y) {
    const out = swissImagePixelOut;

    if (
        x < 0 ||
        y < 0 ||
        x >= raster.width ||
        y >= raster.height
    ) {
        out[0] = out[1] = out[2] = 128;
        return out;
    }

    const p = (y * raster.width + x) * 3;
    const rgb = raster.rgb;

    out[0] = rgb[p];
    out[1] = rgb[p + 1];
    out[2] = rgb[p + 2];

    return out;
}

/* ============================================================
   PROGRESS UI
   ============================================================ */

function showSwissImageProgress(
    done,
    total,
    message = "Coloring SWISSIMAGE…"
) {
    let box =
        getEl("swissimage-progress");

    if (!box) {
        box =
            document.createElement("div");

        box.id =
            "swissimage-progress";

        box.style.cssText = `
            position:fixed;
            right:20px;
            bottom:20px;
            z-index:10000;
            width:270px;
            padding:12px 16px;
            border-radius:8px;
            color:white;
            background:rgba(25,25,25,.93);
            font:14px sans-serif;
            box-shadow:0 2px 12px #0006;
        `;

        box.innerHTML = `
            <div style="
                display:flex;
                align-items:center;
                gap:10px
            ">
                <span style="
                    width:18px;
                    height:18px;
                    flex:none;
                    border:3px solid #888;
                    border-top-color:white;
                    border-radius:50%;
                    animation:swissimage-spin .8s linear infinite
                "></span>

                <span data-message></span>
            </div>

            <div style="
                margin-top:9px;
                height:5px;
                background:#555;
                border-radius:4px
            ">
                <div data-bar style="
                    height:100%;
                    width:0;
                    background:#49a5ff;
                    border-radius:4px
                "></div>
            </div>
        `;

        if (
            !getEl("swissimage-progress-style")
        ) {
            const style =
                document.createElement("style");

            style.id =
                "swissimage-progress-style";

            style.textContent =
                "@keyframes swissimage-spin " +
                "{ to { transform: rotate(360deg) } }";

            document.head.appendChild(style);
        }

        document.body.appendChild(box);
    }

    const percent =
        total
            ? Math.min(
                100,
                Math.round(
                    (done * 100) / total
                )
            )
            : 0;

    box.querySelector(
        "[data-message]"
    ).textContent =
        `${message} ${percent}%`;

    box.querySelector(
        "[data-bar]"
    ).style.width =
        `${percent}%`;
}

function hideSwissImageProgress() {
    getEl("swissimage-progress")?.remove();
}

function yieldToBrowser() {
    return new Promise(resolve =>
        setTimeout(resolve, 0)
    );
}

/* ============================================================
   CREATE THE RGB ATTRIBUTE
   ============================================================ */

/*
 * THIS IS THE MAIN FIX.
 *
 * We never require an existing `rgba` or `color` attribute.
 *
 * For N LiDAR points we create:
 *
 *     Uint8Array(N * 3)
 *
 * and attach it as:
 *
 *     geometry.attributes.color
 *
 * with:
 *
 *     itemSize = 3
 *     normalized = true
 *
 * This is ~60 MB for 20 million points.
 *
 * The raster can independently contain ~100 million pixels.
 */

 function ensureSwissImageColorAttribute(geometry, count) {
    if (!geometry || !count) {
        return null;
    }

    const rgba = geometry.attributes?.rgba;

    if (!rgba || !rgba.array) {
        console.warn(
            "[swiss-copc] Potree geometry has no RGBA attribute.",
            Object.keys(geometry.attributes || {})
        );

        return null;
    }

    /*
     * IMPORTANT:
     *
     * Do not create or replace the attribute here.
     * Potree 1.8 has already created the GPU buffer for
     * the existing "rgba" attribute.
     *
     * We will modify its existing Uint8Array in-place.
     */

    const requiredBytes = count * 4;

    if (rgba.array.length < requiredBytes) {
        console.warn(
            "[swiss-copc] Existing RGBA buffer is too small.",
            {
                points: count,
                availableBytes: rgba.array.length,
                requiredBytes: requiredBytes
            }
        );

        return null;
    }

    return rgba;
}

/* ============================================================
   LV95 -> RASTER MAPPING
   ============================================================ */

/*
 * Converting every point with proj4 is far too slow for millions of
 * points. Instead, LV95 -> Web Mercator is evaluated on a coarse grid
 * covering the tile once, and interpolated bilinearly per point. Over
 * one 1 km tile the error is far below one SWISSIMAGE pixel.
 */
function getSwissMapper(raster) {
    if (raster.mapper) {
        return raster.mapper;
    }

    let minE, maxE, minN, maxN;

    // Preferred: the loaded point cloud's own extent in world (= LV95) coordinates.
    try {
        const box = currentPointCloud.boundingBox.clone();

        if (!currentPointCloud.isLaz && currentPointCloud.matrixWorld) {
            currentPointCloud.updateMatrixWorld(true);
            box.applyMatrix4(currentPointCloud.matrixWorld);
        }

        const pad = 50;

        minE = box.min.x - pad;
        maxE = box.max.x + pad;
        minN = box.min.y - pad;
        maxN = box.max.y + pad;
    } catch (error) {
        minE = NaN;
    }

    const plausible =
        Number.isFinite(minE) &&
        minE > 2400000 && maxE < 2900000 &&
        minN > 1000000 && maxN < 1350000 &&
        maxE - minE < 20000 &&
        maxN - minN < 20000;

    if (!plausible) {
        const [west, south, east, north] = currentTile.bbox;

        const corners = [
            [west, south], [east, south],
            [east, north], [west, north]
        ].map(c => proj4("EPSG:4326", "EPSG:2056", c));

        const pad = 150;

        minE = Math.min(...corners.map(c => c[0])) - pad;
        maxE = Math.max(...corners.map(c => c[0])) + pad;
        minN = Math.min(...corners.map(c => c[1])) - pad;
        maxN = Math.max(...corners.map(c => c[1])) + pad;
    }

    const N = 24;
    const gx = new Float64Array((N + 1) * (N + 1));
    const gy = new Float64Array((N + 1) * (N + 1));
    const R = 6378137;

    for (let j = 0; j <= N; j++) {
        for (let i = 0; i <= N; i++) {
            const lonLat = proj4(
                "EPSG:2056",
                "EPSG:4326",
                [
                    minE + ((maxE - minE) * i) / N,
                    minN + ((maxN - minN) * j) / N
                ]
            );

            const lonRad = (lonLat[0] * Math.PI) / 180;
            const latRad = (lonLat[1] * Math.PI) / 180;

            gx[j * (N + 1) + i] = R * lonRad;
            gy[j * (N + 1) + i] =
                R * Math.log(Math.tan(Math.PI / 4 + latRad / 2));
        }
    }

    raster.stats = { points: 0, outside: 0 };

    raster.mapper = { N, gx, gy, minE, maxE, minN, maxN };

    return raster.mapper;
}

/* ============================================================
   COLOR ONE POTREE NODE (synchronous)
   ============================================================ */

const swissMatrixScratch = new THREE.Matrix4();

/*
 * Node-local point -> world (LV95) matrix.
 *
 * Potree draws a node with  pointcloud.matrixWorld x translate(node box min).
 * Asking three.js for sceneNode.matrixWorld instead can stack the parent
 * nodes' translations on top and place deep nodes far from where they really
 * are - they then fall outside the SWISSIMAGE raster and stay grey.
 *
 * So several candidate matrices are tried, and the one that puts a handful of
 * the node's points inside the node's own bounding box is used.
 */
function resolveSwissNodeMatrix(sceneNode, treeNode, mapper, position, count) {
    const pointcloud = currentPointCloud;
    const array = position.array;
    const itemSize = position.itemSize || 3;
    const samples = [0, count >> 2, count >> 1, (3 * count) >> 2, count - 1];

    let expected = null;
    let tolerance = 1;

    const nodeBox = treeNode?.geometryNode?.boundingBox;

    if (nodeBox && pointcloud?.matrixWorld) {
        expected = nodeBox.clone().applyMatrix4(pointcloud.matrixWorld);

        tolerance = Math.max(
            1,
            0.02 * Math.max(
                expected.max.x - expected.min.x,
                expected.max.y - expected.min.y
            )
        );
    }

    const fits = e => {
        for (const index of samples) {
            const j = index * itemSize;
            const x = array[j];
            const y = array[j + 1];
            const z = itemSize >= 3 ? array[j + 2] : 0;

            const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
            const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
            const wz = e[2] * x + e[6] * y + e[10] * z + e[14];

            if (expected) {
                if (
                    wx < expected.min.x - tolerance || wx > expected.max.x + tolerance ||
                    wy < expected.min.y - tolerance || wy > expected.max.y + tolerance ||
                    wz < expected.min.z - tolerance || wz > expected.max.z + tolerance
                ) {
                    return false;
                }
            } else if (
                wx < mapper.minE - 150 || wx > mapper.maxE + 150 ||
                wy < mapper.minN - 150 || wy > mapper.maxN + 150
            ) {
                return false;
            }
        }

        return true;
    };

    const candidates = {
        // matrix Potree itself already stored for rendering
        D: () => sceneNode.matrixWorld.elements,

        // Potree's convention: point-cloud matrix x node position
        A: () => {
            sceneNode.updateMatrix();
            return swissMatrixScratch.multiplyMatrices(
                pointcloud.matrixWorld,
                sceneNode.matrix
            ).elements;
        },

        // positions already in point-cloud space
        E: () => pointcloud.matrixWorld.elements,

        // plain three.js parent chain
        C: () => {
            sceneNode.updateMatrixWorld(true);
            return sceneNode.matrixWorld.elements;
        }
    };

    const cached = pointcloud.__swissMatrixMethod;
    const order = ["D", "A", "E", "C"];

    if (cached) {
        order.splice(order.indexOf(cached), 1);
        order.unshift(cached);
    }

    const stats = SWISSIMAGE_RGB.matrixStats ??= { D: 0, A: 0, E: 0, C: 0, none: 0 };

    for (const name of order) {
        let elements;

        try {
            elements = candidates[name]();
        } catch (error) {
            continue;
        }

        if (elements && fits(elements)) {
            pointcloud.__swissMatrixMethod = name;
            stats[name]++;
            return Array.from(elements);
        }
    }

    stats.none++;

    if (stats.none <= 3) {
        console.warn(
            "[swiss-copc] no node matrix put the points inside the node box; " +
            "using Potree's convention.",
            { expected, tolerance }
        );
    }

    return Array.from(candidates.A());
}

function colorNodeSync(sceneNode, raster, mapper, treeNode) {
    const geometry = sceneNode.geometry;
    const position = geometry.attributes.position;
    const count = position.count;

    geometry.userData ??= {};

    // Potree already owns an "rgba" buffer for the node; it is filled in place.
    const color = ensureSwissImageColorAttribute(geometry, count);

    if (!color) {
        // not there (yet): leave the node unmarked so it is tried again
        return;
    }

    const e = resolveSwissNodeMatrix(sceneNode, treeNode, mapper, position, count);

    const positions = position.array;
    const itemSize = position.itemSize || 3;
    const colors = color.array;
    const rgbData = raster.rgb;

    const { N, gx, gy, minE, minN } = mapper;
    const invE = N / (mapper.maxE - minE);
    const invN = N / (mapper.maxN - minN);
    const stride = N + 1;

    const worldMinX = raster.worldMinX;
    const worldMaxY = raster.worldMaxY;
    const scaleX = raster.width / (raster.worldMaxX - raster.worldMinX);
    const scaleY = raster.height / (raster.worldMaxY - raster.worldMinY);
    const width = raster.width;
    const height = raster.height;

    let outside = 0;

    for (let i = 0; i < count; i++) {
        const j = i * itemSize;

        const x = positions[j];
        const y = positions[j + 1];
        const z = itemSize >= 3 ? positions[j + 2] : 0;

        // THREE.Matrix4 elements are column-major.
        const worldX = e[0] * x + e[4] * y + e[8] * z + e[12];
        const worldY = e[1] * x + e[5] * y + e[9] * z + e[13];

        let u = (worldX - minE) * invE;
        let v = (worldY - minN) * invN;

        if (u < 0) u = 0; else if (u > N - 1e-9) u = N - 1e-9;
        if (v < 0) v = 0; else if (v > N - 1e-9) v = N - 1e-9;

        const gi = Math.floor(u);
        const gj = Math.floor(v);
        const fu = u - gi;
        const fv = v - gj;
        const k = gj * stride + gi;

        const w00 = (1 - fu) * (1 - fv);
        const w10 = fu * (1 - fv);
        const w01 = (1 - fu) * fv;
        const w11 = fu * fv;

        const mx =
            gx[k] * w00 + gx[k + 1] * w10 +
            gx[k + stride] * w01 + gx[k + stride + 1] * w11;

        const my =
            gy[k] * w00 + gy[k + 1] * w10 +
            gy[k + stride] * w01 + gy[k + stride + 1] * w11;

        const ix = Math.floor((mx - worldMinX) * scaleX);
        const iy = Math.floor((worldMaxY - my) * scaleY);

        const c = i * 4;

        if (ix < 0 || iy < 0 || ix >= width || iy >= height) {
            colors[c] = 128;
            colors[c + 1] = 128;
            colors[c + 2] = 128;
            colors[c + 3] = 255;
            outside++;
            continue;
        }

        const p = (iy * width + ix) * 3;

        colors[c] = rgbData[p];
        colors[c + 1] = rgbData[p + 1];
        colors[c + 2] = rgbData[p + 2];
        colors[c + 3] = 255;
    }

    // Potree's RGB material reads the attribute named "color".
    if (typeof geometry.setAttribute === "function") {
        geometry.setAttribute("color", color);
    } else {
        geometry.addAttribute("color", color);
    }

    color.needsUpdate = true;

    geometry.userData.swissImageColoredFor = raster.id;

    raster.stats.points += count;
    raster.stats.outside += outside;
}

/* ============================================================
   PLACE SEARCH
   ============================================================ */

/*
 * swisstopo SearchServer origins:
 *   gg25     municipalities
 *   zipcode  postcodes / localities (Ortschaften)
 *   gazetteer  place names (settlements, hills, lakes, ...)
 *   address  street addresses
 */
const SEARCH_SCOPES = {
    all: "gg25,zipcode,gazetteer,address",
    places: "gg25,zipcode,gazetteer",
    addresses: "address"
};

const SEARCH_ORIGIN_INFO = {
    gg25: { label: "Municipality", order: 0, zoom: 13 },
    zipcode: { label: "Locality", order: 1, zoom: 14 },
    gazetteer: { label: "Place", order: 2, zoom: 15 },
    address: { label: "Address", order: 3, zoom: 18 },
    district: { label: "District", order: 0, zoom: 12 },
    kantone: { label: "Canton", order: 0, zoom: 10 }
};

function stripHtml(value) {
    return String(value ?? "").replace(/<[^>]*>/g, "").trim();
}

async function searchPlace() {
    const input = getEl("search-input");

    if (!input) {
        return;
    }

    const query = input.value.trim();

    if (!query) {
        return;
    }

    const scope = getEl("search-scope")?.value || "all";

    setStatus(`Searching for ${query}…`);

    try {
        const url = new URL(CONFIG.SEARCH_URL);

        url.searchParams.set("searchText", query);
        url.searchParams.set("type", "locations");
        url.searchParams.set("origins", SEARCH_SCOPES[scope] || SEARCH_SCOPES.all);
        url.searchParams.set("sr", "2056");
        url.searchParams.set("limit", scope === "all" ? "20" : "10");

        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`Search failed: ${response.status}`);
        }

        const data = await response.json();
        const results = (data.results || [])
            .map((result, index) => ({ result, index }))
            .sort((a, b) => {
                const oa = SEARCH_ORIGIN_INFO[a.result.attrs?.origin]?.order ?? 9;
                const ob = SEARCH_ORIGIN_INFO[b.result.attrs?.origin]?.order ?? 9;
                return oa - ob || a.index - b.index;
            })
            .map(item => item.result);

        renderSearchResults(results);

        setStatus(`${results.length} search result(s).`);
    } catch (error) {
        console.error(error);
        setStatus(`Place search failed: ${error.message}`);
    }
}

/* "BOX(2683000 1247000,2684000 1248000)" (LV95) -> Leaflet bounds, or null. */
function boxToLatLngBounds(text) {
    const numbers = String(text || "").match(/-?\d+(\.\d+)?/g);

    if (!numbers || numbers.length < 4) {
        return null;
    }

    const [x1, y1, x2, y2] = numbers.map(Number);

    const inSwitzerland = ([lon, lat]) =>
        lon > 5.5 && lon < 11 && lat > 45.5 && lat < 48.2;

    const convert = (a, b) => proj4("EPSG:2056", "EPSG:4326", [a, b]);

    for (const swap of [false, true]) {
        const p1 = swap ? convert(y1, x1) : convert(x1, y1);
        const p2 = swap ? convert(y2, x2) : convert(x2, y2);

        if (inSwitzerland(p1) && inSwitzerland(p2)) {
            return L.latLngBounds(
                [p1[1], p1[0]],
                [p2[1], p2[0]]
            );
        }
    }

    return null;
}

function goToSearchResult(result) {
    const attrs = result.attrs || {};
    const info = SEARCH_ORIGIN_INFO[attrs.origin] || { zoom: 14 };

    const lat = Number(attrs.lat ?? result.lat);
    const lon = Number(attrs.lon ?? result.lon);

    if (!map) {
        return;
    }

    // Prefer the object's extent (municipalities, localities); addresses are points.
    if (attrs.origin !== "address") {
        try {
            const bounds = boxToLatLngBounds(attrs.geom_st_box2d);

            if (bounds && bounds.isValid() && !bounds.getSouthWest().equals(bounds.getNorthEast())) {
                map.fitBounds(bounds.pad(0.1), { maxZoom: 16 });
                return;
            }
        } catch (error) {
            console.warn("Could not use search extent:", error);
        }
    }

    if (Number.isFinite(lat) && Number.isFinite(lon)) {
        map.setView([lat, lon], info.zoom);
    }
}

function renderSearchResults(results) {
    const container = getEl("search-results");

    if (!container) {
        return;
    }

    container.innerHTML = "";

    if (!results.length) {
        const empty = document.createElement("div");
        empty.className = "search-empty";
        empty.textContent = "No match. Try another spelling or search in “Everything”.";
        container.appendChild(empty);
        return;
    }

    for (const result of results) {
        const attrs = result.attrs || {};
        const item = document.createElement("button");

        item.type = "button";
        item.className = "search-result";

        const origin = document.createElement("span");
        origin.className = "origin";
        origin.textContent =
            SEARCH_ORIGIN_INFO[attrs.origin]?.label ||
            attrs.origin ||
            "";

        const label = document.createElement("span");
        label.textContent = stripHtml(
            attrs.label ||
            attrs.detail ||
            result.label ||
            "Location"
        );

        item.append(origin, label);
        item.addEventListener("click", () => goToSearchResult(result));

        container.appendChild(item);
    }
}

/* ============================================================
   DOWNLOAD
   ============================================================ */

function downloadCurrentTile() {
    if (!currentTile) {
        setStatus("No tile selected.");
        return;
    }

    const url =
        getCopcUrl(currentTile);

    if (!url) {
        setStatus("No COPC URL found.");
        return;
    }

    window.open(
        url,
        "_blank",
        "noopener,noreferrer"
    );

    setStatus(
        "COPC URL opened in a new tab."
    );

    window.usageCounter?.hit("downloads");
}

/* ============================================================
   DEBUG API
   ============================================================ */

window.swissCOPC = {
    viewer: () => viewer,

    currentPointCloud:
        () => currentPointCloud,

    currentTile:
        () => currentTile,

    section:
        () => currentSection,

    loadedPointClouds:
        () => loadedPointClouds,

    colorMode: mode => {
        if (currentPointCloud) {
            applyColorMode(
                currentPointCloud,
                mode
            );
        }
    },

    swissImage:
        () => SWISSIMAGE_RGB.raster,

    // { points, outside }: how many coloured points fell outside the raster
    swissStats:
        () => SWISSIMAGE_RGB.raster?.stats,

    // which node-matrix variant was used, e.g. { D: 0, A: 412, E: 0, C: 0, none: 0 }
    swissMatrixStats:
        () => SWISSIMAGE_RGB.matrixStats,

    createHorizontalSection:
        () => createSection("horizontal"),

    createVerticalSection:
        () => createSection("vertical"),

    clearSection:
        () => clearSection()
}
