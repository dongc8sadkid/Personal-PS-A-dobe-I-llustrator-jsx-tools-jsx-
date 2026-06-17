#target illustrator
/*
 * AddRegistrationAndPrep.jsx
 * ---------------------------------------------------------------------------
 * Prep current Illustrator doc for output:
 *   1. Unlock + show every layer (recursive) so you can do TIFF exports after.
 *   2. Find "Thru-cut", read the union bbox of all its lines (no Shape A built).
 *   3. rectB = cut bbox expanded 0.375" on all sides (centered on bbox center).
 *   4. SNAP: if rectB width or height is in [48,48.5]" -> 47.75",
 *            or in [53,53.5]" -> 52.75". Centered shrink, other side untouched.
 *            (Both qualify -> snapTieBreak decides which one changes.)
 *   5. Active artboard -> rectB.
 *   6. Crease + Register layers ensured (created if missing).
 *   7. Register dots: 0.235" dia, K100, no stroke, WHOLE circle tangent inside
 *      rectB edge, max center spacing <= 24", deduped on overlap, forced NON-
 *      mirror-symmetric on both axes. If snapped: dots only on the two edges
 *      whose LENGTH == the changed dimension.
 *   8. rectC = rectB expanded 0.125" (centered). Drawn in Crease, white/no-stroke.
 *      (rectB object is skipped: end state == "build B, offset to C, delete B".)
 *   9. Active artboard -> rectC. Dots end up 0.125" inside the artboard (bleed).
 *  10. Save-as-PDF via a dialog, filename prefilled "(NNNNNNNN).pdf".
 *      Confirm = PDF written to chosen path. Cancel = nothing saved.
 *
 * Notes / 备注:
 *   - Assumes CMYK doc. White = 0/0/0/0, dot = K100.
 *   - Only the ACTIVE artboard is touched (multi-artboard docs: just the active one).
 *   - All expansion/shrink is centered on the cut bbox center -> nothing skews.
 *   - Large Canvas / Large Format docs handled via document.scaleFactor: all inch
 *     sizes stay true (a 0.235" dot stays 0.235", not 2.35").
 * ---------------------------------------------------------------------------
 */

(function () {

    // ===================== CONFIG =====================
    var CFG = {
        cutLayerName: "Thru-cut",
        creaseLayerName: "Crease",
        registerLayerName: "Register",

        offsetA_in: 0.375,   // cut bbox -> rectB
        offsetC_in: 0.125,   // rectB -> rectC

        dotDiameter_in: 0.235,
        maxGap_in: 24,       // max center-to-center spacing along an edge

        // snap bands [lo, hi] -> target (inches)
        snapBands: [
            { lo: 48, hi: 49, target: 47.75 },
            { lo: 53, hi: 54, target: 52.75 }
        ],
        snapEps_in: 0.02,    // tolerance padding on band edges (inclusive)

        // if BOTH width & height qualify for snap, which one changes:
        //   "width"  -> change width, lock height  (dots on TOP & BOTTOM)
        //   "height" -> change height, lock width  (dots on LEFT & RIGHT)
        snapTieBreak: "width",

        symTol_in: 0.02,     // mirror-symmetry detection tolerance
        nudge_in: 0.75,      // how far to nudge one corner dot to break symmetry

        showSummary: true,   // brief QC alert before the save dialog
        pdfPreset: ""        // optional Adobe PDF preset, e.g. "[High Quality Print]". "" = default options.
    };
    // Large Canvas / Large Format detection.
    // In large-canvas docs the DOM uses a scaled unit (document.scaleFactor, usually
    // 10): one DOM unit = scaleFactor real points. Deriving units-per-inch from it
    // keeps every inch size true -- a 0.235" dot stays 0.235", not 2.35".
    var SCALE = 1;
    try { if (app.activeDocument.scaleFactor) SCALE = app.activeDocument.scaleFactor; } catch (eSF) {}
    var IN = 72 / SCALE; // document units per inch (accounts for large canvas)

    // ===================== bounds helpers =====================
    // bounds = [L, T, R, B] with T > B and R > L (Illustrator y-up)
    function bW(b)  { return b[2] - b[0]; }
    function bH(b)  { return b[1] - b[3]; }
    function bCx(b) { return (b[0] + b[2]) / 2; }
    function bCy(b) { return (b[1] + b[3]) / 2; }
    function unionB(a, b) {
        if (!a) return [b[0], b[1], b[2], b[3]];
        return [Math.min(a[0], b[0]), Math.max(a[1], b[1]),
                Math.max(a[2], b[2]), Math.min(a[3], b[3])];
    }
    function expandB(b, d) { return [b[0] - d, b[1] + d, b[2] + d, b[3] - d]; }
    function setWidthCentered(b, w)  { var cx = bCx(b); return [cx - w / 2, b[1], cx + w / 2, b[3]]; }
    function setHeightCentered(b, h) { var cy = bCy(b); return [b[0], cy + h / 2, b[2], cy - h / 2]; }

    // ===================== color helpers =====================
    function cmyk(c, m, y, k) { var col = new CMYKColor(); col.cyan = c; col.magenta = m; col.yellow = y; col.black = k; return col; }
    function WHITE() { return cmyk(0, 0, 0, 0); }
    function K100()  { return cmyk(0, 0, 0, 100); }

    // ===================== layer helpers =====================
    function setUnlockedVisibleAll(layers) {
        for (var i = 0; i < layers.length; i++) {
            var L = layers[i];
            L.locked = false;
            L.visible = true;
            if (L.layers && L.layers.length) setUnlockedVisibleAll(L.layers);
        }
    }
    function findLayer(doc, name) {
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
        walk(doc.layers, false);
        if (!hit) walk(doc.layers, true); // case-insensitive fallback
        return hit;
    }
    function ensureLayer(doc, name) {
        var L = findLayer(doc, name);
        if (!L) { L = doc.layers.add(); L.name = name; }
        L.locked = false; L.visible = true;
        return L;
    }
    // union geometricBounds over a layer; recurse sublayers; skip guides
    function collectLayerBounds(layer) {
        var b = null;
        var items = layer.pageItems;
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            try { if (it.guides) continue; } catch (e) {}
            try { b = unionB(b, it.geometricBounds); } catch (e2) {}
        }
        if (layer.layers && layer.layers.length) {
            for (var j = 0; j < layer.layers.length; j++) {
                var sb = collectLayerBounds(layer.layers[j]);
                if (sb) b = unionB(b, sb);
            }
        }
        return b;
    }

    // ===================== draw helpers =====================
    function drawRect(layer, b, fill) {
        var r = layer.pathItems.rectangle(b[1], b[0], bW(b), bH(b)); // top,left,w,h
        r.stroked = false; r.filled = true; r.fillColor = fill;
        return r;
    }
    function drawDot(layer, cx, cy, D, fill) {
        var e = layer.pathItems.ellipse(cy + D / 2, cx - D / 2, D, D); // top,left,w,h
        e.stroked = false; e.filled = true; e.fillColor = fill;
        return e;
    }

    // ===================== dot generation =====================
    function genEdgeDots(b, r, maxGap, edges) {
        var dots = [];
        function lineDots(edge) {
            var minP, maxP, fixed;
            if (edge === "top" || edge === "bottom") {
                minP = b[0] + r; maxP = b[2] - r;
                fixed = (edge === "top") ? b[1] - r : b[3] + r;
            } else {
                minP = b[3] + r; maxP = b[1] - r;
                fixed = (edge === "left") ? b[0] + r : b[2] - r;
            }
            var span = maxP - minP;
            if (span <= 0) {
                var mid = (minP + maxP) / 2;
                if (edge === "top" || edge === "bottom") dots.push({ x: mid, y: fixed, edge: edge });
                else dots.push({ x: fixed, y: mid, edge: edge });
                return;
            }
            var n = Math.max(1, Math.ceil(span / maxGap));
            var step = span / n;
            for (var i = 0; i <= n; i++) {
                var p = minP + i * step;
                if (edge === "top" || edge === "bottom") dots.push({ x: p, y: fixed, edge: edge });
                else dots.push({ x: fixed, y: p, edge: edge });
            }
        }
        for (var k = 0; k < edges.length; k++) lineDots(edges[k]);
        return dots;
    }
    function dedupeDots(dots, minDist) {
        var kept = [];
        for (var i = 0; i < dots.length; i++) {
            var d = dots[i], ok = true;
            for (var j = 0; j < kept.length; j++) {
                var dx = d.x - kept[j].x, dy = d.y - kept[j].y;
                if (Math.sqrt(dx * dx + dy * dy) < minDist) { ok = false; break; }
            }
            if (ok) kept.push(d);
        }
        return kept;
    }
    function isMirror(dots, cx, cy, axis, tol) {
        for (var i = 0; i < dots.length; i++) {
            var tx, ty;
            if (axis === 'v') { tx = 2 * cx - dots[i].x; ty = dots[i].y; }
            else { tx = dots[i].x; ty = 2 * cy - dots[i].y; }
            var found = false;
            for (var j = 0; j < dots.length; j++) {
                if (Math.abs(dots[j].x - tx) <= tol && Math.abs(dots[j].y - ty) <= tol) { found = true; break; }
            }
            if (!found) return false;
        }
        return true;
    }
    // Nudge ONE off-axis corner dot inward along its own edge until the whole
    // set is asymmetric about BOTH axes. Inward = toward center -> never opens
    // a gap beyond maxGap (the outer side is a corner, no neighbor there).
    function breakSymmetry(dots, cx, cy, tol, nudge) {
        var tries = 0;
        while ((isMirror(dots, cx, cy, 'v', tol) || isMirror(dots, cx, cy, 'h', tol)) && tries < 12) {
            var idx = -1;
            for (var i = 0; i < dots.length; i++) {
                if (Math.abs(dots[i].x - cx) > tol && Math.abs(dots[i].y - cy) > tol) { idx = i; break; }
            }
            if (idx < 0) idx = 0;
            var d = dots[idx];
            var delta = nudge * (1 + tries * 0.5);
            if (d.edge === "top" || d.edge === "bottom") d.x += (d.x < cx) ? delta : -delta;
            else d.y += (d.y < cy) ? delta : -delta;
            tries++;
        }
        return dots;
    }

    // ===================== MAIN =====================
    if (app.documents.length === 0) { alert("Open a document first."); return; }
    var doc = app.activeDocument;

    if (doc.documentColorSpace !== DocumentColorSpace.CMYK)
        alert("Heads up: this document is not CMYK.\nWhite/Black are still written as CMYK values.");

    // 1) unlock + show all layers (recursive)
    setUnlockedVisibleAll(doc.layers);

    // 2) Thru-cut bbox
    var cutLayer = findLayer(doc, CFG.cutLayerName);
    if (!cutLayer) { alert('Layer "' + CFG.cutLayerName + '" not found.'); return; }
    var cutB = collectLayerBounds(cutLayer);
    if (!cutB) { alert('Layer "' + CFG.cutLayerName + '" has no artwork.'); return; }

    // 3) rectB = cut bbox + 0.375" (centered)
    var rectB = expandB(cutB, CFG.offsetA_in * IN);

    // 4) SNAP
    function bandTarget(valIn) {
        for (var i = 0; i < CFG.snapBands.length; i++) {
            var bd = CFG.snapBands[i];
            if (valIn >= bd.lo - CFG.snapEps_in && valIn <= bd.hi + CFG.snapEps_in) return bd.target;
        }
        return null;
    }
    var wT = bandTarget(bW(rectB) / IN);
    var hT = bandTarget(bH(rectB) / IN);
    var changedAxis = "none";
    if (wT !== null && hT !== null) {
        if (CFG.snapTieBreak === "height") { rectB = setHeightCentered(rectB, hT * IN); changedAxis = "height"; }
        else { rectB = setWidthCentered(rectB, wT * IN); changedAxis = "width"; }
    } else if (wT !== null) { rectB = setWidthCentered(rectB, wT * IN); changedAxis = "width"; }
    else if (hT !== null) { rectB = setHeightCentered(rectB, hT * IN); changedAxis = "height"; }

    // edges to populate: edges whose LENGTH == the changed dimension
    var edges;
    if (changedAxis === "width") edges = ["top", "bottom"];
    else if (changedAxis === "height") edges = ["left", "right"];
    else edges = ["top", "bottom", "left", "right"];

    // 5) active artboard -> rectB
    var abIdx = doc.artboards.getActiveArtboardIndex();
    doc.artboards[abIdx].artboardRect = [rectB[0], rectB[1], rectB[2], rectB[3]];

    // 6) layers
    var creaseLayer = ensureLayer(doc, CFG.creaseLayerName);
    var registerLayer = ensureLayer(doc, CFG.registerLayerName);

    // 7) register dots on rectB (trim), tangent inside
    var D = CFG.dotDiameter_in * IN;
    var rDot = D / 2;
    var dots = genEdgeDots(rectB, rDot, CFG.maxGap_in * IN, edges);
    dots = dedupeDots(dots, D);                              // overlap if centers < diameter
    dots = breakSymmetry(dots, bCx(rectB), bCy(rectB), CFG.symTol_in * IN, CFG.nudge_in * IN);
    for (var di = 0; di < dots.length; di++) drawDot(registerLayer, dots[di].x, dots[di].y, D, K100());

    // 8) rectC = rectB + 0.125" (centered); Crease, white/no-stroke
    var rectC = expandB(rectB, CFG.offsetC_in * IN);
    drawRect(creaseLayer, rectC, WHITE());

    // 9) active artboard -> rectC
    doc.artboards[abIdx].artboardRect = [rectC[0], rectC[1], rectC[2], rectC[3]];

    app.redraw();

    // QC summary
    if (CFG.showSummary) {
        var msg = "Done.\n"
                + (SCALE !== 1 ? "Large Canvas detected: scaleFactor " + SCALE + "\n" : "")
                + "rectC (artboard): " + (bW(rectC) / IN).toFixed(3) + '" x ' + (bH(rectC) / IN).toFixed(3) + '"\n'
                + "Snap: " + changedAxis + "\n"
                + "Register dots: " + dots.length + "  on  " + edges.join(", ");
        alert(msg);
    }

    // 10) Save as PDF via dialog (filename prefilled "(NNNNNNNN).pdf").
    //     Pick a location + confirm = PDF is written there. Cancel = nothing saved.
    var rnd = "";
    for (var z = 0; z < 8; z++) rnd += Math.floor(Math.random() * 10).toString();
    var suggested = new File("(" + rnd + ").pdf");
    var chosen = suggested.saveDlg("Save PDF");
    if (chosen) {
        if (!/\.pdf$/i.test(chosen.fsName)) chosen = new File(chosen.fsName + ".pdf");
        var opt = new PDFSaveOptions();
        if (CFG.pdfPreset && CFG.pdfPreset.length) { try { opt.pDFPreset = CFG.pdfPreset; } catch (e3) {} }
        doc.saveAs(chosen, opt);
    }

})();
