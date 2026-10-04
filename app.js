/* =========================================================
   SWISS LIDAR VIEWER
   ========================================================= */


/* =========================================================
   GLOBAL STATE
   ========================================================= */

var viewer = null;

var map = null;

var tiles = [];

var selectedTile = null;

var loadedClouds = [];

var tileLayers = [];

var searchMarker = null;

var queryController = null;

var activeSection = null;


/* =========================================================
   DOM HELPER
   ========================================================= */

function byId(id) {
    return document.getElementById(id);
}


/* =========================================================
   STATUS
   ========================================================= */

function setStatus(message) {

    var element = byId("status");

    if (!element) {
        return;
    }

    element.textContent = message;
}


/* =========================================================
   INITIALIZE
   ========================================================= */

function initialize() {

    initializeViewer();

    initializeMap();

    initializeEvents();

    setStatus("Ready.");

    findTiles();
}


/* =========================================================
   POTREE VIEWER
   ========================================================= */

function initializeViewer() {

    var renderArea = byId("potree_render_area");

    if (!renderArea) {

        console.error(
            "Potree render area not found."
        );

        return;
    }


    viewer = new Potree.Viewer(
        renderArea
    );


    viewer.setEDLEnabled(true);

    viewer.setFOV(60);

    viewer.setPointBudget(
        CONFIG.POINT_BUDGET
    );


    /*
        IMPORTANT:

        We deliberately do NOT call:

            viewer.loadGUI()

        Therefore the Potree sidebar remains hidden.
    */


    /*
        Dark background.
    */

    if (viewer.renderer) {

        viewer.renderer.setClearColor(
            0x111111,
            1
        );

    }


    /*
        Some Potree builds expose these methods.
    */

    try {

        viewer.setBackground(
            "gradient"
        );

    } catch (error) {

        console.log(
            "Background setting unavailable."
        );

    }


    console.log(
        "Potree initialized."
    );

}


/* =========================================================
   LEAFLET MAP
   ========================================================= */

function initializeMap() {

    var mapElement = byId("map");

    if (!mapElement) {

        console.error(
            "Map container not found."
        );

        return;
    }


    map = L.map(
        mapElement,
        {
            zoomControl: true
        }
    ).setView(
        CONFIG.MAP_CENTER,
        CONFIG.MAP_ZOOM
    );


    L.tileLayer(
        CONFIG.BASEMAP,
        {
            attribution:
                CONFIG.BASEMAP_ATTRIBUTION,

            maxZoom: 19
        }
    ).addTo(map);


    map.on(
        "moveend",
        function() {

            findTiles();

        }
    );


    /*
        Make sure Leaflet recalculates
        its dimensions after initialization.
    */

    setTimeout(
        function() {

            map.invalidateSize();

        },
        250
    );
}


/* =========================================================
   EVENTS
   ========================================================= */

function initializeEvents() {


    var findButton =
        byId("findTilesButton");

    if (findButton) {

        findButton.addEventListener(
            "click",
            findTiles
        );

    }


    var fitButton =
        byId("fitButton");

    if (fitButton) {

        fitButton.addEventListener(
            "click",
            fitLoadedClouds
        );

    }


    var clearButton =
        byId("clearButton");

    if (clearButton) {

        clearButton.addEventListener(
            "click",
            clearAllClouds
        );

    }


    var searchButton =
        byId("search-button");

    if (searchButton) {

        searchButton.addEventListener(
            "click",
            searchPlace
        );

    }


    var searchInput =
        byId("search-input");

    if (searchInput) {

        searchInput.addEventListener(
            "keydown",
            function(event) {

                if (
                    event.key === "Enter"
                ) {

                    searchPlace();

                }

            }
        );

    }


    var loadButton =
        byId("load-button");

    if (loadButton) {

        loadButton.addEventListener(
            "click",
            function() {

                if (selectedTile) {

                    loadTile(
                        selectedTile
                    );

                }

            }
        );

    }


    var unloadButton =
        byId("unload-button");

    if (unloadButton) {

        unloadButton.addEventListener(
            "click",
            unloadSelectedTile
        );

    }


    var downloadButton =
        byId("download-button");

    if (downloadButton) {

        downloadButton.addEventListener(
            "click",
            downloadSelectedTile
        );

    }


    var colorMode =
        byId("color-mode");

    if (colorMode) {

        colorMode.addEventListener(
            "change",
            function() {

                applyColorMode(
                    colorMode.value
                );

            }
        );

    }


    var horizontalButton =
        byId(
            "horizontal-section-button"
        );

    if (horizontalButton) {

        horizontalButton.addEventListener(
            "click",
            createHorizontalSection
        );

    }


    var verticalButton =
        byId(
            "vertical-section-button"
        );

    if (verticalButton) {

        verticalButton.addEventListener(
            "click",
            createVerticalSection
        );

    }


    var clearSectionButton =
        byId(
            "clear-section-button"
        );

    if (clearSectionButton) {

        clearSectionButton.addEventListener(
            "click",
            clearSection
        );

    }

}


/* =========================================================
   STAC SEARCH
   ========================================================= */

function findTiles() {

    if (!map) {
        return;
    }


    var bounds =
        map.getBounds();


    var west =
        bounds.getWest();

    var south =
        bounds.getSouth();

    var east =
        bounds.getEast();

    var north =
        bounds.getNorth();


    var bbox =
        [
            west,
            south,
            east,
            north
        ].join(",");


    if (queryController) {

        try {

            queryController.abort();

        } catch (error) {
            /* ignore */
        }

    }


    queryController =
        new AbortController();


    setStatus(
        "Searching LiDAR tiles..."
    );


    var url =
        CONFIG.STAC_ROOT +
        "/collections/" +
        encodeURIComponent(
            CONFIG.COLLECTION
        ) +
        "/items?bbox=" +
        encodeURIComponent(
            bbox
        ) +
        "&limit=" +
        CONFIG.MAX_TILES;


    fetch(
        url,
        {
            signal:
                queryController.signal
        }
    )
    .then(
        function(response) {

            if (!response.ok) {

                throw new Error(
                    "STAC request failed: " +
                    response.status
                );

            }

            return response.json();

        }
    )
    .then(
        function(data) {

            processSTACResults(
                data
            );

        }
    )
    .catch(
        function(error) {

            if (
                error &&
                error.name === "AbortError"
            ) {

                return;

            }


            console.error(
                error
            );


            setStatus(
                "Tile search failed."
            );

        }
    );
}


/* =========================================================
   PROCESS STAC
   ========================================================= */

function processSTACResults(
    data
) {

    tiles = [];


    if (
        !data ||
        !data.features
    ) {

        renderTiles();

        return;
    }


    for (
        var i = 0;
        i < data.features.length;
        i++
    ) {

        var feature =
            data.features[i];


        var asset =
            findCOPCAsset(
                feature
            );


        if (!asset) {
            continue;
        }


        var tile =
            createTile(
                feature,
                asset
            );


        if (tile) {

            tiles.push(
                tile
            );

        }

    }


    renderTileFootprints();

    renderTiles();


    setStatus(
        tiles.length +
        " LiDAR tile(s) found."
    );
}


/* =========================================================
   FIND COPC ASSET
   ========================================================= */

function findCOPCAsset(
    feature
) {

    if (
        !feature ||
        !feature.assets
    ) {

        return null;
    }


    var keys =
        Object.keys(
            feature.assets
        );


    for (
        var i = 0;
        i < keys.length;
        i++
    ) {

        var key =
            keys[i];


        var asset =
            feature.assets[key];


        if (!asset) {
            continue;
        }


        var href =
            asset.href ||
            "";


        var type =
            asset.type ||
            "";


        var lowerHref =
            href.toLowerCase();

        var lowerType =
            type.toLowerCase();


        if (
            lowerHref.indexOf(".copc.laz") !== -1 ||
            lowerHref.indexOf(".laz") !== -1 ||
            lowerType.indexOf("copc") !== -1 ||
            lowerType.indexOf("laz") !== -1
        ) {

            return asset;

        }

    }


    return null;
}


/* =========================================================
   CREATE TILE
   ========================================================= */

function createTile(
    feature,
    asset
) {

    if (!feature) {
        return null;
    }


    var bbox =
        feature.bbox ||
        null;


    return {

        id:
            feature.id ||
            Math.random().toString(36),

        title:
            feature.properties &&
            (
                feature.properties.title ||
                feature.properties.name
            )
                ?
                (
                    feature.properties.title ||
                    feature.properties.name
                )
                :
                (
                    feature.id ||
                    "LiDAR tile"
                ),

        href:
            asset.href,

        bbox:
            bbox,

        geometry:
            feature.geometry,

        properties:
            feature.properties ||
            {},

        asset:
            asset

    };
}


/* =========================================================
   TILE FOOTPRINTS
   ========================================================= */

function renderTileFootprints() {

    if (!map) {
        return;
    }


    for (
        var i = 0;
        i < tileLayers.length;
        i++
    ) {

        try {

            map.removeLayer(
                tileLayers[i]
            );

        } catch (error) {
            /* ignore */
        }

    }


    tileLayers = [];


    for (
        var j = 0;
        j < tiles.length;
        j++
    ) {

        var tile =
            tiles[j];


        var layer =
            createTileLayer(
                tile
            );


        if (layer) {

            layer.addTo(
                map
            );

            tileLayers.push(
                layer
            );

        }

    }
}


/* =========================================================
   CREATE TILE LAYER
   ========================================================= */

function createTileLayer(
    tile
) {

    if (
        !tile ||
        !tile.geometry
    ) {

        return null;
    }


    try {

        var layer =
            L.geoJSON(
                tile.geometry,
                {
                    style:
                        function() {

                            return {

                                color: "#ffffff",

                                weight: 1,

                                fillColor:
                                    "#ffffff",

                                fillOpacity:
                                    0.08

                            };

                        }
                }
            );


        layer.on(
            "click",
            function() {

                selectTile(
                    tile
                );

            }
        );


        return layer;

    } catch (error) {

        console.error(
            error
        );

        return null;

    }
}


/* =========================================================
   TILE LIST
   ========================================================= */

function renderTiles() {

    var list =
        byId("tile-list");

    var count =
        byId("tile-count");


    if (!list) {
        return;
    }


    list.innerHTML = "";


    if (count) {

        count.textContent =
            tiles.length;

    }


    if (tiles.length === 0) {

        list.innerHTML =
            '<div class="attribute-empty" style="padding:12px;">' +
            'No LiDAR tiles found in the current map area.' +
            '</div>';

        return;
    }


    for (
        var i = 0;
        i < tiles.length;
        i++
    ) {

        var tile =
            tiles[i];


        var row =
            document.createElement(
                "div"
            );


        row.className =
            "tile-row";


        if (
            selectedTile &&
            selectedTile.id === tile.id
        ) {

            row.classList.add(
                "selected"
            );

        }


        if (
            isTileLoaded(
                tile
            )
        ) {

            row.classList.add(
                "loaded"
            );

        }


        var name =
            document.createElement(
                "div"
            );

        name.className =
            "tile-name";

        name.textContent =
            tile.title;


        var meta =
            document.createElement(
                "div"
            );

        meta.className =
            "tile-meta";

        meta.textContent =
            tile.id;


        row.appendChild(
            name
        );

        row.appendChild(
            meta
        );


        row.addEventListener(
            "click",
            (function(tileRef) {

                return function() {

                    selectTile(
                        tileRef
                    );

                };

            })(tile)
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
    tile
) {

    selectedTile =
        tile;


    updateSelectedPanel();

    renderTiles();


    setStatus(
        "Selected: " +
        tile.title
    );
}


/* =========================================================
   UPDATE SELECTED PANEL
   ========================================================= */

function updateSelectedPanel() {

    var title =
        byId("selected-title");

    var info =
        byId("selected-info");

    var loadButton =
        byId("load-button");

    var unloadButton =
        byId("unload-button");

    var downloadButton =
        byId("download-button");


    if (!selectedTile) {

        if (title) {
            title.textContent =
                "No tile selected";
        }

        if (info) {
            info.textContent =
                "Select a LiDAR tile.";
        }

        if (loadButton) {
            loadButton.disabled =
                true;
        }

        if (unloadButton) {
            unloadButton.disabled =
                true;
        }

        if (downloadButton) {
            downloadButton.disabled =
                true;
        }

        return;
    }


    if (title) {

        title.textContent =
            selectedTile.title;

    }


    if (info) {

        info.textContent =
            selectedTile.href;

    }


    if (loadButton) {

        loadButton.disabled =
            isTileLoaded(
                selectedTile
            );

    }


    if (unloadButton) {

        unloadButton.disabled =
            !isTileLoaded(
                selectedTile
            );

    }


    if (downloadButton) {

        downloadButton.disabled =
            !selectedTile.href;

    }


    updateSectionButtons();
}


/* =========================================================
   IS LOADED
   ========================================================= */

function isTileLoaded(
    tile
) {

    for (
        var i = 0;
        i < loadedClouds.length;
        i++
    ) {

        if (
            loadedClouds[i].tile.id ===
            tile.id
        ) {

            return true;

        }

    }


    return false;
}


/* =========================================================
   LOAD TILE
   ========================================================= */

function loadTile(
    tile
) {

    if (!tile) {
        return;
    }


    if (isTileLoaded(tile)) {

        setStatus(
            "Tile is already loaded."
        );

        return;
    }


    if (
        loadedClouds.length >=
        CONFIG.MAX_LOADED_POINTCLOUDS
    ) {

        setStatus(
            "Maximum number of loaded point clouds reached."
        );

        return;
    }


    setStatus(
        "Loading " +
        tile.title +
        "..."
    );


    try {

        Potree.loadPointCloud(
            tile.href,
            tile.title,
            function(event) {

                if (
                    !event ||
                    !event.pointcloud
                ) {

                    setStatus(
                        "Point cloud could not be loaded."
                    );

                    return;

                }


                var pointcloud =
                    event.pointcloud;


                configurePointCloud(
                    pointcloud
                );


                viewer.scene.addPointCloud(
                    pointcloud
                );


                loadedClouds.push({

                    tile:
                        tile,

                    pointcloud:
                        pointcloud

                });


                selectedTile =
                    tile;


                inspectPointCloud(
                    pointcloud
                );


                updateSelectedPanel();

                renderTiles();


                fitLoadedClouds();


                updateSectionButtons();


                setStatus(
                    "Loaded " +
                    tile.title
                );

            }
        );

    } catch (error) {

        console.error(
            error
        );


        setStatus(
            "Point-cloud loading failed."
        );

    }
}


/* =========================================================
   CONFIGURE POINT CLOUD
   ========================================================= */

function configurePointCloud(
    pointcloud
) {

    if (!pointcloud) {
        return;
    }


    var material =
        pointcloud.material;


    if (!material) {
        return;
    }


    /*
        Make the points clearly visible.
    */

    try {

        material.size =
            1.5;

    } catch (error) {
        /* ignore */
    }


    try {

        material.pointSizeType =
            Potree.PointSizeType.ADAPTIVE;

    } catch (error) {
        /* ignore */
    }


    /*
        Disable RGB because this dataset
        should be inspected through its
        LiDAR attributes.
    */

    setColorModeOnPointCloud(
        pointcloud,
        "intensity-gradient"
    );


    /*
        Explicit intensity range.

        Swiss/LAS intensity is commonly
        represented as 16-bit data.
    */

    try {

        material.intensityRange =
            [
                0,
                65535
            ];

    } catch (error) {
        /* ignore */
    }


    /*
        Try to derive the actual elevation range.
    */

    try {

        var box =
            pointcloud.boundingBox;

        if (box) {

            var minZ =
                box.min.z;

            var maxZ =
                box.max.z;


            if (
                isFinite(minZ) &&
                isFinite(maxZ) &&
                maxZ > minZ
            ) {

                material.elevationRange =
                    [
                        minZ,
                        maxZ
                    ];

            }

        }

    } catch (error) {

        console.log(
            "Could not set elevation range.",
            error
        );

    }


    /*
        Some Potree versions need the
        shader update explicitly.
    */

    try {

        if (
            typeof material.updateShaderSource ===
            "function"
        ) {

            material.updateShaderSource();

        }

    } catch (error) {

        console.log(
            "Shader refresh failed.",
            error
        );

    }


    /*
        Ensure transparency does not
        accidentally make the cloud black.
    */

    try {

        material.opacity =
            1.0;

    } catch (error) {
        /* ignore */
    }


    /*
        Slightly increase point visibility.
    */

    try {

        material.minSize =
            2;

    } catch (error) {
        /* ignore */
    }
}


/* =========================================================
   ATTRIBUTE INSPECTION
   ========================================================= */

function inspectPointCloud(
    pointcloud
) {

    var list =
        byId("attribute-list");


    if (!list) {
        return;
    }


    list.innerHTML = "";


    if (
        !pointcloud ||
        !pointcloud.pcoGeometry
    ) {

        list.innerHTML =
            '<div class="attribute-empty">' +
            'No point-cloud metadata available.' +
            '</div>';

        return;
    }


    var pointAttributes =
        pointcloud
            .pcoGeometry
            .pointAttributes;


    if (!pointAttributes) {

        list.innerHTML =
            '<div class="attribute-empty">' +
            'No point attributes available.' +
            '</div>';

        return;
    }


    var attributes =
        pointAttributes.attributes ||
        [];


    console.log(
        "Point-cloud attributes:",
        attributes
    );


    if (attributes.length === 0) {

        list.innerHTML =
            '<div class="attribute-empty">' +
            'No attributes found.' +
            '</div>';

        return;
    }


    for (
        var i = 0;
        i < attributes.length;
        i++
    ) {

        var attribute =
            attributes[i];


        var row =
            document.createElement(
                "div"
            );

        row.className =
            "attribute-row";


        var name =
            document.createElement(
                "div"
            );

        name.className =
            "attribute-name";


        var value =
            document.createElement(
                "div"
            );

        value.className =
            "attribute-value";


        var friendly =
            getFriendlyAttributeName(
                attribute
            );


        name.textContent =
            friendly;


        value.textContent =
            getAttributeDetails(
                attribute
            );


        row.appendChild(
            name
        );

        row.appendChild(
            value
        );


        list.appendChild(
            row
        );

    }
}


/* =========================================================
   FRIENDLY ATTRIBUTE NAME
   ========================================================= */

function getFriendlyAttributeName(
    attribute
) {

    if (!attribute) {
        return "Unknown";
    }


    var name =
        String(
            attribute.name ||
            attribute.attribute ||
            ""
        );


    var lower =
        name.toLowerCase();


    if (
        lower.indexOf("position") !== -1
    ) {

        return "Position";

    }


    if (
        lower.indexOf("rgba") !== -1 ||
        lower === "color"
    ) {

        return "RGBA color";

    }


    if (
        lower === "intensity"
    ) {

        return "Intensity";

    }


    if (
        lower === "classification"
    ) {

        return "Classification";

    }


    if (
        lower.indexOf("gps") !== -1
    ) {

        return "GPS time";

    }


    if (
        lower === "returnnumber"
    ) {

        return "Return number";

    }


    if (
        lower === "numberofreturns"
    ) {

        return "Number of returns";

    }


    if (
        lower.indexOf("source") !== -1
    ) {

        return "Point source ID";

    }


    return name;
}


/* =========================================================
   ATTRIBUTE DETAILS
   ========================================================= */

function getAttributeDetails(
    attribute
) {

    if (!attribute) {
        return "";
    }


    var parts = [];


    if (
        attribute.type !== undefined
    ) {

        parts.push(
            String(
                attribute.type
            )
        );

    }


    if (
        attribute.numElements !==
        undefined
    ) {

        parts.push(
            String(
                attribute.numElements
            ) +
            " values"
        );

    }


    if (
        attribute.elementSize !==
        undefined
    ) {

        parts.push(
            String(
                attribute.elementSize
            ) +
            " B"
        );

    }


    return parts.join(
        " · "
    );
}


/* =========================================================
   SET COLOR MODE
   ========================================================= */

function applyColorMode(
    mode
) {

    if (
        loadedClouds.length === 0
    ) {

        setStatus(
            "Load a point cloud first."
        );

        return;
    }


    for (
        var i = 0;
        i < loadedClouds.length;
        i++
    ) {

        var pointcloud =
            loadedClouds[i]
                .pointcloud;


        setColorModeOnPointCloud(
            pointcloud,
            mode
        );

    }


    setStatus(
        "Displaying by " +
        getColorModeLabel(
            mode
        )
    );
}


/* =========================================================
   COLOR MODE ON POINT CLOUD
   ========================================================= */

function setColorModeOnPointCloud(
    pointcloud,
    mode
) {

    if (
        !pointcloud ||
        !pointcloud.material
    ) {

        return;
    }


    var material =
        pointcloud.material;


    var enumValue =
        null;


    /*
        Potree 1.8 naming.
    */

    if (!Potree.PointColorType) {

        console.warn(
            "Potree.PointColorType unavailable."
        );

        return;
    }


    if (mode === "intensity-gradient") {

        enumValue =
            Potree.PointColorType
                .INTENSITY_GRADIENT;

    }

    else if (mode === "intensity") {

        enumValue =
            Potree.PointColorType
                .INTENSITY;

    }

    else if (mode === "classification") {

        enumValue =
            Potree.PointColorType
                .CLASSIFICATION;

    }

    else if (mode === "elevation") {

        if (
            Potree.PointColorType
                .ELEVATION !== undefined
        ) {

            enumValue =
                Potree.PointColorType
                    .ELEVATION;

        }

        else {

            enumValue =
                Potree.PointColorType
                    .HEIGHT;

        }

    }

    else if (
        mode === "return-number"
    ) {

        enumValue =
            Potree.PointColorType
                .RETURN_NUMBER;

    }

    else if (
        mode === "number-of-returns"
    ) {

        if (
            Potree.PointColorType
                .NUMBER_OF_RETURNS !== undefined
        ) {

            enumValue =
                Potree.PointColorType
                    .NUMBER_OF_RETURNS;

        }

    }

    else if (
        mode === "source-id"
    ) {

        if (
            Potree.PointColorType
                .SOURCE !== undefined
        ) {

            enumValue =
                Potree.PointColorType
                    .SOURCE;

        }

        else if (
            Potree.PointColorType
                .SOURCE_ID !== undefined
        ) {

            enumValue =
                Potree.PointColorType
                    .SOURCE_ID;

        }

    }


    if (enumValue === null) {

        console.warn(
            "Unsupported color mode:",
            mode
        );

        return;
    }


    /*
        Important for Potree 1.8:
        setting the material property
        and refreshing the shader.
    */

    try {

        material.pointColorType =
            enumValue;

    } catch (error) {

        console.error(
            "Could not set point color type.",
            error
        );

        return;
    }


    /*
        Keep the intensity range valid.
    */

    if (
        mode === "intensity" ||
        mode === "intensity-gradient"
    ) {

        try {

            material.intensityRange =
                [
                    0,
                    65535
                ];

        } catch (error) {
            /* ignore */
        }

    }


    /*
        Elevation range.
    */

    if (
        mode === "elevation"
    ) {

        try {

            if (
                pointcloud.boundingBox
            ) {

                material.elevationRange =
                    [
                        pointcloud
                            .boundingBox
                            .min
                            .z,

                        pointcloud
                            .boundingBox
                            .max
                            .z
                    ];

            }

        } catch (error) {
            /* ignore */
        }

    }


    /*
        Force shader regeneration.
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
            "Could not refresh Potree shader.",
            error
        );

    }


    /*
        In some Potree versions the
        material needs to be marked dirty.
    */

    try {

        material.needsUpdate =
            true;

    } catch (error) {
        /* ignore */
    }
}


/* =========================================================
   COLOR LABEL
   ========================================================= */

function getColorModeLabel(
    mode
) {

    if (
        mode ===
        "intensity-gradient"
    ) {

        return "intensity gradient";

    }


    if (
        mode ===
        "intensity"
    ) {

        return "intensity";

    }


    if (
        mode ===
        "classification"
    ) {

        return "classification";

    }


    if (
        mode ===
        "elevation"
    ) {

        return "elevation";

    }


    if (
        mode ===
        "return-number"
    ) {

        return "return number";

    }


    if (
        mode ===
        "number-of-returns"
    ) {

        return "number of returns";

    }


    if (
        mode ===
        "source-id"
    ) {

        return "point source ID";

    }


    return mode;
}


/* =========================================================
   FIT CLOUDS
   ========================================================= */

function fitLoadedClouds() {

    if (
        !viewer ||
        loadedClouds.length === 0
    ) {

        setStatus(
            "No point cloud loaded."
        );

        return;
    }


    try {

        viewer.fitToScreen();

        setStatus(
            "View fitted to point cloud."
        );

    } catch (error) {

        console.error(
            error
        );

        setStatus(
            "Could not fit view."
        );

    }
}


/* =========================================================
   REMOVE POINT CLOUD
   ========================================================= */

function removePointCloudFromViewer(
    pointcloud
) {

    if (
        !viewer ||
        !pointcloud
    ) {

        return;
    }


    /*
        Potree 1.8 does not necessarily
        expose scene.removePointCloud().
    */

    try {

        if (
            viewer.scene &&
            viewer.scene.pointclouds
        ) {

            var index =
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

    } catch (error) {

        console.error(
            error
        );

    }


    try {

        if (
            typeof pointcloud.dispose ===
            "function"
        ) {

            pointcloud.dispose();

        }

    } catch (error) {
        /* ignore */
    }
}


/* =========================================================
   UNLOAD SELECTED
   ========================================================= */

function unloadSelectedTile() {

    if (!selectedTile) {
        return;
    }


    for (
        var i =
            loadedClouds.length - 1;
        i >= 0;
        i--
    ) {

        if (
            loadedClouds[i]
                .tile
                .id ===
            selectedTile.id
        ) {

            var pointcloud =
                loadedClouds[i]
                    .pointcloud;


            removePointCloudFromViewer(
                pointcloud
            );


            loadedClouds.splice(
                i,
                1
            );

        }

    }


    clearSection();


    updateSelectedPanel();

    renderTiles();


    setStatus(
        "Unloaded " +
        selectedTile.title
    );
}


/* =========================================================
   CLEAR ALL CLOUDS
   ========================================================= */

function clearAllClouds() {

    for (
        var i =
            loadedClouds.length - 1;
        i >= 0;
        i--
    ) {

        removePointCloudFromViewer(
            loadedClouds[i]
                .pointcloud
        );

    }


    loadedClouds = [];


    clearSection();


    updateSelectedPanel();

    renderTiles();


    setStatus(
        "All point clouds cleared."
    );
}


/* =========================================================
   DOWNLOAD
   ========================================================= */

function downloadSelectedTile() {

    if (
        !selectedTile ||
        !selectedTile.href
    ) {

        return;
    }


    /*
        Cross-origin servers may ignore the
        HTML download attribute.

        Opening the original COPC URL is
        therefore the safest browser behaviour.
    */

    window.open(
        selectedTile.href,
        "_blank"
    );


    setStatus(
        "Opened COPC download URL."
    );
}


/* =========================================================
   SEARCH PLACE
   ========================================================= */

function searchPlace() {

    var input =
        byId("search-input");


    var results =
        byId("search-results");


    if (!input || !results) {
        return;
    }


    var query =
        input.value.trim();


    if (!query) {

        results.innerHTML = "";

        return;
    }


    results.innerHTML =
        '<div class="attribute-empty" style="padding:10px;">' +
        'Searching...' +
        '</div>';


    var url =
        CONFIG.SEARCH_URL +
        "?searchText=" +
        encodeURIComponent(
            query
        ) +
        "&typeahead=true" +
        "&limit=8";


    fetch(url)
        .then(
            function(response) {

                if (!response.ok) {

                    throw new Error(
                        "Search failed"
                    );

                }

                return response.json();

            }
        )
        .then(
            function(data) {

                renderPlaceResults(
                    data
                );

            }
        )
        .catch(
            function(error) {

                console.error(
                    error
                );

                results.innerHTML =
                    '<div class="attribute-empty" style="padding:10px;">' +
                    'Search failed.' +
                    '</div>';

            }
        );
}


/* =========================================================
   RENDER PLACE RESULTS
   ========================================================= */

function renderPlaceResults(
    data
) {

    var results =
        byId("search-results");


    if (!results) {
        return;
    }


    results.innerHTML = "";


    var features =
        data &&
        data.results
            ?
            data.results
            :
            [];


    if (features.length === 0) {

        results.innerHTML =
            '<div class="attribute-empty" style="padding:10px;">' +
            'No results.' +
            '</div>';

        return;
    }


    for (
        var i = 0;
        i < features.length;
        i++
    ) {

        var item =
            features[i];


        var row =
            document.createElement(
                "div"
            );


        row.className =
            "search-result";


        row.textContent =
            item.label ||
            item.attrs &&
            item.attrs.label ||
            "Result";


        row.addEventListener(
            "click",
            (function(result) {

                return function() {

                    zoomToSearchResult(
                        result
                    );

                };

            })(item)
        );


        results.appendChild(
            row
        );

    }
}


/* =========================================================
   ZOOM SEARCH RESULT
   ========================================================= */

function zoomToSearchResult(
    result
) {

    if (
        !map ||
        !result
    ) {

        return;
    }


    var attrs =
        result.attrs ||
        {};


    var lat =
        parseFloat(
            attrs.lat
        );

    var lon =
        parseFloat(
            attrs.lon
        );


    if (
        !isFinite(lat) ||
        !isFinite(lon)
    ) {

        return;
    }


    map.setView(
        [
            lat,
            lon
        ],
        15
    );


    if (searchMarker) {

        map.removeLayer(
            searchMarker
        );

    }


    searchMarker =
        L.marker(
            [
                lat,
                lon
            ]
        )
        .addTo(map);


    searchMarker.bindPopup(
        result.label ||
        "Search result"
    ).openPopup();


    var results =
        byId("search-results");


    if (results) {

        results.innerHTML = "";

    }
}


/* =========================================================
   SECTION BUTTON STATE
   ========================================================= */

function updateSectionButtons() {

    var horizontal =
        byId(
            "horizontal-section-button"
        );

    var vertical =
        byId(
            "vertical-section-button"
        );

    var clear =
        byId(
            "clear-section-button"
        );

    var info =
        byId(
            "section-info"
        );


    var enabled =
        loadedClouds.length > 0;


    if (horizontal) {
        horizontal.disabled =
            !enabled;
    }

    if (vertical) {
        vertical.disabled =
            !enabled;
    }

    if (clear) {
        clear.disabled =
            !activeSection;
    }


    if (info) {

        if (activeSection) {

            info.textContent =
                activeSection.type ===
                "horizontal"
                    ?
                    "Horizontal section active."
                    :
                    "Vertical section active.";

        }

        else if (enabled) {

            info.textContent =
                "Choose a section type.";

        }

        else {

            info.textContent =
                "Load a point cloud to create sections.";

        }

    }
}


/* =========================================================
   GET CLOUD BOUNDS
   ========================================================= */

function getCombinedCloudBounds() {

    if (
        loadedClouds.length === 0
    ) {

        return null;
    }


    var min =
        new THREE.Vector3(
            Infinity,
            Infinity,
            Infinity
        );


    var max =
        new THREE.Vector3(
            -Infinity,
            -Infinity,
            -Infinity
        );


    for (
        var i = 0;
        i < loadedClouds.length;
        i++
    ) {

        var cloud =
            loadedClouds[i]
                .pointcloud;


        if (
            !cloud ||
            !cloud.boundingBox
        ) {

            continue;
        }


        var box =
            cloud.boundingBox;


        min.x =
            Math.min(
                min.x,
                box.min.x
            );

        min.y =
            Math.min(
                min.y,
                box.min.y
            );

        min.z =
            Math.min(
                min.z,
                box.min.z
            );


        max.x =
            Math.max(
                max.x,
                box.max.x
            );

        max.y =
            Math.max(
                max.y,
                box.max.y
            );

        max.z =
            Math.max(
                max.z,
                box.max.z
            );

    }


    if (
        !isFinite(min.x) ||
        !isFinite(max.x)
    ) {

        return null;
    }


    return {
        min: min,
        max: max
    };
}


/* =========================================================
   HORIZONTAL SECTION
   ========================================================= */

function createHorizontalSection() {

    clearSection();


    var bounds =
        getCombinedCloudBounds();


    if (!bounds) {

        setStatus(
            "No point cloud available."
        );

        return;
    }


    var center =
        new THREE.Vector3(
            (
                bounds.min.x +
                bounds.max.x
            ) / 2,

            (
                bounds.min.y +
                bounds.max.y
            ) / 2,

            (
                bounds.min.z +
                bounds.max.z
            ) / 2
        );


    var width =
        bounds.max.x -
        bounds.min.x;


    var depth =
        bounds.max.y -
        bounds.min.y;


    var height =
        bounds.max.z -
        bounds.min.z;


    /*
        Very thin horizontal box.

        It acts like a horizontal
        slice through the cloud.
    */

    var thickness =
        Math.max(
            height * 0.03,
            0.25
        );


    var volume =
        new Potree.BoxVolume();


    volume.name =
        "Horizontal Section";


    volume.position.copy(
        center
    );


    volume.scale.set(
        width,
        depth,
        thickness
    );


    volume.clip =
        true;


    volume.visible =
        true;


    viewer.scene.addVolume(
        volume
    );


    viewer.setClipTask(
        Potree.ClipTask.SHOW_INSIDE
    );


    activeSection = {

        type:
            "horizontal",

        volume:
            volume

    };


    updateSectionButtons();


    setStatus(
        "Horizontal section created."
    );
}


/* =========================================================
   VERTICAL SECTION
   ========================================================= */

function createVerticalSection() {

    clearSection();


    var bounds =
        getCombinedCloudBounds();


    if (!bounds) {

        setStatus(
            "No point cloud available."
        );

        return;
    }


    var center =
        new THREE.Vector3(
            (
                bounds.min.x +
                bounds.max.x
            ) / 2,

            (
                bounds.min.y +
                bounds.max.y
            ) / 2,

            (
                bounds.min.z +
                bounds.max.z
            ) / 2
        );


    var width =
        bounds.max.x -
        bounds.min.x;


    var depth =
        bounds.max.y -
        bounds.min.y;


    var height =
        bounds.max.z -
        bounds.min.z;


    /*
        Thin vertical plane.

        X direction is narrow,
        Y spans the cloud,
        Z spans the cloud.

        This produces a vertical
        cross-section.
    */

    var thickness =
        Math.max(
            width * 0.03,
            0.25
        );


    var volume =
        new Potree.BoxVolume();


    volume.name =
        "Vertical Section";


    volume.position.copy(
        center
    );


    volume.scale.set(
        thickness,
        depth,
        height
    );


    volume.clip =
        true;


    volume.visible =
        true;


    viewer.scene.addVolume(
        volume
    );


    viewer.setClipTask(
        Potree.ClipTask.SHOW_INSIDE
    );


    activeSection = {

        type:
            "vertical",

        volume:
            volume

    };


    updateSectionButtons();


    setStatus(
        "Vertical section created."
    );
}


/* =========================================================
   CLEAR SECTION
   ========================================================= */

function clearSection() {

    if (
        activeSection &&
        activeSection.volume
    ) {

        try {

            if (
                viewer.scene &&
                viewer.scene.removeVolume
            ) {

                viewer.scene.removeVolume(
                    activeSection.volume
                );

            }

        } catch (error) {

            console.warn(
                "Could not remove volume.",
                error
            );

        }


        /*
            Fallback for Potree builds where
            removeVolume is unavailable.
        */

        try {

            if (
                viewer.scene &&
                viewer.scene.volumes
            ) {

                var index =
                    viewer.scene
                        .volumes
                        .indexOf(
                            activeSection.volume
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

        } catch (error) {
            /* ignore */
        }

    }


    activeSection =
        null;


    try {

        viewer.setClipTask(
            Potree.ClipTask.NONE
        );

    } catch (error) {

        /*
            Some versions don't expose NONE.
            SHOW_OUTSIDE effectively restores
            normal display for no volumes.
        */

        try {

            viewer.setClipTask(
                Potree.ClipTask.SHOW_OUTSIDE
            );

        } catch (secondError) {
            /* ignore */
        }

    }


    updateSectionButtons();

}


/* =========================================================
   START
   ========================================================= */

if (
    document.readyState ===
    "loading"
) {

    document.addEventListener(
        "DOMContentLoaded",
        initialize
    );

} else {

    initialize();

}
