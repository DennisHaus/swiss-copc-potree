code = "use strict";

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
let swissImageColoring = false;

/* ============================================================
   SWISSIMAGE STATE
   ============================================================ */

const SWISSIMAGE_RGB = {
    layer: "ch.swisstopo.swissimage-product",

    /*
     * Zoom 25 is the native 10 cm-ish scale used by the
     * SWISSIMAGE product. We automatically lower the zoom
     * if a tile footprint would require too many WMTS tiles.
     */
    zoom: 25,

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

    console.log("[swiss-copc]", message);
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

        currentTiles = Array.isArray(data.features)
            ? data.features
            : [];

        renderTiles();

        setStatus(`${currentTiles.length} tile(s) found.`);
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
    const attributes = getEl("selected-attributes");

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

function getCopcUrl(tile) {
    if (!tile?.assets) {
        return null;
    }

    for (const [key, asset] of Object.entries(tile.assets)) {
        const href = asset?.href || "";
        const type = asset?.type || "";
        const roles = Array.isArray(asset?.roles)
            ? asset.roles
            : [];

        const text =
            `${key} ${href} ${type} ${roles.join(" ")}`
                .toLowerCase();

        if (
            text.includes("copc") ||
            /\.copc(\.laz)?($|\?)/i.test(href)
        ) {
            return href;
        }
    }

    for (const asset of Object.values(tile.assets)) {
        const href = asset?.href || "";

        if (/\.laz($|\?)/i.test(href)) {
            return href;
        }
    }

    return null;
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

    applyColorMode(pointcloud, "intensity");
    refreshPointCloudMaterial(pointcloud);
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
    if (!pointcloud?.material) {
        return;
    }

    const material = pointcloud.material;

    if (mode === "swissimage") {
        material.activeAttributeName = null;

        const ok = setPointColorType(
            material,
            "RGB"
        );

        if (!ok) {
            setStatus(
                "Potree RGB color mode is unavailable."
            );
            return;
        }

        refreshPointCloudMaterial(pointcloud);
        updateDisplayedColorMode("swissimage");

        /*
         * If visible nodes are already available, process now.
         * Otherwise the timer will process them when Potree
         * has loaded them.
         */
        startSwissImageProcessing();

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
    if (!Potree.PointColorType) {
        return false;
    }

    if (
        Potree.PointColorType[name] ===
        undefined
    ) {
        console.warn(
            `Potree.PointColorType.${name} is unavailable.`
        );
        return false;
    }

    material.pointColorType =
        Potree.PointColorType[name];

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
        clearInterval(
            SWISSIMAGE_RGB.processTimer
        );

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

function startSwissImageProcessing() {
    if (!currentPointCloud || !currentTile) {
        return;
    }

    if (SWISSIMAGE_RGB.processTimer) {
        /*
         * We still immediately process here. This is useful when
         * the user switches to SWISSIMAGE after Potree has already
         * loaded new visible nodes.
         */
        processSwissImageRGB();
        return;
    }

    processSwissImageRGB();

    SWISSIMAGE_RGB.processTimer =
        window.setInterval(
            processSwissImageRGB,
            1500
        );
}

async function processSwissImageRGB() {
    const selector =
        getEl("color-mode");

    if (
        swissImageProcessRunning ||
        !currentPointCloud ||
        !currentTile ||
        (
            selector &&
            selector.value !== "swissimage"
        )
    ) {
        return;
    }

    swissImageProcessRunning = true;

    showSwissImageProgress(
        0,
        1,
        "Preparing SWISSIMAGE…"
    );

    await new Promise(resolve => {
        requestAnimationFrame(() => {
            requestAnimationFrame(resolve);
        });
    });

    try {
        const currentKey =
            tileKey(currentTile, 0);

        if (
            !SWISSIMAGE_RGB.raster ||
            SWISSIMAGE_RGB.raster.tileKey !== currentKey
        ) {
            await prepareSwissImageRaster();
        }

        await colorVisiblePointNodes(
            (done, total) => {
                showSwissImageProgress(done, total);
            }
        );

        setStatus("SWISSIMAGE RGB applied.");
    } catch (error) {
        console.error(
            "SWISSIMAGE RGB failed:",
            error
        );

        setStatus(
            `SWISSIMAGE RGB failed: ${error.message}`
        );
    } finally {
        hideSwissImageProgress();
        swissImageProcessRunning = false;
    }
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
        throw new Error(
            "Selected tile has no bbox."
        );
    }

    if (typeof proj4 !== "function") {
        throw new Error(
            "proj4 is not available."
        );
    }

    SWISSIMAGE_RGB.loading = true;

    try {
        const [
            west,
            south,
            east,
            north
        ] = currentTile.bbox;

        /*
         * WGS84 -> LV95.
         */
        const sw = proj4(
            "EPSG:4326",
            "EPSG:2056",
            [west, south]
        );

        const ne = proj4(
            "EPSG:4326",
            "EPSG:2056",
            [east, north]
        );

        /*
         * LV95 -> WebMercator.
         */
        const sw3857 = proj4(
            "EPSG:2056",
            "EPSG:3857",
            sw
        );

        const ne3857 = proj4(
            "EPSG:2056",
            "EPSG:3857",
            ne
        );

        /*
         * A full 1 km x 1 km 10 cm raster is approximately
         * 100 million pixels. We deliberately do not compare
         * that number with the LiDAR point count.
         *
         * Instead, these limits only control how many WMTS
         * tiles are stitched into the browser canvas.
         *
         * If the native zoom requires too many tiles, we lower
         * the zoom. The LiDAR points are still sampled from
         * the resulting raster.
         */
        const MAX_RASTER_PIXELS =
            32 * 1024 * 1024;

        const MAX_RASTER_TILES = 128;

        let z = SWISSIMAGE_RGB.zoom;

        let minX;
        let maxX;
        let minY;
        let maxY;
        let tilesWide;
        let tilesHigh;

        while (true) {
            const minTile =
                mercatorToTile(
                    sw3857[0],
                    ne3857[1],
                    z
                );

            const maxTile =
                mercatorToTile(
                    ne3857[0],
                    sw3857[1],
                    z
                );

            minX = Math.min(
                minTile.x,
                maxTile.x
            );

            maxX = Math.max(
                minTile.x,
                maxTile.x
            );

            minY = Math.min(
                minTile.y,
                maxTile.y
            );

            maxY = Math.max(
                minTile.y,
                maxTile.y
            );

            tilesWide =
                maxX - minX + 1;

            tilesHigh =
                maxY - minY + 1;

            const tileCount =
                tilesWide * tilesHigh;

            const pixelCount =
                tilesWide *
                SWISSIMAGE_RGB.tileSize *
                tilesHigh *
                SWISSIMAGE_RGB.tileSize;

            if (
                tileCount <= MAX_RASTER_TILES &&
                pixelCount <= MAX_RASTER_PIXELS
            ) {
                break;
            }

            if (z <= 0) {
                throw new Error(
                    "SWISSIMAGE raster exceeds the safe browser size limit."
                );
            }

            z--;
        }

        const canvas =
            document.createElement("canvas");

        canvas.width =
            tilesWide *
            SWISSIMAGE_RGB.tileSize;

        canvas.height =
            tilesHigh *
            SWISSIMAGE_RGB.tileSize;

        const context =
            canvas.getContext(
                "2d",
                {
                    willReadFrequently: true
                }
            );

        if (!context) {
            throw new Error(
                "Could not create raster canvas."
            );
        }

        setStatus(
            `Loading SWISSIMAGE RGB at zoom ${z} ` +
            `(${tilesWide} × ${tilesHigh} WMTS tiles)…`
        );

        const requests = [];

        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                requests.push(
                    loadSwissImageTile(z, x, y)
                        .then(image => {
                            const px =
                                (x - minX) *
                                SWISSIMAGE_RGB.tileSize;

                            const py =
                                (y - minY) *
                                SWISSIMAGE_RGB.tileSize;

                            context.drawImage(
                                image,
                                px,
                                py
                            );
                        })
                );
            }
        }

        await Promise.all(requests);

        const topLeft =
            tileToMercator(
                minX,
                minY,
                z
            );

        const bottomRight =
            tileToMercator(
                maxX + 1,
                maxY + 1,
                z
            );

        SWISSIMAGE_RGB.cache.clear();

        const raster = {
            tileKey: tileKey(currentTile, 0),

            canvas,
            context,

            minX,
            minY,
            maxX,
            maxY,
            z,

            worldMinX: topLeft.x,
            worldMaxY: topLeft.y,
            worldMaxX: bottomRight.x,
            worldMinY: bottomRight.y,

            width: canvas.width,
            height: canvas.height
        };

        SWISSIMAGE_RGB.raster = raster;

        swissImageBlockCaches.delete(raster);

        setStatus(
            `SWISSIMAGE raster ready: ` +
            `${raster.width.toLocaleString()} × ` +
            `${raster.height.toLocaleString()} pixels.`
        );
    } finally {
        SWISSIMAGE_RGB.loading = false;
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

function getSwissImagePixel(
    raster,
    x,
    y
) {
    let cache =
        swissImageBlockCaches.get(raster);

    if (!cache) {
        cache = new Map();
        swissImageBlockCaches.set(
            raster,
            cache
        );
    }

    const blockX =
        Math.floor(
            x / SWISSIMAGE_BLOCK_SIZE
        );

    const blockY =
        Math.floor(
            y / SWISSIMAGE_BLOCK_SIZE
        );

    const key =
        `${blockX},${blockY}`;

    let block = cache.get(key);

    if (block) {
        /*
         * LRU refresh.
         */
        cache.delete(key);
        cache.set(key, block);
    } else {
        const x0 =
            blockX *
            SWISSIMAGE_BLOCK_SIZE;

        const y0 =
            blockY *
            SWISSIMAGE_BLOCK_SIZE;

        const width =
            Math.min(
                SWISSIMAGE_BLOCK_SIZE,
                raster.width - x0
            );

        const height =
            Math.min(
                SWISSIMAGE_BLOCK_SIZE,
                raster.height - y0
            );

        if (
            width <= 0 ||
            height <= 0
        ) {
            return [128, 128, 128];
        }

        let imageData;

        try {
            imageData =
                raster.context.getImageData(
                    x0,
                    y0,
                    width,
                    height
                );
        } catch (error) {
            throw new Error(
                "SWISSIMAGE pixels cannot be read. " +
                "The WMTS image may not be CORS-enabled. " +
                `Original error: ${error.message}`
            );
        }

        block = {
            x0,
            y0,
            width,
            height,
            data: imageData.data
        };

        cache.set(key, block);

        if (
            cache.size >
            SWISSIMAGE_MAX_CACHED_BLOCKS
        ) {
            cache.delete(
                cache.keys().next().value
            );
        }
    }

    const localX =
        x - block.x0;

    const localY =
        y - block.y0;

    if (
        localX < 0 ||
        localY < 0 ||
        localX >= block.width ||
        localY >= block.height
    ) {
        return [128, 128, 128];
    }

    const offset =
        (
            localY *
            block.width +
            localX
        ) * 4;

    return [
        block.data[offset],
        block.data[offset + 1],
        block.data[offset + 2]
    ];
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

function ensureSwissImageColorAttribute(
    geometry,
    count
) {
    if (
        !geometry ||
        !count
    ) {
        return null;
    }

    if (
        typeof THREE ===
        "undefined" ||
        !THREE.BufferAttribute
    ) {
        throw new Error(
            "THREE.BufferAttribute is unavailable."
        );
    }

    let color =
        geometry.attributes?.color;

    if (
        color &&
        color.count === count &&
        color.itemSize === 3 &&
        color.array instanceof Uint8Array &&
        color.normalized === true
    ) {
        return color;
    }

    /*
     * Replace any incompatible old color/RGBA attribute.
     */
    const array =
        new Uint8Array(count * 3);

    /*
     * Neutral default until every point is sampled.
     */
    array.fill(128);

    color =
        new THREE.BufferAttribute(
            array,
            3,
            true
        );

    if (
        typeof geometry.setAttribute ===
        "function"
    ) {
        geometry.setAttribute(
            "color",
            color
        );
    } else {
        geometry.attributes.color =
            color;
    }

    color.needsUpdate = true;

    return color;
}

/* ============================================================
   COLOR ONE POTREE GEOMETRY
   ============================================================ */

async function colorGeometryFromSwissImage(
    sceneNode,
    rasterKey,
    onProgress = () => {}
) {
    const geometry =
        sceneNode?.geometry;

    const position =
        geometry?.attributes?.position;

    const raster =
        SWISSIMAGE_RGB.raster;

    if (
        !geometry ||
        !position ||
        !raster?.context
    ) {
        return false;
    }

    geometry.userData ??= {};

    if (
        geometry.userData.swissImageColoredFor ===
        rasterKey
    ) {
        return false;
    }

    const count =
        position.count;

    if (!count) {
        return false;
    }

    /*
     * One RGB triplet per LiDAR point.
     */
    const color =
        ensureSwissImageColorAttribute(
            geometry,
            count
        );

    if (!color) {
        return false;
    }

    const positions =
        position.array;

    const positionItemSize =
        position.itemSize || 3;

    const colors =
        color.array;

    /*
     * Potree node positions can be local to the scene node.
     * matrixWorld converts them to the world coordinate system.
     */
    if (
        typeof sceneNode.updateMatrixWorld ===
        "function"
    ) {
        sceneNode.updateMatrixWorld(true);
    }

    const matrixWorld =
        sceneNode.matrixWorld;

    if (!matrixWorld) {
        throw new Error(
            "Potree scene node has no matrixWorld."
        );
    }

    const e =
        matrixWorld.elements;

    /*
     * The point cloud is assumed to be in LV95 world
     * coordinates after matrixWorld.
     */
    const worldWidth =
        raster.worldMaxX -
        raster.worldMinX;

    const worldHeight =
        raster.worldMaxY -
        raster.worldMinY;

    if (
        !Number.isFinite(worldWidth) ||
        !Number.isFinite(worldHeight) ||
        worldWidth <= 0 ||
        worldHeight <= 0
    ) {
        throw new Error(
            "Invalid SWISSIMAGE raster world extent."
        );
    }

    const scaleX =
        raster.width /
        worldWidth;

    const scaleY =
        raster.height /
        worldHeight;

    const lv95 = [0, 0];

    for (
        let start = 0;
        start < count;
        start += SWISSIMAGE_BATCH_SIZE
    ) {
        const end =
            Math.min(
                start +
                SWISSIMAGE_BATCH_SIZE,
                count
            );

        for (
            let i = start;
            i < end;
            i++
        ) {
            const j =
                i *
                positionItemSize;

            const x =
                positions[j];

            const y =
                positions[j + 1];

            const z =
                positionItemSize >= 3
                    ? positions[j + 2]
                    : 0;

            /*
             * THREE.Matrix4 is column-major.
             */
            const worldX =
                e[0] * x +
                e[4] * y +
                e[8] * z +
                e[12];

            const worldY =
                e[1] * x +
                e[5] * y +
                e[9] * z +
                e[13];

            lv95[0] = worldX;
            lv95[1] = worldY;

            /*
             * LV95 -> WebMercator.
             */
            const mercator =
                proj4(
                    "EPSG:2056",
                    "EPSG:3857",
                    lv95
                );

            /*
             * WebMercator -> raster pixel.
             *
             * Raster origin is top-left, so Y is inverted.
             */
            const ix =
                Math.floor(
                    (
                        mercator[0] -
                        raster.worldMinX
                    ) *
                    scaleX
                );

            const iy =
                Math.floor(
                    (
                        raster.worldMaxY -
                        mercator[1]
                    ) *
                    scaleY
                );

            const c =
                i * 3;

            if (
                ix < 0 ||
                iy < 0 ||
                ix >= raster.width ||
                iy >= raster.height
            ) {
                colors[c] = 128;
                colors[c + 1] = 128;
                colors[c + 2] = 128;
                continue;
            }

            const rgb =
                getSwissImagePixel(
                    raster,
                    ix,
                    iy
                );

            colors[c] =
                rgb[0];

            colors[c + 1] =
                rgb[1];

            colors[c + 2] =
                rgb[2];
        }

        onProgress(end);

        await yieldToBrowser();
    }

    color.needsUpdate = true;

    geometry.userData.swissImageColoredFor =
        rasterKey;

    return true;
}

/* ============================================================
   COLOR VISIBLE NODES
   ============================================================ */

async function colorVisiblePointNodes(
    onProgress = () => {}
) {
    if (
        swissImageColoring ||
        !currentPointCloud ||
        !SWISSIMAGE_RGB.raster
    ) {
        return;
    }

    const nodes =
        currentPointCloud.visibleNodes;

    if (!Array.isArray(nodes)) {
        return;
    }

    const rasterKey =
        SWISSIMAGE_RGB.raster.tileKey ||
        "current-raster";

    const pending = [];

    for (const node of nodes) {
        const sceneNode =
            node?.sceneNode;

        const geometry =
            sceneNode?.geometry;

        const position =
            geometry?.attributes?.position;

        if (
            sceneNode &&
            geometry &&
            position &&
            position.count > 0 &&
            geometry.userData
                ?.swissImageColoredFor !==
            rasterKey
        ) {
            pending.push({
                sceneNode,
                count: position.count
            });
        }
    }

    const total =
        pending.reduce(
            (sum, item) =>
                sum + item.count,
            0
        );

    if (!total) {
        onProgress(0, 0);
        return;
    }

    swissImageColoring = true;

    let done = 0;

    try {
        for (const item of pending) {
            const sceneNode =
                item.sceneNode;

            if (
                typeof sceneNode.updateMatrixWorld ===
                "function"
            ) {
                sceneNode.updateMatrixWorld(true);
            }

            await colorGeometryFromSwissImage(
                sceneNode,
                rasterKey,
                pointsInNode => {
                    onProgress(
                        done + pointsInNode,
                        total
                    );
                }
            );

            done += item.count;

            onProgress(
                done,
                total
            );

            await yieldToBrowser();
        }
    } finally {
        swissImageColoring = false;
    }
}

/* ============================================================
   PLACE SEARCH
   ============================================================ */

async function searchPlace() {
    const input =
        getEl("search-input");

    if (!input) {
        return;
    }

    const query =
        input.value.trim();

    if (!query) {
        return;
    }

    setStatus(
        `Searching for ${query}…`
    );

    try {
        const url =
            new URL(CONFIG.SEARCH_URL);

        url.searchParams.set(
            "searchText",
            query
        );

        url.searchParams.set(
            "type",
            "locations"
        );

        url.searchParams.set(
            "origins",
            "address"
        );

        url.searchParams.set(
            "limit",
            "5"
        );

        const response =
            await fetch(url);

        if (!response.ok) {
            throw new Error(
                `Search failed: ${response.status}`
            );
        }

        const data =
            await response.json();

        const results =
            data.results || [];

        renderSearchResults(results);

        setStatus(
            `${results.length} search result(s).`
        );
    } catch (error) {
        console.error(error);

        setStatus(
            `Place search failed: ${error.message}`
        );
    }
}

function renderSearchResults(results) {
    const container =
        getEl("search-results");

    if (!container) {
        return;
    }

    container.innerHTML = "";

    for (const result of results) {
        const item =
            document.createElement("button");

        item.type = "button";

        const attrs =
            result.attrs || {};

        item.textContent =
            attrs.label ||
            attrs.detail ||
            result.label ||
            "Location";

        item.addEventListener(
            "click",
            () => {
                const lat =
                    Number(
                        attrs.lat ||
                        result.lat
                    );

                const lon =
                    Number(
                        attrs.lon ||
                        result.lon
                    );

                if (
                    map &&
                    Number.isFinite(lat) &&
                    Number.isFinite(lon)
                ) {
                    map.setView(
                        [lat, lon],
                        14
                    );
                }
            }
        );

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

    createHorizontalSection:
        () => createSection("horizontal"),

    createVerticalSection:
        () => createSection("vertical"),

    clearSection:
        () => clearSection()
}
