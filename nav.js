/*
 * Swiss LiDAR Viewer - keyboard navigation and camera projection
 *
 *   W / S        forward / back (horizontal, along the view direction)
 *   A / D        left / right
 *   E / C        up / down
 *   arrow keys   turn left / right, tilt up / down
 *   Shift        three times faster
 *   O            orthographic <-> perspective
 *
 * Speed follows the distance to the point the camera looks at, so it feels
 * the same close to a facade and high above the tile. Keys are ignored
 * while typing in a field.
 */

(function () {
    "use strict";

    const el = id => document.getElementById(id);
    const MOVE = new Set(["w", "a", "s", "d", "e", "c", "arrowleft", "arrowright", "arrowup", "arrowdown"]);
    const keys = new Set();
    let shift = false, last = 0, running = false;

    const typing = target => {
        const tag = (target?.tagName || "").toLowerCase();
        return tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable;
    };

    function viewReady() {
        return typeof viewer !== "undefined" && viewer?.scene?.view;
    }

    /* ---------- projection ---------- */

    function isOrtho() {
        try { return viewer.scene.cameraMode === Potree.CameraMode.ORTHOGRAPHIC; } catch (error) { return false; }
    }

    function toggleProjection() {
        if (!viewReady() || !window.Potree?.CameraMode || typeof viewer.setCameraMode !== "function") {
            setStatus("This Potree version has no orthographic camera.");
            return;
        }
        viewer.setCameraMode(isOrtho() ? Potree.CameraMode.PERSPECTIVE : Potree.CameraMode.ORTHOGRAPHIC);
        updateButton();
        window.swissAtmosphere?.invalidate();
        setStatus(isOrtho() ? "Orthographic view (true to scale, no perspective)." : "Perspective view.");
    }

    function updateButton() {
        const b = el("nav-projection");
        if (b) b.textContent = isOrtho() ? "Orthographic ✓ (O)" : "Perspective ✓ (O)";
    }

    /* ---------- movement ---------- */

    function step(time) {
        if (!keys.size || !viewReady()) { running = false; return; }

        const dt = Math.min(0.1, last ? (time - last) / 1000 : 0.016);
        last = time;

        const view = viewer.scene.view;
        const distance = Math.max(2, Math.min(800, view.radius || 50));
        const speed = distance * 0.6 * (shift ? 3 : 1);

        // horizontal forward and right vectors
        const dir = view.direction.clone();
        dir.z = 0;
        if (dir.lengthSq() < 1e-6) dir.set(-Math.sin(view.yaw), Math.cos(view.yaw), 0);
        dir.normalize();
        const right = new THREE.Vector3(dir.y, -dir.x, 0);

        const k = key => keys.has(key) ? 1 : 0;
        const move = new THREE.Vector3()
            .addScaledVector(dir, k("w") - k("s"))
            .addScaledVector(right, k("d") - k("a"))
            .add(new THREE.Vector3(0, 0, k("e") - k("c")));

        if (move.lengthSq() > 0) view.position.addScaledVector(move.normalize(), speed * dt);

        const turn = (k("arrowright") - k("arrowleft")) * 1.2 * dt * (shift ? 2 : 1);
        const tilt = (k("arrowup") - k("arrowdown")) * 0.8 * dt * (shift ? 2 : 1);
        if (turn) view.yaw -= turn;
        if (tilt) view.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, view.pitch + tilt));

        requestAnimationFrame(step);
    }

    function start() {
        if (running) return;
        running = true;
        last = 0;
        requestAnimationFrame(step);
    }

    window.addEventListener("keydown", event => {
        if (typing(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
        shift = event.shiftKey;
        const key = event.key.toLowerCase();

        if (key === "o") { toggleProjection(); event.preventDefault(); return; }
        if (!MOVE.has(key)) return;

        keys.add(key);
        event.preventDefault();
        event.stopPropagation();          // keep Potree's own key handling out of it
        start();
    }, true);

    window.addEventListener("keyup", event => {
        shift = event.shiftKey;
        keys.delete(event.key.toLowerCase());
    }, true);

    window.addEventListener("blur", () => keys.clear());

    document.addEventListener("DOMContentLoaded", () => {
        el("nav-projection")?.addEventListener("click", toggleProjection);
        setTimeout(updateButton, 1500);
    });

    window.swissNav = { toggleProjection };
})();
