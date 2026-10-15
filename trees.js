/*
 * Swiss LiDAR Viewer - single trees from swissSURFACE3D
 *
 * swissSURFACE3D puts all vegetation (low, medium, high) into class 3, so
 * trees are separated by their height above the terrain (swissALTI3D, or
 * the LiDAR ground points where it is missing).
 *
 *   1. canopy height model (CHM): highest vegetation point per 0.5 m cell
 *      minus the terrain
 *   2. tree tops: local maxima of the (lightly smoothed) CHM, searched in a
 *      window that grows with the tree height (Popescu & Wynne 2004)
 *   3. crowns: region growing from the tops, highest cells first
 *   4. per tree: position (LV95), height, crown base, crown diameter/area,
 *      estimated leaf type (needle / broadleaf, experimental): swissSURFACE3D
 *      is mostly flown leafless, so lasers pass through bare broadleaf crowns
 *      to the ground but hardly through evergreen conifers; conifers are
 *      also conical (crown edge low relative to the tip), broadleaf crowns
 *      dome-shaped
 *   5. crown volume: a soft "blob" - an icosphere pushed out to the crown
 *      points in every direction, smoothed, drawn translucent with fading
 *      edges: an approximation that still reads as an abstraction of the
 *      point cloud
 *
 * Exports: OBJ for Rhino (local origin, Z up, one object per tree), CSV and
 * GeoJSON (LV95).
 *
 * Loaded after colorsource.js and export.js (uses swissEnsureAlti,
 * swissGroundZ, swissGroundFill, swissTileExtentLV95, window.swissTilePoints).
 */

(function () {
    "use strict";

    const CHM_CELL = 0.5;          // m
    const SAMPLE_CELL = 1;         // m, crown point samples
    const SAMPLE_CAP = 6;          // kept points per 1 m cell (vegetation)
    const VEGETATION = 3;          // swissSURFACE3D: all vegetation heights
    const GROUND = new Uint8Array(256);
    GROUND[2] = 1;
    GROUND[9] = 1;

    const state = {
        result: null,       // { trees, origin, extent, tileKey }
        group: null,
        busy: false,
        month: 7,           // season of the crowns (1..12.99)
        years: 0            // growth: years from now
    };

    /* ============================================================
       DETECTION (pure computation, no three.js)
       ============================================================ */

    /*
     * forEachPoint(fn, onProgress) must call fn(e, n, z, cls) for every point.
     * groundZ(e, n) returns the terrain height or NaN.
     */
    async function detectTrees({ forEachPoint, extent, groundAt, minHeight = 3, onProgress, key = "" }) {
        const nx = Math.ceil((extent.maxE - extent.minE) / CHM_CELL);
        const ny = Math.ceil((extent.maxN - extent.minN) / CHM_CELL);
        const n = nx * ny;

        const top = new Float32Array(n).fill(NaN);          // highest vegetation z

        // LiDAR ground (fallback for the terrain)
        const groundGrid = {
            key,
            ground: {
                cell: 2, minE: extent.minE, minN: extent.minN,
                nx: Math.ceil((extent.maxE - extent.minE) / 2),
                ny: Math.ceil((extent.maxN - extent.minN) / 2),
                raw: null, filled: null, dirty: false, filledAt: 0
            }
        };
        groundGrid.ground.raw = new Float32Array(groundGrid.ground.nx * groundGrid.ground.ny).fill(NaN);

        // crown point samples: reservoir of SAMPLE_CAP points per 1 m cell
        const sx = Math.ceil((extent.maxE - extent.minE) / SAMPLE_CELL);
        const sy = Math.ceil((extent.maxN - extent.minN) / SAMPLE_CELL);
        const seen = new Uint16Array(sx * sy);          // vegetation points per 1 m cell
        const groundSeen = new Uint16Array(sx * sy);    // ground points per 1 m cell
        const slot = new Int32Array(sx * sy * SAMPLE_CAP).fill(-1);
        let cap = 1 << 20, used = 0;
        let PE = new Float32Array(cap), PN = new Float32Array(cap), PZ = new Float32Array(cap);

        let vegetation = 0, classified = false;
        let seed = 12345;
        const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

        await forEachPoint((e, nn, z, cls) => {
            if (cls >= 0) classified = true;

            const le = e - extent.minE, ln = nn - extent.minN;
            if (le < 0 || ln < 0) return;

            if (GROUND[cls]) {
                const g = groundGrid.ground;
                const i = Math.floor(le / 2), j = Math.floor(ln / 2);
                if (i < g.nx && j < g.ny) {
                    const k = j * g.nx + i;
                    if (!(g.raw[k] <= z)) { g.raw[k] = z; g.dirty = true; }
                }
                const si = Math.floor(le / SAMPLE_CELL), sj = Math.floor(ln / SAMPLE_CELL);
                if (si < sx && sj < sy && groundSeen[sj * sx + si] < 65535) groundSeen[sj * sx + si]++;
                return;
            }

            if (cls !== VEGETATION) return;

            const i = Math.floor(le / CHM_CELL), j = Math.floor(ln / CHM_CELL);
            if (i >= nx || j >= ny) return;

            const k = j * nx + i;
            if (!(top[k] >= z)) top[k] = z;
            vegetation++;

            // reservoir sample for the crown shape
            const si = Math.floor(le / SAMPLE_CELL), sj = Math.floor(ln / SAMPLE_CELL);
            const c = sj * sx + si;
            const count = seen[c] < 65535 ? ++seen[c] : 65535;
            let target = -1;

            if (count <= SAMPLE_CAP) {
                if (used === cap) {
                    cap *= 2;
                    const grow = a => { const b = new Float32Array(cap); b.set(a); return b; };
                    PE = grow(PE); PN = grow(PN); PZ = grow(PZ);
                }
                target = used++;
                slot[c * SAMPLE_CAP + count - 1] = target;
            } else {
                const r = Math.floor(rand() * count);
                if (r < SAMPLE_CAP) target = slot[c * SAMPLE_CAP + r];
            }

            if (target >= 0) { PE[target] = le; PN[target] = ln; PZ[target] = z; }
        }, onProgress);

        if (!classified) throw new Error("The point cloud has no classification.");
        if (!vegetation) return { trees: [], vegetation: 0 };

        swissGroundFill(groundGrid.ground);

        const groundOf = (e, nn) => {
            const z = groundAt(e, nn);
            return z === z ? z : swissGroundZ(groundGrid, e, nn);
        };

        // 1. canopy height model
        const chm = new Float32Array(n);
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const k = j * nx + i;
                const z = top[k];
                if (!(z === z)) continue;
                const g = groundOf(extent.minE + (i + 0.5) * CHM_CELL, extent.minN + (j + 0.5) * CHM_CELL);
                const h = z - g;
                chm[k] = h > 0 && h < 120 ? h : 0;
            }
        }

        // light smoothing (1-2-1) against single noisy points
        const smooth = new Float32Array(n);
        const tmp = new Float32Array(n);
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const k = j * nx + i;
                const l = i > 0 ? chm[k - 1] : chm[k], r = i < nx - 1 ? chm[k + 1] : chm[k];
                tmp[k] = (l + 2 * chm[k] + r) / 4;
            }
        }
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const k = j * nx + i;
                const d = j > 0 ? tmp[k - nx] : tmp[k], u = j < ny - 1 ? tmp[k + nx] : tmp[k];
                smooth[k] = chm[k] > 0 ? (d + 2 * tmp[k] + u) / 4 : 0;
            }
        }

        // 2. tree tops: local maxima in a height-dependent window
        const higher = (a, ka, b, kb) => a > b || (a === b && ka > kb);
        const seeds = [];

        for (let j = 1; j < ny - 1; j++) {
            for (let i = 1; i < nx - 1; i++) {
                const k = j * nx + i;
                const h = smooth[k];
                if (h < minHeight) continue;

                // quick 3x3 test first
                let isMax = true;
                for (let dj = -1; dj <= 1 && isMax; dj++) {
                    for (let di = -1; di <= 1; di++) {
                        if (!di && !dj) continue;
                        const q = k + dj * nx + di;
                        if (higher(smooth[q], q, h, k)) { isMax = false; break; }
                    }
                }
                if (!isMax) continue;

                // window radius: half the expected crown width (deciduous, Popescu & Wynne)
                const radius = Math.min(6, Math.max(1, (3.09632 + 0.00895 * h * h) / 2 * 0.8));
                const rc = Math.ceil(radius / CHM_CELL);
                const r2 = (radius / CHM_CELL) ** 2;

                for (let dj = -rc; dj <= rc && isMax; dj++) {
                    const jj = j + dj;
                    if (jj < 0 || jj >= ny) continue;
                    for (let di = -rc; di <= rc; di++) {
                        if (di * di + dj * dj > r2) continue;
                        const ii = i + di;
                        if (ii < 0 || ii >= nx) continue;
                        const q = jj * nx + ii;
                        if (q !== k && higher(smooth[q], q, h, k)) { isMax = false; break; }
                    }
                }

                if (isMax) seeds.push(k);
            }
        }

        // 3. crowns: region growing, highest cells first
        const label = new Int32Array(n);
        const seedOf = [0];
        seeds.forEach((k, idx) => { label[k] = idx + 1; seedOf.push(k); });

        const floor = Math.max(1.5, minHeight * 0.5);
        const order = [];
        for (let k = 0; k < n; k++) if (smooth[k] >= floor && !label[k]) order.push(k);
        order.sort((a, b) => smooth[b] - smooth[a]);

        for (let pass = 0; pass < 3; pass++) {
            let added = 0;

            for (const k of order) {
                if (label[k]) continue;

                const i = k % nx, j = (k - i) / nx;
                let best = 0, bestD = Infinity;

                for (let dj = -1; dj <= 1; dj++) {
                    for (let di = -1; di <= 1; di++) {
                        if (!di && !dj) continue;
                        const ii = i + di, jj = j + dj;
                        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
                        const lb = label[jj * nx + ii];
                        if (!lb) continue;

                        const s = seedOf[lb];
                        const si = s % nx, sj = (s - si) / nx;
                        const d = Math.hypot(si - i, sj - j) * CHM_CELL;
                        const hs = smooth[s];

                        // stay within a plausible crown, not too far below the top
                        if (d > Math.min(14, 0.4 * hs + 1.5)) continue;
                        if (smooth[k] < 0.25 * hs) continue;
                        if (d < bestD) { bestD = d; best = lb; }
                    }
                }

                if (best) { label[k] = best; added++; }
            }

            if (!added) break;
        }

        // 4. per tree
        const trees = seeds.map((k, idx) => {
            const i = k % nx, j = (k - i) / nx;
            const e = extent.minE + (i + 0.5) * CHM_CELL;
            const nn = extent.minN + (j + 0.5) * CHM_CELL;

            return {
                id: idx + 1, e, n: nn, groundZ: groundOf(e, nn),
                height: 0, cells: 0, sumE: 0, sumN: 0, points: [],
                sampleCells: new Set(), cellList: []
            };
        });

        for (let k = 0; k < n; k++) {
            const lb = label[k];
            if (!lb) continue;
            const t = trees[lb - 1];
            t.cells++;
            if (chm[k] > t.height) t.height = chm[k];
            const i = k % nx, j = (k - i) / nx;
            t.sumE += i; t.sumN += j;
            t.cellList.push(k);
            t.sampleCells.add(Math.floor(j * CHM_CELL / SAMPLE_CELL) * sx + Math.floor(i * CHM_CELL / SAMPLE_CELL));
        }

        // crown point samples
        for (let p = 0; p < used; p++) {
            const i = Math.floor(PE[p] / CHM_CELL), j = Math.floor(PN[p] / CHM_CELL);
            if (i >= nx || j >= ny) continue;
            const lb = label[j * nx + i];
            if (!lb) continue;

            const t = trees[lb - 1];
            if (t.points.length >= 1200) continue;

            const e = extent.minE + PE[p], nn = extent.minN + PN[p];
            const hz = PZ[p] - groundOf(e, nn);
            if (hz > 0.5) t.points.push(e, nn, hz);
        }

        const result = [];

        for (const t of trees) {
            if (t.cells < 4 || t.height < minHeight) continue;

            const area = t.cells * CHM_CELL * CHM_CELL;
            const heights = [];
            for (let p = 2; p < t.points.length; p += 3) {
                if (t.points[p] >= Math.max(1, 0.2 * t.height)) heights.push(t.points[p]);
            }
            heights.sort((a, b) => a - b);

            const base = heights.length >= 8
                ? heights[Math.floor(heights.length * 0.05)]
                : Math.max(1, t.height * 0.4);

            // leaf type: crown shape + laser penetration to the ground
            const R = Math.sqrt(area / Math.PI);
            const ti = Math.round((t.e - extent.minE) / CHM_CELL - 0.5), tj = Math.round((t.n - extent.minN) / CHM_CELL - 0.5);
            let edgeSum = 0, edgeCount = 0;
            const inner = new Set();

            for (const k of t.cellList) {
                const i = k % nx, j = (k - i) / nx;
                const r = Math.hypot(i - ti, j - tj) * CHM_CELL / Math.max(0.5, R);
                if (r >= 0.55 && r <= 0.9) { edgeSum += chm[k]; edgeCount++; }
                // penetration only inside the crown (edge cells also see ground beside the tree)
                if (r < 0.6) inner.add(Math.floor(j * CHM_CELL / SAMPLE_CELL) * sx + Math.floor(i * CHM_CELL / SAMPLE_CELL));
            }

            let veg = 0, grd = 0;
            for (const c of inner) { veg += seen[c]; grd += groundSeen[c]; }
            const penetration = veg + grd > 0 ? grd / (veg + grd) : 0;
            const edge = edgeCount >= 3 ? edgeSum / edgeCount / t.height : NaN;

            // shape decides; penetration confirms (or decides when the shape is in between)
            let leafType = "unknown";
            if (t.height >= 5 && edge === edge) {
                if (edge < 0.68 && penetration < 0.3) leafType = "needle";
                else if (edge > 0.76 && penetration > 0.15) leafType = "broadleaf";
                else if (edge >= 0.68 && edge <= 0.76) {
                    if (penetration < 0.1) leafType = "needle";
                    else if (penetration > 0.3) leafType = "broadleaf";
                }
            }

            result.push({
                id: result.length + 1,
                leafType,
                penetration,
                edgeRatio: edge,
                e: t.e,
                n: t.n,
                groundZ: t.groundZ,
                height: t.height,
                crownBase: Math.min(base, t.height * 0.9),
                crownArea: area,
                crownDiameter: 2 * Math.sqrt(area / Math.PI),
                centroidE: extent.minE + (t.sumE / t.cells + 0.5) * CHM_CELL,
                centroidN: extent.minN + (t.sumN / t.cells + 0.5) * CHM_CELL,
                points: t.points
            });
        }

        return { trees: result, vegetation };
    }

    /* ============================================================
       SOFT CROWN VOLUME ("blob")
       ============================================================ */

    const icoCache = new Map();

    /* Icosphere with vertex neighbours: level 1 = 42, level 2 = 162 vertices. */
    function icosphere(level = 2) {
        if (icoCache.has(level)) return icoCache.get(level);

        const t = (1 + Math.sqrt(5)) / 2;
        let v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
                 [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
            .map(p => { const l = Math.hypot(...p); return p.map(x => x / l); });
        let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4],
                 [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8],
                 [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];

        for (let s = 0; s < level; s++) {
            const mid = new Map();
            const half = (a, b) => {
                const key = a < b ? `${a}_${b}` : `${b}_${a}`;
                if (!mid.has(key)) {
                    const p = [0, 1, 2].map(c => (v[a][c] + v[b][c]) / 2);
                    const l = Math.hypot(...p);
                    v.push(p.map(x => x / l));
                    mid.set(key, v.length - 1);
                }
                return mid.get(key);
            };
            f = f.flatMap(([a, b, c]) => {
                const ab = half(a, b), bc = half(b, c), ca = half(c, a);
                return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]];
            });
        }

        const nb = v.map(() => new Set());
        for (const [a, b, c] of f) {
            nb[a].add(b); nb[a].add(c); nb[b].add(a); nb[b].add(c); nb[c].add(a); nb[c].add(b);
        }

        const result = { v, f, nb: nb.map(s => [...s]) };
        icoCache.set(level, result);
        return result;
    }

    /*
     * Crown styles:
     *   blob       soft, organic: 162 directions, light smoothing, a little noise
     *   geometric  calm, faceted: 42 directions, strong smoothing, no noise
     */
    const CROWN = {
        blob: { level: 2, smooth: 3, noise: 0.1 },
        geometric: { level: 1, smooth: 6, noise: 0 }
    };

    /*
     * Crown for one tree: for every icosphere direction, how far the crown
     * points reach (85th percentile), filled and smoothed. Vertices relative
     * to the stem foot (e, n, groundZ), Z up.
     */
    function crownBlob(tree, style = "blob") {
        const opts = CROWN[style] || CROWN.blob;
        const { v, f, nb } = icosphere(opts.level);
        const top = tree.height, base = tree.crownBase;
        const r0 = Math.max(0.8, tree.crownDiameter / 2);

        const pts = [];
        for (let p = 0; p + 2 < tree.points.length; p += 3) {
            if (tree.points[p + 2] >= base) pts.push(tree.points[p] - tree.e, tree.points[p + 1] - tree.n, tree.points[p + 2]);
        }

        let cx = 0, cy = 0;
        if (pts.length >= 24) {
            for (let p = 0; p < pts.length; p += 3) { cx += pts[p]; cy += pts[p + 1]; }
            cx /= pts.length / 3; cy /= pts.length / 3;
        }
        const cz = (top + base) / 2;
        const halfH = Math.max(0.6, (top - base) / 2);

        const bins = v.map(() => []);
        for (let p = 0; p < pts.length; p += 3) {
            const dx = pts[p] - cx, dy = pts[p + 1] - cy, dz = pts[p + 2] - cz;
            const r = Math.hypot(dx, dy, dz);
            if (r < 1e-6) continue;
            let best = 0, bestDot = -2;
            for (let q = 0; q < v.length; q++) {
                const d = (v[q][0] * dx + v[q][1] * dy + v[q][2] * dz) / r;
                if (d > bestDot) { bestDot = d; best = q; }
            }
            bins[best].push(r);
        }

        let radius = bins.map((b, q) => {
            if (b.length >= 2) {
                b.sort((x, y) => x - y);
                return b[Math.floor((b.length - 1) * 0.85)];
            }
            const [x, y, z] = v[q];
            return 1 / Math.sqrt((x * x + y * y) / (r0 * r0) + (z * z) / (halfH * halfH));
        });

        for (let it = 0; it < opts.smooth; it++) {
            radius = radius.map((r, q) => {
                const m = nb[q].reduce((s, o) => s + radius[o], 0) / nb[q].length;
                return 0.45 * r + 0.55 * m;
            });
        }

        let h = (tree.id * 2654435761) >>> 0;
        const noise = () => { h = (h ^ (h << 13)) >>> 0; h = (h ^ (h >>> 17)) >>> 0; h = (h ^ (h << 5)) >>> 0; return h / 4294967296; };

        const positions = [], shade = [];
        v.forEach(([x, y, z], q) => {
            let r = radius[q] * (1 - opts.noise / 2 + opts.noise * noise());
            if (z > 1e-6) r = Math.min(r, (top + 0.3 - cz) / z);
            if (z < -1e-6) r = Math.min(r, (base * 0.9 - cz) / z);
            const pz = cz + z * r;
            positions.push(cx + x * r, cy + y * r, pz);
            shade.push(Math.max(0, Math.min(1, (pz - base) / Math.max(0.5, top - base))));
        });

        return { positions, shade, faces: f, centre: [cx, cy, cz] };
    }

    /*
     * Stem, relative to the stem foot, Z up.
     *   blob       tapered 8-sided body leaning into the crown centre
     *   geometric  slim straight 6-sided cylinder, vertical
     */
    function stemGeometry(tree, style = "blob", centre = null) {
        const [cx, cy, cz] = centre || crownBlob(tree, style).centre;
        const r0 = Math.min(0.45, Math.max(0.06, 0.012 * tree.height + 0.01 * tree.crownDiameter));
        const geometric = style === "geometric";
        const sides = geometric ? 6 : 8;
        const rings = geometric
            ? [[0, 0, -0.2, r0 * 0.55], [0, 0, cz, r0 * 0.45]]
            : [[0, 0, -0.2, r0], [cx * 0.5, cy * 0.5, tree.crownBase, r0 * 0.75], [cx, cy, cz, r0 * 0.45]];

        const positions = [], shade = [], faces = [];
        rings.forEach(([x, y, z, r], ringIndex) => {
            for (let s = 0; s < sides; s++) {
                const a = (s / sides) * Math.PI * 2;
                positions.push(x + r * Math.cos(a), y + r * Math.sin(a), z);
                shade.push(ringIndex / (rings.length - 1));
            }
        });
        for (let ring = 0; ring < rings.length - 1; ring++) {
            for (let s = 0; s < sides; s++) {
                const a = ring * sides + s, b = ring * sides + (s + 1) % sides;
                faces.push([a, b, b + sides], [a, b + sides, a + sides]);
            }
        }
        return { positions, shade, faces };
    }

    /* ---------- growth over the coming years ---------- */

    /*
     * Height approaches a typical final height (Chapman-Richards-like):
     * young trees grow fast, old trees hardly. Crowns widen a little less
     * than the height grows.
     */
    const FINAL_HEIGHT = { needle: 38, broadleaf: 32, unknown: 34 };

    function growth(tree, years) {
        if (!years) return { sz: 1, sxy: 1 };
        let hMax = FINAL_HEIGHT[tree.leafType] || 34;
        if (tree.height >= 0.95 * hMax) hMax = tree.height * 1.08;
        const h = hMax - (hMax - tree.height) * Math.exp(-0.03 * years);
        const sz = h / tree.height;
        return { sz, sxy: Math.pow(sz, 0.85) };
    }

    /* Crown + stem of one tree for a style and a number of years from now. */
    function treeGeometry(tree, style, years) {
        tree._crowns = tree._crowns || {};
        const crown = tree._crowns[style] || (tree._crowns[style] = crownBlob(tree, style));
        const { sz, sxy } = growth(tree, years);

        const positions = crown.positions.slice();
        for (let p = 0; p < positions.length; p += 3) {
            positions[p] *= sxy; positions[p + 1] *= sxy; positions[p + 2] *= sz;
        }

        const grown = { ...tree, height: tree.height * sz, crownBase: tree.crownBase * sz, crownDiameter: tree.crownDiameter * sxy };
        const [cx, cy, cz] = crown.centre;
        const stem = stemGeometry(grown, style, [cx * sxy, cy * sxy, cz * sz]);

        return { crown: { positions, shade: crown.shade, faces: crown.faces }, stem, height: grown.height };
    }

    /* ---------- seasons (broadleaf only; conifers stay green) ---------- */

    // month (1..12.99) -> [low colour, high colour, opacity] of broadleaf crowns
    const SEASON = [
        [1,    [0.36, 0.31, 0.27], [0.56, 0.50, 0.44], 0.32],    // bare
        [3.5,  [0.38, 0.36, 0.27], [0.62, 0.60, 0.42], 0.42],    // buds
        [4.6,  [0.32, 0.50, 0.19], [0.76, 0.88, 0.46], 0.78],    // fresh green
        [6.5,  [0.21, 0.40, 0.15], [0.60, 0.75, 0.40], 1.0],     // summer
        [8.7,  [0.24, 0.38, 0.15], [0.60, 0.69, 0.35], 1.0],     // late summer
        [10.1, [0.55, 0.28, 0.10], [0.95, 0.66, 0.25], 0.9],     // autumn
        [11.1, [0.45, 0.30, 0.18], [0.75, 0.55, 0.32], 0.55],    // late autumn
        [12.5, [0.36, 0.31, 0.27], [0.56, 0.50, 0.44], 0.32]     // bare
    ];

    function seasonPalette(month, muted) {
        let m = month < 1 ? month + 12 : month;
        if (m > SEASON[SEASON.length - 1][0]) m -= 12;
        let k = 0;
        while (k < SEASON.length - 2 && SEASON[k + 1][0] <= m) k++;
        const [m0, l0, h0, a0] = SEASON[k], [m1, l1, h1, a1] = SEASON[k + 1];
        const t = Math.min(1, Math.max(0, (m - m0) / (m1 - m0)));
        const mix = (a, b) => a.map((v, i) => v + (b[i] - v) * t);

        // conifers: slightly darker in winter
        const winter = 0.5 + 0.5 * Math.cos(((month - 1) / 12) * Math.PI * 2);
        const needleLow = [0.10, 0.27, 0.22].map(v => v * (1 - 0.15 * winter));
        const needleHigh = [0.34, 0.55, 0.47].map(v => v * (1 - 0.15 * winter));

        // professional style: calmer, less saturated colours
        const tone = c => muted ? c.map(v => v * 0.55 + 0.45 * (c[0] + c[1] + c[2]) / 3 + 0.04) : c;

        return {
            broadLow: tone(mix(l0, l1)), broadHigh: tone(mix(h0, h1)), broadAlpha: a0 + (a1 - a0) * t,
            needleLow: tone(needleLow), needleHigh: tone(needleHigh)
        };
    }

    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    /* ============================================================
       THREE.JS DISPLAY
       ============================================================ */

    const ATMO = window.swissAtmosphere;

    const BLOB_VERTEX = `
        ${ATMO.vertexDecl}
        attribute float aShade;
        attribute float aType;      // 0 broadleaf, 0.5 unknown, 1 needle
        varying vec3 vNormal;
        varying vec3 vView;
        varying float vShade;
        varying float vType;
        varying vec3 vLight;

        void main() {
            vType = aType;
            ${ATMO.vertexMain}
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vNormal = normalize(normalMatrix * normal);
            vView = normalize(-mv.xyz);
            vShade = aShade;
            vLight = normalize((viewMatrix * vec4(0.35, 0.25, 1.0, 0.0)).xyz);
            gl_Position = projectionMatrix * mv;
        }
    `;

    const BLOB_FRAGMENT = `
        uniform float uOpacity;
        uniform vec3 uLow;          // stems: bark colours
        uniform vec3 uHigh;
        uniform float uStem;        // 1: stem material
        uniform float uByType;      // 1: colour by leaf type
        uniform vec3 uBroadLow;
        uniform vec3 uBroadHigh;
        uniform float uBroadAlpha;
        uniform vec3 uNeedleLow;
        uniform vec3 uNeedleHigh;
        uniform float uSoftEdge;    // 1: hazy silhouette (soft volume), 0: calm (geometric)
        ${ATMO.fragmentDecl}
        varying vec3 vNormal;
        varying vec3 vView;
        varying float vShade;
        varying float vType;
        varying vec3 vLight;

        void main() {
            vec3 n = normalize(vNormal);
            float facing = abs(dot(n, normalize(vView)));
            float soft = smoothstep(0.0, 0.85, facing);
            float light = 0.55 + 0.45 * max(dot(n, vLight), 0.0);

            vec3 low = uLow, high = uHigh;
            float alpha = 1.0;

            if (uStem < 0.5) {
                if (uByType > 0.5 && vType < 0.25) {
                    low = uBroadLow; high = uBroadHigh; alpha = uBroadAlpha;
                } else if (uByType > 0.5 && vType > 0.75) {
                    low = uNeedleLow; high = uNeedleHigh;
                } else {
                    low = mix(uBroadLow, uNeedleLow, 0.5);
                    high = mix(uBroadHigh, uNeedleHigh, 0.5);
                    alpha = mix(uBroadAlpha, 1.0, 0.5);
                }
                alpha *= uOpacity * mix(0.75 + 0.25 * soft, 0.12 + 0.88 * soft, uSoftEdge);
            }

            vec3 colour = atmoShade(mix(low, high, vShade) * (0.8 + 0.2 * light));
            gl_FragColor = vec4(colour, alpha);
        }
    `;

    function setAttr(geometry, name, attribute) {
        if (typeof geometry.setAttribute === "function") geometry.setAttribute(name, attribute);
        else geometry.addAttribute(name, attribute);
    }

    /* Scene coordinates = LV95 unless the viewer applies a large offset. */
    function worldOffset(extent) {
        try {
            const box = currentPointCloud?.boundingBox?.clone();
            if (!box) return [0, 0];
            if (currentPointCloud.matrixWorld && !currentPointCloud.isLaz) box.applyMatrix4(currentPointCloud.matrixWorld);
            const dx = box.min.x - extent.minE, dy = box.min.y - extent.minN;
            if (Math.abs(dx) > 100000 || Math.abs(dy) > 100000) return [dx, dy];
        } catch (error) { /* keep LV95 */ }
        return [0, 0];
    }

    /* Indexed -> flat-shaded (each triangle its own normal): faceted look. */
    function flatten(positions, shade, type, index) {
        const P = [], S = [], T = [];
        for (let i = 0; i < index.length; i++) {
            const k = index[i];
            P.push(positions[k * 3], positions[k * 3 + 1], positions[k * 3 + 2]);
            S.push(shade[k]);
            T.push(type[k]);
        }
        return { positions: P, shade: S, type: T };
    }

    function treeMaterial(stem, style, opacity) {
        const palette = seasonPalette(state.month, style === "geometric");
        const colour = c => new THREE.Color(c[0], c[1], c[2]);

        return new THREE.ShaderMaterial({
            uniforms: {
                ...ATMO.uniforms(),
                uStem: { value: stem ? 1 : 0 },
                uByType: { value: el("trees-bytype")?.checked !== false ? 1 : 0 },
                uOpacity: { value: opacity },
                uSoftEdge: { value: style === "geometric" ? 0 : 1 },
                uLow: { value: new THREE.Color(style === "geometric" ? 0x55504a : 0x4a3a2c) },
                uHigh: { value: new THREE.Color(style === "geometric" ? 0x8c8780 : 0x8a7560) },
                uBroadLow: { value: colour(palette.broadLow) },
                uBroadHigh: { value: colour(palette.broadHigh) },
                uBroadAlpha: { value: palette.broadAlpha },
                uNeedleLow: { value: colour(palette.needleLow) },
                uNeedleHigh: { value: colour(palette.needleHigh) }
            },
            vertexShader: BLOB_VERTEX,
            fragmentShader: BLOB_FRAGMENT,
            transparent: !stem,
            depthWrite: !!stem,
            side: THREE.FrontSide
        });
    }

    function buildGroup(result, style, opacity, years) {
        const { trees, origin } = result;
        const group = new THREE.Group();
        group.name = "swiss-trees";

        const [ox, oy] = worldOffset(result.extent);
        group.position.set(origin[0] + ox, origin[1] + oy, origin[2]);

        const typeValue = { broadleaf: 0, unknown: 0.5, needle: 1 };
        const parts = { stem: { positions: [], shade: [], type: [], index: [] }, crown: { positions: [], shade: [], type: [], index: [] } };

        for (const t of trees) {
            const geo = treeGeometry(t, style, years);
            const x0 = t.e - origin[0], y0 = t.n - origin[1], z0 = t.groundZ - origin[2];

            for (const [name, part] of [["stem", geo.stem], ["crown", geo.crown]]) {
                const target = parts[name];
                const offset = target.positions.length / 3;
                for (let p = 0; p < part.positions.length; p += 3) {
                    target.positions.push(part.positions[p] + x0, part.positions[p + 1] + y0, part.positions[p + 2] + z0);
                    target.type.push(name === "crown" ? (typeValue[t.leafType] ?? 0.5) : 0.5);
                }
                target.shade.push(...part.shade);
                for (const [a, b, c] of part.faces) target.index.push(a + offset, b + offset, c + offset);
            }
        }

        for (const name of ["stem", "crown"]) {
            let { positions, shade, type, index } = parts[name];
            const g = new THREE.BufferGeometry();

            if (style === "geometric") {
                ({ positions, shade, type } = flatten(positions, shade, type, index));
                setAttr(g, "position", new THREE.Float32BufferAttribute(positions, 3));
                setAttr(g, "aShade", new THREE.Float32BufferAttribute(shade, 1));
                setAttr(g, "aType", new THREE.Float32BufferAttribute(type, 1));
                g.computeVertexNormals();      // non-indexed: one normal per facet
            } else {
                setAttr(g, "position", new THREE.Float32BufferAttribute(positions, 3));
                setAttr(g, "aShade", new THREE.Float32BufferAttribute(shade, 1));
                setAttr(g, "aType", new THREE.Float32BufferAttribute(type, 1));
                g.setIndex(index);
                g.computeVertexNormals();
            }

            const mesh = new THREE.Mesh(g, treeMaterial(name === "stem", style, opacity));
            mesh.name = name === "stem" ? "swiss-tree-stems" : "swiss-tree-crowns";
            if (name === "crown") mesh.renderOrder = 10;
            group.add(mesh);
        }

        return group;
    }

    /* Season: only colours change, no rebuild. */
    function applySeason() {
        const mesh = state.group?.getObjectByName("swiss-tree-crowns");
        if (!mesh) return;
        const style = el("trees-style")?.value || "blob";
        const p = seasonPalette(state.month, style === "geometric");
        const u = mesh.material.uniforms;
        u.uBroadLow.value.setRGB(...p.broadLow);
        u.uBroadHigh.value.setRGB(...p.broadHigh);
        u.uBroadAlpha.value = p.broadAlpha;
        u.uNeedleLow.value.setRGB(...p.needleLow);
        u.uNeedleHigh.value.setRGB(...p.needleHigh);
    }

    function show() {
        if (state.group) {
            state.group.parent?.remove(state.group);
            state.group.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
            state.group = null;
        }

        if (!state.result || !viewer?.scene?.scene) return;

        const style = el("trees-style")?.value || "blob";
        if (style === "none") return;

        const opacity = Number(el("trees-opacity")?.value ?? 0.6);
        state.group = buildGroup(state.result, style, opacity, state.years);
        state.group.traverse(o => { if (o.isMesh) ATMO.attach(o); });
        viewer.scene.scene.add(state.group);
        ATMO.invalidate();
    }

    /* ============================================================
       EXPORT
       ============================================================ */

    function download(name, text, type) {
        const blob = new Blob([text], { type });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
        window.usageCounter?.hit("downloads");
    }

    function baseName() {
        return `trees_${(swissKmTileId?.(currentTile) || "tile")}`;
    }

    /* OBJ for Rhino: local origin (in the file name and header), Z up. */
    function exportObj() {
        const { trees, origin } = state.result;
        const fix = x => x.toFixed(3);
        const lines = [
            "# Trees from swissSURFACE3D (Swiss LiDAR Viewer)",
            `# Local coordinates. LV95 = local + (${origin[0]}, ${origin[1]}, ${origin[2]})`,
            "# Z is up: in Rhino's OBJ import keep 'Map OBJ Y to Rhino Z' switched OFF.",
            "# One object per tree: crown volume + stem."
        ];
        let base = 1;

        const style = (el("trees-style")?.value || "blob") === "geometric" ? "geometric" : "blob";

        for (const t of trees) {
            const geo = treeGeometry(t, style, state.years);
            const x0 = t.e - origin[0], y0 = t.n - origin[1], z0 = t.groundZ - origin[2];

            lines.push(`o tree_${String(t.id).padStart(4, "0")}_${t.leafType}_h${geo.height.toFixed(1)}m` +
                (state.years ? `_in${state.years}y` : ""));

            for (const part of [geo.crown, geo.stem]) {
                for (let p = 0; p < part.positions.length; p += 3) {
                    lines.push(`v ${fix(part.positions[p] + x0)} ${fix(part.positions[p + 1] + y0)} ${fix(part.positions[p + 2] + z0)}`);
                }
                for (const [a, b, c] of part.faces) lines.push(`f ${a + base} ${b + base} ${c + base}`);
                base += part.positions.length / 3;
            }
        }

        download(`${baseName()}_origin_${origin.join("_")}.obj`, lines.join("\n"), "text/plain");
    }

    function exportCsv() {
        const rows = ["id;E_LV95;N_LV95;ground_z;height_m;crown_base_m;crown_diameter_m;crown_area_m2;leaf_type_estimated;laser_penetration"];
        for (const t of state.result.trees) {
            rows.push([t.id, t.e.toFixed(2), t.n.toFixed(2), t.groundZ.toFixed(2), t.height.toFixed(2),
                t.crownBase.toFixed(2), t.crownDiameter.toFixed(2), t.crownArea.toFixed(1),
                t.leafType, t.penetration.toFixed(2)].join(";"));
        }
        download(`${baseName()}.csv`, rows.join("\n"), "text/csv");
    }

    function exportGeoJson() {
        const features = state.result.trees.map(t => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [+t.e.toFixed(2), +t.n.toFixed(2), +t.groundZ.toFixed(2)] },
            properties: {
                id: t.id,
                height_m: +t.height.toFixed(2),
                crown_base_m: +t.crownBase.toFixed(2),
                crown_diameter_m: +t.crownDiameter.toFixed(2),
                crown_area_m2: +t.crownArea.toFixed(1),
                leaf_type_estimated: t.leafType,
                laser_penetration: +t.penetration.toFixed(2)
            }
        }));

        download(`${baseName()}.geojson`, JSON.stringify({
            type: "FeatureCollection",
            crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::2056" } },
            features
        }), "application/geo+json");
    }

    /* ============================================================
       UI
       ============================================================ */

    const el = id => document.getElementById(id);

    function setInfo(text) {
        if (el("trees-info")) el("trees-info").textContent = text;
    }

    function updateButtons() {
        const ready = !!state.result?.trees.length;
        for (const id of ["trees-obj", "trees-csv", "trees-geojson"]) {
            if (el(id)) el(id).disabled = !ready || state.busy;
        }
        if (el("trees-detect")) el("trees-detect").disabled = state.busy || !currentTile;
    }

    async function run() {
        if (state.busy || !currentTile || !window.swissTilePoints) return;

        state.busy = true;
        updateButtons();

        const minHeight = Number(el("trees-minh")?.value || 3);
        const key = tileKey(currentTile, 0);
        const t0 = performance.now();

        try {
            setInfo("Loading terrain (swissALTI3D)…");
            await swissEnsureAlti();

            const extent = swissTileExtentLV95(0);

            setInfo("Reading all points of the tile…");
            const out = await detectTrees({
                forEachPoint: window.swissTilePoints.forEach,
                extent,
                key,
                minHeight,
                groundAt: (e, n) => {
                    const alti = SWISS_ALTI.data;
                    if (!alti || SWISS_ALTI.key !== key) return NaN;
                    const i = Math.floor((e - alti.originE) * alti.invRes);
                    const j = Math.floor((alti.originN - n) * alti.invRes);
                    return i >= 0 && j >= 0 && i < alti.width && j < alti.height ? alti.z[j * alti.width + i] : NaN;
                },
                onProgress: (done, total) => {
                    showSwissImageProgress(done, total, "Reading points…");
                }
            });

            hideSwissImageProgress();

            const origin = [
                Math.round((extent.minE + extent.maxE) / 2 / 100) * 100,
                Math.round((extent.minN + extent.maxN) / 2 / 100) * 100,
                Math.round((out.trees[0]?.groundZ || 0) / 10) * 10
            ];

            state.result = { trees: out.trees, origin, extent, tileKey: key };
            show();

            const s = Math.round((performance.now() - t0) / 1000);
            const tall = out.trees.filter(t => t.height >= 15).length;
            const byType = type => out.trees.filter(t => t.leafType === type).length.toLocaleString();
            setInfo(
                `${out.trees.length.toLocaleString()} trees found (${tall.toLocaleString()} taller than 15 m; ` +
                `estimated ${byType("broadleaf")} broadleaf, ${byType("needle")} needle, ${byType("unknown")} unclear), ` +
                `from ${out.vegetation.toLocaleString()} vegetation points [${s} s]. ` +
                (SWISS_ALTI.data ? `Terrain: ${SWISS_ALTI.note}.` : "Terrain: LiDAR ground points.")
            );
        } catch (error) {
            hideSwissImageProgress();
            console.error("[trees]", error);
            setInfo(`Tree detection failed: ${error.message}`);
        } finally {
            state.busy = false;
            updateButtons();
        }
    }

    document.addEventListener("DOMContentLoaded", () => {
        el("trees-detect")?.addEventListener("click", run);
        el("trees-style")?.addEventListener("change", show);

        el("trees-season")?.addEventListener("input", event => {
            state.month = Number(event.target.value);
            if (el("trees-season-out")) el("trees-season-out").textContent = MONTHS[Math.floor(state.month - 1) % 12];
            applySeason();
        });

        let growTimer = null;
        el("trees-years")?.addEventListener("input", event => {
            state.years = Number(event.target.value);
            if (el("trees-years-out")) el("trees-years-out").textContent = state.years ? `+${state.years} years` : "today";
            clearTimeout(growTimer);
            growTimer = setTimeout(show, 120);         // rebuild (also redraws the shadows)
        });
        el("trees-bytype")?.addEventListener("change", show);
        el("trees-opacity")?.addEventListener("input", () => {
            const mesh = state.group?.getObjectByName("swiss-tree-crowns");
            if (mesh) mesh.material.uniforms.uOpacity.value = Number(el("trees-opacity").value);
        });
        el("trees-minh")?.addEventListener("input", () => {
            if (el("trees-minh-out")) el("trees-minh-out").textContent = `${el("trees-minh").value} m`;
        });
        el("trees-obj")?.addEventListener("click", exportObj);
        el("trees-csv")?.addEventListener("click", exportCsv);
        el("trees-geojson")?.addEventListener("click", exportGeoJson);

        // another tile: the trees of the old one disappear
        setInterval(() => {
            if (state.result && currentTile && state.result.tileKey !== tileKey(currentTile, 0)) {
                state.result = null;
                show();
                setInfo("");
            }
            updateButtons();
        }, 1000);

        updateButtons();
    });

    // for tests / other modules
    window.swissTrees = { detectTrees, crownBlob, stemGeometry, treeGeometry, growth, seasonPalette, current: () => state.result };
})();
