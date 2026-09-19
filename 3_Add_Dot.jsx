#target illustrator
/*
 * AddRegistrationAndPrep.jsx
 * ---------------------------------------------------------------------------
 * Prep current Illustrator doc for output:
 *   1. Unlock + show every layer (recursive) so you can do TIFF exports after.
 *   2. Find "Thru-cut", read the union bbox of all its lines (no Shape A built).
 *   3. rectB = cut bbox expanded 0.375" on all sides (centered on bbox center).
 *   4. SNAP: if rectB width or height falls into configured material bands,
 *            shrink that dimension to the matching safe rectB target.
 *            If BOTH width and height qualify, ask the user to choose 48x96,
 *            49x97, keep the original size with no snap, or cancel/check the file.
 *   5. Active artboard -> rectB.
 *   6. Crease + Register layers ensured (created if missing).
 *   7. Register dots: 0.235" dia, K100, no stroke, WHOLE circle tangent inside
 *      rectB edge, max center spacing <= 24", deduped on overlap, forced NON-
 *      mirror-symmetric on both axes. If snapped: dots only on the two edges
 *      whose LENGTH == the changed dimension.
 *   8. rectC = rectB expanded 0.125" (centered). Drawn in Crease, white/no-stroke.
 *      (rectB object is skipped: end state == "build B, offset to C, delete B".)
 *   9. Active artboard -> rectC. Dots end up 0.125" inside the artboard (bleed).
 *  10. Stray-dot cleanup: checks Register layer only. Any K100 circle whose
 *      bbox TOUCHES the Thru-cut bbox (center need not be inside) OR whose center
 *      is outside the final artboard is deleted. Never touches other layers.
 *  11. Before the save dialog: count how many separate pieces the Thru-cut layer
 *      will drop when fully cut (scoped to the FINAL artboard, which encloses the
 *      whole cut). Shown as "N closed + M grid cells = T pieces". Handles separate closed shapes
 *      (test-PDF style) AND single-stroke line grids (file1 style) with one metric
 *      (planar arrangement bounded-face count). Warns on CROSSING (a closed shape
 *      pierced = print accident -> re-check) and STRAY open lines (enclose nothing).
 *  12. Save-as-PDF via a dialog, filename prefilled "(NNNNNNNN).pdf".
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
        kissLayerName: "Kiss-cut",
        creaseLayerName: "Crease",
        registerLayerName: "Register",

        offsetA_in: 0.375,   // cut bbox -> rectB
        offsetC_in: 0.125,   // rectB -> rectC

        dotDiameter_in: 0.235,
        maxGap_in: 24,       // max center-to-center spacing along an edge

        // Stray-dot cleanup: a Register-layer K100 dot is removed if its bbox TOUCHES the
        // Thru-cut bbox (no longer requires the center to be inside). This pad adds a little
        // grazing tolerance. Legit reg dots sit ~0.14" off the cut bbox, so this is safe.
        strayTouchPad_in: 0.01,

        // Final pre-save guard: abort if Thru-cut / Kiss-cut artwork sticks outside final artboard.
        // Small tolerance avoids false alarms from Illustrator rounding noise.
        cutOutsideArtboardTol_in: 0.005,

        // snap bands [lo, hi] -> target rectB size (inches).
        // Final artboard rectC becomes target + 0.25" because offsetC expands both sides by 0.125".
        snapBands: [
            { lo: 48, hi: 49, target: 47.75 },  // final 48"
            { lo: 49, hi: 50, target: 48.75 },  // final 49"
            { lo: 53, hi: 54, target: 52.75 },  // final 53"
            { lo: 96, hi: 97, target: 95.75 },  // final 96"
            { lo: 97, hi: 98, target: 96.75 }   // final 97"
        ],
        snapEps_in: 0.02,    // tolerance padding on band edges (inclusive)

        // Long-job review guard: if final rectB height exceeds this AND any snap
        // was applied, force Register dots onto all four sides, build/QC normally,
        // then skip PDF saving so the operator must review the Illustrator file.
        longSnapReviewHeight_in: 120,

        // If BOTH width & height qualify for snap, show a human confirmation dialog.
        // These are final sheet targets; rectB targets are 0.25" smaller.
        doubleSnapSheetTargets: [
            { label: "48 x 96 final sheet", rectBW: 47.75, rectBH: 95.75 },
            { label: "49 x 97 final sheet", rectBW: 48.75, rectBH: 96.75 }
        ],

        symTol_in: 0.02,          // mirror-symmetry detection tolerance
        cornerPairGap_in: [2, 5], // gap range (in") for the 2nd dot at the special corner

        showSummary: true,   // brief QC alert before the save dialog
        pdfPreset: "",       // optional Adobe PDF preset, e.g. "[High Quality Print]". "" = default options.

        // --- Thru-cut piece counter (added) ---
        // Before the save dialog, report how many separate pieces the Thru-cut layer
        // will drop when fully cut. Counts only shapes on the ACTIVE artboard.
        countPieces:     true,   // master switch for the whole feature
        flattenTol_pt:   0.3,    // bezier->line flatten precision (pt). smaller = finer + slower
        snapTol_pt:      0.5,    // merge endpoints/intersections within this (pt). your grids are clean -> tight is fine
        abortOnCrossing: false,  // true = if a CROSSING (print accident) is found, warn and SKIP the save
        warnStrayLines:  true    // warn about open lines that enclose nothing ("call the operator")
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

    // ===================== final artboard QC helpers =====================
    function fmtIn(v) { return (v / IN).toFixed(3) + '\"'; }

    function cutLayerOutsideArtboardReport(doc, layerName, abRect) {
        var L = findLayer(doc, layerName);
        if (!L) return null; // Kiss-cut may not exist on every job; missing layer is OK.

        var lb = collectLayerBounds(L);
        if (!lb) return null;

        var tol = CFG.cutOutsideArtboardTol_in * IN;
        var outs = [];
        if (lb[0] < abRect[0] - tol) outs.push('LEFT  ' + fmtIn(abRect[0] - lb[0]));
        if (lb[1] > abRect[1] + tol) outs.push('TOP   ' + fmtIn(lb[1] - abRect[1]));
        if (lb[2] > abRect[2] + tol) outs.push('RIGHT ' + fmtIn(lb[2] - abRect[2]));
        if (lb[3] < abRect[3] - tol) outs.push('BOTTOM ' + fmtIn(abRect[3] - lb[3]));

        if (outs.length === 0) return null;

        return {
            layerName: L.name,
            bounds: lb,
            outs: outs
        };
    }

    function abortIfCutLayersOutsideArtboard(doc, abRect) {
        var reports = [];
        var r1 = cutLayerOutsideArtboardReport(doc, CFG.cutLayerName, abRect);
        if (r1) reports.push(r1);
        var r2 = cutLayerOutsideArtboardReport(doc, CFG.kissLayerName, abRect);
        if (r2) reports.push(r2);

        if (reports.length === 0) return false;

        var msg = '\u26A0 CUT LINE OUTSIDE ARTBOARD / \u5200\u7ebf\u8d85\u51fa\u753b\u677f\n\n'
                + 'Save skipped. No PDF save dialog will open.\n'
                + '\u811a\u672c\u5df2\u4e2d\u6b62\uff0c\u8bf7\u56de\u5934\u68c0\u67e5 Snap / Artboard / Cut lines.\n\n'
                + 'Final artboard: ' + fmtIn(bW(abRect)) + ' x ' + fmtIn(bH(abRect)) + '\n'
                + 'Tolerance: ' + CFG.cutOutsideArtboardTol_in.toFixed(3) + '\"\n\n';

        for (var i = 0; i < reports.length; i++) {
            var rr = reports[i];
            msg += '[' + rr.layerName + '] is outside:\n'
                + rr.outs.join('\n') + '\n'
                + 'Layer bbox: ' + fmtIn(bW(rr.bounds)) + ' x ' + fmtIn(bH(rr.bounds)) + '\n\n';
        }

        alert(msg);
        return true;
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
    // At the off-axis corner chosen for asymmetry: first OFFSET that dot 2" along
    // its edge (toward edge center), THEN add a second dot a further 2–5" out from
    // the offset position. Both stay tangent to rectB. Result: that one corner shows
    // a distinct pair so the cutter operator instantly spots the reference corner.
    function breakSymmetry(dots, b, cx, cy, tol, r, inUnit) {
        // find first dot off-axis in BOTH x and y (a corner dot)
        var idx = -1;
        for (var i = 0; i < dots.length; i++) {
            if (Math.abs(dots[i].x - cx) > tol && Math.abs(dots[i].y - cy) > tol) { idx = i; break; }
        }
        if (idx < 0) idx = 0;
        var d = dots[idx];

        var horiz = (d.edge === "top" || d.edge === "bottom");
        var dir   = horiz ? ((d.x < cx) ? 1 : -1) : ((d.y < cy) ? 1 : -1); // toward edge center

        function clamp(v) {
            return horiz ? Math.max(b[0] + r, Math.min(b[2] - r, v))
                         : Math.max(b[3] + r, Math.min(b[1] - r, v));
        }

        // 1) offset the corner dot itself by 2"
        var firstOff = 2 * inUnit;
        if (horiz) d.x = clamp(d.x + dir * firstOff);
        else       d.y = clamp(d.y + dir * firstOff);

        // 2) copy a second dot a further 2–5" out from the (now offset) position
        var lo = CFG.cornerPairGap_in[0], hi = CFG.cornerPairGap_in[1];
        var gap = (lo + Math.random() * (hi - lo)) * inUnit;
        var x2 = d.x, y2 = d.y;
        if (horiz) x2 = clamp(d.x + dir * gap);
        else       y2 = clamp(d.y + dir * gap);
        dots.push({ x: x2, y: y2, edge: d.edge });

        // fallback: if still mirror-symmetric, nudge the new dot
        var tries = 0;
        while ((isMirror(dots, cx, cy, 'v', tol) || isMirror(dots, cx, cy, 'h', tol)) && tries < 6) {
            if (horiz) dots[dots.length - 1].x = clamp(dots[dots.length - 1].x + dir * 0.25 * inUnit * (tries + 1));
            else       dots[dots.length - 1].y = clamp(dots[dots.length - 1].y + dir * 0.25 * inUnit * (tries + 1));
            tries++;
        }
        return dots;
    }

    // ===================== stray dot cleanup =====================
    // Detects black circle-like PathItems that are either:
    //   (a) TOUCHING the Thru-cut bbox  — bbox overlaps/grazes the cut (center need NOT be inside)
    //   (b) outside the final artboard   — fell off the edge (center test)
    // "Black" = CMYK K>=50, Gray>=50, RGB<=50 each channel, or spot named "black"/"registration"
    // "Small"  = both w and h <= 1.5" (catches 0.235" reg dots; ignores big design circles)
    // "Circle" = w and h within 15% of each other
    var _maxDotDia = 1.5 * IN;
    var _minKBlack = 50;

    function _isBlackCircle(item) {
        if (item.typename !== "PathItem") return false;
        var b;
        try { b = item.geometricBounds; } catch (e) { return false; }
        var w = Math.abs(b[2] - b[0]);
        var h = Math.abs(b[1] - b[3]);
        if (w > _maxDotDia || h > _maxDotDia) return false;           // too big
        if (w === 0 || Math.abs(w - h) / w > 0.15) return false;      // not circular
        if (!item.filled) return false;
        var col = item.fillColor;
        if (!col) return false;
        if (col.typename === "CMYKColor") return col.black >= _minKBlack;
        if (col.typename === "GrayColor") return col.gray  >= _minKBlack;
        if (col.typename === "RGBColor")  return col.red <= 50 && col.green <= 50 && col.blue <= 50;
        if (col.typename === "SpotColor") {
            var sn = col.spot.name.toLowerCase();
            return sn.indexOf("black") !== -1 || sn === "registration";
        }
        return false;
    }
    function _isStrayPos(item, cutB, abRect) {
        var b = item.geometricBounds;   // [left, top, right, bottom], y-up (top > bottom)
        // (a) dot's bbox TOUCHES / overlaps the Thru-cut bbox (center no longer required inside).
        //     Standard AABB intersection + a small pad so grazing contact still counts.
        var pad = CFG.strayTouchPad_in * IN;
        var touchCut = (b[0] <= cutB[2] + pad) && (b[2] >= cutB[0] - pad) &&
                       (b[3] <= cutB[1] + pad) && (b[1] >= cutB[3] - pad);
        // (b) center outside the final artboard — fell off the edge
        var cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
        var outAB = cx < abRect[0] || cx > abRect[2] || cy > abRect[1] || cy < abRect[3];
        return touchCut || outAB;
    }
    function cleanStrayDots(layers, cutB, abRect) {
        var victims = [];
        function walk(lyr) {
            var items = lyr.pageItems;
            for (var i = 0; i < items.length; i++) {
                if (_isBlackCircle(items[i]) && _isStrayPos(items[i], cutB, abRect)) victims.push(items[i]);
            }
            if (lyr.layers && lyr.layers.length)
                for (var j = 0; j < lyr.layers.length; j++) walk(lyr.layers[j]);
        }
        for (var i = 0; i < layers.length; i++) walk(layers[i]);
        // delete collected refs (safe: we're no longer iterating the live collection)
        for (var k = 0; k < victims.length; k++) { try { victims[k].remove(); } catch (e2) {} }
        return victims.length;
    }

    // ===================== Thru-cut piece counter =====================
    // Counts how many separate pieces the Thru-cut layer drops when fully cut.
    // Validated (Python port) against real files: 24 separate ellipses -> 24,
    // and a 9x7 single-stroke grid -> 48. Synthetic tests cover crossing/stray/donut/gang-up.
    //
    // Method (Case A: shapes never cross; at most they share edges or form line grids):
    //   * flatten every path to straight segments
    //   * pairwise (bbox-gated) contact classify:  touch / collinear / transversal cross
    //       - transversal cross where EITHER side is a CLOSED edge  -> CROSSING (print accident)
    //       - open x open transversal cross                          -> normal grid, OK
    //   * union touching items into clusters
    //       - singleton closed loop  -> 1 piece (even/odd nesting: a loop inside a loop = hole)
    //       - singleton compound     -> 1 piece (donut = 1, per spec)
    //       - singleton open path     -> STRAY (encloses nothing)
    //       - cluster (>=2)           -> planarize + Euler:  faces = E - V + C
    //                                    degree-1 vertices    -> STRAY (dangling cut)
    //   Returns { closed, cells, total, crossings:[pt], strays:[pt], items }
    function PC_dist(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return Math.sqrt(dx * dx + dy * dy); }
    function PC_d2(ax, ay, bx, by)   { var dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
    function PC_eqPt(a, b, t) { return Math.abs(a[0] - b[0]) <= t && Math.abs(a[1] - b[1]) <= t; }

    function PC_flattenCubic(p0, p1, p2, p3, tol, out, depth) {
        var x0 = p0[0], y0 = p0[1], x3 = p3[0], y3 = p3[1];
        var dx = x3 - x0, dy = y3 - y0, L = Math.sqrt(dx * dx + dy * dy);
        function dpt(px, py) {
            if (L < 1e-9) return Math.sqrt((px - x0) * (px - x0) + (py - y0) * (py - y0));
            return Math.abs((px - x0) * dy - (py - y0) * dx) / L;
        }
        if (depth > 18 || (dpt(p1[0], p1[1]) <= tol && dpt(p2[0], p2[1]) <= tol)) { out.push([x3, y3]); return; }
        function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
        var p01 = mid(p0, p1), p12 = mid(p1, p2), p23 = mid(p2, p3);
        var p012 = mid(p01, p12), p123 = mid(p12, p23), pm = mid(p012, p123);
        PC_flattenCubic(p0, p01, p012, pm, tol, out, depth + 1);
        PC_flattenCubic(pm, p123, p23, p3, tol, out, depth + 1);
    }

    // PathItem outline -> flat point list (poly). Straight spans stay 1 segment.
    function PC_pathToPoly(pi, flatTol) {
        var pts = pi.pathPoints, n = pts.length;
        if (n < 2) return null;
        var poly = [], a0 = pts[0].anchor; poly.push([a0[0], a0[1]]);
        var spanN = pi.closed ? n : (n - 1);
        for (var i = 0; i < spanN; i++) {
            var cur = pts[i], nxt = pts[(i + 1) % n];
            var A = cur.anchor, h0 = cur.rightDirection, h1 = nxt.leftDirection, B = nxt.anchor;
            if (PC_eqPt(h0, A, 1e-4) && PC_eqPt(h1, B, 1e-4)) poly.push([B[0], B[1]]);
            else PC_flattenCubic([A[0], A[1]], [h0[0], h0[1]], [h1[0], h1[1]], [B[0], B[1]], flatTol, poly, 0);
        }
        return poly;
    }
    function PC_polyToSegs(poly, closed) {
        var segs = [], m = poly.length, lim = closed ? m : (m - 1);
        for (var i = 0; i < lim; i++) {
            var a = poly[i], b = poly[(i + 1) % m];
            if (PC_d2(a[0], a[1], b[0], b[1]) > 1e-12) segs.push([a[0], a[1], b[0], b[1]]);
        }
        return segs;
    }
    function PC_bboxOfSegs(segs) {
        var minx = 1e18, miny = 1e18, maxx = -1e18, maxy = -1e18;
        for (var i = 0; i < segs.length; i++) {
            var s = segs[i];
            if (s[0] < minx) minx = s[0]; if (s[2] < minx) minx = s[2];
            if (s[0] > maxx) maxx = s[0]; if (s[2] > maxx) maxx = s[2];
            if (s[1] < miny) miny = s[1]; if (s[3] < miny) miny = s[3];
            if (s[1] > maxy) maxy = s[1]; if (s[3] > maxy) maxy = s[3];
        }
        return [minx, miny, maxx, maxy];
    }
    function PC_bboxOverlap(A, B, pad) { return !(A[2] < B[0] - pad || B[2] < A[0] - pad || A[3] < B[1] - pad || B[3] < A[1] - pad); }
    function PC_segBoxHit(a, b, pad) {
        return !(Math.max(a[0], a[2]) < Math.min(b[0], b[2]) - pad || Math.max(b[0], b[2]) < Math.min(a[0], a[2]) - pad ||
                 Math.max(a[1], a[3]) < Math.min(b[1], b[3]) - pad || Math.max(b[1], b[3]) < Math.min(a[1], a[3]) - pad);
    }

    // classify two segments -> { type:'none'|'cross'|'touch'|'collinear', pt:[x,y]|null }
    function PC_classify(a, b, tol) {
        var ax1 = a[0], ay1 = a[1], ax2 = a[2], ay2 = a[3];
        var bx1 = b[0], by1 = b[1], bx2 = b[2], by2 = b[3];
        var rx = ax2 - ax1, ry = ay2 - ay1, sx = bx2 - bx1, sy = by2 - by1;
        var denom = rx * sy - ry * sx, qpx = bx1 - ax1, qpy = by1 - ay1;
        var Lr = Math.sqrt(rx * rx + ry * ry), Ls = Math.sqrt(sx * sx + sy * sy);
        if (Math.abs(denom) < 1e-9) {
            var crs = qpx * ry - qpy * rx;
            if (Lr < 1e-9) return { type: 'none', pt: null };
            if (Math.abs(crs) / Lr > tol) return { type: 'none', pt: null }; // parallel, not collinear
            var t0 = ((bx1 - ax1) * rx + (by1 - ay1) * ry) / (Lr * Lr);
            var t1 = ((bx2 - ax1) * rx + (by2 - ay1) * ry) / (Lr * Lr);
            if (t0 > t1) { var tmp = t0; t0 = t1; t1 = tmp; }
            var lo = Math.max(0, t0), hi = Math.min(1, t1);
            if (hi - lo > tol / Lr) return { type: 'collinear', pt: null };
            if (PC_dist(bx1, by1, ax1, ay1) <= tol || PC_dist(bx1, by1, ax2, ay2) <= tol) return { type: 'touch', pt: [bx1, by1] };
            if (PC_dist(bx2, by2, ax1, ay1) <= tol || PC_dist(bx2, by2, ax2, ay2) <= tol) return { type: 'touch', pt: [bx2, by2] };
            return { type: 'none', pt: null };
        }
        var t = (qpx * sy - qpy * sx) / denom;
        var u = (qpx * ry - qpy * rx) / denom;
        var tt = Lr > 0 ? tol / Lr : tol, tu = Ls > 0 ? tol / Ls : tol;
        if (t < -tt || t > 1 + tt || u < -tu || u > 1 + tu) return { type: 'none', pt: null };
        var px = ax1 + t * rx, py = ay1 + t * ry;
        var atA = PC_dist(px, py, ax1, ay1) <= tol || PC_dist(px, py, ax2, ay2) <= tol;
        var atB = PC_dist(px, py, bx1, by1) <= tol || PC_dist(px, py, bx2, by2) <= tol;
        if (atA || atB) return { type: 'touch', pt: [px, py] };
        return { type: 'cross', pt: [px, py] }; // interior x interior = transversal
    }

    function PC_pointInPoly(px, py, poly) {
        var inside = false, n = poly.length, j = n - 1;
        for (var i = 0; i < n; i++) {
            var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
            var dydiff = (yj - yi) || 1e-12;
            if (((yi > py) != (yj > py)) && (px < (xj - xi) * (py - yi) / dydiff + xi)) inside = !inside;
            j = i;
        }
        return inside;
    }

    // union-find
    function PC_ufMake(n) { var p = []; for (var i = 0; i < n; i++) p[i] = i; return p; }
    function PC_ufFind(p, x) { while (p[x] != x) { p[x] = p[p[x]]; x = p[x]; } return x; }
    function PC_ufUnion(p, a, b) { p[PC_ufFind(p, a)] = PC_ufFind(p, b); }

    // planarize a set of segments + count bounded faces via Euler. Pushes degree-1 pts to strayOut.
    function PC_eulerFaces(segs, tol, strayOut) {
        var N = segs.length, pon = [];
        for (var i = 0; i < N; i++) pon[i] = [ { t: 0, x: segs[i][0], y: segs[i][1] }, { t: 1, x: segs[i][2], y: segs[i][3] } ];
        for (var i2 = 0; i2 < N; i2++) for (var j2 = i2 + 1; j2 < N; j2++) {
            if (!PC_segBoxHit(segs[i2], segs[j2], tol)) continue;
            var c = PC_classify(segs[i2], segs[j2], tol);
            if (!c.pt) continue;
            var pr = c.pt, pairs = [[i2, segs[i2]], [j2, segs[j2]]];
            for (var k = 0; k < 2; k++) {
                var idx = pairs[k][0], s = pairs[k][1];
                var L2 = PC_d2(s[0], s[1], s[2], s[3]);
                var tp = L2 < 1e-12 ? 0 : ((pr[0] - s[0]) * (s[2] - s[0]) + (pr[1] - s[1]) * (s[3] - s[1])) / L2;
                if (tp < 0) tp = 0; if (tp > 1) tp = 1;
                pon[idx].push({ t: tp, x: pr[0], y: pr[1] });
            }
        }
        var vid = {}, vcount = 0, inv = [];
        function getv(x, y) {
            var kx = Math.round(x / tol), ky = Math.round(y / tol), key = kx + "_" + ky;
            if (vid[key] === undefined) { vid[key] = vcount; inv[vcount] = [kx * tol, ky * tol]; vcount++; }
            return vid[key];
        }
        var edgeKeys = {}, edgeList = [];
        for (var e = 0; e < N; e++) {
            var lst = pon[e];
            lst.sort(function (A, B) { return A.t - B.t; });
            for (var a2 = 0; a2 < lst.length - 1; a2++) {
                var va = getv(lst[a2].x, lst[a2].y), vb = getv(lst[a2 + 1].x, lst[a2 + 1].y);
                if (va == vb) continue;
                var lo = Math.min(va, vb), hi = Math.max(va, vb), ek = lo + "_" + hi;
                if (edgeKeys[ek] === undefined) { edgeKeys[ek] = 1; edgeList.push([lo, hi]); }
            }
        }
        var V = vcount, E = edgeList.length, pf = PC_ufMake(V), deg = [];
        for (var d0 = 0; d0 < V; d0++) deg[d0] = 0;
        for (var e2 = 0; e2 < E; e2++) { PC_ufUnion(pf, edgeList[e2][0], edgeList[e2][1]); deg[edgeList[e2][0]]++; deg[edgeList[e2][1]]++; }
        var roots = {}, C = 0;
        for (var v = 0; v < V; v++) if (deg[v] > 0) { var r = PC_ufFind(pf, v); if (roots[r] === undefined) { roots[r] = 1; C++; } }
        var faces = E - V + C;
        for (var v2 = 0; v2 < V; v2++) if (deg[v2] == 1) strayOut.push([inv[v2][0], inv[v2][1]]);
        return faces < 0 ? 0 : faces;
    }

    function countThruCutPieces(layer, abRect, IN_, SCALE_) {
        var SNAP = CFG.snapTol_pt / SCALE_;     // pt -> document units (large-canvas safe)
        var FLAT = CFG.flattenTol_pt / SCALE_;
        function inAB(b) {
            var cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
            return cx >= abRect[0] - SNAP && cx <= abRect[2] + SNAP && cy <= abRect[1] + SNAP && cy >= abRect[3] - SNAP;
        }
        var items = [];
        function pushPath(pi) {
            var poly = PC_pathToPoly(pi, FLAT); if (!poly) return;
            var segs = PC_polyToSegs(poly, pi.closed ? true : false); if (segs.length === 0) return;
            items.push({ segs: segs, closed: pi.closed ? true : false, compound: false, poly: poly, bbox: PC_bboxOfSegs(segs) });
        }
        function pushCompound(cp) {
            var segs = [], poly = null;
            for (var i = 0; i < cp.pathItems.length; i++) {
                var p2 = PC_pathToPoly(cp.pathItems[i], FLAT); if (!p2) continue;
                var sg = PC_polyToSegs(p2, true);
                for (var s = 0; s < sg.length; s++) segs.push(sg[s]);
                if (!poly) poly = p2;
            }
            if (segs.length === 0) return;
            items.push({ segs: segs, closed: true, compound: true, poly: poly, bbox: PC_bboxOfSegs(segs) });
        }
        // Process a pageItems collection. pageItems on a Layer or Group returns DIRECT
        // children only (NOT recursive), so GroupItems must be descended into explicitly.
        // This counts grouped artwork WITHOUT ungrouping (non-destructive: your file is untouched).
        function collectFrom(coll) {
            for (var i = 0; i < coll.length; i++) {
                var it = coll[i];
                try { if (it.guides) continue; } catch (eg) {}
                var tn = it.typename, bb;
                if (tn === "PathItem") {
                    try { if (it.clipping) continue; } catch (ec) {}   // skip clip masks (not a cut shape)
                    try { bb = it.geometricBounds; } catch (e1) { continue; }
                    if (inAB(bb)) pushPath(it);
                } else if (tn === "CompoundPathItem") {
                    try { bb = it.geometricBounds; } catch (e2) { continue; }
                    if (inAB(bb)) pushCompound(it);
                } else if (tn === "GroupItem") {
                    collectFrom(it.pageItems);                         // descend into the group (handles nested groups)
                }
                // other types (text, plugin/symbol art) are not cut paths -> ignored
            }
        }
        function walk(lyr) {
            collectFrom(lyr.pageItems);
            if (lyr.layers && lyr.layers.length) for (var j = 0; j < lyr.layers.length; j++) walk(lyr.layers[j]);
        }
        walk(layer);

        var n = items.length, crossings = [], strays = [], pf = PC_ufMake(n);
        for (var i = 0; i < n; i++) for (var j = i + 1; j < n; j++) {
            if (!PC_bboxOverlap(items[i].bbox, items[j].bbox, SNAP)) continue;
            var touched = false, Si = items[i].segs, Sj = items[j].segs;
            for (var a = 0; a < Si.length; a++) for (var b = 0; b < Sj.length; b++) {
                if (!PC_segBoxHit(Si[a], Sj[b], SNAP)) continue;
                var c = PC_classify(Si[a], Sj[b], SNAP);
                if (c.type === 'none') continue;
                if (c.type === 'cross') {
                    if (items[i].closed || items[j].closed) { if (c.pt) crossings.push(c.pt); }
                    touched = true;            // open x open crossing = grid node, still same cluster
                } else touched = true;          // touch / collinear (shared edge) = same cluster
            }
            if (touched) PC_ufUnion(pf, i, j);
        }
        var groups = {};
        for (var g = 0; g < n; g++) { var rt = PC_ufFind(pf, g); if (!groups[rt]) groups[rt] = []; groups[rt].push(g); }
        var closed_pieces = 0, cell_pieces = 0, isoClosed = [];
        for (var key in groups) {
            if (!groups.hasOwnProperty(key)) continue;
            var mem = groups[key];
            if (mem.length === 1) {
                var it = items[mem[0]];
                if (it.closed) { if (it.compound) closed_pieces++; else isoClosed.push(it); }
                else strays.push([it.bbox[0], it.bbox[1]]);   // isolated open path -> encloses nothing
            } else {
                var segs = [];
                for (var m = 0; m < mem.length; m++) { var sg = items[mem[m]].segs; for (var s2 = 0; s2 < sg.length; s2++) segs.push(sg[s2]); }
                cell_pieces += PC_eulerFaces(segs, SNAP, strays);
            }
        }
        // even/odd nesting among isolated, non-compound closed loops (donut by separate paths = 1)
        for (var ic = 0; ic < isoClosed.length; ic++) {
            var depth = 0, rp = isoClosed[ic].poly[0];
            for (var jc = 0; jc < isoClosed.length; jc++) {
                if (ic === jc) continue;
                if (PC_pointInPoly(rp[0], rp[1], isoClosed[jc].poly)) depth++;
            }
            if (depth % 2 === 0) closed_pieces++;
        }
        return { closed: closed_pieces, cells: cell_pieces, total: closed_pieces + cell_pieces,
                 crossings: crossings, strays: strays, items: n };
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
        var best = null;
        var bestDist = 1e18;
        for (var i = 0; i < CFG.snapBands.length; i++) {
            var bd = CFG.snapBands[i];
            if (valIn >= bd.lo - CFG.snapEps_in && valIn <= bd.hi + CFG.snapEps_in) {
                // If padded bands overlap at a boundary, choose the band whose center is closest.
                var mid = (bd.lo + bd.hi) / 2;
                var dist = Math.abs(valIn - mid);
                if (dist < bestDist) { best = bd; bestDist = dist; }
            }
        }
        return best ? best.target : null;
    }

    function askDoubleSnapSheetTarget(widthIn, heightIn, widthTarget, heightTarget) {
        var dlg = new Window("dialog", "Double snap check");
        dlg.orientation = "column";
        dlg.alignChildren = "fill";
        dlg.margins = 16;
        dlg.spacing = 10;

        var intro = dlg.add("statictext", undefined,
            "Width and height both match snap ranges. Choose a final sheet size, or continue without snapping:",
            { multiline: true }
        );
        intro.preferredSize.width = 460;

        var info = dlg.add("statictext", undefined,
            "rectB width:  " + widthIn.toFixed(3) + "\" -> detected " + widthTarget + "\"\n" +
            "rectB height: " + heightIn.toFixed(3) + "\" -> detected " + heightTarget + "\"",
            { multiline: true }
        );
        info.preferredSize.width = 460;

        var panel = dlg.add("panel", undefined, "Snap choice");
        panel.orientation = "column";
        panel.alignChildren = "left";
        panel.margins = 12;
        panel.spacing = 6;

        var radios = [];
        for (var st = 0; st < CFG.doubleSnapSheetTargets.length; st++) {
            var tgt = CFG.doubleSnapSheetTargets[st];
            var finalW = tgt.rectBW + 2 * CFG.offsetC_in;
            var finalH = tgt.rectBH + 2 * CFG.offsetC_in;
            var rb = panel.add("radiobutton", undefined,
                tgt.label + "  (rectB " + tgt.rectBW + " x " + tgt.rectBH + ", final artboard " + finalW + " x " + finalH + ")"
            );
            rb.__target = tgt;
            radios.push(rb);
        }

        // Deliberate bypass: keep rectB exactly as calculated from the cut bounds.
        // This is distinct from Cancel: the script continues and places dots on all four sides.
        var noSnapRadio = panel.add("radiobutton", undefined,
            "No Snap - ignore sheet width and add dots directly (all four sides)"
        );

        // Try to preselect the target matching the detected snap result.
        for (var r0 = 0; r0 < radios.length; r0++) {
            if (Math.abs(radios[r0].__target.rectBW - widthTarget) < 0.001 &&
                Math.abs(radios[r0].__target.rectBH - heightTarget) < 0.001) {
                radios[r0].value = true;
                break;
            }
        }

        var warning = dlg.add("statictext", undefined,
            "If this is unexpected, cancel and check the Thru-cut bounds / artboard before saving.",
            { multiline: true }
        );
        warning.preferredSize.width = 460;

        var btns = dlg.add("group");
        btns.alignment = "right";
        var cancelBtn = btns.add("button", undefined, "Cancel / Check file", { name: "cancel" });
        var okBtn = btns.add("button", undefined, "Continue", { name: "ok" });
        dlg.defaultElement = okBtn;
        dlg.cancelElement = cancelBtn;

        var chosen = null;
        okBtn.onClick = function () {
            if (noSnapRadio.value) {
                chosen = { noSnap: true };
            } else {
                for (var r = 0; r < radios.length; r++) {
                    if (radios[r].value) { chosen = radios[r].__target; break; }
                }
            }
            if (!chosen) {
                alert("Please choose a sheet target or No Snap, or cancel to check the file.");
                return;
            }
            dlg.close();
        };

        dlg.show();
        return chosen;
    }

    var rectBWidthIn  = bW(rectB) / IN;
    var rectBHeightIn = bH(rectB) / IN;
    var wT = bandTarget(rectBWidthIn);
    var hT = bandTarget(rectBHeightIn);
    var changedAxis = "none";
    if (wT !== null && hT !== null) {
        var sheetTarget = askDoubleSnapSheetTarget(rectBWidthIn, rectBHeightIn, wT, hT);
        if (sheetTarget === null) { return; }
        if (!sheetTarget.noSnap) {
            rectB = setWidthCentered(rectB, sheetTarget.rectBW * IN);
            rectB = setHeightCentered(rectB, sheetTarget.rectBH * IN);
            changedAxis = "both";
        }
    } else if (wT !== null) { rectB = setWidthCentered(rectB, wT * IN); changedAxis = "width"; }
    else if (hT !== null) { rectB = setHeightCentered(rectB, hT * IN); changedAxis = "height"; }

    // Long-job + snap guard. Use the POST-SNAP rectB height. If any snap was
    // applied and the height exceeds the cutter limit, force dots on all four
    // sides and later skip saving so the operator must review the prepared file.
    var longSnapReview = (changedAxis !== "none" && (bH(rectB) / IN) > CFG.longSnapReviewHeight_in);

    // edges to populate: normally, edges whose LENGTH == the changed dimension.
    // Long snapped jobs are the exception: cutter constraints require all four sides.
    var edges;
    if (longSnapReview) edges = ["top", "bottom", "left", "right"];
    else if (changedAxis === "width") edges = ["top", "bottom"];
    else if (changedAxis === "height") edges = ["left", "right"];
    else if (changedAxis === "both") edges = ["top", "bottom", "left", "right"];
    else edges = ["top", "bottom", "left", "right"];

    // Precompute final artboard. QC will run after Register dots + Crease box are built,
    // so if it aborts, the operator still has the generated setup pieces to adjust.
    var rectC = expandB(rectB, CFG.offsetC_in * IN);

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
    dots = breakSymmetry(dots, rectB, bCx(rectB), bCy(rectB), CFG.symTol_in * IN, rDot, IN);
    for (var di = 0; di < dots.length; di++) drawDot(registerLayer, dots[di].x, dots[di].y, D, K100());

    // 8) rectC = rectB + 0.125" (centered); Crease, white/no-stroke
    drawRect(creaseLayer, rectC, WHITE());

    // 9) active artboard -> rectC
    doc.artboards[abIdx].artboardRect = [rectC[0], rectC[1], rectC[2], rectC[3]];

    // stray-dot cleanup: scan Register layer ONLY.
    // Remove K100 dots whose center is inside the cut bbox OR outside the artboard.
    // Scoping to Register avoids touching anything in customer artwork.
    var deletedDots = cleanStrayDots([registerLayer], cutB, [rectC[0], rectC[1], rectC[2], rectC[3]]);

    app.redraw();

    // Final cut-line QC: run AFTER Register dots + Crease box exist, but BEFORE any
    // summaries, piece-count warnings, or the save dialog. If it aborts, the file is
    // left with the generated Register/Crease assets so you can adjust them manually.
    if (abortIfCutLayersOutsideArtboard(doc, [rectC[0], rectC[1], rectC[2], rectC[3]])) {
        return;
    }

    // Thru-cut piece count (active artboard only). Runs after redraw, before the save dialog.
    // Thru-cut layer contents are never modified by this script, so counting here is safe.
    // Thru-cut piece count. Scoped to the FINAL artboard (rectC), which is built from the
    // union bbox of ALL Thru-cut artwork + margins -> it always contains every cut shape.
    // (Using the pre-resize artboard here would wrongly drop shapes that stick out past it,
    //  e.g. bleed tabs / scalloped edges above or below the main body.)
    var pieceRes = null;
    if (CFG.countPieces) {
        try { pieceRes = countThruCutPieces(cutLayer, rectC, IN, SCALE); }
        catch (ePC) { pieceRes = { error: ePC.toString() }; }
    }

    // helper: format a list of [x,y] doc-unit points as inches, capped
    function fmtPts(arr, capN) {
        var s = "", k = (arr.length < capN ? arr.length : capN);
        for (var i = 0; i < k; i++) s += "   (" + (arr[i][0] / IN).toFixed(2) + '", ' + (arr[i][1] / IN).toFixed(2) + '")\n';
        if (arr.length > capN) s += "   ... +" + (arr.length - capN) + " more\n";
        return s;
    }

    // QC summary
    if (CFG.showSummary) {
        var msg = "Done.\n"
                + (SCALE !== 1 ? "Large Canvas detected: scaleFactor " + SCALE + "\n" : "")
                + "rectC (artboard): " + (bW(rectC) / IN).toFixed(3) + '" x ' + (bH(rectC) / IN).toFixed(3) + '"\n'
                + "Snap: " + changedAxis + "\n"
                + "Register dots: " + dots.length + "  on  " + edges.join(", ")
                + (longSnapReview ? "\nLONG SNAP REVIEW: save will be skipped" : "")
                + (deletedDots > 0 ? "\nStray dots removed: " + deletedDots : "");
        if (pieceRes && !pieceRes.error)
            msg += "\nThru-cut: " + pieceRes.closed + " closed + " + pieceRes.cells
                 + " grid cells = " + pieceRes.total + " pieces";
        else if (pieceRes && pieceRes.error)
            msg += "\nThru-cut count FAILED: " + pieceRes.error;
        alert(msg);
    }

    // Crossing / stray warnings (independent alert, fires before the save dialog).
    if (pieceRes && !pieceRes.error) {
        var hasCross = pieceRes.crossings.length > 0;
        var hasStray = CFG.warnStrayLines && pieceRes.strays.length > 0;
        if (hasCross || hasStray) {
            var w = "\u26A0  Thru-cut QC \u8b66\u544a / WARNING\n\n";
            if (hasCross) {
                w += "CROSSING \u00d7" + pieceRes.crossings.length + "  \u2014 \u95ed\u5408\u5f62\u72b6\u88ab\u8d2f\u7a7f\n"
                   + "\u8981\u51fa\u5370\u5237\u4e8b\u6545\u4e86\uff0c\u8bf7\u91cd\u67e5\u6587\u4ef6\uff01 (closed shape pierced)\n"
                   + fmtPts(pieceRes.crossings, 8) + "\n";
            }
            if (hasStray) {
                w += "STRAY LINES \u00d7" + pieceRes.strays.length + "  \u2014 \u4e0d\u95ed\u5408\u3001\u56f4\u4e0d\u51fa\u5f62\u72b6\u7684\u7ebf\n"
                   + "\u8be5\u53eb operator \u4e86 (open lines enclosing nothing)\n"
                   + fmtPts(pieceRes.strays, 8);
            }
            alert(w);
            if (CFG.abortOnCrossing && hasCross) {
                alert("abortOnCrossing = true \uff1a\u5df2\u8df3\u8fc7\u4fdd\u5b58\u3002\u4fee\u597d\u6587\u4ef6\u518d\u8dd1\u4e00\u904d\u3002\n(crossing detected, save skipped)");
                return;
            }
        }
    }

    // Long snapped jobs must be manually reviewed. At this point Register dots,
    // Crease, artboard, cleanup, cut-line QC, piece count, and warnings have all
    // completed. Leave the prepared Illustrator file open and skip the save dialog.
    if (longSnapReview) {
        alert("\u26A0 LONG JOB + SNAP / \u957f\u56fe Snap \u68c0\u67e5\n\n"
            + "Height exceeds " + CFG.longSnapReviewHeight_in.toFixed(0) + "\" and Snap was applied.\n\n"
            + "Register dots were forced onto all four sides.\n"
            + "PDF save has been skipped.\n\n"
            + "Please review:\n"
            + "\u2022 Register dot placement\n"
            + "\u2022 Cutter orientation / panel direction\n"
            + "\u2022 Final artboard size\n"
            + "\u2022 Thru-cut and Kiss-cut lines\n\n"
            + "rectB height: " + (bH(rectB) / IN).toFixed(3) + "\"\n"
            + "Final artboard height: " + (bH(rectC) / IN).toFixed(3) + "\"\n"
            + "Snap: " + changedAxis);
        return;
    }

    // 10) Save as PDF via dialog (filename prefilled "(X sets) (NNNNNNNN).pdf").
    //     X comes from the layout script's session memory (app.__layoutByQty_sets).
    //     Pick a location + confirm = PDF is written there. Cancel = nothing saved.
    var sets = 1;
    try {
        var rawSets = app.__layoutByQty_sets;
        if (rawSets !== undefined && rawSets !== null && rawSets !== "") {
            var parsedSets = parseInt(rawSets, 10);
            if (!isNaN(parsedSets) && parsedSets >= 1) sets = parsedSets;
        }
    } catch (eSet) {}

    var rnd = "";
    for (var z = 0; z < 8; z++) rnd += Math.floor(Math.random() * 10).toString();
    var suggested = new File("(" + sets + " sets) (" + rnd + ").pdf");
    var chosen = suggested.saveDlg("Save PDF");
    if (chosen) {
        if (!/\.pdf$/i.test(chosen.fsName)) chosen = new File(chosen.fsName + ".pdf");
        var opt = new PDFSaveOptions();
        if (CFG.pdfPreset && CFG.pdfPreset.length) { try { opt.pDFPreset = CFG.pdfPreset; } catch (e3) {} }
        doc.saveAs(chosen, opt);
    }

})();
