/*
 * Swiss LiDAR Viewer - scale figures (Massstabsfiguren)
 *
 * Abstract white model figures (like in architectural models), built from
 * simple boxes: standing and walking, 1.55 - 1.95 m tall. They are placed
 * on the terrain near the centre of the view - never inside buildings or at
 * tree stems - and are lit and shadowed like the surfaces.
 *
 * Needs the surfaces (surfaces.js) for terrain and building heights.
 */

(function () {
    "use strict";

    const el = id => document.getElementById(id);
    const ATMO = window.swissAtmosphere;
    const state = { group: null, seed: 1 };

    /* ============================================================
       Geometry (pure)
       ============================================================ */

    /* Box centred at (x, y, z) with size (w, d, h), rotated by angle about Z, tilted about X. */
    function box(out, x, y, z, w, d, h, angle = 0, tilt = 0, pivotZ = z + h / 2) {
        const corners = [];
        for (const sz of [-1, 1]) for (const sy of [-1, 1]) for (const sx of [-1, 1]) {
            let px = sx * w / 2, py = sy * d / 2, pz = z + sz * h / 2 - pivotZ;
            // tilt (leg / arm swing) about the X axis through the pivot
            const cy = Math.cos(tilt), sy2 = Math.sin(tilt);
            [py, pz] = [py * cy - pz * sy2, py * sy2 + pz * cy];
            pz += pivotZ;
            corners.push([px, py, pz]);
        }
        const ca = Math.cos(angle), sa = Math.sin(angle);
        const C = corners.map(([px, py, pz]) => [x + px * ca - py * sa, y + px * sa + py * ca, pz]);
        // 0..7: (-x-y-z, +x-y-z, -x+y-z, +x+y-z, -x-y+z, +x-y+z, -x+y+z, +x+y+z)
        const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
        for (const [a, b, c, d2] of faces) out.push(...C[a], ...C[b], ...C[c], ...C[a], ...C[c], ...C[d2]);
    }

    /* One figure standing at (x, y, z), facing angle; returns flat triangles. */
    function figure(x, y, z, height, angle, walking) {
        const s = height / 1.75, out = [];
        const swing = walking ? 0.35 : 0;
        const hip = z + 0.86 * s;

        // legs (swing about the hip)
        box(out, x - 0.09 * s * Math.cos(angle), y - 0.09 * s * Math.sin(angle), z + 0.43 * s, 0.13 * s, 0.16 * s, 0.86 * s, angle, swing, hip);
        box(out, x + 0.09 * s * Math.cos(angle), y + 0.09 * s * Math.sin(angle), z + 0.43 * s, 0.13 * s, 0.16 * s, 0.86 * s, angle, -swing, hip);
        // torso
        box(out, x, y, z + 1.17 * s, 0.38 * s, 0.22 * s, 0.62 * s, angle);
        // arms (swing opposite to the legs)
        const shoulder = z + 1.44 * s;
        box(out, x - 0.25 * s * Math.cos(angle), y - 0.25 * s * Math.sin(angle), z + 1.15 * s, 0.09 * s, 0.11 * s, 0.6 * s, angle, -swing * 0.7, shoulder);
        box(out, x + 0.25 * s * Math.cos(angle), y + 0.25 * s * Math.sin(angle), z + 1.15 * s, 0.09 * s, 0.11 * s, 0.6 * s, angle, swing * 0.7, shoulder);
        // neck + head
        box(out, x, y, z + 1.52 * s, 0.1 * s, 0.1 * s, 0.06 * s, angle);
        box(out, x, y, z + 1.645 * s, 0.19 * s, 0.22 * s, 0.21 * s, angle);
        return out;
    }

    /*
     * Places count figures within radius of (cx, cy). terrainAt / buildingAt
     * from surfaces; trees: [{e, n, crownDiameter}] to keep stems free.
     */
    function place({ cx, cy, radius, count, terrainAt, buildingAt, trees = [], seed = 1 }) {
        let h = (seed * 2654435761) >>> 0;
        const rnd = () => { h = (h ^ (h << 13)) >>> 0; h = (h ^ (h >>> 17)) >>> 0; h = (h ^ (h << 5)) >>> 0; return h / 4294967296; };
        const placed = [];

        for (let attempt = 0; attempt < count * 60 && placed.length < count; attempt++) {
            // more figures close to the centre, some further away; small groups
            const near = placed.length && rnd() < 0.35 ? placed[Math.floor(rnd() * placed.length)] : null;
            const r = near ? 1 + rnd() * 3 : radius * Math.sqrt(rnd());
            const a = rnd() * Math.PI * 2;
            const x = (near ? near.x : cx) + r * Math.cos(a), y = (near ? near.y : cy) + r * Math.sin(a);

            const z = terrainAt(x, y);
            if (!(z === z)) continue;

            // not in or right next to buildings
            let blocked = false;
            for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const b = buildingAt(x + dx, y + dy);
                if (b === b && b - terrainAt(x + dx, y + dy) > 1) { blocked = true; break; }
            }
            if (blocked) continue;

            // not at tree stems, not on steep ground, not on top of each other
            if (trees.some(t => Math.hypot(t.e - x, t.n - y) < Math.max(1, t.crownDiameter * 0.2))) continue;
            if (Math.abs(terrainAt(x + 1, y) - terrainAt(x - 1, y)) > 0.8 || Math.abs(terrainAt(x, y + 1) - terrainAt(x, y - 1)) > 0.8) continue;
            if (placed.some(p => Math.hypot(p.x - x, p.y - y) < 0.7)) continue;

            placed.push({ x, y, z, height: 1.55 + rnd() * 0.4, angle: rnd() * Math.PI * 2, walking: rnd() < 0.5 });
        }

        return placed;
    }

    /* ============================================================
       Display
       ============================================================ */

    const VERTEX = `
        ${ATMO.vertexDecl}
        void main() {
            ${ATMO.vertexMain}
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `;

    const FRAGMENT = `
        uniform vec3 uColor;
        ${ATMO.fragmentDecl}
        void main() {
            gl_FragColor = vec4(atmoShade(uColor), 1.0);
        }
    `;

    function clear() {
        if (state.group) {
            state.group.parent?.remove(state.group);
            state.group.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
            state.group = null;
        }
    }

    function show() {
        clear();
        if (!el("figures-on")?.checked) { ATMO.invalidate(); return; }

        const surfaces = window.swissSurfaces;
        const S = surfaces?.current();
        if (!S) {
            setStatus("Scale figures need the surfaces – click 'Build surfaces' first.");
            if (el("figures-on")) el("figures-on").checked = false;
            return;
        }

        // around the point the camera looks at
        let cx = S.minE + S.cell * (S.nx - 1) / 2, cy = S.minN + S.cell * (S.ny - 1) / 2;
        try {
            const pivot = viewer.scene.view.getPivot();
            if (pivot && Number.isFinite(pivot.x)) { cx = pivot.x; cy = pivot.y; }
        } catch (error) { /* centre of the model */ }

        const trees = window.swissTrees?.current()?.trees || [];
        const count = Number(el("figures-count")?.value || 16);
        const figures = place({
            cx, cy, radius: Number(el("figures-radius")?.value || 60), count,
            terrainAt: (e, n) => surfaces.terrainAt(e, n),
            buildingAt: (e, n) => surfaces.buildingAt(e, n),
            trees, seed: state.seed
        });

        if (!figures.length) { setStatus("No free ground for scale figures here."); return; }

        const origin = [Math.round(cx), Math.round(cy), Math.round(figures[0].z)];
        const triangles = [];
        for (const f of figures) {
            triangles.push(...figure(f.x - origin[0], f.y - origin[1], f.z - origin[2], f.height, f.angle, f.walking));
        }

        const g = new THREE.BufferGeometry();
        const attribute = new THREE.Float32BufferAttribute(triangles, 3);
        if (typeof g.setAttribute === "function") g.setAttribute("position", attribute); else g.addAttribute("position", attribute);
        g.computeVertexNormals();

        const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
            uniforms: { ...ATMO.uniforms(), uColor: { value: new THREE.Color(0xf4f2ee) } },
            vertexShader: VERTEX,
            fragmentShader: FRAGMENT
        }));
        ATMO.attach(mesh);

        const group = new THREE.Group();
        group.name = "swiss-figures";
        group.position.set(origin[0], origin[1], origin[2]);
        group.add(mesh);

        state.group = group;
        viewer.scene.scene.add(group);
        ATMO.invalidate();
        setStatus(`${figures.length} scale figures placed.`);
    }

    document.addEventListener("DOMContentLoaded", () => {
        el("figures-on")?.addEventListener("change", show);
        el("figures-count")?.addEventListener("change", show);
        el("figures-radius")?.addEventListener("change", show);
        el("figures-shuffle")?.addEventListener("click", () => { state.seed++; if (!el("figures-on")?.checked) el("figures-on").checked = true; show(); });
        el("surf-clear")?.addEventListener("click", () => { clear(); if (el("figures-on")) el("figures-on").checked = false; });
    });

    window.swissFigures = { figure, place, show };
})();
