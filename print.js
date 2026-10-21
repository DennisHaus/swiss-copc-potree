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
 * Terrain: a closed height-field solid from swissALTI3D at up to its native
 * 0.5 m (the terrain data IS a height raster, so this is exact).
 *
 * Buildings: the ORIGINAL swissBUILDINGS3D triangles - the same faces as in
 * the 3D view, not rasterised. Ground vertices are pushed into the terrain
 * (no gaps on slopes), cuts at the area edge get flat caps.
 *
 *   positive   terrain and buildings joined by an exact boolean union into
 *              one closed solid
 *   negative   rim block minus the model turned upside down (exact boolean
 *              subtraction), mirrored north-south as the cast comes out
 *
 * The booleans use manifold-3d (WebAssembly, loaded on demand). Buildings
 * that are not closed solids in the source data, or a failed library load,
 * fall back gracefully: separate shells (positive) or a 0.25 m raster (mould).
 *
 * Units: millimetres at the chosen scale.
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
        // heights once, triangles into one preallocated array (millions of
        // triangles would not fit into a plain JS array)
        const H = new Float32Array(nx * ny);
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) H[j * nx + i] = top(i, j);

        const count = 2 * (nx - 1) * (ny - 1) + 4 * (nx - 1) + 4 * (ny - 1) + 2 * (nx - 1) + 2 * (ny - 1);
        const tris = new Float32Array(count * 9);
        let o = 0;
        const v = (x, y, z) => { tris[o++] = x; tris[o++] = y; tris[o++] = z; };
        const P = (i, j) => v(i * step, j * step, H[j * nx + i]);
        const B = (i, j) => v(i * step, j * step, 0);

        // top: counter-clockwise from above (normal up)
        for (let j = 0; j < ny - 1; j++) {
            for (let i = 0; i < nx - 1; i++) {
                P(i, j); P(i + 1, j); P(i + 1, j + 1);
                P(i, j); P(i + 1, j + 1); P(i, j + 1);
            }
        }

        // walls: along the boundary, normal outward
        for (let i = 0; i < nx - 1; i++) {                 // south (j = 0), normal -y
            B(i, 0); B(i + 1, 0); P(i + 1, 0);
            B(i, 0); P(i + 1, 0); P(i, 0);
        }
        for (let i = 0, j = ny - 1; i < nx - 1; i++) {     // north (j = ny-1), normal +y
            B(i + 1, j); B(i, j); P(i, j);
            B(i + 1, j); P(i, j); P(i + 1, j);
        }
        for (let j = 0; j < ny - 1; j++) {                 // west (i = 0), normal -x
            B(0, j + 1); B(0, j); P(0, j);
            B(0, j + 1); P(0, j); P(0, j + 1);
        }
        for (let j = 0, i = nx - 1; j < ny - 1; j++) {     // east (i = nx-1), normal +x
            B(i, j); B(i, j + 1); P(i, j + 1);
            B(i, j); P(i, j + 1); P(i, j);
        }

        // base: fan from its centre to every boundary vertex (normal down)
        const cx = (nx - 1) * step / 2, cy = (ny - 1) * step / 2;
        const ring = [];
        for (let i = 0; i < nx - 1; i++) ring.push([i, 0]);
        for (let j = 0; j < ny - 1; j++) ring.push([nx - 1, j]);
        for (let i = nx - 1; i > 0; i--) ring.push([i, ny - 1]);
        for (let j = ny - 1; j > 0; j--) ring.push([0, j]);
        for (let r = 0; r < ring.length; r++) {
            const a = ring[(r + 1) % ring.length], b = ring[r];
            v(cx, cy, 0); B(a[0], a[1]); B(b[0], b[1]);
        }

        return tris;
    }

    /*
     * swissBUILDINGS3D triangles (LV95, metres) -> print triangles (mm), as
     * they are: clipped to the print area, ground vertices sunk into the
     * terrain so no gap opens on slopes, cuts at the area edge capped.
     * g: E0, N0, E1, N1 (extent of the terrain solid), lo (height at the
     * top of the base), base, mm, exaggeration, groundAt(e, n).
     */
    const GROUND_TOL = 0.75;   // m: vertices this close to the terrain are footings
    const SINK = 1.5;          // m: how deep footings go into the terrain

    function buildingTriangles(T, shift, g) {
        const out = [];
        const zmin = g.base * 0.5;

        const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        const planes = [
            [p => p[0] >= g.E0, (a, b) => lerp(a, b, (g.E0 - a[0]) / (b[0] - a[0]))],
            [p => p[0] <= g.E1, (a, b) => lerp(a, b, (g.E1 - a[0]) / (b[0] - a[0]))],
            [p => p[1] >= g.N0, (a, b) => lerp(a, b, (g.N0 - a[1]) / (b[1] - a[1]))],
            [p => p[1] <= g.N1, (a, b) => lerp(a, b, (g.N1 - a[1]) / (b[1] - a[1]))]
        ];
        const clip = (poly, keep, cut) => {
            const res = [];
            for (let k = 0; k < poly.length; k++) {
                const a = poly[k], b = poly[(k + 1) % poly.length];
                const ina = keep(a), inb = keep(b);
                if (ina) res.push(a);
                if (ina !== inb) res.push(cut(a, b));
            }
            return res;
        };

        const toPrint = ([e, n, z]) => {
            let h = z + shift;
            const ground = g.groundAt(e, n);
            if (ground === ground && h <= ground + GROUND_TOL) h = ground - SINK;
            return [(e - g.E0) * g.mm, (n - g.N0) * g.mm, Math.max(zmin, g.base + (h - g.lo) * g.exaggeration * g.mm)];
        };

        let top = 0;
        for (let t = 0; t + 8 < T.length; t += 9) {
            let poly = [[T[t], T[t + 1], T[t + 2]], [T[t + 3], T[t + 4], T[t + 5]], [T[t + 6], T[t + 7], T[t + 8]]];

            if (!poly.every(p => p[0] >= g.E0 && p[0] <= g.E1 && p[1] >= g.N0 && p[1] <= g.N1)) {
                for (const [keep, cut] of planes) { poly = clip(poly, keep, cut); if (poly.length < 3) break; }
                if (poly.length < 3) continue;
            }

            const P = poly.map(toPrint);
            for (let k = 1; k + 1 < P.length; k++) {
                out.push(...P[0], ...P[k], ...P[k + 1]);
                top = Math.max(top, P[0][2], P[k][2], P[k + 1][2]);
            }
        }

        capCuts(out, [(g.E1 - g.E0) * g.mm, (g.N1 - g.N0) * g.mm]);
        return { triangles: new Float32Array(out), top };
    }

    /*
     * Buildings cut by the print-area edge are open there. Find the open
     * edges lying in one of the four edge planes, chain them into loops and
     * close each loop with a flat cap (ear clipping), facing outward.
     */
    function capCuts(out, [X, Y]) {
        const eps = 1e-4, q = v => Math.round(v * 1e4);
        const pts = new Map(), edges = new Map();

        const vid = (x, y, z) => { const k = `${q(x)},${q(y)},${q(z)}`; if (!pts.has(k)) pts.set(k, [x, y, z]); return k; };
        for (let t = 0; t < out.length; t += 9) {
            const ids = [vid(out[t], out[t + 1], out[t + 2]), vid(out[t + 3], out[t + 4], out[t + 5]), vid(out[t + 6], out[t + 7], out[t + 8])];
            for (let k = 0; k < 3; k++) {
                const a = ids[k], b = ids[(k + 1) % 3], rev = `${b}|${a}`;
                if (edges.has(rev)) edges.delete(rev); else edges.set(`${a}|${b}`, [a, b]);
            }
        }

        const planes = [
            { on: p => Math.abs(p[0]) < eps, uv: p => [p[1], p[2]], n: [-1, 0, 0] },
            { on: p => Math.abs(p[0] - X) < eps, uv: p => [p[1], p[2]], n: [1, 0, 0] },
            { on: p => Math.abs(p[1]) < eps, uv: p => [p[0], p[2]], n: [0, -1, 0] },
            { on: p => Math.abs(p[1] - Y) < eps, uv: p => [p[0], p[2]], n: [0, 1, 0] }
        ];

        for (const plane of planes) {
            // open edges in this plane; the cap runs along them in reverse
            const next = new Map();
            for (const [a, b] of edges.values()) {
                if (plane.on(pts.get(a)) && plane.on(pts.get(b))) next.set(b, a);
            }

            while (next.size) {
                const start = next.keys().next().value;
                const loop = [];
                let cur = start;
                while (next.has(cur) && loop.length < 100000) {
                    loop.push(cur);
                    const nxt = next.get(cur);
                    next.delete(cur);
                    cur = nxt;
                }
                if (cur !== start || loop.length < 3) continue;     // not a closed loop: leave it

                const P3 = loop.map(k => pts.get(k));
                for (const [a, b, c] of earClip(P3.map(plane.uv))) {
                    const A = P3[a];
                    let B = P3[b], C = P3[c];
                    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
                    const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
                    const dot = (uy * vz - uz * vy) * plane.n[0] + (uz * vx - ux * vz) * plane.n[1] + (ux * vy - uy * vx) * plane.n[2];
                    if (dot < 0) [B, C] = [C, B];
                    out.push(...A, ...B, ...C);
                }
            }
        }
    }

    /* Ear clipping of a simple polygon (2D); returns index triples. */
    function earClip(poly) {
        const n = poly.length;
        let area = 0;
        for (let i = 0, j = n - 1; i < n; j = i++) area += (poly[j][0] - poly[i][0]) * (poly[j][1] + poly[i][1]);
        const idx = [...Array(n).keys()];
        if (area < 0) idx.reverse();                              // make it counter-clockwise

        const EPS = 1e-9;
        const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        // strictly inside: points on an edge (straight runs of the outline) do not block an ear
        const inTri = (p, a, b, c) => cross(a, b, p) > EPS && cross(b, c, p) > EPS && cross(c, a, p) > EPS;
        const tris = [];

        for (let guard = 0; idx.length > 3 && guard < n * n; guard++) {
            let clipped = false;
            for (let k = 0; k < idx.length; k++) {
                const ia = idx[(k + idx.length - 1) % idx.length], ib = idx[k], ic = idx[(k + 1) % idx.length];
                const a = poly[ia], b = poly[ib], c = poly[ic];
                if (cross(a, b, c) <= EPS) continue;              // reflex or straight: not an ear tip
                if (idx.some(i => i !== ia && i !== ib && i !== ic && inTri(poly[i], a, b, c))) continue;
                tris.push([ia, ib, ic]);
                idx.splice(k, 1);
                clipped = true;
                break;
            }
            if (!clipped) break;
        }
        if (idx.length === 3 && Math.abs(cross(poly[idx[0]], poly[idx[1]], poly[idx[2]])) > EPS) tris.push(idx);

        // vertices on straight runs end up on a triangle edge instead of a
        // corner: split that triangle so the cap meets the walls edge to edge
        const used = new Set(tris.flat());
        for (let v = 0; v < n; v++) {
            if (used.has(v)) continue;
            const p = poly[v];
            for (let t = 0; t < tris.length; t++) {
                const T = tris[t];
                let done = false;
                for (let k = 0; k < 3; k++) {
                    const a = poly[T[k]], b = poly[T[(k + 1) % 3]];
                    const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
                    const along = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / len2;
                    if (along <= 0 || along >= 1 || Math.abs(cross(a, b, p)) > 1e-6 * Math.sqrt(len2)) continue;
                    const r = T[(k + 2) % 3];
                    tris.splice(t, 1, [T[k], v, r], [v, T[(k + 1) % 3], r]);
                    done = true;
                    break;
                }
                if (done) break;
            }
        }
        return tris;
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
                size: [(nx - 1) * step, (ny - 1) * step, base + relief],
                lo, mm
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
       Exact booleans (manifold-3d, WebAssembly, loaded on demand)
       ============================================================ */

    // pinned; ES module that fetches manifold.wasm from the same folder
    const MANIFOLD_URL = "https://cdn.jsdelivr.net/npm/manifold-3d@3.5.4/manifold.js";
    let manifoldPromise = null;

    function loadManifold() {
        if (!manifoldPromise) {
            manifoldPromise = (async () => {
                const module = await import(window.SWISS_MANIFOLD_URL || MANIFOLD_URL);
                const wasm = await module.default();
                wasm.setup();
                return wasm;
            })().catch(error => { manifoldPromise = null; throw error; });
        }
        return manifoldPromise;
    }

    /* Height-field solid as an indexed mesh (shared vertices) for manifold. */
    function solidIndexed(nx, ny, step, H) {
        const n = nx * ny;
        const vert = new Float32Array((2 * n + 1) * 3);
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
            const k = j * nx + i;
            vert.set([i * step, j * step, H[k]], k * 3);              // top
            vert.set([i * step, j * step, 0], (n + k) * 3);           // bottom
        }
        const C = 2 * n;
        vert.set([(nx - 1) * step / 2, (ny - 1) * step / 2, 0], C * 3);

        const tri = [];
        const P = (i, j) => j * nx + i, Bt = (i, j) => n + j * nx + i;
        for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
            tri.push(P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j), P(i + 1, j + 1), P(i, j + 1));
        }
        for (let i = 0; i < nx - 1; i++) tri.push(Bt(i, 0), Bt(i + 1, 0), P(i + 1, 0), Bt(i, 0), P(i + 1, 0), P(i, 0));
        for (let i = 0, j = ny - 1; i < nx - 1; i++) tri.push(Bt(i + 1, j), Bt(i, j), P(i, j), Bt(i + 1, j), P(i, j), P(i + 1, j));
        for (let j = 0; j < ny - 1; j++) tri.push(Bt(0, j + 1), Bt(0, j), P(0, j), Bt(0, j + 1), P(0, j), P(0, j + 1));
        for (let j = 0, i = nx - 1; j < ny - 1; j++) tri.push(Bt(i, j), Bt(i, j + 1), P(i, j + 1), Bt(i, j), P(i, j + 1), P(i, j));

        const ring = [];
        for (let i = 0; i < nx - 1; i++) ring.push(Bt(i, 0));
        for (let j = 0; j < ny - 1; j++) ring.push(Bt(nx - 1, j));
        for (let i = nx - 1; i > 0; i--) ring.push(Bt(i, ny - 1));
        for (let j = ny - 1; j > 0; j--) ring.push(Bt(0, j));
        for (let r = 0; r < ring.length; r++) tri.push(C, ring[(r + 1) % ring.length], ring[r]);

        return { vert, tri: Uint32Array.from(tri) };
    }

    /*
     * Triangle soup -> one indexed mesh per building. Vertices are welded by
     * position; faces are grouped across edges that join exactly two faces,
     * so row houses sharing a wall stay separate solids.
     */
    function splitShells(T) {
        const q = v => Math.round(v * 1e4);
        const ids = new Map(), verts = [];
        const vid = (x, y, z) => {
            const k = `${q(x)},${q(y)},${q(z)}`;
            let id = ids.get(k);
            if (id === undefined) { id = verts.length / 3; ids.set(k, id); verts.push(x, y, z); }
            return id;
        };

        const faces = [];
        for (let t = 0; t + 8 < T.length; t += 9) {
            const f = [vid(T[t], T[t + 1], T[t + 2]), vid(T[t + 3], T[t + 4], T[t + 5]), vid(T[t + 6], T[t + 7], T[t + 8])];
            if (f[0] !== f[1] && f[1] !== f[2] && f[0] !== f[2]) faces.push(f);
        }

        const edgeFaces = new Map();
        faces.forEach((f, fi) => {
            for (let k = 0; k < 3; k++) {
                const a = f[k], b = f[(k + 1) % 3], key = a < b ? `${a}|${b}` : `${b}|${a}`;
                (edgeFaces.get(key) || edgeFaces.set(key, []).get(key)).push(fi);
            }
        });

        const parent = faces.map((_, i) => i);
        const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
        for (const list of edgeFaces.values()) {
            if (list.length === 2) parent[find(list[0])] = find(list[1]);
        }

        const groups = new Map();
        faces.forEach((f, fi) => { const r = find(fi); (groups.get(r) || groups.set(r, []).get(r)).push(f); });

        return [...groups.values()].map(group => {
            const local = new Map(), vert = [], tri = [];
            for (const f of group) for (const v of f) {
                let id = local.get(v);
                if (id === undefined) { id = vert.length / 3; local.set(v, id); vert.push(verts[v * 3], verts[v * 3 + 1], verts[v * 3 + 2]); }
                tri.push(id);
            }
            return { vert: Float32Array.from(vert), tri: Uint32Array.from(tri) };
        });
    }

    /* Indexed mesh -> Manifold, or null if it is not a closed solid. */
    function toManifold(wasm, { vert, tri }) {
        try {
            const mesh = new wasm.Mesh({ numProp: 3, vertProperties: vert, triVerts: tri });
            mesh.merge();
            const m = new wasm.Manifold(mesh);
            if (m.status && m.status() !== "NoError" && m.status() !== 0) { m.delete?.(); return null; }
            if (m.isEmpty()) { m.delete?.(); return null; }
            return m;
        } catch (error) {
            return null;
        }
    }

    function soupOf({ vert, tri }) {
        const out = new Float32Array(tri.length * 3);
        for (let i = 0; i < tri.length; i++) out.set(vert.subarray(tri[i] * 3, tri[i] * 3 + 3), i * 3);
        return out;
    }

    function manifoldTriangles(m) {
        const mesh = m.getMesh();
        const P = mesh.vertProperties, np = mesh.numProp, V = mesh.triVerts;
        const out = new Float32Array(V.length * 3);
        for (let i = 0; i < V.length; i++) {
            out[i * 3] = P[V[i] * np]; out[i * 3 + 1] = P[V[i] * np + 1]; out[i * 3 + 2] = P[V[i] * np + 2];
        }
        return out;
    }

    function concat(arrays) {
        const out = new Float32Array(arrays.reduce((s, a) => s + a.length, 0));
        let o = 0;
        for (const a of arrays) { out.set(a, o); o += a.length; }
        return out;
    }

    /*
     * The print model as manifolds: terrain solid (heights H, base lowered by
     * `extra` mm below 0) and each building that is a closed solid. Buildings
     * that are not are returned as `open` (triangle soups).
     */
    function modelManifolds(wasm, nx, ny, step, H, buildingTris, extra = 0) {
        const lifted = extra ? H.map(h => h + extra) : H;
        let terrain = toManifold(wasm, solidIndexed(nx, ny, step, lifted));
        if (!terrain) throw new Error("terrain solid is not closed");
        if (extra) { const t = terrain.translate([0, 0, -extra]); terrain.delete?.(); terrain = t; }

        const solids = [], open = [];
        for (const shell of buildingTris ? splitShells(buildingTris) : []) {
            const m = toManifold(wasm, shell);
            if (m) solids.push(m); else open.push(soupOf(shell));
        }
        return { terrain, solids, open };
    }

    /*
     * The exact print model: positive = terrain ∪ buildings as one solid;
     * negative = rim block minus the model turned upside down (mirrored
     * north-south, as the cast comes out of the mould).
     * z: terrain heights (LV95 m) at nodes E0 + i*cell, N0 + j*cell.
     */
    function exactModel(wasm, { nx, ny, cell, z, E0, N0, buildings, shift = 0, groundAt, scale, exaggeration = 1, base = 5, negative = false, rim = 4 }) {
        const mm = 1000 / scale, step = cell * mm;
        const X = (nx - 1) * step, Y = (ny - 1) * step;
        let lo = Infinity;
        for (const v of z) if (v < lo) lo = v;

        const g = { E0, N0, E1: E0 + (nx - 1) * cell, N1: N0 + (ny - 1) * cell, lo, mm, base, exaggeration, groundAt };
        const bt = buildingTriangles(buildings, shift, g);
        const heights = zz => Float32Array.from(zz, v => base + (v - lo) * exaggeration * mm);
        const maxOf = H => H.reduce((m, v) => (v > m ? v : m), -Infinity);
        const free = list => list.forEach(m => m?.delete?.());

        if (!negative) {
            const H = heights(z);
            const { terrain, solids, open } = modelManifolds(wasm, nx, ny, step, H, bt.triangles);
            const all = wasm.Manifold.union([terrain, ...solids]);
            const triangles = concat([manifoldTriangles(all), ...open]);
            free([terrain, ...solids, all]);
            return { triangles, size: [X, Y, Math.max(maxOf(H), bt.top)], solids: solids.length, open: open.length };
        }

        // buildings that are not closed solids cannot be subtracted:
        // rasterise those finely into the terrain heights instead
        const shells = splitShells(bt.triangles);
        const closed = [], open = [];
        for (const shell of shells) {
            const m = toManifold(wasm, shell);
            if (m) { closed.push(soupOf(shell)); m.delete?.(); } else open.push(soupOf(shell));
        }
        const zz = Float32Array.from(z);
        if (open.length && window.swissSurfaces?.rasteriseTriangles) {
            const back = new Float64Array(open.reduce((s, a) => s + a.length, 0));
            let o = 0;
            for (const a of open) for (let i = 0; i < a.length; i += 3) {
                back[o++] = a[i] / mm + E0; back[o++] = a[i + 1] / mm + N0;
                back[o++] = lo + (a[i + 2] - base) / (exaggeration * mm);
            }
            const fine = Math.min(0.25, cell);
            const grid = { minE: E0 - cell / 2, minN: N0 - cell / 2, cell: fine, nx: Math.ceil(nx * cell / fine), ny: Math.ceil(ny * cell / fine) };
            window.swissSurfaces.rasteriseTriangles(back, grid);
            for (let gj = 0; gj < grid.ny; gj++) for (let gi = 0; gi < grid.nx; gi++) {
                const h = grid.z[gj * grid.nx + gi];
                if (!(h === h)) continue;
                const i = Math.min(nx - 1, Math.floor(gi * fine / cell)), j = Math.min(ny - 1, Math.floor(gj * fine / cell));
                if (h > zz[j * nx + i]) zz[j * nx + i] = h;
            }
        }

        const H = heights(zz);
        const EXTRA = 10;                                       // mm: the model sticks out of the block
        const { terrain, solids } = modelManifolds(wasm, nx, ny, step, H, closed.length ? concat(closed) : null, EXTRA);
        const model = wasm.Manifold.union([terrain, ...solids]);

        const topMax = Math.max(maxOf(H), bt.top);
        const K = base + topMax;                                // highest point -> floor of `base` mm
        const rimTop = topMax + 3;
        const block = wasm.Manifold.cube([X + 2 * rim, Y + 2 * rim, rimTop]);
        // (x, y, z) -> (x + rim, Y - y + rim, K - z): upside down and mirrored north-south
        const turned = model.rotate([180, 0, 0]);
        const placed = turned.translate([rim, Y + rim, K]);
        const mould = block.subtract(placed);
        const triangles = manifoldTriangles(mould);
        free([terrain, ...solids, model, block, turned, placed, mould]);

        return { triangles, size: [X + 2 * rim, Y + 2 * rim, rimTop], solids: solids.length, open: open.length };
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
            `(${Math.round(area.w)} × ${Math.round(area.h)} m at 1:${scale.toLocaleString()}), covers ${tiles} km tile${tiles > 1 ? "s" : ""}. ` +
            (() => { try { return `Terrain ${terrainCell(settings(), area.w, area.h)} m.`; } catch (error) { return `${error.message}.`; } })();
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
            detail: el("print-detail")?.value || "auto"
        };
    }

    const AUTO_MAX_TRIS = 6e6;     // ~300 MB STL
    const FULL_MAX_TRIS = 16e6;    // ~800 MB STL: beyond that browsers give up

    /*
     * Terrain grid spacing in metres. auto: about 0.2 mm on the print (one
     * nozzle line), never finer than swissALTI3D's 0.5 m; full: 0.5 m.
     */
    function terrainCell(o, w, h) {
        const tris = cell => 2 * (w / cell) * (h / cell);
        if (o.detail === "full") {
            if (tris(0.5) > FULL_MAX_TRIS) {
                throw new Error(`full resolution would need ${(tris(0.5) / 1e6).toFixed(0)} M triangles – make the area smaller (max. about ${Math.floor(Math.sqrt(FULL_MAX_TRIS / 2) * 0.5)} m square) or use Auto`);
            }
            return 0.5;
        }
        if (o.detail === "auto") {
            let cell = Math.max(0.5, o.scale * 0.0002);
            cell = Math.max(cell, Math.sqrt(2 * w * h / AUTO_MAX_TRIS));
            return cell <= 0.5 ? 0.5 : Math.ceil(cell * 4) / 4;
        }
        return Math.max(0.5, Math.max(w, h) / Number(o.detail || 500));
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
            const cell = terrainCell(o, area.w, area.h);
            const gsd = cell < 1.5 ? 0.5 : 2;

            const terrain = await swissLoadAltiArea(b, gsd, text => setStatus(text));
            if (terrain.missing === terrain.tiles) throw new Error("no swissALTI3D terrain for this area");

            // grid nodes at cell centres (at 0.5 m: exactly the swissALTI3D pixels)
            const E0 = b.minE + cell / 2, N0 = b.minN + cell / 2;
            const nx = Math.max(2, Math.floor(area.w / cell)), ny = Math.max(2, Math.floor(area.h / cell));
            setStatus(`Building terrain (${nx} × ${ny} at ${cell} m)…`);
            await new Promise(r => setTimeout(r, 0));

            const z = new Float32Array(nx * ny);
            for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
                z[j * nx + i] = terrain.at(E0 + i * cell, N0 + j * cell);
            }
            window.swissSurfaces.fillGaps(z, nx, ny);

            let B = null, shift = 0, buildingNote = "", wasm = null;
            if (withBuildings) {
                B = await window.swissBuildings3D.loadBuildings({
                    area: b, terrainAt: (e, n) => terrain.at(e, n), onProgress: text => setStatus(text)
                });
                // LiDAR-checked offset from the surfaces, if available
                shift = window.swissSurfaces?.current()?.check?.shift || 0;

                setStatus("Loading the geometry library…");
                try { wasm = await loadManifold(); } catch (error) { console.warn("[print] manifold-3d not available:", error); }
            }

            setStatus("Building the model…");
            await new Promise(r => setTimeout(r, 0));

            let result = null;
            const groundAt = (e, n) => terrain.at(e, n);

            if (withBuildings && wasm) {
                // exact: original building faces, joined with the terrain by a boolean union / subtraction
                try {
                    const r = exactModel(wasm, {
                        nx, ny, cell, z, E0, N0, buildings: B.triangles, shift, groundAt,
                        scale: o.scale, exaggeration: o.exaggeration, base: o.base, negative
                    });
                    result = r;
                    buildingNote = `, ${r.solids.toLocaleString()} buildings with their original faces` +
                        (r.open ? `, ${r.open} not closed in the source (${negative ? "rasterised at 0.25 m" : "added as separate shells"})` : "");
                } catch (error) {
                    console.warn("[print] exact model failed, falling back:", error);
                    buildingNote = ` (exact geometry failed: ${error.message})`;
                }
            }

            if (!result) {
                if (withBuildings && negative) {
                    // fallback: a mould from one height raster, buildings at 0.25 m
                    const fine = Math.min(0.25, cell);
                    const grid = { minE: b.minE, minN: b.minN, cell: fine, nx: Math.ceil(area.w / fine), ny: Math.ceil(area.h / fine) };
                    window.swissSurfaces.rasteriseTriangles(B.triangles, grid);
                    for (let gj = 0; gj < grid.ny; gj++) for (let gi = 0; gi < grid.nx; gi++) {
                        const h = grid.z[gj * grid.nx + gi];
                        if (!(h === h)) continue;
                        const i = Math.min(nx - 1, Math.floor(gi * fine / cell)), j = Math.min(ny - 1, Math.floor(gj * fine / cell));
                        if (h + shift > z[j * nx + i]) z[j * nx + i] = h + shift;
                    }
                    buildingNote += wasm ? "" : " (geometry library not available: mould with buildings rasterised at 0.25 m)";
                }

                // terrain only: the height field IS the exact swissALTI3D surface
                result = printSolid({ nx, ny, cell, z }, { ...o, negative });

                if (withBuildings && !negative) {
                    const bt = buildingTriangles(B.triangles, shift, {
                        E0, N0, E1: E0 + (nx - 1) * cell, N1: N0 + (ny - 1) * cell,
                        lo: result.lo, mm: result.mm, base: o.base, exaggeration: o.exaggeration, groundAt
                    });
                    result.triangles = concat([result.triangles, bt.triangles]);
                    result.size[2] = Math.max(result.size[2], bt.top);
                    buildingNote += `, ${(bt.triangles.length / 9).toLocaleString()} original building faces as separate shells`;
                }
            }

            setStatus("Writing STL…");
            await new Promise(r => setTimeout(r, 0));

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
                `${(result.triangles.length / 9).toLocaleString()} triangles, terrain ${cell} m from ${terrain.tiles} tile(s)${buildingNote}` +
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

    window.swissPrint = { printSolid, solid, stl, area, buildingTriangles, terrainCell, earClip, loadManifold, exactModel, splitShells, solidIndexed, manifoldTriangles };
})();
