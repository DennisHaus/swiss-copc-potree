/*
 * Swiss LiDAR Viewer - raster colour sources
 *
 * Everything a point can be coloured with, always in LV95 (EPSG:2056) so a
 * point maps to a pixel by plain arithmetic, the same way FME's
 * PointCloudOnRasterComponentSetter does it:
 *
 *   swissimage   SWISSIMAGE 10 cm GeoTIFF of the tile (STAC, see app.js)
 *   hist1946     SWISSIMAGE HIST 1946            (WMTS, LV95 tile grid)
 *   siegfried    Siegfried map, with year        (WMTS)
 *   dufour       Dufour map, with edition        (WMTS)
 *   geology      Geological atlas GA25           (WMTS)
 *   geocover     GeoCover                        (WMTS)
 *   geoadmin     any layer of the federal geoportal, found by search
 *                (natural hazards, protection forest, ...): LV95 WMTS if
 *                the layer has tiles, otherwise WMS
 *   wms          any WMS (e.g. a cantonal geoportal's hazard map)
 *   local        your own GeoTIFF, or TIFF + TFW (e.g. SWISSIMAGE RS)
 *
 * Height above ground comes from swissALTI3D (0.5 m terrain model of the
 * same tile, the model SWISSIMAGE itself is rectified on). Only where it is
 * missing, the LiDAR ground points are used instead.
 *
 * Settings (SWISS_COLOR, set by ui.js):
 *
 *   groundOnly  filter: hide every point that is not ground (2) or water (9)
 *   occlusion   building points lying more than 3 m below the highest point
 *               of their 0.5 m cell (walls) cannot be seen in a top view and
 *               get a neutral colour instead of roof/ground colour
 *   leanAuto    estimate the relief displacement from the data (see below)
 *   leanX/Y     manual displacement when leanAuto is off
 *
 * Relief displacement: orthophotos are rectified on the terrain, so tall
 * objects (church towers) are drawn displaced away from the camera, by
 * about height x (distance from nadir / flying height). A point h metres
 * above the ground is therefore coloured from (E + lx * h, N + ly * h).
 * lx/ly are estimated per 250 m block by moving the LiDAR roof outlines
 * over the image until they match its edges best.
 *
 * Loaded after app.js. Uses its globals (CONFIG, currentTile, proj4, ...).
 */

/* ============================================================
   SOURCES
   ============================================================ */

const SWISS_SOURCES = {
    swissimage: {
        label: "SWISSIMAGE 10 cm",
        type: "dop10"
    },
    hist1946: {
        label: "SWISSIMAGE HIST 1946",
        type: "wmts",
        // the first identifier found in the capabilities is used
        layers: ["ch.swisstopo.swissimage-product_1946", "ch.swisstopo.swissimage-product"],
        preferTime: "1946"
    },
    siegfried: {
        label: "Siegfried map",
        type: "wmts",
        layers: ["ch.swisstopo.hiks-siegfried"],
        chooseTime: true
    },
    dufour: {
        label: "Dufour map",
        type: "wmts",
        layers: ["ch.swisstopo.hiks-dufour"],
        chooseTime: true
    },
    geology: {
        label: "Geological atlas GA25",
        type: "wmts",
        layers: ["ch.swisstopo.geologie-geologischer_atlas"],
        groundOnly: true
    },
    geocover: {
        label: "GeoCover (geological vector data)",
        type: "wmts",
        layers: ["ch.swisstopo.geologie-geocover"],
        groundOnly: true
    },
    geoadmin: {
        label: "geo.admin.ch layer",
        type: "geoadmin",
        groundOnly: true
    },
    wms: {
        label: "WMS layer",
        type: "wms",
        groundOnly: true
    },
    local: {
        label: "Own GeoTIFF / TIFF + TFW",
        type: "local"
    }
};

// extra or changed WMTS layers can be added in config.js:
//   CONFIG.COLOR_SOURCES = { mylayer: { label: "...", type: "wmts", layers: ["ch...."] } }
if (window.CONFIG && CONFIG.COLOR_SOURCES) {
    Object.assign(SWISS_SOURCES, CONFIG.COLOR_SOURCES);
}

const SWISS_COLOR = {
    source: "swissimage",
    time: "",            // WMTS time ("" = layer default)
    groundOnly: false,   // filter: show ground / water points only
    occlusion: true,
    leanAuto: true,      // estimate the tower lean from the data
    leanX: 0,            // manual lean: metres of image shift per metre of height
    leanY: 0,
    layerId: "",         // geoadmin: layer id, e.g. ch.bafu.landesforstinventar-schutzwaldregionen
    layerLabel: "",
    wmsUrl: "",          // wms: service URL
    wmsLayer: ""         // wms: layer name(s), comma separated
};

const SWISS_LOCAL = {
    tif: null,           // File
    tfw: null,           // File (optional world file)
    bands: [0, 1, 2],    // band index for red, green, blue
    stretch: true,       // 2-98 % contrast stretch (needed for 16 bit)
    version: 0,          // bumped whenever file or bands change
    info: null           // { bands, bitsPerSample, width, height } of the file
};

function swissSource() {
    return SWISS_SOURCES[SWISS_COLOR.source] || SWISS_SOURCES.swissimage;
}

/* Identifies the raster content: a different key needs a new raster. */
function swissSourceKey() {
    const source = swissSource();

    if (source.type === "local") {
        return `local:${SWISS_LOCAL.version}`;
    }

    if (source.type === "wmts") {
        return `${SWISS_COLOR.source}:${SWISS_COLOR.time}`;
    }

    if (source.type === "geoadmin") {
        return `geoadmin:${SWISS_COLOR.layerId}`;
    }

    if (source.type === "wms") {
        return `wms:${SWISS_COLOR.wmsUrl}|${SWISS_COLOR.wmsLayer}`;
    }

    return SWISS_COLOR.source;
}

/* Raster + point rules: a different key needs recolouring only. */
function swissColorKey(raster) {
    const lean = SWISS_COLOR.leanAuto
        ? `auto:${raster.leanEstimate ? raster.leanEstimate.id : "none"}`
        : `${SWISS_COLOR.leanX},${SWISS_COLOR.leanY}`;

    return `${raster.id}|occ:${SWISS_COLOR.occlusion ? 1 : 0}|lean:${lean}`;
}

/* LV95 extent of the current tile (+ pad), for loading rasters. */
function swissTileExtentLV95(pad = 20) {
    const id = typeof swissKmTileId === "function" ? swissKmTileId(currentTile) : null;

    if (id) {
        const [e, n] = id.split("-").map(Number);
        return {
            minE: e * 1000 - pad,
            minN: n * 1000 - pad,
            maxE: e * 1000 + 1000 + pad,
            maxN: n * 1000 + 1000 + pad
        };
    }

    const [west, south, east, north] = currentTile.bbox;
    const corners = [[west, south], [east, south], [east, north], [west, north]]
        .map(c => proj4("EPSG:4326", "EPSG:2056", c));

    return {
        minE: Math.min(...corners.map(c => c[0])) - pad,
        maxE: Math.max(...corners.map(c => c[0])) + pad,
        minN: Math.min(...corners.map(c => c[1])) - pad,
        maxN: Math.max(...corners.map(c => c[1])) + pad
    };
}

/* Slider scale: zoom 20 = 10 cm, 19 = 20 cm, 18 = 40 cm ... */
function swissTargetResolution() {
    return 0.1 * Math.pow(2, 20 - SWISSIMAGE_RGB.zoom);
}

/* ============================================================
   WMTS IN LV95 (no reprojection)
   ============================================================ */

const SWISS_WMTS = {
    capabilitiesUrl: "https://wmts.geo.admin.ch/EPSG/2056/1.0.0/WMTSCapabilities.xml",
    capabilities: null   // Promise -> { layers: Map, matrixSets: Map }
};

const SWISS_WMTS_MAX_SIDE = 8192;   // canvas side limit (px)

function wmtsChildren(node, name) {
    return Array.from(node.children).filter(child => child.localName === name);
}

function wmtsChildText(node, name) {
    const child = wmtsChildren(node, name)[0];
    return child ? child.textContent.trim() : "";
}

async function loadWmtsCapabilities() {
    if (!SWISS_WMTS.capabilities) {
        SWISS_WMTS.capabilities = (async () => {
            const response = await fetch(SWISS_WMTS.capabilitiesUrl);

            if (!response.ok) {
                throw new Error(`WMTS capabilities failed (${response.status})`);
            }

            const xml = new DOMParser().parseFromString(await response.text(), "application/xml");
            const contents = xml.getElementsByTagNameNS("*", "Contents")[0];

            if (!contents) {
                throw new Error("WMTS capabilities could not be read.");
            }

            const matrixSets = new Map();

            for (const set of wmtsChildren(contents, "TileMatrixSet")) {
                const matrices = wmtsChildren(set, "TileMatrix").map(m => {
                    const [left, top] = wmtsChildText(m, "TopLeftCorner").split(/\s+/).map(Number);

                    return {
                        id: wmtsChildText(m, "Identifier"),
                        // OGC standard pixel size: 0.28 mm
                        res: Number(wmtsChildText(m, "ScaleDenominator")) * 0.00028,
                        left,
                        top,
                        tileWidth: Number(wmtsChildText(m, "TileWidth")) || 256,
                        tileHeight: Number(wmtsChildText(m, "TileHeight")) || 256,
                        cols: Number(wmtsChildText(m, "MatrixWidth")),
                        rows: Number(wmtsChildText(m, "MatrixHeight"))
                    };
                });

                matrixSets.set(wmtsChildText(set, "Identifier"), matrices);
            }

            const layers = new Map();

            for (const layer of wmtsChildren(contents, "Layer")) {
                const id = wmtsChildText(layer, "Identifier");
                const dimension = wmtsChildren(layer, "Dimension")
                    .find(d => wmtsChildText(d, "Identifier") === "Time");
                const resource = wmtsChildren(layer, "ResourceURL")[0];
                const link = wmtsChildren(layer, "TileMatrixSetLink")[0];

                layers.set(id, {
                    id,
                    title: wmtsChildText(layer, "Title"),
                    times: dimension ? wmtsChildren(dimension, "Value").map(v => v.textContent.trim()) : [],
                    defaultTime: dimension ? wmtsChildText(dimension, "Default") : "current",
                    template: resource?.getAttribute("template") || "",
                    matrixSet: link ? wmtsChildText(link, "TileMatrixSet") : ""
                });
            }

            return { layers, matrixSets };
        })().catch(error => {
            SWISS_WMTS.capabilities = null;
            throw error;
        });
    }

    return SWISS_WMTS.capabilities;
}

/* Layer + available times of a WMTS source (for the time dropdown). */
async function swissWmtsLayerInfo(source) {
    const caps = await loadWmtsCapabilities();
    const layer = (source.layers || []).map(id => caps.layers.get(id)).find(Boolean);

    if (!layer) {
        throw new Error(`Layer ${source.layers?.join(" / ")} not found in the LV95 WMTS.`);
    }

    return { layer, caps };
}

function swissPickTime(source, layer) {
    const times = layer.times;

    if (SWISS_COLOR.time && times.includes(SWISS_COLOR.time)) {
        return SWISS_COLOR.time;
    }

    if (source.preferTime) {
        const match = times.find(t => t.startsWith(source.preferTime));
        if (match) return match;
    }

    return layer.defaultTime || times[0] || "current";
}

function loadTileImage(url, signal) {
    return new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);    // outside coverage etc.
        img.src = url;
        signal?.addEventListener("abort", () => { img.src = ""; resolve(null); });
    });
}

async function prepareWmtsLv95Raster(source) {
    const { layer, caps } = await swissWmtsLayerInfo(source);
    const matrices = caps.matrixSets.get(layer.matrixSet);

    if (!matrices?.length) {
        throw new Error(`Tile matrix set ${layer.matrixSet} missing.`);
    }

    const time = swissPickTime(source, layer);
    const extent = swissTileExtentLV95();
    const target = swissTargetResolution();
    const width = extent.maxE - extent.minE;
    const height = extent.maxN - extent.minN;

    // finest needed level: coarsest one that is still as sharp as requested,
    // limited by the layer's own deepest level and the canvas size
    const sorted = [...matrices].sort((a, b) => b.res - a.res);   // coarse -> fine
    let matrix = sorted[0];

    for (const m of sorted) {
        const side = Math.max(width, height) / m.res + 2 * m.tileWidth;

        if (side > SWISS_WMTS_MAX_SIDE) break;

        matrix = m;

        if (m.res <= target * 1.01) break;
    }

    const tileW = matrix.tileWidth * matrix.res;
    const tileH = matrix.tileHeight * matrix.res;

    const col0 = Math.max(0, Math.floor((extent.minE - matrix.left) / tileW));
    const col1 = Math.min(matrix.cols - 1, Math.floor((extent.maxE - matrix.left) / tileW));
    const row0 = Math.max(0, Math.floor((matrix.top - extent.maxN) / tileH));
    const row1 = Math.min(matrix.rows - 1, Math.floor((matrix.top - extent.minN) / tileH));

    const cols = col1 - col0 + 1;
    const rows = row1 - row0 + 1;
    const canvas = document.createElement("canvas");

    canvas.width = cols * matrix.tileWidth;
    canvas.height = rows * matrix.tileHeight;

    const context = canvas.getContext("2d", { willReadFrequently: true });
    const jobs = [];

    for (let r = row0; r <= row1; r++) {
        for (let c = col0; c <= col1; c++) {
            jobs.push([c, r]);
        }
    }

    let done = 0;
    let failed = 0;

    const urlFor = (c, r) => layer.template
        .replace("{Time}", encodeURIComponent(time))
        .replace("{TileMatrix}", matrix.id)
        .replace("{TileCol}", c)
        .replace("{TileRow}", r);

    showSwissImageProgress(0, jobs.length, `Loading ${source.label}…`);

    async function worker() {
        while (jobs.length) {
            const [c, r] = jobs.shift();
            const img = await loadTileImage(urlFor(c, r));

            if (img) {
                context.drawImage(img, (c - col0) * matrix.tileWidth, (r - row0) * matrix.tileHeight);
            } else {
                failed++;
            }

            done++;
            showSwissImageProgress(done, done + jobs.length, `Loading ${source.label}…`);
        }
    }

    await Promise.all(Array.from({ length: 8 }, worker));

    const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const n = canvas.width * canvas.height;
    const rgb = new Uint8Array(n * 3);
    const nodata = new Uint8Array(n);
    let anyNodata = false;

    for (let i = 0; i < n; i++) {
        rgb[i * 3] = rgba[i * 4];
        rgb[i * 3 + 1] = rgba[i * 4 + 1];
        rgb[i * 3 + 2] = rgba[i * 4 + 2];

        if (rgba[i * 4 + 3] < 128) {
            nodata[i] = 1;
            anyNodata = true;
        }
    }

    canvas.width = canvas.height = 0;
    hideSwissImageProgress();

    return {
        kind: "lv95",
        rgb,
        nodata: anyNodata ? nodata : null,
        width: cols * matrix.tileWidth,
        height: rows * matrix.tileHeight,
        originE: matrix.left + col0 * tileW,
        originN: matrix.top - row0 * tileH,
        resE: matrix.res,
        resN: matrix.res,
        failedTiles: failed,
        fallbackTiles: 0,
        label: `${source.label}${layer.times.length > 1 ? ` (${/^\d{8}$/.test(time) ? time.slice(0, 4) : time})` : ""}`,
        idPart: `${layer.id}@${time}@${matrix.id}`
    };
}

/* ============================================================
   WMS (federal geoportal fallback, cantonal geoportals)
   ============================================================ */

const SWISS_GEOADMIN_WMS = "https://wms.geo.admin.ch/";
const SWISS_WMS_CHUNK = 2048;     // px per request (servers limit the size)

function swissWmsUrl(base, layers, box, width, height) {
    const url = new URL(base);

    const params = {
        SERVICE: "WMS",
        VERSION: "1.3.0",
        REQUEST: "GetMap",
        LAYERS: layers,
        STYLES: "",
        CRS: "EPSG:2056",
        // EPSG:2056 axis order is east, north
        BBOX: [box.minE, box.minN, box.maxE, box.maxN].join(","),
        WIDTH: String(width),
        HEIGHT: String(height),
        FORMAT: "image/png",
        TRANSPARENT: "TRUE"
    };

    for (const [key, value] of Object.entries(params)) {
        // keep parameters the user put into the URL (e.g. a map= path), replace ours
        for (const existing of [...url.searchParams.keys()]) {
            if (existing.toUpperCase() === key) url.searchParams.delete(existing);
        }
        url.searchParams.set(key, value);
    }

    return url.toString();
}

async function prepareWmsRaster(base, layers, label) {
    if (!base || !layers) {
        throw new Error("WMS URL or layer missing.");
    }

    const extent = swissTileExtentLV95();
    // vector maps: 0.5 m is plenty; follow the slider when it asks for less
    const res = Math.max(0.5, swissTargetResolution());
    const width = Math.ceil((extent.maxE - extent.minE) / res);
    const height = Math.ceil((extent.maxN - extent.minN) / res);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });

    const jobs = [];

    for (let y = 0; y < height; y += SWISS_WMS_CHUNK) {
        for (let x = 0; x < width; x += SWISS_WMS_CHUNK) {
            const w = Math.min(SWISS_WMS_CHUNK, width - x);
            const h = Math.min(SWISS_WMS_CHUNK, height - y);

            jobs.push({
                x, y, w, h,
                box: {
                    minE: extent.minE + x * res,
                    maxE: extent.minE + (x + w) * res,
                    maxN: extent.maxN - y * res,
                    minN: extent.maxN - (y + h) * res
                }
            });
        }
    }

    let failed = 0;
    let done = 0;

    showSwissImageProgress(0, jobs.length, `Loading ${label}…`);

    await Promise.all(jobs.map(async job => {
        const img = await loadTileImage(swissWmsUrl(base, layers, job.box, job.w, job.h));

        if (img) {
            context.drawImage(img, job.x, job.y, job.w, job.h);
        } else {
            failed++;
        }

        showSwissImageProgress(++done, jobs.length, `Loading ${label}…`);
    }));

    hideSwissImageProgress();

    if (failed === jobs.length) {
        throw new Error(`${label}: the WMS returned no image (wrong URL/layer, or the server blocks web apps).`);
    }

    let rgba;

    try {
        rgba = context.getImageData(0, 0, width, height).data;
    } catch (error) {
        throw new Error(`${label}: the server does not allow web apps to read its images (CORS).`);
    }

    const n = width * height;
    const rgb = new Uint8Array(n * 3);
    const nodata = new Uint8Array(n);

    for (let i = 0; i < n; i++) {
        rgb[i * 3] = rgba[i * 4];
        rgb[i * 3 + 1] = rgba[i * 4 + 1];
        rgb[i * 3 + 2] = rgba[i * 4 + 2];
        if (rgba[i * 4 + 3] < 128) nodata[i] = 1;
    }

    canvas.width = canvas.height = 0;

    return {
        kind: "lv95",
        rgb,
        nodata,
        width,
        height,
        originE: extent.minE,
        originN: extent.maxN,
        resE: res,
        resN: res,
        failedTiles: failed,
        fallbackTiles: 0,
        label,
        idPart: `wms-${base}-${layers}@${res}`
    };
}

/* A geo.admin.ch layer: tiles if the LV95 WMTS has it, otherwise WMS. */
async function prepareGeoadminRaster() {
    const id = SWISS_COLOR.layerId;
    const label = SWISS_COLOR.layerLabel || id;

    if (!id) {
        throw new Error("No layer chosen - search for a layer first.");
    }

    try {
        const caps = await loadWmtsCapabilities();

        if (caps.layers.has(id)) {
            const raster = await prepareWmtsLv95Raster({ label, layers: [id] });
            raster.label = label;
            return raster;
        }
    } catch (error) {
        console.warn("[colour] WMTS not usable, trying WMS:", error);
    }

    return prepareWmsRaster(SWISS_GEOADMIN_WMS, id, label);
}

/* Search the federal geoportal's layers (e.g. "Gefahren", "Schutzwald"). */
async function swissSearchLayers(text) {
    const url = new URL(CONFIG.SEARCH_URL || "https://api3.geo.admin.ch/rest/services/ech/SearchServer");

    url.searchParams.set("searchText", text);
    url.searchParams.set("type", "layers");
    url.searchParams.set("lang", (navigator.language || "de").slice(0, 2));
    url.searchParams.set("limit", "30");

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Layer search failed (${response.status}).`);
    }

    const data = await response.json();

    return (data.results || [])
        .map(result => ({
            id: result.attrs?.layer || result.attrs?.id || result.id,
            label: String(result.attrs?.label || result.attrs?.title || "").replace(/<[^>]*>/g, "").trim()
        }))
        .filter(item => item.id && String(item.id).startsWith("ch."));
}

/* ============================================================
   swissALTI3D TERRAIN (height above ground)
   ============================================================ */

const SWISS_ALTI = {
    collection: "ch.swisstopo.swissalti3d",
    key: null,
    promise: null,
    data: null,          // { z, width, height, originE, originN, invRes, year, res }
    note: ""
};

async function swissFindAltiHref(tile) {
    const id = typeof swissKmTileId === "function" ? swissKmTileId(tile) : null;
    if (!id || !Array.isArray(tile?.bbox)) return null;

    const [west, south, east, north] = tile.bbox;
    const cx = (west + east) / 2, cy = (south + north) / 2, d = 0.0005;

    const url = new URL(`${CONFIG.STAC_ROOT}/collections/${SWISS_ALTI.collection}/items`);
    url.searchParams.set("bbox", [cx - d, cy - d, cx + d, cy + d].join(","));
    url.searchParams.set("limit", "100");

    const response = await fetch(url);
    if (!response.ok) throw new Error(`swissALTI3D STAC request failed (${response.status})`);

    const data = await response.json();
    const lidarYear = typeof swissItemYear === "function" ? swissItemYear(tile) : NaN;
    let best = null;

    for (const item of data.features || []) {
        if (!String(item.id || "").includes(id)) continue;

        const year = typeof swissItemYear === "function" ? swissItemYear(item) : NaN;

        for (const asset of Object.values(item.assets || {})) {
            const href = asset?.href || "";
            if (!/\.tiff?($|\?)/i.test(href)) continue;

            const gsd = Number(asset["gsd"] ?? asset["eo:gsd"]) || (/_0\.5_/.test(href) ? 0.5 : /_2_/.test(href) ? 2 : 9);
            const dYear = Number.isFinite(lidarYear) && Number.isFinite(year) ? Math.abs(year - lidarYear) : 0;
            // finest model, closest to the LiDAR year (newer on a tie)
            const rank = gsd * 100 + dYear - (Number.isFinite(year) ? year / 1e5 : 0);

            if (!best || rank < best.rank) best = { href, year, gsd, rank };
        }
    }

    return best;
}

/* Load the terrain of the current tile (once per tile; never throws). */
function swissEnsureAlti() {
    const key = currentTile ? tileKey(currentTile, 0) : "";

    if (SWISS_ALTI.key === key && SWISS_ALTI.promise) {
        return SWISS_ALTI.promise;
    }

    SWISS_ALTI.key = key;
    SWISS_ALTI.data = null;
    SWISS_ALTI.note = "";

    SWISS_ALTI.promise = (async () => {
        try {
            if (typeof GeoTIFF === "undefined") throw new Error("geotiff.js is not loaded");

            const found = await swissFindAltiHref(currentTile);
            if (!found) throw new Error("no swissALTI3D tile found");

            setStatus(`Loading swissALTI3D ${found.year} terrain…`);

            const tiff = await GeoTIFF.fromUrl(found.href);
            const image = await tiff.getImage(0);
            const [left, , right, top] = image.getBoundingBox();
            const width = image.getWidth();
            const height = image.getHeight();
            const raster = await image.readRasters({ samples: [0], interleave: true });
            const noValue = image.getGDALNoData();

            const z = raster instanceof Float32Array ? raster : Float32Array.from(raster);

            if (noValue !== null && noValue !== undefined) {
                for (let i = 0; i < z.length; i++) {
                    if (z[i] === noValue) z[i] = NaN;
                }
            }

            if (SWISS_ALTI.key !== key) return;   // tile changed meanwhile

            const res = (right - left) / width;

            SWISS_ALTI.data = {
                z, width, height,
                originE: left,
                originN: top,
                invRes: 1 / res,
                res,
                year: found.year
            };
            SWISS_ALTI.note = `swissALTI3D ${found.year} (${res} m)`;
            console.info(`[colour] terrain: ${SWISS_ALTI.note}`);
        } catch (error) {
            SWISS_ALTI.note = `swissALTI3D unavailable (${error.message}) - using LiDAR ground points`;
            console.warn("[colour]", SWISS_ALTI.note);
        }
    })();

    return SWISS_ALTI.promise;
}

/* ============================================================
   OWN FILE: GeoTIFF, or TIFF + TFW world file
   ============================================================ */

/* Called by ui.js with the picked files. Reads only the header. */
async function swissSetLocalFiles(files) {
    const list = Array.from(files || []);
    const tif = list.find(f => /\.tiff?$/i.test(f.name));
    const tfw = list.find(f => /\.(tfw|tifw|tiffw|wld)$/i.test(f.name));

    if (!tif) {
        throw new Error("Please choose a .tif file (and its .tfw if it has one).");
    }

    const tiff = await GeoTIFF.fromBlob(tif);
    const image = await tiff.getImage(0);

    SWISS_LOCAL.tif = tif;
    SWISS_LOCAL.tfw = tfw || null;
    SWISS_LOCAL.info = {
        name: tif.name,
        bands: image.getSamplesPerPixel(),
        bitsPerSample: image.getBitsPerSample(),
        width: image.getWidth(),
        height: image.getHeight()
    };

    const bands = SWISS_LOCAL.info.bands;
    SWISS_LOCAL.bands = bands >= 3 ? [0, 1, 2] : [0, 0, 0];
    SWISS_LOCAL.stretch = SWISS_LOCAL.info.bitsPerSample > 8;
    SWISS_LOCAL.version++;

    return SWISS_LOCAL.info;
}

async function swissLocalGeoreference(image) {
    let left, top, resE, resN;

    if (SWISS_LOCAL.tfw) {
        // A, D, B, E, C, F: pixel size x, rotations, pixel size y (negative),
        // centre of the upper-left pixel
        const values = (await SWISS_LOCAL.tfw.text()).trim().split(/\s+/).map(Number);

        if (values.length < 6 || values.some(v => !Number.isFinite(v))) {
            throw new Error("The world file (.tfw) could not be read.");
        }

        const [a, d, b, e, c, f] = values;

        if (Math.abs(d) > 1e-9 || Math.abs(b) > 1e-9) {
            throw new Error("Rotated world files are not supported.");
        }

        resE = a;
        resN = -e;
        left = c - a / 2;
        top = f - e / 2;
    } else {
        let box;

        try {
            box = image.getBoundingBox();
        } catch (error) {
            throw new Error("The file has no georeference - add its .tfw world file.");
        }

        resE = (box[2] - box[0]) / image.getWidth();
        resN = (box[3] - box[1]) / image.getHeight();
        left = box[0];
        top = box[3];
    }

    // LV03 (e.g. Dufour map delivered in CH1903): shift to LV95.
    // Accurate to about 1-2 m (the exact FINELTRA transformation is not applied).
    let note = "";

    if (left < 1000000 && top < 1000000) {
        left += 2000000;
        top += 1000000;
        note = " (LV03 shifted to LV95, ±2 m)";
    }

    return { left, top, resE, resN, note };
}

/* 2-98 % stretch of one band to 8 bit. */
function swissStretchBand(values, n, stretch, nodataValue) {
    const out = new Uint8Array(n);

    if (!stretch) {
        for (let i = 0; i < n; i++) {
            const v = values[i];
            out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
        return out;
    }

    const step = Math.max(1, Math.floor(n / 200000));
    const sample = [];

    for (let i = 0; i < n; i += step) {
        const v = values[i];
        if (v !== nodataValue && v === v) sample.push(v);
    }

    sample.sort((a, b) => a - b);

    const lo = sample.length ? sample[Math.floor(sample.length * 0.02)] : 0;
    const hi = sample.length ? sample[Math.floor(sample.length * 0.98)] : 1;
    const scale = 255 / Math.max(1e-9, hi - lo);

    for (let i = 0; i < n; i++) {
        const v = (values[i] - lo) * scale;
        out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }

    return out;
}

async function prepareLocalRaster() {
    if (!SWISS_LOCAL.tif) {
        throw new Error("No file chosen - pick a GeoTIFF (or TIFF + TFW) first.");
    }

    showSwissImageProgress(0, 1, `Reading ${SWISS_LOCAL.tif.name}…`);

    try {
        const tiff = await GeoTIFF.fromBlob(SWISS_LOCAL.tif);
        const image = await tiff.getImage(0);
        const geo = await swissLocalGeoreference(image);
        const extent = swissTileExtentLV95();

        const fullW = image.getWidth();
        const fullH = image.getHeight();

        // part of the file that covers the LiDAR tile
        const x0 = Math.max(0, Math.floor((extent.minE - geo.left) / geo.resE));
        const x1 = Math.min(fullW, Math.ceil((extent.maxE - geo.left) / geo.resE));
        const y0 = Math.max(0, Math.floor((geo.top - extent.maxN) / geo.resN));
        const y1 = Math.min(fullH, Math.ceil((geo.top - extent.minN) / geo.resN));

        if (x1 <= x0 || y1 <= y0) {
            throw new Error(`${SWISS_LOCAL.tif.name} does not cover this LiDAR tile.`);
        }

        // read at the slider resolution (never finer than the file)
        const scale = Math.max(1, swissTargetResolution() / geo.resE);
        let outW = Math.max(1, Math.round((x1 - x0) / scale));
        let outH = Math.max(1, Math.round((y1 - y0) / scale));

        const maxPixels = SWISSIMAGE_MAX_RASTER_PIXELS / 2;

        if (outW * outH > maxPixels) {
            const f = Math.sqrt(maxPixels / (outW * outH));
            outW = Math.floor(outW * f);
            outH = Math.floor(outH * f);
        }

        const n = outW * outH;
        const bandCount = image.getSamplesPerPixel();
        const photometric = image.fileDirectory?.PhotometricInterpretation;
        let rgb;
        let nodata = null;

        if (photometric === 6 && bandCount >= 3) {
            // JPEG/YCbCr: let geotiff.js convert to RGB
            rgb = await image.readRGB({ window: [x0, y0, x1, y1], width: outW, height: outH, interleave: true });
        } else {
            const wanted = SWISS_LOCAL.bands.map(b => Math.min(b, bandCount - 1));
            const unique = [...new Set(wanted)];

            const data = await image.readRasters({
                window: [x0, y0, x1, y1],
                width: outW,
                height: outH,
                samples: unique,
                interleave: false
            });

            const noValue = image.getGDALNoData();
            const stretched = new Map(unique.map((b, i) => [
                b,
                swissStretchBand(data[i], n, SWISS_LOCAL.stretch, noValue)
            ]));

            rgb = new Uint8Array(n * 3);

            const [r, g, b] = wanted.map(index => stretched.get(index));

            for (let i = 0; i < n; i++) {
                rgb[i * 3] = r[i];
                rgb[i * 3 + 1] = g[i];
                rgb[i * 3 + 2] = b[i];
            }

            if (noValue !== null && noValue !== undefined) {
                nodata = new Uint8Array(n);
                const first = data[0];

                for (let i = 0; i < n; i++) {
                    if (first[i] === noValue) nodata[i] = 1;
                }
            }
        }

        if (!(rgb instanceof Uint8Array)) {
            rgb = Uint8Array.from(rgb);
        }

        const resE = ((x1 - x0) * geo.resE) / outW;
        const resN = ((y1 - y0) * geo.resN) / outH;

        return {
            kind: "lv95",
            rgb,
            nodata,
            width: outW,
            height: outH,
            originE: geo.left + x0 * geo.resE,
            originN: geo.top - y0 * geo.resN,
            resE,
            resN,
            failedTiles: 0,
            fallbackTiles: 0,
            label: `${SWISS_LOCAL.tif.name}${geo.note}`,
            idPart: `local-${SWISS_LOCAL.version}-${SWISS_LOCAL.bands.join("")}-${SWISS_LOCAL.stretch ? 1 : 0}@${resE}`
        };
    } finally {
        hideSwissImageProgress();
    }
}

/* Entry point used by prepareSwissImageRaster() for non-SWISSIMAGE sources. */
async function prepareOtherSourceRaster() {
    const source = swissSource();

    if (source.type === "local" && typeof GeoTIFF === "undefined") {
        throw new Error("geotiff.js is not loaded.");
    }

    SWISSIMAGE_RGB.loading = true;

    try {
        setStatus(`Loading ${source.label}…`);

        const raster =
            source.type === "local" ? await prepareLocalRaster() :
            source.type === "geoadmin" ? await prepareGeoadminRaster() :
            source.type === "wms" ? await prepareWmsRaster(SWISS_COLOR.wmsUrl, SWISS_COLOR.wmsLayer, SWISS_COLOR.wmsLayer) :
            await prepareWmtsLv95Raster(source);

        const key = tileKey(currentTile, 0);

        raster.tileKey = key;
        raster.requestedZoom = SWISSIMAGE_RGB.zoom;
        raster.z = SWISSIMAGE_RGB.zoom;
        raster.sourceKey = swissSourceKey();
        raster.id = `${key}@${raster.idPart}`;

        SWISSIMAGE_RGB.raster = raster;

        setStatus(
            `${raster.label} ready: ${raster.width.toLocaleString()} × ${raster.height.toLocaleString()} px, ` +
            `${Math.round(raster.resE * 100)} cm/px` +
            (raster.failedTiles ? `, ${raster.failedTiles} tile(s) without data` : "") +
            "."
        );
    } finally {
        SWISSIMAGE_RGB.loading = false;
    }
}

/* ============================================================
   GROUND AND TOP-SURFACE GRIDS
   ============================================================ */

/*
 * ground: lowest ground/water point per 2 m cell, gaps (under buildings)
 *         filled from the nearest ground cell -> height above ground
 * top:    highest point per 1 m cell -> what is visible from above
 */
const SWISS_GROUND_CELL = 2;
const SWISS_TOP_CELL = 0.5;          // fine enough that steep spires are not "walls"
const SWISS_ROOF_CELL = 1;           // building tops, for the lean estimate
const SWISS_OCCLUSION_DEPTH = 3;

// ASPRS classes
const SWISS_CLASS_GROUND = new Uint8Array(256);
[2, 9, 11].forEach(c => { SWISS_CLASS_GROUND[c] = 1; });

const SWISS_CLASS_OCCLUDABLE = new Uint8Array(256);   // walls of these can be hidden
[6, 17].forEach(c => { SWISS_CLASS_OCCLUDABLE[c] = 1; });

const SWISS_CLASS_NOISE = new Uint8Array(256);
[7, 18].forEach(c => { SWISS_CLASS_NOISE[c] = 1; });

const SWISS_WALL = [190, 186, 180];
const SWISS_NODATA = [150, 150, 150];

let swissGrids = null;

function getSwissGrids(mapper) {
    const key = currentTile ? tileKey(currentTile, 0) : "";

    if (swissGrids && swissGrids.key === key) {
        return swissGrids;
    }

    const make = cell => {
        const nx = Math.max(1, Math.ceil((mapper.maxE - mapper.minE) / cell));
        const ny = Math.max(1, Math.ceil((mapper.maxN - mapper.minN) / cell));
        return { cell, nx, ny, minE: mapper.minE, minN: mapper.minN, raw: new Float32Array(nx * ny).fill(NaN) };
    };

    swissGrids = {
        key,
        ground: Object.assign(make(SWISS_GROUND_CELL), { filled: null, dirty: false, filledAt: 0 }),
        top: make(SWISS_TOP_CELL),
        roof: make(SWISS_ROOF_CELL),
        hasClasses: false,
        fed: new WeakSet()     // geometries / datasets already added
    };

    return swissGrids;
}

function swissGridIndex(grid, e, n) {
    const i = Math.floor((e - grid.minE) / grid.cell);
    const j = Math.floor((n - grid.minN) / grid.cell);
    return (i < 0 || j < 0 || i >= grid.nx || j >= grid.ny) ? -1 : j * grid.nx + i;
}

function swissGridsAdd(grids, e, n, z, cls) {
    if (cls >= 0 && SWISS_CLASS_NOISE[cls]) {
        return;
    }

    const t = swissGridIndex(grids.top, e, n);

    if (t >= 0 && !(grids.top.raw[t] >= z)) {
        grids.top.raw[t] = z;
    }

    if (cls === 6) {
        const r = swissGridIndex(grids.roof, e, n);

        if (r >= 0 && !(grids.roof.raw[r] >= z)) {
            grids.roof.raw[r] = z;
        }
    }

    if (cls >= 0 && SWISS_CLASS_GROUND[cls]) {
        const g = swissGridIndex(grids.ground, e, n);
        const ground = grids.ground;

        if (g >= 0 && !(ground.raw[g] <= z)) {
            ground.raw[g] = z;
            ground.dirty = true;
        }
    }
}

/* Nearest-ground fill of empty cells (two-pass chamfer propagation). */
function swissGroundFill(ground) {
    const { nx, ny, raw } = ground;
    const n = nx * ny;
    const val = new Float32Array(n);
    const dist = new Float32Array(n);
    const D = Math.SQRT2;
    let any = false;

    for (let k = 0; k < n; k++) {
        if (raw[k] === raw[k]) { val[k] = raw[k]; dist[k] = 0; any = true; }
        else dist[k] = Infinity;
    }

    ground.dirty = false;
    ground.filledAt = performance.now();

    if (!any) { ground.filled = null; return; }

    const relax = (k, m, w) => {
        const d = dist[m] + w;
        if (d < dist[k]) { dist[k] = d; val[k] = val[m]; }
    };

    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const k = j * nx + i;
            if (dist[k] === 0) continue;
            if (i > 0) relax(k, k - 1, 1);
            if (j > 0) {
                relax(k, k - nx, 1);
                if (i > 0) relax(k, k - nx - 1, D);
                if (i < nx - 1) relax(k, k - nx + 1, D);
            }
        }
    }

    for (let j = ny - 1; j >= 0; j--) {
        for (let i = nx - 1; i >= 0; i--) {
            const k = j * nx + i;
            if (dist[k] === 0) continue;
            if (i < nx - 1) relax(k, k + 1, 1);
            if (j < ny - 1) {
                relax(k, k + nx, 1);
                if (i < nx - 1) relax(k, k + nx + 1, D);
                if (i > 0) relax(k, k + nx - 1, D);
            }
        }
    }

    ground.filled = val;
}

function swissGroundRefresh(grids, force = false) {
    const ground = grids.ground;

    if (!ground.dirty && ground.filled) return;

    if (force || !ground.filled || performance.now() - ground.filledAt > 500) {
        swissGroundFill(ground);
    }
}

function swissGroundZ(grids, e, n) {
    // swissALTI3D: the terrain model the orthophotos are rectified on
    const alti = SWISS_ALTI.data;

    if (alti && SWISS_ALTI.key === grids.key) {
        const i = Math.floor((e - alti.originE) * alti.invRes);
        const j = Math.floor((alti.originN - n) * alti.invRes);

        if (i >= 0 && j >= 0 && i < alti.width && j < alti.height) {
            const z = alti.z[j * alti.width + i];
            if (z === z) return z;
        }
    }

    // fallback: LiDAR ground points
    const ground = grids.ground;
    const k = swissGridIndex(ground, e, n);

    if (k < 0) return NaN;

    const z = ground.raw[k];
    return z === z ? z : ground.filled ? ground.filled[k] : NaN;
}

/* Add a Potree node (e = node-local -> LV95 matrix). */
function swissGridsFeedGeometry(grids, geometry, e) {
    if (grids.fed.has(geometry)) return;
    grids.fed.add(geometry);

    const position = geometry.attributes.position;
    const cls = geometry.attributes.classification?.array || null;
    const arr = position.array;
    const size = position.itemSize || 3;

    if (cls) grids.hasClasses = true;

    for (let i = 0; i < position.count; i++) {
        const j = i * size;
        const x = arr[j], y = arr[j + 1], z = size >= 3 ? arr[j + 2] : 0;

        swissGridsAdd(
            grids,
            e[0] * x + e[4] * y + e[8] * z + e[12],
            e[1] * x + e[5] * y + e[9] * z + e[13],
            e[2] * x + e[6] * y + e[10] * z + e[14],
            cls ? cls[i] : -1
        );
    }
}

/* ============================================================
   PER-POINT COLOUR
   ============================================================ */

function swissColorContext(raster, mapper) {
    const grids = getSwissGrids(mapper);
    const field = SWISS_COLOR.leanAuto && raster.leanEstimate?.ok ? raster.leanEstimate : null;
    const lean = !!field || (!SWISS_COLOR.leanAuto && (SWISS_COLOR.leanX !== 0 || SWISS_COLOR.leanY !== 0));

    if (lean) swissGroundRefresh(grids);

    const ctx = {
        raster,
        grids,
        rgb: raster.rgb,
        nodata: raster.nodata || null,
        width: raster.width,
        height: raster.height,
        occlusion: SWISS_COLOR.occlusion,
        lean,
        field,
        leanX: SWISS_COLOR.leanX,
        leanY: SWISS_COLOR.leanY,
        direct: !!mapper.direct
    };

    if (ctx.direct) {
        ctx.originE = raster.originE;
        ctx.originN = raster.originN;
        ctx.invResE = 1 / raster.resE;
        ctx.invResN = 1 / raster.resN;
    } else {
        // WMTS Web Mercator fallback (see getSwissMapper in app.js)
        ctx.N = mapper.N;
        ctx.gx = mapper.gx;
        ctx.gy = mapper.gy;
        ctx.minE = mapper.minE;
        ctx.minN = mapper.minN;
        ctx.invE = mapper.N / (mapper.maxE - mapper.minE);
        ctx.invN = mapper.N / (mapper.maxN - mapper.minN);
        ctx.stride = mapper.N + 1;
        ctx.worldMinX = raster.worldMinX;
        ctx.worldMaxY = raster.worldMaxY;
        ctx.scaleX = raster.width / (raster.worldMaxX - raster.worldMinX);
        ctx.scaleY = raster.height / (raster.worldMaxY - raster.worldMinY);
    }

    return ctx;
}

function swissPut(out, o, c) {
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2];
}

/*
 * Colour of one point (LV95 e/n/z, ASPRS class or -1) into out[o..o+2].
 * Returns 1 if the point falls outside the raster.
 */
function swissColorPoint(ctx, e, n, z, cls, out, o) {
    // walls: not visible from above
    if (cls >= 0 && ctx.occlusion && SWISS_CLASS_OCCLUDABLE[cls]) {
        const t = swissGridIndex(ctx.grids.top, e, n);

        if (t >= 0 && ctx.grids.top.raw[t] - z > SWISS_OCCLUSION_DEPTH) {
            swissPut(out, o, SWISS_WALL);
            return 0;
        }
    }

    // relief displacement of tall objects
    if (ctx.lean) {
        const gz = swissGroundZ(ctx.grids, e, n);

        if (gz === gz && z > gz) {
            const h = z - gz;

            if (ctx.field) {
                swissLeanAt(ctx.field, e, n, SWISS_LEAN_TMP);
                e += SWISS_LEAN_TMP[0] * h;
                n += SWISS_LEAN_TMP[1] * h;
            } else {
                e += ctx.leanX * h;
                n += ctx.leanY * h;
            }
        }
    }

    let ix, iy;

    if (ctx.direct) {
        ix = Math.floor((e - ctx.originE) * ctx.invResE);
        iy = Math.floor((ctx.originN - n) * ctx.invResN);
    } else {
        const N = ctx.N;
        let u = (e - ctx.minE) * ctx.invE;
        let v = (n - ctx.minN) * ctx.invN;

        if (u < 0) u = 0; else if (u > N - 1e-9) u = N - 1e-9;
        if (v < 0) v = 0; else if (v > N - 1e-9) v = N - 1e-9;

        const gi = Math.floor(u), gj = Math.floor(v);
        const fu = u - gi, fv = v - gj;
        const k = gj * ctx.stride + gi, s = ctx.stride;
        const gx = ctx.gx, gy = ctx.gy;

        const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv);
        const w01 = (1 - fu) * fv, w11 = fu * fv;

        const mx = gx[k] * w00 + gx[k + 1] * w10 + gx[k + s] * w01 + gx[k + s + 1] * w11;
        const my = gy[k] * w00 + gy[k + 1] * w10 + gy[k + s] * w01 + gy[k + s + 1] * w11;

        ix = Math.floor((mx - ctx.worldMinX) * ctx.scaleX);
        iy = Math.floor((ctx.worldMaxY - my) * ctx.scaleY);
    }

    if (ix < 0 || iy < 0 || ix >= ctx.width || iy >= ctx.height) {
        out[o] = out[o + 1] = out[o + 2] = 128;
        return 1;
    }

    const p = iy * ctx.width + ix;

    if (ctx.nodata && ctx.nodata[p]) {
        swissPut(out, o, SWISS_NODATA);
        return 0;
    }

    out[o] = ctx.rgb[p * 3];
    out[o + 1] = ctx.rgb[p * 3 + 1];
    out[o + 2] = ctx.rgb[p * 3 + 2];
    return 0;
}

/* ============================================================
   AUTOMATIC LEAN ESTIMATE
   ============================================================ */

/*
 * Roof edges of the LiDAR (building cells more than 6 m above ground next
 * to a cell at least 3 m lower) are moved over the image by lean * height.
 * At the right lean, the image shows a strong brightness step across every
 * edge (roof inside, ground outside). The lean with the largest mean step
 * wins - first for the whole tile, then refined per 250 m block, because
 * the displacement grows with the distance from the camera's flight line.
 */
const SWISS_LEAN_BLOCK = 250;
const SWISS_LEAN_TMP = [0, 0];

/*
 * Compact luminance copy (at most 25 cm/px, 1 byte per pixel): the search
 * reads it millions of times at random places, which is far faster in a
 * small array than in the full RGB raster.
 */
function swissImageDescriptor(raster) {
    if (raster.kind !== "lv95") return null;

    const f = Math.max(1, Math.floor(0.25 / raster.resE));
    const width = Math.floor(raster.width / f);
    const height = Math.floor(raster.height / f);
    const lum = new Uint8Array(width * height);
    const rgb = raster.rgb;
    const half = f >> 1;

    for (let j = 0; j < height; j++) {
        const row = (j * f + half) * raster.width;

        for (let i = 0; i < width; i++) {
            const p = (row + i * f + half) * 3;
            lum[j * width + i] = (77 * rgb[p] + 150 * rgb[p + 1] + 29 * rgb[p + 2]) >> 8;
        }
    }

    return {
        lum,
        width,
        height,
        originE: raster.originE,
        originN: raster.originN,
        invE: 1 / (raster.resE * f),
        invN: 1 / (raster.resN * f)
    };
}

function swissRoofEdges(grids) {
    const roof = grids.roof, top = grids.top;
    const { nx, ny, cell, minE, minN, raw } = roof;
    const E = [], N = [], DX = [], DY = [], H = [];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    for (let j = 1; j < ny - 1; j++) {
        for (let i = 1; i < nx - 1; i++) {
            const z = raw[j * nx + i];
            if (!(z === z)) continue;

            const e = minE + (i + 0.5) * cell;
            const n = minN + (j + 0.5) * cell;
            const gz = swissGroundZ(grids, e, n);
            if (!(z - gz > 6)) continue;

            for (const [di, dj] of dirs) {
                const zn = raw[(j + dj) * nx + i + di];
                if (zn === zn && z - zn < 3) continue;          // still roof

                // the neighbour must be known and clearly lower
                const t = swissGridIndex(top, e + di * cell, n + dj * cell);
                if (t < 0) continue;

                const zt = top.raw[t];
                if (!(zt === zt) || z - zt < 3) continue;

                E.push(e); N.push(n); DX.push(di); DY.push(dj); H.push(z - gz);
            }
        }
    }

    return { E, N, DX, DY, H, count: E.length };
}

/*
 * Mean brightness step across the given roof edges for one lean.
 * Inlined pixel lookups: this runs a few million times per estimate.
 */
function swissLeanScore(img, edges, idx, lx, ly) {
    const { lum, width, height, originE, originN, invE, invN } = img;
    const E = edges.E, N = edges.N, DX = edges.DX, DY = edges.DY, H = edges.H;
    let sum = 0, used = 0;

    for (let m = 0; m < idx.length; m++) {
        const k = idx[m];
        const h = H[k];
        const e = E[k] + lx * h;
        const n = N[k] + ly * h;

        const ia = Math.floor((e - 0.25 * DX[k] - originE) * invE);
        const ja = Math.floor((originN - n + 0.25 * DY[k]) * invN);
        const ib = Math.floor((e + 0.9 * DX[k] - originE) * invE);
        const jb = Math.floor((originN - n - 0.9 * DY[k]) * invN);

        if (ia < 0 || ja < 0 || ib < 0 || jb < 0 ||
            ia >= width || ib >= width || ja >= height || jb >= height) continue;

        const d = lum[ja * width + ia] - lum[jb * width + ib];

        sum += d < 0 ? -d : d;
        used++;
    }

    return used ? sum / used : 0;
}

function swissLeanSearch(img, edges, idx, cx, cy, range, step) {
    let best = { lx: cx, ly: cy, score: -1 };

    for (let lx = cx - range; lx <= cx + range + 1e-9; lx += step) {
        for (let ly = cy - range; ly <= cy + range + 1e-9; ly += step) {
            const score = swissLeanScore(img, edges, idx, lx, ly);
            if (score > best.score) best = { lx, ly, score };
        }
    }

    return best;
}

/* Coarse-to-fine search: 5 cm, 1 cm, 2.5 mm per metre of height. */
function swissLeanSearchMulti(img, edges, idx, cx, cy, range) {
    let best = swissLeanSearch(img, edges, swissSubsample(idx, 1500), cx, cy, range, Math.max(0.02, range / 10));
    best = swissLeanSearch(img, edges, swissSubsample(idx, 4000), best.lx, best.ly, 0.05, 0.01);
    best = swissLeanSearch(img, edges, swissSubsample(idx, 8000), best.lx, best.ly, 0.01, 0.0025);
    return best;
}

function swissSubsample(indices, max) {
    if (indices.length <= max) return indices;
    const step = indices.length / max;
    return Array.from({ length: max }, (_, i) => indices[Math.floor(i * step)]);
}

let swissLeanCounter = 0;

function swissEstimateLean(raster, mapper) {
    const img = swissImageDescriptor(raster);
    const grids = getSwissGrids(mapper);

    swissGroundRefresh(grids, true);

    const fail = reason => ({ ok: false, id: `none-${++swissLeanCounter}`, reason });

    if (!img) return fail("only possible with LV95 rasters");

    const edges = swissRoofEdges(grids);

    if (edges.count < 80) {
        return fail(`too few tall roof edges (${edges.count})`);
    }

    const all = Array.from({ length: edges.count }, (_, i) => i);

    // whole tile: up to 5 m per 10 m of height in any direction
    const fine = swissLeanSearchMulti(img, edges, all, 0, 0, 0.5);
    const zero = swissLeanScore(img, edges, swissSubsample(all, 10000), 0, 0);

    // no clear improvement over "no correction": do not guess
    if (fine.score < zero * 1.03) {
        return fail("no clear displacement found");
    }

    // per 250 m block, around the tile value
    const bx = Math.max(1, Math.ceil((mapper.maxE - mapper.minE) / SWISS_LEAN_BLOCK));
    const by = Math.max(1, Math.ceil((mapper.maxN - mapper.minN) / SWISS_LEAN_BLOCK));
    const lx = new Float32Array(bx * by).fill(fine.lx);
    const ly = new Float32Array(bx * by).fill(fine.ly);
    const blocks = Array.from({ length: bx * by }, () => []);

    for (let k = 0; k < edges.count; k++) {
        const i = Math.min(bx - 1, Math.max(0, Math.floor((edges.E[k] - mapper.minE) / SWISS_LEAN_BLOCK)));
        const j = Math.min(by - 1, Math.max(0, Math.floor((edges.N[k] - mapper.minN) / SWISS_LEAN_BLOCK)));
        blocks[j * bx + i].push(k);
    }

    let refined = 0;

    blocks.forEach((idx, b) => {
        if (idx.length < 150) return;

        const sub = swissSubsample(idx, 3000);
        const local = swissLeanSearchMulti(img, edges, sub, fine.lx, fine.ly, 0.1);
        const atTile = swissLeanScore(img, edges, sub, fine.lx, fine.ly);

        if (local.score > atTile * 1.03) {
            lx[b] = local.lx;
            ly[b] = local.ly;
            refined++;
        }
    });

    return {
        ok: true,
        id: `est-${++swissLeanCounter}`,
        lx: fine.lx,
        ly: fine.ly,
        gain: fine.score / Math.max(1e-9, zero),
        edges: edges.count,
        refined,
        field: { minE: mapper.minE, minN: mapper.minN, size: SWISS_LEAN_BLOCK, nx: bx, ny: by, lx, ly }
    };
}

/* Bilinear lean between block centres. */
function swissLeanAt(estimate, e, n, out) {
    const f = estimate.field;
    let u = (e - f.minE) / f.size - 0.5;
    let v = (n - f.minN) / f.size - 0.5;

    u = u < 0 ? 0 : u > f.nx - 1 ? f.nx - 1 : u;
    v = v < 0 ? 0 : v > f.ny - 1 ? f.ny - 1 : v;

    const i = Math.min(f.nx - 2, Math.floor(u)), j = Math.min(f.ny - 2, Math.floor(v));

    if (f.nx < 2 || f.ny < 2) {
        const k = Math.round(v) * f.nx + Math.round(u);
        out[0] = f.lx[k]; out[1] = f.ly[k];
        return out;
    }

    const fu = u - i, fv = v - j;
    const k = j * f.nx + i;
    const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;

    out[0] = f.lx[k] * w00 + f.lx[k + 1] * w10 + f.lx[k + f.nx] * w01 + f.lx[k + f.nx + 1] * w11;
    out[1] = f.ly[k] * w00 + f.ly[k + 1] * w10 + f.ly[k + f.nx] * w01 + f.ly[k + f.nx + 1] * w11;
    return out;
}

/* Run the estimate for the current raster (COPC: after the grids were fed). */
function swissUpdateLeanEstimate(raster, mapper) {
    if (!SWISS_COLOR.leanAuto) return;

    const t0 = performance.now();
    raster.leanEstimate = swissEstimateLean(raster, mapper);
    const ms = Math.round(performance.now() - t0);
    const est = raster.leanEstimate;

    const text = est.ok
        ? `Tower lean estimated from ${est.edges.toLocaleString()} roof edges: ` +
          `${(est.lx * 10).toFixed(2)} m east, ${(est.ly * 10).toFixed(2)} m north per 10 m of height` +
          (est.refined ? ` (refined in ${est.refined} block(s))` : "") +
          (SWISS_ALTI.note ? `; terrain: ${SWISS_ALTI.note}` : "") + ` [${ms} ms]`
        : `Tower lean not estimated: ${est.reason}.`;

    console.info("[colour]", text);
    window.dispatchEvent(new CustomEvent("swiss-lean-estimate", { detail: { estimate: est, text } }));
}

/* ============================================================
   GROUND-ONLY FILTER (hide all other classes)
   ============================================================ */

function swissApplyGroundFilter() {
    const only = SWISS_COLOR.groundOnly;

    // Potree: classification visibility (works in every colour mode)
    try {
        const scheme = viewer?.classifications;

        if (scheme) {
            for (const key of Object.keys(scheme)) {
                const code = Number(key);
                const visible = !only || (Number.isInteger(code) && SWISS_CLASS_GROUND[code] === 1);

                if (typeof viewer.setClassificationVisibility === "function") {
                    viewer.setClassificationVisibility(key, visible);
                } else if (scheme[key]) {
                    scheme[key].visible = visible;
                }
            }

            for (const pointcloud of viewer.scene?.pointclouds || []) {
                const material = pointcloud.material;
                if (!material) continue;
                material.classification = scheme;
                material.recomputeClassification?.();
                material.needsUpdate = true;
            }
        }
    } catch (error) {
        console.warn("[colour] ground filter (Potree) failed:", error);
    }

    // plain LAZ clouds (laz.js)
    if (currentPointCloud?.isLaz) {
        currentPointCloud.lazSetGroundOnly?.(only);
    }
}

/* ============================================================
   SETTINGS CHANGES (called by ui.js)
   ============================================================ */

function swissRecolour(newRaster) {
    if (newRaster) {
        SWISSIMAGE_RGB.raster = null;
    }

    const raster = SWISSIMAGE_RGB.raster;

    if (raster) {
        raster.treeDone = false;
        raster.announced = false;
        raster.stats = { points: 0, outside: 0 };
    }

    if (!currentPointCloud || getEl("color-mode")?.value !== "swissimage") {
        return;
    }

    if (currentPointCloud.isLaz) {
        void currentPointCloud.lazSetColorMode("swissimage");
    } else {
        startSwissImageProcessing();
    }
}

window.swissColor = {
    sources: SWISS_SOURCES,
    settings: SWISS_COLOR,
    local: SWISS_LOCAL,
    groundClasses: SWISS_CLASS_GROUND,

    /* occlusion or lean changed */
    rulesChanged() {
        swissRecolour(false);
    },

    /* source, time, file or bands changed */
    sourceChanged() {
        swissRecolour(true);
    },

    /* estimate the tower lean again (e.g. after more detail has loaded) */
    estimateLean() {
        const raster = SWISSIMAGE_RGB.raster;
        if (!raster) return;

        raster.leanEstimate = null;
        raster.leanPending = true;
        swissRecolour(false);
    },

    groundOnlyChanged() {
        swissApplyGroundFilter();
    },

    setLocalFiles: swissSetLocalFiles,
    searchLayers: swissSearchLayers,
    terrainNote: () => SWISS_ALTI.note,

    async times(sourceName) {
        const source = SWISS_SOURCES[sourceName];

        if (!source || source.type !== "wmts" || !source.chooseTime) {
            return null;
        }

        const { layer } = await swissWmtsLayerInfo(source);
        return { times: layer.times, defaultTime: layer.defaultTime };
    }
};
