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
        swissZoom: 19,
        // raster colouring (colorsource.js)
        colorSource: "swissimage",
        colorTimes: {},          // chosen year per map source
        groundOnly: false,       // filter: ground / water points only
        occlusion: false,        // off: every point takes the pixel under it (like FME)
        leanAuto: false,         // off: no building-lean correction (like FME)
        settingsVersion: 2,
        leanX: 0,                // metres of shift per 10 m of height
        leanY: 0,
        layerId: "",             // geo.admin.ch layer (natural hazards, ...)
        layerLabel: "",
        wmsUrl: "",
        wmsLayer: ""
    };

    let settings = loadSettings();

    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            const stored = raw ? JSON.parse(raw) : {};

            // version 2: plain orthophoto colours by default (no lean correction,
            // no neutral walls) - also for settings saved by earlier versions
            if ((stored.settingsVersion || 1) < 2) {
                stored.leanAuto = false;
                stored.occlusion = false;
                stored.leanX = 0;
                stored.leanY = 0;
                stored.settingsVersion = 2;
            }

            return { ...DEFAULTS, ...stored };
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
        window.swissColor?.groundOnlyChanged();

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

    /*
     * The slider keeps its zoom scale: 20 = 10 cm (native GeoTIFF),
     * 19 = 20 cm, 18 = 40 cm ... For tiles without a GeoTIFF the WMTS
     * map tiles are used at the same zoom (about the same resolution).
     */
    function swissInfoText(zoom) {
        const res = 0.1 * Math.pow(2, 20 - zoom);
        const side = Math.round(1000 / res);
        const megabytes = (side * side * 3) / 1e6;

        const cm = res * 100;
        const resText = cm >= 100 ? `${(cm / 100).toFixed(1)} m` : `${Math.round(cm)} cm`;

        return {
            label: `${resText}/px${zoom >= 20 ? " (native)" : ""}`,
            info:
                `SWISSIMAGE: about ` +
                `${(side / 1000).toFixed(1)}k × ${(side / 1000).toFixed(1)} px, ` +
                `${megabytes >= 1000 ? (megabytes / 1000).toFixed(1) + " GB" : Math.round(megabytes) + " MB"} memory. ` +
                `Maps are read at their finest level up to this resolution. Also used for the export.`
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
       Raster colour source, ground-only, walls, tower lean
       ------------------------------------------------------------ */

    const leanText = v => {
        const value = Number(v);
        return value === 0 ? "off" : `${value > 0 ? "+" : ""}${value.toFixed(2)} m / 10 m`;
    };

    const timeText = t => (/^\d{8}$/.test(t) ? t.slice(0, 4) : t);

    function pushColorSettings() {
        const c = window.swissColor?.settings;
        if (!c) return;

        // sources that are not ready yet (no file / layer chosen) stay on SWISSIMAGE
        const notReady =
            (settings.colorSource === "local" && !window.swissColor.local.tif) ||
            (settings.colorSource === "geoadmin" && !settings.layerId) ||
            (settings.colorSource === "wms" && !(settings.wmsUrl && settings.wmsLayer));

        const source = notReady ? "swissimage" : settings.colorSource;

        c.source = source;
        c.time = settings.colorTimes?.[source] || "";
        c.groundOnly = settings.groundOnly;
        c.occlusion = settings.occlusion;
        c.leanAuto = settings.leanAuto;
        c.leanX = 0;    // manual lean removed: correction is either automatic or off
        c.leanY = 0;
        c.layerId = settings.layerId;
        c.layerLabel = settings.layerLabel;
        c.wmsUrl = settings.wmsUrl;
        c.wmsLayer = settings.wmsLayer;
    }

    async function refreshTimeOptions() {
        const row = el("color-time-row");
        const select = el("color-time");
        if (!row || !select) return;

        const source = window.swissColor.settings.source;
        row.hidden = true;

        try {
            const info = await window.swissColor.times(source);

            if (!info || info.times.length < 2) return;

            select.innerHTML = "";

            for (const t of info.times) {
                const option = document.createElement("option");
                option.value = t;
                option.textContent = timeText(t);
                select.appendChild(option);
            }

            select.value = window.swissColor.settings.time || info.defaultTime || info.times[0];
            row.hidden = false;
        } catch (error) {
            console.warn("[colour] could not read the map years:", error);
        }
    }

    function fillBandSelects(info) {
        const box = el("color-bands");
        if (!box) return;

        box.hidden = !info;
        if (!info) return;

        const local = window.swissColor.local;

        ["band-r", "band-g", "band-b"].forEach((id, k) => {
            const select = el(id);
            select.innerHTML = "";

            for (let b = 0; b < info.bands; b++) {
                const option = document.createElement("option");
                option.value = b;
                option.textContent = `Band ${b + 1}`;
                select.appendChild(option);
            }

            select.value = local.bands[k];
        });

        el("band-stretch").checked = local.stretch;
    }

    function syncColorControls() {
        const c = window.swissColor?.settings;
        if (!c) return;

        // the select shows the choice even before a file is picked
        if (el("color-source")) el("color-source").value = settings.colorSource;
        if (el("ground-only")) el("ground-only").checked = settings.groundOnly;
        if (el("color-occlusion")) el("color-occlusion").checked = settings.occlusion;
        if (el("lean-auto")) el("lean-auto").checked = settings.leanAuto;
        if (el("lean-estimate")) el("lean-estimate").hidden = !settings.leanAuto;
        if (el("color-local-row")) el("color-local-row").hidden = settings.colorSource !== "local";
        if (el("color-geoadmin-row")) el("color-geoadmin-row").hidden = settings.colorSource !== "geoadmin";
        if (el("color-wms-row")) el("color-wms-row").hidden = settings.colorSource !== "wms";
        if (el("wms-url") && !el("wms-url").value) el("wms-url").value = settings.wmsUrl || "";
        if (el("wms-layer") && !el("wms-layer").value) el("wms-layer").value = settings.wmsLayer || "";

        if (settings.layerId && el("layer-info") && settings.colorSource === "geoadmin") {
            el("layer-info").textContent = `Shown: ${settings.layerLabel || settings.layerId} (${settings.layerId})`;
        }

        for (const [key, id] of [["leanX", "swiss-lean-x"], ["leanY", "swiss-lean-y"]]) {
            if (el(id)) el(id).value = settings[key];
            if (el(`${id}-out`)) el(`${id}-out`).textContent = leanText(settings[key]);
        }

        void refreshTimeOptions();
    }

    function bindColorSource() {
        if (!window.swissColor) return;

        el("color-source")?.addEventListener("change", event => {
            const source = event.target.value;

            settings.colorSource = source;

            // geology belongs on the terrain only
            if (window.swissColor.sources[source]?.groundOnly && !settings.groundOnly) {
                settings.groundOnly = true;
                window.swissColor.settings.groundOnly = true;
                window.swissColor.groundOnlyChanged();
                setStatus("Geology: only ground points are shown (untick 'Show ground points only' to see all).");
            }

            saveSettings();
            pushColorSettings();   // "local" only becomes active once a file is picked
            syncColorControls();

            if (source === "local" && !window.swissColor.local.tif) {
                el("color-file")?.click();
                return;
            }

            // wait until a layer / WMS has been chosen
            if (window.swissColor.settings.source !== source) {
                if (source === "geoadmin") el("layer-search")?.focus();
                return;
            }

            window.swissColor.sourceChanged();
        });

        /* geo.admin.ch layer search */
        let searchToken = 0;

        async function runLayerSearch(text) {
            const select = el("layer-results");
            const info = el("layer-info");
            if (!select || !text.trim()) return;

            const token = ++searchToken;
            if (info) info.textContent = "Searching…";

            try {
                const results = await window.swissColor.searchLayers(text.trim());
                if (token !== searchToken) return;

                select.innerHTML = "";

                for (const r of results) {
                    const option = document.createElement("option");
                    option.value = r.id;
                    option.textContent = r.label || r.id;
                    option.title = r.id;
                    select.appendChild(option);
                }

                if (info) {
                    info.textContent = results.length
                        ? `${results.length} layer(s) - pick one to colour the ground points.`
                        : "No layers found.";
                }
            } catch (error) {
                if (info) info.textContent = error.message;
            }
        }

        document.querySelectorAll("[data-layer-search]").forEach(button => {
            button.addEventListener("click", () => {
                const text = button.dataset.layerSearch;
                if (el("layer-search")) el("layer-search").value = text;
                void runLayerSearch(text);
            });
        });

        let searchTimer = null;

        el("layer-search")?.addEventListener("input", event => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => runLayerSearch(event.target.value), 350);
        });

        el("layer-results")?.addEventListener("change", event => {
            const option = event.target.selectedOptions[0];
            if (!option) return;

            settings.colorSource = "geoadmin";
            settings.layerId = option.value;
            settings.layerLabel = option.textContent;
            saveSettings();
            pushColorSettings();
            syncColorControls();
            window.swissColor.sourceChanged();
        });

        el("wms-apply")?.addEventListener("click", () => {
            settings.colorSource = "wms";
            settings.wmsUrl = el("wms-url")?.value.trim() || "";
            settings.wmsLayer = el("wms-layer")?.value.trim() || "";

            if (!settings.wmsUrl || !settings.wmsLayer) {
                setStatus("Please enter the WMS URL and the layer name.");
                return;
            }

            saveSettings();
            pushColorSettings();
            syncColorControls();
            window.swissColor.sourceChanged();
        });

        el("color-time")?.addEventListener("change", event => {
            const source = window.swissColor.settings.source;

            settings.colorTimes = { ...(settings.colorTimes || {}), [source]: event.target.value };
            window.swissColor.settings.time = event.target.value;
            saveSettings();
            window.swissColor.sourceChanged();
        });

        el("color-file")?.addEventListener("change", async event => {
            const info = el("color-file-info");

            try {
                const meta = await window.swissColor.setLocalFiles(event.target.files);

                if (info) {
                    info.textContent =
                        `${meta.name}: ${meta.width.toLocaleString()} × ${meta.height.toLocaleString()} px, ` +
                        `${meta.bands} band(s), ${meta.bitsPerSample[0] || meta.bitsPerSample} bit.` +
                        (meta.bands >= 4 ? " For colour-infrared choose NIR → red, red → green, green → blue." : "");
                }

                fillBandSelects(meta);
                settings.colorSource = "local";
                window.swissColor.settings.source = "local";
                saveSettings();
                syncColorControls();
                window.swissColor.sourceChanged();
            } catch (error) {
                if (info) info.textContent = error.message;
                setStatus(error.message);
            }
        });

        for (const [k, id] of [[0, "band-r"], [1, "band-g"], [2, "band-b"]]) {
            el(id)?.addEventListener("change", event => {
                const local = window.swissColor.local;
                local.bands[k] = Number(event.target.value);
                local.version++;
                window.swissColor.sourceChanged();
            });
        }

        el("band-stretch")?.addEventListener("change", event => {
            const local = window.swissColor.local;
            local.stretch = event.target.checked;
            local.version++;
            window.swissColor.sourceChanged();
        });

        el("ground-only")?.addEventListener("change", event => {
            settings.groundOnly = event.target.checked;
            saveSettings();
            pushColorSettings();
            window.swissColor.groundOnlyChanged();
        });

        el("lean-auto")?.addEventListener("change", event => {
            settings.leanAuto = event.target.checked;
            saveSettings();
            pushColorSettings();
            syncColorControls();
            window.swissColor.rulesChanged();
        });

        el("lean-estimate")?.addEventListener("click", () => {
            if (el("lean-info")) el("lean-info").textContent = "Estimating…";
            window.swissColor.estimateLean();
        });

        window.addEventListener("swiss-lean-estimate", event => {
            if (el("lean-info")) el("lean-info").textContent = event.detail.text;
            setStatus(event.detail.text);
        });

        el("color-occlusion")?.addEventListener("change", event => {
            settings.occlusion = event.target.checked;
            saveSettings();
            pushColorSettings();
            window.swissColor.rulesChanged();
        });

        for (const [key, id] of [["leanX", "swiss-lean-x"], ["leanY", "swiss-lean-y"]]) {
            const input = el(id);
            const out = el(`${id}-out`);
            if (!input) continue;

            input.addEventListener("input", () => {
                settings[key] = Number(input.value);
                if (out) out.textContent = leanText(settings[key]);
            });

            // recolouring is heavy: only when the slider is released
            input.addEventListener("change", () => {
                settings[key] = Number(input.value);
                saveSettings();
                pushColorSettings();
                window.swissColor.rulesChanged();
            });

            input.addEventListener("dblclick", () => {
                input.value = 0;
                input.dispatchEvent(new Event("input"));
                input.dispatchEvent(new Event("change"));
            });
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
            pushColorSettings();
            syncColorControls();
            window.swissColor?.groundOnlyChanged();
            window.swissColor?.sourceChanged();
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
        pushColorSettings();
        syncControls();
        syncColorControls();
        bindAppearance();
        bindColorSource();
        bindLayout();
        bindReadme();
        applyViewerSettings();
        refreshMapSize();
    });
})();
