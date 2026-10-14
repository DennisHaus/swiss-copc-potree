/*
 * Swiss LiDAR Viewer - surfaces instead of points
 *
 * Uses the classification to build closed surfaces:
 *
 *   terrain  swissALTI3D (the bare ground: streets, squares, meadows, also
 *            under trees and cars); LiDAR ground points where it is missing
 *   roofs    building points (class 6) and bridges (17): highest point per
 *            cell, small holes filled, isolated noise removed, triangulated
 *   walls    vertical faces along every roof outline down to the terrain
 *            (LiDAR barely sees facades and the orthophoto never does, so
 *            they get a neutral colour)
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

    const state = { surface: null, group: null, texture: null, busy: false, hidden: [] };

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
                terrain[j * nx + i] = z === z ? z : 0;
            }
        }

        cleanRoofs(roof, terrain, nx, ny);

        return { nx, ny, cell, minE: area.minE, minN: area.minN, terrain, roof, built };
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

    const VERTEX = `
        uniform vec4 uMap;          // (origin - texture left, texture top - origin, 1/width m, 1/height m)
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vLight;

        void main() {
            vUv = vec2((position.x + uMap.x) * uMap.z, (uMap.y - position.y) * uMap.w);
            vNormal = normalize(normalMatrix * normal);
            vLight = normalize((viewMatrix * vec4(0.35, -0.25, 1.0, 0.0)).xyz);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `;

    const FRAGMENT = `
        uniform sampler2D uTex;
        uniform float uUseTex;
        uniform vec3 uColor;
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vLight;

        void main() {
            vec3 base = uColor;
            if (uUseTex > 0.5 && vUv.x >= 0.0 && vUv.x <= 1.0 && vUv.y >= 0.0 && vUv.y <= 1.0) {
                base = texture2D(uTex, vUv).rgb;
            }
            float light = 0.62 + 0.38 * max(dot(normalize(vNormal), vLight), 0.0);
            gl_FragColor = vec4(base * light, 1.0);
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

    function material(colour, crop, useTex, origin) {
        return new THREE.ShaderMaterial({
            uniforms: {
                uTex: { value: state.texture },
                uUseTex: { value: useTex && state.texture ? 1 : 0 },
                uColor: { value: new THREE.Color(colour) },
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
        const style = el("surf-style")?.value || "ortho";
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
        addMesh(S.meshes.roof, colours.roof, useTex);
        addMesh(S.meshes.walls, colours.wall, false, S.meshes.walls.normals);

        state.group = group;
        viewer.scene.scene.add(group);
        setPointsHidden(el("surf-hide-points")?.checked !== false);
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
        const textured = !!S.crop && (el("surf-style")?.value || "ortho") !== "white";
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
        write("roofs", S.meshes.roof, textured ? "ortho" : "roof", textured);
        write("walls", S.meshes.walls, "wall", false);

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

            setInfo("Reading building points…");
            const S = await buildSurface({
                forEachPoint: window.swissTilePoints.forEach,
                area, cell, key,
                terrainAt: (e, n) => {
                    const alti = SWISS_ALTI.data;
                    if (!alti || SWISS_ALTI.key !== key) return NaN;
                    const i = Math.floor((e - alti.originE) * alti.invRes);
                    const j = Math.floor((alti.originN - n) * alti.invRes);
                    return i >= 0 && j >= 0 && i < alti.width && j < alti.height ? alti.z[j * alti.width + i] : NaN;
                },
                onProgress: (done, total) => showSwissImageProgress(done, total, "Reading points…")
            });
            hideSwissImageProgress();

            const origin = [
                Math.round((area.minE + area.maxE) / 2 / 100) * 100,
                Math.round((area.minN + area.maxN) / 2 / 100) * 100,
                Math.round(S.terrain[Math.floor(S.terrain.length / 2)] / 10) * 10
            ];

            const roofWalls = roofAndWallMeshes(S, origin);
            S.meshes = { terrain: terrainMesh(S, origin), roof: roofWalls.roof, walls: roofWalls.walls };
            S.origin = origin;
            S.extent = extent;
            S.tileKey = key;
            S.crop = rasterCrop(SWISSIMAGE_RGB.raster, area);

            makeTexture(S.crop);
            state.surface = S;
            show();

            const triangles = (S.meshes.terrain.index.length + S.meshes.roof.index.length + S.meshes.walls.index.length) / 3;
            setInfo(
                `${Math.round((area.maxE - area.minE))} × ${Math.round(area.maxN - area.minN)} m at ${cell} m: ` +
                `${Math.round(triangles).toLocaleString()} triangles` +
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

    window.swissSurfaces = { buildSurface, terrainMesh, roofAndWallMeshes, cleanRoofs };
})();
