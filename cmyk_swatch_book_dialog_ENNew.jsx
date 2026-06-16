#target illustrator
/*
 * CMYK Similar-Color Swatch Book Generator
 * (Illustrator JSX / dialog / remembers settings / relative span / native DeviceCMYK)
 * ============================================================
 * On run, a panel pops up: enter base color, span, and count.
 * Span is entered as offsets RELATIVE to the base color.
 * Your last inputs are remembered and pre-filled next time
 * (stored in Illustrator preferences).
 * Swatches and labels are native CMYK, so values are preserved on PDF export.
 *
 * Span fields:  lower offset / upper offset / step
 *   e.g.  -5   +5   2   -> base +/- 5, step 2
 *         0    0    0   -> lock this channel (base value only)
 *
 * Usage: drop into the ScripshonTrees scripts folder -> click -> fill in -> Generate.
 *        Then export with your own PDF preset (use "Preserve Numbers / No Color Conversion").
 *
 * DEFAULTS below are used on first run or if reading prefs fails.
 */

var DEFAULTS = {
    base: [100, 60, 0, 6],     // base color C,M,Y,K (0-100)
    // per channel relative offsets [lower, upper, step]; 0,0,0 = locked
    C: [0,   0,   2],          // C locked by default
    M: [-10, 10,  2],
    Y: [-10, 10,  2],
    K: [-10, 10,  2],
    capOn: true,
    maxSwatches: 100,
    includeBase: true,
    sheetWidthIn: 48.0,
    swatchIn: 3.0,
    gapIn: 0.25,
    labelIn: 0.38,
    marginIn: 0.5,
    labelPt: 11,
    showBorder: false,
    exportPdf: false,
    pdfPreset: ""
};

var PT = 72.0;
var PREF_KEY = "cmykSwatchBook/config_v2";   // shared with the Chinese version

// ---------- memory (store/read Illustrator prefs) ----------
function saveCfg(c) {
    try {
        var p = [
            c.base[0], c.base[1], c.base[2], c.base[3],
            c.C[0], c.C[1], c.C[2], c.M[0], c.M[1], c.M[2],
            c.Y[0], c.Y[1], c.Y[2], c.K[0], c.K[1], c.K[2],
            c.capOn ? 1 : 0, c.maxSwatches, c.includeBase ? 1 : 0,
            c.sheetWidthIn, c.swatchIn, c.gapIn,
            c.showBorder ? 1 : 0, c.exportPdf ? 1 : 0,
            String(c.pdfPreset || "").replace(/\|/g, "/")
        ];
        app.preferences.setStringPreference(PREF_KEY, p.join("|"));
    } catch (e) {}
}
function loadCfg(def) {
    try {
        var s = app.preferences.getStringPreference(PREF_KEY);
        if (!s || s.length === 0) return def;
        var p = s.split("|");
        if (p.length < 25) return def;
        function f(i) { var v = parseFloat(p[i]); return isNaN(v) ? 0 : v; }
        return {
            base: [f(0), f(1), f(2), f(3)],
            C: [f(4), f(5), f(6)], M: [f(7), f(8), f(9)],
            Y: [f(10), f(11), f(12)], K: [f(13), f(14), f(15)],
            capOn: p[16] == "1", maxSwatches: f(17), includeBase: p[18] == "1",
            sheetWidthIn: f(19), swatchIn: f(20), gapIn: f(21),
            showBorder: p[22] == "1", exportPdf: p[23] == "1",
            pdfPreset: p[24] || "",
            labelIn: def.labelIn, marginIn: def.marginIn, labelPt: def.labelPt
        };
    } catch (e) { return def; }
}

// ---------- color / generation ----------
function cmyk(c, m, y, k) {
    var col = new CMYKColor();
    col.cyan = c; col.magenta = m; col.yellow = y; col.black = k;
    return col;
}
function channelValues(rng) {
    var lo = rng[0], hi = rng[1], step = rng[2];
    if (lo > hi) { var t = lo; lo = hi; hi = t; }
    lo = Math.max(0, Math.min(100, lo));
    hi = Math.max(0, Math.min(100, hi));
    var raw = [];
    if (step <= 0 || lo == hi) { raw.push(Math.round(lo)); }
    else {
        var v = lo;
        while (v <= hi + 1e-9) { raw.push(Math.round(v)); v += step; }
        if (raw[raw.length - 1] != Math.round(hi)) raw.push(Math.round(hi));
    }
    var seen = {}, res = [];
    for (var i = 0; i < raw.length; i++) {
        var x = Math.max(0, Math.min(100, raw[i]));
        if (!seen[x]) { seen[x] = true; res.push(x); }
    }
    res.sort(function (a, b) { return a - b; });
    return res;
}
// relative offset -> absolute range
function toAbs(base, rel) { return [base + rel[0], base + rel[1], rel[2]]; }

function colorsFromCfg(cfg) {
    var cs = channelValues(toAbs(cfg.base[0], cfg.C)),
        ms = channelValues(toAbs(cfg.base[1], cfg.M)),
        ys = channelValues(toAbs(cfg.base[2], cfg.Y)),
        ks = channelValues(toAbs(cfg.base[3], cfg.K));
    var colors = [], seen = {};
    function add(c, m, y, k) {
        var key = c + "," + m + "," + y + "," + k;
        if (!seen[key]) { seen[key] = true; colors.push([c, m, y, k]); }
    }
    if (cfg.includeBase) add(cfg.base[0], cfg.base[1], cfg.base[2], cfg.base[3]);
    for (var a = 0; a < cs.length; a++)
      for (var b = 0; b < ms.length; b++)
        for (var d = 0; d < ys.length; d++)
          for (var e = 0; e < ks.length; e++)
            add(cs[a], ms[b], ys[d], ks[e]);
    if (cfg.capOn && colors.length > cfg.maxSwatches)
        colors = colors.slice(0, Math.max(1, Math.round(cfg.maxSwatches)));
    return colors;
}

// ---------- dialog ----------
function showDialog(d) {
    var w = new Window("dialog", "CMYK Swatch Book Generator");
    w.alignChildren = ["fill", "top"];

    function intField(parent, label, val, chars) {
        var g = parent.add("group");
        if (label !== null) { var s = g.add("statictext", undefined, label); s.preferredSize.width = 16; }
        var e = g.add("edittext", undefined, String(val));
        e.characters = chars || 4;
        return e;
    }

    // base color
    var pB = w.add("panel", undefined, "Base Color (BASE) - remembers last run");
    pB.orientation = "row"; pB.alignChildren = "left";
    var bC = intField(pB, "C", d.base[0]), bM = intField(pB, "M", d.base[1]),
        bY = intField(pB, "Y", d.base[2]), bK = intField(pB, "K", d.base[3]);

    // span (relative offsets)
    var pS = w.add("panel", undefined, "Color Span  (relative to base: lower / upper / step)");
    pS.orientation = "column"; pS.alignChildren = "left";
    var hint = pS.add("statictext", undefined, "e.g.  -5  +5  2  -> base +/- 5 ;   0  0  0  -> lock");
    hint.characters = 44;
    function spanRow(name, arr) {
        var g = pS.add("group");
        var s = g.add("statictext", undefined, name); s.preferredSize.width = 18;
        var mn = g.add("edittext", undefined, String(arr[0])); mn.characters = 4;
        var mx = g.add("edittext", undefined, String(arr[1])); mx.characters = 4;
        var st = g.add("edittext", undefined, String(arr[2])); st.characters = 4;
        return [mn, mx, st];
    }
    var rC = spanRow("C", d.C), rM = spanRow("M", d.M),
        rY = spanRow("Y", d.Y), rK = spanRow("K", d.K);

    // count / options
    var pO = w.add("panel", undefined, "Count / Options");
    pO.orientation = "column"; pO.alignChildren = "left";
    var gCnt = pO.add("group");
    var capChk = gCnt.add("checkbox", undefined, "Max count"); capChk.value = d.capOn;
    var capVal = gCnt.add("edittext", undefined, String(d.maxSwatches)); capVal.characters = 5;
    var baseChk = pO.add("checkbox", undefined, "Include base color (BASE) as first swatch"); baseChk.value = d.includeBase;
    var info = pO.add("statictext", undefined, "Combinations: -"); info.characters = 44;

    // layout
    var pL = w.add("panel", undefined, "Layout (inches)");
    pL.orientation = "row"; pL.alignChildren = "left";
    var fW = intField(pL, "Width", d.sheetWidthIn, 5),
        fSw = intField(pL, "Swatch", d.swatchIn, 4),
        fGap = intField(pL, "Gap", d.gapIn, 4);
    var brdChk = pL.add("checkbox", undefined, "Border"); brdChk.value = d.showBorder;

    // export
    var pE = w.add("panel", undefined, "Export (optional)");
    pE.orientation = "row"; pE.alignChildren = "left";
    var expChk = pE.add("checkbox", undefined, "Export PDF to Desktop after generating"); expChk.value = d.exportPdf;
    pE.add("statictext", undefined, "Preset:");
    var presetTxt = pE.add("edittext", undefined, d.pdfPreset); presetTxt.characters = 18;

    function readCfg() {
        function num(e, def) { var v = parseFloat(e.text); return isNaN(v) ? def : v; }
        return {
            base: [num(bC, 0), num(bM, 0), num(bY, 0), num(bK, 0)],
            C: [num(rC[0], 0), num(rC[1], 0), num(rC[2], 2)],
            M: [num(rM[0], 0), num(rM[1], 0), num(rM[2], 2)],
            Y: [num(rY[0], 0), num(rY[1], 0), num(rY[2], 2)],
            K: [num(rK[0], 0), num(rK[1], 0), num(rK[2], 2)],
            capOn: capChk.value, maxSwatches: Math.max(1, Math.round(num(capVal, 100))),
            includeBase: baseChk.value,
            sheetWidthIn: num(fW, 48), swatchIn: num(fSw, 3), gapIn: num(fGap, 0.25),
            labelIn: d.labelIn, marginIn: d.marginIn, labelPt: d.labelPt,
            showBorder: brdChk.value,
            exportPdf: expChk.value, pdfPreset: presetTxt.text
        };
    }
    function refresh() {
        try {
            var c = readCfg();
            var total = colorsFromCfg({ base: c.base, C: c.C, M: c.M, Y: c.Y, K: c.K,
                                        includeBase: c.includeBase, capOn: false, maxSwatches: 0 }).length;
            var shown = (c.capOn && total > c.maxSwatches) ? c.maxSwatches : total;
            info.text = "Combinations: " + total + "   ->  will generate: " + shown;
        } catch (e) { info.text = "Combinations: invalid input"; }
    }
    var all = [bC, bM, bY, bK, capVal, fW, fSw, fGap,
               rC[0], rC[1], rC[2], rM[0], rM[1], rM[2], rY[0], rY[1], rY[2], rK[0], rK[1], rK[2]];
    for (var i = 0; i < all.length; i++) all[i].onChange = refresh;
    capChk.onClick = refresh; baseChk.onClick = refresh;
    refresh();

    // buttons
    var pBtn = w.add("group"); pBtn.alignment = "right";
    var cancelB = pBtn.add("button", undefined, "Cancel", { name: "cancel" });
    var okB = pBtn.add("button", undefined, "Generate", { name: "ok" });

    var result = null;
    okB.onClick = function () {
        var c = readCfg();
        for (var j = 0; j < 4; j++) {
            if (isNaN(c.base[j]) || c.base[j] < 0 || c.base[j] > 100) { alert("Base color values must be 0-100."); return; }
        }
        var spans = [c.C, c.M, c.Y, c.K];
        for (var k = 0; k < spans.length; k++) {
            if (spans[k][2] < 0) { alert("Step cannot be negative."); return; }
        }
        if (c.sheetWidthIn <= 0 || c.swatchIn <= 0) { alert("Width and swatch size must be greater than 0."); return; }
        result = c;
        w.close(1);
    };
    cancelB.onClick = function () { w.close(0); };

    return (w.show() === 1) ? result : null;
}

// ---------- build document ----------
function generate(cfg) {
    var colors = colorsFromCfg(cfg);
    var n = colors.length;
    if (n === 0) { alert("No swatches generated."); return; }

    var sw = cfg.swatchIn * PT, gap = cfg.gapIn * PT,
        lab = cfg.labelIn * PT, marg = cfg.marginIn * PT;
    var cellW = sw + gap, cellH = sw + lab + gap;
    var pageW = cfg.sheetWidthIn * PT;
    var usableW = pageW - 2 * marg;
    var cols = Math.max(1, Math.floor((usableW + gap) / cellW));
    var rows = Math.ceil(n / cols);
    var pageH = 2 * marg + rows * cellH - gap;

    if (pageW > 16383 || pageH > 16383) {
        alert("Page " + (pageW / PT).toFixed(1) + "\" x " + (pageH / PT).toFixed(1) +
              "\" exceeds Illustrator's artboard limit (~227\"). Reduce count or widen the page.");
        return;
    }
    app.preferences.setIntegerPreference("rulerType", 0);   // 0 = 英寸
    var doc = app.documents.add(DocumentColorSpace.CMYK, pageW, pageH);
    var ab = doc.artboards[0].artboardRect;
    var abLeft = ab[0], abTop = ab[1];
    var black = cmyk(0, 0, 0, 100);

    for (var i = 0; i < n; i++) {
        var col = i % cols, row = Math.floor(i / cols);
        var leftX = abLeft + marg + col * cellW;
        var topY = abTop - marg - row * cellH;
        var c = colors[i];

        var rect = doc.pathItems.rectangle(topY, leftX, sw, sw);
        rect.filled = true;
        rect.fillColor = cmyk(c[0], c[1], c[2], c[3]);
        rect.stroked = cfg.showBorder;
        if (cfg.showBorder) { rect.strokeColor = cmyk(0, 0, 0, 30); rect.strokeWidth = 0.5; }

        var label = "C" + c[0] + " M" + c[1] + " Y" + c[2] + " K" + c[3];
        if (cfg.includeBase && i === 0) label += " (BASE)";
        var bottomY = topY - sw;
        var tf = doc.textFrames.pointText([leftX + sw / 2, bottomY - cfg.labelPt - 2]);
        tf.contents = label;
        var ca = tf.textRange.characterAttributes;
        ca.size = cfg.labelPt; ca.fillColor = black;
        tf.textRange.paragraphAttributes.justification = Justification.CENTER;
    }

    if (cfg.exportPdf) {
        var f = new File(Folder.desktop + "/cmyk_swatch_book.pdf");
        var opt = new PDFSaveOptions();
        if (cfg.pdfPreset !== "") opt.pDFPreset = cfg.pdfPreset;
        doc.saveAs(f, opt);
    }

    // set document ruler units to inches for review / output
    doc.rulerUnits = RulerUnits.Inches;

    app.redraw();
}

// ---------- entry ----------
var seed = loadCfg(DEFAULTS);
var cfg = showDialog(seed);
if (cfg) { saveCfg(cfg); generate(cfg); }
