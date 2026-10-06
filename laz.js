/*
 * Swiss LiDAR Viewer - plain LAZ tiles
 *
 * Potree can only stream COPC. swissSURFACE3D tiles that exist only as
 * ordinary .laz are therefore downloaded, decoded with laz-perf, and drawn
 * here as one THREE.Points object inside Potree's scene:
 *
 *  - every point is kept (no octree), colours are baked ONCE per colour mode
 *    and then stay on the GPU while you navigate
 *  - the point budget thins the cloud uniformly (points are stored in random
 *    order, so a prefix of the buffer is an even sample of the tile)
 *  - sections clip in the shader, using the same section box as the COPC path
 *
 * Needs a laz-perf decoder: a global `createLazPerf` (or `Module` with LASZip),
 * otherwise it is loaded from a CDN. Set CONFIG.LAZ_PERF_BASE to your own copy
 * of laz-perf's lib/web folder to avoid the CDN.
 *
 * Uses globals from app.js: viewer, currentTile, currentPointCloud,
 * currentSection, loadedPointClouds, SWISSIMAGE_RGB, setStatus, ...
 */

(function () {
    "use strict";

    const MAX_POINTS = 60e6;
    const CHUNK = 65536;
    const DEFAULT_LAZ_PERF_BASE = "https://cdn.jsdelivr.net/npm/laz-perf@0.0.7/lib/web/";

    const setAttr = (geometry, name, attribute) =>
        typeof geometry.setAttribute === "function"
            ? geometry.setAttribute(name, attribute)
            : geometry.addAttribute(name, attribute);

    /* ============================================================
       Download
       ============================================================ */

    async function fetchBuffer(url, onProgress, signal) {
        const response = await fetch(url, signal ? { signal } : undefined);

        if (!response.ok) {
            throw new Error(`Download failed (${response.status})`);
        }

        const total = Number(response.headers.get("content-length")) || 0;

        if (!response.body || !total) {
            return response.arrayBuffer();
        }

        const out = new Uint8Array(total);
        const reader = response.body.getReader();
        let got = 0;

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;

            if (got + value.length > out.length) {
                // size header was wrong: fall back to collecting the rest
                const rest = [value];
                for (;;) {
                    const next = await reader.read();
                    if (next.done) break;
                    rest.push(next.value);
                }
                const extra = rest.reduce((n, c) => n + c.length, 0);
                const merged = new Uint8Array(got + extra);
                merged.set(out.subarray(0, got));
                let at = got;
                for (const c of rest) { merged.set(c, at); at += c.length; }
                return merged.buffer;
            }

            out.set(value, got);
            got += value.length;
            onProgress?.(got, total);
        }

        return got === total ? out.buffer : out.buffer.slice(0, got);
    }

    /* ============================================================
       LAS header
       ============================================================ */

    function parseLasHeader(buffer) {
        const v = new DataView(buffer);
        const signature = String.fromCharCode(
            v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3)
        );

        if (signature !== "LASF") {
            throw new Error("This file is not a LAS/LAZ file.");
        }

        const minor = v.getUint8(25);
        let count = v.getUint32(107, true);

        if (minor >= 4) {
            const big = Number(v.getBigUint64(247, true));
            if (big > 0) count = big;
        }

        const f64 = o => v.getFloat64(o, true);

        return {
            versionMinor: minor,
            offsetToPoints: v.getUint32(96, true),
            format: v.getUint8(104) & 0x3f,
            compressed: (v.getUint8(104) & 0x80) !== 0,
            recordLength: v.getUint16(105, true),
            count,
            scale: [f64(131), f64(139), f64(147)],
            offset: [f64(155), f64(163), f64(171)],
            max: [f64(179), f64(195), f64(211)],
            min: [f64(187), f64(203), f64(219)]
        };
    }

    /* ============================================================
       laz-perf
       ============================================================ */

    let lazPerfPromise = null;

    const hasZip = m => !!(m && m.LASZip && m._malloc);

    /*
     * laz-perf's web build (lib/web/laz-perf.js) is an Emscripten module
     * factory, NOT an ES module (its index.js is CommonJS). So it can neither
     * be import()ed nor required in the browser; it has to run as a classic
     * script, or be evaluated with a small module/exports shim.
     */
    function factoryFromSource(code) {
        const shim = { exports: {} };
        const run = new Function(
            "module", "exports", "define", "require",
            `${code}\n;return typeof createLazPerf !== "undefined" ? createLazPerf : undefined;`
        );

        const result = run(shim, shim.exports, undefined, undefined);
        const exported = shim.exports;

        return (
            (typeof result === "function" && result) ||
            (typeof exported === "function" && exported) ||
            exported?.createLazPerf ||
            exported?.default ||
            null
        );
    }

    function loadClassicScript(url) {
        return new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = url;
            script.async = true;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`could not load ${url}`));
            document.head.appendChild(script);
        });
    }

    function getLazPerf() {
        if (lazPerfPromise) {
            return lazPerfPromise;
        }

        lazPerfPromise = (async () => {
            const base = (window.CONFIG && CONFIG.LAZ_PERF_BASE) || DEFAULT_LAZ_PERF_BASE;
            const locateFile = name => base + name;
            const problems = [];

            const tryFactory = async (factory, label) => {
                for (const options of [{ locateFile }, undefined]) {
                    try {
                        const module = await factory(options);
                        if (hasZip(module)) return module;
                        problems.push(`${label}: module has no LASZip/_malloc`);
                    } catch (error) {
                        problems.push(`${label}: ${error.message || error}`);
                    }
                }
                return null;
            };

            // 1. a decoder the page already provides
            if (hasZip(window.Module)) {
                return window.Module;
            }

            const existing = [
                window.createLazPerf,
                window.LazPerf?.createLazPerf,
                window.LazPerf?.create,
                typeof window.LazPerf === "function" ? window.LazPerf : null
            ].filter(Boolean);

            for (const factory of existing) {
                const module = await tryFactory(factory, "page decoder");
                if (module) return module;
            }

            // 2. laz-perf as a classic script (defines window.createLazPerf)
            try {
                await loadClassicScript(base + "laz-perf.js");

                if (typeof window.createLazPerf === "function") {
                    const module = await tryFactory(window.createLazPerf, "script tag");
                    if (module) return module;
                } else {
                    problems.push("script tag: laz-perf.js did not define createLazPerf");
                }
            } catch (error) {
                problems.push(`script tag: ${error.message}`);
            }

            // 3. download the source and evaluate it with a module shim
            try {
                const response = await fetch(base + "laz-perf.js");

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const factory = factoryFromSource(await response.text());

                if (factory) {
                    const module = await tryFactory(factory, "evaluated source");
                    if (module) return module;
                } else {
                    problems.push("evaluated source: no factory found");
                }
            } catch (error) {
                problems.push(`evaluated source: ${error.message}`);
            }

            console.warn("[laz] decoder problems:", problems);

            throw new Error(
                "LAZ decoder (laz-perf) could not be loaded from " + base +
                ". Details: " + (problems.slice(-2).join("; ") || "none") +
                ". Host laz-perf's lib/web folder yourself and set CONFIG.LAZ_PERF_BASE."
            );
        })();

        lazPerfPromise.catch(() => { lazPerfPromise = null; });

        return lazPerfPromise;
    }

    /*
     * Decode a whole LAZ file in chunks. For every chunk,
     * onChunk(heapU8, basePointer, count, firstIndex) is called; the raw
     * point records (header.recordLength bytes each) sit in the wasm heap.
     */
    async function decodeLaz(buffer, header, onChunk, onProgress) {
        const module = await getLazPerf();
        const total = buffer.byteLength;
        const record = header.recordLength;

        const filePtr = module._malloc(total);
        module.HEAPU8.set(new Uint8Array(buffer), filePtr);

        const zip = new module.LASZip();
        const chunkPtr = module._malloc(CHUNK * record);

        try {
            zip.open(filePtr, total);

            for (let done = 0; done < header.count;) {
                const n = Math.min(CHUNK, header.count - done);

                for (let k = 0; k < n; k++) {
                    zip.getPoint(chunkPtr + k * record);
                }

                await onChunk(module.HEAPU8, chunkPtr, n, done);

                done += n;
                onProgress?.(done, header.count);

                if ((done / CHUNK) % 4 === 0) await yieldToBrowser();
            }
        } finally {
            try { zip.delete(); } catch (error) { /* ignore */ }
            module._free(filePtr);
            module._free(chunkPtr);
        }
    }

    /* ============================================================
       Point sources: LAZ, plain LAS, and LAS/LAZ inside a ZIP

       Older swissSURFACE3D tiles are only offered as .las.zip. The ZIP is
       read directly (central directory) and the LAS inside is inflated as a
       stream with the browser's DecompressionStream, so the uncompressed
       file (hundreds of MB) never has to sit in memory as a whole.

       Every source offers  { header, kind, run(onChunk, onProgress) }  and
       calls onChunk(bytes, basePointer, count, firstIndex) with raw point
       records, like decodeLaz does.
       ============================================================ */

    function findZipEntry(buffer) {
        const v = new DataView(buffer);
        const bytes = new Uint8Array(buffer);

        let eocd = -1;

        for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
            if (v.getUint32(i, true) === 0x06054b50) {
                eocd = i;
                break;
            }
        }

        if (eocd < 0) {
            throw new Error("ZIP: end-of-archive record not found (damaged download?).");
        }

        const count = v.getUint16(eocd + 10, true);
        let p = v.getUint32(eocd + 16, true);

        if (count === 0xffff || p === 0xffffffff) {
            throw new Error("ZIP64 archives are not supported.");
        }

        const decoder = new TextDecoder();
        let found = null;

        for (let i = 0; i < count; i++) {
            if (v.getUint32(p, true) !== 0x02014b50) break;

            const nameLength = v.getUint16(p + 28, true);
            const extraLength = v.getUint16(p + 30, true);
            const commentLength = v.getUint16(p + 32, true);
            const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength));

            if (/\.(las|laz)$/i.test(name) && !/(^|\/)__MACOSX\//.test(name)) {
                const entry = {
                    name,
                    method: v.getUint16(p + 10, true),
                    compressedSize: v.getUint32(p + 20, true),
                    size: v.getUint32(p + 24, true),
                    headerOffset: v.getUint32(p + 42, true)
                };

                if (!found || /\.las$/i.test(name)) found = entry;
                if (/\.las$/i.test(name)) break;
            }

            p += 46 + nameLength + extraLength + commentLength;
        }

        if (!found) {
            throw new Error("No .las or .laz file found inside the ZIP.");
        }

        if (found.compressedSize === 0xffffffff || found.size === 0xffffffff) {
            throw new Error("ZIP64 entries are not supported.");
        }

        const nameLength = v.getUint16(found.headerOffset + 26, true);
        const extraLength = v.getUint16(found.headerOffset + 28, true);

        found.dataStart = found.headerOffset + 30 + nameLength + extraLength;

        return found;
    }

    /* Stream of the (inflated) bytes of one ZIP entry. */
    function entryStream(buffer, entry) {
        const data = new Uint8Array(buffer, entry.dataStart, entry.compressedSize);
        let position = 0;

        const raw = new ReadableStream({
            pull(controller) {
                if (position >= data.length) {
                    controller.close();
                    return;
                }

                controller.enqueue(data.subarray(position, position + (1 << 20)));
                position += 1 << 20;
            }
        });

        if (entry.method === 0) {
            return raw;
        }

        if (entry.method !== 8) {
            throw new Error(`Unsupported ZIP compression method ${entry.method}.`);
        }

        if (typeof DecompressionStream === "undefined") {
            throw new Error(
                "This browser cannot unpack ZIP files (DecompressionStream missing). " +
                "Use a current Chrome, Edge, Firefox or Safari."
            );
        }

        return raw.pipeThrough(new DecompressionStream("deflate-raw"));
    }

    /* Exact-size reads from a stream. */
    function byteReader(stream) {
        const reader = stream.getReader();
        const queue = [];
        let queued = 0;
        let finished = false;

        return {
            async pull(n) {
                while (queued < n && !finished) {
                    const result = await reader.read();

                    if (result.done) {
                        finished = true;
                        break;
                    }

                    queue.push(result.value);
                    queued += result.value.length;
                }

                const take = Math.min(n, queued);
                const out = new Uint8Array(take);
                let offset = 0;

                while (offset < take) {
                    const head = queue[0];
                    const need = take - offset;

                    if (head.length <= need) {
                        out.set(head, offset);
                        offset += head.length;
                        queue.shift();
                    } else {
                        out.set(head.subarray(0, need), offset);
                        queue[0] = head.subarray(need);
                        offset += need;
                    }
                }

                queued -= take;

                return out;
            },

            cancel() {
                try { reader.cancel(); } catch (error) { /* ignore */ }
            }
        };
    }

    async function inflateEntry(buffer, entry) {
        const reader = byteReader(entryStream(buffer, entry));
        return (await reader.pull(entry.size)).buffer;
    }

    async function openPointSource(buffer) {
        const sig = new Uint8Array(buffer, 0, 4);

        // ---- ZIP ----
        if (sig[0] === 0x50 && sig[1] === 0x4b) {
            const entry = findZipEntry(buffer);

            // a .laz inside the ZIP: unpack it (it is small), then decode as LAZ
            if (/\.laz$/i.test(entry.name)) {
                return openPointSource(await inflateEntry(buffer, entry));
            }

            const first = byteReader(entryStream(buffer, entry));
            const header = parseLasHeader((await first.pull(375)).buffer);
            first.cancel();

            if (header.compressed) {
                throw new Error("The LAS file inside the ZIP is LAZ-compressed under a .las name.");
            }

            return {
                kind: "zip",
                header,
                async run(onChunk, onProgress) {
                    const reader = byteReader(entryStream(buffer, entry));
                    const record = header.recordLength;

                    await reader.pull(header.offsetToPoints);   // header + VLRs

                    for (let done = 0, round = 0; done < header.count; round++) {
                        const n = Math.min(CHUNK, header.count - done);
                        const chunk = await reader.pull(n * record);

                        if (chunk.length < n * record) {
                            throw new Error("The LAS file inside the ZIP ends early (damaged download?).");
                        }

                        await onChunk(chunk, 0, n, done);

                        done += n;
                        onProgress?.(done, header.count);

                        if (round % 4 === 3) await yieldToBrowser();
                    }
                }
            };
        }

        // ---- LAS / LAZ ----
        const header = parseLasHeader(buffer);

        if (header.compressed) {
            return {
                kind: "laz",
                header,
                run: (onChunk, onProgress) => decodeLaz(buffer, header, onChunk, onProgress)
            };
        }

        return {
            kind: "las",
            header,
            async run(onChunk, onProgress) {
                const whole = new Uint8Array(buffer);
                const record = header.recordLength;

                for (let done = 0, round = 0; done < header.count; round++) {
                    const n = Math.min(CHUNK, header.count - done);

                    await onChunk(whole, header.offsetToPoints + done * record, n, done);

                    done += n;
                    onProgress?.(done, header.count);

                    if (round % 4 === 3) await yieldToBrowser();
                }
            }
        };
    }

    /* ============================================================
       Colour modes (computed on the CPU, uploaded once per mode)
       ============================================================ */

    const CLASS_COLORS = {
        0: [150, 150, 150], 1: [190, 190, 190], 2: [160, 115, 70],
        3: [150, 205, 115], 4: [70, 170, 70], 5: [20, 120, 45],
        6: [235, 90, 60], 7: [220, 40, 200], 9: [60, 120, 235],
        10: [120, 120, 120], 11: [90, 90, 90], 17: [240, 200, 60],
        18: [200, 0, 0]
    };

    function hashColor(i) {
        const h = ((i * 137.508) % 360) / 60;
        const x = 1 - Math.abs((h % 2) - 1);
        const [r, g, b] =
            h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] :
            h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
        return [60 + r * 195, 60 + g * 195, 60 + b * 195];
    }

    const RAMP = [[40, 60, 160], [30, 160, 190], [90, 190, 80], [235, 215, 70], [220, 60, 40]];

    function rampColor(t, out) {
        t = Math.min(Math.max(t, 0), 1) * (RAMP.length - 1);
        const i = Math.min(Math.floor(t), RAMP.length - 2);
        const f = t - i;
        for (let c = 0; c < 3; c++) {
            out[c] = RAMP[i][c] * (1 - f) + RAMP[i + 1][c] * f;
        }
    }

    function fillColors(cloud, mode) {
        const d = cloud.userData.data;
        const out = d.color;
        const n = d.count;
        const tmp = [0, 0, 0];

        if (mode === "intensity") {
            for (let i = 0; i < n; i++) {
                const v = Math.min(255, Math.round(255 * Math.sqrt(d.intensity[i] / d.iMax)));
                const c = i * 4;
                out[c] = out[c + 1] = out[c + 2] = v;
                out[c + 3] = 255;
            }
        } else if (mode === "classification") {
            const lut = [];
            for (let k = 0; k < 256; k++) lut[k] = CLASS_COLORS[k] || hashColor(k);
            for (let i = 0; i < n; i++) {
                const col = lut[d.cls[i]];
                const c = i * 4;
                out[c] = col[0]; out[c + 1] = col[1]; out[c + 2] = col[2]; out[c + 3] = 255;
            }
        } else if (mode === "elevation") {
            const span = Math.max(d.zHi - d.zLo, 1e-6);
            for (let i = 0; i < n; i++) {
                rampColor((d.pos[i * 3 + 2] + d.origin[2] - d.zLo) / span, tmp);
                const c = i * 4;
                out[c] = tmp[0]; out[c + 1] = tmp[1]; out[c + 2] = tmp[2]; out[c + 3] = 255;
            }
        } else if (mode === "return-number" || mode === "number-of-returns") {
            const shift = mode === "return-number" ? 0 : 4;
            const lut = [];
            for (let k = 0; k < 16; k++) lut[k] = hashColor(k * 3 + 1);
            for (let i = 0; i < n; i++) {
                const col = lut[(d.returns[i] >> shift) & 15];
                const c = i * 4;
                out[c] = col[0]; out[c + 1] = col[1]; out[c + 2] = col[2]; out[c + 3] = 255;
            }
        } else if (mode === "source-id") {
            const cache = new Map();
            for (let i = 0; i < n; i++) {
                const id = d.source[i];
                let col = cache.get(id);
                if (!col) { col = hashColor(id); cache.set(id, col); }
                const c = i * 4;
                out[c] = col[0]; out[c + 1] = col[1]; out[c + 2] = col[2]; out[c + 3] = 255;
            }
        }
    }

    /* SWISSIMAGE: bake once per raster, keep the result. */
    async function bakeSwissImage(cloud, force) {
        const d = cloud.userData.data;

        if (!swissImageRasterIsCurrent() || force) {
            if (force) {
                SWISSIMAGE_RGB.raster = null;
                SWISSIMAGE_RGB.cache.clear();
            }
            setStatus("Preparing SWISSIMAGE…");
            await prepareSwissImageRaster();
        }

        const raster = SWISSIMAGE_RGB.raster;

        if (d.swissRasterId === raster.id && d.swissRgba) {
            return;
        }

        const mapper = getSwissMapper(raster);
        const { N, gx, gy, minE, minN } = mapper;
        const invE = N / (mapper.maxE - minE);
        const invN = N / (mapper.maxN - minN);
        const stride = N + 1;

        const scaleX = raster.width / (raster.worldMaxX - raster.worldMinX);
        const scaleY = raster.height / (raster.worldMaxY - raster.worldMinY);
        const rgb = raster.rgb;

        const rgba = d.swissRgba || new Uint8Array(d.count * 4);
        const pos = d.pos;
        const [ox, oy] = d.origin;

        let outside = 0;

        for (let start = 0; start < d.count; start += 500000) {
            const end = Math.min(start + 500000, d.count);

            for (let i = start; i < end; i++) {
                let u = (ox + pos[i * 3] - minE) * invE;
                let v = (oy + pos[i * 3 + 1] - minN) * invN;

                if (u < 0) u = 0; else if (u > N - 1e-9) u = N - 1e-9;
                if (v < 0) v = 0; else if (v > N - 1e-9) v = N - 1e-9;

                const gi = Math.floor(u), gj = Math.floor(v);
                const fu = u - gi, fv = v - gj;
                const k = gj * stride + gi;
                const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv);
                const w01 = (1 - fu) * fv, w11 = fu * fv;

                const mx = gx[k] * w00 + gx[k + 1] * w10 + gx[k + stride] * w01 + gx[k + stride + 1] * w11;
                const my = gy[k] * w00 + gy[k + 1] * w10 + gy[k + stride] * w01 + gy[k + stride + 1] * w11;

                const ix = Math.floor((mx - raster.worldMinX) * scaleX);
                const iy = Math.floor((raster.worldMaxY - my) * scaleY);
                const c = i * 4;

                if (ix < 0 || iy < 0 || ix >= raster.width || iy >= raster.height) {
                    rgba[c] = rgba[c + 1] = rgba[c + 2] = 128;
                    outside++;
                } else {
                    const p = (iy * raster.width + ix) * 3;
                    rgba[c] = rgb[p]; rgba[c + 1] = rgb[p + 1]; rgba[c + 2] = rgb[p + 2];
                }

                rgba[c + 3] = 255;
            }

            showSwissImageProgress(end, d.count, "Colouring tile…");
            await yieldToBrowser();
        }

        hideSwissImageProgress();

        d.swissRgba = rgba;
        d.swissRasterId = raster.id;

        const pct = (100 * outside) / d.count;

        setStatus(
            "SWISSIMAGE RGB applied" +
            (pct > 1 ? ` (${pct.toFixed(1)} % of points outside the raster)` : "") +
            (raster.failedTiles ? `; ${raster.failedTiles} map tile(s) could not be loaded` : "") +
            "."
        );
    }

    /* ============================================================
       Rendering
       ============================================================ */

    const VERTEX = `
        uniform float uSize;
        uniform float uMode;      // 0 fixed px, 1 attenuated, 2 adaptive
        uniform float uScale;     // viewport height / 2 * projection[1][1]
        uniform float uSpacing;   // effective point spacing in metres
        uniform float uDpr;
        uniform float uClipOn;
        uniform mat4 uClipInv;    // local point space -> section box space
        attribute vec4 aColor;
        varying vec4 vColor;
        varying float vClipped;

        void main() {
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mv;

            float px = uSize * uDpr;
            if (uMode > 1.5) {
                px = uSize * uSpacing * uScale / max(-mv.z, 0.01);
            } else if (uMode > 0.5) {
                px = uSize * 0.1 * uScale / max(-mv.z, 0.01);
            }
            gl_PointSize = clamp(px, 1.0, 48.0);

            vClipped = 0.0;
            if (uClipOn > 0.5) {
                vec3 c = (uClipInv * vec4(position, 1.0)).xyz;
                if (abs(c.x) > 0.5 || abs(c.y) > 0.5 || abs(c.z) > 0.5) vClipped = 1.0;
            }

            vColor = aColor;
        }
    `;

    const FRAGMENT = `
        uniform float uShape;     // 0 square, 1 circle
        uniform float uOpacity;
        varying vec4 vColor;
        varying float vClipped;

        void main() {
            if (vClipped > 0.5) discard;
            if (uShape > 0.5) {
                vec2 d = gl_PointCoord - vec2(0.5);
                if (dot(d, d) > 0.25) discard;
            }
            gl_FragColor = vec4(vColor.rgb, uOpacity);
        }
    `;

    function invertInto(target, source) {
        if (typeof target.invert === "function") {
            return target.copy(source).invert();
        }
        return target.getInverse(source);
    }

    function createCloud(data, header) {
        const geometry = new THREE.BufferGeometry();

        setAttr(geometry, "position", new THREE.BufferAttribute(data.pos, 3));
        setAttr(geometry, "aColor", new THREE.BufferAttribute(data.color, 4, true));

        const material = new THREE.ShaderMaterial({
            uniforms: {
                uSize: { value: 1.5 },
                uMode: { value: 2 },
                uScale: { value: 1000 },
                uSpacing: { value: 0.5 },
                uDpr: { value: window.devicePixelRatio || 1 },
                uShape: { value: 1 },
                uOpacity: { value: 1 },
                uClipOn: { value: 0 },
                uClipInv: { value: new THREE.Matrix4() }
            },
            vertexShader: VERTEX,
            fragmentShader: FRAGMENT
        });

        const points = new THREE.Points(geometry, material);

        // positions are relative to the tile's minimum corner (keeps float32 precise)
        points.position.set(data.origin[0], data.origin[1], data.origin[2]);
        points.updateMatrix();
        points.frustumCulled = false;

        points.isLaz = true;
        points.userData.data = data;
        points.boundingBox = new THREE.Box3(
            new THREE.Vector3(header.min[0], header.min[1], header.min[2]),
            new THREE.Vector3(header.max[0], header.max[1], header.max[2])
        );

        const inverse = new THREE.Matrix4();

        points.onBeforeRender = function (renderer, scene, camera) {
            const u = material.uniforms;
            const section = currentSection;

            // Potree derives near/far from its own point clouds; with only this
            // cloud in the scene they may be unset, so set them from our box.
            if (currentPointCloud === points && !(viewer?.scene?.pointclouds?.length > 0)) {
                const box = points.boundingBox;
                const radius = box.min.distanceTo(box.max) / 2;
                const center = box.min.clone().add(box.max).multiplyScalar(0.5);
                const distance = camera.position.distanceTo(center);
                const near = Math.max(distance - radius, 0.1);
                const far = distance + radius * 2;

                if (Math.abs(camera.near - near) > 1e-3 || Math.abs(camera.far - far) > 1e-3) {
                    camera.near = near;
                    camera.far = far;
                    camera.updateProjectionMatrix();
                }
            }

            u.uScale.value =
                (renderer.domElement.height / 2) * camera.projectionMatrix.elements[5];

            if (section?.volume && currentPointCloud === points) {
                section.volume.updateMatrixWorld(true);
                invertInto(inverse, section.volume.matrixWorld);
                u.uClipInv.value.copy(inverse).multiply(points.matrixWorld);
                u.uClipOn.value = 1;
            } else {
                u.uClipOn.value = 0;
            }
        };

        let colorToken = 0;

        points.lazSetColorMode = async function (mode, force = false) {
            const token = ++colorToken;

            try {
                if (mode === "swissimage") {
                    const upToDate =
                        !force &&
                        data.swissRgba &&
                        swissImageRasterIsCurrent() &&
                        data.swissRasterId === SWISSIMAGE_RGB.raster.id;

                    if (!upToDate) {
                        // the tile must not be switched while colours are computed
                        setBusy(true, "Colouring tile with SWISSIMAGE…");
                    }

                    try {
                        await bakeSwissImage(points, force);
                    } finally {
                        if (!upToDate) setBusy(false);
                    }

                    if (token !== colorToken) return;
                    data.color.set(data.swissRgba);
                } else {
                    fillColors(points, mode === "intensity-gradient" ? "intensity" : mode);
                }

                geometry.attributes.aColor.needsUpdate = true;
                data.mode = mode;
            } catch (error) {
                hideSwissImageProgress();
                console.error("[laz] colouring failed:", error);
                setStatus(`Colouring failed: ${error.message}`);
            }
        };

        // Appearance settings from ui.js
        points.lazApplyAppearance = function (s) {
            const u = material.uniforms;

            u.uSize.value = s.size;
            u.uShape.value = s.shape === "SQUARE" ? 0 : 1;
            u.uOpacity.value = s.opacity;
            u.uMode.value = s.sizeType === "FIXED" ? 0 : s.sizeType === "ATTENUATED" ? 1 : 2;

            material.transparent = s.opacity < 1;

            const shown = Math.max(1, Math.min(data.count, Math.round(s.budget * 1e6)));

            geometry.setDrawRange(0, shown);

            // thinner display -> larger effective spacing (keeps the surface closed)
            u.uSpacing.value = data.spacing * Math.sqrt(data.count / shown);
            points.userData.shown = shown;
        };

        points.lazFit = function () {
            const box = points.boundingBox;
            const size = box.max.clone().sub(box.min);
            const center = box.min.clone().add(box.max).multiplyScalar(0.5);
            const reach = Math.max(size.x, size.y) * 0.9;

            const position = new THREE.Vector3(center.x, center.y - reach, center.z + reach * 0.8);

            try {
                viewer.scene.view.setView(position, center, 400);
            } catch (error) {
                viewer.scene.view.position.copy(position);
                viewer.scene.view.lookAt(center);
            }
        };

        points.lazDispose = function () {
            geometry.dispose();
            material.dispose();
            if (points.parent) points.parent.remove(points);
            data.pos = data.color = data.swissRgba = null;
            points.userData.lazBuffer = null;
        };

        return points;
    }

    /* ============================================================
       Load
       ============================================================ */

    async function buildData(source, job) {
        const header = source.header;
        const n = header.count;
        const fmt = header.format;
        const ext = fmt >= 6;
        const rec = header.recordLength;

        if (rec < 20 || fmt > 10) {
            throw new Error(`Unsupported LAS point format ${fmt}.`);
        }

        const data = {
            count: n,
            origin: [header.min[0], header.min[1], header.min[2]],
            pos: new Float32Array(n * 3),
            color: new Uint8Array(n * 4),
            intensity: new Uint16Array(n),
            cls: new Uint8Array(n),
            returns: new Uint8Array(n),        // return number | number of returns << 4
            source: new Uint16Array(n),
            swissRgba: null,
            swissRasterId: null,
            mode: null,
            iMax: 1, zLo: header.min[2], zHi: header.max[2], spacing: 0.5
        };

        // random slot for every point: a buffer prefix is then an even sample
        const slot = new Uint32Array(n);
        for (let i = 0; i < n; i++) slot[i] = i;
        for (let i = n - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const t = slot[i]; slot[i] = slot[j]; slot[j] = t;
        }

        const [sx, sy, sz] = header.scale;
        const [ox, oy, oz] = header.offset;
        const [mx, my, mz] = data.origin;

        await source.run((u, base, count, first) => {
            if (job?.cancelled) {
                throw new Error("Loading cancelled.");
            }

            for (let k = 0; k < count; k++) {
                const p = base + k * rec;
                const s = slot[first + k];

                const x = (u[p] | (u[p + 1] << 8) | (u[p + 2] << 16) | (u[p + 3] << 24));
                const y = (u[p + 4] | (u[p + 5] << 8) | (u[p + 6] << 16) | (u[p + 7] << 24));
                const z = (u[p + 8] | (u[p + 9] << 8) | (u[p + 10] << 16) | (u[p + 11] << 24));

                data.pos[s * 3] = x * sx + ox - mx;
                data.pos[s * 3 + 1] = y * sy + oy - my;
                data.pos[s * 3 + 2] = z * sz + oz - mz;

                data.intensity[s] = u[p + 12] | (u[p + 13] << 8);

                const b = u[p + 14];
                data.returns[s] = ext
                    ? ((b & 15) | ((b >> 4) << 4))
                    : ((b & 7) | (((b >> 3) & 7) << 4));

                data.cls[s] = ext ? u[p + 16] : (u[p + 15] & 31);
                data.source[s] = ext
                    ? (u[p + 20] | (u[p + 21] << 8))
                    : (u[p + 18] | (u[p + 19] << 8));
            }
        }, (done, total) => showSwissImageProgress(done, total, "Decoding LAZ…"));

        hideSwissImageProgress();

        // display scales from a sample
        const step = Math.max(1, Math.floor(n / 50000));
        const iv = [], zv = [];

        for (let i = 0; i < n; i += step) {
            iv.push(data.intensity[i]);
            zv.push(data.pos[i * 3 + 2] + mz);
        }

        iv.sort((a, b) => a - b);
        zv.sort((a, b) => a - b);

        data.iMax = Math.max(1, iv[Math.floor(iv.length * 0.99)] || 1);
        data.zLo = zv[Math.floor(zv.length * 0.01)];
        data.zHi = zv[Math.floor(zv.length * 0.99)];

        const area = Math.max((header.max[0] - header.min[0]) * (header.max[1] - header.min[1]), 1);
        data.spacing = Math.sqrt(area / n);

        return data;
    }

    function showInfo(cloud) {
        const d = cloud.userData.data;

        updateSelectedAttributes([
            { name: "points (all kept)", type: d.count.toLocaleString(), numElements: "" },
            { name: "position", type: "float32", numElements: 3 },
            { name: "intensity", type: "uint16", numElements: 1 },
            { name: "classification", type: "uint8", numElements: 1 },
            { name: "return number", type: "uint8", numElements: 1 },
            { name: "point source id", type: "uint16", numElements: 1 }
        ]);

        const info = getEl("selected-info");
        if (info) info.textContent = `LAZ · ${d.count.toLocaleString()} points`;
    }

    window.loadLazTile = async function (url) {
        const existing = loadedPointClouds.get(url);

        if (existing?.isLaz) {
            currentPointCloud = existing;
            showInfo(existing);
            fitCurrentPointCloud();
            updateControlState();
            setStatus("Tile already loaded.");
            return;
        }

        enforcePointCloudLimit();

        // Lock the whole app until the tile is completely loaded (or cancelled).
        const job = { cancelled: false, controller: new AbortController() };

        setBusy(true, "Downloading tile…", () => {
            job.cancelled = true;
            job.controller.abort();
            setStatus("Cancelling…");
        });

        try {
            setStatus("Downloading tile…");

            const buffer = await fetchBuffer(
                url,
                (got, total) => showSwissImageProgress(got, total, "Downloading…"),
                job.controller.signal
            );

            hideSwissImageProgress();

            const source = await openPointSource(buffer);
            const header = source.header;

            if (!header.count || header.count > MAX_POINTS) {
                throw new Error(`Unsupported point count (${header.count}).`);
            }

            setStatus(
                (source.kind === "zip" ? "Unpacking and reading " : "Decoding ") +
                `${header.count.toLocaleString()} points…`
            );

            const data = await buildData(source, job);
            const cloud = createCloud(data, header);

            cloud.userData.lazBuffer = buffer;      // (zip or laz) kept for the full-resolution export
            cloud.userData.lazHeader = header;
            cloud.userData.lazUrl = url;

            viewer.scene.scene.add(cloud);
            loadedPointClouds.set(url, cloud);
            currentPointCloud = cloud;

            fillColors(cloud, "intensity");
            data.mode = "intensity";
            updateDisplayedColorMode("intensity");

            window.applyAppearance?.(cloud);

            showInfo(cloud);
            fitCurrentPointCloud();
            updateControlState();

            setStatus(`Tile loaded: ${header.count.toLocaleString()} points.`);
        } catch (error) {
            hideSwissImageProgress();

            if (job.cancelled || error?.name === "AbortError") {
                setStatus("Loading cancelled.");
            } else {
                console.error("[laz] loading failed:", error);
                setStatus(`Loading failed: ${error.message}`);
            }

            updateControlState();
        } finally {
            setBusy(false);
        }
    };

    // Used by export.js
    window.swissLaz = { parseLasHeader, decodeLaz, fetchBuffer, openPointSource };
})();
