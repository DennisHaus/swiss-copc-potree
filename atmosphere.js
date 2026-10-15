/*
 * Swiss LiDAR Viewer - light and atmosphere
 *
 * Shared by the surfaces (surfaces.js), the tree crowns (trees.js) and the
 * image renderer (render.js):
 *
 *   sun       position from date, time and the tile's location (simplified
 *             NOAA formulas, ~0.5 deg); warm, low light in the evening
 *   shadows   buildings and crowns cast shadows onto terrain and roofs: the
 *             scene is drawn once from the sun into a depth map (shadow map)
 *   fog       distance haze in the colour of the horizon
 *   sky       gradient + sun glow, composed under rendered images
 *   vignette  optional darkening of the image corners (renders)
 *   focus     depth of field as tilt-shift (model-photo look): a sharp band,
 *             increasingly blurred above and below (renders)
 *   section   the active section box (app.js) also cuts surfaces, crowns
 *             and figures, not only the points
 *
 * Meshes use the shader pieces exported here; their uniforms are shared, so
 * changing the sun or fog updates everything at once.
 *
 * Loaded after Potree/three.js and before trees.js / surfaces.js.
 */

(function () {
    "use strict";

    const el = id => document.getElementById(id);
    const rad = Math.PI / 180;

    /* ============================================================
       Shared uniforms
       ============================================================ */

    const DEFAULT_SUN = new THREE.Vector3(0.35, -0.25, 1).normalize();

    const shared = {
        uSunDir: { value: DEFAULT_SUN.clone() },
        uSunColor: { value: new THREE.Color(0.52, 0.5, 0.47) },
        uAmbient: { value: new THREE.Color(0.6, 0.61, 0.63) },
        uFogColor: { value: new THREE.Color(0.86, 0.89, 0.93) },
        uFogNear: { value: 1e9 },
        uFogFar: { value: 2e9 },
        uShadowMap: { value: null },
        uShadowOn: { value: 0 },
        uShadowTexel: { value: 1 / 4096 }
    };

    const settings = {
        sun: true,
        date: new Date().toISOString().slice(0, 10),
        hour: 15,
        shadows: true,
        fog: false,
        fogDistance: 1500,
        sky: true,
        vignette: false,
        dof: false,
        dofFocus: 0.6,          // sharp band position, 0 = top, 1 = bottom of the image
        dofStrength: 0.5        // 0..1
    };

    let sunInfo = null;     // { azimuth, elevation } in degrees

    /* ============================================================
       Shader pieces
       ============================================================ */

    const vertexDecl = `
        uniform mat4 uShadowMatrix;
        uniform mat4 uSectionMatrix;
        varying vec3 vSection;
        varying vec3 vAtmoNormal;
        varying float vAtmoDist;
        varying vec4 vAtmoShadow;
    `;

    // needs: position, normal
    const vertexMain = `
        vAtmoNormal = normal;
        vAtmoDist = length((modelViewMatrix * vec4(position, 1.0)).xyz);
        vAtmoShadow = uShadowMatrix * vec4(position, 1.0);
        vSection = (uSectionMatrix * vec4(position, 1.0)).xyz;
    `;

    const fragmentDecl = `
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform vec3 uAmbient;
        uniform vec3 uFogColor;
        uniform float uFogNear;
        uniform float uFogFar;
        uniform sampler2D uShadowMap;
        uniform float uShadowOn;
        uniform float uShadowTexel;
        uniform float uSectionOn;
        varying vec3 vSection;
        varying vec3 vAtmoNormal;
        varying float vAtmoDist;
        varying vec4 vAtmoShadow;

        // three.js RGBA depth packing
        float atmoUnpack(vec4 v) {
            return dot(v, vec4(255.0 / 256.0) / vec4(256.0 * 256.0 * 256.0, 256.0 * 256.0, 256.0, 1.0));
        }

        float atmoShadow() {
            if (uShadowOn < 0.5) return 1.0;
            vec3 c = vAtmoShadow.xyz / vAtmoShadow.w * 0.5 + 0.5;
            if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
            float lit = 0.0;
            for (int i = -1; i <= 1; i++) {
                for (int j = -1; j <= 1; j++) {
                    float d = atmoUnpack(texture2D(uShadowMap, c.xy + vec2(float(i), float(j)) * uShadowTexel));
                    lit += (c.z - 0.0006 > d) ? 0.0 : 1.0;
                }
            }
            return lit / 9.0;
        }

        // albedo -> lit, shadowed, hazy colour
        vec3 atmoShade(vec3 albedo) {
            // outside the section box: cut away
            if (uSectionOn > 0.5 && (abs(vSection.x) > 0.5 || abs(vSection.y) > 0.5 || abs(vSection.z) > 0.5)) discard;
            vec3 n = normalize(vAtmoNormal);
            if (!gl_FrontFacing) n = -n;
            float diffuse = max(dot(n, uSunDir), 0.0);
            vec3 colour = albedo * (uAmbient + uSunColor * diffuse * atmoShadow());
            float f = clamp((vAtmoDist - uFogNear) / max(1.0, uFogFar - uFogNear), 0.0, 1.0);
            return mix(colour, uFogColor, f * f * (3.0 - 2.0 * f));
        }
    `;

    /* Uniforms for a new material: shared ones + its own shadow matrix. */
    function uniforms() {
        return {
            ...shared,
            uShadowMatrix: { value: new THREE.Matrix4() },
            uSectionMatrix: { value: new THREE.Matrix4() },
            uSectionOn: { value: 0 }
        };
    }

    /* ============================================================
       Sun position
       ============================================================ */

    /* Azimuth (from north, clockwise) and elevation in degrees. */
    function sunPosition(date, latDeg, lonDeg) {
        const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
        const L = (280.460 + 0.9856474 * n) % 360;
        const g = ((357.528 + 0.9856003 * n) % 360) * rad;
        const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
        const eps = (23.439 - 0.0000004 * n) * rad;

        const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
        const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
        const gmst = (280.46061837 + 360.98564736629 * n) % 360;
        const ha = ((gmst + lonDeg) * rad) - ra;
        const lat = latDeg * rad;

        const elevation = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha));
        const azimuth = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(ha));

        return { azimuth: ((azimuth / rad) + 360) % 360, elevation: elevation / rad };
    }

    const mix3 = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
    const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

    /* Colours for a sun elevation (degrees). */
    function palette(elevation) {
        const day = smooth(3, 25, elevation);         // 0 = sunset light, 1 = full day
        const up = smooth(-4, 4, elevation);          // sun above the horizon at all

        return {
            zenith: mix3([0.24, 0.30, 0.48], [0.25, 0.47, 0.77], day),
            horizon: mix3([0.96, 0.76, 0.56], [0.82, 0.88, 0.94], day),
            sun: mix3([1.0, 0.68, 0.42], [1.0, 0.97, 0.91], day).map(v => v * 0.62 * up),
            ambient: mix3([0.42, 0.42, 0.50], [0.48, 0.52, 0.58], day).map(v => v * (0.55 + 0.45 * up))
        };
    }

    function tileLatLon() {
        try {
            const b = currentTile?.bbox;
            if (Array.isArray(b)) return [(b[1] + b[3]) / 2, (b[0] + b[2]) / 2];
        } catch (error) { /* default */ }
        return [46.8, 8.2];
    }

    /* ============================================================
       Apply settings
       ============================================================ */

    function update() {
        let p;

        if (settings.sun) {
            const [lat, lon] = tileLatLon();
            const hh = Math.floor(settings.hour), mm = Math.round((settings.hour - hh) * 60);
            const date = new Date(`${settings.date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`);
            sunInfo = sunPosition(isNaN(date) ? new Date() : date, lat, lon);

            const az = sunInfo.azimuth * rad, el = Math.max(sunInfo.elevation, 2) * rad;
            shared.uSunDir.value.set(Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)).normalize();

            p = palette(sunInfo.elevation);
            shared.uSunColor.value.setRGB(...p.sun);
            shared.uAmbient.value.setRGB(...p.ambient);
        } else {
            sunInfo = null;
            shared.uSunDir.value.copy(DEFAULT_SUN);
            shared.uSunColor.value.setRGB(0.52, 0.5, 0.47);
            shared.uAmbient.value.setRGB(0.6, 0.61, 0.63);
            p = palette(40);
        }

        shared.uFogColor.value.setRGB(...p.horizon);
        shared.uFogNear.value = settings.fog ? settings.fogDistance * 0.25 : 1e9;
        shared.uFogFar.value = settings.fog ? settings.fogDistance : 2e9;

        if (el("atmo-sun-info")) {
            el("atmo-sun-info").textContent = sunInfo
                ? `Sun: ${Math.round(sunInfo.azimuth)}° azimuth, ${sunInfo.elevation.toFixed(1)}° elevation` +
                  (sunInfo.elevation < 0 ? " (below the horizon)" : "")
                : "Fixed soft light (sun off).";
        }

        invalidate();
    }

    /* ============================================================
       Shadow map
       ============================================================ */

    let shadowTarget = null, depthMaterial = null, shadowCamera = null, pending = false;
    const shadowViewProj = new THREE.Matrix4();

    function shadowCasters() {
        const scene = viewer?.scene?.scene;
        const groups = ["swiss-surfaces", "swiss-trees", "swiss-figures"].map(n => scene?.getObjectByName(n)).filter(g => g && g.visible);
        return { scene, groups };
    }

    /* Every mesh sets its own shadow matrix right before it is drawn. */
    const sectionInverse = new THREE.Matrix4();

    function attach(mesh) {
        mesh.onBeforeRender = function (renderer, scene, camera, geometry, material) {
            const u = material?.uniforms;
            if (!u?.uShadowMatrix) return;
            u.uShadowMatrix.value.multiplyMatrices(shadowViewProj, this.matrixWorld);

            // section box of app.js: world -> unit box (-0.5 .. 0.5)
            const volume = typeof currentSection !== "undefined" ? currentSection?.volume : null;
            if (volume && u.uSectionMatrix) {
                volume.updateMatrixWorld(true);
                if (typeof sectionInverse.invert === "function") sectionInverse.copy(volume.matrixWorld).invert();
                else sectionInverse.getInverse(volume.matrixWorld);
                u.uSectionMatrix.value.multiplyMatrices(sectionInverse, this.matrixWorld);
                u.uSectionOn.value = 1;
            } else if (u.uSectionOn) {
                u.uSectionOn.value = 0;
            }
        };
    }

    function renderShadows() {
        pending = false;

        const { scene, groups } = shadowCasters();
        const renderer = viewer?.renderer;

        if (!settings.shadows || !renderer || !scene || !groups.length) {
            shared.uShadowOn.value = 0;
            return;
        }

        try {
            const size = Math.min(4096, renderer.capabilities?.maxTextureSize || 4096);

            if (!shadowTarget || shadowTarget.width !== size) {
                shadowTarget?.dispose();
                shadowTarget = new THREE.WebGLRenderTarget(size, size, {
                    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, format: THREE.RGBAFormat
                });
                depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
            }

            // fit an orthographic "sun camera" around everything that casts shadows
            const box = new THREE.Box3();
            for (const g of groups) { g.updateMatrixWorld(true); box.expandByObject(g); }
            if (box.isEmpty()) { shared.uShadowOn.value = 0; return; }

            const centre = box.getCenter(new THREE.Vector3());
            const radius = box.getSize(new THREE.Vector3()).length() / 2;
            const sun = shared.uSunDir.value;

            shadowCamera = shadowCamera || new THREE.OrthographicCamera();
            Object.assign(shadowCamera, { left: -radius, right: radius, top: radius, bottom: -radius, near: 1, far: radius * 4 });
            shadowCamera.up.set(0, 0, 1);
            if (Math.abs(sun.z) > 0.99) shadowCamera.up.set(0, 1, 0);
            shadowCamera.position.copy(centre).addScaledVector(sun, radius * 2);
            shadowCamera.lookAt(centre);
            shadowCamera.updateMatrixWorld(true);
            shadowCamera.updateProjectionMatrix();
            shadowViewProj.multiplyMatrices(shadowCamera.projectionMatrix, shadowCamera.matrixWorldInverse);

            // draw depth from the sun
            let clear;
            try { clear = renderer.getClearColor(new THREE.Color()).clone(); } catch (error) { clear = renderer.getClearColor().clone(); }
            const alpha = renderer.getClearAlpha();
            const previous = renderer.getRenderTarget ? renderer.getRenderTarget() : null;

            renderer.setClearColor(0xffffff, 1);
            scene.overrideMaterial = depthMaterial;

            if (renderer.setRenderTarget) {
                renderer.setRenderTarget(shadowTarget);
                renderer.clear();
                renderer.render(scene, shadowCamera);
                renderer.setRenderTarget(previous);
            } else {
                renderer.render(scene, shadowCamera, shadowTarget, true);
            }

            scene.overrideMaterial = null;
            renderer.setClearColor(clear, alpha);

            shared.uShadowMap.value = shadowTarget.texture;
            shared.uShadowTexel.value = 1 / size;
            shared.uShadowOn.value = 1;
        } catch (error) {
            console.warn("[atmosphere] shadows disabled:", error);
            if (scene) scene.overrideMaterial = null;
            shared.uShadowOn.value = 0;
        }
    }

    /* Something changed (sun, meshes): redraw the shadow map soon. */
    function invalidate() {
        if (pending) return;
        pending = true;
        requestAnimationFrame(renderShadows);
    }

    /* ============================================================
       Sky for rendered images
       ============================================================ */

    const css = c => `rgb(${c.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255)).join(",")})`;

    /*
     * Draw the image onto a sky (and add a vignette): image must have a
     * transparent background. camera is used to place the sun glow.
     */
    function compose(image, camera) {
        const out = document.createElement("canvas");
        out.width = image.width;
        out.height = image.height;
        const ctx = out.getContext("2d");
        const W = out.width, H = out.height;
        const p = palette(sunInfo ? sunInfo.elevation : 40);

        if (settings.sky) {
            const g = ctx.createLinearGradient(0, 0, 0, H);
            g.addColorStop(0, css(p.zenith));
            g.addColorStop(0.62, css(p.horizon));
            g.addColorStop(1, css(p.horizon.map(v => v * 0.93)));
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, W, H);

            // sun glow where the sun is in view
            if (sunInfo && sunInfo.elevation > -2 && camera) {
                try {
                    const target = camera.position.clone().addScaledVector(shared.uSunDir.value, 1e5).project(camera);
                    if (target.z < 1) {
                        const x = (target.x * 0.5 + 0.5) * W, y = (0.5 - target.y * 0.5) * H;
                        const r = Math.max(W, H) * 0.35;
                        const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
                        glow.addColorStop(0, "rgba(255,248,225,0.85)");
                        glow.addColorStop(0.08, "rgba(255,236,200,0.45)");
                        glow.addColorStop(1, "rgba(255,230,200,0)");
                        ctx.fillStyle = glow;
                        ctx.fillRect(0, 0, W, H);
                    }
                } catch (error) { /* no glow */ }
            }
        }

        ctx.drawImage(image, 0, 0);

        if (settings.dof) tiltShift(out);

        if (settings.vignette) {
            const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.55);
            v.addColorStop(0, "rgba(0,0,0,0)");
            v.addColorStop(1, "rgba(0,0,0,0.35)");
            ctx.fillStyle = v;
            ctx.fillRect(0, 0, W, H);
        }

        return out;
    }

    /*
     * Tilt-shift: a horizontal sharp band around dofFocus, blur growing
     * above and below (three blur levels, blended with soft masks).
     */
    function tiltShift(canvas) {
        const W = canvas.width, H = canvas.height;
        const ctx = canvas.getContext("2d");
        if (!("filter" in ctx)) { console.warn("[atmosphere] canvas blur not supported - no depth of field"); return; }

        const source = document.createElement("canvas");
        source.width = W; source.height = H;
        source.getContext("2d").drawImage(canvas, 0, 0);

        const maxBlur = Math.max(2, W * 0.006 * (0.4 + 1.6 * settings.dofStrength));
        const focus = settings.dofFocus, band = 0.12;

        for (const level of [0.33, 0.66, 1]) {
            const layer = document.createElement("canvas");
            layer.width = W; layer.height = H;
            const lctx = layer.getContext("2d");
            lctx.filter = `blur(${(maxBlur * level).toFixed(1)}px)`;
            lctx.drawImage(source, 0, 0);
            lctx.filter = "none";

            // keep this blur level only where it belongs (further from the band = stronger)
            const inner = band + (level - 0.33) * 0.55, outer = inner + 0.2;
            const stop = v => Math.min(1, Math.max(0, v));
            const g = lctx.createLinearGradient(0, 0, 0, H);
            g.addColorStop(0, "rgba(0,0,0,1)");
            g.addColorStop(stop(focus - outer), "rgba(0,0,0,1)");
            g.addColorStop(stop(focus - inner), "rgba(0,0,0,0)");
            g.addColorStop(stop(focus + inner), "rgba(0,0,0,0)");
            g.addColorStop(stop(focus + outer), "rgba(0,0,0,1)");
            g.addColorStop(1, "rgba(0,0,0,1)");
            lctx.globalCompositeOperation = "destination-in";
            lctx.fillStyle = g;
            lctx.fillRect(0, 0, W, H);

            ctx.drawImage(layer, 0, 0);
        }
    }

    /* ============================================================
       UI
       ============================================================ */

    function hourText(h) {
        const hh = Math.floor(h), mm = Math.round((h - hh) * 60);
        return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
    }

    document.addEventListener("DOMContentLoaded", () => {
        const bindCheck = (id, key) => el(id)?.addEventListener("change", e => { settings[key] = e.target.checked; update(); });

        if (el("atmo-date")) el("atmo-date").value = settings.date;
        if (el("atmo-time")) el("atmo-time").value = settings.hour;
        if (el("atmo-time-out")) el("atmo-time-out").textContent = hourText(settings.hour);
        if (el("atmo-fogdist-out")) el("atmo-fogdist-out").textContent = `${settings.fogDistance} m`;

        bindCheck("atmo-sun", "sun");
        bindCheck("atmo-shadows", "shadows");
        bindCheck("atmo-fog", "fog");
        bindCheck("atmo-sky", "sky");
        bindCheck("atmo-vignette", "vignette");
        bindCheck("atmo-dof", "dof");
        el("atmo-dof-focus")?.addEventListener("input", e => { settings.dofFocus = Number(e.target.value); });
        el("atmo-dof-strength")?.addEventListener("input", e => { settings.dofStrength = Number(e.target.value); });

        el("atmo-date")?.addEventListener("change", e => { settings.date = e.target.value; update(); });
        el("atmo-time")?.addEventListener("input", e => {
            settings.hour = Number(e.target.value);
            if (el("atmo-time-out")) el("atmo-time-out").textContent = hourText(settings.hour);
            update();
        });
        el("atmo-fogdist")?.addEventListener("input", e => {
            settings.fogDistance = Number(e.target.value);
            if (el("atmo-fogdist-out")) el("atmo-fogdist-out").textContent = `${settings.fogDistance} m`;
            update();
        });

        for (const [id, key] of [["atmo-sun", "sun"], ["atmo-shadows", "shadows"], ["atmo-fog", "fog"], ["atmo-sky", "sky"], ["atmo-vignette", "vignette"], ["atmo-dof", "dof"]]) {
            if (el(id)) el(id).checked = settings[key];
        }

        update();
    });

    window.swissAtmosphere = {
        vertexDecl, vertexMain, fragmentDecl, uniforms, attach, invalidate, compose, settings,
        sunPosition, palette,
        update
    };
})();
