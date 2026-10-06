/*
 * Swiss LiDAR Viewer - full-resolution export
 *
 * Reads every node of the tile's COPC file (independent of what Potree has
 * loaded or the point budget) and writes an uncompressed LAS 1.4 file,
 * point format 7 (XYZ, intensity, returns, classification, GPS time, RGB).
 *
 *  - "Export coloured tile": all points, RGB sampled from SWISSIMAGE
 *  - "Export section":       only points inside the active section box
 *
 * Needs the COPC reader from ./potree/libs/copc/index.js (copc.js, global `Copc`).
 * Uses globals from app.js: currentTile, currentPointCloud, currentSection,
 * SWISSIMAGE_RGB, getCopcUrl, tileKey, prepareSwissImageRaster,
 * showSwissImageProgress, hideSwissImageProgress, yieldToBrowser, setStatus.
 */

(function () {
    "use strict";

    const POINT_FORMAT = 7;
    const POINT_RECORD_LENGTH = 36;
    const HEADER_SIZE = 375;
    const CHUNK_POINTS = 250000;

    const LV95_WKT =
        'PROJCS["CH1903+ / LV95",GEOGCS["CH1903+",DATUM["CH1903+",' +
        'SPHEROID["Bessel 1841",6377397.155,299.1528128],' +
        'TOWGS84[674.374,15.056,405.346,0,0,0,0]],' +
        'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],' +
        'PROJECTION["Hotine_Oblique_Mercator_Azimuth_Center"],' +
        'PARAMETER["latitude_of_center",46.95240555555556],' +
        'PARAMETER["longitude_of_center",7.439583333333333],' +
        'PARAMETER["azimuth",90],PARAMETER["rectified_grid_angle",90],' +
        'PARAMETER["scale_factor",1],PARAMETER["false_easting",2600000],' +
        'PARAMETER["false_northing",1200000],UNIT["metre",1],' +
        'AUTHORITY["EPSG","2056"]]';

    let exporting = false;
    let colourNote = "";
    let abortRequested = false;

    const el = id => document.getElementById(id);

    /* ============================================================
       Buttons
       ============================================================ */

    window.updateExportButtons = function () {
        const tileButton = el("export-tile-button");
        const sectionButton = el("export-section-button");
        const cancelButton = el("export-cancel-button");

        if (!tileButton || !sectionButton) {
            return;
        }

        const hasUrl = !!(currentTile && getCopcUrl(currentTile));

        tileButton.disabled = exporting || !hasUrl;
        sectionButton.disabled = exporting || !hasUrl || !currentSection;

        if (cancelButton) {
            cancelButton.hidden = !exporting;
        }
    };

    function setExportInfo(text) {
        const info = el("export-info");
        if (info) info.textContent = text;
    }

    /* ============================================================
       COPC reader (copc.js)
       ============================================================ */

    function copcLibrary() {
        return window.Copc || window.COPC || window.copc || null;
    }

    let lazPerfPromise = null;

    function getLazPerf() {
        if (lazPerfPromise) {
            return lazPerfPromise;
        }

        const factory =
            window.createLazPerf ||
            window.LazPerf?.create ||
            window.LazPerf?.createLazPerf ||
            (typeof window.LazPerf === "function" ? window.LazPerf : null);

        lazPerfPromise = factory
            ? Promise.resolve(factory())
            : Promise.resolve(null);

        return lazPerfPromise;
    }

    async function openCopc(url) {
        const lib = copcLibrary();

        if (!lib) {
            throw new Error(
                "COPC reader not found (expected global `Copc` from potree/libs/copc/index.js)."
            );
        }

        const api = lib.Copc && typeof lib.Copc.create === "function" ? lib.Copc : lib;

        if (typeof api.create !== "function") {
            throw new Error("The COPC library has no create() function.");
        }

        const copc = await api.create(url);
        const lazPerf = await getLazPerf();

        const loadPage = async page => {
            const hierarchy = lib.Hierarchy || api.Hierarchy;

            if (hierarchy && typeof hierarchy.load === "function") {
                return hierarchy.load(url, page);
            }

            return api.loadHierarchyPage(url, page);
        };

        // Walk the whole hierarchy (root page plus sub-pages).
        const nodes = {};
        const pageQueue = [copc.info.rootHierarchyPage];
        const seenPages = new Set();

        while (pageQueue.length) {
            const page = pageQueue.shift();
            const pageKey = `${page.pageOffset}:${page.pageLength}`;

            if (seenPages.has(pageKey)) continue;
            seenPages.add(pageKey);

            const result = await loadPage(page);

            Object.assign(nodes, result.nodes || {});

            for (const subPage of Object.values(result.pages || {})) {
                if (subPage) pageQueue.push(subPage);
            }
        }

        return {
            copc,
            nodes,
            async loadView(node) {
                return api.loadPointDataView(url, copc, node, lazPerf ? { lazPerf } : {});
            }
        };
    }

    /* "d-x-y-z" -> axis-aligned bounds in the file's coordinates */
    function nodeBounds(key, cube) {
        const [d, x, y, z] = key.split("-").map(Number);
        const size = (cube[3] - cube[0]) / Math.pow(2, d);

        return {
            min: [cube[0] + x * size, cube[1] + y * size, cube[2] + z * size],
            max: [cube[0] + (x + 1) * size, cube[1] + (y + 1) * size, cube[2] + (z + 1) * size]
        };
    }

    /* ============================================================
       Section filter (Potree box volume -> point test)
       ============================================================ */

    /*
     * The viewer's world coordinates equal the file's LV95 coordinates (the
     * SWISSIMAGE sampler in app.js relies on the same assumption). If Potree
     * ever applies a large translation, it is detected here and compensated.
     */
    function detectWorldOffset(cube) {
        try {
            const box = currentPointCloud?.boundingBox?.clone();

            if (!box) return [0, 0, 0];

            if (currentPointCloud.matrixWorld && !currentPointCloud.isLaz) {
                box.applyMatrix4(currentPointCloud.matrixWorld);
            }

            const dx = box.min.x - cube[0];
            const dy = box.min.y - cube[1];
            const dz = box.min.z - cube[2];

            if (Math.abs(dx) > 100000 || Math.abs(dy) > 100000) {
                console.warn("[export] world offset detected:", dx, dy, dz);
                return [dx, dy, dz];
            }
        } catch (error) {
            console.warn("[export] could not check world offset:", error);
        }

        return [0, 0, 0];
    }

    function createSectionFilter(offset) {
        const volume = currentSection.volume;

        volume.updateMatrixWorld(true);

        const inverse = new THREE.Matrix4();

        if (typeof inverse.invert === "function") {
            inverse.copy(volume.matrixWorld).invert();
        } else {
            inverse.getInverse(volume.matrixWorld);
        }

        const m = inverse.elements;
        const [ox, oy, oz] = offset;

        // Is a point (file coordinates) inside the unit box in volume space?
        const contains = (x, y, z) => {
            const wx = x + ox;
            const wy = y + oy;
            const wz = z + oz;

            const lx = m[0] * wx + m[4] * wy + m[8] * wz + m[12];
            if (lx < -0.5 || lx > 0.5) return false;

            const ly = m[1] * wx + m[5] * wy + m[9] * wz + m[13];
            if (ly < -0.5 || ly > 0.5) return false;

            const lz = m[2] * wx + m[6] * wy + m[10] * wz + m[14];
            return lz >= -0.5 && lz <= 0.5;
        };

        // Can a node box be skipped entirely?
        const nodeOutside = bounds => {
            let minX = Infinity, minY = Infinity, minZ = Infinity;
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

            for (let i = 0; i < 8; i++) {
                const wx = (i & 1 ? bounds.max[0] : bounds.min[0]) + ox;
                const wy = (i & 2 ? bounds.max[1] : bounds.min[1]) + oy;
                const wz = (i & 4 ? bounds.max[2] : bounds.min[2]) + oz;

                const lx = m[0] * wx + m[4] * wy + m[8] * wz + m[12];
                const ly = m[1] * wx + m[5] * wy + m[9] * wz + m[13];
                const lz = m[2] * wx + m[6] * wy + m[10] * wz + m[14];

                minX = Math.min(minX, lx); maxX = Math.max(maxX, lx);
                minY = Math.min(minY, ly); maxY = Math.max(maxY, ly);
                minZ = Math.min(minZ, lz); maxZ = Math.max(maxZ, lz);
            }

            return (
                maxX < -0.5 || minX > 0.5 ||
                maxY < -0.5 || minY > 0.5 ||
                maxZ < -0.5 || minZ > 0.5
            );
        };

        return { contains, nodeOutside };
    }

    /* ============================================================
       SWISSIMAGE colour sampler (full tile)
       ============================================================ */

    async function createColorSampler(bounds) {
        const key = tileKey(currentTile, 0);

        if (
            !SWISSIMAGE_RGB.raster ||
            SWISSIMAGE_RGB.raster.tileKey !== key ||
            SWISSIMAGE_RGB.raster.requestedZoom !== SWISSIMAGE_RGB.zoom
        ) {
            setStatus("Preparing SWISSIMAGE for export…");
            await prepareSwissImageRaster();
        }

        const raster = SWISSIMAGE_RGB.raster;

        if (!raster?.rgb) {
            throw new Error("SWISSIMAGE raster is not available.");
        }

        colourNote = swissTileNote(raster);

        const pixels = raster.rgb;

        // LV95 -> Web Mercator on a coarse grid; bilinear in between.
        // Over one tile this is accurate to far below one pixel and avoids
        // a proj4 call per point.
        const N = 16;
        const pad = 5;
        const minE = bounds.min[0] - pad, maxE = bounds.max[0] + pad;
        const minN = bounds.min[1] - pad, maxN = bounds.max[1] + pad;
        const dE = maxE - minE, dN = maxN - minN;

        const gx = new Float64Array((N + 1) * (N + 1));
        const gy = new Float64Array((N + 1) * (N + 1));
        const R = 6378137;

        for (let j = 0; j <= N; j++) {
            for (let i = 0; i <= N; i++) {
                const [lon, lat] = proj4(
                    "EPSG:2056",
                    "EPSG:4326",
                    [minE + (dE * i) / N, minN + (dN * j) / N]
                );

                gx[j * (N + 1) + i] = R * lon * Math.PI / 180;
                gy[j * (N + 1) + i] = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
            }
        }

        const scaleX = raster.width / (raster.worldMaxX - raster.worldMinX);
        const scaleY = raster.height / (raster.worldMaxY - raster.worldMinY);
        const out = [128, 128, 128];

        // Returns [r, g, b] (0-255) for an LV95 coordinate; array is reused.
        function sample(e, n) {
            let u = ((e - minE) / dE) * N;
            let v = ((n - minN) / dN) * N;

            u = Math.min(Math.max(u, 0), N - 1e-9);
            v = Math.min(Math.max(v, 0), N - 1e-9);

            const i = Math.floor(u), j = Math.floor(v);
            const fu = u - i, fv = v - j;
            const k = j * (N + 1) + i;

            const bilerp = g =>
                g[k] * (1 - fu) * (1 - fv) +
                g[k + 1] * fu * (1 - fv) +
                g[k + N + 1] * (1 - fu) * fv +
                g[k + N + 2] * fu * fv;

            const ix = Math.floor((bilerp(gx) - raster.worldMinX) * scaleX);
            const iy = Math.floor((raster.worldMaxY - bilerp(gy)) * scaleY);

            if (ix < 0 || iy < 0 || ix >= raster.width || iy >= raster.height) {
                out[0] = out[1] = out[2] = 128;
                return out;
            }

            const p = (iy * raster.width + ix) * 3;
            out[0] = pixels[p];
            out[1] = pixels[p + 1];
            out[2] = pixels[p + 2];
            return out;
        }

        return { sample, raster };
    }

    /* ============================================================
       LAS 1.4 writer (point format 7)
       ============================================================ */

    class LasWriter {
        constructor({ scale, offset, wkt, sink }) {
            this.scale = scale;
            this.offset = offset;
            this.wkt = wkt;
            this.sink = sink;

            const wktBytes = new TextEncoder().encode(wkt + "\0");

            this.wktBytes = wktBytes;
            this.headerBytes = HEADER_SIZE + 54 + wktBytes.length;

            this.count = 0;
            this.byReturn = new Array(15).fill(0);
            this.min = [Infinity, Infinity, Infinity];
            this.max = [-Infinity, -Infinity, -Infinity];

            this.buffer = new ArrayBuffer(CHUNK_POINTS * POINT_RECORD_LENGTH);
            this.view = new DataView(this.buffer);
            this.inBuffer = 0;
        }

        async begin() {
            // reserve space for the header; it is filled in at the end
            await this.sink.write(new Uint8Array(this.headerBytes));
        }

        add(x, y, z, intensity, returnNumber, numberOfReturns, flagsByte,
                  classification, userData, scanAngle, sourceId, gps, r, g, b) {
            const v = this.view;
            const o = this.inBuffer * POINT_RECORD_LENGTH;

            v.setInt32(o, Math.round((x - this.offset[0]) / this.scale[0]), true);
            v.setInt32(o + 4, Math.round((y - this.offset[1]) / this.scale[1]), true);
            v.setInt32(o + 8, Math.round((z - this.offset[2]) / this.scale[2]), true);
            v.setUint16(o + 12, intensity & 0xffff, true);
            v.setUint8(o + 14, (returnNumber & 15) | ((numberOfReturns & 15) << 4));
            v.setUint8(o + 15, flagsByte & 0xff);
            v.setUint8(o + 16, classification & 0xff);
            v.setUint8(o + 17, userData & 0xff);
            v.setInt16(o + 18, scanAngle, true);
            v.setUint16(o + 20, sourceId & 0xffff, true);
            v.setFloat64(o + 22, gps, true);
            v.setUint16(o + 30, r, true);
            v.setUint16(o + 32, g, true);
            v.setUint16(o + 34, b, true);

            this.count++;
            if (returnNumber >= 1 && returnNumber <= 15) this.byReturn[returnNumber - 1]++;

            if (x < this.min[0]) this.min[0] = x;
            if (y < this.min[1]) this.min[1] = y;
            if (z < this.min[2]) this.min[2] = z;
            if (x > this.max[0]) this.max[0] = x;
            if (y > this.max[1]) this.max[1] = y;
            if (z > this.max[2]) this.max[2] = z;

            this.inBuffer++;
        }

        get full() {
            return this.inBuffer >= CHUNK_POINTS;
        }

        async flush() {
            if (!this.inBuffer) return;

            const bytes = new Uint8Array(
                this.buffer.slice(0, this.inBuffer * POINT_RECORD_LENGTH)
            );

            this.inBuffer = 0;
            await this.sink.write(bytes);
        }

        buildHeader() {
            const buffer = new ArrayBuffer(this.headerBytes);
            const v = new DataView(buffer);
            const ascii = (offset, text, length) => {
                for (let i = 0; i < Math.min(text.length, length); i++) {
                    v.setUint8(offset + i, text.charCodeAt(i) & 0x7f);
                }
            };

            const now = new Date();
            const dayOfYear = Math.floor(
                (now - new Date(now.getFullYear(), 0, 0)) / 86400000
            );

            const empty = this.count === 0;
            const min = empty ? [0, 0, 0] : this.min;
            const max = empty ? [0, 0, 0] : this.max;

            ascii(0, "LASF", 4);
            v.setUint16(6, 1 << 4, true);                  // global encoding: WKT CRS
            v.setUint8(24, 1);
            v.setUint8(25, 4);
            ascii(26, "Swiss LiDAR Viewer", 32);
            ascii(58, "Swiss LiDAR Viewer export", 32);
            v.setUint16(90, dayOfYear, true);
            v.setUint16(92, now.getFullYear(), true);
            v.setUint16(94, HEADER_SIZE, true);
            v.setUint32(96, this.headerBytes, true);       // offset to point data
            v.setUint32(100, 1, true);                     // one VLR (WKT)
            v.setUint8(104, POINT_FORMAT);
            v.setUint16(105, POINT_RECORD_LENGTH, true);
            // legacy point counts stay 0 for formats 6+

            v.setFloat64(131, this.scale[0], true);
            v.setFloat64(139, this.scale[1], true);
            v.setFloat64(147, this.scale[2], true);
            v.setFloat64(155, this.offset[0], true);
            v.setFloat64(163, this.offset[1], true);
            v.setFloat64(171, this.offset[2], true);
            v.setFloat64(179, max[0], true);
            v.setFloat64(187, min[0], true);
            v.setFloat64(195, max[1], true);
            v.setFloat64(203, min[1], true);
            v.setFloat64(211, max[2], true);
            v.setFloat64(219, min[2], true);

            v.setBigUint64(247, BigInt(this.count), true);
            this.byReturn.forEach((n, i) => v.setBigUint64(255 + i * 8, BigInt(n), true));

            // WKT VLR
            const vlr = HEADER_SIZE;
            ascii(vlr + 2, "LASF_Projection", 16);
            v.setUint16(vlr + 18, 2112, true);
            v.setUint16(vlr + 20, this.wktBytes.length, true);
            ascii(vlr + 22, "OGC WKT coordinate system", 32);
            new Uint8Array(buffer, vlr + 54).set(this.wktBytes);

            return new Uint8Array(buffer);
        }

        async finish() {
            await this.flush();
            return this.sink.finish(this.buildHeader());
        }
    }

    /* ============================================================
       Output sinks: File System Access API (streams to disk) or Blob
       ============================================================ */

    async function createSink(fileName) {
        if (typeof window.showSaveFilePicker === "function") {
            // Must run directly inside the click handler (user gesture).
            const handle = await window.showSaveFilePicker({
                suggestedName: fileName,
                types: [{
                    description: "LAS point cloud",
                    accept: { "application/octet-stream": [".las"] }
                }]
            });

            const writable = await handle.createWritable();
            let size = 0;

            return {
                kind: "disk",
                async write(bytes) { size += bytes.length; await writable.write(bytes); },
                async finish(header) {
                    await writable.write({ type: "write", position: 0, data: header });
                    await writable.close();
                    return { size, location: handle.name };
                },
                async abort() { try { await writable.abort(); } catch (e) { /* ignore */ } }
            };
        }

        const parts = [];
        let size = 0;
        let first = true;

        return {
            kind: "memory",
            async write(bytes) {
                size += bytes.length;
                // the first write is the header placeholder; it is replaced at the end
                parts.push(first ? null : new Blob([bytes]));
                first = false;
            },
            async finish(header) {
                parts[0] = new Blob([header]);

                const blob = new Blob(parts, { type: "application/octet-stream" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");

                link.href = url;
                link.download = fileName;
                document.body.appendChild(link);
                link.click();
                link.remove();

                setTimeout(() => URL.revokeObjectURL(url), 60000);

                return { size, location: fileName };
            },
            async abort() { parts.length = 0; }
        };
    }

    /* ============================================================
       Export
       ============================================================ */

    function safeName(text) {
        return String(text || "tile").replace(/[^A-Za-z0-9._-]+/g, "_");
    }

    function formatBytes(n) {
        return n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;
    }

    // Tolerant getter lookup: returns a function(index) or null.
    function getter(view, ...names) {
        for (const name of names) {
            try {
                const g = view.getter(name);
                if (typeof g === "function") return g;
            } catch (error) { /* try next name */ }
        }
        return null;
    }

    /* ============================================================
       Writers: COPC (node by node) and plain LAZ (decoded in chunks)
       ============================================================ */

    async function writeFromCopc({ url, kind, useRgb, sink }) {
        setStatus("Opening COPC file…");

        const reader = await openCopc(url);
        const { copc, nodes } = reader;
        const cube = copc.info.cube;

        // choose nodes
        let filter = null;

        if (kind === "section") {
            filter = createSectionFilter(detectWorldOffset(cube));
        }

        const selected = [];
        let totalPoints = 0;

        for (const [key, node] of Object.entries(nodes)) {
            if (!node || !node.pointCount) continue;
            if (filter && filter.nodeOutside(nodeBounds(key, cube))) continue;

            selected.push({ key, node });
            totalPoints += node.pointCount;
        }

        if (!selected.length) {
            throw new Error("The section does not contain any points.");
        }

        // coarse-to-fine order keeps the file roughly LOD-sorted
        selected.sort((a, b) => a.key.split("-")[0] - b.key.split("-")[0]);

        // colour
        let colour = null;

        if (useRgb) {
            colour = await createColorSampler({
                min: [copc.header.min[0], copc.header.min[1], copc.header.min[2]],
                max: [copc.header.max[0], copc.header.max[1], copc.header.max[2]]
            });
        }

        const writer = new LasWriter({
            scale: copc.header.scale || [0.001, 0.001, 0.001],
            offset: copc.header.offset || [0, 0, 0],
            wkt: (copc.wkt && String(copc.wkt).trim()) || LV95_WKT,
            sink
        });

        await writer.begin();

        let processed = 0;

        for (let n = 0; n < selected.length; n++) {
            if (abortRequested) throw new Error("Export cancelled.");

            const view = await reader.loadView(selected[n].node);
            const count = view.pointCount;

            const X = getter(view, "X");
            const Y = getter(view, "Y");
            const Z = getter(view, "Z");
            const intensity = getter(view, "Intensity");
            const returnNumber = getter(view, "ReturnNumber");
            const numberOfReturns = getter(view, "NumberOfReturns");
            const classification = getter(view, "Classification");
            const classFlags = getter(view, "ClassificationFlags", "Synthetic");
            const channel = getter(view, "ScannerChannel");
            const direction = getter(view, "ScanDirectionFlag");
            const edge = getter(view, "EdgeOfFlightLine");
            const userData = getter(view, "UserData");
            const scanAngle = getter(view, "ScanAngle");
            const scanAngleRank = scanAngle ? null : getter(view, "ScanAngleRank");
            const sourceId = getter(view, "PointSourceId");
            const gps = getter(view, "GpsTime");
            const red = getter(view, "Red");
            const green = getter(view, "Green");
            const blue = getter(view, "Blue");

            if (!X || !Y || !Z) {
                throw new Error("COPC point data has no X/Y/Z dimensions.");
            }

            for (let i = 0; i < count; i++) {
                const x = X(i), y = Y(i), z = Z(i);

                if (filter && !filter.contains(x, y, z)) continue;

                let r = 0, g = 0, b = 0;

                if (colour) {
                    const rgb = colour.sample(x, y);
                    r = rgb[0] * 257;
                    g = rgb[1] * 257;
                    b = rgb[2] * 257;
                } else if (red && green && blue) {
                    r = red(i); g = green(i); b = blue(i);
                }

                const flags =
                    ((classFlags ? classFlags(i) : 0) & 15) |
                    (((channel ? channel(i) : 0) & 3) << 4) |
                    (((direction ? direction(i) : 0) & 1) << 6) |
                    (((edge ? edge(i) : 0) & 1) << 7);

                const angle = scanAngle
                    ? scanAngle(i)
                    : scanAngleRank ? Math.round(scanAngleRank(i) / 0.006) : 0;

                writer.add(
                    x, y, z,
                    intensity ? intensity(i) : 0,
                    returnNumber ? returnNumber(i) : 1,
                    numberOfReturns ? numberOfReturns(i) : 1,
                    flags,
                    classification ? classification(i) : 0,
                    userData ? userData(i) : 0,
                    angle,
                    sourceId ? sourceId(i) : 0,
                    gps ? gps(i) : 0,
                    r, g, b
                );

                if (writer.full) await writer.flush();
            }

            processed += count;

            showSwissImageProgress(
                processed,
                totalPoints,
                kind === "section" ? "Exporting section…" : "Exporting tile…"
            );

            await yieldToBrowser();
        }

        return writer;
    }

    async function writeFromLaz({ url, kind, useRgb, sink }) {
        const lib = window.swissLaz;

        if (!lib) {
            throw new Error("laz.js is not loaded.");
        }

        // reuse the file if this tile is already open in the viewer
        const open = currentPointCloud?.isLaz && currentPointCloud.userData.lazUrl === url
            ? currentPointCloud
            : null;

        let buffer = open?.userData.lazBuffer;

        if (!buffer) {
            setStatus("Downloading…");
            buffer = await lib.fetchBuffer(
                url,
                (got, total) => showSwissImageProgress(got, total, "Downloading…")
            );
            hideSwissImageProgress();
        }

        // LAZ, plain LAS, or LAS/LAZ inside a ZIP
        const source = await lib.openPointSource(buffer);
        const header = source.header;

        const cube = [...header.min, ...header.max];
        const filter = kind === "section"
            ? createSectionFilter(detectWorldOffset(cube))
            : null;

        const colour = useRgb
            ? await createColorSampler({ min: header.min, max: header.max })
            : null;

        const writer = new LasWriter({
            scale: header.scale,
            offset: header.offset,
            wkt: LV95_WKT,
            sink
        });

        await writer.begin();

        const fmt = header.format;
        const ext = fmt >= 6;
        const rec = header.recordLength;
        const [sx, sy, sz] = header.scale;
        const [ox, oy, oz] = header.offset;

        // RGB position in the source record, if it has one
        const rgbAt = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 }[fmt];
        const gpsAt = ext ? 22 : ({ 1: 20, 3: 20, 4: 20, 5: 20 }[fmt]);

        const label = kind === "section" ? "Exporting section…" : "Exporting tile…";

        await source.run(async (u, base, count, first) => {
            if (abortRequested) throw new Error("Export cancelled.");

            const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);

            for (let k = 0; k < count; k++) {
                const p = base + k * rec;

                const x = dv.getInt32(p, true) * sx + ox;
                const y = dv.getInt32(p + 4, true) * sy + oy;
                const z = dv.getInt32(p + 8, true) * sz + oz;

                if (filter && !filter.contains(x, y, z)) continue;

                const b14 = u[p + 14];
                const b15 = u[p + 15];

                let ret, nret, cls, flags, user, angle, src;

                if (ext) {
                    ret = b14 & 15;
                    nret = b14 >> 4;
                    flags = b15;
                    cls = u[p + 16];
                    user = u[p + 17];
                    angle = dv.getInt16(p + 18, true);
                    src = dv.getUint16(p + 20, true);
                } else {
                    ret = b14 & 7;
                    nret = (b14 >> 3) & 7;
                    cls = b15 & 31;
                    flags = ((b15 >> 5) & 7) | (((b14 >> 6) & 1) << 6) | (((b14 >> 7) & 1) << 7);
                    user = u[p + 17];
                    angle = Math.round(dv.getInt8(p + 16) / 0.006);
                    src = dv.getUint16(p + 18, true);
                }

                let r = 0, g = 0, b = 0;

                if (colour) {
                    const rgb = colour.sample(x, y);
                    r = rgb[0] * 257; g = rgb[1] * 257; b = rgb[2] * 257;
                } else if (rgbAt !== undefined) {
                    r = dv.getUint16(p + rgbAt, true);
                    g = dv.getUint16(p + rgbAt + 2, true);
                    b = dv.getUint16(p + rgbAt + 4, true);
                }

                writer.add(
                    x, y, z,
                    dv.getUint16(p + 12, true),
                    ret, nret, flags, cls, user, angle, src,
                    gpsAt !== undefined ? dv.getFloat64(p + gpsAt, true) : 0,
                    r, g, b
                );

                if (writer.full) await writer.flush();
            }

            showSwissImageProgress(first + count, header.count, label);
        });

        return writer;
    }

    async function runExport(kind) {
        if (exporting) return;

        const url = currentTile && getCopcUrl(currentTile);

        if (!url) {
            setStatus("No point-cloud file for this tile.");
            return;
        }

        const isLaz = tileSourceRank(currentTile) !== 0;

        if (kind === "section" && !currentSection) {
            setStatus("Create a section first.");
            return;
        }

        const tileName = safeName(currentTile.id || currentTile.properties?.title);
        const useRgb = el("exp-rgb")?.checked !== false;
        const fileName =
            `${tileName}_${kind === "section" ? "section" : "full"}${useRgb ? "_rgb" : ""}.las`;

        let sink;

        try {
            sink = await createSink(fileName);   // may open the save dialog
        } catch (error) {
            if (error?.name === "AbortError") {
                setStatus("Export cancelled.");
            } else {
                setStatus(`Export failed: ${error.message}`);
            }
            return;
        }

        exporting = true;
        abortRequested = false;
        colourNote = "";
        window.updateExportButtons();

        const started = performance.now();
        let finished = false;

        try {
            const writer = isLaz
                ? await writeFromLaz({ url, kind, useRgb, sink })
                : await writeFromCopc({ url, kind, useRgb, sink });

            if (kind === "section" && writer.count === 0) {
                throw new Error("No points inside the section box.");
            }

            const result = await writer.finish();
            finished = true;

            const seconds = Math.round((performance.now() - started) / 1000);
            const message =
                `Exported ${writer.count.toLocaleString()} points ` +
                `(${formatBytes(result.size)}) as ${result.location} in ${seconds} s` +
                (useRgb ? colourNote : "") +
                ".";

            setStatus(message);
            setExportInfo(message);

            window.usageCounter?.hit("downloads");
        } catch (error) {
            console.error("[export]", error);
            setStatus(`Export failed: ${error.message}`);
            setExportInfo(`Export failed: ${error.message}`);
        } finally {
            if (!finished) await sink.abort();

            hideSwissImageProgress();
            exporting = false;
            window.updateExportButtons();
        }
    }

    /* ============================================================
       Init
       ============================================================ */

    document.addEventListener("DOMContentLoaded", () => {
        el("export-tile-button")?.addEventListener("click", () => runExport("tile"));
        el("export-section-button")?.addEventListener("click", () => runExport("section"));
        el("export-cancel-button")?.addEventListener("click", () => {
            abortRequested = true;
            setStatus("Cancelling export…");
        });

        window.updateExportButtons();
    });
})();
