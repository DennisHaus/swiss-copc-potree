/* ============================================================
   SwissTopo swissSURFACE3D COPC + Potree 1.8
   ============================================================ */

"use strict";

/* ------------------------------------------------------------
   Global state
   ------------------------------------------------------------ */

let viewer = null;
let map = null;

let currentPointCloud = null;
let currentTile = null;

let currentTiles = [];
let tileLayerGroup = null;

let currentSection = null;

const loadedPointClouds = new Map();


/* ------------------------------------------------------------
   DOM helpers
   ------------------------------------------------------------ */

function $(id) {
    return document.getElementById(id);
}

function setStatus(message) {
    const el = $("status");

    if (el) {
        el.textContent = message || "";
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


/* ------------------------------------------------------------
   Initialization
   ------------------------------------------------------------ */

document.addEventListener("DOMContentLoaded", () => {
    initPotree();
    initMap();
    initUI();

    setStatus("Ready");
});


/* ------------------------------------------------------------
   Potree
   ------------------------------------------------------------ */

function initPotree() {
    const renderArea = $("potree_render_area");

    if (!renderArea) {
        console.error("Missing #potree_render_area");
        return;
    }

    viewer = new Potree.Viewer(renderArea);

    viewer.setEDLEnabled(true);
    viewer.setFOV(60);
    viewer.setPointBudget(CONFIG.POINT_BUDGET || 2_000_000);

    /*
     * IMPORTANT:
     * Do NOT call viewer.loadGUI().
     * We intentionally use our own interface.
     */

    if (viewer.renderer) {
        viewer.renderer.setClearColor(0x20252b, 1);
    }

    /*
     * Start with clipping disabled.
     */
    try {
        viewer.setClipTask(Potree.ClipTask.NONE);
    } catch (error) {
        console.warn("Could not set initial clip task:", error);
    }
}


/* ------------------------------------------------------------
   Leaflet map
   ------------------------------------------------------------ */

function initMap() {
    if (!window.L) {
        console.warn("Leaflet not available");
        return;
    }

    const mapElement = $("map");

    if (!mapElement) {
        return;
    }

    map = L.map(mapElement, {
        zoomControl: true,
        attributionControl: true
    }).setView(
        CONFIG.MAP_CENTER || [46.8182, 8.2275],
        CONFIG.MAP_ZOOM || 8
    );

    L.tileLayer(CONFIG.BASEMAP, {
        attribution: CONFIG.BASEMAP_ATTRIBUTION || "© swisstopo",
        maxZoom: 19
    }).addTo(map);

    tileLayerGroup = L.layerGroup().addTo(map);

    /*
     * Make sure Leaflet recalculates its size after the UI is
     * completely laid out.
     */
    setTimeout(() => {
        map.invalidateSize();
    }, 250);
}


/* ------------------------------------------------------------
   UI
   ------------------------------------------------------------ */

function initUI() {
    const findButton = $("findTilesButton");
    const fitButton = $("fitButton");
    const clearButton = $("clearButton");

    const searchButton = $("search-button");
    const searchInput = $("search-input");

    const colorMode = $("color-mode");

    const horizontalButton = $("horizontalSectionButton");
    const verticalButton = $("verticalSectionButton");
    const clearSectionButton = $("clearSectionButton");

    const unloadButton = $("unloadButton");
    const downloadButton = $("downloadButton");

    if (findButton) {
        findButton.addEventListener("click", findTilesFromMap);
    }

    if (fitButton) {
        fitButton.addEventListener("click", fitCurrentPointCloud);
    }

    if (clearButton) {
        clearButton.addEventListener("click", clearAllPointClouds);
    }

    if (searchButton) {
        searchButton.addEventListener("click", searchPlace);
    }

    if (searchInput) {
        searchInput.addEventListener("keydown", event => {
            if (event.key === "Enter") {
                searchPlace();
            }
        });
    }

    if (colorMode) {
        colorMode.addEventListener("change", () => {
            if (currentPointCloud) {
                applyColorMode(currentPointCloud, colorMode.value);
            }
        });
    }

    if (horizontalButton) {
        horizontalButton.addEventListener("click", () => {
            createSection("horizontal");
        });
    }

    if (verticalButton) {
        verticalButton.addEventListener("click", () => {
            createSection("vertical");
        });
    }

    if (clearSectionButton) {
        clearSectionButton.addEventListener("click", clearSection);
    }

    if (unloadButton) {
        unloadButton.addEventListener("click", unloadCurrentPointCloud);
    }

    if (downloadButton) {
        downloadButton.addEventListener("click", downloadCurrentTile);
    }
}


/* ------------------------------------------------------------
   STAC
   ------------------------------------------------------------ */

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
        const url = new URL(
            `${CONFIG.STAC_ROOT}/search`
        );

        url.searchParams.set(
            "collections",
            CONFIG.COLLECTION
        );

        url.searchParams.set(
            "bbox",
            bbox.join(",")
        );

        url.searchParams.set(
            "limit",
            CONFIG.MAX_TILES || 200
        );

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

        setStatus(
            `${currentTiles.length} tile(s) found.`
        );
    } catch (error) {
        console.error(error);

        setStatus(
            `Tile search failed: ${error.message}`
        );
    }
}


/* ------------------------------------------------------------
   Tile rendering
   ------------------------------------------------------------ */

function renderTiles() {
    const list = $("tile-list");
    const count = $("tile-count");

    if (list) {
        list.innerHTML = "";
    }

    if (count) {
        count.textContent = String(currentTiles.length);
    }

    if (tileLayerGroup) {
        tileLayerGroup.clearLayers();
    }

    currentTiles.forEach((tile, index) => {
        renderTileOnMap(tile, index);
        renderTileInList(tile, index);
    });
}


function renderTileOnMap(tile, index) {
    if (!map || !tileLayerGroup) {
        return;
    }

    const geometry = tile.geometry;

    if (!geometry) {
        return;
    }

    let layer = null;

    try {
        layer = L.geoJSON(geometry, {
            style: {
                color: "#00ffff",
                weight: 1,
                fillOpacity: 0.05
            }
        });

        layer.on("click", () => {
            selectTile(tile);
        });

        layer.addTo(tileLayerGroup);
    } catch (error) {
        console.warn(
            "Could not render tile footprint:",
            error
        );
    }
}


function renderTileInList(tile, index) {
    const list = $("tile-list");

    if (!list) {
        return;
    }

    const item = document.createElement("button");

    item.type = "button";
    item.className = "tile-item";

    const name =
        tile.properties?.title ||
        tile.id ||
        `Tile ${index + 1}`;

    item.textContent = name;

    item.addEventListener("click", () => {
        selectTile(tile);
    });

    list.appendChild(item);
}


/* ------------------------------------------------------------
   Tile selection
   ------------------------------------------------------------ */

function selectTile(tile) {
    currentTile = tile;

    const title =
        tile.properties?.title ||
        tile.id ||
        "Selected tile";

    const selectedTitle = $("selected-title");
    const selectedInfo = $("selected-info");

    if (selectedTitle) {
        selectedTitle.textContent = title;
    }

    if (selectedInfo) {
        selectedInfo.textContent =
            tile.id || "";
    }

    updateSelectedAttributes([]);

    setStatus(`Selected ${title}`);

    loadSelectedTile();
}


/* ------------------------------------------------------------
   COPC asset detection
   ------------------------------------------------------------ */

function getCopcUrl(tile) {
    if (!tile || !tile.assets) {
        return null;
    }

    const assets = tile.assets;

    /*
     * First look for an asset explicitly marked COPC.
     */
    for (const [key, asset] of Object.entries(assets)) {
        const href = asset?.href || "";

        const mediaType =
            asset?.type ||
            asset?.media_type ||
            "";

        const roles = Array.isArray(asset?.roles)
            ? asset.roles
            : [];

        const text = (
            `${key} ${href} ${mediaType} ${roles.join(" ")}`
        ).toLowerCase();

        if (
            text.includes("copc") ||
            href.toLowerCase().endsWith(".copc.laz") ||
            href.toLowerCase().endsWith(".copc")
        ) {
            return href;
        }
    }

    /*
     * Fallback: find a LAZ/LAS asset.
     */
    for (const asset of Object.values(assets)) {
        const href = asset?.href || "";

        if (
            /\.copc(\.laz)?($|\?)/i.test(href) ||
            /\.laz($|\?)/i.test(href)
        ) {
            return href;
        }
    }

    return null;
}


/* ------------------------------------------------------------
   Load point cloud
   ------------------------------------------------------------ */

async function loadSelectedTile() {
    if (!currentTile) {
        return;
    }

    const copcUrl = getCopcUrl(currentTile);

    if (!copcUrl) {
        setStatus(
            "No COPC asset was found for this tile."
        );
        return;
    }

    setStatus("Loading COPC…");

    /*
     * If this exact tile was already loaded, simply select it.
     */
    if (loadedPointClouds.has(copcUrl)) {
        const pointcloud =
            loadedPointClouds.get(copcUrl);

        currentPointCloud = pointcloud;

        showPointCloudInfo(pointcloud);

        fitCurrentPointCloud();

        setStatus("Tile already loaded.");

        return;
    }

    /*
     * Keep the number of loaded clouds bounded.
     */
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

                    const pointcloud =
                        event.pointcloud;

                    configurePointCloud(
                        pointcloud
                    );

                    viewer.scene.addPointCloud(
                        pointcloud
                    );

                    loadedPointClouds.set(
                        copcUrl,
                        pointcloud
                    );

                    currentPointCloud =
                        pointcloud;

                    showPointCloudInfo(
                        pointcloud
                    );

                    fitCurrentPointCloud();

                    setStatus(
                        "COPC loaded."
                    );

                    resolve();
                }
            );
        });
    } catch (error) {
        console.error(error);

        setStatus(
            `COPC loading failed: ${error.message}`
        );
    }
}


/* ------------------------------------------------------------
   Configure point cloud
   ------------------------------------------------------------ */

function configurePointCloud(pointcloud) {
    const material = pointcloud.material;

    /*
     * Point appearance.
     */
    material.size = 1.0;

    material.pointSizeType =
        Potree.PointSizeType.ADAPTIVE;

    if (
        Potree.PointShape &&
        Potree.PointShape.SQUARE !== undefined
    ) {
        material.shape =
            Potree.PointShape.SQUARE;
    }

    /*
     * IMPORTANT FOR POTREE 1.8:
     *
     * Intensity should not rely on automatic scaling.
     * Explicitly use the LAS/COPC 16-bit range.
     */
    if ("intensityRange" in material) {
        material.intensityRange = [
            0,
            65535
        ];
    }

    /*
     * Start with elevation because swissSURFACE3D is
     * primarily elevation data.
     */
    applyColorMode(
        pointcloud,
        "elevation"
    );

    /*
     * Give the point cloud a reasonable bounding box.
     */
    if (
        pointcloud.boundingBox &&
        pointcloud.boundingBox.min &&
        pointcloud.boundingBox.max
    ) {
        const box = pointcloud.boundingBox;

        const center = new THREE.Vector3();

        box.getCenter(center);

        /*
         * Do not alter the actual cloud position.
         * We only use this information for sections.
         */
    }

    /*
     * If supported, make the point cloud slightly
     * brighter.
     */
    if ("opacity" in material) {
        material.opacity = 1.0;
    }

    refreshPointCloudMaterial(pointcloud);
}


/* ------------------------------------------------------------
   Material refresh
   ------------------------------------------------------------ */

function refreshPointCloudMaterial(pointcloud) {
    if (!pointcloud || !pointcloud.material) {
        return;
    }

    const material = pointcloud.material;

    /*
     * Potree regenerates its shader when these properties
     * change. Calling updateShaderSource explicitly makes
     * the behavior reliable when we change modes ourselves.
     */
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

    /*
     * Force a render.
     */
    if (viewer && viewer.renderer) {
        viewer.renderer.render(
            viewer.scene.scene,
            viewer.scene.getActiveCamera()
        );
    }
}


/* ------------------------------------------------------------
   Color modes
   ------------------------------------------------------------ */

function applyColorMode(pointcloud, mode) {
    if (!pointcloud || !pointcloud.material) {
        return;
    }

    const material = pointcloud.material;

    /*
     * Always reset active attribute first.
     *
     * This is important because Potree 1.8 uses
     * activeAttributeName for scalar-field rendering.
     */
    material.activeAttributeName = null;

    switch (mode) {
        case "rgb":
            setPointColorType(
                material,
                "RGB"
            );

            /*
             * Do not set activeAttributeName here.
             * RGB is handled directly by Potree's RGB
             * color mode.
             */
            break;


        case "intensity":
            material.activeAttributeName =
                "intensity";

            if ("intensityRange" in material) {
                material.intensityRange = [
                    0,
                    65535
                ];
            }

            setPointColorType(
                material,
                "INTENSITY"
            );

            break;


        case "intensity-gradient":
            material.activeAttributeName =
                "intensity";

            if ("intensityRange" in material) {
                material.intensityRange = [
                    0,
                    65535
                ];
            }

            setPointColorType(
                material,
                "INTENSITY_GRADIENT"
            );

            break;


        case "classification":
            material.activeAttributeName =
                "classification";

            setPointColorType(
                material,
                "CLASSIFICATION"
            );

            break;


        case "return-number":
            material.activeAttributeName =
                "returnNumber";

            setPointColorType(
                material,
                "RETURN_NUMBER"
            );

            break;


        case "number-of-returns":
            material.activeAttributeName =
                "numberOfReturns";

            /*
             * Potree 1.8 does not consistently expose a
             * dedicated PointColorType for numberOfReturns.
             *
             * Use intensity-style scalar coloring only if
             * the enum exists. Otherwise fall back to RGB
             * rather than producing a black shader.
             */
            if (
                Potree.PointColorType &&
                Potree.PointColorType.NUMBER_OF_RETURNS !==
                    undefined
            ) {
                material.pointColorType =
                    Potree.PointColorType.NUMBER_OF_RETURNS;
            } else if (
                Potree.PointColorType &&
                Potree.PointColorType.INTENSITY !==
                    undefined
            ) {
                material.pointColorType =
                    Potree.PointColorType.INTENSITY;
            }

            break;


        case "source-id":
            material.activeAttributeName =
                "pointSourceID";

            if (
                Potree.PointColorType &&
                Potree.PointColorType.SOURCE !==
                    undefined
            ) {
                material.pointColorType =
                    Potree.PointColorType.SOURCE;
            }

            break;


        case "elevation":
        default:
            /*
             * IMPORTANT:
             *
             * Do NOT use:
             *
             * material.activeAttributeName = "elevation"
             *
             * because elevation is normally a Potree color
             * mode rather than a LAS attribute called
             * "elevation".
             */
            material.activeAttributeName = null;

            if (
                Potree.PointColorType &&
                Potree.PointColorType.ELEVATION !==
                    undefined
            ) {
                material.pointColorType =
                    Potree.PointColorType.ELEVATION;
            } else if (
                Potree.PointColorType &&
                Potree.PointColorType.HEIGHT !==
                    undefined
            ) {
                material.pointColorType =
                    Potree.PointColorType.HEIGHT;
            }

            break;
    }

    /*
     * Make elevation range explicit when possible.
     */
    if (
        mode === "elevation" &&
        pointcloud.boundingBox
    ) {
        const minZ =
            pointcloud.boundingBox.min.z;

        const maxZ =
            pointcloud.boundingBox.max.z;

        if (
            Number.isFinite(minZ) &&
            Number.isFinite(maxZ) &&
            maxZ > minZ &&
            "elevationRange" in material
        ) {
            material.elevationRange = [
                minZ,
                maxZ
            ];
        }
    }

    refreshPointCloudMaterial(
        pointcloud
    );

    /*
     * Update displayed attribute information.
     */
    updateDisplayedColorMode(mode);
}


/* ------------------------------------------------------------
   PointColorType helper
   ------------------------------------------------------------ */

function setPointColorType(material, name) {
    if (
        !Potree.PointColorType ||
        Potree.PointColorType[name] === undefined
    ) {
        console.warn(
            `Potree.PointColorType.${name} is not available.`
        );

        return;
    }

    material.pointColorType =
        Potree.PointColorType[name];
}


/* ------------------------------------------------------------
   Color mode UI
   ------------------------------------------------------------ */

function updateDisplayedColorMode(mode) {
    const selector = $("color-mode");

    if (
        selector &&
        selector.value !== mode
    ) {
        selector.value = mode;
    }
}


/* ------------------------------------------------------------
   Point-cloud attributes
   ------------------------------------------------------------ */

function getPointAttributes(pointcloud) {
    const result = [];

    const attributes =
        pointcloud?.pcoGeometry?.pointAttributes;

    if (!attributes) {
        return result;
    }

    /*
     * Potree PointAttributes generally contains an
     * .attributes array.
     */
    if (Array.isArray(attributes.attributes)) {
        for (const attribute of attributes.attributes) {
            if (!attribute) {
                continue;
            }

            result.push({
                name:
                    attribute.name ||
                    attribute.attributeName ||
                    "unknown",

                description:
                    attribute.description ||
                    "",

                type:
                    attribute.type ||
                    "",

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

    updateSelectedAttributes(
        attributes
    );

    /*
     * Also write a useful summary.
     */
    const selectedInfo =
        $("selected-info");

    if (selectedInfo) {
        const names =
            attributes.map(a => a.name);

        selectedInfo.textContent =
            names.length
                ? names.join(", ")
                : "Point cloud loaded";
    }
}


function updateSelectedAttributes(attributes) {
    const list = $("attribute-list");

    if (!list) {
        return;
    }

    list.innerHTML = "";

    if (!attributes || attributes.length === 0) {
        const item =
            document.createElement("div");

        item.className =
            "attribute-item";

        item.textContent =
            "No attribute metadata available.";

        list.appendChild(item);

        return;
    }

    for (const attribute of attributes) {
        const item =
            document.createElement("div");

        item.className =
            "attribute-item";

        const name =
            attribute.name || "unknown";

        const type =
            attribute.type || "";

        const count =
            attribute.numElements
                ? ` × ${attribute.numElements}`
                : "";

        item.innerHTML =
            `<strong>${escapeHtml(name)}</strong>` +
            `<span>${escapeHtml(type)}${escapeHtml(count)}</span>`;

        list.appendChild(item);
    }
}


/* ------------------------------------------------------------
   Fit camera
   ------------------------------------------------------------ */

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


/* ------------------------------------------------------------
   Point cloud limit
   ------------------------------------------------------------ */

function enforcePointCloudLimit() {
    const max =
        CONFIG.MAX_LOADED_POINTCLOUDS || 4;

    while (
        loadedPointClouds.size >= max
    ) {
        const first =
            loadedPointClouds.entries().next();

        if (first.done) {
            break;
        }

        const [
            url,
            pointcloud
        ] = first.value;

        unloadPointCloud(
            url,
            pointcloud
        );
    }
}


/* ------------------------------------------------------------
   Unload current
   ------------------------------------------------------------ */

function unloadCurrentPointCloud() {
    if (!currentPointCloud) {
        return;
    }

    let urlToRemove = null;

    for (
        const [
            url,
            pointcloud
        ] of loadedPointClouds.entries()
    ) {
        if (
            pointcloud ===
            currentPointCloud
        ) {
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

    const selectedTitle =
        $("selected-title");

    const selectedInfo =
        $("selected-info");

    if (selectedTitle) {
        selectedTitle.textContent =
            "No tile selected";
    }

    if (selectedInfo) {
        selectedInfo.textContent = "";
    }

    updateSelectedAttributes([]);

    setStatus("Point cloud unloaded.");
}


function unloadPointCloud(url, pointcloud) {
    try {
        if (
            viewer &&
            viewer.scene &&
            viewer.scene.pointclouds
        ) {
            const index =
                viewer.scene.pointclouds.indexOf(
                    pointcloud
                );

            if (index !== -1) {
                viewer.scene.pointclouds.splice(
                    index,
                    1
                );
            }
        }

        if (
            pointcloud.parent &&
            typeof pointcloud.parent.remove ===
                "function"
        ) {
            pointcloud.parent.remove(
                pointcloud
            );
        }
    } catch (error) {
        console.warn(
            "Could not fully remove point cloud:",
            error
        );
    }

    loadedPointClouds.delete(url);

    if (
        currentPointCloud ===
        pointcloud
    ) {
        currentPointCloud = null;
    }
}


/* ------------------------------------------------------------
   Clear all point clouds
   ------------------------------------------------------------ */

function clearAllPointClouds() {
    clearSection();

    for (
        const [
            url,
            pointcloud
        ] of loadedPointClouds.entries()
    ) {
        try {
            if (
                pointcloud.parent &&
                typeof pointcloud.parent.remove ===
                    "function"
            ) {
                pointcloud.parent.remove(
                    pointcloud
                );
            }
        } catch (error) {
            console.warn(error);
        }
    }

    loadedPointClouds.clear();

    currentPointCloud = null;
    currentTile = null;

    const selectedTitle =
        $("selected-title");

    const selectedInfo =
        $("selected-info");

    if (selectedTitle) {
        selectedTitle.textContent =
            "No tile selected";
    }

    if (selectedInfo) {
        selectedInfo.textContent = "";
    }

    updateSelectedAttributes([]);

    setStatus(
        "All point clouds cleared."
    );
}


/* ============================================================
   SECTIONS
   ============================================================ */


/* ------------------------------------------------------------
   Section state
   ------------------------------------------------------------ */

function getPointCloudBounds() {
    if (
        !currentPointCloud ||
        !currentPointCloud.boundingBox
    ) {
        return null;
    }

    const box =
        currentPointCloud.boundingBox;

    const min =
        box.min.clone();

    const max =
        box.max.clone();

    return {
        min,
        max,

        size: new THREE.Vector3(
            max.x - min.x,
            max.y - min.y,
            max.z - min.z
        ),

        center: new THREE.Vector3(
            (min.x + max.x) / 2,
            (min.y + max.y) / 2,
            (min.z + max.z) / 2
        )
    };
}


/* ------------------------------------------------------------
   Create section
   ------------------------------------------------------------ */

function createSection(type) {
    if (!currentPointCloud) {
        setStatus(
            "Load a point cloud first."
        );

        return;
    }

    clearSection();

    const bounds =
        getPointCloudBounds();

    if (!bounds) {
        setStatus(
            "Point-cloud bounds are unavailable."
        );

        return;
    }

    const volume =
        new Potree.BoxVolume();

    volume.name =
        type === "horizontal"
            ? "Horizontal section"
            : "Vertical section";

    volume.clip = true;
    volume.visible = true;

    /*
     * IMPORTANT:
     *
     * Potree examples use volume.scale as the actual
     * world-space size of the clipping box.
     */
    const size =
        bounds.size.clone();

    const minimumThickness =
        Math.max(
            Math.min(
                size.x,
                size.y,
                size.z
            ) * 0.005,
            0.1
        );

    if (type === "horizontal") {
        /*
         * Thin horizontal slab.
         */
        volume.scale.set(
            Math.max(size.x, minimumThickness),
            Math.max(size.y, minimumThickness),
            Math.max(
                size.z * 0.02,
                minimumThickness
            )
        );

        volume.position.set(
            bounds.center.x,
            bounds.center.y,
            bounds.center.z
        );
    } else {
        /*
         * Thin vertical slab.
         *
         * Default orientation:
         * thin along X, large along Y/Z.
         */
        volume.scale.set(
            Math.max(
                size.x * 0.02,
                minimumThickness
            ),
            Math.max(size.y, minimumThickness),
            Math.max(size.z, minimumThickness)
        );

        volume.position.set(
            bounds.center.x,
            bounds.center.y,
            bounds.center.z
        );
    }

    /*
     * Add to Potree's scene.
     */
    viewer.scene.addVolume(
        volume
    );

    /*
     * Only show points inside the section.
     */
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
        bounds,
        position:
            type === "horizontal"
                ? bounds.center.z
                : bounds.center.x,

        thickness:
            type === "horizontal"
                ? volume.scale.z
                : volume.scale.x
    };

    createSectionControls();

    updateSectionInfo();

    setStatus(
        `${type === "horizontal" ? "Horizontal" : "Vertical"} section enabled.`
    );
}


/* ------------------------------------------------------------
   Section controls
   ------------------------------------------------------------ */

function createSectionControls() {
    const container =
        $("section-info");

    if (!container || !currentSection) {
        return;
    }

    const bounds =
        currentSection.bounds;

    if (
        currentSection.type ===
        "horizontal"
    ) {
        const min =
            bounds.min.z;

        const max =
            bounds.max.z;

        const value =
            currentSection.volume.position.z;

        const range =
            document.createElement("div");

        range.className =
            "section-control";

        range.innerHTML = `
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
        const min =
            bounds.min.x;

        const max =
            bounds.max.x;

        const value =
            currentSection.volume.position.x;

        const range =
            document.createElement("div");

        range.className =
            "section-control";

        range.innerHTML = `
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

    container.appendChild(
        createSectionTitle()
    );

    container.appendChild(
        range
    );

    const positionSlider =
        $("section-position");

    const thicknessSlider =
        $("section-thickness");

    if (positionSlider) {
        positionSlider.addEventListener(
            "input",
            updateSectionFromControls
        );
    }

    if (thicknessSlider) {
        thicknessSlider.addEventListener(
            "input",
            updateSectionFromControls
        );
    }
}


function createSectionTitle() {
    const title =
        document.createElement("div");

    title.className =
        "section-type";

    title.textContent =
        currentSection.type ===
        "horizontal"
            ? "Horizontal section"
            : "Vertical section";

    return title;
}


/* ------------------------------------------------------------
   Update section from sliders
   ------------------------------------------------------------ */

function updateSectionFromControls() {
    if (!currentSection) {
        return;
    }

    const positionSlider =
        $("section-position");

    const thicknessSlider =
        $("section-thickness");

    if (!positionSlider) {
        return;
    }

    const position =
        Number(positionSlider.value);

    const thickness =
        Number(
            thicknessSlider?.value ||
            1
        );

    const volume =
        currentSection.volume;

    if (
        currentSection.type ===
        "horizontal"
    ) {
        volume.position.z =
            position;

        volume.scale.z =
            thickness;
    } else {
        volume.position.x =
            position;

        volume.scale.x =
            thickness;
    }

    updateSectionInfo();
}


/* ------------------------------------------------------------
   Section information
   ------------------------------------------------------------ */

function updateSectionInfo() {
    if (!currentSection) {
        return;
    }

    const volume =
        currentSection.volume;

    const positionValue =
        $("section-position-value");

    const thicknessValue =
        $("section-thickness-value");

    if (
        positionValue
    ) {
        const value =
            currentSection.type ===
            "horizontal"
                ? volume.position.z
                : volume.position.x;

        positionValue.textContent =
            `${value.toFixed(2)} m`;
    }

    if (
        thicknessValue
    ) {
        const value =
            currentSection.type ===
            "horizontal"
                ? volume.scale.z
                : volume.scale.x;

        thicknessValue.textContent =
            `${value.toFixed(2)} m`;
    }
}


/* ------------------------------------------------------------
   Clear section
   ------------------------------------------------------------ */

function clearSection() {
    if (!viewer) {
        return;
    }

    if (
        currentSection &&
        currentSection.volume
    ) {
        try {
            viewer.scene.removeVolume(
                currentSection.volume
            );
        } catch (error) {
            /*
             * Some Potree builds don't expose
             * removeVolume(). Fall back to removing
             * directly from the scene volume collection.
             */
            try {
                const volumes =
                    viewer.scene.volumes;

                const index =
                    volumes.indexOf(
                        currentSection.volume
                    );

                if (index !== -1) {
                    volumes.splice(
                        index,
                        1
                    );
                }

                if (
                    currentSection.volume.parent
                ) {
                    currentSection.volume.parent.remove(
                        currentSection.volume
                    );
                }
            } catch (secondError) {
                console.warn(
                    "Could not remove section:",
                    secondError
                );
            }
        }
    }

    currentSection = null;

    /*
     * Turn clipping off.
     */
    try {
        viewer.setClipTask(
            Potree.ClipTask.NONE
        );
    } catch (error) {
        console.warn(
            "Could not disable clipping:",
            error
        );
    }

    const sectionInfo =
        $("section-info");

    if (sectionInfo) {
        sectionInfo.innerHTML =
            "No section active.";
    }
}


/* ============================================================
   PLACE SEARCH
   ============================================================ */

async function searchPlace() {
    const input =
        $("search-input");

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
            new URL(
                CONFIG.SEARCH_URL
            );

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

        renderSearchResults(
            results
        );

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
        $("search-results");

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

        const label =
            attrs.label ||
            attrs.detail ||
            result.label ||
            "Location";

        item.textContent =
            label;

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

        container.appendChild(
            item
        );
    }
}


/* ============================================================
   DOWNLOAD
   ============================================================ */

function downloadCurrentTile() {
    if (!currentTile) {
        setStatus(
            "No tile selected."
        );

        return;
    }

    const url =
        getCopcUrl(currentTile);

    if (!url) {
        setStatus(
            "No COPC URL found."
        );

        return;
    }

    /*
     * Browser security prevents reliably forcing a
     * cross-origin download from JavaScript.
     *
     * Opening the original COPC URL lets the browser
     * handle the download/stream directly.
     */
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
   DEBUG HELPERS
   ============================================================ */

window.swissCOPC = {
    viewer: () => viewer,

    currentPointCloud: () =>
        currentPointCloud,

    currentTile: () =>
        currentTile,

    section: () =>
        currentSection,

    loadedPointClouds: () =>
        loadedPointClouds,

    colorMode: mode => {
        if (currentPointCloud) {
            applyColorMode(
                currentPointCloud,
                mode
            );
        }
    },

    createHorizontalSection: () =>
        createSection("horizontal"),

    createVerticalSection: () =>
        createSection("vertical"),

    clearSection: () =>
        clearSection()
};
