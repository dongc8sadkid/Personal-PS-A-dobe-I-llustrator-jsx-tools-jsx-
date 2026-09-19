#target illustrator

/*
 * Banner_Prep_v0_4.jsx
 * ------------------------------------------------------------
 * Trial banner prep script for Illustrator.
 *
 * v0.4 fixes:
 *   - Original selected AxB shape is converted to a finished-size reference line after a successful build:
 *     stroke = C0 M0 Y0 K35, no fill, dashed 0.5" / 0.5".
 *     It stays on its original layer.
 *
 * v0.3 fixes:
 *   - Production colors updated:
 *     Thru-cut stroke = C99 M0 Y0 K0.
 *     Kiss-cut / Windslit stroke = C0 M99 Y0 K0.
 *     Grommet fill = C89 M0 Y0 K0, no stroke.
 *
 * v0.2 fixes:
 *   - Kiss-cut layer name fixed: "Kiss-cut".
 *   - Generated Grommet / Kiss-cut / Thru-cut objects are created DIRECTLY on layers,
 *     not inside auto groups. This avoids the empty/unselectable __AUTO_BANNER_PREP__ group issue.
 *   - Old auto groups/items named with __AUTO_BANNER_PREP__ are cleaned before rebuild.
 *   - Non-rectangle offset no longer relies on Illustrator live Offset Path effect.
 *     For simple closed straight-line paths, it uses a scripted polygon miter offset.
 *     Curved/compound/multi-path irregular shapes stop with a clear alert instead of making
 *     a fake overlapping Thru-cut.
 *   - Large Canvas support tightened: all inch values use 72 / doc.scaleFactor;
 *     visual stroke width uses 1 / doc.scaleFactor.
 *
 * Workflow:
 *   1) Select ONE finished-size shape (AxB).
 *      - Axis-aligned rectangle = full auto mode.
 *      - Non-rectangle simple closed straight path = conservative irregular mode.
 *   2) Run script.
 *   3) Choose +s / +webbing / +heat hem / custom offset, pocket, grommet, windslit.
 *   4) Script builds output paths into:
 *      - Thru-cut
 *      - Grommet
 *      - Kiss-cut
 *
 * Design choices:
 *   - Rectangular banner: offset + pocket + grommet + windslit supported.
 *   - Non-rectangle: simple polygon offset supported. Pocket is NOT supported;
 *     if pocket is selected, script stops before making anything.
 *   - Non-rectangle grommet is conservative bbox mode in this trial version.
 *     It does NOT trace the true inward offset path.
 *   - No Register / Crease / PDF save here. Run your Add Dot script after this if needed.
 *   - Remembers previous dialog values for the current Illustrator session.
 *     Ctrl+Z will undo document changes, but app.__bannerPrep_lastSettings should remain
 *     until Illustrator is closed/restarted.
 * ------------------------------------------------------------
 */

(function () {

    // ===================== CONFIG =====================
    var CFG = {
        thruLayerName: "Thru-cut",
        grommetLayerName: "Grommet",
        kissLayerName: "Kiss-cut",

        autoNamePrefix: "__AUTO_BANNER_PREP__",

        defaultFinish: "s",          // s | webbing | heat | custom
        defaultCustomOffset_in: 0.75,

        seamOffset_in: 0.75,
        webbingOffset_in: 1.0,
        heatHemOffset_in: 1.5,

        grommetDiameter_in: 0.25,
        grommetInset_in: 0.5,
        grommetSpacing_in: 24,

        windslitSpacing_in: 27,
        windslitMargin_in: 12,
        windslitW_in: 6,
        windslitH_in: 3,

        strokeWidth_pt: 1,

        rectTol_in: 0.01,
        straightTol_in: 0.003,
        dedupeTol_in: 0.01,
        lineIntersectTol: 1e-9
    };

    if (app.documents.length === 0) {
        alert("Open a document first.");
        return;
    }

    var doc = app.activeDocument;

    // Large Canvas / Large Format detection.
    // In large-canvas docs the DOM uses a scaled unit (usually document.scaleFactor = 10).
    // 1 real inch = 72 / scaleFactor document units.
    var SCALE = 1;
    try { if (doc.scaleFactor) SCALE = doc.scaleFactor; } catch (eSF) {}
    var IN = 72 / SCALE; // document units per real inch
    var PT = 1 / SCALE;  // document units per visual point

    // ===================== Basic helpers =====================
    function cmyk(c, m, y, k) {
        var col = new CMYKColor();
        col.cyan = c;
        col.magenta = m;
        col.yellow = y;
        col.black = k;
        return col;
    }

    // Production colors / cutter-recognition colors.
    // Note: CMYKColor property order is C, M, Y, K even when shop notation is typed in a different order.
    function THRU_COLOR() { return cmyk(99, 0, 0, 0); }      // C99 M0 Y0 K0
    function KISS_COLOR() { return cmyk(0, 99, 0, 0); }      // C0 M99 Y0 K0
    function GROMMET_COLOR() { return cmyk(89, 0, 0, 0); }   // C89 M0 Y0 K0
    function AXB_REF_COLOR() { return cmyk(0, 0, 0, 35); }   // C0 M0 Y0 K35

    function bW(b) { return b[2] - b[0]; }
    function bH(b) { return b[1] - b[3]; }
    function toIn(v) { return v / IN; }
    function inch(v) { return v * IN; }

    function fmtIn(v) {
        return (Math.round(v * 1000) / 1000).toString();
    }

    function parseInchText(s, fallback, label) {
        if (s === undefined || s === null) return fallback;
        var raw = String(s).replace(/inches|inch|in|\"|”|“|'/ig, "").replace(/\s+/g, "");
        if (raw === "") return fallback;
        var n = parseFloat(raw);
        if (isNaN(n)) throw new Error(label + " is not a number: " + s);
        return n;
    }

    function selectionFirst() {
        if (!doc.selection || doc.selection.length !== 1) {
            alert("Please select exactly ONE finished-size shape (AxB), then run again.");
            return null;
        }
        return doc.selection[0];
    }

    function safeBounds(item) {
        try { return item.geometricBounds; }
        catch (e) { return null; }
    }

    // ===================== Layer helpers =====================
    function findLayer(doc_, name) {
        var hit = null;
        function walk(layers, low) {
            for (var i = 0; i < layers.length; i++) {
                var nm = low ? layers[i].name.toLowerCase() : layers[i].name;
                var key = low ? name.toLowerCase() : name;
                if (nm === key) { hit = layers[i]; return; }
                if (layers[i].layers && layers[i].layers.length) walk(layers[i].layers, low);
                if (hit) return;
            }
        }
        walk(doc_.layers, false);
        if (!hit) walk(doc_.layers, true);
        return hit;
    }

    function ensureLayer(doc_, name) {
        var L = findLayer(doc_, name);
        if (!L) { L = doc_.layers.add(); L.name = name; }
        L.locked = false;
        L.visible = true;
        return L;
    }

    function isAutoNamed(item) {
        try { return item.name && item.name.indexOf(CFG.autoNamePrefix) === 0; }
        catch (e) { return false; }
    }

    function cleanAutoItems(layer) {
        // Remove old direct auto pageItems and old v0.1 auto groups.
        var victims = [];
        for (var i = 0; i < layer.pageItems.length; i++) {
            try {
                if (isAutoNamed(layer.pageItems[i])) victims.push(layer.pageItems[i]);
            } catch (e) {}
        }
        for (var j = victims.length - 1; j >= 0; j--) {
            try { victims[j].remove(); } catch (e2) {}
        }
    }

    // ===================== Shape detection =====================
    function isStraightPathPoint(pp, tol) {
        var a = pp.anchor;
        var l = pp.leftDirection;
        var r = pp.rightDirection;
        return Math.abs(a[0] - l[0]) <= tol && Math.abs(a[1] - l[1]) <= tol &&
               Math.abs(a[0] - r[0]) <= tol && Math.abs(a[1] - r[1]) <= tol;
    }

    function pushUnique(arr, v, tol) {
        for (var i = 0; i < arr.length; i++) {
            if (Math.abs(arr[i] - v) <= tol) return;
        }
        arr.push(v);
    }

    function hasCorner(corners, x, y, tol) {
        for (var i = 0; i < corners.length; i++) {
            if (Math.abs(corners[i][0] - x) <= tol && Math.abs(corners[i][1] - y) <= tol) return true;
        }
        return false;
    }

    function isAxisAlignedRectangle(item) {
        if (!item || item.typename !== "PathItem") return false;
        try { if (!item.closed) return false; } catch (e0) { return false; }
        var pts;
        try { pts = item.pathPoints; } catch (e1) { return false; }
        if (pts.length !== 4) return false;

        var tol = CFG.rectTol_in * IN;
        var xs = [], ys = [], corners = [];
        for (var i = 0; i < pts.length; i++) {
            if (!isStraightPathPoint(pts[i], tol)) return false;
            var a = pts[i].anchor;
            pushUnique(xs, a[0], tol);
            pushUnique(ys, a[1], tol);
            corners.push([a[0], a[1]]);
        }
        if (xs.length !== 2 || ys.length !== 2) return false;
        var L = Math.min(xs[0], xs[1]);
        var R = Math.max(xs[0], xs[1]);
        var B = Math.min(ys[0], ys[1]);
        var T = Math.max(ys[0], ys[1]);
        return hasCorner(corners, L, T, tol) && hasCorner(corners, R, T, tol) &&
               hasCorner(corners, R, B, tol) && hasCorner(corners, L, B, tol);
    }

    function getSimplePathItem(item) {
        // v0.2 irregular polygon offset intentionally supports one simple PathItem only.
        // This avoids pretending a compound/multi-path/clipped shape was offset correctly.
        if (!item) return null;
        if (item.typename === "PathItem") return item;
        if (item.typename === "CompoundPathItem") {
            try {
                if (item.pathItems.length === 1) return item.pathItems[0];
            } catch (e) {}
            return null;
        }
        return null;
    }

    function pathToStraightClosedPoints(pi) {
        if (!pi || pi.typename !== "PathItem") return null;
        try { if (!pi.closed) return null; } catch (e0) { return null; }
        var pts;
        try { pts = pi.pathPoints; } catch (e1) { return null; }
        if (pts.length < 3) return null;

        var tol = CFG.straightTol_in * IN;
        var out = [];
        for (var i = 0; i < pts.length; i++) {
            if (!isStraightPathPoint(pts[i], tol)) return null;
            var a = pts[i].anchor;
            out.push([a[0], a[1]]);
        }
        // remove duplicate final point if somebody manually closed by repeating first anchor
        if (out.length > 3) {
            var f = out[0], l = out[out.length - 1];
            if (Math.abs(f[0] - l[0]) <= tol && Math.abs(f[1] - l[1]) <= tol) out.pop();
        }
        return out.length >= 3 ? out : null;
    }

    // ===================== Dialog memory =====================
    function defaultSettings() {
        return {
            finish: CFG.defaultFinish,
            customOffset_in: CFG.defaultCustomOffset_in,

            pocketTopOn: false,
            pocketTop_in: 0,
            pocketBottomOn: false,
            pocketBottom_in: 0,
            pocketLeftOn: false,
            pocketLeft_in: 0,
            pocketRightOn: false,
            pocketRight_in: 0,

            grommetOn: false,
            grommetDiameter_in: CFG.grommetDiameter_in,
            grommetInset_in: CFG.grommetInset_in,
            grommetSpacing_in: CFG.grommetSpacing_in,

            windslitOn: false,
            windslitSpacing_in: CFG.windslitSpacing_in,
            windslitMargin_in: CFG.windslitMargin_in,
            windslitW_in: CFG.windslitW_in,
            windslitH_in: CFG.windslitH_in
        };
    }

    function cloneSettings(s) {
        var d = defaultSettings();
        if (!s) return d;
        for (var k in d) {
            if (d.hasOwnProperty(k) && s[k] !== undefined) d[k] = s[k];
        }
        return d;
    }

    function loadLastSettings() {
        var s = null;
        try { s = app.__bannerPrep_lastSettings; } catch (e) {}
        return cloneSettings(s);
    }

    function saveLastSettings(s) {
        try { app.__bannerPrep_lastSettings = cloneSettings(s); } catch (e) {}
    }

    function finishOffset(settings) {
        if (settings.finish === "s") return CFG.seamOffset_in;
        if (settings.finish === "webbing") return CFG.webbingOffset_in;
        if (settings.finish === "heat") return CFG.heatHemOffset_in;
        return settings.customOffset_in;
    }

    function hasAnyPocket(settings) {
        return settings.pocketTopOn || settings.pocketBottomOn || settings.pocketLeftOn || settings.pocketRightOn;
    }

    function showDialog(settings, detectedMode, baseB) {
        var dlg = new Window("dialog", "Banner Prep v0.4");
        dlg.orientation = "column";
        dlg.alignChildren = "fill";
        dlg.margins = 16;
        dlg.spacing = 10;

        var baseInfo = dlg.add("statictext", undefined,
            "Selected AxB: " + fmtIn(toIn(bW(baseB))) + "\" x " + fmtIn(toIn(bH(baseB))) + "\"    Mode: " + detectedMode +
            (SCALE !== 1 ? "    Large Canvas scaleFactor: " + SCALE : ""),
            { multiline: true }
        );
        baseInfo.preferredSize.width = 520;

        var finishPanel = dlg.add("panel", undefined, "Finish / Main offset");
        finishPanel.orientation = "column";
        finishPanel.alignChildren = "left";
        finishPanel.margins = 12;
        finishPanel.spacing = 5;

        var rbS = finishPanel.add("radiobutton", undefined, "+s  seam / hem  = 0.75\"");
        var rbW = finishPanel.add("radiobutton", undefined, "+webbing  = 1\"");
        var rbH = finishPanel.add("radiobutton", undefined, "+heat hem  = 1.5\"");
        var customGrp = finishPanel.add("group");
        customGrp.orientation = "row";
        var rbC = customGrp.add("radiobutton", undefined, "custom offset");
        var customTxt = customGrp.add("edittext", undefined, String(settings.customOffset_in));
        customTxt.characters = 6;
        customGrp.add("statictext", undefined, "inch");

        rbS.value = settings.finish === "s";
        rbW.value = settings.finish === "webbing";
        rbH.value = settings.finish === "heat";
        rbC.value = settings.finish === "custom";
        if (!rbS.value && !rbW.value && !rbH.value && !rbC.value) rbS.value = true;

        var pocketPanel = dlg.add("panel", undefined, "Pocket / extra outward extension (rectangle only)");
        pocketPanel.orientation = "column";
        pocketPanel.alignChildren = "left";
        pocketPanel.margins = 12;
        pocketPanel.spacing = 5;

        function pocketRow(label, checked, val) {
            var g = pocketPanel.add("group");
            g.orientation = "row";
            var cb = g.add("checkbox", undefined, label);
            cb.value = checked;
            var txt = g.add("edittext", undefined, String(val));
            txt.characters = 6;
            g.add("statictext", undefined, "inch");
            return { cb: cb, txt: txt };
        }
        var pTop = pocketRow("Top", settings.pocketTopOn, settings.pocketTop_in);
        var pBot = pocketRow("Bottom", settings.pocketBottomOn, settings.pocketBottom_in);
        var pLeft = pocketRow("Left", settings.pocketLeftOn, settings.pocketLeft_in);
        var pRight = pocketRow("Right", settings.pocketRightOn, settings.pocketRight_in);

        var gromPanel = dlg.add("panel", undefined, "Grommet");
        gromPanel.orientation = "column";
        gromPanel.alignChildren = "left";
        gromPanel.margins = 12;
        gromPanel.spacing = 5;
        var gOn = gromPanel.add("checkbox", undefined, "Add grommet circles on Grommet layer");
        gOn.value = settings.grommetOn;
        var gLine = gromPanel.add("group");
        gLine.orientation = "row";
        gLine.add("statictext", undefined, "Dia");
        var gDiaTxt = gLine.add("edittext", undefined, String(settings.grommetDiameter_in));
        gDiaTxt.characters = 5;
        gLine.add("statictext", undefined, "Inset");
        var gInsetTxt = gLine.add("edittext", undefined, String(settings.grommetInset_in));
        gInsetTxt.characters = 5;
        gLine.add("statictext", undefined, "Max spacing");
        var gSpacingTxt = gLine.add("edittext", undefined, String(settings.grommetSpacing_in));
        gSpacingTxt.characters = 5;
        gLine.add("statictext", undefined, "inch");

        var windPanel = dlg.add("panel", undefined, "Windslit");
        windPanel.orientation = "column";
        windPanel.alignChildren = "left";
        windPanel.margins = 12;
        windPanel.spacing = 5;
        var wOn = windPanel.add("checkbox", undefined, "Add windslit lower half-circles on Kiss-cut layer");
        wOn.value = settings.windslitOn;
        var wLine = windPanel.add("group");
        wLine.orientation = "row";
        wLine.add("statictext", undefined, "Spacing");
        var wSpacingTxt = wLine.add("edittext", undefined, String(settings.windslitSpacing_in));
        wSpacingTxt.characters = 5;
        wLine.add("statictext", undefined, "Margin");
        var wMarginTxt = wLine.add("edittext", undefined, String(settings.windslitMargin_in));
        wMarginTxt.characters = 5;
        wLine.add("statictext", undefined, "Shape W/H");
        var wWTxt = wLine.add("edittext", undefined, String(settings.windslitW_in));
        wWTxt.characters = 4;
        var wHTxt = wLine.add("edittext", undefined, String(settings.windslitH_in));
        wHTxt.characters = 4;
        wLine.add("statictext", undefined, "inch");

        var note = dlg.add("statictext", undefined,
            "Non-rectangle: pocket will stop before making anything. Irregular offset supports simple closed straight-line paths only. Grommet is bbox-conservative in this trial.",
            { multiline: true }
        );
        note.preferredSize.width = 520;

        var btns = dlg.add("group");
        btns.alignment = "right";
        var cancelBtn = btns.add("button", undefined, "Cancel", { name: "cancel" });
        var okBtn = btns.add("button", undefined, "Build", { name: "ok" });
        dlg.defaultElement = okBtn;
        dlg.cancelElement = cancelBtn;

        var result = null;
        okBtn.onClick = function () {
            try {
                var out = cloneSettings(settings);
                out.finish = rbS.value ? "s" : (rbW.value ? "webbing" : (rbH.value ? "heat" : "custom"));
                out.customOffset_in = parseInchText(customTxt.text, CFG.defaultCustomOffset_in, "custom offset");

                out.pocketTopOn = pTop.cb.value;
                out.pocketTop_in = parseInchText(pTop.txt.text, 0, "top pocket");
                out.pocketBottomOn = pBot.cb.value;
                out.pocketBottom_in = parseInchText(pBot.txt.text, 0, "bottom pocket");
                out.pocketLeftOn = pLeft.cb.value;
                out.pocketLeft_in = parseInchText(pLeft.txt.text, 0, "left pocket");
                out.pocketRightOn = pRight.cb.value;
                out.pocketRight_in = parseInchText(pRight.txt.text, 0, "right pocket");

                out.grommetOn = gOn.value;
                out.grommetDiameter_in = parseInchText(gDiaTxt.text, CFG.grommetDiameter_in, "grommet diameter");
                out.grommetInset_in = parseInchText(gInsetTxt.text, CFG.grommetInset_in, "grommet inset");
                out.grommetSpacing_in = parseInchText(gSpacingTxt.text, CFG.grommetSpacing_in, "grommet spacing");

                out.windslitOn = wOn.value;
                out.windslitSpacing_in = parseInchText(wSpacingTxt.text, CFG.windslitSpacing_in, "windslit spacing");
                out.windslitMargin_in = parseInchText(wMarginTxt.text, CFG.windslitMargin_in, "windslit margin");
                out.windslitW_in = parseInchText(wWTxt.text, CFG.windslitW_in, "windslit width");
                out.windslitH_in = parseInchText(wHTxt.text, CFG.windslitH_in, "windslit height");

                if (out.customOffset_in < 0) throw new Error("custom offset cannot be negative.");
                if ((out.pocketTopOn && out.pocketTop_in <= 0) ||
                    (out.pocketBottomOn && out.pocketBottom_in <= 0) ||
                    (out.pocketLeftOn && out.pocketLeft_in <= 0) ||
                    (out.pocketRightOn && out.pocketRight_in <= 0)) {
                    throw new Error("Checked pocket sides must have a value greater than 0.");
                }
                if (out.grommetOn) {
                    if (out.grommetDiameter_in <= 0) throw new Error("grommet diameter must be greater than 0.");
                    if (out.grommetInset_in < 0) throw new Error("grommet inset cannot be negative.");
                    if (out.grommetSpacing_in <= 0) throw new Error("grommet spacing must be greater than 0.");
                }
                if (out.windslitOn) {
                    if (out.windslitSpacing_in <= 0) throw new Error("windslit spacing must be greater than 0.");
                    if (out.windslitMargin_in < 0) throw new Error("windslit margin cannot be negative.");
                    if (out.windslitW_in <= 0 || out.windslitH_in <= 0) throw new Error("windslit W/H must be greater than 0.");
                }

                result = out;
                dlg.close();
            } catch (err) {
                alert(err.message || err.toString());
            }
        };

        dlg.show();
        return result;
    }

    // ===================== Drawing helpers =====================
    function stylePathStrokeOnly(p, strokeColor) {
        try { p.filled = false; } catch (e0) {}
        try { p.stroked = true; } catch (e1) {}
        try { p.strokeWidth = CFG.strokeWidth_pt * PT; } catch (e2) {}
        try { p.strokeColor = strokeColor; } catch (e3) {}
    }

    function stylePathFillOnly(p, fillColor) {
        try { p.stroked = false; } catch (e0) {}
        try { p.filled = true; } catch (e1) {}
        try { p.fillColor = fillColor; } catch (e2) {}
    }

    function drawPath(layer, pts, closed, strokeColor, nameSuffix) {
        var p = layer.pathItems.add();
        p.setEntirePath(pts);
        p.closed = closed ? true : false;
        p.name = CFG.autoNamePrefix + " " + nameSuffix;
        stylePathStrokeOnly(p, strokeColor);
        return p;
    }

    function drawRectPath(layer, b, strokeColor) {
        return drawPath(layer, [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], true, strokeColor, "Thru-cut rectangle");
    }

    function drawCirclePath(layer, cx, cy, dia, fillColor, idx) {
        var p = layer.pathItems.ellipse(cy + dia / 2, cx - dia / 2, dia, dia);
        p.name = CFG.autoNamePrefix + " Grommet " + idx;
        stylePathFillOnly(p, fillColor);
        return p;
    }

    function styleAxBReference(item) {
        // Convert the originally selected finished-size shape into a grey dashed reference line.
        // Keep it on its original layer; do not move it into cutter-recognition layers.
        var dash = inch(0.5);
        var gap = inch(0.5);

        function styleOnePath(p) {
            try { p.filled = false; } catch (e0) {}
            try { p.stroked = true; } catch (e1) {}
            try { p.strokeWidth = CFG.strokeWidth_pt * PT; } catch (e2) {}
            try { p.strokeColor = AXB_REF_COLOR(); } catch (e3) {}
            try { p.strokeDashes = [dash, gap]; } catch (e4) {}
            try { p.strokeDashOffset = 0; } catch (e5) {}
            try { p.name = CFG.autoNamePrefix + " AxB reference"; } catch (e6) {}
        }

        try {
            if (!item) return false;
            if (item.typename === "PathItem") {
                styleOnePath(item);
                return true;
            }
            if (item.typename === "CompoundPathItem") {
                var changed = false;
                for (var i = 0; i < item.pathItems.length; i++) {
                    styleOnePath(item.pathItems[i]);
                    changed = true;
                }
                try { item.name = CFG.autoNamePrefix + " AxB reference"; } catch (eName) {}
                return changed;
            }
        } catch (eOuter) {}
        return false;
    }

    // ===================== Polygon offset helpers =====================
    function signedArea(pts) {
        var a = 0;
        for (var i = 0; i < pts.length; i++) {
            var p = pts[i], q = pts[(i + 1) % pts.length];
            a += p[0] * q[1] - q[0] * p[1];
        }
        return a / 2;
    }

    function lineIntersection(p1, p2, p3, p4) {
        var x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1];
        var x3 = p3[0], y3 = p3[1], x4 = p4[0], y4 = p4[1];
        var den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
        if (Math.abs(den) < CFG.lineIntersectTol) return null;
        var px = ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / den;
        var py = ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / den;
        return [px, py];
    }

    function offsetPolygonMiter(pts, dist) {
        var n = pts.length;
        if (n < 3) return null;
        var area = signedArea(pts);
        if (Math.abs(area) < 1e-6) return null;

        // In Illustrator's normal coordinate plane here, y is still numerical y-up in artboardRect/path coords.
        // CCW polygon interior is left side, so outward normal is right side: [dy, -dx].
        // CW polygon interior is right side, so outward normal is left side: [-dy, dx].
        var ccw = area > 0;
        var offLines = [];
        var normals = [];

        for (var i = 0; i < n; i++) {
            var a = pts[i];
            var b = pts[(i + 1) % n];
            var dx = b[0] - a[0];
            var dy = b[1] - a[1];
            var len = Math.sqrt(dx * dx + dy * dy);
            if (len < 1e-8) return null;
            var nx = ccw ? (dy / len) : (-dy / len);
            var ny = ccw ? (-dx / len) : (dx / len);
            normals.push([nx, ny]);
            offLines.push({
                a: [a[0] + nx * dist, a[1] + ny * dist],
                b: [b[0] + nx * dist, b[1] + ny * dist]
            });
        }

        var out = [];
        for (var v = 0; v < n; v++) {
            var prev = offLines[(v - 1 + n) % n];
            var curr = offLines[v];
            var ip = lineIntersection(prev.a, prev.b, curr.a, curr.b);
            if (!ip) {
                // Parallel fallback: push vertex by averaged adjacent normals.
                var n1 = normals[(v - 1 + n) % n];
                var n2 = normals[v];
                var ax = n1[0] + n2[0];
                var ay = n1[1] + n2[1];
                var al = Math.sqrt(ax * ax + ay * ay);
                if (al < 1e-8) { ax = n2[0]; ay = n2[1]; al = 1; }
                ip = [pts[v][0] + (ax / al) * dist, pts[v][1] + (ay / al) * dist];
            }
            out.push(ip);
        }
        return out;
    }

    // ===================== Grommet helpers =====================
    function genEdgeGrommetCenters(baseB, inset, maxGap) {
        var L = baseB[0] + inset;
        var R = baseB[2] - inset;
        var T = baseB[1] - inset;
        var B = baseB[3] + inset;
        var pts = [];

        function addLine(edge) {
            var minP, maxP, fixed, span, n, step, i, p;
            if (edge === "top" || edge === "bottom") {
                minP = L; maxP = R;
                fixed = (edge === "top") ? T : B;
            } else {
                minP = B; maxP = T;
                fixed = (edge === "left") ? L : R;
            }

            span = maxP - minP;
            if (span < 0) return;
            if (span === 0) {
                if (edge === "top" || edge === "bottom") pts.push({ x: minP, y: fixed, edge: edge });
                else pts.push({ x: fixed, y: minP, edge: edge });
                return;
            }
            n = Math.max(1, Math.ceil(span / maxGap));
            step = span / n;
            for (i = 0; i <= n; i++) {
                p = minP + i * step;
                if (edge === "top" || edge === "bottom") pts.push({ x: p, y: fixed, edge: edge });
                else pts.push({ x: fixed, y: p, edge: edge });
            }
        }

        addLine("top"); addLine("bottom"); addLine("left"); addLine("right");
        return dedupePoints(pts, CFG.dedupeTol_in * IN);
    }

    function dedupePoints(pts, tol) {
        var out = [];
        for (var i = 0; i < pts.length; i++) {
            var keep = true;
            for (var j = 0; j < out.length; j++) {
                var dx = pts[i].x - out[j].x;
                var dy = pts[i].y - out[j].y;
                if (Math.sqrt(dx * dx + dy * dy) <= tol) { keep = false; break; }
            }
            if (keep) out.push(pts[i]);
        }
        return out;
    }

    function buildGrommets(layer, baseB, settings, fillColor) {
        var dia = inch(settings.grommetDiameter_in);
        var inset = inch(settings.grommetInset_in);
        var maxGap = inch(settings.grommetSpacing_in);
        var pts = genEdgeGrommetCenters(baseB, inset, maxGap);
        for (var i = 0; i < pts.length; i++) drawCirclePath(layer, pts[i].x, pts[i].y, dia, fillColor, i + 1);
        return pts.length;
    }

    // ===================== Windslit helpers =====================
    function axisPositions(cMin, cMax, step) {
        var span = cMax - cMin;
        var n = Math.floor(span / step) + 1;
        if (n < 1) n = 1;
        var used = (n - 1) * step;
        var start = cMin + (span - used) / 2;
        var arr = [];
        for (var k = 0; k < n; k++) arr.push(start + k * step);
        return arr;
    }

    function drawLowerSemicircle(layer, cx, cy, r, strokeColor, idx) {
        var KAPPA = 0.5522847498;
        var yFlat = cy + r / 2;
        var kr = KAPPA * r;

        var Ax = cx - r, Ay = yFlat;
        var Bx = cx,     By = yFlat - r;
        var Cx = cx + r, Cy = yFlat;

        var p = layer.pathItems.add();
        p.setEntirePath([[Ax, Ay], [Bx, By], [Cx, Cy]]);
        p.closed = false;
        p.name = CFG.autoNamePrefix + " Windslit " + idx;

        var pp = p.pathPoints;
        pp[0].anchor = [Ax, Ay];
        pp[0].leftDirection = [Ax, Ay];
        pp[0].rightDirection = [Ax, Ay - kr];

        pp[1].anchor = [Bx, By];
        pp[1].leftDirection = [Bx - kr, By];
        pp[1].rightDirection = [Bx + kr, By];

        pp[2].anchor = [Cx, Cy];
        pp[2].leftDirection = [Cx, Cy - kr];
        pp[2].rightDirection = [Cx, Cy];

        stylePathStrokeOnly(p, strokeColor);
        return p;
    }

    function buildWindslits(layer, baseB, settings, strokeColor) {
        var spacing = inch(settings.windslitSpacing_in);
        var margin = inch(settings.windslitMargin_in);
        var shapeW = inch(settings.windslitW_in);
        var shapeH = inch(settings.windslitH_in);
        var radius = shapeW / 2;
        var halfW = shapeW / 2;
        var halfH = shapeH / 2;

        var L = baseB[0], T = baseB[1], R = baseB[2], B = baseB[3];
        var cMinX = L + margin + halfW;
        var cMaxX = R - margin - halfW;
        var cMinY = B + margin + halfH;
        var cMaxY = T - margin - halfH;

        if (cMaxX < cMinX || cMaxY < cMinY) return 0;

        var xs = axisPositions(cMinX, cMaxX, spacing);
        var ys = axisPositions(cMinY, cMaxY, spacing);
        var count = 0;
        for (var xi = 0; xi < xs.length; xi++) {
            for (var yi = 0; yi < ys.length; yi++) {
                count++;
                drawLowerSemicircle(layer, xs[xi], ys[yi], radius, strokeColor, count);
            }
        }
        return count;
    }

    // ===================== Main =====================
    var src = selectionFirst();
    if (!src) return;
    var baseB = safeBounds(src);
    if (!baseB) {
        alert("Could not read geometric bounds from the selected object.");
        return;
    }

    var rectMode = isAxisAlignedRectangle(src);
    var simplePi = getSimplePathItem(src);
    var straightPts = simplePi ? pathToStraightClosedPoints(simplePi) : null;
    var irregularSimpleMode = (!rectMode && straightPts !== null);
    var detectedMode = rectMode ? "Rectangle" : (irregularSimpleMode ? "Non-rectangle simple polygon" : "Non-rectangle unsupported shape");

    var settings = showDialog(loadLastSettings(), detectedMode, baseB);
    if (!settings) return;

    // Save session memory immediately after valid dialog input.
    // If script stops because non-rectangle + pocket, the dialog values are still remembered.
    saveLastSettings(settings);

    var mainOffset_in = finishOffset(settings);
    var mainOffset = inch(mainOffset_in);
    var anyPocket = hasAnyPocket(settings);

    if (!rectMode && anyPocket) {
        alert("Pocket on non-rectangle shape detected.\n\nThis trial script will not auto-build pocket for irregular shapes.\nPlease manually adjust the selected edge/anchor points, then rerun if needed.\n\nNo artwork was generated.");
        return;
    }

    if (!rectMode && !irregularSimpleMode) {
        alert("This non-rectangle shape is not supported by v0.4 irregular offset.\n\nv0.4 only offsets ONE simple closed straight-line path.\nCurves, groups, clipping masks, and multi-path compound shapes are stopped on purpose so the script does not generate a fake overlapping Thru-cut.\n\nNo artwork was generated.");
        return;
    }

    var thruColor = THRU_COLOR();
    var kissColor = KISS_COLOR();
    var grommetColor = GROMMET_COLOR();
    var thruLayer = ensureLayer(doc, CFG.thruLayerName);
    var grommetLayer = ensureLayer(doc, CFG.grommetLayerName);
    var kissLayer = ensureLayer(doc, CFG.kissLayerName);

    // Clean only our previous generated objects. Do this after all stop conditions.
    cleanAutoItems(thruLayer);
    cleanAutoItems(grommetLayer);
    cleanAutoItems(kissLayer);

    var thruCount = 0;
    var gromCount = 0;
    var windCount = 0;
    var notes = [];

    if (rectMode) {
        var L = baseB[0] - mainOffset - (settings.pocketLeftOn ? inch(settings.pocketLeft_in) : 0);
        var T = baseB[1] + mainOffset + (settings.pocketTopOn ? inch(settings.pocketTop_in) : 0);
        var R = baseB[2] + mainOffset + (settings.pocketRightOn ? inch(settings.pocketRight_in) : 0);
        var B = baseB[3] - mainOffset - (settings.pocketBottomOn ? inch(settings.pocketBottom_in) : 0);
        var thruB = [L, T, R, B];
        drawRectPath(thruLayer, thruB, thruColor);
        thruCount = 1;
        notes.push("Thru-cut rectangle: " + fmtIn(toIn(bW(thruB))) + "\" x " + fmtIn(toIn(bH(thruB))) + "\"");
    } else {
        var offPts = offsetPolygonMiter(straightPts, mainOffset);
        if (!offPts) {
            alert("Irregular polygon offset failed. No artwork was generated.\n\nThis usually means the selected path has duplicate points or a degenerate/self-crossing outline.");
            return;
        }
        drawPath(thruLayer, offPts, true, thruColor, "Thru-cut irregular polygon offset");
        thruCount = 1;
        notes.push("Irregular Thru-cut: scripted polygon miter offset " + fmtIn(mainOffset_in) + "\". Please inspect corners/concave areas.");
    }

    if (settings.grommetOn) {
        gromCount = buildGrommets(grommetLayer, baseB, settings, grommetColor);
        if (!rectMode) notes.push("Irregular grommet is bbox-conservative only; not true inward path tracing.");
    }

    if (settings.windslitOn) {
        windCount = buildWindslits(kissLayer, baseB, settings, kissColor);
        if (windCount === 0) notes.push("Windslit skipped: selected AxB area is too small for current margin/shape settings.");
        if (!rectMode) notes.push("Irregular windslit uses selected object's bbox in this trial; inspect placement.");
    }

    var refStyled = styleAxBReference(src);
    if (!refStyled) notes.push("Could not style selected AxB shape as dashed reference line; please check selected item type.");

    app.redraw();

    var msg = "Banner Prep v0.4 done.\n" +
              (SCALE !== 1 ? "Large Canvas detected: scaleFactor " + SCALE + "\n" : "") +
              "Mode: " + detectedMode + "\n" +
              "Main offset: " + fmtIn(mainOffset_in) + "\"\n" +
              "Thru-cut objects: " + thruCount + "\n" +
              "Grommet circles: " + gromCount + "\n" +
              "Windslits: " + windCount;

    if (notes.length) {
        msg += "\n\nNotes:\n";
        for (var ni = 0; ni < notes.length; ni++) msg += "- " + notes[ni] + "\n";
    }

    alert(msg);

})();
