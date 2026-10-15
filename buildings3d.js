/*
 * Swiss LiDAR Viewer - swissBUILDINGS3D from swisstopo's 3D Tiles service
 *
 * https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json
 * (Cesium 3D Tiles, the same buildings as map.geo.admin.ch in 3D)
 *
 *   1. walk the tileset (explicit tree or implicit tiling) down to the leaf
 *      tiles over the requested LV95 area
 *   2. read each .b3dm: feature table (RTC_CENTER) + glTF 1.0 or 2.0 with
 *      plain, quantized or Draco-compressed geometry (swisstopo's building
 *      tiles are Draco-compressed; Google's decoder is loaded on demand)
 *   3. Earth-centred coordinates -> WGS84 -> LV95 (proj4, already loaded)
 *   4. heights: aligned to the terrain (swissALTI3D) per tile, which also
 *      removes any ellipsoid / geoid difference
 *
 * Result: triangles in LV95 (E, N, height), flat list.
 */

(function () {
    "use strict";

    const TILESET = "https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json";

    /* ============================================================
       Geodesy
       ============================================================ */

    const A = 6378137.0, F = 1 / 298.257223563;
    const E2 = F * (2 - F), B = A * (1 - F), EP2 = (A * A - B * B) / (B * B);

    function geodeticToEcef(lonDeg, latDeg, h) {
        const lon = lonDeg * Math.PI / 180, lat = latDeg * Math.PI / 180;
        const s = Math.sin(lat), c = Math.cos(lat);
        const n = A / Math.sqrt(1 - E2 * s * s);
        return [(n + h) * c * Math.cos(lon), (n + h) * c * Math.sin(lon), (n * (1 - E2) + h) * s];
    }

    /* Bowring, refined twice: sub-millimetre for points near the surface. */
    function ecefToGeodetic(x, y, z) {
        const p = Math.hypot(x, y);
        const lon = Math.atan2(y, x);
        let theta = Math.atan2(z * A, p * B);
        let lat = Math.atan2(z + EP2 * B * Math.sin(theta) ** 3, p - E2 * A * Math.cos(theta) ** 3);

        for (let i = 0; i < 2; i++) {
            const s = Math.sin(lat);
            const n = A / Math.sqrt(1 - E2 * s * s);
            const h = p / Math.cos(lat) - n;
            lat = Math.atan2(z, p * (1 - E2 * n / (n + h)));
        }

        const s = Math.sin(lat);
        const n = A / Math.sqrt(1 - E2 * s * s);
        const h = Math.abs(Math.cos(lat)) > 1e-9 ? p / Math.cos(lat) - n : Math.abs(z) - B;

        return [lon * 180 / Math.PI, lat * 180 / Math.PI, h];
    }

    /* ============================================================
       4x4 matrices (column-major, like glTF and 3D Tiles)
       ============================================================ */

    const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

    function mul(a, b) {
        const r = new Array(16);
        for (let c = 0; c < 4; c++) {
            for (let row = 0; row < 4; row++) {
                let s = 0;
                for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
                r[c * 4 + row] = s;
            }
        }
        return r;
    }

    function apply(m, x, y, z) {
        return [
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14]
        ];
    }

    function trs(node) {
        if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.slice();

        const [tx, ty, tz] = node.translation || [0, 0, 0];
        const [qx, qy, qz, qw] = node.rotation || [0, 0, 0, 1];
        const [sx, sy, sz] = node.scale || [1, 1, 1];

        return [
            (1 - 2 * (qy * qy + qz * qz)) * sx, 2 * (qx * qy + qz * qw) * sx, 2 * (qx * qz - qy * qw) * sx, 0,
            2 * (qx * qy - qz * qw) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, 2 * (qy * qz + qx * qw) * sy, 0,
            2 * (qx * qz + qy * qw) * sz, 2 * (qy * qz - qx * qw) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
            tx, ty, tz, 1
        ];
    }

    // glTF is Y-up, 3D Tiles is Z-up: (x, y, z) -> (x, -z, y)
    const Y_UP_TO_Z_UP = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

    /* ============================================================
       Draco decoder (loaded on demand)
       ============================================================ */

    const DRACO_SOURCES = [
        "https://www.gstatic.com/draco/versioned/decoders/1.5.6/draco_decoder.js",
        "https://cdn.jsdelivr.net/npm/draco3d@1.5.6/draco_decoder.js"
    ];

    let dracoPromise = null;

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = src;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`could not load ${src}`));
            document.head.appendChild(script);
        });
    }

    function ensureDraco() {
        if (!dracoPromise) {
            dracoPromise = (async () => {
                if (typeof DracoDecoderModule !== "function") {
                    let lastError = null;
                    for (const src of DRACO_SOURCES) {
                        try { await loadScript(src); if (typeof DracoDecoderModule === "function") break; }
                        catch (error) { lastError = error; }
                    }
                    if (typeof DracoDecoderModule !== "function") {
                        throw lastError || new Error("Draco decoder not available");
                    }
                }
                return await new Promise(resolve => {
                    const module = DracoDecoderModule({ onModuleLoaded: m => resolve(m) });
                    if (module && typeof module.then === "function") module.then(resolve);
                });
            })().catch(error => { dracoPromise = null; throw error; });
        }
        return dracoPromise;
    }

    /* Draco primitive -> { positions: Float32Array, index: Uint32Array } */
    function decodeDraco(draco, bytes, positionId) {
        const decoder = new draco.Decoder();
        const array = new Int8Array(bytes);
        let geometry = null;

        try {
            const type = decoder.GetEncodedGeometryType(array);
            if (type !== draco.TRIANGULAR_MESH) throw new Error("Draco data is not a triangle mesh");

            geometry = new draco.Mesh();
            const status = decoder.DecodeArrayToMesh(array, array.byteLength, geometry);
            if (!status.ok() || geometry.ptr === 0) throw new Error(`Draco decoding failed: ${status.error_msg()}`);

            const attribute = positionId !== undefined
                ? decoder.GetAttributeByUniqueId(geometry, positionId)
                : decoder.GetAttribute(geometry, decoder.GetAttributeId(geometry, draco.POSITION));

            const points = geometry.num_points();
            const components = attribute.num_components();
            const posBytes = points * components * 4;
            let ptr = draco._malloc(posBytes);
            decoder.GetAttributeDataArrayForAllPoints(geometry, attribute, draco.DT_FLOAT32, posBytes, ptr);
            const positions = new Float32Array(draco.HEAPF32.buffer, ptr, points * components).slice();
            draco._free(ptr);

            const faces = geometry.num_faces();
            const indexBytes = faces * 3 * 4;
            ptr = draco._malloc(indexBytes);
            decoder.GetTrianglesUInt32Array(geometry, indexBytes, ptr);
            const index = new Uint32Array(draco.HEAPF32.buffer, ptr, faces * 3).slice();
            draco._free(ptr);

            return { positions, index, components };
        } finally {
            if (geometry) draco.destroy(geometry);
            draco.destroy(decoder);
        }
    }

    /* ============================================================
       b3dm + glTF
       ============================================================ */

    const text = (bytes) => new TextDecoder().decode(bytes);
    const magicAt = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

    function parseB3dm(buffer) {
        const dv = new DataView(buffer);
        if (magicAt(dv, 0) !== "b3dm") throw new Error("not a b3dm tile");

        // 3D Tiles 1.0 header (28 bytes); two legacy layouts are tried as well
        const layouts = [
            () => {
                const ftJ = dv.getUint32(12, true), ftB = dv.getUint32(16, true);
                const btJ = dv.getUint32(20, true), btB = dv.getUint32(24, true);
                return { ftStart: 28, ftJ, glb: 28 + ftJ + ftB + btJ + btB };
            },
            () => ({ ftStart: 0, ftJ: 0, glb: 24 + dv.getUint32(12, true) + dv.getUint32(16, true) }),
            () => ({ ftStart: 0, ftJ: 0, glb: 20 + dv.getUint32(16, true) })
        ];

        for (const layout of layouts) {
            const L = layout();
            if (L.glb + 12 <= buffer.byteLength && magicAt(dv, L.glb) === "glTF") {
                let rtc = null;
                if (L.ftJ) {
                    try {
                        const ft = JSON.parse(text(new Uint8Array(buffer, L.ftStart, L.ftJ)).trim() || "{}");
                        if (Array.isArray(ft.RTC_CENTER)) rtc = ft.RTC_CENTER;
                    } catch (error) { /* no feature table */ }
                }
                return { glb: buffer.slice(L.glb), rtc };
            }
        }

        throw new Error("no glTF inside the b3dm tile");
    }

    function parseGlb(buffer) {
        const dv = new DataView(buffer);
        const version = dv.getUint32(4, true);

        if (version === 2) {
            let offset = 12, json = null, bin = null;
            while (offset + 8 <= buffer.byteLength) {
                const length = dv.getUint32(offset, true), type = dv.getUint32(offset + 4, true);
                const start = offset + 8;
                if (type === 0x4e4f534a) json = JSON.parse(text(new Uint8Array(buffer, start, length)));
                else if (type === 0x004e4942) bin = buffer.slice(start, start + length);
                offset = start + length;
            }
            return { version: 2, json, bin };
        }

        if (version === 1) {
            const contentLength = dv.getUint32(12, true);
            const json = JSON.parse(text(new Uint8Array(buffer, 20, contentLength)));
            return { version: 1, json, bin: buffer.slice(20 + contentLength) };
        }

        throw new Error(`glTF version ${version} not supported`);
    }

    const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
    const TYPED = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
    const NORMALIZE = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

    function bufferData(gltf, bufferId) {
        const buffers = gltf.json.buffers;
        const buffer = buffers?.[bufferId];

        if (bufferId === "binary_glTF" || !buffer?.uri || buffer?.extensions?.KHR_binary_glTF) return gltf.bin;
        if (buffer.uri.startsWith("data:")) {
            const b64 = buffer.uri.split(",")[1];
            const raw = atob(b64);
            const out = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
            return out.buffer;
        }
        return gltf.bin;   // external files are not used by swisstopo's tiles
    }

    /* Accessor -> plain number array (dequantized, normalized). */
    function readAccessor(gltf, id) {
        const acc = gltf.json.accessors[id];
        const view = gltf.json.bufferViews[acc.bufferView];
        const data = bufferData(gltf, view.buffer);
        const Typed = TYPED[acc.componentType];
        const n = COMPONENTS[acc.type] || 1;
        const size = Typed.BYTES_PER_ELEMENT;
        const stride = acc.byteStride || view.byteStride || n * size;
        const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
        const dv = new DataView(data);
        const out = new Float64Array(acc.count * n);

        const read = {
            5120: o => dv.getInt8(o), 5121: o => dv.getUint8(o), 5122: o => dv.getInt16(o, true),
            5123: o => dv.getUint16(o, true), 5125: o => dv.getUint32(o, true), 5126: o => dv.getFloat32(o, true)
        }[acc.componentType];

        for (let i = 0; i < acc.count; i++) {
            for (let c = 0; c < n; c++) out[i * n + c] = read(base + i * stride + c * size);
        }

        if (acc.normalized && NORMALIZE[acc.componentType]) {
            const d = NORMALIZE[acc.componentType];
            for (let i = 0; i < out.length; i++) out[i] = Math.max(out[i] / d, -1);
        }

        // Cesium glTF 1.0 quantization
        const q = acc.extensions?.WEB3D_quantized_attributes;
        if (q?.decodeMatrix && n === 3) {
            const m = q.decodeMatrix;   // 4x4, column-major
            for (let i = 0; i < acc.count; i++) {
                const [x, y, z] = [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]];
                out[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
                out[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
                out[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
            }
        }

        return out;
    }

    /* All triangles of a glTF, in the glTF's own frame (node transforms applied). */
    function gltfTriangles(gltf, draco = null) {
        const json = gltf.json;

        const out = [];
        const meshOf = node => gltf.version === 1 ? (node.meshes || []) : (node.mesh !== undefined ? [node.mesh] : []);

        const visit = (nodeId, parent) => {
            const node = json.nodes[nodeId];
            const m = mul(parent, trs(node));

            for (const meshId of meshOf(node)) {
                for (const prim of json.meshes[meshId].primitives || []) {
                    const mode = prim.mode === undefined ? 4 : prim.mode;
                    if (mode !== 4 && mode !== 5 && mode !== 6) continue;

                    let pos, idx;
                    const dracoExt = prim.extensions?.KHR_draco_mesh_compression;

                    if (dracoExt) {
                        if (!draco) throw new Error("Draco decoder missing");
                        const view = json.bufferViews[dracoExt.bufferView];
                        const data = bufferData(gltf, view.buffer);
                        const bytes = data.slice(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
                        const decoded = decodeDraco(draco, bytes, dracoExt.attributes?.POSITION);
                        if (decoded.components !== 3) continue;
                        pos = decoded.positions;
                        idx = decoded.index;
                    } else {
                        pos = readAccessor(gltf, prim.attributes.POSITION);
                        idx = prim.indices !== undefined
                            ? readAccessor(gltf, prim.indices)
                            : Float64Array.from({ length: pos.length / 3 }, (_, i) => i);
                    }

                    if (mode === 5) {   // strip
                        const t = [];
                        for (let i = 0; i + 2 < idx.length; i++) t.push(...(i % 2 ? [idx[i + 1], idx[i], idx[i + 2]] : [idx[i], idx[i + 1], idx[i + 2]]));
                        idx = t;
                    } else if (mode === 6) {   // fan
                        const t = [];
                        for (let i = 1; i + 1 < idx.length; i++) t.push(idx[0], idx[i], idx[i + 1]);
                        idx = t;
                    }

                    // every index is one corner; only whole triangles (3 corners)
                    const corners = idx.length - (idx.length % 3);
                    for (let i = 0; i < corners; i++) {
                        const k = idx[i] * 3;
                        out.push(...apply(m, pos[k], pos[k + 1], pos[k + 2]));
                    }
                }
            }

            for (const child of node.children || []) visit(child, m);
        };

        const sceneId = json.scene !== undefined ? json.scene : (gltf.version === 1 ? Object.keys(json.scenes || {})[0] : 0);
        const scene = json.scenes?.[sceneId];
        const roots = scene?.nodes || Object.keys(json.nodes || {});
        for (const r of roots) visit(r, IDENTITY);

        // the CESIUM_RTC extension (glTF 1.0) also gives a centre
        const rtc = json.extensions?.CESIUM_RTC?.center || null;
        return { positions: out, rtc };
    }

    /* ============================================================
       Tileset traversal
       ============================================================ */

    function wgsBox(area, margin = 30) {
        const corners = [[area.minE - margin, area.minN - margin], [area.maxE + margin, area.minN - margin],
            [area.maxE + margin, area.maxN + margin], [area.minE - margin, area.maxN + margin]]
            .map(c => proj4("EPSG:2056", "EPSG:4326", c));
        return {
            w: Math.min(...corners.map(c => c[0])), e: Math.max(...corners.map(c => c[0])),
            s: Math.min(...corners.map(c => c[1])), n: Math.max(...corners.map(c => c[1]))
        };
    }

    function intersects(bv, transform, box) {
        if (bv?.region) {
            const [w, s, e, n] = bv.region.map(r => r * 180 / Math.PI);
            return !(e < box.w || w > box.e || n < box.s || s > box.n);
        }

        // box or sphere in Earth-centred coordinates: centre + radius test
        let centre, radius;
        if (bv?.box) {
            const b = bv.box;
            centre = b.slice(0, 3);
            radius = Math.hypot(b[3], b[4], b[5]) + Math.hypot(b[6], b[7], b[8]) + Math.hypot(b[9], b[10], b[11]);
        } else if (bv?.sphere) {
            centre = bv.sphere.slice(0, 3);
            radius = bv.sphere[3];
        } else {
            return true;
        }

        const [x, y, z] = apply(transform, centre[0], centre[1], centre[2]);
        const [lon, lat] = ecefToGeodetic(x, y, z);
        const dLat = radius / 111320, dLon = radius / (111320 * Math.cos(lat * Math.PI / 180));
        return !(lon + dLon < box.w || lon - dLon > box.e || lat + dLat < box.s || lat - dLat > box.n);
    }

    const resolve = (uri, base) => new URL(uri, base).toString();

    async function fetchJson(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${url.split("/").slice(-3).join("/")}: HTTP ${response.status}`);
        return response.json();
    }

    /* Leaf contents over the area: [{ url, transform }] */
    async function collectContents(url, box, onProgress) {
        const found = [];
        let visited = 0;

        const walkTileset = async (tilesetUrl, parentTransform, depth) => {
            const tileset = await fetchJson(tilesetUrl);
            const upAxis = tileset.asset?.gltfUpAxis || "Y";
            const root = tileset.root;

            if (root.implicitTiling) {
                implicitContents(root, tilesetUrl, box, parentTransform, upAxis, found);
                return;
            }

            await walkTile(root, tilesetUrl, parentTransform, upAxis, depth);
        };

        const walkTile = async (tile, baseUrl, parentTransform, upAxis, depth) => {
            const transform = tile.transform ? mul(parentTransform, tile.transform) : parentTransform;
            if (!intersects(tile.boundingVolume, transform, box)) return;

            visited++;
            onProgress?.(visited, found.length);

            const uri = tile.content?.uri || tile.content?.url;
            const children = tile.children || [];

            if (uri && /\.json(\?|$)/i.test(uri)) {
                if (depth < 12) await walkTileset(resolve(uri, baseUrl), transform, depth + 1);
                return;
            }

            if (!children.length) {
                if (uri) found.push({ url: resolve(uri, baseUrl), transform, upAxis });
                return;
            }

            for (const child of children) await walkTile(child, baseUrl, transform, upAxis, depth);
        };

        await walkTileset(url, IDENTITY, 0);
        return found;
    }

    /* 3D Tiles 1.1 implicit quadtree: tiles of the deepest level over the area. */
    function implicitContents(root, baseUrl, box, transform, upAxis, found) {
        const it = root.implicitTiling;
        const template = root.content?.uri;
        const region = root.boundingVolume?.region;
        if (!template || !region) throw new Error("implicit tiling without region is not supported");

        const [w, s, e, n] = region.map(r => r * 180 / Math.PI);
        const level = (it.availableLevels || it.maximumLevel + 1 || 1) - 1;
        const count = 2 ** level;
        const dx = (e - w) / count, dy = (n - s) / count;

        const x0 = Math.max(0, Math.floor((box.w - w) / dx)), x1 = Math.min(count - 1, Math.floor((box.e - w) / dx));
        const y0 = Math.max(0, Math.floor((box.s - s) / dy)), y1 = Math.min(count - 1, Math.floor((box.n - s) / dy));

        for (let x = x0; x <= x1; x++) {
            for (let y = y0; y <= y1; y++) {
                const uri = template.replace("{level}", level).replace("{x}", x).replace("{y}", y);
                found.push({ url: resolve(uri, baseUrl), transform, upAxis });
            }
        }
    }

    /* ============================================================
       Public: buildings over an LV95 area
       ============================================================ */

    /*
     * Returns { triangles: Float64Array [E, N, h, ...] in LV95, tiles, failed }.
     * terrainAt(e, n) aligns the heights (per tile) to the terrain.
     */
    async function loadBuildings({ area, terrainAt, onProgress, tilesetUrl = TILESET }) {
        const box = wgsBox(area);
        const contents = await collectContents(tilesetUrl, box, (v, f) => onProgress?.(`Finding tiles… ${f}`));

        if (!contents.length) throw new Error("no swissBUILDINGS3D tiles for this area");

        const triangles = [];
        let failed = 0, done = 0, lastError = null;

        for (const content of contents) {
            onProgress?.(`Loading buildings ${++done}/${contents.length}…`);

            let local;
            try {
                const response = await fetch(content.url);
                if (!response.ok) { failed++; continue; }
                const buffer = await response.arrayBuffer();

                const b3dm = parseB3dm(buffer);
                const gltf = parseGlb(b3dm.glb);
                const needsDraco = (gltf.json.extensionsUsed || []).includes("KHR_draco_mesh_compression");
                if (needsDraco) onProgress?.(`Loading buildings ${done}/${contents.length} (decoding)…`);
                local = gltfTriangles(gltf, needsDraco ? await ensureDraco() : null);
                local.rtc = b3dm.rtc || local.rtc;
            } catch (error) {
                failed++;
                lastError = error;
                console.warn("[buildings3d]", content.url, error);
                if (/could not load|not available/.test(error.message)) throw error;   // decoder missing: stop
                continue;
            }

            // glTF frame -> Earth-centred -> WGS84 -> LV95
            let m = content.upAxis === "Z" ? IDENTITY : Y_UP_TO_Z_UP;
            if (local.rtc) m = mul([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, local.rtc[0], local.rtc[1], local.rtc[2], 1], m);
            m = mul(content.transform, m);

            const P = local.positions;
            const lv = new Float64Array(P.length);
            const offsets = [];

            for (let i = 0; i < P.length; i += 3) {
                const [x, y, z] = apply(m, P[i], P[i + 1], P[i + 2]);
                const [lon, lat, h] = ecefToGeodetic(x, y, z);
                const [E, N] = proj4("EPSG:4326", "EPSG:2056", [lon, lat]);
                lv[i] = E; lv[i + 1] = N; lv[i + 2] = h;

                if (i % 9 === 0) {          // one vertex per triangle is enough
                    const t = terrainAt(E, N);
                    if (t === t) offsets.push(t - h);
                }
            }

            // building feet sit on the terrain: the high end of (terrain - height)
            // is the vertical datum offset (ellipsoid / geoid), the rest are roofs
            offsets.sort((a, b) => a - b);
            const dz = offsets.length ? offsets[Math.floor(offsets.length * 0.85)] : 0;

            for (let i = 0; i < lv.length; i += 3) {
                const E = lv[i], N = lv[i + 1];
                // keep only triangles over the area (with a little margin)
                lv[i + 2] += dz;
            }

            for (let i = 0; i + 8 < lv.length; i += 9) {
                const cE = (lv[i] + lv[i + 3] + lv[i + 6]) / 3, cN = (lv[i + 1] + lv[i + 4] + lv[i + 7]) / 3;
                if (!(cE === cE && cN === cN)) continue;
                if (cE < area.minE || cE > area.maxE || cN < area.minN || cN > area.maxN) continue;
                for (let k = 0; k < 9; k++) triangles.push(lv[i + k]);
            }
        }

        if (!triangles.length && failed) {
            throw new Error(`swissBUILDINGS3D tiles could not be read${lastError ? ` (${lastError.message})` : ""}`);
        }

        return { triangles: Float64Array.from(triangles), tiles: contents.length, failed };
    }

    window.swissBuildings3D = {
        loadBuildings,
        // for tests
        _internal: { geodeticToEcef, ecefToGeodetic, parseB3dm, parseGlb, gltfTriangles, decodeDraco, mul, apply, Y_UP_TO_Z_UP, collectContents }
    };
})();
