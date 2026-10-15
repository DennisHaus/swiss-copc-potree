/*
 * Swiss LiDAR Viewer - 3D print files (STL)
 *
 * For a freely placed print area (up to 2 x 2 km, across tile borders -
 * e.g. over the corner of four tiles): terrain from swissALTI3D, buildings
 * from swissBUILDINGS3D, as a closed solid (watertight, printable):
 *
 *   positive   the model itself: top surface, side walls, flat base
 *   negative   casting mould: the inverted surface, mirrored, with a rim
 *              around it - pour into it, turn the cast over: positive
 *
 * Everything is turned into a height raster (top view, highest surface per
 * cell) first, so the result is always closed and has no overhangs (roof
 * overhangs become vertical). Units: millimetres at the chosen scale.
 */

(function () {
    "use strict";

    const el = id => document.getElementById(id);

    /* ============================================================
       Solid from a height field
       ============================================================ */

    /*
     * top(i, j): height in mm of vertex (i, j), i < nx, j < ny, spacing step
     * mm. Returns triangles (Float32Array, 9 numbers each), outward facing.
     */
    function solid(nx, ny, step, top) {
        const tris = [];
        const tri = (a, b, c) => tris.push(...a, ...b, ...c);
        const P = (i, j) => [i * step, j * step, top(i, j)];
        const B = (i, j) => [i * step, j * step, 0];

        // top: counter-clockwise from above (normal up)
        for (let j = 0; j < ny - 1; j++) {
            for (let i = 0; i < nx - 1; i++) {
                tri(P(i, j), P(i + 1, j), P(i + 1, j + 1));
                tri(P(i, j), P(i + 1, j + 1), P(i, j + 1));
            }
        }

        // walls: along the boundary, normal outward
        for (let i = 0; i < nx - 1; i++) {                 // south (j = 0), normal -y
            tri(B(i, 0), B(i + 1, 0), P(i + 1, 0));
            tri(B(i, 0), P(i + 1, 0), P(i, 0));
        }
        for (let i = 0; i < nx - 1; i++) {                 // north (j = ny-1), normal +y
            const j = ny - 1;
            tri(B(i + 1, j), B(i, j), P(i, j));
            tri(B(i + 1, j), P(i, j), P(i + 1, j));
        }
        for (let j = 0; j < ny - 1; j++) {                 // west (i = 0), normal -x
            tri(B(0, j + 1), B(0, j), P(0, j));
            tri(B(0, j + 1), P(0, j), P(0, j + 1));
        }
        for (let j = 0; j < ny - 1; j++) {                 // east (i = nx-1), normal +x
            const i = nx - 1;
            tri(B(i, j), B(i, j + 1), P(i, j + 1));
            tri(B(i, j), P(i, j + 1), P(i, j));
        }

        // base: fan from its centre to every boundary vertex (normal down)
        const centre = [(nx - 1) * step / 2, (ny - 1) * step / 2, 0];
        const ring = [];
        for (let i = 0; i < nx - 1; i++) ring.push(B(i, 0));
        for (let j = 0; j < ny - 1; j++) ring.push(B(nx - 1, j));
        for (let i = nx - 1; i > 0; i--) ring.push(B(i, ny - 1));
        for (let j = ny - 1; j > 0; j--) ring.push(B(0, j));
        for (let r = 0; r < ring.length; r++) tri(centre, ring[(r + 1) % ring.length], ring[r]);

        return new Float32Array(tris);
    }

    /*
     * raster -> solid in mm. options: scale (e.g. 2000 for 1:2000),
     * exaggeration, base (mm), negative (bool), rim (mm).
     */
    function printSolid(raster, { scale, exaggeration = 1, base = 5, negative = false, rim = 4 }) {
        const { nx, ny, cell, z } = raster;
        let lo = Infinity, hi = -Infinity;
        for (const v of z) { if (v < lo) lo = v; if (v > hi) hi = v; }

        const mm = 1000 / scale;                          // metres -> mm
        const relief = (hi - lo) * exaggeration * mm;
        const step = cell * mm;

        if (!negative) {
            return {
                triangles: solid(nx, ny, step, (i, j) => base + (z[j * nx + i] - lo) * exaggeration * mm),
                size: [(nx - 1) * step, (ny - 1) * step, base + relief]
            };
        }

        // mould: inverted and mirrored surface, plus a rim to pour against
        const r = Math.max(1, Math.round(rim / step));
        const NX = nx + 2 * r, NY = ny + 2 * r;
        const rimTop = base + relief + 3;

        const top = (i, j) => {
            const ii = i - r, jj = j - r;
            if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) return rimTop;
            const src = (ny - 1 - jj) * nx + ii;             // mirrored north-south
            return base + (hi - z[src]) * exaggeration * mm;
        };

        return { triangles: solid(NX, NY, step, top), size: [(NX - 1) * step, (NY - 1) * step, rimTop] };
    }

    /* ============================================================
       Binary STL
       ============================================================ */

    function stl(triangles, label) {
        const count = triangles.length / 9;
        const buffer = new ArrayBuffer(84 + count * 50);
        const dv = new DataView(buffer);
        const header = `Swiss LiDAR Viewer: ${label}`.slice(0, 79);
        for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
        dv.setUint32(80, count, true);

        let o = 84;
        for (let t = 0; t < triangles.length; t += 9) {
            const ax = triangles[t + 3] - triangles[t], ay = triangles[t + 4] - triangles[t + 1], az = triangles[t + 5] - triangles[t + 2];
            const bx = triangles[t + 6] - triangles[t], by = triangles[t + 7] - triangles[t + 1], bz = triangles[t + 8] - triangles[t + 2];
            let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
            const len = Math.hypot(nx, ny, nz) || 1;
            dv.setFloat32(o, nx / len, true); dv.setFloat32(o + 4, ny / len, true); dv.setFloat32(o + 8, nz / len, true);
            o += 12;
            for (let k = 0; k < 9; k++) { dv.setFloat32(o, triangles[t + k], true); o += 4; }
            o += 2;
        }

        return buffer;
    }

    /* ============================================================
       Print area (movable, independent of the loaded tile)
       ============================================================ */

    const MAX_SIDE = 2000;
    const area = { cE: NaN, cN: NaN, w: 1000, h: 1000 };
    let mapShape = null, outline = null;

    const bounds = () => ({ minE: area.cE - area.w / 2, maxE: area.cE + area.w / 2, minN: area.cN - area.h / 2, maxN: area.cN + area.h / 2 });

    function defaultArea() {
        const S = window.swissSurfaces?.current();
        if (S) {
            area.cE = S.minE + S.cell * (S.nx - 1) / 2;
            area.cN = S.minN + S.cell * (S.ny - 1) / 2;
            return;
        }
        try {
            const pivot = viewer.scene.view.getPivot();
            if (pivot && Number.isFinite(pivot.x)) { area.cE = Math.round(pivot.x); area.cN = Math.round(pivot.y); return; }
        } catch (error) { /* tile */ }
        const id = typeof swissKmTileId === "function" && swissKmTileId(currentTile);
        if (id) { const [e, n] = id.split("-").map(Number); area.cE = e * 1000 + 500; area.cN = n * 1000 + 500; }
    }

    function syncInputs() {
        if (el("print-ce")) el("print-ce").value = Math.round(area.cE);
        if (el("print-cn")) el("print-cn").value = Math.round(area.cN);
        if (el("print-w")) el("print-w").value = Math.round(area.w);
        if (el("print-h")) el("print-h").value = Math.round(area.h);
    }

    function readInputs() {
        const num = (id, fallback) => { const v = Number(el(id)?.value); return Number.isFinite(v) ? v : fallback; };
        area.cE = num("print-ce", area.cE);
        area.cN = num("print-cn", area.cN);
        area.w = Math.min(MAX_SIDE, Math.max(50, num("print-w", area.w)));
        area.h = Math.min(MAX_SIDE, Math.max(50, num("print-h", area.h)));
    }

    /* Rectangle on the 2D map: drag it to move the print area. */
    function drawOnMap() {
        if (typeof map === "undefined" || !map || typeof L === "undefined" || !Number.isFinite(area.cE)) return;
        const b = bounds();
        const latlngs = [[b.minE, b.minN], [b.maxE, b.minN], [b.maxE, b.maxN], [b.minE, b.maxN]]
            .map(c => { const [lon, lat] = proj4("EPSG:2056", "EPSG:4326", c); return [lat, lon]; });

        if (!mapShape) {
            mapShape = L.polygon(latlngs, { color: "#d9622b", weight: 2, fillOpacity: 0.08, dashArray: "6 4" }).addTo(map);
            mapShape.bindTooltip("3D print area – drag to move");

            mapShape.on("mousedown", start => {
                L.DomEvent.stop(start);
                map.dragging.disable();
                const [e0, n0] = proj4("EPSG:4326", "EPSG:2056", [start.latlng.lng, start.latlng.lat]);
                const c0 = [area.cE, area.cN];

                const move = ev => {
                    const [e, n] = proj4("EPSG:4326", "EPSG:2056", [ev.latlng.lng, ev.latlng.lat]);
                    area.cE = c0[0] + (e - e0);
                    area.cN = c0[1] + (n - n0);
                    syncInputs();
                    drawOnMap();
                };
                const end = () => {
                    map.off("mousemove", move);
                    map.off("mouseup", end);
                    map.dragging.enable();
                    update();
                };
                map.on("mousemove", move);
                map.on("mouseup", end);
            });
        } else {
            mapShape.setLatLngs(latlngs);
        }
    }

    /* Frame in the 3D view. */
    function drawOutline() {
        if (outline) { outline.parent?.remove(outline); outline.geometry.dispose(); outline.material.dispose(); outline = null; }
        if (!el("print-show")?.checked || !viewer?.scene?.scene || !Number.isFinite(area.cE)) return;

        const b = bounds();
        const height = (e, n) => {
            const z = window.swissSurfaces?.terrainAt(e, n);
            if (z === z && z !== undefined) return z;
            const a = typeof swissAltiAt === "function" ? swissAltiAt(e, n) : NaN;
            if (a === a) return a;
            try { return viewer.scene.view.getPivot().z; } catch (error) { return 0; }
        };

        // the frame follows the terrain along its edges
        const pts = [];
        const edge = (e0, n0, e1, n1) => {
            for (let k = 0; k < 40; k++) {
                const t = k / 40, e = e0 + (e1 - e0) * t, n = n0 + (n1 - n0) * t;
                pts.push(e - area.cE, n - area.cN, height(e, n) + 1.5);
            }
        };
        edge(b.minE, b.minN, b.maxE, b.minN); edge(b.maxE, b.minN, b.maxE, b.maxN);
        edge(b.maxE, b.maxN, b.minE, b.maxN); edge(b.minE, b.maxN, b.minE, b.minN);

        const z0 = pts[2];
        for (let i = 2; i < pts.length; i += 3) pts[i] -= z0;

        const g = new THREE.BufferGeometry();
        const attr = new THREE.Float32BufferAttribute(pts, 3);
        if (typeof g.setAttribute === "function") g.setAttribute("position", attr); else g.addAttribute("position", attr);
        outline = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0xd9622b }));
        outline.name = "swiss-print-area";
        outline.position.set(area.cE, area.cN, z0);
        viewer.scene.scene.add(outline);
    }

    function info() {
        const box = el("print-info");
        if (!box) return;
        if (!Number.isFinite(area.cE)) { box.textContent = "Load a tile to place the print area."; return; }
        const { scale } = settings();
        const b = bounds();
        const tiles = (Math.floor((b.maxE - 1e-6) / 1000) - Math.floor(b.minE / 1000) + 1) * (Math.floor((b.maxN - 1e-6) / 1000) - Math.floor(b.minN / 1000) + 1);
        box.textContent = `Print size: ${Math.round(area.w * 1000 / scale)} × ${Math.round(area.h * 1000 / scale)} mm ` +
            `(${Math.round(area.w)} × ${Math.round(area.h)} m at 1:${scale.toLocaleString()}), covers ${tiles} km tile${tiles > 1 ? "s" : ""}.`;
    }

    function update() {
        drawOnMap();
        drawOutline();
        info();
    }

    /* ============================================================
       Export
       ============================================================ */

    function settings() {
        return {
            scale: Number(el("print-scale")?.value || 2000),
            exaggeration: Number(el("print-exag")?.value || 1),
            base: Number(el("print-base")?.value || 5),
            maxCells: Number(el("print-detail")?.value || 500)
        };
    }

    let busy = false;

    async function exportPrint(withBuildings, negative) {
        if (busy) return;
        readInputs();
        if (!Number.isFinite(area.cE)) { setStatus("Place the print area first."); return; }

        busy = true;
        const o = settings();
        const b = bounds();

        try {
            const cell = Math.max(0.5, Math.max(area.w, area.h) / o.maxCells);
            const gsd = cell < 1.5 ? 0.5 : 2;

            const terrain = await swissLoadAltiArea(b, gsd, text => setStatus(text));
            if (terrain.missing === terrain.tiles) throw new Error("no swissALTI3D terrain for this area");

            const nx = Math.max(2, Math.floor(area.w / cell)), ny = Math.max(2, Math.floor(area.h / cell));
            const z = new Float32Array(nx * ny);
            for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
                z[j * nx + i] = terrain.at(b.minE + (i + 0.5) * cell, b.minN + (j + 0.5) * cell);
            }
            window.swissSurfaces.fillGaps(z, nx, ny);

            let buildingNote = "";
            if (withBuildings) {
                const B = await window.swissBuildings3D.loadBuildings({
                    area: b, terrainAt: (e, n) => terrain.at(e, n), onProgress: text => setStatus(text)
                });

                // LiDAR-checked offset from the surfaces, if available
                const shift = window.swissSurfaces?.current()?.check?.shift || 0;

                // rasterise finely (max 1 m), then the highest value per print cell
                const fine = Math.min(1, cell);
                const grid = { minE: b.minE, minN: b.minN, cell: fine, nx: Math.ceil(area.w / fine), ny: Math.ceil(area.h / fine) };
                window.swissSurfaces.rasteriseTriangles(B.triangles, grid);

                for (let gj = 0; gj < grid.ny; gj++) for (let gi = 0; gi < grid.nx; gi++) {
                    const h = grid.z[gj * grid.nx + gi];
                    if (!(h === h)) continue;
                    const i = Math.min(nx - 1, Math.floor(gi * fine / cell)), j = Math.min(ny - 1, Math.floor(gj * fine / cell));
                    if (h + shift > z[j * nx + i]) z[j * nx + i] = h + shift;
                }
                buildingNote = `, ${(B.triangles.length / 9).toLocaleString()} building faces`;
            }

            const result = printSolid({ nx, ny, cell, z }, { ...o, negative });
            const label = `${withBuildings ? "terrain+buildings" : "terrain"}_${negative ? "negative-mould" : "positive"}_1-${o.scale}` +
                (o.exaggeration !== 1 ? `_x${o.exaggeration}` : "");

            const blob = new Blob([stl(result.triangles, label)], { type: "model/stl" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `print_E${Math.round(area.cE)}_N${Math.round(area.cN)}_${label}.stl`;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);

            window.usageCounter?.hit("downloads");
            setStatus(
                `STL saved: ${result.size.map(v => Math.round(v)).join(" × ")} mm, ` +
                `${(result.triangles.length / 9).toLocaleString()} triangles, ${terrain.tiles} terrain tile(s)${buildingNote}` +
                (terrain.missing ? ` – ${terrain.missing} tile(s) without terrain` : "") +
                (negative ? " (mould: mirrored, pour and turn over)." : ".")
            );
        } catch (error) {
            console.error("[print]", error);
            setStatus(`3D print failed: ${error.message}`);
        } finally {
            busy = false;
        }
    }

    document.addEventListener("DOMContentLoaded", () => {
        el("print-terrain-pos")?.addEventListener("click", () => exportPrint(false, false));
        el("print-terrain-neg")?.addEventListener("click", () => exportPrint(false, true));
        el("print-all-pos")?.addEventListener("click", () => exportPrint(true, false));
        el("print-all-neg")?.addEventListener("click", () => exportPrint(true, true));

        for (const id of ["print-ce", "print-cn", "print-w", "print-h"]) {
            el(id)?.addEventListener("change", () => { readInputs(); syncInputs(); update(); });
        }
        for (const id of ["print-scale", "print-exag", "print-base", "print-detail"]) el(id)?.addEventListener("change", info);
        el("print-show")?.addEventListener("change", drawOutline);
        el("print-here")?.addEventListener("click", () => {
            try {
                const pivot = viewer.scene.view.getPivot();
                area.cE = Math.round(pivot.x); area.cN = Math.round(pivot.y);
            } catch (error) { defaultArea(); }
            syncInputs(); update();
        });

        // nudge buttons: data-move="dx,dy" in metres
        document.querySelectorAll("[data-print-move]").forEach(button => button.addEventListener("click", () => {
            const [dx, dy] = button.dataset.printMove.split(",").map(Number);
            readInputs(); area.cE += dx; area.cN += dy; syncInputs(); update();
        }));

        // place the area as soon as there is something to place it on
        const timer = setInterval(() => {
            if (!Number.isFinite(area.cE) && (currentTile || window.swissSurfaces?.current())) {
                defaultArea(); syncInputs(); update();
            }
            if (Number.isFinite(area.cE)) clearInterval(timer);
        }, 1000);
        el("surf-build")?.addEventListener("click", () => setTimeout(() => { if (!Number.isFinite(area.cE)) defaultArea(); syncInputs(); update(); }, 1500));
    });

    window.swissPrint = { printSolid, solid, stl, area };
})();
