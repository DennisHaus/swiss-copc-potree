/*
 * Swiss LiDAR Viewer - 3D print files (STL)
 *
 * From the current surfaces (surfaces.js): terrain, or terrain with
 * buildings, as a closed solid (watertight, printable):
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
       Height raster
       ============================================================ */

    /*
     * S: surfaces model. Returns { nx, ny, cell, z } with z in metres for the
     * cell centres; buildings: highest of terrain and building per cell.
     */
    function heightRaster(S, maxCells, withBuildings) {
        const width = S.cell * (S.nx - 1), height = S.cell * (S.ny - 1);
        const cell = Math.max(S.cell, Math.max(width, height) / maxCells);
        const nx = Math.max(2, Math.floor(width / cell)), ny = Math.max(2, Math.floor(height / cell));
        const z = new Float32Array(nx * ny);

        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                z[j * nx + i] = window.swissSurfaces.terrainAt(S.minE + (i + 0.5) * cell, S.minN + (j + 0.5) * cell);
            }
        }

        if (withBuildings && S.buildingGrid?.z) {
            const g = S.buildingGrid;
            // highest building height inside each print cell
            for (let gj = 0; gj < g.ny; gj++) {
                for (let gi = 0; gi < g.nx; gi++) {
                    const h = g.z[gj * g.nx + gi];
                    if (!(h === h)) continue;
                    const e = g.minE + (gi + 0.5) * g.cell, n = g.minN + (gj + 0.5) * g.cell;
                    const i = Math.floor((e - S.minE) / cell), j = Math.floor((n - S.minN) / cell);
                    if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
                    if (h > z[j * nx + i]) z[j * nx + i] = h;
                }
            }
        }

        return { nx, ny, cell, z };
    }

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
       UI
       ============================================================ */

    function settings() {
        return {
            scale: Number(el("print-scale")?.value || 2000),
            exaggeration: Number(el("print-exag")?.value || 1),
            base: Number(el("print-base")?.value || 5),
            maxCells: Number(el("print-detail")?.value || 500)
        };
    }

    function info() {
        const S = window.swissSurfaces?.current();
        const box = el("print-info");
        if (!box) return;
        if (!S) { box.textContent = "Build surfaces first – the print uses the same area."; return; }
        const { scale } = settings();
        const w = S.cell * (S.nx - 1), h = S.cell * (S.ny - 1);
        box.textContent = `Print size: ${Math.round(w * 1000 / scale)} × ${Math.round(h * 1000 / scale)} mm ` +
            `(${Math.round(w)} × ${Math.round(h)} m at 1:${scale.toLocaleString()}).`;
    }

    function exportPrint(withBuildings, negative) {
        const S = window.swissSurfaces?.current();
        if (!S) { setStatus("Build surfaces first – the print uses the same area."); return; }

        const o = settings();
        setStatus("Preparing 3D print…");

        setTimeout(() => {
            try {
                const raster = heightRaster(S, o.maxCells, withBuildings);
                const result = printSolid(raster, { ...o, negative });
                const label = `${withBuildings ? "terrain+buildings" : "terrain"}_${negative ? "negative-mould" : "positive"}_1-${o.scale}` +
                    (o.exaggeration !== 1 ? `_x${o.exaggeration}` : "");
                const tile = (typeof swissKmTileId === "function" && swissKmTileId(currentTile)) || "tile";

                const blob = new Blob([stl(result.triangles, label)], { type: "model/stl" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `print_${tile}_${label}.stl`;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);

                window.usageCounter?.hit("downloads");
                setStatus(
                    `STL saved: ${result.size.map(v => Math.round(v)).join(" × ")} mm, ` +
                    `${(result.triangles.length / 9).toLocaleString()} triangles` +
                    (negative ? " (mould: mirrored, pour and turn over)." : ".")
                );
            } catch (error) {
                console.error("[print]", error);
                setStatus(`3D print failed: ${error.message}`);
            }
        }, 30);
    }

    document.addEventListener("DOMContentLoaded", () => {
        el("print-terrain-pos")?.addEventListener("click", () => exportPrint(false, false));
        el("print-terrain-neg")?.addEventListener("click", () => exportPrint(false, true));
        el("print-all-pos")?.addEventListener("click", () => exportPrint(true, false));
        el("print-all-neg")?.addEventListener("click", () => exportPrint(true, true));
        for (const id of ["print-scale", "print-exag", "print-base", "print-detail"]) el(id)?.addEventListener("change", info);
        el("surf-build")?.addEventListener("click", () => setTimeout(info, 500));
        setInterval(info, 2000);
    });

    window.swissPrint = { heightRaster, printSolid, solid, stl };
})();
