"use strict";

/*
 * SwissTopo swissSURFACE3D COPC viewer
 * Potree 1.8
 *
 * IMPORTANT:
 * Do not define a global "$()" helper here.
 * Potree uses jQuery's "$()" internally.
 */

 setStatus("V1");


/* ============================================================
   GLOBAL STATE
   ============================================================ */

let viewer = null;
let map = null;

let currentPointCloud = null;
let currentTile = null;

let currentTiles = [];
let tileLayerGroup = null;

let currentSection = null;

const loadedPointClouds = new Map();

const tileLayers = new Map();
let selectedTileKey = null;


/* ============================================================
   DOM HELPER
   ============================================================ */

function getEl(id) {
    return document.getElementById(id);
}


/* ============================================================
   STATUS
   ============================================================ */

function setStatus(message) {
    const element = getEl("status");

    if (element) {
        element.textContent = message || "";
    }

    console.log("[swiss-copc]", message);
}


/* ============================================================
   HTML ESCAPING
   ============================================================ */

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
    initUI();

    setStatus("Ready");
});


/* ============================================================
   POTREE INITIALIZATION
   ============================================================ */

function initPotree() {
    const renderArea = getEl(
        "potree_render_area"
    );

    if (!renderArea) {
        console.error(
            "Missing #potree_render_area"
        );
        return;
    }

    /*
     * IMPORTANT:
     *
     * Your Potree 1.8 build expects the actual DOM
     * element here.
     *
     * We intentionally DO NOT define our own "$()"
     * function because Potree needs jQuery's "$()".
     */
    viewer = new Potree.Viewer(
        renderArea
    );

    viewer.setEDLEnabled(true);

    viewer.setFOV(60);

    viewer.setPointBudget(
        CONFIG.POINT_BUDGET || 2000000
    );

    /*
     * We intentionally do not call:
     *
     * viewer.loadGUI();
     *
     * because the project uses its own interface.
     */

    try {
        viewer.setClipTask(
            Potree.ClipTask.NONE
        );
    } catch (error) {
        console.warn(
            "Could not set initial clip task:",
            error
        );
    }
}
// ------------------------------------------------------------
// Leaflet map
// ------------------------------------------------------------

map = L.map("map", {
    zoomControl: true,
    attributionControl: true,
    preferCanvas: true
}).setView(
    CONFIG.MAP_CENTER,
    CONFIG.MAP_ZOOM
);

// ------------------------------------------------------------
// Tile footprint panes
// ------------------------------------------------------------

map.createPane("tileFootprints");
map.getPane("tileFootprints").style.zIndex = 650;

map.createPane("tileHighlight");
map.getPane("tileHighlight").style.zIndex = 660;
// ------------------------------------------------------------
// SwissTopo basemaps
// ------------------------------------------------------------

const swissTopo = L.tileLayer(
    "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg",
    {
        maxZoom: 20,
        attribution: "© swisstopo"
    }
);

const swissTopoGrey = L.tileLayer(
    "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg",
    {
        maxZoom: 20,
        attribution: "© swisstopo"
    }
);

const swissImage = L.tileLayer(
    "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage-product/default/current/3857/{z}/{x}/{y}.jpeg",
    {
        maxZoom: 20,
        attribution: "© swisstopo"
    }
);

// Default
swissTopoGrey.addTo(map);

// Small layer switcher
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

/* ============================================================
   UI INITIALIZATION
   ============================================================ */

function initUI() {
    const findButton =
        getEl("findTilesButton");

    const fitButton =
        getEl("fitButton");

    const clearButton =
        getEl("clearButton");

    const searchButton =
        getEl("search-button");

    const searchInput =
        getEl("search-input");

    const colorMode =
        getEl("color-mode");

    const horizontalButton =
        getEl(
            "horizontalSectionButton"
        );

    const verticalButton =
        getEl(
            "verticalSectionButton"
        );

    const clearSectionButton =
        getEl(
            "clearSectionButton"
        );

    const unloadButton =
        getEl("unloadButton");

    const downloadButton =
        getEl("downloadButton");


    if (findButton) {
        findButton.addEventListener(
            "click",
            findTilesFromMap
        );
    }


    if (fitButton) {
        fitButton.addEventListener(
            "click",
            fitCurrentPointCloud
        );
    }


    if (clearButton) {
        clearButton.addEventListener(
            "click",
            clearAllPointClouds
        );
    }


    if (searchButton) {
        searchButton.addEventListener(
            "click",
            searchPlace
        );
    }


    if (searchInput) {
        searchInput.addEventListener(
            "keydown",
            event => {
                if (event.key === "Enter") {
                    searchPlace();
                }
            }
        );
    }


    if (colorMode) {
        colorMode.addEventListener(
            "change",
            () => {
                if (currentPointCloud) {
                    applyColorMode(
                        currentPointCloud,
                        colorMode.value
                    );
                }
            }
        );
    }


    if (horizontalButton) {
        horizontalButton.addEventListener(
            "click",
            () => {
                createSection(
                    "horizontal"
                );
            }
        );
    }


    if (verticalButton) {
        verticalButton.addEventListener(
            "click",
            () => {
                createSection(
                    "vertical"
                );
            }
        );
    }


    if (clearSectionButton) {
        clearSectionButton.addEventListener(
            "click",
            clearSection
        );
    }


    if (unloadButton) {
        unloadButton.addEventListener(
            "click",
            unloadCurrentPointCloud
        );
    }


    if (downloadButton) {
        downloadButton.addEventListener(
            "click",
            downloadCurrentTile
        );
    }
}


/* ============================================================
   STAC TILE SEARCH
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

       console.log("=== STAC TILE SEARCH ===");
       console.log("Map bounds:", bounds);
       console.log("BBOX:", bbox);

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

           // STAC API maximum is 100
           url.searchParams.set(
               "limit",
               "100"
           );

           console.log("STAC URL:", url.toString());

           const response = await fetch(url);

           console.log(
               "STAC response:",
               response.status,
               response.statusText
           );

           if (!response.ok) {
               const text = await response.text();

               console.error(
                   "STAC error response:",
                   text
               );

               throw new Error(
                   `STAC request failed: ${response.status}`
               );
           }

           const data = await response.json();

           console.log("STAC response:", data);
           console.log(
               "STAC features:",
               data.features
           );

           currentTiles = Array.isArray(data.features)
               ? data.features
               : [];

           console.log(
               "NUMBER OF TILES:",
               currentTiles.length
           );

           if (currentTiles.length > 0) {
               console.log(
                   "FIRST TILE:",
                   currentTiles[0]
               );

               console.log(
                   "FIRST TILE GEOMETRY:",
                   currentTiles[0].geometry
               );

               console.log(
                   "FIRST TILE BBOX:",
                   currentTiles[0].bbox
               );
           }

           renderTiles();

           setStatus(
               `${currentTiles.length} tile(s) found.`
           );

       } catch (error) {
           console.error(
               "Tile search failed:",
               error
           );

           setStatus(
               `Tile search failed: ${error.message}`
           );
       }
   }


/* ============================================================
   RENDER TILE RESULTS
   ============================================================ */

   function renderTiles() {
    const list = getEl("tile-list");
    const count = getEl("tile-count");

    if (list) {
        list.innerHTML = "";
    }

    if (count) {
        count.textContent =
            String(currentTiles.length);
    }

    // Remove previous footprints
    for (const layer of tileLayers.values()) {
        if (map.hasLayer(layer)) {
            map.removeLayer(layer);
        }
    }

    tileLayers.clear();
    selectedTileKey = null;

    if (!currentTiles.length) {
        console.warn(
            "No STAC tiles returned."
        );

        return;
    }

    const footprintLayers = [];

    currentTiles.forEach((tile, index) => {
        const layer =
            renderTileOnMap(tile, index);

        if (layer) {
            footprintLayers.push(layer);
        }

        renderTileInList(tile, index);
    });

    console.log(
        "Rendered footprint layers:",
        footprintLayers.length
    );

    // Zoom to the returned tiles
    if (footprintLayers.length > 0) {
        const group =
            L.featureGroup(footprintLayers);

        map.fitBounds(
            group.getBounds().pad(0.05)
        );
    }
}

/* ============================================================
   TILE FOOTPRINT ON MAP
   ============================================================ */



   function geometryFromTile(tile) {
       if (tile.geometry) {
           return tile.geometry;
       }

       // Fallback: create a polygon from STAC bbox
       if (Array.isArray(tile.bbox) && tile.bbox.length >= 4) {
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

       return null;
   }

   function tileKey(tile, index) {
       return (
           tile.id ||
           tile.properties?.id ||
           tile.properties?.title ||
           tile.properties?.name ||
           `tile-${index}`
       );
   }


   function geometryFromTile(tile) {

       // Standard STAC geometry
       if (tile.geometry) {
           return tile.geometry;
       }

       // Fallback if geometry happens to be nested
       if (tile.properties?.geometry) {
           return tile.properties.geometry;
       }

       // STAC bbox is WGS84 lon/lat
       if (
           Array.isArray(tile.bbox) &&
           tile.bbox.length >= 4
       ) {
           const [
               west,
               south,
               east,
               north
           ] = tile.bbox;

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

       return null;
   }


function geometryFromTile(tile) {

    // Normal STAC geometry
    if (tile.geometry) {
        return tile.geometry;
    }

    // Some responses may put geometry in properties
    if (tile.properties?.geometry) {
        return tile.properties.geometry;
    }

    // STAC bbox fallback
    if (
        Array.isArray(tile.bbox) &&
        tile.bbox.length >= 4
    ) {
        const [
            west,
            south,
            east,
            north
        ] = tile.bbox;

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

    return null;
}

function renderTileOnMap(tile, index) {
    const geometry = geometryFromTile(tile);

    const key = tileKey(tile, index);

    console.log(
        "Rendering tile:",
        key
    );

    console.log(
        "Geometry:",
        geometry
    );

    if (!geometry) {
        console.warn(
            "Tile has no geometry:",
            tile
        );

        return null;
    }

    const layer = L.geoJSON(
        geometry,
        {
            pane: "tileFootprints",

            style: {
                color: "#0066ff",
                weight: 2,
                opacity: 1,
                fillColor: "#3388ff",
                fillOpacity: 0.25
            }
        }
    );

    layer.addTo(map);

    layer.on(
        "click",
        function(event) {
            L.DomEvent.stopPropagation(event);

            selectTile(
                tile,
                index
            );
        }
    );

    tileLayers.set(
        key,
        layer
    );

    return layer;
}

/* ============================================================
   TILE LIST
   ============================================================ */

   function renderTileInList(tile, index) {
       const list = getEl("tile-list");
       if (!list) return;

       const item = document.createElement("button");
       item.type = "button";
       item.className = "tile-item";

       const name =
           tile.properties?.title ||
           tile.id ||
           `Tile ${index + 1}`;

       item.textContent = name;

       item.addEventListener("click", () => {
           selectTile(tile, index);
       });

       list.appendChild(item);
   }

/* ============================================================
   SELECT TILE
   ============================================================ */

   function selectTile(tile, index = 0) {
       const key = tileKey(tile, index);

       // Reset previous selection
       if (selectedTileKey && tileLayers.has(selectedTileKey)) {
           const oldLayer = tileLayers.get(selectedTileKey);

           oldLayer.setStyle({
               weight: 2,
               color: "#2563eb",
               fillColor: "#3b82f6",
               fillOpacity: 0.12
           });
       }

       selectedTileKey = key;

       // Highlight new selection
       const layer = tileLayers.get(key);

       if (layer) {
           layer.setStyle({
               weight: 4,
               color: "#f59e0b",
               fillColor: "#f59e0b",
               fillOpacity: 0.30
           });

           layer.bringToFront();
       }

       currentTile = tile;

       updateSelectedPanel(tile);

       // Keep your existing loading behaviour
       loadSelectedTile();
   }


/* ============================================================
   FIND COPC ASSET
   ============================================================ */

function getCopcUrl(tile) {
    if (
        !tile ||
        !tile.assets
    ) {
        return null;
    }

    const assets =
        tile.assets;


    /*
     * Prefer explicitly COPC-labelled assets.
     */
    for (
        const [
            key,
            asset
        ] of Object.entries(assets)
    ) {
        const href =
            asset?.href || "";

        const mediaType =
            asset?.type ||
            asset?.media_type ||
            "";

        const roles =
            Array.isArray(
                asset?.roles
            )
                ? asset.roles
                : [];

        const text = (
            `${key} ${href} ${mediaType} ${roles.join(" ")}`
        ).toLowerCase();


        if (
            text.includes("copc") ||
            href
                .toLowerCase()
                .endsWith(
                    ".copc.laz"
                ) ||
            href
                .toLowerCase()
                .endsWith(
                    ".copc"
                )
        ) {
            return href;
        }
    }


    /*
     * Fallback to LAZ.
     */
    for (
        const asset of Object.values(
            assets
        )
    ) {
        const href =
            asset?.href || "";

        if (
            /\.copc(\.laz)?($|\?)/i.test(
                href
            ) ||
            /\.laz($|\?)/i.test(
                href
            )
        ) {
            return href;
        }
    }


    return null;
}


/* ============================================================
   LOAD SELECTED TILE
   ============================================================ */

async function loadSelectedTile() {
    if (!currentTile) {
        return;
    }

    const copcUrl =
        getCopcUrl(
            currentTile
        );


    if (!copcUrl) {
        setStatus(
            "No COPC asset was found for this tile."
        );

        return;
    }


    setStatus(
        "Loading COPC…"
    );


    /*
     * Already loaded?
     */
    if (
        loadedPointClouds.has(
            copcUrl
        )
    ) {
        currentPointCloud =
            loadedPointClouds.get(
                copcUrl
            );

        showPointCloudInfo(
            currentPointCloud
        );

        fitCurrentPointCloud();

        setStatus(
            "Tile already loaded."
        );

        return;
    }


    enforcePointCloudLimit();


    try {
        await new Promise(
            (resolve, reject) => {

                Potree.loadPointCloud(
                    copcUrl,
                    currentTile.id ||
                        "swissSURFACE3D",

                    event => {

                        if (
                            !event ||
                            !event.pointcloud
                        ) {
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
            }
        );

    } catch (error) {
        console.error(error);

        setStatus(
            `COPC loading failed: ${error.message}`
        );
    }
}


/* ============================================================
   CONFIGURE POINT CLOUD
   ============================================================ */

function configurePointCloud(
    pointcloud
) {
    const material =
        pointcloud.material;


    /*
     * Point size.
     */
    material.size =
        1.0;


    /*
     * Adaptive point sizing.
     */
    if (
        Potree.PointSizeType &&
        Potree.PointSizeType.ADAPTIVE !==
            undefined
    ) {
        material.pointSizeType =
            Potree.PointSizeType.ADAPTIVE;
    }


    /*
     * Square points.
     */
    if (
        Potree.PointShape &&
        Potree.PointShape.SQUARE !==
            undefined
    ) {
        material.shape =
            Potree.PointShape.SQUARE;
    }


    /*
     * IMPORTANT:
     *
     * Potree 1.7/1.8 often needs explicit intensity
     * scaling. swissSURFACE3D LAS intensity is generally
     * represented as a 16-bit value.
     */
    if (
        "intensityRange" in material
    ) {
        material.intensityRange = [
            0,
            65535
        ];
    }


    /*
     * Start with elevation.
     */
    applyColorMode(
        pointcloud,
        "elevation"
    );


    /*
     * Full opacity.
     */
    if (
        "opacity" in material
    ) {
        material.opacity =
            1.0;
    }


    refreshPointCloudMaterial(
        pointcloud
    );
}


/* ============================================================
   MATERIAL / SHADER REFRESH
   ============================================================ */

function refreshPointCloudMaterial(
    pointcloud
) {
    if (
        !pointcloud ||
        !pointcloud.material
    ) {
        return;
    }

    const material =
        pointcloud.material;


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
     * Tell WebGL that the material changed.
     */
    material.needsUpdate =
        true;
}


/* ============================================================
   COLOR MODES
   ============================================================ */

function applyColorMode(
    pointcloud,
    mode
) {
    if (
        !pointcloud ||
        !pointcloud.material
    ) {
        return;
    }

    const material =
        pointcloud.material;


    /*
     * Reset scalar attribute.
     *
     * This is critical for Potree 1.8.
     */
    material.activeAttributeName =
        null;


    switch (mode) {

        /* ----------------------------------------------------
           RGB
           ---------------------------------------------------- */

        case "rgb":

            setPointColorType(
                material,
                "RGB"
            );

            break;


        /* ----------------------------------------------------
           INTENSITY
           ---------------------------------------------------- */

        case "intensity":

            material.activeAttributeName =
                "intensity";


            if (
                "intensityRange" in material
            ) {
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


        /* ----------------------------------------------------
           INTENSITY GRADIENT
           ---------------------------------------------------- */

        case "intensity-gradient":

            material.activeAttributeName =
                "intensity";


            if (
                "intensityRange" in material
            ) {
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


        /* ----------------------------------------------------
           CLASSIFICATION
           ---------------------------------------------------- */

        case "classification":

            material.activeAttributeName =
                "classification";


            setPointColorType(
                material,
                "CLASSIFICATION"
            );

            break;


        /* ----------------------------------------------------
           RETURN NUMBER
           ---------------------------------------------------- */

        case "return-number":

            material.activeAttributeName =
                "returnNumber";


            setPointColorType(
                material,
                "RETURN_NUMBER"
            );

            break;


        /* ----------------------------------------------------
           NUMBER OF RETURNS
           ---------------------------------------------------- */

        case "number-of-returns":

            material.activeAttributeName =
                "numberOfReturns";


            /*
             * Some Potree 1.8 builds don't provide
             * NUMBER_OF_RETURNS.
             */
            if (
                Potree.PointColorType &&
                Potree.PointColorType
                    .NUMBER_OF_RETURNS !==
                    undefined
            ) {

                material.pointColorType =
                    Potree.PointColorType
                        .NUMBER_OF_RETURNS;

            } else {

                /*
                 * Don't invent an unsupported enum.
                 * Keep the scalar attribute selected,
                 * but use intensity as the available
                 * scalar shader.
                 */
                setPointColorType(
                    material,
                    "INTENSITY"
                );
            }

            break;


        /* ----------------------------------------------------
           SOURCE ID
           ---------------------------------------------------- */

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


        /* ----------------------------------------------------
           ELEVATION
           ---------------------------------------------------- */

        case "elevation":

        default:

            /*
             * IMPORTANT:
             *
             * Do NOT set:
             *
             * activeAttributeName = "elevation"
             *
             * Elevation is handled as Potree's
             * elevation/height color mode.
             */
            material.activeAttributeName =
                null;


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
     * Explicit elevation range.
     */
    if (
        mode === "elevation" &&
        pointcloud.boundingBox
    ) {

        const minZ =
            pointcloud
                .boundingBox
                .min
                .z;

        const maxZ =
            pointcloud
                .boundingBox
                .max
                .z;


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


    updateDisplayedColorMode(
        mode
    );
}


/* ============================================================
   POINT COLOR TYPE HELPER
   ============================================================ */

function setPointColorType(
    material,
    name
) {
    if (
        !Potree.PointColorType ||
        Potree.PointColorType[name] ===
            undefined
    ) {
        console.warn(
            `Potree.PointColorType.${name} is not available.`
        );

        return false;
    }


    material.pointColorType =
        Potree.PointColorType[name];


    return true;
}


/* ============================================================
   COLOR MODE UI
   ============================================================ */

function updateDisplayedColorMode(
    mode
) {
    const selector =
        getEl("color-mode");

    if (
        selector &&
        selector.value !== mode
    ) {
        selector.value =
            mode;
    }
}


/* ============================================================
   POINT-CLOUD ATTRIBUTES
   ============================================================ */

function getPointAttributes(
    pointcloud
) {
    const result = [];

    const pointAttributes =
        pointcloud
            ?.pcoGeometry
            ?.pointAttributes;


    if (!pointAttributes) {
        return result;
    }


    if (
        Array.isArray(
            pointAttributes.attributes
        )
    ) {

        for (
            const attribute of
                pointAttributes.attributes
        ) {

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


/* ============================================================
   SHOW POINT-CLOUD INFO
   ============================================================ */

function showPointCloudInfo(
    pointcloud
) {
    const attributes =
        getPointAttributes(
            pointcloud
        );


    updateSelectedAttributes(
        attributes
    );


    const selectedInfo =
        getEl("selected-info");


    if (selectedInfo) {

        const names =
            attributes.map(
                attribute =>
                    attribute.name
            );


        selectedInfo.textContent =
            names.length
                ? names.join(", ")
                : "Point cloud loaded";
    }
}


/* ============================================================
   ATTRIBUTE LIST UI
   ============================================================ */

function updateSelectedAttributes(
    attributes
) {
    const list =
        getEl("attribute-list");


    if (!list) {
        return;
    }


    list.innerHTML = "";


    if (
        !attributes ||
        attributes.length === 0
    ) {

        const item =
            document.createElement(
                "div"
            );

        item.className =
            "attribute-item";

        item.textContent =
            "No attribute metadata available.";

        list.appendChild(
            item
        );

        return;
    }


    for (
        const attribute of attributes
    ) {

        const item =
            document.createElement(
                "div"
            );

        item.className =
            "attribute-item";


        const name =
            attribute.name ||
            "unknown";


        const type =
            attribute.type ||
            "";


        const count =
            attribute.numElements
                ? ` × ${attribute.numElements}`
                : "";


        item.innerHTML =
            `<strong>${escapeHtml(name)}</strong>` +
            `<span>${escapeHtml(type)}${escapeHtml(count)}</span>`;


        list.appendChild(
            item
        );
    }
}


/* ============================================================
   CAMERA FIT
   ============================================================ */

function fitCurrentPointCloud() {
    if (
        !viewer ||
        !currentPointCloud
    ) {
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


/* ============================================================
   POINT-CLOUD LIMIT
   ============================================================ */

function enforcePointCloudLimit() {
    const max =
        CONFIG.MAX_LOADED_POINTCLOUDS ||
        4;


    while (
        loadedPointClouds.size >= max
    ) {

        const first =
            loadedPointClouds
                .entries()
                .next();


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


/* ============================================================
   UNLOAD CURRENT POINT CLOUD
   ============================================================ */

function unloadCurrentPointCloud() {
    if (!currentPointCloud) {
        return;
    }


    let urlToRemove =
        null;


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

            urlToRemove =
                url;

            break;
        }
    }


    if (urlToRemove) {
        unloadPointCloud(
            urlToRemove,
            currentPointCloud
        );
    }


    currentPointCloud =
        null;


    clearSection();


    const selectedTitle =
        getEl("selected-title");


    const selectedInfo =
        getEl("selected-info");


    if (selectedTitle) {
        selectedTitle.textContent =
            "No tile selected";
    }


    if (selectedInfo) {
        selectedInfo.textContent =
            "";
    }


    updateSelectedAttributes(
        []
    );


    setStatus(
        "Point cloud unloaded."
    );
}


/* ============================================================
   UNLOAD POINT CLOUD
   ============================================================ */

function unloadPointCloud(
    url,
    pointcloud
) {
    try {

        if (
            viewer &&
            viewer.scene &&
            Array.isArray(
                viewer.scene.pointclouds
            )
        ) {

            const index =
                viewer.scene
                    .pointclouds
                    .indexOf(
                        pointcloud
                    );


            if (index !== -1) {
                viewer.scene
                    .pointclouds
                    .splice(
                        index,
                        1
                    );
            }
        }


        if (
            pointcloud.parent &&
            typeof pointcloud
                .parent
                .remove ===
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


    loadedPointClouds.delete(
        url
    );


    if (
        currentPointCloud ===
        pointcloud
    ) {

        currentPointCloud =
            null;
    }
}


/* ============================================================
   CLEAR ALL POINT CLOUDS
   ============================================================ */

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
                typeof pointcloud
                    .parent
                    .remove ===
                    "function"
            ) {

                pointcloud.parent.remove(
                    pointcloud
                );
            }

        } catch (error) {

            console.warn(
                error
            );
        }
    }


    loadedPointClouds.clear();


    currentPointCloud =
        null;

    currentTile =
        null;


    const selectedTitle =
        getEl("selected-title");


    const selectedInfo =
        getEl("selected-info");


    if (selectedTitle) {
        selectedTitle.textContent =
            "No tile selected";
    }


    if (selectedInfo) {
        selectedInfo.textContent =
            "";
    }


    updateSelectedAttributes(
        []
    );


    setStatus(
        "All point clouds cleared."
    );
}


/* ============================================================
   SECTION BOUNDS
   ============================================================ */

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

        size:
            new THREE.Vector3(
                max.x - min.x,
                max.y - min.y,
                max.z - min.z
            ),

        center:
            new THREE.Vector3(
                (min.x + max.x) / 2,
                (min.y + max.y) / 2,
                (min.z + max.z) / 2
            )
    };
}


/* ============================================================
   CREATE SECTION
   ============================================================ */

function createSection(
    type
) {
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


    volume.clip =
        true;


    volume.visible =
        true;


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


    if (
        type === "horizontal"
    ) {

        /*
         * Large XY slab, thin Z.
         */
        volume.scale.set(
            Math.max(
                size.x,
                minimumThickness
            ),

            Math.max(
                size.y,
                minimumThickness
            ),

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
         * Vertical slab.
         *
         * Thin X, large Y and Z.
         */
        volume.scale.set(
            Math.max(
                size.x * 0.02,
                minimumThickness
            ),

            Math.max(
                size.y,
                minimumThickness
            ),

            Math.max(
                size.z,
                minimumThickness
            )
        );


        volume.position.set(
            bounds.center.x,
            bounds.center.y,
            bounds.center.z
        );
    }


    viewer.scene.addVolume(
        volume
    );


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
        `${
            type === "horizontal"
                ? "Horizontal"
                : "Vertical"
        } section enabled.`
    );
}


/* ============================================================
   SECTION CONTROLS
   ============================================================ */

function createSectionControls() {
    const container =
        getEl("section-info");


    if (
        !container ||
        !currentSection
    ) {
        return;
    }


    const bounds =
        currentSection.bounds;


    const controls =
        document.createElement(
            "div"
        );


    controls.className =
        "section-control";


    if (
        currentSection.type ===
        "horizontal"
    ) {

        const min =
            bounds.min.z;

        const max =
            bounds.max.z;

        const value =
            currentSection
                .volume
                .position
                .z;


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
                step="${Math.max(
                    (max - min) / 1000,
                    0.01
                )}"
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
                min="${Math.max(
                    (max - min) / 1000,
                    0.01
                )}"
                max="${Math.max(
                    (max - min) * 0.25,
                    0.1
                )}"
                step="${Math.max(
                    (max - min) / 1000,
                    0.01
                )}"
                value="${currentSection.volume.scale.z}"
            >
        `;

    } else {

        const min =
            bounds.min.x;

        const max =
            bounds.max.x;

        const value =
            currentSection
                .volume
                .position
                .x;


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
                step="${Math.max(
                    (max - min) / 1000,
                    0.01
                )}"
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
                min="${Math.max(
                    (max - min) / 1000,
                    0.01
                )}"
                max="${Math.max(
                    (max - min) * 0.25,
                    0.1
                )}"
                step="${Math.max(
                    (max - min) / 1000,
                    0.01
                )}"
                value="${currentSection.volume.scale.x}"
            >
        `;
    }


    container.innerHTML = "";

    container.appendChild(
        controls
    );


    const positionSlider =
        getEl("section-position");


    const thicknessSlider =
        getEl("section-thickness");


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


/* ============================================================
   UPDATE SECTION FROM SLIDERS
   ============================================================ */

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
        Number(
            positionSlider.value
        );


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


/* ============================================================
   SECTION INFO
   ============================================================ */

function updateSectionInfo() {
    if (!currentSection) {
        return;
    }


    const volume =
        currentSection.volume;


    const positionValue =
        getEl(
            "section-position-value"
        );


    const thicknessValue =
        getEl(
            "section-thickness-value"
        );


    if (positionValue) {

        const value =
            currentSection.type ===
            "horizontal"
                ? volume.position.z
                : volume.position.x;


        positionValue.textContent =
            `${value.toFixed(2)} m`;
    }


    if (thicknessValue) {

        const value =
            currentSection.type ===
            "horizontal"
                ? volume.scale.z
                : volume.scale.x;


        thicknessValue.textContent =
            `${value.toFixed(2)} m`;
    }
}


/* ============================================================
   CLEAR SECTION
   ============================================================ */

function clearSection() {
    if (!viewer) {
        return;
    }


    if (
        currentSection &&
        currentSection.volume
    ) {

        const volume =
            currentSection.volume;


        try {

            if (
                typeof viewer.scene
                    .removeVolume ===
                    "function"
            ) {

                viewer.scene.removeVolume(
                    volume
                );

            } else {

                /*
                 * Fallback for Potree builds without
                 * scene.removeVolume().
                 */
                if (
                    viewer.scene.volumes
                ) {

                    const index =
                        viewer.scene
                            .volumes
                            .indexOf(
                                volume
                            );


                    if (index !== -1) {

                        viewer.scene
                            .volumes
                            .splice(
                                index,
                                1
                            );
                    }
                }


                if (
                    volume.parent
                ) {

                    volume.parent.remove(
                        volume
                    );
                }
            }

        } catch (error) {

            console.warn(
                "Could not remove section:",
                error
            );
        }
    }


    currentSection =
        null;


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
        getEl("section-info");


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


/* ============================================================
   SEARCH RESULTS
   ============================================================ */

function renderSearchResults(
    results
) {
    const container =
        getEl("search-results");


    if (!container) {
        return;
    }


    container.innerHTML = "";


    for (
        const result of results
    ) {

        const item =
            document.createElement(
                "button"
            );


        item.type =
            "button";


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
                    Number.isFinite(
                        lat
                    ) &&
                    Number.isFinite(
                        lon
                    )
                ) {

                    map.setView(
                        [
                            lat,
                            lon
                        ],
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
        getCopcUrl(
            currentTile
        );


    if (!url) {

        setStatus(
            "No COPC URL found."
        );

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

    viewer: () =>
        viewer,

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
        createSection(
            "horizontal"
        ),

    createVerticalSection: () =>
        createSection(
            "vertical"
        ),

    clearSection: () =>
        clearSection()
};
