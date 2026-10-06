/*
 * Swiss LiDAR Viewer - anonymous usage counters
 *
 * Counts, across all visitors:
 *   visits     page opened (once per browser session)
 *   downloads  full-resolution exports and original-file downloads
 *   sections   sections created
 *
 * The numbers are shown in the About dialog. They are stored by the free
 * Abacus counting service (https://abacus.jasoncameron.dev: no account, CORS
 * and SSL). Nothing about the visitor is sent by this app; the service sees the
 * request like any web server (IP address, browser).
 *
 * Optional settings in config.js:
 *
 *   CONFIG.COUNTER = {
 *       enabled: true,                       // false switches counting off
 *       namespace: "my-unique-name",         // default: derived from the page URL
 *       base: "https://abacus.jasoncameron.dev",
 *       countLocal: false                    // true also counts localhost / file://
 *   };
 *
 * Other scripts call  window.usageCounter?.hit("downloads")  etc.
 */

(function () {
    "use strict";

    const config = (window.CONFIG && window.CONFIG.COUNTER) || {};

    const BASE = String(config.base || "https://abacus.jasoncameron.dev").replace(/\/+$/, "");
    const KEYS = ["visits", "downloads", "sections"];
    const SESSION_FLAG = "swiss-lidar-viewer.visit-counted";

    const clean = text =>
        String(text || "")
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, "-")
            .replace(/^-+|-+$/g, "");

    // e.g. "dennishaus.github.io-swiss-lidar-viewer"
    const namespace =
        clean(config.namespace) ||
        clean(`${location.hostname}${location.pathname.replace(/[^/]*$/, "")}`) ||
        "swiss-lidar-viewer";

    const isLocal =
        location.protocol === "file:" ||
        ["localhost", "127.0.0.1", "[::1]", ""].includes(location.hostname);

    const enabled = config.enabled !== false;
    const countHere = enabled && (!isLocal || config.countLocal === true);

    const values = {};

    /* ------------------------------------------------------------
       Service calls
       ------------------------------------------------------------ */

    async function request(action, key) {
        const url =
            `${BASE}/${action}/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`;

        const response = await fetch(url, { cache: "no-store" });

        // a counter that was never hit does not exist yet
        if (response.status === 404 && action === "get") {
            return 0;
        }

        if (!response.ok) {
            throw new Error(`counter ${action} failed (${response.status})`);
        }

        const data = await response.json();
        const value = Number(data.value);

        if (!Number.isFinite(value)) {
            throw new Error("counter returned no number");
        }

        return value;
    }

    /* ------------------------------------------------------------
       Display (About dialog)
       ------------------------------------------------------------ */

    function render() {
        for (const key of KEYS) {
            const element = document.getElementById(`stat-${key}`);

            if (!element) {
                continue;
            }

            element.textContent =
                key in values ? values[key].toLocaleString() : "–";
        }
    }

    /* ------------------------------------------------------------
       Public API
       ------------------------------------------------------------ */

    /* Count one event. Never throws and never blocks the app. */
    function hit(key) {
        if (!countHere || !KEYS.includes(key)) {
            return Promise.resolve(null);
        }

        return request("hit", key)
            .then(value => {
                values[key] = value;
                render();
                return value;
            })
            .catch(error => {
                console.warn("[counter]", error.message);
                return null;
            });
    }

    /* Read the current totals (without counting anything). */
    function refresh(keys = KEYS) {
        if (!enabled) {
            render();
            return Promise.resolve(values);
        }

        return Promise.all(
            keys.map(key =>
                request("get", key)
                    .then(value => { values[key] = value; })
                    .catch(error => console.warn("[counter]", error.message))
            )
        ).then(() => {
            render();
            return values;
        });
    }

    window.usageCounter = { hit, refresh, namespace, values };

    /* ------------------------------------------------------------
       Start: count the visit once per session, show the totals
       ------------------------------------------------------------ */

    document.addEventListener("DOMContentLoaded", () => {
        render();

        let alreadyCounted = false;

        try {
            alreadyCounted = sessionStorage.getItem(SESSION_FLAG) === "1";
            sessionStorage.setItem(SESSION_FLAG, "1");
        } catch (error) {
            /* storage blocked: every page load counts */
        }

        if (!alreadyCounted && countHere) {
            hit("visits");
            refresh(["downloads", "sections"]);
        } else {
            refresh();
        }

        // fresh numbers whenever the About dialog is opened
        document.getElementById("readme-button")?.addEventListener("click", () => refresh());
    });
})();
