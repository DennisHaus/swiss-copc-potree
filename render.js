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
 * Styles:
 *   shown   exactly the current appearance
 *   dense   larger points that close the gaps -> continuous surfaces
 *   white   dense, on a white background (plans, collages)
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

    async function renderImage() {
        if (busy || !window.viewer) return;

        const area = viewer.renderArea || el("potree_render_area");
        const canvas = viewer.renderer?.domElement;

        if (!area || !canvas) {
            setStatus("Render area not found.");
            return;
        }

        busy = true;
        cancelled = false;
        if (el("render-button")) el("render-button").disabled = true;

        const style = el("render-style")?.value || "dense";
        const withTrees = el("render-trees")?.checked !== false;
        const wanted = Number(el("render-width")?.value || 4000);

        // remember everything that is changed
        const savedCss = area.style.cssText;
        const savedBudget = typeof viewer.getPointBudget === "function" ? viewer.getPointBudget() : null;
        const trees = viewer.scene.scene.getObjectByName("swiss-trees");
        const savedTreesVisible = trees ? trees.visible : null;

        const onKey = event => { if (event.key === "Escape") cancelled = true; };
        window.addEventListener("keydown", onKey);

        try {
            // target size, same proportions as the view
            const aspect = area.clientWidth / Math.max(1, area.clientHeight);
            const limit = maxSide();
            let width = Math.min(wanted, limit);
            let height = Math.round(width / aspect);

            if (height > limit) {
                height = limit;
                width = Math.round(height * aspect);
            }

            // more points for the larger image
            if (savedBudget !== null) viewer.setPointBudget(Math.max(savedBudget, 25_000_000));

            if (currentPointCloud?.isLaz) {
                const d = currentPointCloud.userData.data;
                currentPointCloud.geometry.setDrawRange(0, d.count);
            }

            if (style !== "shown") {
                for (const pc of viewer.scene.pointclouds || []) {
                    if (pc.material) pc.material.size *= 1.8;
                }
                if (currentPointCloud?.isLaz) currentPointCloud.material.uniforms.uSize.value *= 1.8;
            }

            if (style === "white") {
                try { viewer.setBackground("white"); } catch (error) { /* keep */ }
            }

            if (trees) trees.visible = withTrees;

            // enlarge the drawing, keep it on screen as a scaled preview
            const ratio = canvas.width / Math.max(1, area.clientWidth);   // device pixels per CSS px
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

            // correct once if the viewer applies its own pixel ratio
            if (canvas.width && Math.abs(canvas.width - width) > 2) {
                const k = width / canvas.width;
                applySize(width * k, height * k);
                for (let i = 0; i < 4; i++) await frame();
            }

            // wait until the detail for this resolution has loaded
            const t0 = performance.now();
            let idle = 0;

            while (performance.now() - t0 < 90000) {
                if (cancelled) throw new Error("cancelled");
                await frame();

                const loading = nodesLoading();
                idle = loading === 0 ? idle + 1 : 0;
                if (idle >= 30) break;

                overlay(
                    `Rendering ${width} × ${height} px – loading detail` +
                    (loading ? ` (${loading} parts)` : "") +
                    `… ${Math.round((performance.now() - t0) / 1000)} s (Esc cancels)`
                );
            }

            overlay("Saving image…");
            const image = await captureNextFrame();

            const blob = await new Promise(resolve => image.toBlob(resolve, "image/png"));
            if (!blob) throw new Error("the image could not be encoded");

            const name = `render_${(typeof swissKmTileId === "function" && swissKmTileId(currentTile)) || "view"}_` +
                `${image.width}x${image.height}.png`;
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = name;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);

            window.usageCounter?.hit("downloads");
            setStatus(
                `Image saved: ${image.width} × ${image.height} px` +
                (image.width < wanted ? ` (graphics card limit: ${limit} px)` : "") + "."
            );
        } catch (error) {
            setStatus(error.message === "cancelled" ? "Rendering cancelled." : `Rendering failed: ${error.message}`);
            if (error.message !== "cancelled") console.error("[render]", error);
        } finally {
            area.style.cssText = savedCss;
            if (savedBudget !== null) viewer.setPointBudget(savedBudget);
            if (trees && savedTreesVisible !== null) trees.visible = savedTreesVisible;

            window.applyAppearance?.();          // point sizes, LAZ draw range
            window.reapplyViewerSettings?.();    // background, EDL, budget

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
