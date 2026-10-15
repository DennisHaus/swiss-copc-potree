/*
 * Swiss LiDAR Viewer - surfaces instead of points
 *
 * Uses the classification to build closed surfaces:
 *
 *   terrain  swissALTI3D (the bare ground: streets, squares, meadows, also
 *            under trees and cars); LiDAR ground points where it is missing
 *   buildings  swissBUILDINGS3D (swisstopo's 3D Tiles, see buildings3d.js):
 *            clean roof planes and walls; or, as fallback / on request,
 *            from the LiDAR building points (class 6) and bridges (17):
 *            highest point per cell, holes filled, noise removed, with
 *            vertical walls along every roof outline
 *   walls    neutral colour (the orthophoto never shows facades)
 *
 * Vegetation, cars, poles etc. are left out - trees come from trees.js as
 * soft crown volumes.
 *
 * Colour: the current raster (SWISSIMAGE, maps, ...) as an image texture on
 * terrain and roofs, or a white massing model.
 *
 * Export: OBJ + MTL + PNG texture for Rhino (local origin, Z up).
 */

(function () {
    "use strict";

    const BUILT = new Uint8Array(256);
    BUILT[6] = 1;
    BUILT[17] = 1;
    const GROUND = new Uint8Array(256);
    GROUND[2] = 1;
    GROUND[9] = 1;

    const state = { surface: null, group: null, texture: null, busy: false, hidden: [], look: null };

    /* ============================================================
       GRIDS (pure computation)
       ============================================================ */

    /*
     * One pass over the points: highest built point per cell, lowest
     * ground point per 2 m (fallback terrain). area = region to model.
     */
    async function buildSurface({ forEachPoint, area, cell, terrainAt, onProgress, key = "" }) {
        const nx = Math.round((area.maxE - area.minE) / cell) + 1;     // vertices at cell centres
        const ny = Math.round((area.maxN - area.minN) / cell) + 1;
        const n = nx * ny;
        const roof = new Float32Array(n).fill(NaN);

        const groundGrid = {
            key,
            ground: {
                cell: 2, minE: area.minE, minN: area.minN,
                nx: Math.ceil((area.maxE - area.minE) / 2) + 1,
                ny: Math.ceil((area.maxN - area.minN) / 2) + 1,
                raw: null, filled: null, dirty: false, filledAt: 0
            }
        };
        groundGrid.ground.raw = new Float32Array(groundGrid.ground.nx * groundGrid.ground.ny).fill(NaN);

        let built = 0;
        const half = cell / 2;

        await forEachPoint((e, nn, z, cls) => {
            if (GROUND[cls]) {
                const g = groundGrid.ground;
                const i = Math.floor((e - area.minE) / 2), j = Math.floor((nn - area.minN) / 2);
                if (i >= 0 && j >= 0 && i < g.nx && j < g.ny) {
                    const k = j * g.nx + i;
                    if (!(g.raw[k] <= z)) { g.raw[k] = z; g.dirty = true; }
                }
                return;
            }

            if (!BUILT[cls]) return;

            const i = Math.floor((e - area.minE + half) / cell), j = Math.floor((nn - area.minN + half) / cell);
            if (i < 0 || j < 0 || i >= nx || j >= ny) return;

            const k = j * nx + i;
            if (!(roof[k] >= z)) roof[k] = z;
            built++;
        }, onProgress);

        swissGroundFill(groundGrid.ground);

        // terrain at every vertex
        const terrain = new Float32Array(n);
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const e = area.minE + i * cell, nn = area.minN + j * cell;
                let z = terrainAt(e, nn);
                if (!(z === z)) z = swissGroundZ(groundGrid, e, nn);
                terrain[j * nx + i] = z;      // NaN: filled below
            }
        }

        // gaps (e.g. right at the tile edge): nearest valid neighbour, never 0
        fillGaps(terrain, nx, ny);

        cleanRoofs(roof, terrain, nx, ny);

        return { nx, ny, cell, minE: area.minE, minN: area.minN, terrain, roof, built };
    }

    /* Fill NaN cells with the nearest valid value (two-pass propagation). */
    function fillGaps(z, nx, ny) {
        let missing = 0;
        for (let k = 0; k < z.length; k++) if (!(z[k] === z[k])) missing++;
        if (!missing || missing === z.length) { if (missing) z.fill(0); return; }

        const dist = new Float32Array(z.length);
        for (let k = 0; k < z.length; k++) dist[k] = z[k] === z[k] ? 0 : Infinity;
        const relax = (k, m) => { if (dist[m] + 1 < dist[k]) { dist[k] = dist[m] + 1; z[k] = z[m]; } };

        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
            const k = j * nx + i;
            if (i > 0) relax(k, k - 1);
            if (j > 0) relax(k, k - nx);
        }
        for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
            const k = j * nx + i;
            if (i < nx - 1) relax(k, k + 1);
            if (j < ny - 1) relax(k, k + nx);
        }
    }

    /* Drop low/isolated built cells, close small holes in roofs. */
    function cleanRoofs(roof, terrain, nx, ny) {
        const n = nx * ny;

        // at least 1.5 m above the terrain
        for (let k = 0; k < n; k++) {
            if (roof[k] === roof[k] && roof[k] - terrain[k] < 1.5) roof[k] = NaN;
        }

        const neighbours = (k, fn) => {
            const i = k % nx, j = (k - i) / nx;
            for (let dj = -1; dj <= 1; dj++) {
                for (let di = -1; di <= 1; di++) {
                    if (!di && !dj) continue;
                    const ii = i + di, jj = j + dj;
                    if (ii >= 0 && jj >= 0 && ii < nx && jj < ny) fn(jj * nx + ii);
                }
            }
        };

        // fill holes: empty cells mostly surrounded by roof
        for (let pass = 0; pass < 3; pass++) {
            const add = [];
            for (let k = 0; k < n; k++) {
                if (roof[k] === roof[k]) continue;
                let count = 0, sum = 0;
                neighbours(k, q => { if (roof[q] === roof[q]) { count++; sum += roof[q]; } });
                if (count >= 5) add.push(k, sum / count);
            }
            if (!add.length) break;
            for (let a = 0; a < add.length; a += 2) roof[add[a]] = add[a + 1];
        }

        // remove isolated cells (single noise hits)
        const drop = [];
        for (let k = 0; k < n; k++) {
            if (!(roof[k] === roof[k])) continue;
            let count = 0;
            neighbours(k, q => { if (roof[q] === roof[q]) count++; });
            if (count < 2) drop.push(k);
        }
        for (const k of drop) roof[k] = NaN;
    }

    /* ============================================================
       MESHES (pure computation; coordinates relative to origin)
       ============================================================ */

    function terrainMesh(S, origin) {
        const { nx, ny, cell, minE, minN, terrain } = S;
        const positions = new Float32Array(nx * ny * 3);

        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const k = j * nx + i;
                positions[k * 3] = minE + i * cell - origin[0];
                positions[k * 3 + 1] = minN + j * cell - origin[1];
                positions[k * 3 + 2] = terrain[k] - origin[2];
            }
        }

        const index = new Uint32Array((nx - 1) * (ny - 1) * 6);
        let p = 0;
        for (let j = 0; j < ny - 1; j++) {
            for (let i = 0; i < nx - 1; i++) {
                const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
                index[p++] = a; index[p++] = b; index[p++] = d;
                index[p++] = a; index[p++] = d; index[p++] = c;
            }
        }

        return { positions, index };
    }

    /*
     * Roofs: triangles between neighbouring roof cells (2x2 blocks with 3 or
     * 4 roof corners). Walls: every roof edge used by only one triangle is
     * an outline edge and gets a vertical face down to the terrain.
     */
    function roofAndWallMeshes(S, origin) {
        const { nx, ny, cell, minE, minN, terrain, roof } = S;
        const vertexOf = new Int32Array(nx * ny).fill(-1);
        const rp = [];

        const vertex = k => {
            if (vertexOf[k] < 0) {
                const i = k % nx, j = (k - i) / nx;
                vertexOf[k] = rp.length / 3;
                rp.push(minE + i * cell - origin[0], minN + j * cell - origin[1], roof[k] - origin[2]);
            }
            return vertexOf[k];
        };

        const tris = [];           // grid cell ids
        const has = k => roof[k] === roof[k];

        for (let j = 0; j < ny - 1; j++) {
            for (let i = 0; i < nx - 1; i++) {
                const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
                const ha = has(a), hb = has(b), hc = has(c), hd = has(d);
                const count = ha + hb + hc + hd;

                // do not bridge roofs of very different height (separate buildings / levels)
                const zs = [a, b, c, d].filter(has).map(k => roof[k]);
                if (count >= 3 && Math.max(...zs) - Math.min(...zs) > 4) continue;

                if (count === 4) { tris.push(a, b, d, a, d, c); }
                else if (count === 3) {
                    if (!ha) tris.push(b, d, c);
                    else if (!hb) tris.push(a, d, c);
                    else if (!hc) tris.push(a, b, d);
                    else tris.push(a, b, c);
                }
            }
        }

        // outline edges (used once), with the triangle's third corner
        const edges = new Map();
        const n = nx * ny;
        for (let t = 0; t < tris.length; t += 3) {
            for (let s = 0; s < 3; s++) {
                const u = tris[t + s], v = tris[t + (s + 1) % 3], w = tris[t + (s + 2) % 3];
                const key = u < v ? u * n + v : v * n + u;
                const entry = edges.get(key);
                if (entry) entry.count++;
                else edges.set(key, { u, v, w, count: 1 });
            }
        }

        const roofIndex = tris.map(vertex);

        // walls
        const wp = [], wn = [], wi = [];
        for (const { u, v, w, count } of edges.values()) {
            if (count !== 1) continue;

            const ui = u % nx, uj = (u - ui) / nx, vi = v % nx, vj = (v - vi) / nx, xi = w % nx, xj = (w - xi) / nx;
            // outward normal: perpendicular to the edge, away from the third corner
            let ex = vi - ui, ey = vj - uj;
            let nxv = ey, nyv = -ex;
            const mx = (ui + vi) / 2 - xi, my = (uj + vj) / 2 - xj;
            if (nxv * mx + nyv * my < 0) { nxv = -nxv; nyv = -nyv; }
            const len = Math.hypot(nxv, nyv) || 1;
            nxv /= len; nyv /= len;

            const base = wp.length / 3;
            for (const k of [u, v]) {
                const i = k % nx, j = (k - i) / nx;
                const x = minE + i * cell - origin[0], y = minN + j * cell - origin[1];
                wp.push(x, y, roof[k] - origin[2], x, y, terrain[k] - 0.3 - origin[2]);
                wn.push(nxv, nyv, 0, nxv, nyv, 0);
            }
            // u-top, u-bottom, v-top, v-bottom
            wi.push(base, base + 1, base + 3, base, base + 3, base + 2);
        }

        return {
            roof: { positions: new Float32Array(rp), index: new Uint32Array(roofIndex) },
            walls: { positions: new Float32Array(wp), normals: new Float32Array(wn), index: new Uint32Array(wi) }
        };
    }

    /*
     * Highest building surface per cell (top view), from swissBUILDINGS3D
     * triangles (LV95). Used for 3D prints and to keep scale figures outside.
     */
    function rasteriseTriangles(T, grid) {
        const { minE, minN, cell, nx, ny } = grid;
        const z = grid.z || (grid.z = new Float32Array(nx * ny).fill(NaN));

        for (let t = 0; t + 8 < T.length; t += 9) {
            const ax = T[t], ay = T[t + 1], az = T[t + 2];
            const bx = T[t + 3], by = T[t + 4], bz = T[t + 5];
            const cx = T[t + 6], cy = T[t + 7], cz = T[t + 8];
            const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
            if (Math.abs(det) < 1e-9) continue;             // vertical wall: seen edge-on from above

            const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - minE) / cell));
            const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - minE) / cell));
            const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - minN) / cell));
            const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - minN) / cell));

            for (let j = j0; j <= j1; j++) {
                const py = minN + (j + 0.5) * cell;
                for (let i = i0; i <= i1; i++) {
                    const px = minE + (i + 0.5) * cell;
                    const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
                    const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
                    const l3 = 1 - l1 - l2;
                    if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
                    const h = l1 * az + l2 * bz + l3 * cz;
                    const k = j * nx + i;
                    if (!(z[k] >= h)) z[k] = h;
                }
            }
        }
        return grid;
    }

    /* swissBUILDINGS3D triangles (LV95) -> flat-shaded mesh relative to origin */
    function buildingMesh(triangles, origin, marked = null) {
        const n = triangles.length;
        const positions = new Float32Array(n), normals = new Float32Array(n);
        const flag = new Float32Array(n / 3);
        if (marked) for (const t of marked) flag[t / 3] = flag[t / 3 + 1] = flag[t / 3 + 2] = 1;

        for (let i = 0; i < n; i += 9) {
            for (let k = 0; k < 9; k += 3) {
                positions[i + k] = triangles[i + k] - origin[0];
                positions[i + k + 1] = triangles[i + k + 1] - origin[1];
                positions[i + k + 2] = triangles[i + k + 2] - origin[2];
            }
            const ax = positions[i + 3] - positions[i], ay = positions[i + 4] - positions[i + 1], az = positions[i + 5] - positions[i + 2];
            const bx = positions[i + 6] - positions[i], by = positions[i + 7] - positions[i + 1], bz = positions[i + 8] - positions[i + 2];
            let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
            const len = Math.hypot(nx, ny, nz) || 1;
            nx /= len; ny /= len; nz /= len;
            for (let k = 0; k < 9; k += 3) { normals[i + k] = nx; normals[i + k + 1] = ny; normals[i + k + 2] = nz; }
        }

        return { positions, normals, flag };
    }

    /*
     * swissBUILDINGS3D roofs vs LiDAR (highest building point per cell):
     * common offset (median) and the share of roof area that differs by
     * more than 1 m after correcting it. Marks those triangles.
     */
    function compareWithLidar(S, T) {
        const diffs = [], tris = [];

        for (let t = 0; t + 8 < T.length; t += 9) {
            const ax = T[t + 3] - T[t], ay = T[t + 4] - T[t + 1], az = T[t + 5] - T[t + 2];
            const bx = T[t + 6] - T[t], by = T[t + 7] - T[t + 1], bz = T[t + 8] - T[t + 2];
            const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
            const len = Math.hypot(nx, ny, nz);
            if (!len || Math.abs(nz / len) < 0.3) continue;            // walls

            const e = (T[t] + T[t + 3] + T[t + 6]) / 3, n = (T[t + 1] + T[t + 4] + T[t + 7]) / 3, z = (T[t + 2] + T[t + 5] + T[t + 8]) / 3;
            const i = Math.round((e - S.minE) / S.cell), j = Math.round((n - S.minN) / S.cell);
            if (i < 0 || j < 0 || i >= S.nx || j >= S.ny) continue;
            const lidar = S.roof[j * S.nx + i];
            if (!(lidar === lidar)) continue;

            diffs.push(lidar - z);
            tris.push(t, Math.abs(nz) / 2);                           // area in plan
        }

        if (!diffs.length) return { shift: 0, compared: 0, offShare: 0, marked: new Set() };

        const sorted = diffs.filter(d => Math.abs(d) < 5).sort((a, b) => a - b);
        const shift = sorted.length ? sorted[sorted.length >> 1] : 0;

        let area = 0, offArea = 0;
        const marked = new Set();
        for (let k = 0; k < diffs.length; k++) {
            const a = tris[2 * k + 1];
            area += a;
            if (Math.abs(diffs[k] - shift) > 1) { offArea += a; marked.add(tris[2 * k]); }
        }

        return { shift, compared: diffs.length, offShare: area ? offArea / area : 0, marked };
    }

    /* ============================================================
       TEXTURE from the current raster
       ============================================================ */

    function maxTexture() {
        try {
            const gl = viewer.renderer.getContext();
            return Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE));
        } catch (error) {
            return 2048;
        }
    }

    /* Crop of the raster over the area, at most maxTexture() px, RGBA. */
    function rasterCrop(raster, area) {
        if (!raster || raster.kind !== "lv95") return null;

        const x0 = Math.max(0, Math.floor((area.minE - raster.originE) / raster.resE));
        const x1 = Math.min(raster.width, Math.ceil((area.maxE - raster.originE) / raster.resE));
        const y0 = Math.max(0, Math.floor((raster.originN - area.maxN) / raster.resN));
        const y1 = Math.min(raster.height, Math.ceil((raster.originN - area.minN) / raster.resN));
        if (x1 <= x0 || y1 <= y0) return null;

        const f = Math.max(1, Math.ceil(Math.max(x1 - x0, y1 - y0) / maxTexture()));
        const w = Math.floor((x1 - x0) / f), h = Math.floor((y1 - y0) / f);
        const rgba = new Uint8Array(w * h * 4);

        for (let j = 0; j < h; j++) {
            for (let i = 0; i < w; i++) {
                const p = ((y0 + j * f) * raster.width + x0 + i * f) * 3;
                const q = (j * w + i) * 4;
                rgba[q] = raster.rgb[p]; rgba[q + 1] = raster.rgb[p + 1]; rgba[q + 2] = raster.rgb[p + 2]; rgba[q + 3] = 255;
            }
        }

        return {
            rgba, width: w, height: h,
            left: raster.originE + x0 * raster.resE,
            top: raster.originN - y0 * raster.resN,
            widthM: w * f * raster.resE,
            heightM: h * f * raster.resN
        };
    }

    /* ============================================================
       DISPLAY
       ============================================================ */

    const ATMO = window.swissAtmosphere;

    const VERTEX = `
        uniform vec4 uMap;          // (origin - texture left, texture top - origin, 1/width m, 1/height m)
        attribute float aFlag;
        varying vec2 vUv;
        varying float vUp;
        varying float vFlag;
        ${ATMO.vertexDecl}

        void main() {
            vFlag = aFlag;
            vUv = vec2((position.x + uMap.x) * uMap.z, (uMap.y - position.y) * uMap.w);
            vUp = normal.z;
            ${ATMO.vertexMain}
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `;

    const FRAGMENT = `
        uniform sampler2D uTex;
        uniform float uUseTex;
        uniform vec3 uColor;
        uniform vec3 uRoofColor;
        uniform float uSplit;       // 1: faces pointing up are roofs, the rest walls
        varying vec2 vUv;
        varying float vUp;
        varying float vFlag;
        ${ATMO.fragmentDecl}

        void main() {
            bool roof = uSplit < 0.5 || abs(vUp) > 0.3;
            vec3 base = uSplit > 0.5 && roof ? uRoofColor : uColor;
            if (roof && uUseTex > 0.5 && vUv.x >= 0.0 && vUv.x <= 1.0 && vUv.y >= 0.0 && vUv.y <= 1.0) {
                base = texture2D(uTex, vUv).rgb;
            }
            if (vFlag > 0.5) base = mix(base, vec3(0.86, 0.22, 0.18), 0.75);   // differs from LiDAR
            gl_FragColor = vec4(atmoShade(base), 1.0);
        }
    `;

    function setAttr(geometry, name, attribute) {
        if (typeof geometry.setAttribute === "function") geometry.setAttribute(name, attribute);
        else geometry.addAttribute(name, attribute);
    }

    function worldOffset(extent) {
        try {
            const box = currentPointCloud?.boundingBox?.clone();
            if (!box) return [0, 0];
            if (currentPointCloud.matrixWorld && !currentPointCloud.isLaz) box.applyMatrix4(currentPointCloud.matrixWorld);
            const dx = box.min.x - extent.minE, dy = box.min.y - extent.minN;
            if (Math.abs(dx) > 100000 || Math.abs(dy) > 100000) return [dx, dy];
        } catch (error) { /* LV95 */ }
        return [0, 0];
    }

    const COLOURS = {
        white: { terrain: 0xe8e5de, roof: 0xd6d1c8, wall: 0xf3f1ec },
        ortho: { terrain: 0xb8b8b0, roof: 0xa8a49c, wall: 0xd9d3c9 }
    };

    function material(colour, crop, useTex, origin, roofColour = null) {
        return new THREE.ShaderMaterial({
            uniforms: {
                ...ATMO.uniforms(),
                uTex: { value: state.texture },
                uUseTex: { value: useTex && state.texture ? 1 : 0 },
                uColor: { value: new THREE.Color(colour) },
                uRoofColor: { value: new THREE.Color(roofColour ?? colour) },
                uSplit: { value: roofColour === null ? 0 : 1 },
                uMap: {
                    value: crop
                        ? new THREE.Vector4(origin[0] - crop.left, crop.top - origin[1], 1 / crop.widthM, 1 / crop.heightM)
                        : new THREE.Vector4(0, 0, 0, 0)
                }
            },
            vertexShader: VERTEX,
            fragmentShader: FRAGMENT,
            side: THREE.DoubleSide
        });
    }

    function show() {
        if (state.group) {
            state.group.parent?.remove(state.group);
            state.group.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); });
            state.group = null;
        }

        setPointsHidden(false);
        if (!state.surface || !viewer?.scene?.scene) return;

        const S = state.surface;
        const style = state.look || el("surf-style")?.value || "white";
        const colours = COLOURS[style === "white" ? "white" : "ortho"];
        const useTex = style !== "white";

        const group = new THREE.Group();
        group.name = "swiss-surfaces";
        const [ox, oy] = worldOffset(S.extent);
        group.position.set(S.origin[0] + ox, S.origin[1] + oy, S.origin[2]);

        const addMesh = (mesh, colour, tex, normals) => {
            if (!mesh.index.length) return;
            const g = new THREE.BufferGeometry();
            setAttr(g, "position", new THREE.BufferAttribute(mesh.positions, 3));
            if (normals) setAttr(g, "normal", new THREE.BufferAttribute(normals, 3));
            g.setIndex(new THREE.BufferAttribute(mesh.index, 1));
            if (!normals) g.computeVertexNormals();
            group.add(new THREE.Mesh(g, material(colour, S.crop, tex, S.origin)));
        };

        addMesh(S.meshes.terrain, colours.terrain, useTex);

        if (S.meshes.buildings) {
            // swissBUILDINGS3D: flat faces, roofs vs walls by slope
            const B = S.meshes.buildings;
            const g = new THREE.BufferGeometry();
            setAttr(g, "position", new THREE.BufferAttribute(B.positions, 3));
            setAttr(g, "normal", new THREE.BufferAttribute(B.normals, 3));
            setAttr(g, "aFlag", new THREE.BufferAttribute(el("surf-mark-diff")?.checked ? B.flag : new Float32Array(B.flag.length), 1));
            group.add(new THREE.Mesh(g, material(colours.wall, S.crop, useTex, S.origin, colours.roof)));
        } else {
            addMesh(S.meshes.roof, colours.roof, useTex);
            addMesh(S.meshes.walls, colours.wall, false, S.meshes.walls.normals);
        }

        group.traverse(o => { if (o.isMesh) ATMO.attach(o); });
        state.group = group;
        viewer.scene.scene.add(group);
        setPointsHidden(el("surf-hide-points")?.checked !== false);
        ATMO.invalidate();
    }

    function setPointsHidden(hidden) {
        if (hidden) {
            for (const pc of viewer?.scene?.pointclouds || []) {
                if (pc.visible) { pc.visible = false; state.hidden.push(pc); }
            }
            if (currentPointCloud?.isLaz && currentPointCloud.visible) {
                currentPointCloud.visible = false;
                state.hidden.push(currentPointCloud);
            }
        } else {
            for (const pc of state.hidden) pc.visible = true;
            state.hidden = [];
        }
    }

    function makeTexture(crop) {
        if (state.texture) { state.texture.dispose(); state.texture = null; }
        if (!crop) return;

        const tex = new THREE.DataTexture(crop.rgba, crop.width, crop.height, THREE.RGBAFormat);
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.flipY = false;
        tex.needsUpdate = true;
        state.texture = tex;
    }

    /* ============================================================
       EXPORT: OBJ + MTL + PNG
       ============================================================ */

    function download(name, data, type) {
        const blob = data instanceof Blob ? data : new Blob([data], { type });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
    }

    async function exportObj() {
        const S = state.surface;
        if (!S) return;

        const name = `surfaces_${(typeof swissKmTileId === "function" && swissKmTileId(currentTile)) || "tile"}`;
        const textured = !!S.crop && (el("surf-style")?.value || "white") !== "white";
        const out = [
            "# Surfaces from swissSURFACE3D + swissALTI3D (Swiss LiDAR Viewer)",
            `# Local coordinates. LV95 = local + (${S.origin.join(", ")})`,
            "# Z is up: in Rhino's OBJ import keep 'Map OBJ Y to Rhino Z' switched OFF.",
            `mtllib ${name}.mtl`
        ];
        const fix = x => x.toFixed(3);
        let base = 1;

        const write = (label, mesh, mtl, uv) => {
            if (!mesh.index.length) return;
            out.push(`o ${label}`, `usemtl ${mtl}`);
            const P = mesh.positions;
            for (let p = 0; p < P.length; p += 3) out.push(`v ${fix(P[p])} ${fix(P[p + 1])} ${fix(P[p + 2])}`);
            if (uv) {
                const c = S.crop;
                for (let p = 0; p < P.length; p += 3) {
                    const u = (P[p] + S.origin[0] - c.left) / c.widthM;
                    const v = 1 - (c.top - (P[p + 1] + S.origin[1])) / c.heightM;
                    out.push(`vt ${u.toFixed(5)} ${v.toFixed(5)}`);
                }
            }
            const I = mesh.index;
            for (let t = 0; t < I.length; t += 3) {
                const a = I[t] + base, b = I[t + 1] + base, c = I[t + 2] + base;
                out.push(uv ? `f ${a}/${a} ${b}/${b} ${c}/${c}` : `f ${a} ${b} ${c}`);
            }
            base += P.length / 3;
        };

        setStatus("Writing OBJ…");
        write("terrain", S.meshes.terrain, textured ? "ortho" : "terrain", textured);

        if (S.meshes.buildings) {
            // split swissBUILDINGS3D faces into roofs (pointing up) and walls
            const B = S.meshes.buildings.positions, Nn = S.meshes.buildings.normals;
            const roofs = [], walls = [];
            for (let i = 0; i < B.length; i += 9) (Math.abs(Nn[i + 2]) > 0.3 ? roofs : walls).push(i);
            const asMesh = list => {
                const positions = new Float32Array(list.length * 9);
                list.forEach((i, t) => positions.set(B.subarray(i, i + 9), t * 9));
                return { positions, index: Uint32Array.from({ length: list.length * 3 }, (_, k) => k) };
            };
            write("roofs", asMesh(roofs), textured ? "ortho" : "roof", textured);
            write("walls", asMesh(walls), "wall", false);
        } else {
            write("roofs", S.meshes.roof, textured ? "ortho" : "roof", textured);
            write("walls", S.meshes.walls, "wall", false);
        }

        const mtl = [
            "newmtl terrain", "Kd 0.91 0.90 0.87",
            "newmtl roof", "Kd 0.84 0.82 0.78",
            "newmtl wall", "Kd 0.95 0.94 0.92"
        ];
        if (textured) mtl.push("newmtl ortho", "Kd 1 1 1", `map_Kd ${name}.png`);

        download(`${name}.obj`, out.join("\n"), "text/plain");
        download(`${name}.mtl`, mtl.join("\n"), "text/plain");

        if (textured) {
            const c = S.crop;
            const canvas = document.createElement("canvas");
            canvas.width = c.width;
            canvas.height = c.height;
            canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(c.rgba.buffer.slice(0)), c.width, c.height), 0, 0);
            const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
            if (png) download(`${name}.png`, png);
        }

        window.usageCounter?.hit("downloads");
        setStatus("Surfaces exported (OBJ, MTL" + (textured ? ", PNG texture" : "") + ").");
    }

    /* ============================================================
       UI
       ============================================================ */

    const el = id => document.getElementById(id);

    function setInfo(text) {
        if (el("surf-info")) el("surf-info").textContent = text;
    }

    /* Area to model: whole tile at 1 m, or 600 m around the view at 0.5 m. */
    function modelArea(extent, cell) {
        if (cell >= 1) return { ...extent };

        let cx = (extent.minE + extent.maxE) / 2, cy = (extent.minN + extent.maxN) / 2;
        try {
            const pivot = viewer.scene.view.getPivot();
            const [ox, oy] = worldOffset(extent);
            if (pivot && Number.isFinite(pivot.x)) { cx = pivot.x - ox; cy = pivot.y - oy; }
        } catch (error) { /* tile centre */ }

        const half = 300;
        cx = Math.min(extent.maxE - half, Math.max(extent.minE + half, cx));
        cy = Math.min(extent.maxN - half, Math.max(extent.minN + half, cy));
        return { minE: cx - half, maxE: cx + half, minN: cy - half, maxN: cy + half };
    }

    async function run() {
        if (state.busy || !currentTile || !window.swissTilePoints) return;
        state.busy = true;
        if (el("surf-build")) el("surf-build").disabled = true;

        const cell = Number(el("surf-detail")?.value || 1);
        const key = tileKey(currentTile, 0);
        const t0 = performance.now();

        try {
            setInfo("Loading terrain (swissALTI3D)…");
            await swissEnsureAlti();

            const extent = swissTileExtentLV95(0);
            const area = modelArea(extent, cell);

            const terrainAt = (e, n) => swissAltiAt(e, n, key);

            const wantSb3d = (el("surf-buildings")?.value || "sb3d") === "sb3d";
            const haveAlti = !!SWISS_ALTI.data && SWISS_ALTI.key === key;

            // swissBUILDINGS3D first; LiDAR points are only read when needed
            let sb3d = null, sb3dNote = "";
            if (wantSb3d) {
                try {
                    sb3d = await window.swissBuildings3D.loadBuildings({
                        area, terrainAt,
                        onProgress: text => setInfo(text)
                    });
                    if (!sb3d.triangles.length) { sb3dNote = "no swissBUILDINGS3D buildings here"; sb3d = null; }
                } catch (error) {
                    console.warn("[surfaces] swissBUILDINGS3D:", error);
                    sb3dNote = `swissBUILDINGS3D unavailable (${error.message}) – buildings from LiDAR`;
                }
            }

            const checkLidar = !!sb3d && el("surf-check-lidar")?.checked !== false;
            const readPoints = !sb3d || !haveAlti || checkLidar;
            if (readPoints) setInfo(checkLidar ? "Reading LiDAR building points to check heights…" : sb3d ? "Reading ground points (no swissALTI3D)…" : "Reading building points…");

            const S = await buildSurface({
                forEachPoint: readPoints ? window.swissTilePoints.forEach : async () => 0,
                area, cell, key, terrainAt,
                onProgress: (done, total) => showSwissImageProgress(done, total, "Reading points…")
            });
            hideSwissImageProgress();
            S.sb3d = sb3d;
            S.sb3dNote = sb3dNote;

            if (sb3d && checkLidar) {
                S.check = compareWithLidar(S, sb3d.triangles);
                if (Math.abs(S.check.shift) >= 0.1) {
                    const T = sb3d.triangles;
                    for (let i = 2; i < T.length; i += 3) T[i] += S.check.shift;
                }
            }

            const origin = [
                Math.round((area.minE + area.maxE) / 2 / 100) * 100,
                Math.round((area.minN + area.maxN) / 2 / 100) * 100,
                Math.round(S.terrain[Math.floor(S.terrain.length / 2)] / 10) * 10
            ];

            if (S.sb3d) {
                S.meshes = { terrain: terrainMesh(S, origin), buildings: buildingMesh(S.sb3d.triangles, origin, S.check?.marked) };
            } else {
                const roofWalls = roofAndWallMeshes(S, origin);
                S.meshes = { terrain: terrainMesh(S, origin), roof: roofWalls.roof, walls: roofWalls.walls };
            }
            S.origin = origin;
            S.extent = extent;
            S.tileKey = key;
            S.crop = rasterCrop(SWISSIMAGE_RGB.raster, area);

            // 1 m building height raster (prints, scale figures)
            S.buildingGrid = { minE: area.minE, minN: area.minN, cell: 1,
                nx: Math.ceil((area.maxE - area.minE)), ny: Math.ceil((area.maxN - area.minN)) };
            if (S.sb3d) {
                rasteriseTriangles(S.sb3d.triangles, S.buildingGrid);
            } else {
                const g = S.buildingGrid;
                g.z = new Float32Array(g.nx * g.ny).fill(NaN);
                for (let j = 0; j < S.ny; j++) for (let i = 0; i < S.nx; i++) {
                    const h = S.roof[j * S.nx + i];
                    if (!(h === h)) continue;
                    const gi = Math.floor(i * S.cell), gj = Math.floor(j * S.cell);
                    if (gi < g.nx && gj < g.ny && !(g.z[gj * g.nx + gi] >= h)) g.z[gj * g.nx + gi] = h;
                }
            }

            makeTexture(S.crop);
            state.surface = S;
            show();

            const buildingTriangles = S.meshes.buildings
                ? S.meshes.buildings.positions.length / 9
                : (S.meshes.roof.index.length + S.meshes.walls.index.length) / 3;
            setInfo(
                `${Math.round((area.maxE - area.minE))} × ${Math.round(area.maxN - area.minN)} m, terrain ${cell} m; ` +
                `buildings: ${S.sb3d ? "swissBUILDINGS3D" : "from LiDAR"} (${Math.round(buildingTriangles).toLocaleString()} triangles)` +
                (S.sb3dNote ? ` – ${S.sb3dNote}` : "") +
                (S.check ? `; LiDAR check: common offset ${S.check.shift >= 0 ? "+" : ""}${S.check.shift.toFixed(2)} m corrected, ` +
                    `${Math.round(S.check.offShare * 100)} % of the roof area differs by > 1 m (${S.check.compared.toLocaleString()} roof faces compared)` : "") +
                (S.crop ? `, texture ${S.crop.width} × ${S.crop.height} px` : ", no raster texture (colour the tile with an LV95 raster first)") +
                ` [${Math.round((performance.now() - t0) / 1000)} s].`
            );
            if (el("surf-obj")) el("surf-obj").disabled = false;
        } catch (error) {
            hideSwissImageProgress();
            console.error("[surfaces]", error);
            setInfo(`Building surfaces failed: ${error.message}`);
        } finally {
            state.busy = false;
            if (el("surf-build")) el("surf-build").disabled = false;
        }
    }

    function clear() {
        state.surface = null;
        show();
        makeTexture(null);
        setInfo("");
        if (el("surf-obj")) el("surf-obj").disabled = true;
    }

    document.addEventListener("DOMContentLoaded", () => {
        el("surf-build")?.addEventListener("click", run);
        el("surf-clear")?.addEventListener("click", clear);
        el("surf-style")?.addEventListener("change", show);
        el("surf-mark-diff")?.addEventListener("change", show);
        el("surf-hide-points")?.addEventListener("change", event => {
            setPointsHidden(false);
            if (state.group) setPointsHidden(event.target.checked);
        });
        el("surf-obj")?.addEventListener("click", () => exportObj().catch(error => setStatus(`Export failed: ${error.message}`)));

        // another tile: remove the old surfaces
        setInterval(() => {
            if (state.surface && currentTile && state.surface.tileKey !== tileKey(currentTile, 0)) clear();
        }, 1000);
    });

    /* used by render.js for the style series */
    const view = {
        has: () => !!state.surface,
        look: () => state.look || el("surf-style")?.value || "white",
        setLook(look) { state.look = look; show(); },
        resetLook() { state.look = null; show(); },
        setVisible(visible) { if (state.group) state.group.visible = visible; },
        visible: () => !!state.group?.visible,
        setPointsHidden(hidden) { setPointsHidden(false); if (hidden && state.group) setPointsHidden(true); },
        pointsHidden: () => state.hidden.length > 0
    };

    /* terrain height (bilinear on the terrain grid) */
    function terrainAt(S, e, n) {
        const fx = (e - S.minE) / S.cell, fy = (n - S.minN) / S.cell;
        const i = Math.max(0, Math.min(S.nx - 2, Math.floor(fx))), j = Math.max(0, Math.min(S.ny - 2, Math.floor(fy)));
        const u = Math.min(1, Math.max(0, fx - i)), v = Math.min(1, Math.max(0, fy - j));
        const T = S.terrain, k = j * S.nx + i;
        return (T[k] * (1 - u) + T[k + 1] * u) * (1 - v) + (T[k + S.nx] * (1 - u) + T[k + S.nx + 1] * u) * v;
    }

    function buildingAt(S, e, n) {
        const g = S?.buildingGrid;
        if (!g?.z) return NaN;
        const i = Math.floor((e - g.minE) / g.cell), j = Math.floor((n - g.minN) / g.cell);
        return i >= 0 && j >= 0 && i < g.nx && j < g.ny ? g.z[j * g.nx + i] : NaN;
    }

    window.swissSurfaces = {
        buildSurface, terrainMesh, roofAndWallMeshes, cleanRoofs, rasteriseTriangles, fillGaps, compareWithLidar, view,
        current: () => state.surface,
        terrainAt: (e, n) => state.surface ? terrainAt(state.surface, e, n) : NaN,
        buildingAt: (e, n) => buildingAt(state.surface, e, n)
    };
})();
