/* =========================================================
   Swiss LiDAR COPC Viewer
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

const viewer =
    new Potree.Viewer(
        document.getElementById(
            "potree_render_area"
        )
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
 * Potree GUI.
 */

viewer.loadGUI(() => {

    viewer.setLanguage("en");

    $("#menu_appearance")
        .next()
        .show();

    $("#menu_tools")
        .next()
        .show();

    $("#menu_clipping")
        .next()
        .show();

});


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

function setStatus(message) {

    document.getElementById(
        "status"
    ).textContent = message;

}


function escapeHtml(value) {

    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");

}


/* =========================================================
   BBOX
   ========================================================= */

/*
 * Leaflet returns:
 *
 * south, west, north, east
 *
 * STAC expects:
 *
 * west, south, east, north
 */

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

function buildSTACURL(bbox) {

    const url =
        new URL(
            `${CONFIG.STAC_ROOT}/collections/${CONFIG.COLLECTION}/items`
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
 * Get all pages of STAC results.
 */

async function fetchAllSTACItems(
    firstURL
) {

    let url =
        firstURL;

    const items = [];

    while (url) {

        const response =
            await fetch(url);

        if (!response.ok) {

            throw new Error(
                `STAC request failed: ${response.status}`
            );

        }

        const data =
            await response.json();

        if (Array.isArray(data.features)) {

            items.push(
                ...data.features
            );

        }


        /*
         * STAC pagination.
         */

        const next =
            data.links?.find(
                link =>
                    link.rel === "next"
            );

        url =
            next?.href || null;

        /*
         * Safety limit.
         */

        if (items.length >=
            CONFIG.MAX_TILES) {

            break;

        }

    }

    return items;

}


/* =========================================================
   FIND COPC ASSET
   ========================================================= */

function findCOPCAsset(item) {

    const assets =
        Object.values(
            item.assets || {}
        );

    /*
     * Prefer an explicitly COPC-named asset.
     */

    let asset =
        assets.find(
            a =>
                typeof a.href === "string" &&
                (
                    a.href
                        .toLowerCase()
                        .includes(".copc.laz")
                    ||
                    a.title
                        ?.toLowerCase()
                        .includes("copc")
                )
        );

    if (asset) {

        return asset;

    }


    /*
     * Some catalogue versions may expose
     * the COPC file under a less obvious asset
     * name. Look at the href.
     */

    asset =
        assets.find(
            a =>
                typeof a.href === "string" &&
                a.href
                    .toLowerCase()
                    .includes("copc")
        );

    return asset || null;

}


/* =========================================================
   NORMALIZE TILE
   ========================================================= */

function normalizeTile(item) {

    const asset =
        findCOPCAsset(item);

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

    return {

        id:
            item.id,

        title:
            item.properties?.title ||
            item.id,

        bbox: bbox,

        geometry:
            item.geometry,

        date:
            item.properties?.datetime ||
            item.properties?.updated ||
            null,

        href:
            asset.href,

        assetTitle:
            asset.title ||
            "",

        size:
            asset["file:size"] ||
            asset["size"] ||
            null

    };

}


/* =========================================================
   FIND TILES
   ========================================================= */

async function findTiles() {

    if (state.queryController) {

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
            buildSTACURL(bbox);


        const response =
            await fetchAllSTACItems(
                url.href
            );


        const tiles =
            response
                .map(normalizeTile)
                .filter(Boolean)
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
            `${tiles.length} COPC tile(s) found.`
        );


    } catch (error) {

        if (
            error.name ===
            "AbortError"
        ) {

            return;

        }

        console.error(error);

        setStatus(
            `Tile search failed: ${error.message}`
        );

    }

}


/* =========================================================
   DRAW TILE FOOTPRINTS
   ========================================================= */

function drawTiles(tiles) {

    clearTileLayers();


    for (const tile of tiles) {

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
            () => {

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

    for (
        const layer
        of state.tileLayers.values()
    ) {

        map.removeLayer(
            layer
        );

    }

    state.tileLayers.clear();

}


/* =========================================================
   TILE LIST
   ========================================================= */

function renderTileList(tiles) {

    const list =
        document.getElementById(
            "tile-list"
        );


    const count =
        document.getElementById(
            "tile-count"
        );


    count.textContent =
        tiles.length;


    list.innerHTML = "";


    if (!tiles.length) {

        list.innerHTML =
            `
            <div class="tile-row">
                No COPC tiles found.
            </div>
            `;

        return;

    }


    for (const tile of tiles) {

        const row =
            document.createElement(
                "div"
            );


        row.className =
            "tile-row";


        row.dataset.id =
            tile.id;


        row.innerHTML =
            `
            <div class="tile-name">
                ${escapeHtml(tile.title)}
            </div>

            <div class="tile-meta">
                ${escapeHtml(tile.id)}
            </div>
            `;


        row.addEventListener(
            "click",
            () => {

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

function selectTile(id) {

    const tile =
        state.tiles.find(
            t => t.id === id
        );


    if (!tile) {

        return;

    }


    state.selectedTile =
        tile;


    /*
     * Highlight map rectangle.
     */

    for (
        const [tileId, layer]
        of state.tileLayers
    ) {

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


    /*
     * Highlight list item.
     */

    document
        .querySelectorAll(
            ".tile-row"
        )
        .forEach(
            row => {

                row.classList.toggle(
                    "selected",
                    row.dataset.id === id
                );

            }
        );


    /*
     * Selected panel.
     */

    document.getElementById(
        "selected-title"
    ).textContent =
        tile.title;


    document.getElementById(
        "selected-info"
    ).innerHTML =
        `
        <div><b>ID:</b> ${escapeHtml(tile.id)}</div>
        <div><b>COPC:</b> ${escapeHtml(tile.href)}</div>
        `;


    document.getElementById(
        "load-button"
    ).disabled = false;


    document.getElementById(
        "unload-button"
    ).disabled =
        !state.loadedClouds.has(
            tile.id
        );


    setStatus(
        `Selected ${tile.id}`
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


    /*
     * Already loaded?
     */

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


    /*
     * Prevent excessive simultaneous
     * clouds.
     */

    if (
        state.loadedClouds.size >=
        CONFIG.MAX_LOADED_POINTCLOUDS
    ) {

        setStatus(
            `Maximum of ${CONFIG.MAX_LOADED_POINTCLOUDS} loaded tiles reached. Unload one first.`
        );

        return;

    }


    setStatus(
        `Starting COPC stream for ${tile.id}...`
    );


    try {

        /*
         * Potree supports COPC URLs directly.
         */

        await new Promise(
            (resolve, reject) => {

                Potree.loadPointCloud(
                    tile.href,
                    tile.title,

                    event => {

                        try {

                            const pointcloud =
                                event.pointcloud;


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


                            document.getElementById(
                                "unload-button"
                            ).disabled = false;


                            setStatus(
                                `Streaming ${tile.id}`
                            );


                            /*
                             * Only automatically fit
                             * the first loaded tile.
                             */

                            if (
                                state.loadedClouds.size === 1
                            ) {

                                viewer.fitToScreen(
                                    0.5
                                );

                            }


                            resolve();

                        } catch (error) {

                            reject(error);

                        }

                    }
                );

            }
        );


    } catch (error) {

        console.error(error);

        setStatus(
            `Could not load COPC: ${error.message}`
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


    material.size =
        1;


    material.minSize =
        2;


    material.pointSizeType =
        Potree.PointSizeType.ADAPTIVE;


    material.shape =
        Potree.PointShape.SQUARE;


    /*
     * RGB is preferred when available.
     */

    try {

        material.activeAttributeName =
            "rgba";

    } catch {

        /*
         * Some datasets may not expose RGB.
         */

    }

}


/* =========================================================
   UNLOAD SELECTED
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


    viewer.scene.removePointCloud(
        pointcloud
    );


    /*
     * Dispose where supported.
     */

    try {

        pointcloud.dispose();

    } catch {

        // Ignore.

    }


    state.loadedClouds.delete(
        tile.id
    );


    document.getElementById(
        "unload-button"
    ).disabled = true;


    setStatus(
        `Unloaded ${tile.id}`
    );

}


/* =========================================================
   CLEAR EVERYTHING
   ========================================================= */

function clearAll() {

    for (
        const pointcloud
        of state.loadedClouds.values()
    ) {

        viewer.scene.removePointCloud(
            pointcloud
        );

        try {

            pointcloud.dispose();

        } catch {

            // Ignore.

        }

    }


    state.loadedClouds.clear();

    state.selectedTile =
        null;


    clearTileLayers();


    state.tiles =
        [];


    renderTileList(
        []
    );


    document.getElementById(
        "selected-title"
    ).textContent =
        "No tile selected";


    document.getElementById(
        "selected-info"
    ).innerHTML =
        "";


    document.getElementById(
        "load-button"
    ).disabled = true;


    document.getElementById(
        "unload-button"
    ).disabled = true;


    setStatus(
        "Cleared."
    );

}


/* =========================================================
   SEARCH SWISS PLACE
   ========================================================= */

async function searchPlace(
    text
) {

    if (!text.trim()) {

        return;

    }


    setStatus(
        `Searching for ${text}...`
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
                `Search failed: ${response.status}`
            );

        }


        const data =
            await response.json();


        renderSearchResults(
            data
        );


    } catch (error) {

        console.error(error);

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
        document.getElementById(
            "search-results"
        );


    container.innerHTML =
        "";


    const results =
        data.results ||
        [];


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


        row.textContent =
            result.label ||
            result.attrs?.label ||
            result.name ||
            "Location";


        row.addEventListener(
            "click",
            () => {

                const lon =
                    result.lon ??
                    result.geometry?.coordinates?.[0];

                const lat =
                    result.lat ??
                    result.geometry?.coordinates?.[1];


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
                        .addTo(map)
                        .bindPopup(
                            result.label ||
                            result.name ||
                            "Location"
                        )
                        .openPopup();


                    /*
                     * Automatically search the
                     * surrounding LiDAR tiles.
                     */

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
            `
            <div class="search-result">
                No results.
            </div>
            `;

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
        `Looking up shared tile ${tileId}...`
    );


    /*
     * We don't have a global tile list,
     * so derive the tile search from the
     * tile ID by asking STAC for matching
     * items.
     */

    try {

        const url =
            new URL(
                `${CONFIG.STAC_ROOT}/collections/${CONFIG.COLLECTION}/items`
            );


        /*
         * The API may support id directly
         * in a future version, but searching
         * the collection is more portable.
         *
         * We therefore query the collection
         * and look for the requested ID.
         */

        url.searchParams.set(
            "limit",
            "100"
        );


        const items =
            await fetchAllSTACItems(
                url.href
            );


        const tile =
            items
                .map(normalizeTile)
                .find(
                    item =>
                        item?.id === tileId
                );


        if (!tile) {

            setStatus(
                "Shared tile was not found in the current catalogue."
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

        console.error(error);

        setStatus(
            `Could not open shared tile: ${error.message}`
        );

    }

}


/* =========================================================
   EVENTS
   ========================================================= */

document
    .getElementById(
        "findTilesButton"
    )
    .addEventListener(
        "click",
        findTiles
    );


document
    .getElementById(
        "load-button"
    )
    .addEventListener(
        "click",
        async () => {

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


document
    .getElementById(
        "unload-button"
    )
    .addEventListener(
        "click",
        unloadSelectedTile
    );


document
    .getElementById(
        "clearButton"
    )
    .addEventListener(
        "click",
        clearAll
    );


document
    .getElementById(
        "fitButton"
    )
    .addEventListener(
        "click",
        () => {

            viewer.fitToScreen(
                0.5
            );

        }
    );


document
    .getElementById(
        "search-button"
    )
    .addEventListener(
        "click",
        () => {

            searchPlace(
                document.getElementById(
                    "search-input"
                ).value
            );

        }
    );


document
    .getElementById(
        "search-input"
    )
    .addEventListener(
        "keydown",
        event => {

            if (
                event.key === "Enter"
            ) {

                searchPlace(
                    event.target.value
                );

            }

        }
    );


/*
 * Refresh tiles when map movement ends.
 */

let moveTimer = null;

map.on(
    "moveend",
    () => {

        clearTimeout(
            moveTimer
        );


        moveTimer =
            setTimeout(
                () => {

                    findTiles();

                },
                350
            );

    }
);


/* =========================================================
   STARTUP
   ========================================================= */

(async function init() {

    setStatus(
        "Loading..."
    );


    await findTiles();


    await loadTileFromURL();


    setStatus(
        "Ready."
    );

})();
