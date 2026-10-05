"use strict";

/*
 * SwissTopo swissSURFACE3D COPC viewer
 * Potree 1.8
 *
 * Features:
 * - STAC tile search
 * - SwissTopo tile footprints
 * - COPC loading
 * - Elevation / intensity / classification / return modes
 * - SWISSIMAGE RGB projected vertically onto LiDAR points
 * - Circular points
 * - Horizontal / vertical sections
 * - Load / unload / download controls
 * - Place search
 *
 * IMPORTANT:
 * Do NOT define a global "$()" helper.
 * Potree uses jQuery's "$()" internally.
 */

 setStatus("B_8");



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


/* ============================================================
   SWISSIMAGE RGB STATE
   ============================================================ */

const SWISSIMAGE_RGB = {
    layer:
        "ch.swisstopo.swissimage-product",

    zoom:
        25,

    tileSize:
        256,

    cache:
        new Map(),

    raster:
        null,

    loading:
        false,

    pointCloudsProcessed:
        new WeakSet(),

    processTimer:
        null
};


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

document.addEventListener(
    "DOMContentLoaded",
    () => {

        initPotree();

        initMap();

        initUI();

        updateControlState();

        setStatus("Ready");
    }
);


/* ============================================================
   POTREE INITIALIZATION
   ============================================================ */

function initPotree() {

    const renderArea =
        getEl("potree_render_area");

    if (!renderArea) {

        console.error(
            "Missing #potree_render_area"
        );

        return;
    }


    viewer =
        new Potree.Viewer(
            renderArea
        );


    /*
     * Black Potree background.
     */
    try {
        viewer.setBackground("black");
    } catch (error) {
        console.warn(
            "Could not set Potree background:",
            error
        );
    }


    viewer.setEDLEnabled(true);

    viewer.setFOV(60);


    viewer.setPointBudget(
        CONFIG.POINT_BUDGET ||
        20000000
    );


    /*
     * Do not load Potree's sidebar.
     */
    try {
        viewer.setClipTask(
            Potree.ClipTask.NONE
        );
    } catch (error) {
        console.warn(
            error
        );
    }
}


/* ============================================================
   MAP INITIALIZATION
   ============================================================ */

function initMap() {

    map =
        L.map(
            "map",
            {
                zoomControl: true,
                attributionControl: true,
                preferCanvas: true
            }
        ).setView(
            CONFIG.MAP_CENTER,
            CONFIG.MAP_ZOOM
        );


    /*
     * Footprint panes.
     */
    map.createPane(
        "tileFootprints"
    );

    map.getPane(
        "tileFootprints"
    ).style.zIndex = 700;


    map.createPane(
        "tileHighlight"
    );

    map.getPane(
        "tileHighlight"
    ).style.zIndex = 710;


    /*
     * SwissTopo colour.
     */
    const swissTopo =
        L.tileLayer(
            "https://wmts.geo.admin.ch/1.0.0/" +
            "ch.swisstopo.pixelkarte-farbe/" +
            "default/current/3857/{z}/{x}/{y}.jpeg",
            {
                maxZoom: 20,
                attribution: "© swisstopo"
            }
        );


    /*
     * SwissTopo grey.
     */
    const swissTopoGrey =
        L.tileLayer(
            "https://wmts.geo.admin.ch/1.0.0/" +
            "ch.swisstopo.pixelkarte-grau/" +
            "default/current/3857/{z}/{x}/{y}.jpeg",
            {
                maxZoom: 20,
                attribution: "© swisstopo"
            }
        );


    /*
     * SWISSIMAGE map layer.
     */
    const swissImage =
        L.tileLayer(
            "https://wmts.geo.admin.ch/1.0.0/" +
            "ch.swisstopo.swissimage-product/" +
            "default/current/3857/{z}/{x}/{y}.jpeg",
            {
                maxZoom: 20,
                attribution: "© swisstopo"
            }
        );


    /*
     * Default background.
     */
    swissTopoGrey.addTo(map);


    /*
     * Map layer switcher.
     */
    L.control.layers(
        {
            "SwissTopo":
                swissTopo,

            "SwissTopo grey":
                swissTopoGrey,

            "SWISSIMAGE":
                swissImage
        },
        null,
        {
            collapsed: true,
            position: "topright"
        }
    ).addTo(map);
}


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
        getEl("horizontal-section-button");

    const verticalButton =
        getEl("vertical-section-button");

    const clearSectionButton =
        getEl("clear-section-button");

    const loadButton =
        getEl("load-button");

    const unloadButton =
        getEl("unload-button");

    const downloadButton =
        getEl("download-button");


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

                if (!currentPointCloud) {
                    return;
                }

                applyColorMode(
                    currentPointCloud,
                    colorMode.value
                );
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


    if (loadButton) {

        loadButton.addEventListener(
            "click",
            loadSelectedTile
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
   BUTTON STATE
   ============================================================ */

   function updateControlState() {
       const loadButton = getEl("load-button");
       const unloadButton = getEl("unload-button");
       const downloadButton = getEl("download-button");

       const horizontalButton = getEl("horizontal-section-button");
       const verticalButton = getEl("vertical-section-button");
       const clearSectionButton = getEl("clear-section-button");

       const colorMode = getEl("color-mode");

       const hasTile = !!currentTile;
       const hasPointCloud = !!currentPointCloud;
       const hasSection = !!currentSection;
       const hasDownload = hasTile && !!getCopcUrl(currentTile);

       if (loadButton) {
           loadButton.disabled = !hasTile || hasPointCloud;
       }

       if (unloadButton) {
           unloadButton.disabled = !hasPointCloud;
       }

       if (downloadButton) {
           downloadButton.disabled = !hasDownload;
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
           colorMode.enabled = !hasPointCloud;
       }
   }

/* ============================================================
   STAC TILE SEARCH
   ============================================================ */

async function findTilesFromMap() {

    if (!map) {

        setStatus(
            "Map is not available."
        );

        return;
    }


    const bounds =
        map.getBounds();


    const bbox = [
        bounds.getWest(),
        bounds.getSouth(),
        bounds.getEast(),
        bounds.getNorth()
    ];


    console.log(
        "=== STAC TILE SEARCH ==="
    );

    console.log(
        "Map bounds:",
        bounds
    );

    console.log(
        "BBOX:",
        bbox
    );


    setStatus(
        "Searching swissSURFACE3D tiles…"
    );


    try {

        const url =
            new URL(
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
            "100"
        );


        console.log(
            "STAC URL:",
            url.toString()
        );


        const response =
            await fetch(url);


        if (!response.ok) {

            const text =
                await response.text();

            console.error(
                text
            );

            throw new Error(
                `STAC request failed: ${response.status}`
            );
        }


        const data =
            await response.json();


        currentTiles =
            Array.isArray(data.features)
                ? data.features
                : [];


        console.log(
            "STAC tiles:",
            currentTiles.length
        );


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
   TILE RENDERING
   ============================================================ */

function renderTiles() {

    const list =
        getEl("tile-list");

    const count =
        getEl("tile-count");


    if (list) {
        list.innerHTML = "";
    }


    if (count) {

        count.textContent =
            String(
                currentTiles.length
            );
    }


    for (
        const layer of
            tileLayers.values()
    ) {

        if (map.hasLayer(layer)) {

            map.removeLayer(
                layer
            );
        }
    }


    tileLayers.clear();

    selectedTileKey = null;


    if (
        currentTiles.length === 0
    ) {

        return;
    }


    const footprintLayers = [];


    currentTiles.forEach(
        (tile, index) => {

            const layer =
                renderTileOnMap(
                    tile,
                    index
                );


            if (layer) {

                footprintLayers.push(
                    layer
                );
            }


            renderTileInList(
                tile,
                index
            );
        }
    );


    if (
        footprintLayers.length > 0
    ) {

        const group =
            L.featureGroup(
                footprintLayers
            );


        map.fitBounds(
            group
                .getBounds()
                .pad(0.05)
        );
    }
}


/* ============================================================
   TILE FOOTPRINT
   ============================================================ */

function renderTileOnMap(
    tile,
    index
) {

    const geometry =
        geometryFromTile(tile);


    if (!geometry) {

        console.warn(
            "No geometry for tile:",
            tile
        );

        return null;
    }


    const key =
        tileKey(
            tile,
            index
        );


    const layer =
        L.geoJSON(
            geometry,
            {
                pane:
                    "tileFootprints",

                interactive:
                    true,

                style: {
                    color:
                        "#0066ff",

                    weight:
                        3,

                    opacity:
                        1,

                    fillColor:
                        "#1683ff",

                    fillOpacity:
                        0.28
                }
            }
        );


    layer.addTo(map);


    layer.on(
        "click",
        event => {

            L.DomEvent.stopPropagation(
                event
            );

            selectTile(
                tile,
                index
            );
        }
    );


    layer.on(
        "mouseover",
        () => {

            if (
                selectedTileKey !==
                key
            ) {

                layer.setStyle({
                    color:
                        "#00a8ff",

                    weight:
                        4,

                    fillColor:
                        "#1683ff",

                    fillOpacity:
                        0.40
                });
            }


            layer.bringToFront();
        }
    );


    layer.on(
        "mouseout",
        () => {

            if (
                selectedTileKey !==
                key
            ) {

                layer.setStyle({
                    color:
                        "#0066ff",

                    weight:
                        3,

                    fillColor:
                        "#1683ff",

                    fillOpacity:
                        0.28
                });
            }
        }
    );


    tileLayers.set(
        key,
        layer
    );


    return layer;
}


/* ============================================================
   TILE GEOMETRY
   ============================================================ */

function tileKey(
    tile,
    index
) {

    return (
        tile.id ||
        tile.properties?.id ||
        tile.properties?.title ||
        tile.properties?.name ||
        `tile-${index}`
    );
}


function geometryFromTile(
    tile
) {

    /*
     * Use bbox first.
     *
     * STAC geometry can represent the item
     * center rather than the complete tile.
     */
    if (
        Array.isArray(tile.bbox) &&
        tile.bbox.length >= 4
    ) {

        const [
            west,
            south,
            east,
            north
        ] =
            tile.bbox;


        return {
            type:
                "Polygon",

            coordinates: [[
                [
                    west,
                    south
                ],

                [
                    east,
                    south
                ],

                [
                    east,
                    north
                ],

                [
                    west,
                    north
                ],

                [
                    west,
                    south
                ]
            ]]
        };
    }


    if (tile.geometry) {

        return tile.geometry;
    }


    return null;
}


/* ============================================================
   TILE LIST
   ============================================================ */

function renderTileInList(
    tile,
    index
) {

    const list =
        getEl("tile-list");


    if (!list) {
        return;
    }


    const item =
        document.createElement(
            "button"
        );


    item.type =
        "button";


    item.className =
        "tile-item";


    const name =
        tile.properties?.title ||
        tile.id ||
        `Tile ${index + 1}`;


    item.textContent =
        name;


    item.addEventListener(
        "click",
        () => {

            selectTile(
                tile,
                index
            );
        }
    );


    list.appendChild(
        item
    );
}


/* ============================================================
   TILE SELECTION
   ============================================================ */

function selectTile(
    tile,
    index = 0
) {

    const key =
        tileKey(
            tile,
            index
        );


    /*
     * Reset previous footprint.
     */
    if (
        selectedTileKey &&
        tileLayers.has(
            selectedTileKey
        )
    ) {

        tileLayers
            .get(selectedTileKey)
            .setStyle({
                weight:
                    3,

                color:
                    "#0066ff",

                fillColor:
                    "#1683ff",

                fillOpacity:
                    0.28
            });
    }


    selectedTileKey =
        key;


    /*
     * Highlight current tile.
     */
    const layer =
        tileLayers.get(
            key
        );


    if (layer) {

        layer.setStyle({
            weight:
                5,

            color:
                "#ff8c00",

            fillColor:
                "#ffb000",

            fillOpacity:
                0.38
        });


        layer.bringToFront();


        try {

            map.fitBounds(
                layer
                    .getBounds()
                    .pad(0.10)
            );

        } catch (error) {

            console.warn(
                error
            );
        }
    }


    currentTile =
        tile;


    updateSelectedPanel(
        tile
    );


    updateControlState();


    /*
     * Keep the original convenient behaviour:
     * automatically load the selected tile.
     */
    loadSelectedTile();
}


/* ============================================================
   SELECTED TILE PANEL
   ============================================================ */

function updateSelectedPanel(
    tile
) {

    const title =
        getEl("selected-title");

    const info =
        getEl("selected-info");

    const attributes =
        getEl("selected-attributes");


    const tileName =
        tile?.properties?.title ||
        tile?.id ||
        "Selected tile";


    if (title) {

        title.textContent =
            tileName;
    }


    if (info) {

        const bbox =
            tile?.bbox;


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

            info.textContent =
                "Tile selected.";
        }
    }


    if (attributes) {

        attributes.innerHTML =
            "";


        const assets =
            tile?.assets || {};


        for (
            const [
                key,
                asset
            ] of Object.entries(assets)
        ) {

            const row =
                document.createElement(
                    "div"
                );


            row.className =
                "attribute-item";


            row.innerHTML =
                `<strong>${escapeHtml(key)}</strong>` +
                `<span>${escapeHtml(
                    asset?.type ||
                    ""
                )}</span>`;


            if (asset?.href) {

                row.title =
                    asset.href;
            }


            attributes.appendChild(
                row
            );
        }
    }
}


/* ============================================================
   FIND COPC
   ============================================================ */

function getCopcUrl(
    tile
) {

    if (
        !tile ||
        !tile.assets
    ) {

        return null;
    }


    for (
        const [
            key,
            asset
        ] of Object.entries(
            tile.assets
        )
    ) {

        const href =
            asset?.href ||
            "";

        const type =
            asset?.type ||
            "";

        const roles =
            Array.isArray(
                asset?.roles
            )
                ? asset.roles
                : [];


        const text =
            (
                `${key} ${href} ${type} ${roles.join(" ")}`
            ).toLowerCase();


        if (
            text.includes("copc") ||
            /\.copc(\.laz)?($|\?)/i.test(
                href
            )
        ) {

            return href;
        }
    }


    for (
        const asset of Object.values(
            tile.assets
        )
    ) {

        const href =
            asset?.href ||
            "";


        if (
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

        setStatus(
            "Select a tile first."
        );

        return;
    }


    if (currentPointCloud) {

        updateControlState();

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


    if (
        loadedPointClouds.has(
            copcUrl
        )
    ) {

        currentPointCloud =
            loadedPointClouds.get(
                copcUrl
            );


        configurePointCloud(
            currentPointCloud
        );


        showPointCloudInfo(
            currentPointCloud
        );


        fitCurrentPointCloud();


        updateControlState();


        setStatus(
            "Tile already loaded."
        );


        startSwissImageProcessing();

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


                        updateControlState();


                        setStatus(
                            "COPC loaded."
                        );


                        /*
                         * Start SWISSIMAGE processing.
                         */
                        startSwissImageProcessing();


                        resolve();
                    }
                );
            }
        );

    } catch (error) {

        console.error(
            error
        );


        setStatus(
            `COPC loading failed: ${error.message}`
        );


        updateControlState();
    }
}


/* ============================================================
   POINT CLOUD CONFIGURATION
   ============================================================ */

function configurePointCloud(
    pointcloud
) {

    const material =
        pointcloud.material;


    if (!material) {
        return;
    }


    /*
     * Circular points.
     */
    if (
        Potree.PointShape &&
        Potree.PointShape.CIRCLE !==
            undefined
    ) {

        material.shape =
            Potree.PointShape.CIRCLE;
    }


    material.size =
        1.5;


    /*
     * Adaptive point size.
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
     * Intensity.
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
     * Start with intensity.
     */
    applyColorMode(
        pointcloud,
        "intensity"
    );


    material.opacity =
        1.0;


    refreshPointCloudMaterial(
        pointcloud
    );
}


/* ============================================================
   MATERIAL REFRESH
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
     * SWISSIMAGE RGB.
     */
    if (
        mode === "swissimage"
    ) {

        material.activeAttributeName =
            null;


        setPointColorType(
            material,
            "RGB"
        );


        refreshPointCloudMaterial(
            pointcloud
        );


        updateDisplayedColorMode(
            "swissimage"
        );


        startSwissImageProcessing();

        return;
    }


    /*
     * Reset scalar attribute.
     */
    material.activeAttributeName =
        null;


    switch (mode) {

        case "intensity":

            material.activeAttributeName =
                "intensity";


            material.intensityRange = [
                0,
                65535
            ];


            setPointColorType(
                material,
                "INTENSITY"
            );

            break;


        case "intensity-gradient":

            material.activeAttributeName =
                "intensity";


            material.intensityRange = [
                0,
                65535
            ];


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


            setPointColorType(
                material,
                "NUMBER_OF_RETURNS"
            );

            break;


        case "source-id":

            material.activeAttributeName =
                "pointSourceID";


            if (
                Potree.PointColorType?.SOURCE !==
                    undefined
            ) {

                material.pointColorType =
                    Potree.PointColorType.SOURCE;
            }

            break;


        case "elevation":

        default:

            /*
             * Potree 1.8 builds differ:
             * some expose HEIGHT,
             * others ELEVATION.
             */
            material.activeAttributeName =
                null;


            setElevationColorType(
                material
            );


            setElevationRange(
                pointcloud
            );

            break;
    }


    refreshPointCloudMaterial(
        pointcloud
    );


    updateDisplayedColorMode(
        mode
    );
}


/* ============================================================
   POINT COLOR TYPE
   ============================================================ */

function setPointColorType(
    material,
    name
) {

    if (
        !Potree.PointColorType
    ) {

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


/* ============================================================
   ELEVATION COLOR TYPE
   ============================================================ */

function setElevationColorType(
    material
) {

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


/* ============================================================
   ELEVATION RANGE
   ============================================================ */

function setElevationRange(
    pointcloud
) {

    const material =
        pointcloud?.material;


    if (
        !material ||
        !pointcloud.boundingBox
    ) {

        return;
    }


    const box =
        pointcloud.boundingBox;


    const minZ =
        box.min.z;

    const maxZ =
        box.max.z;


    if (
        !Number.isFinite(minZ) ||
        !Number.isFinite(maxZ) ||
        maxZ <= minZ
    ) {

        return;
    }


    if (
        "elevationRange" in material
    ) {

        material.elevationRange = [
            minZ,
            maxZ
        ];
    }
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
   POINT CLOUD ATTRIBUTES
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
   POINT CLOUD INFO
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
   ATTRIBUTE LIST
   ============================================================ */

function updateSelectedAttributes(
    attributes
) {

    const list =
        getEl("attribute-list");


    if (!list) {
        return;
    }


    list.innerHTML =
        "";


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
        const attribute of
            attributes
    ) {

        const item =
            document.createElement(
                "div"
            );


        item.className =
            "attribute-item";


        const count =
            attribute.numElements
                ? ` × ${attribute.numElements}`
                : "";


        item.innerHTML =
            `<strong>${escapeHtml(
                attribute.name
            )}</strong>` +
            `<span>${escapeHtml(
                attribute.type
            )}${escapeHtml(
                count
            )}</span>`;


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
   POINT CLOUD LIMIT
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
        ] =
            first.value;


        unloadPointCloud(
            url,
            pointcloud
        );
    }
}


/* ============================================================
   UNLOAD CURRENT
   ============================================================ */

function unloadCurrentPointCloud() {

    if (!currentPointCloud) {

        setStatus(
            "No point cloud loaded."
        );

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


    updateSelectedAttributes(
        []
    );


    updateControlState();


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
            "Could not remove point cloud:",
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
                typeof pointcloud.parent.remove ===
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


    updateSelectedAttributes(
        []
    );


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


    updateControlState();


    setStatus(
        "All point clouds cleared."
    );
}


/* ============================================================
   POINT CLOUD BOUNDS
   ============================================================ */

   function getPointCloudBounds() {
       if (!currentPointCloud || !currentPointCloud.boundingBox) {
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

/* ============================================================
   SECTION CREATION
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


    container.innerHTML =
        "";


    container.appendChild(
        controls
    );


    const positionSlider =
        getEl(
            "section-position"
        );


    const thicknessSlider =
        getEl(
            "section-thickness"
        );


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
   UPDATE SECTION
   ============================================================ */

function updateSectionFromControls() {

    if (!currentSection) {
        return;
    }


    const positionSlider =
        getEl(
            "section-position"
        );


    const thicknessSlider =
        getEl(
            "section-thickness"
        );


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
                typeof viewer.scene.removeVolume ===
                    "function"
            ) {

                viewer.scene.removeVolume(
                    volume
                );

            } else {

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


                if (volume.parent) {

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
            error
        );
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
   SWISSIMAGE RGB
   ============================================================ */

/*
 * SWISSIMAGE is served as WebMercator XYZ imagery.
 *
 * We:
 *
 * 1. Take the selected LiDAR tile bbox.
 * 2. Transform LV95 -> WebMercator.
 * 3. Download the required SWISSIMAGE tiles.
 * 4. Stitch them into an offscreen canvas.
 * 5. Transform every loaded LiDAR point XY to WebMercator.
 * 6. Sample the orthophoto.
 * 7. Write RGB into the point's color BufferAttribute.
 *
 * This is CPU based, so it is deliberately restricted
 * to the currently loaded/visible Potree nodes.
 */


function startSwissImageProcessing() {

    if (
        !currentPointCloud ||
        !currentTile
    ) {

        return;
    }


    /*
     * Do not start multiple timers.
     */
    if (
        SWISSIMAGE_RGB.processTimer
    ) {

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

    if (
        !currentPointCloud ||
        !currentTile
    ) {

        return;
    }


    /*
     * Only do this when SWISSIMAGE RGB is selected.
     */
    const selector =
        getEl("color-mode");


    if (
        selector &&
        selector.value !==
            "swissimage"
    ) {

        return;
    }


    try {

        if (
            !SWISSIMAGE_RGB.raster ||
            SWISSIMAGE_RGB.raster.tileKey !==
                tileKey(
                    currentTile,
                    0
                )
        ) {

            await prepareSwissImageRaster();
        }


        colorVisiblePointNodes();

    } catch (error) {

        console.error(
            "SWISSIMAGE RGB failed:",
            error
        );


        setStatus(
            `SWISSIMAGE RGB failed: ${error.message}`
        );
    }
}


/* ============================================================
   PREPARE SWISSIMAGE RASTER
   ============================================================ */

async function prepareSwissImageRaster() {

    if (
        SWISSIMAGE_RGB.loading
    ) {

        return;
    }


    if (
        !currentTile?.bbox
    ) {

        throw new Error(
            "Selected tile has no bbox."
        );
    }


    if (
        typeof proj4 !==
            "function"
    ) {

        throw new Error(
            "proj4 is not available. Make sure proj4.js is loaded."
        );
    }


    SWISSIMAGE_RGB.loading =
        true;


    try {

        const [
            west,
            south,
            east,
            north
        ] =
            currentTile.bbox;


        /*
         * Convert tile corners from WGS84
         * into LV95.
         */
        const sw =
            proj4(
                "EPSG:4326",
                "EPSG:2056",
                [
                    west,
                    south
                ]
            );


        const ne =
            proj4(
                "EPSG:4326",
                "EPSG:2056",
                [
                    east,
                    north
                ]
            );


        /*
         * Then LV95 -> WebMercator.
         */
        const sw3857 =
            proj4(
                "EPSG:2056",
                "EPSG:3857",
                sw
            );


        const ne3857 =
            proj4(
                "EPSG:2056",
                "EPSG:3857",
                ne
            );


        const z =
            SWISSIMAGE_RGB.zoom;


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


        const minX =
            Math.min(
                minTile.x,
                maxTile.x
            );


        const maxX =
            Math.max(
                minTile.x,
                maxTile.x
            );


        const minY =
            Math.min(
                minTile.y,
                maxTile.y
            );


        const maxY =
            Math.max(
                minTile.y,
                maxTile.y
            );


        const tilesWide =
            maxX - minX + 1;


        const tilesHigh =
            maxY - minY + 1;


        const canvas =
            document.createElement(
                "canvas"
            );


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
                    willReadFrequently:
                        true
                }
            );


        if (!context) {

            throw new Error(
                "Could not create raster canvas."
            );
        }


        setStatus(
            "Loading SWISSIMAGE RGB…"
        );


        const requests = [];


        for (
            let y = minY;
            y <= maxY;
            y++
        ) {

            for (
                let x = minX;
                x <= maxX;
                x++
            ) {

                requests.push(
                    loadSwissImageTile(
                        z,
                        x,
                        y
                    ).then(
                        image => {

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
                        }
                    )
                );
            }
        }


        await Promise.all(
            requests
        );


        /*
         * World coordinate of the raster canvas
         * upper-left corner.
         */
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


        SWISSIMAGE_RGB.raster = {

            tileKey:
                tileKey(
                    currentTile,
                    0
                ),

            canvas,

            context,

            minX,

            minY,

            maxX,

            maxY,

            z,

            worldMinX:
                topLeft.x,

            worldMaxY:
                topLeft.y,

            worldMaxX:
                bottomRight.x,

            worldMinY:
                bottomRight.y,

            width:
                canvas.width,

            height:
                canvas.height
        };


        setStatus(
            "SWISSIMAGE RGB ready."
        );

    } finally {

        SWISSIMAGE_RGB.loading =
            false;
    }
}


/* ============================================================
   LOAD SWISSIMAGE TILE
   ============================================================ */

function loadSwissImageTile(
    z,
    x,
    y
) {

    const key =
        `${z}/${x}/${y}`;


    if (
        SWISSIMAGE_RGB.cache.has(
            key
        )
    ) {

        return SWISSIMAGE_RGB.cache.get(
            key
        );
    }


    const promise =
        new Promise(
            (resolve, reject) => {

                const image =
                    new Image();


                image.crossOrigin =
                    "anonymous";


                image.onload =
                    () => resolve(
                        image
                    );


                image.onerror =
                    () => reject(
                        new Error(
                            `SWISSIMAGE tile failed: ${key}`
                        )
                    );


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
   WEBMERCATOR TILE MATH
   ============================================================ */

function mercatorToTile(
    x,
    y,
    z
) {

    const world =
        20037508.342789244;


    const n =
        Math.pow(
            2,
            z
        );


    const tx =
        (
            x + world
        ) /
        (
            2 * world
        ) *
        n;


    const ty =
        (
            world - y
        ) /
        (
            2 * world
        ) *
        n;


    return {
        x:
            Math.floor(tx),

        y:
            Math.floor(ty)
    };
}


function tileToMercator(
    x,
    y,
    z
) {

    const world =
        20037508.342789244;


    const n =
        Math.pow(
            2,
            z
        );


    return {

        x:
            x /
            n *
            2 *
            world -
            world,

        y:
            world -
            y /
            n *
            2 *
            world
    };
}


/* ============================================================
   COLOR VISIBLE POTREE NODES
   ============================================================ */

function colorVisiblePointNodes() {

    if (
        !currentPointCloud ||
        !SWISSIMAGE_RGB.raster
    ) {

        return;
    }


    const nodes =
        currentPointCloud.visibleNodes;


    if (
        !Array.isArray(nodes)
    ) {

        return;
    }


    let processed =
        0;


    for (
        const node of nodes
    ) {

        const sceneNode =
            node?.sceneNode;


        const geometry =
            sceneNode?.geometry;


        if (!geometry) {
            continue;
        }


        if (
            SWISSIMAGE_RGB
                .pointCloudsProcessed
                .has(
                    geometry
                )
        ) {

            continue;
        }


        const changed =
            colorGeometryFromSwissImage(
                sceneNode
            );


        if (changed) {

            SWISSIMAGE_RGB
                .pointCloudsProcessed
                .add(
                    geometry
                );

            processed++;
        }
    }


    if (processed > 0) {

        console.log(
            "[swiss-copc] SWISSIMAGE-colored nodes:",
            processed
        );
    }
}


/* ============================================================
   COLOR ONE GEOMETRY
   ============================================================ */

function colorGeometryFromSwissImage(
    sceneNode
) {

    const geometry =
        sceneNode?.geometry;


    if (
        !geometry ||
        !geometry.attributes
    ) {

        return false;
    }


    const position =
        geometry.attributes.position;


    if (!position) {
        return false;
    }


    const count =
        position.count;


    if (
        !count ||
        count > 5000000
    ) {

        return false;
    }


    let color =
        geometry.attributes.color;


    /*
     * swissSURFACE3D normally does not provide
     * RGB as part of the LiDAR product.
     *
     * Therefore create the color attribute.
     */
    if (!color) {

        color =
            new THREE.BufferAttribute(
                new Float32Array(
                    count * 3
                ),
                3
            );


        geometry.setAttribute(
            "color",
            color
        );
    }


    const positions =
        position.array;


    const colors =
        color.array;


    const raster =
        SWISSIMAGE_RGB.raster;


    const worldPosition =
        new THREE.Vector3();


    const lv95 =
        [0, 0];


    const mercator =
        [0, 0];


    for (
        let i = 0;
        i < count;
        i++
    ) {

        const px =
            positions[
                i * 3
            ];


        const py =
            positions[
                i * 3 + 1
            ];


        const pz =
            positions[
                i * 3 + 2
            ];


        worldPosition.set(
            px,
            py,
            pz
        );


        /*
         * Convert node-local point to world
         * coordinates.
         */
        worldPosition.applyMatrix4(
            sceneNode.matrixWorld
        );


        /*
         * Potree swissSURFACE3D coordinates
         * are LV95.
         */
        lv95[0] =
            worldPosition.x;

        lv95[1] =
            worldPosition.y;


        const result =
            proj4(
                "EPSG:2056",
                "EPSG:3857",
                lv95
            );


        mercator[0] =
            result[0];

        mercator[1] =
            result[1];


        const rasterX =
            (
                mercator[0] -
                raster.worldMinX
            ) /
            (
                raster.worldMaxX -
                raster.worldMinX
            ) *
            raster.width;


        const rasterY =
            (
                raster.worldMaxY -
                mercator[1]
            ) /
            (
                raster.worldMaxY -
                raster.worldMinY
            ) *
            raster.height;


        const ix =
            Math.floor(
                rasterX
            );


        const iy =
            Math.floor(
                rasterY
            );


        if (
            ix < 0 ||
            iy < 0 ||
            ix >= raster.width ||
            iy >= raster.height
        ) {

            colors[
                i * 3
            ] = 0.5;

            colors[
                i * 3 + 1
            ] = 0.5;

            colors[
                i * 3 + 2
            ] = 0.5;

            continue;
        }


        /*
         * Canvas pixel.
         */
        const pixel =
            raster.context.getImageData(
                ix,
                iy,
                1,
                1
            ).data;


        /*
         * RGB -> Potree 0..1.
         */
        colors[
            i * 3
        ] =
            pixel[0] / 255;


        colors[
            i * 3 + 1
        ] =
            pixel[1] / 255;


        colors[
            i * 3 + 2
        ] =
            pixel[2] / 255;
    }


    color.needsUpdate =
        true;


    return true;
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

        console.error(
            error
        );


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


    container.innerHTML =
        "";


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
            result.attrs ||
            {};


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

    viewer:
        () => viewer,

    currentPointCloud:
        () => currentPointCloud,

    currentTile:
        () => currentTile,

    section:
        () => currentSection,

    loadedPointClouds:
        () => loadedPointClouds,

    colorMode:
        mode => {

            if (currentPointCloud) {

                applyColorMode(
                    currentPointCloud,
                    mode
                );
            }
        },

    swissImage:
        () =>
            SWISSIMAGE_RGB.raster,

    createHorizontalSection:
        () =>
            createSection(
                "horizontal"
            ),

    createVerticalSection:
        () =>
            createSection(
                "vertical"
            ),

    clearSection:
        () =>
            clearSection()
};
