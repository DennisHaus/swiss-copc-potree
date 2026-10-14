/*
 * Swiss LiDAR Viewer - render the current view as a high-resolution image
 *
 * The point cloud is drawn at the target resolution (e.g. 4000 or 8000 px
 * wide) from the current camera, including tree crowns, and saved as PNG.
 *
 * How: the render area is temporarily enlarged to the target size (shown
 * scaled down on screen as a preview), so Potree itself picks the level of
 * detail and point sizes for that resolution. Once loading has settled, one
 * finished frame is copied, then everything is restored.
 *
 * Styles (any combination, rendered one after the other from the same view):
 *   as shown         exactly the current appearance
 *   points           larger points that close the gaps
 *   points white     the same on a white background
 *   white model      surfaces (surfaces.js) as white massing model, white background
 *   textured model   surfaces with the raster texture
 *
 * Loaded after ui.js and trees.js.
 */

(function () {
    "use strict";

    const el = id => document.getElementById(id);
    const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

    let busy = false;
    let cancelled = false;

    function nodesLoading() {
        return window.Potree && typeof Potree.numNodesLoading === "number" ? Potree.numNodesLoading : 0;
    }

    /* Largest drawing buffer this graphics card allows. */
    function maxSide() {
        try {
            const gl = viewer.renderer.getContext();
            const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
            return Math.min(
                gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
                gl.getParameter(gl.MAX_TEXTURE_SIZE),
                dims ? Math.min(dims[0], dims[1]) : Infinity,
                8192
            );
        } catch (error) {
            return 4096;
        }
    }

    /* Copy the next finished frame (right after Potree has drawn it). */
    function captureNextFrame() {
        return new Promise((resolve, reject) => {
            const original = viewer.render;
            let done = false;

            const finish = (fn, value) => {
                if (done) return;
                done = true;
                viewer.render = original;
                fn(value);
            };

            viewer.render = function (...args) {
                const result = original.apply(this, args);

                try {
                    const source = viewer.renderer.domElement;
                    const copy = document.createElement("canvas");
                    copy.width = source.width;
                    copy.height = source.height;
                    copy.getContext("2d").drawImage(source, 0, 0);
                    finish(resolve, copy);
                } catch (error) {
                    finish(reject, error);
                }

                return result;
            };

            setTimeout(() => finish(reject, new Error("the viewer did not draw a frame")), 8000);
        });
    }

    function overlay(text) {
        let box = el("render-overlay");

        if (!box) {
            box = document.createElement("div");
            box.id = "render-overlay";
            box.style.cssText =
                "position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,0.75);" +
                "color:#fff;font:14px sans-serif;display:flex;align-items:flex-end;" +
                "justify-content:center;padding:16px;pointer-events:none";
            document.body.appendChild(box);
        }

        box.textContent = text;
        return box;
    }

    /* ------------------------------------------------------------
       Styles
       ------------------------------------------------------------ */

    const STYLES = {
        "shown":       { label: "as-shown" },
        "points":      { label: "points", points: true, dense: true },
        "points-white":{ label: "points-white", points: true, dense: true, background: "white" },
        "model-white": { label: "white-model", model: "white", background: "white" },
        "model-tex":   { label: "textured-model", model: "ortho" }
    };

    function selectedStyles() {
        return Object.keys(STYLES).filter(key => el(`render-st-${key}`)?.checked);
    }

    /* Apply one style; returns a function that undoes it. */
    function applyStyle(key) {
        const style = STYLES[key];
        const surfaces = window.swissSurfaces?.view;
        const undo = [];

        if (style.model) {
            if (!surfaces?.has()) return null;          // no surfaces built: skip this style

            const look = surfaces.look(), visible = surfaces.visible(), hidden = surfaces.pointsHidden();
            surfaces.setLook(style.model);
            surfaces.setVisible(true);
            surfaces.setPointsHidden(true);
            undo.push(() => { surfaces.setLook(look); surfaces.setVisible(visible); surfaces.setPointsHidden(hidden); });
        }

        if (style.points && surfaces?.has()) {
            const visible = surfaces.visible(), hidden = surfaces.pointsHidden();
            surfaces.setVisible(false);
            surfaces.setPointsHidden(false);
            undo.push(() => { surfaces.setVisible(visible); surfaces.setPointsHidden(hidden); });
        }

        if (style.dense) {
            for (const pc of viewer.scene.pointclouds || []) {
                if (pc.material) pc.material.size *= 1.8;
            }
            if (currentPointCloud?.isLaz) currentPointCloud.material.uniforms.uSize.value *= 1.8;
            undo.push(() => window.applyAppearance?.());
        }

        if (style.background) {
            try { viewer.setBackground(style.background); } catch (error) { /* keep */ }
            undo.push(() => window.reapplyViewerSettings?.());
        }

        return () => { for (const fn of undo.reverse()) fn(); };
    }

    function saveCanvas(image, styleLabel) {
        return new Promise((resolve, reject) => {
            image.toBlob(blob => {
                if (!blob) { reject(new Error("the image could not be encoded")); return; }

                const tile = (typeof swissKmTileId === "function" && swissKmTileId(currentTile)) || "view";
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `render_${tile}_${styleLabel}_${image.width}x${image.height}.png`;
                document.body.appendChild(a);
                a.click();
                setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
                resolve();
            }, "image/png");
        });
    }

    async function waitForDetail(width, height, label) {
        const t0 = performance.now();
        let idle = 0;

        while (performance.now() - t0 < 90000) {
            if (cancelled) throw new Error("cancelled");
            await frame();

            const loading = nodesLoading();
            idle = loading === 0 ? idle + 1 : 0;
            if (idle >= 30) return;

            overlay(
                `${label}: ${width} × ${height} px – loading detail` +
                (loading ? ` (${loading} parts)` : "") +
                `… ${Math.round((performance.now() - t0) / 1000)} s (Esc cancels)`
            );
        }
    }

    /* ------------------------------------------------------------
       Render the series
       ------------------------------------------------------------ */

    async function renderImage() {
        if (busy || typeof viewer === "undefined" || !viewer) return;

        const area = viewer.renderArea || el("potree_render_area");
        const canvas = viewer.renderer?.domElement;

        if (!area || !canvas) {
            setStatus("Render area not found.");
            return;
        }

        const styles = selectedStyles();
        if (!styles.length) {
            setStatus("Choose at least one style to render.");
            return;
        }

        busy = true;
        cancelled = false;
        if (el("render-button")) el("render-button").disabled = true;

        const withTrees = el("render-trees")?.checked !== false;
        const wanted = Number(el("render-width")?.value || 4000);

        const savedCss = area.style.cssText;
        const savedBudget = typeof viewer.getPointBudget === "function" ? viewer.getPointBudget() : null;
        const trees = viewer.scene.scene.getObjectByName("swiss-trees");
        const savedTreesVisible = trees ? trees.visible : null;

        const onKey = event => { if (event.key === "Escape") cancelled = true; };
        window.addEventListener("keydown", onKey);

        const saved = [], skipped = [];

        try {
            const aspect = area.clientWidth / Math.max(1, area.clientHeight);
            const limit = maxSide();
            let width = Math.min(wanted, limit);
            let height = Math.round(width / aspect);
            if (height > limit) { height = limit; width = Math.round(height * aspect); }

            if (savedBudget !== null) viewer.setPointBudget(Math.max(savedBudget, 25_000_000));
            if (currentPointCloud?.isLaz) {
                currentPointCloud.geometry.setDrawRange(0, currentPointCloud.userData.data.count);
            }
            if (trees) trees.visible = withTrees;

            // enlarge the drawing, keep it on screen as a scaled preview
            const ratio = canvas.width / Math.max(1, area.clientWidth);
            const applySize = (w, h) => {
                const cssW = w / ratio, cssH = h / ratio;
                const scale = Math.min(window.innerWidth / cssW, window.innerHeight / cssH) * 0.9;
                area.style.cssText = savedCss +
                    `;position:fixed;left:${(window.innerWidth - cssW * scale) / 2}px;top:${(window.innerHeight - cssH * scale) / 2}px;` +
                    `width:${cssW}px;height:${cssH}px;transform:scale(${scale});transform-origin:0 0;z-index:9999;`;
            };

            overlay(`Rendering ${width} × ${height} px… (Esc cancels)`);
            applySize(width, height);
            for (let i = 0; i < 4; i++) await frame();

            if (canvas.width && Math.abs(canvas.width - width) > 2) {
                const k = width / canvas.width;
                applySize(width * k, height * k);
                for (let i = 0; i < 4; i++) await frame();
            }

            for (let s = 0; s < styles.length; s++) {
                const key = styles[s];
                const label = `${s + 1}/${styles.length} ${STYLES[key].label}`;
                const undo = applyStyle(key);

                if (!undo) { skipped.push(STYLES[key].label); continue; }

                try {
                    await waitForDetail(width, height, label);
                    overlay(`${label}: saving…`);
                    const image = await captureNextFrame();
                    await saveCanvas(image, STYLES[key].label);
                    saved.push(`${STYLES[key].label} (${image.width} × ${image.height})`);
                } finally {
                    undo();
                    for (let i = 0; i < 2; i++) await frame();
                }
            }

            window.usageCounter?.hit("downloads");
            setStatus(
                (saved.length ? `Saved: ${saved.join(", ")}.` : "Nothing saved.") +
                (skipped.length ? ` Skipped (build surfaces first): ${skipped.join(", ")}.` : "") +
                (width < wanted ? ` Graphics card limit: ${limit} px.` : "")
            );
        } catch (error) {
            setStatus(error.message === "cancelled"
                ? `Rendering cancelled${saved.length ? ` after ${saved.length} image(s)` : ""}.`
                : `Rendering failed: ${error.message}`);
            if (error.message !== "cancelled") console.error("[render]", error);
        } finally {
            area.style.cssText = savedCss;
            if (savedBudget !== null) viewer.setPointBudget(savedBudget);
            if (trees && savedTreesVisible !== null) trees.visible = savedTreesVisible;

            window.applyAppearance?.();
            window.reapplyViewerSettings?.();

            el("render-overlay")?.remove();
            window.removeEventListener("keydown", onKey);
            if (el("render-button")) el("render-button").disabled = false;
            busy = false;
        }
    }

    document.addEventListener("DOMContentLoaded", () => {
        el("render-button")?.addEventListener("click", renderImage);
    });

    window.swissRender = { renderImage };
})();
