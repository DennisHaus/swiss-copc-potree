/*
 * Swiss LiDAR Viewer - interface layer
 *
 * - collapsible docks and folds
 * - appearance controls (point budget, size, shape, background, ...)
 * - About / impressum dialog
 *
 * Loaded after app.js. Uses its globals: viewer, map, Potree, CONFIG.
 */

(function () {
    "use strict";

    const STORAGE_KEY = "swiss-lidar-viewer.appearance.v1";

    /* ------------------------------------------------------------
       Appearance settings
       ------------------------------------------------------------ */

    const DEFAULTS = {
        budget: Math.min(
            50,
            Math.max(0.5, (CONFIG.POINT_BUDGET || 20000000) / 1e6)
        ),
        minNodeSize: 30,
        size: 1.5,
        sizeType: "ADAPTIVE",
        shape: "CIRCLE",
        opacity: 1,
        fov: 60,
        edl: true,
        edlStrength: 1,
        bg: "#000000",
        bgCustom: "#101418",
        swissZoom: 19
    };

    let settings = loadSettings();

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
        } catch (error) {
            return { ...DEFAULTS };
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch (error) {
            /* private mode etc. - settings just won't persist */
        }
    }

    const el = id => document.getElementById(id);

    /* ------------------------------------------------------------
       Apply settings to Potree
       ------------------------------------------------------------ */

    function allPointClouds() {
        return viewer?.scene?.pointclouds || [];
    }

    function applyToPointCloud(pointcloud) {
        // plain LAZ clouds are drawn by laz.js
        if (pointcloud?.isLaz) {
            pointcloud.lazApplyAppearance(settings);
            return;
        }

        const material = pointcloud?.material;

        if (!material) {
            return;
        }

        material.size = settings.size;
        material.opacity = settings.opacity;

        // only touch the shader when size mode or shape really change
        let shaderChanged = false;

        const sizeType = Potree.PointSizeType?.[settings.sizeType];

        if (sizeType !== undefined && material.pointSizeType !== sizeType) {
            material.pointSizeType = sizeType;
            shaderChanged = true;
        }

        const shape = Potree.PointShape?.[settings.shape];

        if (shape !== undefined && material.shape !== shape) {
            material.shape = shape;
            shaderChanged = true;
        }

        if (shaderChanged) {
            try {
                material.updateShaderSource?.();
            } catch (error) {
                console.warn("Could not refresh Potree shader:", error);
            }

            material.needsUpdate = true;
        }
    }

    // Called by app.js whenever a point cloud is configured.
    window.applyAppearance = function (pointcloud) {
        if (pointcloud) {
            applyToPointCloud(pointcloud);
        } else {
            allPointClouds().forEach(applyToPointCloud);

            if (currentPointCloud?.isLaz) {
                applyToPointCloud(currentPointCloud);
            }
        }
    };

    function applyBackground() {
        const area = el("potree_render_area");
        const container = el("potree-container");

        let colour = settings.bg === "custom" ? settings.bgCustom : settings.bg;
        let mode = "none";

        if (settings.bg === "gradient") {
            mode = "gradient";
            colour = "#000000";
        } else if (colour.toLowerCase() === "#000000") {
            mode = "black";
        } else if (colour.toLowerCase() === "#ffffff") {
            mode = "white";
        }

        // "none" makes Potree clear transparently, so the page colour shows through.
        if (area) area.style.background = colour;
        if (container) container.style.background = colour;

        try {
            viewer.setBackground(mode);
        } catch (error) {
            console.warn("Could not set Potree background:", error);
        }
    }

    function applyViewerSettings() {
        if (!viewer) {
            return;
        }

        viewer.setPointBudget(Math.round(settings.budget * 1e6));
        viewer.setFOV(settings.fov);

        if (typeof viewer.setMinNodeSize === "function") {
            viewer.setMinNodeSize(settings.minNodeSize);
        }
        viewer.setEDLEnabled(settings.edl);

        if (typeof viewer.setEDLStrength === "function") {
            viewer.setEDLStrength(settings.edlStrength);
        }

        applyBackground();
        window.applyAppearance();
    }

    /* ------------------------------------------------------------
       SWISSIMAGE resolution
       ------------------------------------------------------------ */

    // Ground size of one WMTS pixel (Web Mercator) at a latitude.
    function groundResolution(zoom, latitude) {
        return (156543.03392804097 / Math.pow(2, zoom)) *
            Math.cos((latitude * Math.PI) / 180);
    }

    function swissInfoText(zoom) {
        const bbox = currentTile?.bbox;
        const latitude = Array.isArray(bbox) ? (bbox[1] + bbox[3]) / 2 : 46.8;
        const res = groundResolution(zoom, latitude);

        const pixelsPerSide = 1000 / res;
        const tilesPerSide = Math.ceil(pixelsPerSide / 256) + 1;
        const side = tilesPerSide * 256;
        const megabytes = (side * side * 3) / 1e6;

        const cm = res * 100;
        const resText = cm >= 100 ? `${(cm / 100).toFixed(1)} m` : `${Math.round(cm)} cm`;

        return {
            label: `${resText}/px${zoom >= 20 ? " (native)" : ""}`,
            info:
                `About ${(side / 1000).toFixed(1)}k × ${(side / 1000).toFixed(1)} px, ` +
                `${(tilesPerSide * tilesPerSide).toLocaleString()} map tiles to download, ` +
                `${megabytes >= 1000 ? (megabytes / 1000).toFixed(1) + " GB" : Math.round(megabytes) + " MB"} memory. ` +
                `Also used for the export.`
        };
    }

    window.updateSwissInfo = function () {
        const slider = el("swiss-zoom");
        if (!slider) return;

        const text = swissInfoText(Number(slider.value));
        el("swiss-zoom-out").textContent = text.label;
        el("swiss-zoom-info").textContent = text.info;
    };

    // Switch the raster and recolour the point cloud.
    function applySwissZoom() {
        SWISSIMAGE_RGB.zoom = settings.swissZoom;

        const raster = SWISSIMAGE_RGB.raster;

        if (raster && raster.requestedZoom !== settings.swissZoom) {
            SWISSIMAGE_RGB.raster = null;
            SWISSIMAGE_RGB.cache.clear();
        }

        if (currentPointCloud && el("color-mode")?.value === "swissimage") {
            if (currentPointCloud.isLaz) {
                // re-bake the whole tile once with the new raster
                void currentPointCloud.lazSetColorMode("swissimage");
            } else {
                // no-op if already running; the running loop rebuilds the raster
                startSwissImageProcessing();
            }
        }
    }

    /* ------------------------------------------------------------
       Bind controls
       ------------------------------------------------------------ */

    const fmt = {
        minNodeSize: v => `${v} px`,
        budget: v => `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 })} M`,
        size: v => Number(v).toFixed(1),
        opacity: v => `${Math.round(v * 100)} %`,
        fov: v => `${v}°`,
        edlStrength: v => Number(v).toFixed(1)
    };

    const outputIds = {
        minNodeSize: "ap-lod-out",
        budget: "ap-budget-out",
        size: "ap-size-out",
        opacity: "ap-opacity-out",
        fov: "ap-fov-out",
        edlStrength: "ap-edl-strength-out"
    };

    const rangeIds = {
        minNodeSize: "ap-lod",
        budget: "ap-budget",
        size: "ap-size",
        opacity: "ap-opacity",
        fov: "ap-fov",
        edlStrength: "ap-edl-strength"
    };

    function syncControls() {
        for (const [key, id] of Object.entries(rangeIds)) {
            const input = el(id);
            const out = el(outputIds[key]);

            if (input) input.value = settings[key];
            if (out) out.textContent = fmt[key](settings[key]);
        }

        el("ap-sizetype").value = settings.sizeType;
        el("ap-shape").value = settings.shape;
        el("ap-edl").checked = settings.edl;
        el("ap-bg").value = settings.bg;
        el("ap-bg-color").value = settings.bgCustom;

        el("ap-edl-strength").disabled = !settings.edl;

        el("swiss-zoom").value = settings.swissZoom;
        window.updateSwissInfo();
    }

    function bindAppearance() {
        el("swiss-zoom")?.addEventListener("input", event => {
            settings.swissZoom = Number(event.target.value);
            window.updateSwissInfo();
        });

        // Rebuilding the raster is heavy, so only apply when the slider is released.
        el("swiss-zoom")?.addEventListener("change", event => {
            settings.swissZoom = Number(event.target.value);
            saveSettings();
            applySwissZoom();
        });

        for (const [key, id] of Object.entries(rangeIds)) {
            el(id)?.addEventListener("input", event => {
                settings[key] = Number(event.target.value);
                el(outputIds[key]).textContent = fmt[key](settings[key]);
                saveSettings();
                applyViewerSettings();
            });
        }

        el("ap-sizetype")?.addEventListener("change", event => {
            settings.sizeType = event.target.value;
            saveSettings();
            applyViewerSettings();
        });

        el("ap-shape")?.addEventListener("change", event => {
            settings.shape = event.target.value;
            saveSettings();
            applyViewerSettings();
        });

        el("ap-edl")?.addEventListener("change", event => {
            settings.edl = event.target.checked;
            el("ap-edl-strength").disabled = !settings.edl;
            saveSettings();
            applyViewerSettings();
        });

        el("ap-bg")?.addEventListener("change", event => {
            settings.bg = event.target.value;
            saveSettings();
            applyViewerSettings();
        });

        el("ap-bg-color")?.addEventListener("input", event => {
            settings.bgCustom = event.target.value;
            settings.bg = "custom";
            el("ap-bg").value = "custom";
            saveSettings();
            applyViewerSettings();
        });

        el("ap-reset")?.addEventListener("click", () => {
            settings = { ...DEFAULTS };
            saveSettings();
            syncControls();
            applyViewerSettings();
            applySwissZoom();
            setStatus("Appearance reset.");
        });
    }

    /* ------------------------------------------------------------
       Layout: docks, folds, map size
       ------------------------------------------------------------ */

    function refreshMapSize() {
        if (!map) return;
        // wait for the layout change, then let Leaflet re-measure
        setTimeout(() => map.invalidateSize(), 60);
    }

    function bindLayout() {
        const app = el("app");

        const toggle = (button, className) => {
            button?.addEventListener("click", () => {
                const open = app.classList.toggle(className);
                button.setAttribute("aria-pressed", String(open));
                refreshMapSize();
            });
        };

        toggle(el("toggle-left"), "left-open");
        toggle(el("toggle-right"), "right-open");

        el("map-expand")?.addEventListener("click", event => {
            const wide = el("dock-left").classList.toggle("wide");
            event.currentTarget.textContent = wide ? "Narrow" : "Wide";
            refreshMapSize();
        });

        el("fold-map")?.addEventListener("toggle", refreshMapSize);

        // Dragging the map's resize handle changes its size.
        const wrap = el("map-wrap");

        if (wrap && "ResizeObserver" in window) {
            new ResizeObserver(() => map && map.invalidateSize()).observe(wrap);
        }

        // Small screens: start with only the left dock open.
        if (window.innerWidth <= 700) {
            app.classList.remove("right-open");
            el("toggle-right")?.setAttribute("aria-pressed", "false");
        }
    }

    function bindReadme() {
        const dialog = el("readme");

        el("readme-button")?.addEventListener("click", () => {
            if (typeof dialog.showModal === "function") {
                dialog.showModal();
            } else {
                dialog.setAttribute("open", "");
            }
        });

        el("readme-close")?.addEventListener("click", () => dialog.close());

        // click on the backdrop closes the dialog
        dialog?.addEventListener("click", event => {
            if (event.target === dialog) dialog.close();
        });
    }

    /* ------------------------------------------------------------
       Init (app.js has already created viewer and map)
       ------------------------------------------------------------ */

    document.addEventListener("DOMContentLoaded", () => {
        SWISSIMAGE_RGB.zoom = settings.swissZoom;
        syncControls();
        bindAppearance();
        bindLayout();
        bindReadme();
        applyViewerSettings();
        refreshMapSize();
    });
})();
