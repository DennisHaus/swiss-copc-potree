/* =========================================================
   Swiss LiDAR COPC Viewer
   Potree 1.8
   ========================================================= */

"use strict";


/* =========================================================
   GLOBAL STATE
   ========================================================= */

const state = {

    tiles: [],

    selectedTile: null,

    loadedClouds: new Map(),

    tileLayers: new Map(),

    searchMarker: null,

    queryController: null

};


/* =========================================================
   POTREE VIEWER
   ========================================================= */

const renderArea =
    document.getElementById(
        "potree_render_area"
    );


const viewer =
    new Potree.Viewer(
        renderArea
    );


viewer.setEDLEnabled(true);

viewer.setFOV(60);

viewer.setPointBudget(
    CONFIG.POINT_BUDGET
);

viewer.setBackground(
    "gradient"
);

viewer.loadSettingsFromURL();


/*
 * Deliberately DO NOT call viewer.loadGUI().
 *
 * The Potree sidebar/menu is not useful for this
 * application because we provide our own controls.
 */


/* =========================================================
   LEAFLET MAP
   ========================================================= */

const map =
    L.map(
        "map",
        {
            zoomControl: true
        }
    );


map.setView(
    CONFIG.MAP_CENTER,
    CONFIG.MAP_ZOOM
);


/*
 * SwissTopo basemap.
 */

L.tileLayer(
    CONFIG.BASEMAP,
    {
        attribution:
            CONFIG.BASEMAP_ATTRIBUTION,

        maxZoom: 19
    }
).addTo(map);


/* =========================================================
   HELPERS
   ========================================================= */

function getElement(id) {

    return document.getElementById(id);

}


function setStatus(message) {

    const element =
        getElement("status");

    if (element) {

        element.textContent =
            message;

    }

}


function escapeHtml(value) {

    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

}


/* =========================================================
   POINT ATTRIBUTE INSPECTION
   ========================================================= */

/*
 * Convert Potree's point-attribute object into a
 * simple list that is easy to inspect in the console.
 */

function inspectPointCloudAttributes(pointcloud) {

    console.group(
        "Swiss LiDAR - Point Cloud Inspection"
    );


    console.log(
        "Point cloud:",
        pointcloud
    );


    console.log(
        "PcoGeometry:",
        pointcloud.pcoGeometry
    );


    console.log(
        "Material:",
        pointcloud.material
    );


    const pcoGeometry =
        pointcloud.pcoGeometry;


    if (!pcoGeometry) {

        console.warn(
            "No pcoGeometry found."
        );

        console.groupEnd();

        return [];

    }


    const pointAttributes =
        pcoGeometry.pointAttributes;


    console.log(
        "Raw pointAttributes:",
        pointAttributes
    );


    if (!pointAttributes) {

        console.warn(
            "No pointAttributes found."
        );

        console.groupEnd();

        return [];

    }


    let attributes = [];


    /*
     * Potree normally stores the individual
     * attributes in .attributes.
     */

    if (
        Array.isArray(
            pointAttributes.attributes
        )
    ) {

        attributes =
            pointAttributes.attributes;

    }


    const names =
        attributes.map(
            function(attribute) {

                return attribute.name;

            }
        );


    console.log(
        "Detected point attribute names:",
        names
    );


    /*
     * Print detailed information.
     */

    attributes.forEach(
        function(attribute) {

            console.log(
                "Attribute:",
                attribute.name,
                attribute
            );

        }
    );


    /*
     * Useful summary.
     */

    const hasAttribute =
        function(name) {

            return names.indexOf(name) !== -1;

        };


    console.log(
        "Has intensity:",
        hasAttribute("INTENSITY")
    );


    console.log(
        "Has classification:",
        hasAttribute("CLASSIFICATION")
    );


    console.log(
        "Has RGB:",
        hasAttribute("RGB")
    );


    console.log(
        "Has return number:",
        hasAttribute("RETURN_NUMBER")
    );


    console.log(
        "Has number of returns:",
        hasAttribute("NUMBER_OF_RETURNS")
    );


    console.log(
        "Has point source ID:",
        hasAttribute("SOURCE_ID") ||
        hasAttribute("POINT_SOURCE_ID")
    );


    console.groupEnd();


    return names;

}


/* =========================================================
   ATTRIBUTE HELPERS
   ========================================================= */

function getPointAttributeNames(pointcloud) {

    const pcoGeometry =
        pointcloud.pcoGeometry;


    if (!pcoGeometry) {

        return [];

    }


    const pointAttributes =
        pcoGeometry.pointAttributes;


    if (!pointAttributes) {

        return [];

    }


    if (
        Array.isArray(
            pointAttributes.attributes
        )
    ) {

        return pointAttributes.attributes.map(
            function(attribute) {

                return attribute.name;

            }
        );

    }


    return [];

}


function hasPointAttribute(
    pointcloud,
    name
) {

    const names =
        getPointAttributeNames(
            pointcloud
        );


    return (
        names.indexOf(name) !== -1
    );

}


/* =========================================================
   POINT COLOR MODE
   ========================================================= */

function getElevationColorType() {

    /*
     * Potree versions use slightly different
     * names here.
     *
     * Newer versions:
     *     ELEVATION
     *
     * Older Potree versions:
     *     HEIGHT
     */

    if (
        Potree.PointColorType &&
        typeof Potree.PointColorType.ELEVATION !==
            "undefined"
    ) {

        return Potree.PointColorType.ELEVATION;

    }


    if (
        Potree.PointColorType &&
        typeof Potree.PointColorType.HEIGHT !==
            "undefined"
    ) {

        return Potree.PointColorType.HEIGHT;

    }


    return null;

}


function setPointCloudColorMode(
    pointcloud,
    mode
) {

    if (!pointcloud) {

        return false;

    }


    const material =
        pointcloud.material;


    if (!material) {

        return false;

    }


    const hasIntensity =
        hasPointAttribute(
            pointcloud,
            "INTENSITY"
        );


    const hasClassification =
        hasPointAttribute(
            pointcloud,
            "CLASSIFICATION"
        );


    const hasReturnNumber =
        hasPointAttribute(
            pointcloud,
            "RETURN_NUMBER"
        );


    const hasSource =
        hasPointAttribute(
            pointcloud,
            "SOURCE_ID"
        ) ||
        hasPointAttribute(
            pointcloud,
            "POINT_SOURCE_ID"
        );


    switch (mode) {

        case "intensity":

            if (
                hasIntensity &&
                Potree.PointColorType.INTENSITY !==
                    undefined
            ) {

                material.pointColorType =
                    Potree.PointColorType.INTENSITY;

                return true;

            }

            break;


        case "intensity-gradient":

            if (
                hasIntensity &&
                Potree.PointColorType.INTENSITY_GRADIENT !==
                    undefined
            ) {

                material.pointColorType =
                    Potree.PointColorType.INTENSITY_GRADIENT;

                return true;

            }

            break;


        case "classification":

            if (
                hasClassification &&
                Potree.PointColorType.CLASSIFICATION !==
                    undefined
            ) {

                material.pointColorType =
                    Potree.PointColorType.CLASSIFICATION;

                return true;

            }

            break;


        case "elevation":

            {

                const elevationType =
                    getElevationColorType();


                if (
                    elevationType !== null
                ) {

                    material.pointColorType =
                        elevationType;

                    return true;

                }

            }

            break;


        case "return-number":

            if (
                hasReturnNumber &&
                Potree.PointColorType.RETURN_NUMBER !==
                    undefined
            ) {

                material.pointColorType =
                    Potree.PointColorType.RETURN_NUMBER;

                return true;

            }

            break;


        case "source-id":

            if (
                hasSource &&
                Potree.PointColorType.SOURCE !==
                    undefined
            ) {

                material.pointColorType =
                    Potree.PointColorType.SOURCE;

                return true;

            }

            break;

    }


    return false;

}


/*
 * Automatically select the best available mode.
 *
 * Since your SwissTopo COPC has no RGB, intensity
 * is preferred.
 */

function setBestAvailableColorMode(
    pointcloud
) {

    if (
        setPointCloudColorMode(
            pointcloud,
            "intensity-gradient"
        )
    ) {

        return "intensity-gradient";

    }


    if (
        setPointCloudColorMode(
            pointcloud,
            "intensity"
        )
    ) {

        return "intensity";

    }


    if (
        setPointCloudColorMode(
            pointcloud,
            "classification"
        )
    ) {

        return "classification";

    }


    if (
        setPointCloudColorMode(
            pointcloud,
            "elevation"
        )
    ) {

        return "elevation";

    }


    return null;

}


/*
 * Apply selected color mode to all loaded clouds.
 */

function setAllPointCloudColorMode(
    mode
) {

    let changed = false;


    state.loadedClouds.forEach(
        function(pointcloud) {

            if (
                setPointCloudColorMode(
                    pointcloud,
                    mode
                )
            ) {

                changed = true;

            }

        }
    );


    if (changed) {

        setStatus(
            "Point color: " +
            mode
        );

    } else {

        setStatus(
            "The selected attribute is not available."
        );

    }

}


/* =========================================================
   CONFIGURE POINT CLOUD
   ========================================================= */

function configurePointCloud(
    pointcloud
) {

    const material =
        pointcloud.material;


    /*
     * Point size.
     */

    material.size =
        1.5;


    material.minSize =
        2;


    /*
     * Adaptive point sizing.
     */

    material.pointSizeType =
        Potree.PointSizeType.ADAPTIVE;


    /*
     * Square points.
     */

    material.shape =
        Potree.PointShape.SQUARE;


    /*
     * Fully opaque.
     */

    material.opacity =
        1.0;


    /*
     * Inspect attributes.
     */

    const attributes =
        inspectPointCloudAttributes(
            pointcloud
        );


    /*
     * Display the attributes in our UI.
     */

    updateAttributeDisplay(
        attributes
    );


    /*
     * No RGB exists in this dataset, so choose
     * intensity / classification / elevation.
     */

    const mode =
        setBestAvailableColorMode(
            pointcloud
        );


    console.log(
        "Initial point color mode:",
        mode
    );

}


/* =========================================================
   ATTRIBUTE DISPLAY
   ========================================================= */

function updateAttributeDisplay(
    attributes
) {

    const element =
        getElement(
            "selected-attributes"
        );


    if (!element) {

        return;

    }


    if (
        !attributes ||
        !attributes.length
    ) {

        element.textContent =
            "Point attributes unavailable.";

        return;

    }


    element.innerHTML =
        "<b>Attributes:</b> " +
        attributes
            .map(
                function(name) {

                    return escapeHtml(
                        name
                    );

                }
            )
            .join(", ");

}


/* =========================================================
   BBOX
   ========================================================= */

function mapBBox() {

    const bounds =
        map.getBounds();


    return [
        bounds.getWest(),
        bounds.getSouth(),
        bounds.getEast(),
        bounds.getNorth()
    ];

}


/* =========================================================
   STAC
   ========================================================= */

function buildSTACURL(
    bbox
) {

    const url =
        new URL(
            CONFIG.STAC_ROOT +
            "/collections/" +
            CONFIG.COLLECTION +
            "/items"
        );


    url.searchParams.set(
        "bbox",
        bbox.join(",")
    );


    url.searchParams.set(
        "limit",
        "100"
    );


    return url;

}


/*
 * Get STAC pages.
 */

async function fetchAllSTACItems(
    firstURL,
    signal
) {

    let url =
        firstURL;


    const items = [];


    while (url) {

        const response =
            await fetch(
                url,
                {
                    signal: signal
                }
            );


        if (!response.ok) {

            throw new Error(
                "STAC request failed: " +
                response.status
            );

        }


        const data =
            await response.json();


        if (
            Array.isArray(
                data.features
            )
        ) {

            items.push(
                ...data.features
            );

        }


        let nextURL =
            null;


        if (
            Array.isArray(
                data.links
            )
        ) {

            for (
                let i = 0;
                i < data.links.length;
                i++
            ) {

                const link =
                    data.links[i];


                if (
                    link &&
                    link.rel === "next" &&
                    link.href
                ) {

                    nextURL =
                        link.href;

                    break;

                }

            }

        }


        url =
            nextURL;


        if (
            items.length >=
            CONFIG.MAX_TILES
        ) {

            break;

        }

    }


    return items;

}


/* =========================================================
   FIND COPC ASSET
   ========================================================= */

function findCOPCAsset(
    item
) {

    const assets =
        Object.values(
            item.assets || {}
        );


    let asset =
        assets.find(
            function(a) {

                if (
                    !a ||
                    typeof a.href !==
                        "string"
                ) {

                    return false;

                }


                const href =
                    a.href.toLowerCase();


                const title =
                    typeof a.title ===
                        "string"
                        ? a.title.toLowerCase()
                        : "";


                return (
                    href.indexOf(
                        ".copc.laz"
                    ) !== -1 ||
                    title.indexOf(
                        "copc"
                    ) !== -1
                );

            }
        );


    if (asset) {

        return asset;

    }


    asset =
        assets.find(
            function(a) {

                if (
                    !a ||
                    typeof a.href !==
                        "string"
                ) {

                    return false;

                }


                return (
                    a.href
                        .toLowerCase()
                        .indexOf("copc") !== -1
                );

            }
        );


    return asset || null;

}


/* =========================================================
   NORMALIZE TILE
   ========================================================= */

function normalizeTile(
    item
) {

    const asset =
        findCOPCAsset(
            item
        );


    if (!asset) {

        return null;

    }


    const bbox =
        item.bbox;


    if (
        !bbox ||
        bbox.length < 4
    ) {

        return null;

    }


    let title =
        item.id;


    if (
        item.properties &&
        item.properties.title
    ) {

        title =
            item.properties.title;

    }


    let date =
        null;


    if (
        item.properties
    ) {

        if (
            item.properties.datetime
        ) {

            date =
                item.properties.datetime;

        } else if (
            item.properties.updated
        ) {

            date =
                item.properties.updated;

        }

    }


    let assetTitle =
        "";


    if (asset.title) {

        assetTitle =
            asset.title;

    }


    let size =
        null;


    if (
        asset["file:size"]
    ) {

        size =
            asset["file:size"];

    } else if (
        asset.size
    ) {

        size =
            asset.size;

    }


    return {

        id:
            item.id,

        title:
            title,

        bbox:
            bbox,

        geometry:
            item.geometry,

        date:
            date,

        href:
            asset.href,

        assetTitle:
            assetTitle,

        size:
            size

    };

}


/* =========================================================
   FIND TILES
   ========================================================= */

async function findTiles() {

    if (
        state.queryController
    ) {

        state.queryController.abort();

    }


    state.queryController =
        new AbortController();


    try {

        setStatus(
            "Searching swisstopo tile catalogue..."
        );


        clearTileLayers();


        const bbox =
            mapBBox();


        const url =
            buildSTACURL(
                bbox
            );


        const response =
            await fetchAllSTACItems(
                url.href,
                state.queryController.signal
            );


        const tiles =
            response
                .map(
                    normalizeTile
                )
                .filter(
                    function(tile) {

                        return tile !== null;

                    }
                )
                .slice(
                    0,
                    CONFIG.MAX_TILES
                );


        state.tiles =
            tiles;


        drawTiles(
            tiles
        );


        renderTileList(
            tiles
        );


        setStatus(
            tiles.length +
            " COPC tile(s) found."
        );


    } catch (error) {

        if (
            error.name ===
            "AbortError"
        ) {

            return;

        }


        console.error(
            error
        );


        setStatus(
            "Tile search failed: " +
            error.message
        );

    }

}


/* =========================================================
   DRAW TILE FOOTPRINTS
   ========================================================= */

function drawTiles(
    tiles
) {

    clearTileLayers();


    for (
        const tile
        of tiles
    ) {

        const bbox =
            tile.bbox;


        const rectangle =
            L.rectangle(
                [
                    [
                        bbox[1],
                        bbox[0]
                    ],
                    [
                        bbox[3],
                        bbox[2]
                    ]
                ],
                {
                    color:
                        "#ffffff",

                    weight:
                        1,

                    fillColor:
                        "#ffffff",

                    fillOpacity:
                        0.05
                }
            );


        rectangle.on(
            "click",
            function() {

                selectTile(
                    tile.id
                );

            }
        );


        rectangle.bindTooltip(
            tile.title,
            {
                sticky: true
            }
        );


        rectangle.addTo(
            map
        );


        state.tileLayers.set(
            tile.id,
            rectangle
        );

    }

}


/* =========================================================
   CLEAR TILE LAYERS
   ========================================================= */

function clearTileLayers() {

    state.tileLayers.forEach(
        function(layer) {

            map.removeLayer(
                layer
            );

        }
    );


    state.tileLayers.clear();

}


/* =========================================================
   TILE LIST
   ========================================================= */

function renderTileList(
    tiles
) {

    const list =
        getElement(
            "tile-list"
        );


    const count =
        getElement(
            "tile-count"
        );


    if (!list) {

        return;

    }


    if (count) {

        count.textContent =
            tiles.length;

    }


    list.innerHTML =
        "";


    if (!tiles.length) {

        list.innerHTML =
            '<div class="tile-row">' +
            'No COPC tiles found.' +
            '</div>';

        return;

    }


    for (
        const tile
        of tiles
    ) {

        const row =
            document.createElement(
                "div"
            );


        row.className =
            "tile-row";


        row.dataset.id =
            tile.id;


        row.innerHTML =
            '<div class="tile-name">' +
            escapeHtml(
                tile.title
            ) +
            '</div>' +

            '<div class="tile-meta">' +
            escapeHtml(
                tile.id
            ) +
            '</div>';


        row.addEventListener(
            "click",
            function() {

                selectTile(
                    tile.id
                );

            }
        );


        list.appendChild(
            row
        );

    }

}


/* =========================================================
   SELECT TILE
   ========================================================= */

function selectTile(
    id
) {

    const tile =
        state.tiles.find(
            function(t) {

                return t.id === id;

            }
        );


    if (!tile) {

        return;

    }


    state.selectedTile =
        tile;


    /*
     * Highlight map rectangle.
     */

    state.tileLayers.forEach(
        function(layer, tileId) {

            if (
                tileId === id
            ) {

                layer.setStyle({
                    color:
                        "#ffcc00",

                    weight:
                        3,

                    fillColor:
                        "#ffcc00",

                    fillOpacity:
                        0.15
                });

            } else {

                layer.setStyle({
                    color:
                        "#ffffff",

                    weight:
                        1,

                    fillColor:
                        "#ffffff",

                    fillOpacity:
                        0.05
                });

            }

        }
    );


    /*
     * Highlight list item.
     */

    const rows =
        document.querySelectorAll(
            ".tile-row"
        );


    rows.forEach(
        function(row) {

            row.classList.toggle(
                "selected",
                row.dataset.id === id
            );

        }
    );


    /*
     * Selected panel.
     */

    const titleElement =
        getElement(
            "selected-title"
        );


    if (titleElement) {

        titleElement.textContent =
            tile.title;

    }


    const infoElement =
        getElement(
            "selected-info"
        );


    if (infoElement) {

        infoElement.innerHTML =
            '<div><b>ID:</b> ' +
            escapeHtml(tile.id) +
            '</div>' +

            '<div><b>COPC:</b> ' +
            escapeHtml(tile.href) +
            '</div>';

    }


    const attributesElement =
        getElement(
            "selected-attributes"
        );


    if (attributesElement) {

        attributesElement.textContent =
            "Load the tile to inspect point attributes.";

    }


    const loadButton =
        getElement(
            "load-button"
        );


    if (loadButton) {

        loadButton.disabled =
            false;

    }


    const unloadButton =
        getElement(
            "unload-button"
        );


    if (unloadButton) {

        unloadButton.disabled =
            !state.loadedClouds.has(
                tile.id
            );

    }


    const downloadButton =
        getElement(
            "download-button"
        );


    if (downloadButton) {

        downloadButton.disabled =
            false;

    }


    setStatus(
        "Selected " +
        tile.id
    );

}


/* =========================================================
   LOAD COPC
   ========================================================= */

async function loadSelectedTile() {

    const tile =
        state.selectedTile;


    if (!tile) {

        return;

    }


    if (
        state.loadedClouds.has(
            tile.id
        )
    ) {

        setStatus(
            "Tile is already loaded."
        );

        return;

    }


    if (
        state.loadedClouds.size >=
        CONFIG.MAX_LOADED_POINTCLOUDS
    ) {

        setStatus(
            "Maximum of " +
            CONFIG.MAX_LOADED_POINTCLOUDS +
            " loaded tiles reached. " +
            "Unload one first."
        );

        return;

    }


    setStatus(
        "Starting COPC stream for " +
        tile.id +
        "..."
    );


    try {

        await new Promise(
            function(resolve, reject) {

                try {

                    Potree.loadPointCloud(
                        tile.href,
                        tile.title,
                        function(event) {

                            try {

                                const pointcloud =
                                    event.pointcloud;


                                if (!pointcloud) {

                                    throw new Error(
                                        "Potree did not return a point cloud."
                                    );

                                }


                                configurePointCloud(
                                    pointcloud
                                );


                                viewer.scene.addPointCloud(
                                    pointcloud
                                );


                                state.loadedClouds.set(
                                    tile.id,
                                    pointcloud
                                );


                                const unloadButton =
                                    getElement(
                                        "unload-button"
                                    );


                                if (unloadButton) {

                                    unloadButton.disabled =
                                        false;

                                }


                                setStatus(
                                    "Streaming " +
                                    tile.id
                                );


                                /*
                                 * Automatically fit the first
                                 * loaded tile.
                                 */

                                if (
                                    state.loadedClouds.size ===
                                    1
                                ) {

                                    viewer.fitToScreen(
                                        0.5
                                    );

                                }


                                resolve();

                            } catch (error) {

                                reject(
                                    error
                                );

                            }

                        }
                    );

                } catch (error) {

                    reject(
                        error
                    );

                }

            }
        );

    } catch (error) {

        console.error(
            "COPC loading error:",
            error
        );


        setStatus(
            "Could not load COPC: " +
            error.message
        );

    }

}


/* =========================================================
   REMOVE POINT CLOUD
   ========================================================= */

function removePointCloudFromViewer(
    pointcloud
) {

    /*
     * Some Potree versions expose removePointCloud().
     */

    if (
        viewer.scene.removePointCloud &&
        typeof viewer.scene.removePointCloud ===
            "function"
    ) {

        viewer.scene.removePointCloud(
            pointcloud
        );

        return;

    }


    /*
     * Potree 1.8 keeps point clouds in
     * viewer.scene.pointclouds.
     */

    const pointclouds =
        viewer.scene.pointclouds;


    if (
        Array.isArray(pointclouds)
    ) {

        const index =
            pointclouds.indexOf(
                pointcloud
            );


        if (index !== -1) {

            pointclouds.splice(
                index,
                1
            );

        }

    }

}


/* =========================================================
   UNLOAD SELECTED TILE
   ========================================================= */

function unloadSelectedTile() {

    const tile =
        state.selectedTile;


    if (!tile) {

        return;

    }


    const pointcloud =
        state.loadedClouds.get(
            tile.id
        );


    if (!pointcloud) {

        return;

    }


    removePointCloudFromViewer(
        pointcloud
    );


    try {

        pointcloud.dispose();

    } catch (error) {

        console.warn(
            "Point cloud dispose failed:",
            error
        );

    }


    state.loadedClouds.delete(
        tile.id
    );


    const unloadButton =
        getElement(
            "unload-button"
        );


    if (unloadButton) {

        unloadButton.disabled =
            true;

    }


    const attributesElement =
        getElement(
            "selected-attributes"
        );


    if (attributesElement) {

        attributesElement.textContent =
            "Load the tile to inspect point attributes.";

    }


    setStatus(
        "Unloaded " +
        tile.id
    );

}


/* =========================================================
   CLEAR EVERYTHING
   ========================================================= */

function clearAll() {

    state.loadedClouds.forEach(
        function(pointcloud) {

            removePointCloudFromViewer(
                pointcloud
            );


            try {

                pointcloud.dispose();

            } catch (error) {

                console.warn(
                    "Point cloud dispose failed:",
                    error
                );

            }

        }
    );


    state.loadedClouds.clear();


    state.selectedTile =
        null;


    clearTileLayers();


    state.tiles =
        [];


    renderTileList(
        []
    );


    const selectedTitle =
        getElement(
            "selected-title"
        );


    if (selectedTitle) {

        selectedTitle.textContent =
            "No tile selected";

    }


    const selectedInfo =
        getElement(
            "selected-info"
        );


    if (selectedInfo) {

        selectedInfo.innerHTML =
            "";

    }


    const attributes =
        getElement(
            "selected-attributes"
        );


    if (attributes) {

        attributes.textContent =
            "Load a tile to inspect point attributes.";

    }


    const loadButton =
        getElement(
            "load-button"
        );


    if (loadButton) {

        loadButton.disabled =
            true;

    }


    const unloadButton =
        getElement(
            "unload-button"
        );


    if (unloadButton) {

        unloadButton.disabled =
            true;

    }


    const downloadButton =
        getElement(
            "download-button"
        );


    if (downloadButton) {

        downloadButton.disabled =
            true;

    }


    setStatus(
        "Cleared."
    );

}


/* =========================================================
   DOWNLOAD COPC
   ========================================================= */

function downloadSelectedTile() {

    const tile =
        state.selectedTile;


    if (!tile) {

        setStatus(
            "Select a tile first."
        );

        return;

    }


    if (!tile.href) {

        setStatus(
            "No COPC download URL is available."
        );

        return;

    }


    /*
     * Use a normal link rather than fetch().
     *
     * This is important because COPC files can be
     * very large and should not be downloaded into
     * browser memory first.
     *
     * The final behaviour depends on the server's
     * Content-Disposition/CORS configuration.
     */

    const link =
        document.createElement(
            "a"
        );


    link.href =
        tile.href;


    link.target =
        "_blank";


    link.rel =
        "noopener";


    link.textContent =
        "Download COPC";


    document.body.appendChild(
        link
    );


    link.click();


    document.body.removeChild(
        link
    );


    setStatus(
        "Opening COPC download..."
    );

}


/* =========================================================
   SEARCH SWISS PLACE
   ========================================================= */

async function searchPlace(
    text
) {

    if (
        !text ||
        !text.trim()
    ) {

        return;

    }


    setStatus(
        "Searching for " +
        text +
        "..."
    );


    const url =
        new URL(
            CONFIG.SEARCH_URL
        );


    url.searchParams.set(
        "searchText",
        text
    );


    url.searchParams.set(
        "type",
        "locations"
    );


    url.searchParams.set(
        "sr",
        "4326"
    );


    url.searchParams.set(
        "geometryFormat",
        "geojson"
    );


    url.searchParams.set(
        "limit",
        "10"
    );


    try {

        const response =
            await fetch(
                url
            );


        if (!response.ok) {

            throw new Error(
                "Search failed: " +
                response.status
            );

        }


        const data =
            await response.json();


        renderSearchResults(
            data
        );


    } catch (error) {

        console.error(
            error
        );


        setStatus(
            error.message
        );

    }

}


/* =========================================================
   SEARCH RESULTS
   ========================================================= */

function renderSearchResults(
    data
) {

    const container =
        getElement(
            "search-results"
        );


    if (!container) {

        return;

    }


    container.innerHTML =
        "";


    let results =
        [];


    if (
        data &&
        Array.isArray(
            data.results
        )
    ) {

        results =
            data.results;

    }


    for (
        const result
        of results
    ) {

        const row =
            document.createElement(
                "div"
            );


        row.className =
            "search-result";


        let label =
            "Location";


        if (
            result.label
        ) {

            label =
                result.label;

        } else if (
            result.attrs &&
            result.attrs.label
        ) {

            label =
                result.attrs.label;

        } else if (
            result.name
        ) {

            label =
                result.name;

        }


        row.textContent =
            label;


        row.addEventListener(
            "click",
            function() {

                let lon =
                    null;


                let lat =
                    null;


                if (
                    typeof result.lon ===
                    "number"
                ) {

                    lon =
                        result.lon;

                } else if (
                    result.geometry &&
                    Array.isArray(
                        result.geometry.coordinates
                    )
                ) {

                    lon =
                        result.geometry.coordinates[0];

                }


                if (
                    typeof result.lat ===
                    "number"
                ) {

                    lat =
                        result.lat;

                } else if (
                    result.geometry &&
                    Array.isArray(
                        result.geometry.coordinates
                    )
                ) {

                    lat =
                        result.geometry.coordinates[1];

                }


                if (
                    Number.isFinite(lat) &&
                    Number.isFinite(lon)
                ) {

                    map.setView(
                        [
                            lat,
                            lon
                        ],
                        15
                    );


                    if (
                        state.searchMarker
                    ) {

                        map.removeLayer(
                            state.searchMarker
                        );

                    }


                    state.searchMarker =
                        L.marker(
                            [
                                lat,
                                lon
                            ]
                        )
                        .addTo(
                            map
                        )
                        .bindPopup(
                            label
                        )
                        .openPopup();


                    findTiles();

                }

            }
        );


        container.appendChild(
            row
        );

    }


    if (!results.length) {

        container.innerHTML =
            '<div class="search-result">' +
            'No results.' +
            '</div>';

    }

}


/* =========================================================
   URL SHARING
   ========================================================= */

function updateURLForTile(
    tile
) {

    if (!tile) {

        return;

    }


    const url =
        new URL(
            window.location.href
        );


    url.searchParams.set(
        "tile",
        tile.id
    );


    history.replaceState(
        null,
        "",
        url
    );

}


/* =========================================================
   LOAD TILE FROM URL
   ========================================================= */

async function loadTileFromURL() {

    const params =
        new URLSearchParams(
            window.location.search
        );


    const tileId =
        params.get(
            "tile"
        );


    if (!tileId) {

        return;

    }


    setStatus(
        "Looking up shared tile " +
        tileId +
        "..."
    );


    try {

        const url =
            new URL(
                CONFIG.STAC_ROOT +
                "/collections/" +
                CONFIG.COLLECTION +
                "/items"
            );


        url.searchParams.set(
            "limit",
            "100"
        );


        const items =
            await fetchAllSTACItems(
                url.href
            );


        let tile =
            null;


        for (
            let i = 0;
            i < items.length;
            i++
        ) {

            const candidate =
                normalizeTile(
                    items[i]
                );


            if (
                candidate &&
                candidate.id ===
                    tileId
            ) {

                tile =
                    candidate;

                break;

            }

        }


        if (!tile) {

            setStatus(
                "Shared tile was not found."
            );

            return;

        }


        state.tiles =
            [tile];


        drawTiles(
            [tile]
        );


        renderTileList(
            [tile]
        );


        selectTile(
            tile.id
        );


        await loadSelectedTile();


    } catch (error) {

        console.error(
            error
        );


        setStatus(
            "Could not open shared tile: " +
            error.message
        );

    }

}


/* =========================================================
   EVENTS
   ========================================================= */

const findTilesButton =
    getElement(
        "findTilesButton"
    );


if (findTilesButton) {

    findTilesButton.addEventListener(
        "click",
        findTiles
    );

}


const loadButton =
    getElement(
        "load-button"
    );


if (loadButton) {

    loadButton.addEventListener(
        "click",
        async function() {

            if (
                state.selectedTile
            ) {

                updateURLForTile(
                    state.selectedTile
                );

            }


            await loadSelectedTile();

        }
    );

}


const unloadButton =
    getElement(
        "unload-button"
    );


if (unloadButton) {

    unloadButton.addEventListener(
        "click",
        unloadSelectedTile
    );

}


const downloadButton =
    getElement(
        "download-button"
    );


if (downloadButton) {

    downloadButton.addEventListener(
        "click",
        downloadSelectedTile
    );

}


const clearButton =
    getElement(
        "clearButton"
    );


if (clearButton) {

    clearButton.addEventListener(
        "click",
        clearAll
    );

}


const fitButton =
    getElement(
        "fitButton"
    );


if (fitButton) {

    fitButton.addEventListener(
        "click",
        function() {

            viewer.fitToScreen(
                0.5
            );

        }
    );

}


/*
 * Point color selector.
 */

const colorMode =
    getElement(
        "color-mode"
    );


if (colorMode) {

    colorMode.addEventListener(
        "change",
        function(event) {

            setAllPointCloudColorMode(
                event.target.value
            );

        }
    );

}


/*
 * Search.
 */

const searchButton =
    getElement(
        "search-button"
    );


if (searchButton) {

    searchButton.addEventListener(
        "click",
        function() {

            const input =
                getElement(
                    "search-input"
                );


            if (input) {

                searchPlace(
                    input.value
                );

            }

        }
    );

}


const searchInput =
    getElement(
        "search-input"
    );


if (searchInput) {

    searchInput.addEventListener(
        "keydown",
        function(event) {

            if (
                event.key ===
                "Enter"
            ) {

                searchPlace(
                    event.target.value
                );

            }

        }
    );

}


/*
 * Refresh tiles when map movement ends.
 */

let moveTimer =
    null;


map.on(
    "moveend",
    function() {

        clearTimeout(
            moveTimer
        );


        moveTimer =
            setTimeout(
                function() {

                    findTiles();

                },
                350
            );

    }
);


/* =========================================================
   STARTUP
   ========================================================= */

async function init() {

    setStatus(
        "Loading..."
    );


    await findTiles();


    await loadTileFromURL();


    setStatus(
        "Ready."
    );

}


init();
