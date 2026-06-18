/**********************************************************************
 * ThruCutGridToLines.jsx
 * ------------------------------------------------------------------
 * Adobe Illustrator (ExtendScript / JSX)
 *
 * 把"摆砖"网格(一堆矩形,File2 风格)转成单线切割网格(File1 风格)。
 * Convert a grid built from rectangles into single-stroke cut lines.
 *
 * WHAT IT DOES
 *   1. 只处理"当前选区"里的 axis-aligned 矩形(你先选中网格2)。
 *      Operates ONLY on axis-aligned rectangles in the current selection.
 *   2. 每条网格线只画一遍(共边去重)—— thru-cut 不再双割。
 *      Each grid line is drawn exactly ONCE (shared edges de-duplicated).
 *   3. 容差合并:相邻矩形之间 overlap/gap <= 容差时,视作完美贴合,
 *      在缝/叠的"平均位置"画一条线。默认容差 0.0625 in (4.5 pt)。
 *      Near-touching edges within the tolerance are snapped to ONE line
 *      placed at their AVERAGE coordinate (midpoint for a simple pair).
 *   4. 真缺格(差一整个 cell,远大于容差)照样断开,不穿空档。
 *      Real gaps (cell-sized, >> tolerance) stay open; lines never cross them.
 *   5. 新线用对比色(默认品红),纯肉眼核对用。
 *      New lines use a contrast color (default magenta) for eyeball QC.
 *   6. 跑前弹 confirm 报数,确认后才生成 + 删除源矩形。
 *      Confirm dialog before any destructive action.
 *
 * ALGORITHM
 *   每个矩形拆成 4 条边 -> 按"垂直坐标"做单链聚类(相邻边在容差内归一簇)
 *   -> 每簇落在成员坐标的均值上(就是缝/叠的中间)
 *   -> 簇内对一维区间做并集(容差内的小缝桥接,大缺口保留)。
 *   规则网格与不规则网格通吃。
 *
 *   NOTE: 假设真实网格线之间的间距 >> 合并容差(1/16" 级别的格子不现实)。
 *         若某簇被链得比容差还宽,confirm 会提示你重点核对。
 *
 * @author  Chao Dong feat. LLMs
 * @license MIT
 **********************************************************************/

#target illustrator

(function () {

    // ============================== CONFIG ==============================
    var CONFIG = {
        mergeToleranceInch:  0.0625,          // overlap/gap <= this between adjacent edges => one line at the average. Set ~0 for strict.
        contrastRGB:         [255, 0, 255],   // magenta, for RGB documents
        contrastCMYK:        [0, 100, 0, 0],  // magenta, for CMYK documents
        strokeWidthOverride: null,            // null = copy from source rects; or a number (pt)
        groupName:           "Thru-cut Grid (lines)",
        cornerEps:           0.01,            // pt: float-noise tolerance for the axis-aligned-rectangle test only
        deleteSource:        true,            // remove the source rectangles after building lines
        cleanEmptyGroups:    true             // remove parent groups left empty by the deletion
    };
    // ===================================================================

    var MERGE_TOL = CONFIG.mergeToleranceInch * 72.0;   // points

    if (app.documents.length === 0) { alert("Open a document first."); return; }
    var doc = app.documents[0];

    // Read & write in the same coordinate system so new lines land exactly on the old edges.
    try { app.coordinateSystem = CoordinateSystem.DOCUMENTCOORDINATESYSTEM; } catch (e) {}

    if (doc.selection === null || doc.selection.length === 0) {
        alert("Nothing selected.\n\u8bf7\u5148\u9009\u4e2d\u7f51\u683c2\uff08\u90a3\u5806\u77e9\u5f62\uff09\uff0c\u518d\u8dd1\u811a\u672c\u3002");
        return;
    }

    // ---- 1) Collect axis-aligned rectangles from the selection (recurse groups) ----
    var rects = [];
    collectRects(doc.selection, rects);

    if (rects.length === 0) {
        alert("No axis-aligned rectangles found in the selection.\n"
            + "\u9009\u533a\u91cc\u6ca1\u627e\u5230\u6b63\u77e9\u5f62\uff08\u53ef\u80fd\u9009\u5230\u4e86\u7ebf/\u6587\u5b57/\u65cb\u8f6c\u8fc7\u7684\u8def\u5f84\uff09\u3002");
        return;
    }

    // ---- 2) Explode every rect into 4 edges ----
    //   vEdges: vertical edges,  c = x (cluster axis), [lo,hi] on y
    //   hEdges: horizontal edges, c = y (cluster axis), [lo,hi] on x
    var vEdges = [], hEdges = [];
    var bbox = { l: Infinity, t: -Infinity, r: -Infinity, b: Infinity };

    for (var i = 0; i < rects.length; i++) {
        var R = rects[i];
        var L = R.left, Rt = R.right;
        var yLo = Math.min(R.top, R.bottom), yHi = Math.max(R.top, R.bottom);

        vEdges.push({ c: L,  lo: yLo, hi: yHi });
        vEdges.push({ c: Rt, lo: yLo, hi: yHi });
        hEdges.push({ c: R.top,    lo: L, hi: Rt });
        hEdges.push({ c: R.bottom, lo: L, hi: Rt });

        if (L   < bbox.l) bbox.l = L;
        if (Rt  > bbox.r) bbox.r = Rt;
        if (yHi > bbox.t) bbox.t = yHi;
        if (yLo < bbox.b) bbox.b = yLo;
    }

    // ---- 3) Cluster edges across the perpendicular axis + union along the line ----
    var Hres = buildLines(hEdges, MERGE_TOL);   // horizontal cut lines
    var Vres = buildLines(vEdges, MERGE_TOL);   // vertical cut lines
    var hLines = Hres.lines, vLines = Vres.lines;
    var maxChainSpan = Math.max(Hres.maxSpan, Vres.maxSpan);

    // ---- 4) Confirm before doing anything destructive ----
    var bw = Math.abs(bbox.r - bbox.l), bh = Math.abs(bbox.t - bbox.b);
    var msg = "Found " + rects.length + " rectangle(s) in selection.\n\n"
            + "Merge tolerance: " + CONFIG.mergeToleranceInch + " in (" + fmt(MERGE_TOL) + " pt)\n"
            + "  adjacent edges within this overlap/gap -> ONE line at their average.\n\n"
            + "Generate single-stroke cut lines:\n"
            + "   " + hLines.length + " horizontal  +  " + vLines.length + " vertical\n"
            + "(shared edges de-duplicated, real gaps preserved)\n";
    if (maxChainSpan > MERGE_TOL + 1e-6) {
        msg += "\nNote: a cluster chained wider than the tolerance (max span "
             + fmt(maxChainSpan) + " pt). Eyeball those lines afterward.\n";
    }
    if (CONFIG.deleteSource) {
        msg += "\nThen DELETE the " + rects.length + " source rectangle(s).\n";
    }
    msg += "\nBounding box: " + fmt(bw) + " x " + fmt(bh) + " pt\n\nProceed?";
    if (!confirm(msg)) return;

    // ---- 5) Create the lines ----
    var targetLayer = rects[0].src.layer;
    var color  = makeColor(doc);
    var sample = rects[0].src;
    var sw     = (CONFIG.strokeWidthOverride !== null) ? CONFIG.strokeWidthOverride : sample.strokeWidth;
    var cap    = sample.strokeCap;
    var join   = sample.strokeJoin;
    var miter  = sample.strokeMiterLimit;

    var grp = targetLayer.groupItems.add();
    grp.name = CONFIG.groupName;

    var made = 0;
    for (var h = 0; h < hLines.length; h++) {
        var H = hLines[h];
        makeLine(grp, H.a, H.coord, H.b, H.coord, color, sw, cap, join, miter, "cut-h");
        made++;
    }
    for (var v = 0; v < vLines.length; v++) {
        var V = vLines[v];
        makeLine(grp, V.coord, V.a, V.coord, V.b, color, sw, cap, join, miter, "cut-v");
        made++;
    }

    // ---- 6) Delete the source rectangles (and any group they emptied) ----
    var removed = 0;
    if (CONFIG.deleteSource) {
        var parents = [];
        for (var k = 0; k < rects.length; k++) {
            var p = rects[k].parent;
            if (p && !contains(parents, p)) parents.push(p);
            rects[k].src.remove();
            removed++;
        }
        if (CONFIG.cleanEmptyGroups) {
            for (var pj = 0; pj < parents.length; pj++) {
                try {
                    if (parents[pj].typename === "GroupItem" && parents[pj].pageItems.length === 0) {
                        parents[pj].remove();
                    }
                } catch (e) {}
            }
        }
    }

    alert("Done.\n\u751f\u6210 " + made + " \u6761\u5207\u5272\u7ebf\uff0c\u5220\u9664 " + removed + " \u4e2a\u6e90\u77e9\u5f62\u3002\n"
        + "Lines are in group: \"" + CONFIG.groupName + "\".");


    /* =========================== HELPERS =========================== */

    function collectRects(sel, out) {
        for (var i = 0; i < sel.length; i++) {
            var it = sel[i];
            if (it.typename === "GroupItem") {
                collectRects(it.pageItems, out);
            } else if (it.typename === "PathItem" && isAxisAlignedRect(it)) {
                var gb = it.geometricBounds; // [left, top, right, bottom]
                out.push({ src: it, parent: it.parent,
                           left: gb[0], top: gb[1], right: gb[2], bottom: gb[3] });
            }
        }
    }

    // 4 anchors, closed, exactly 2 distinct x and 2 distinct y => axis-aligned rect.
    function isAxisAlignedRect(item) {
        if (!item.closed) return false;
        var pts = item.pathPoints;
        if (pts.length !== 4) return false;
        var xs = {}, ys = {}, nx = 0, ny = 0;
        for (var i = 0; i < 4; i++) {
            var a = pts[i].anchor;
            var kx = keyOf(a[0]), ky = keyOf(a[1]);
            if (xs[kx] === undefined) { xs[kx] = 1; nx++; }
            if (ys[ky] === undefined) { ys[ky] = 1; ny++; }
        }
        return (nx === 2 && ny === 2);
    }

    // Single-linkage cluster on .c (within tol), place line at the cluster mean,
    // then union the along-axis [lo,hi] intervals (tol bridges slivers, real gaps stay).
    function buildLines(edges, tol) {
        var res = { lines: [], maxSpan: 0 };
        if (edges.length === 0) return res;
        edges.sort(function (e1, e2) { return e1.c - e2.c; });

        var i = 0;
        while (i < edges.length) {
            var j = i;
            var sum = edges[i].c, cnt = 1;
            var cmin = edges[i].c, cmax = edges[i].c;
            while (j + 1 < edges.length && (edges[j + 1].c - edges[j].c) <= tol) {
                j++;
                sum += edges[j].c; cnt++;
                if (edges[j].c < cmin) cmin = edges[j].c;
                if (edges[j].c > cmax) cmax = edges[j].c;
            }
            var rep = sum / cnt;                       // average -> the single cut line
            if ((cmax - cmin) > res.maxSpan) res.maxSpan = (cmax - cmin);

            var intervals = [];
            for (var k = i; k <= j; k++) intervals.push([edges[k].lo, edges[k].hi]);
            var merged = unionIntervals(intervals, tol);
            for (var m = 0; m < merged.length; m++) {
                res.lines.push({ coord: rep, a: merged[m][0], b: merged[m][1] });
            }
            i = j + 1;
        }
        return res;
    }

    function unionIntervals(intervals, tol) {
        if (intervals.length === 0) return [];
        intervals.sort(function (x, y) { return x[0] - y[0]; });
        var res = [];
        var cur = [intervals[0][0], intervals[0][1]];
        for (var i = 1; i < intervals.length; i++) {
            var nx = intervals[i];
            if (nx[0] <= cur[1] + tol) {            // overlap or sliver gap -> extend
                if (nx[1] > cur[1]) cur[1] = nx[1];
            } else {                                 // real gap -> new segment
                res.push(cur);
                cur = [nx[0], nx[1]];
            }
        }
        res.push(cur);
        return res;
    }

    function makeLine(container, x1, y1, x2, y2, color, w, cap, join, miter, name) {
        var p = container.pathItems.add();
        p.setEntirePath([[x1, y1], [x2, y2]]);
        p.closed = false;
        p.filled = false;
        p.stroked = true;
        p.strokeColor = color;
        p.strokeWidth = w;
        try { p.strokeCap = cap; } catch (e) {}
        try { p.strokeJoin = join; } catch (e) {}
        try { p.strokeMiterLimit = miter; } catch (e) {}
        p.name = name;
        return p;
    }

    function makeColor(doc) {
        if (doc.documentColorSpace === DocumentColorSpace.CMYK) {
            var c = new CMYKColor();
            c.cyan = CONFIG.contrastCMYK[0]; c.magenta = CONFIG.contrastCMYK[1];
            c.yellow = CONFIG.contrastCMYK[2]; c.black = CONFIG.contrastCMYK[3];
            return c;
        }
        var r = new RGBColor();
        r.red = CONFIG.contrastRGB[0]; r.green = CONFIG.contrastRGB[1]; r.blue = CONFIG.contrastRGB[2];
        return r;
    }

    function keyOf(v) { return String(Math.round(v / CONFIG.cornerEps)); }
    function fmt(v)   { return (Math.round(v * 100) / 100).toString(); }

    function contains(arr, obj) {
        for (var i = 0; i < arr.length; i++) { if (arr[i] === obj) return true; }
        return false;
    }

})();
