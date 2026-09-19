#target illustrator
/*
 * PanelSplit_KissCut.jsx   v1.3
 * ---------------------------------------------------------------------------
 * 把【当前选中的单个 fill 形状】沿横向(竖直切线)拆成多片 panel。
 * 每片 = 原形状 ∩ 该片矩形(含 overlap)，用 Live Pathfinder Intersect 实现，
 * 断点交给 Pathfinder 自动算，脚本不求交点。
 *
 *   输出：fill 实心块，原位叠放，每片单独一个图层。
 *   原形状不动，另存一份带时间戳的锁定备份图层。
 *
 * v1.1 新增：拆完顺带生成导出 artboard + 边界框。
 * v1.3 新增：可逐 panel 单独导出 PDF。
 *   - 导出时只显示当前 panel 的 kiss-cut / Frames X 对应矩形 / Register 图层(若存在)
 *   - 可临时隐藏原始完整 shape
 *   - PDF 默认不 preserve Illustrator editing capabilities
 *   - 每片导出为单独 PDF（一页一个文件）
 *
 * 作者：Chao Dong feat. LLMs  /  MIT      兼容 ScripshonTrees 启动器。
 * ---------------------------------------------------------------------------
 */

(function () {

    // ===================== CONFIG =====================
    var CFG = {
        name        : "PanelSplit_KissCut",
        version     : "1.3",
        prefPrefix  : "panelSplitKC_",
        layerPrefix : "Panel ",
        backupPrefix: "BACKUP_orig ",
        framesLayer : "Frames X",
        registerLayer: "Register",
        edgeMargin  : 0.5,      // 切割矩形上下各外扩 inch
        grow        : 0.125,    // artboard 边界框四边各外扩 inch
        strokeW     : 0.5,      // 边界框描边宽 pt
        kissStrokeW : 0.5,      // 导出时 Panel/Kiss-cut 描边宽 pt
        eps         : 0.001,
        defaults    : {
            matW: 52,
            overlap: 0.5,
            mode: "greedy",
            count: "",
            doAb: true,
            doPdf: false,
            hideSrcOnExport: true,
            noEditPdf: true
        }
    };

    function fail(msg) { alert(CFG.name + "  v" + CFG.version + "\n\n" + msg); }
    function ts() {
        var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; };
        return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
             + "_" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }
    function baseName(name) { return name.replace(/\.[^\.]+$/, ""); }
    function pad2(n) { return (n < 10 ? "0" : "") + n; }
    function trim(s) { return String(s).replace(/^\s+|\s+$/g, ""); }
    function sanitizeFileName(s) { return String(s).replace(/[\\\/:*?"<>|]/g, "_"); }
    function parsePanelNumber(name) {
        var m = String(name).match(/^Panel\s+(\d+)\b/);
        return m ? parseInt(m[1], 10) : null;
    }

    function getLayerByName(name) {
        for (var i = 0; i < doc.layers.length; i++) {
            if (doc.layers[i].name === name) return doc.layers[i];
        }
        return null;
    }

    function chooseOutputFolder() {
        var folder = null;
        try {
            if (doc.saved && doc.path) {
                folder = new Folder(doc.path.fsName + "/" + baseName(doc.name) + "_PanelPDF_" + ts());
            } else {
                var picked = Folder.selectDialog("请选择 Panel PDF 导出文件夹");
                if (!picked) return null;
                folder = new Folder(picked.fsName + "/" + baseName(doc.name) + "_PanelPDF_" + ts());
            }
            if (!folder.exists) folder.create();
        } catch (e) {
            folder = Folder.selectDialog("请选择 Panel PDF 导出文件夹");
            if (!folder) return null;
        }
        return folder;
    }

    function captureExportState(srcObj, panelObjs, frameObjs, frameLayerObj, registerLayerObj) {
        var st = {
            srcHidden: false,
            srcLayerVisible: true,
            frameLayerVisible: true,
            registerLayerVisible: null,
            panels: [],
            frames: []
        };

        try { st.srcHidden = srcObj.hidden; } catch (e1) {}
        try { st.srcLayerVisible = srcObj.layer.visible; } catch (e2) {}
        try { if (frameLayerObj) st.frameLayerVisible = frameLayerObj.visible; } catch (e3) {}
        try { if (registerLayerObj) st.registerLayerVisible = registerLayerObj.visible; } catch (e4) {}

        for (var i = 0; i < panelObjs.length; i++) {
            st.panels.push({ layer: panelObjs[i].layer, visible: panelObjs[i].layer.visible });
        }
        for (var j = 0; j < frameObjs.length; j++) {
            st.frames.push({ item: frameObjs[j].rect, hidden: frameObjs[j].rect.hidden });
        }
        return st;
    }

    function restoreExportState(st, frameLayerObj, registerLayerObj, srcObj) {
        var i;
        try { srcObj.hidden = st.srcHidden; } catch (e1) {}
        try { srcObj.layer.visible = st.srcLayerVisible; } catch (e2) {}
        try { if (frameLayerObj) frameLayerObj.visible = st.frameLayerVisible; } catch (e3) {}
        try { if (registerLayerObj !== null && registerLayerObj) registerLayerObj.visible = st.registerLayerVisible; } catch (e4) {}

        for (i = 0; i < st.panels.length; i++) {
            try { st.panels[i].layer.visible = st.panels[i].visible; } catch (e5) {}
        }
        for (i = 0; i < st.frames.length; i++) {
            try { st.frames[i].item.hidden = st.frames[i].hidden; } catch (e6) {}
        }
    }

    function kissCutColor() {
        var cc = new CMYKColor();
        cc.cyan = 0;
        cc.magenta = 99;
        cc.yellow = 0;
        cc.black = 0;
        return cc;
    }

    function collectPathItems(obj, arr) {
        if (!obj) return arr;
        try {
            if (obj.typename === "PathItem") {
                arr.push(obj);
                return arr;
            }
            if (obj.typename === "CompoundPathItem") {
                for (var c = 0; c < obj.pathItems.length; c++) {
                    collectPathItems(obj.pathItems[c], arr);
                }
                return arr;
            }
            if (obj.typename === "GroupItem" || obj.typename === "Layer") {
                for (var p = 0; p < obj.pageItems.length; p++) {
                    collectPathItems(obj.pageItems[p], arr);
                }
                return arr;
            }
        } catch (e1) {}

        // 兜底：有些 AI 对象 typename/collection 行为比较怪，尽量多抓一层
        try {
            if (obj.pathItems) {
                for (var i = 0; i < obj.pathItems.length; i++) {
                    collectPathItems(obj.pathItems[i], arr);
                }
            }
        } catch (e2) {}
        try {
            if (obj.compoundPathItems) {
                for (var j = 0; j < obj.compoundPathItems.length; j++) {
                    collectPathItems(obj.compoundPathItems[j], arr);
                }
            }
        } catch (e3) {}
        try {
            if (obj.groupItems) {
                for (var g = 0; g < obj.groupItems.length; g++) {
                    collectPathItems(obj.groupItems[g], arr);
                }
            }
        } catch (e4) {}
        return arr;
    }

    function applyExportKissCutStyle(panelObj) {
        var paths = [];
        collectPathItems(panelObj.piece, paths);

        var st = [];
        var col = kissCutColor();
        for (var i = 0; i < paths.length; i++) {
            var it = paths[i];
            try {
                st.push({
                    item: it,
                    filled: it.filled,
                    fillColor: it.fillColor,
                    stroked: it.stroked,
                    strokeColor: it.strokeColor,
                    strokeWidth: it.strokeWidth
                });

                it.filled = false;
                it.stroked = true;
                it.strokeColor = col;
                it.strokeWidth = CFG.kissStrokeW;
            } catch (e) {}
        }
        return st;
    }

    function restoreExportKissCutStyle(st) {
        if (!st) return;
        for (var i = 0; i < st.length; i++) {
            var s = st[i], it = s.item;
            try {
                it.filled = s.filled;
                if (s.filled && s.fillColor) it.fillColor = s.fillColor;
                it.stroked = s.stroked;
                if (s.strokeColor) it.strokeColor = s.strokeColor;
                if (s.strokeWidth !== undefined) it.strokeWidth = s.strokeWidth;
            } catch (e) {}
        }
    }

    function exportPanelPDFs(opts, madePanels, frameObjs, totalPanels) {
        if (!opts.doPdf) return { count: 0, folder: null, files: [] };
        if (!madePanels || madePanels.length === 0) return { count: 0, folder: null, files: [] };

        var outFolder = chooseOutputFolder();
        if (!outFolder) {
            throw new Error("未选择导出文件夹，已取消 PDF 导出。");
        }

        var frameLayer = getLayerByName(CFG.framesLayer);
        var registerLayer = getLayerByName(CFG.registerLayer);

        var panelMap = {};
        var frameMap = {};
        var i, ab, abName, num, currentPanel, currentFrame;
        for (i = 0; i < madePanels.length; i++) panelMap[madePanels[i].n] = madePanels[i];
        for (i = 0; i < frameObjs.length; i++) frameMap[frameObjs[i].n] = frameObjs[i];

        var state = captureExportState(src, madePanels, frameObjs, frameLayer, registerLayer);
        var exported = [];

        try {
            if (opts.hideSrcOnExport) {
                try { src.hidden = true; } catch (e1) {}
                try { src.layer.visible = true; } catch (e2) {}
                try { src.layer.zOrder(ZOrderMethod.SENDTOBACK); } catch (e3) {}
            }

            if (frameLayer) frameLayer.visible = true;

            for (i = 0; i < doc.artboards.length; i++) {
                ab = doc.artboards[i];
                abName = ab.name;
                num = parsePanelNumber(abName);
                if (num === null) continue;

                currentPanel = panelMap[num];
                currentFrame = frameMap[num];
                if (!currentPanel || !currentFrame) continue;

                // 先全隐藏 panel / frames
                for (var p = 0; p < madePanels.length; p++) {
                    madePanels[p].layer.visible = false;
                }
                for (var f = 0; f < frameObjs.length; f++) {
                    frameObjs[f].rect.hidden = true;
                }

                // 当前片显示
                currentPanel.layer.visible = true;
                currentFrame.rect.hidden = false;
                if (registerLayer) registerLayer.visible = true;

                // 导出瞬间：当前 Panel fill -> none，stroke -> Kiss-cut magenta
                var kissStyleState = [];
                try {
                    kissStyleState = applyExportKissCutStyle(currentPanel);

                    // 激活 artboard
                    try { doc.artboards.setActiveArtboardIndex(i); } catch (e4) {}
                    app.redraw();

                    var pdfFile = new File(outFolder.fsName + "/"
                        + sanitizeFileName(baseName(doc.name) + "_Panel_" + pad2(num) + "_of_" + totalPanels)
                        + ".pdf");

                    var pdfOpts = new PDFSaveOptions();
                    try { pdfOpts.preserveEditability = !opts.noEditPdf ? true : false; } catch (e5) {}
                    try { pdfOpts.viewAfterSaving = false; } catch (e6) {}
                    try { pdfOpts.generateThumbnails = false; } catch (e7) {}
                    try { pdfOpts.optimization = true; } catch (e8) {}
                    try { pdfOpts.artboardRange = String(i + 1); } catch (e9) {}
                    try { pdfOpts.saveMultipleArtboards = true; } catch (e10) {}

                    doc.saveAs(pdfFile, pdfOpts);
                    exported.push(pdfFile);
                } finally {
                    restoreExportKissCutStyle(kissStyleState);
                }
            }
        } finally {
            restoreExportState(state, frameLayer, registerLayer, src);
            app.redraw();
        }

        return { count: exported.length, folder: outFolder, files: exported };
    }

    // ===================== 0. 校验(front-load abort) =====================
    if (app.documents.length === 0) { fail("先打开一个文档。"); return; }
    var doc = app.activeDocument;

    var sel = doc.selection;
    if (!sel || sel.length !== 1) {
        fail("请只选中 1 个对象——你要拆的那个 fill 形状。\n现在选中了：" + (sel ? sel.length : 0) + " 个。");
        return;
    }
    var src = sel[0], tn = src.typename;
    if (tn !== "PathItem" && tn !== "CompoundPathItem" && tn !== "GroupItem") {
        fail("选中的得是 path / compound path / group。\n现在是：" + tn); return;
    }
    if (tn === "GroupItem") {
        if (!confirm("选中的是 group。Intersect 对 group 行为不一定稳，"
            + "建议先 Pathfinder Unite 成单一 compound path 再跑。\n\n仍要继续吗？")) return;
    }
    try {
        if ((tn === "PathItem" && src.stroked) ||
            (tn === "CompoundPathItem" && src.pathItems.length && src.pathItems[0].stroked)) {
            if (!confirm("这个形状好像还有 stroke。本脚本默认你已清成 fill-only。\n\n仍要继续吗？")) return;
        }
    } catch (e) {}

    // ===================== 1. scaleFactor + bounds =====================
    var sf = doc.scaleFactor ? doc.scaleFactor : 1;
    function in2pt(inch) { return inch * 72 / sf; }
    function pt2in(pt)   { return pt * sf / 72; }

    var gb = src.geometricBounds;
    var L = gb[0], T = gb[1], R = gb[2], B = gb[3];
    var W = R - L, H = T - B;

    // ===================== 2. 对话框(参数记忆) =====================
    function loadPrefs() {
        var p = {
            matW: CFG.defaults.matW,
            overlap: CFG.defaults.overlap,
            mode: CFG.defaults.mode,
            count: CFG.defaults.count,
            doAb: CFG.defaults.doAb,
            doPdf: CFG.defaults.doPdf,
            hideSrcOnExport: CFG.defaults.hideSrcOnExport,
            noEditPdf: CFG.defaults.noEditPdf
        };
        try {
            if (app.preferences.getStringPreference(CFG.prefPrefix + "saved") === "1") {
                var mw = app.preferences.getRealPreference(CFG.prefPrefix + "matW");
                var ov = app.preferences.getRealPreference(CFG.prefPrefix + "overlap");
                var md = app.preferences.getStringPreference(CFG.prefPrefix + "mode");
                var ct = app.preferences.getStringPreference(CFG.prefPrefix + "count");
                p.doAb = app.preferences.getBooleanPreference(CFG.prefPrefix + "doAb");
                try { p.doPdf = app.preferences.getBooleanPreference(CFG.prefPrefix + "doPdf"); } catch (e1) {}
                try { p.hideSrcOnExport = app.preferences.getBooleanPreference(CFG.prefPrefix + "hideSrcOnExport"); } catch (e2) {}
                try { p.noEditPdf = app.preferences.getBooleanPreference(CFG.prefPrefix + "noEditPdf"); } catch (e3) {}
                if (mw > 0) p.matW = mw;
                if (ov >= 0) p.overlap = ov;
                if (md === "greedy" || md === "equal") p.mode = md;
                p.count = ct || "";
            }
        } catch (e) {}
        return p;
    }
    function savePrefs(o) {
        try {
            app.preferences.setRealPreference(CFG.prefPrefix + "matW", o.matW);
            app.preferences.setRealPreference(CFG.prefPrefix + "overlap", o.overlap);
            app.preferences.setStringPreference(CFG.prefPrefix + "mode", o.mode);
            app.preferences.setStringPreference(CFG.prefPrefix + "count", o.count);
            app.preferences.setBooleanPreference(CFG.prefPrefix + "doAb", o.doAb);
            app.preferences.setBooleanPreference(CFG.prefPrefix + "doPdf", o.doPdf);
            app.preferences.setBooleanPreference(CFG.prefPrefix + "hideSrcOnExport", o.hideSrcOnExport);
            app.preferences.setBooleanPreference(CFG.prefPrefix + "noEditPdf", o.noEditPdf);
            app.preferences.setStringPreference(CFG.prefPrefix + "saved", "1");
        } catch (e) {}
    }

    function showDialog(pre) {
        var out = null;
        var d = new Window("dialog", CFG.name + "  v" + CFG.version);
        d.alignChildren = "fill"; d.margins = 16; d.spacing = 10;

        d.add("statictext", undefined,
            "选中形状：" + pt2in(W).toFixed(2) + "\" 宽 × " + pt2in(H).toFixed(2) + "\" 高"
            + (sf !== 1 ? "   (Large Canvas sf=" + sf + ")" : ""));

        function row(label, val) {
            var g = d.add("group"); g.alignment = "left";
            var s = g.add("statictext", undefined, label); s.preferredSize.width = 180;
            var e = g.add("edittext", undefined, String(val)); e.characters = 8;
            return e;
        }
        var eW  = row("单片可用宽 (inch)：", pre.matW);
        var eOv = row("overlap 重叠 (inch)：", pre.overlap);

        var pM = d.add("panel", undefined, "拆分方式"); pM.alignChildren = "left"; pM.margins = 14;
        var rbG = pM.add("radiobutton", undefined, "省料拆（每片塞满，最后一片捡剩料）");
        var rbE = pM.add("radiobutton", undefined, "等分拆（所有片同宽均分）");
        rbG.value = (pre.mode !== "equal");
        rbE.value = (pre.mode === "equal");

        var eC = row("等分片数（留空=按料宽自动）：", pre.count);

        var cbAb = d.add("checkbox", undefined, "拆完顺带生成导出 artboard + 边界框");
        cbAb.value = (pre.doAb !== false);

        var pEx = d.add("panel", undefined, "导出"); pEx.alignChildren = "left"; pEx.margins = 14;
        var cbPdf = pEx.add("checkbox", undefined, "拆完逐 panel 单独导出 PDF（一页一个文件）");
        cbPdf.value = (pre.doPdf === true);
        var cbHideSrc = pEx.add("checkbox", undefined, "导出时临时隐藏原始完整 shape，并把其所在图层送到底层");
        cbHideSrc.value = (pre.hideSrcOnExport !== false);
        var cbNoEdit = pEx.add("checkbox", undefined, "PDF 不保留 Illustrator 编辑能力（preserveEditability = false）");
        cbNoEdit.value = (pre.noEditPdf !== false);

        var gB = d.add("group"); gB.alignment = "right"; gB.spacing = 8;
        var bC = gB.add("button", undefined, "取消", { name: "cancel" });
        var bO = gB.add("button", undefined, "拆！",   { name: "ok" });

        cbPdf.onClick = function () {
            if (cbPdf.value) cbAb.value = true;
        };

        bO.onClick = function () {
            var mw = parseFloat(eW.text), ov = parseFloat(eOv.text);
            if (isNaN(mw) || mw <= 0) { alert("单片可用宽要是正数。"); return; }
            if (isNaN(ov) || ov < 0)  { alert("overlap 不能是负数。"); return; }
            if (ov >= mw)             { alert("overlap 不能 ≥ 单片宽，不然没法往前推。"); return; }
            var mode = rbE.value ? "equal" : "greedy", cnt = "";
            if (mode === "equal") {
                var raw = trim(eC.text);
                if (raw !== "") {
                    var n = parseInt(raw, 10);
                    if (isNaN(n) || n < 1) { alert("片数要么留空，要么填 ≥1 的整数。"); return; }
                    cnt = String(n);
                }
            }
            out = {
                matW: mw,
                overlap: ov,
                mode: mode,
                count: cnt,
                doAb: cbPdf.value ? true : cbAb.value,
                doPdf: cbPdf.value,
                hideSrcOnExport: cbHideSrc.value,
                noEditPdf: cbNoEdit.value
            };
            d.close();
        };
        bC.onClick = function () { d.close(); };

        d.show();
        return out;
    }

    var prm = showDialog(loadPrefs());
    if (!prm) return;
    savePrefs(prm);

    // ===================== 3. 算每片 [x0, x1]（相对 L，reported pt） =====================
    var mwPt = in2pt(prm.matW), ovPt = in2pt(prm.overlap), cuts = [];
    if (W <= mwPt + CFG.eps) {
        cuts.push([0, W]);
    } else if (prm.mode === "greedy") {
        var step = mwPt - ovPt;
        for (var x = 0; ; x += step) {
            if (x + mwPt >= W - CFG.eps) { cuts.push([x, W]); break; }
            cuts.push([x, x + mwPt]);
        }
    } else {
        var n = (prm.count !== "") ? parseInt(prm.count, 10) : Math.ceil((W - ovPt) / (mwPt - ovPt));
        if (n < 1) n = 1;
        var pw = (W + (n - 1) * ovPt) / n;
        if (pw > mwPt + CFG.eps) {
            if (!confirm("等分成 " + n + " 片，每片要 " + pt2in(pw).toFixed(2)
                + "\" 宽，超过料宽 " + prm.matW + "\"。\n\n仍要继续吗？")) return;
        }
        var st = pw - ovPt;
        for (var i = 0; i < n; i++) cuts.push([i * st, i * st + pw]);
    }
    if (cuts.length === 0) { fail("没算出任何片，检查参数。"); return; }
    var total = cuts.length;

    // ===================== 4. 备份原形状 =====================
    var bakLayer = doc.layers.add();
    bakLayer.name = CFG.backupPrefix + ts();
    try { src.duplicate(bakLayer, ElementPlacement.PLACEATEND); } catch (e) {}
    bakLayer.visible = false; bakLayer.locked = true;

    // ===================== 5. 逐片 intersect =====================
    function makeWindow(layer, x0, x1) {
        var m = in2pt(CFG.edgeMargin);
        return layer.pathItems.rectangle(T + m, L + x0, (x1 - x0), H + 2 * m);
    }

    var made = [], empties = [], widths = [];
    for (var k = 0; k < cuts.length; k++) {
        var x0 = cuts[k][0], x1 = cuts[k][1];
        widths.push(pt2in(x1 - x0));
        var pl = doc.layers.add();
        pl.name = CFG.layerPrefix + (k + 1) + " / " + total;
        try {
            doc.selection = null;
            var dup  = src.duplicate(pl, ElementPlacement.PLACEATEND);
            var rect = makeWindow(pl, x0, x1);
            doc.selection = null;
            dup.selected = true; rect.selected = true;
            app.executeMenuCommand("group");
            app.executeMenuCommand("Live Pathfinder Intersect");
            app.executeMenuCommand("expandStyle");
            app.redraw();
            var piece = doc.selection[0];
            if (!piece || (piece.pageItems && piece.pageItems.length === 0)) {
                empties.push(k + 1); try { pl.remove(); } catch (e2) {} continue;
            }
            piece.name = CFG.layerPrefix + (k + 1);
            made.push({ n: k + 1, piece: piece, layer: pl });
        } catch (errPiece) {
            empties.push(k + 1); try { pl.remove(); } catch (e3) {}
        }
    }

    // ===================== 6. 边界框 + artboard(可选) =====================
    var abCount = 0;
    var frames = [];
    if (prm.doAb && made.length > 0) {

        // --- 6A. 生成矩形组 X(每片 bbox 四边外扩 grow) ---
        function strokeColor() {
            if (doc.documentColorSpace === DocumentColorSpace.RGB) {
                var rc = new RGBColor(); rc.red = 255; rc.green = 255; rc.blue = 255; return rc;
            }
            var cc = new CMYKColor(); cc.cyan = 99; cc.magenta = 0; cc.yellow = 0; cc.black = 0; return cc;
        }
        var col = strokeColor();
        var gP  = in2pt(CFG.grow);
        var fLayer = doc.layers.add(); fLayer.name = CFG.framesLayer;

        for (var m2 = 0; m2 < made.length; m2++) {
            var bb = made[m2].piece.geometricBounds;     // [L,T,R,B]
            var rL = bb[0] - gP, rT = bb[1] + gP, rR = bb[2] + gP, rB = bb[3] - gP;
            var fr = fLayer.pathItems.rectangle(rT, rL, (rR - rL), (rT - rB));
            fr.name = CFG.layerPrefix + made[m2].n;
            fr.filled = false; fr.stroked = true; fr.strokeColor = col; fr.strokeWidth = CFG.strokeW;
            frames.push({ n: made[m2].n, rect: fr, left: rL });
        }

        // --- 6B. 删原 artboard、按从左到右建新 artboard ---
        frames.sort(function (a, b) { return a.left - b.left; });
        var origCount = doc.artboards.length;          // 建新之前都算"原"的
        for (var f = 0; f < frames.length; f++) {
            var rb = frames[f].rect.geometricBounds;    // 不含 stroke，正好是扩大框
            var ab = doc.artboards.add(rb);
            ab.name = CFG.layerPrefix + frames[f].n + " / " + total;
            abCount++;
        }
        // 新 artboard 都已在末尾；反复删第一个(原的)，但绝不删到只剩 <1
        for (var r = 0; r < origCount && doc.artboards.length > 1; r++) {
            doc.artboards.remove(0);
        }
        if (abCount > 0) { try { doc.artboards.setActiveArtboardIndex(0); } catch (e4) {} }
    }

    // ===================== 6C. 逐 panel 导出 PDF(可选) =====================
    var exportInfo = { count: 0, folder: null, files: [] };
    if (prm.doPdf) {
        if (!prm.doAb || abCount === 0) {
            fail("要导出逐 panel PDF，必须先生成 artboard，但这次没有可用 artboard。");
            return;
        }
        try {
            exportInfo = exportPanelPDFs(prm, made, frames, total);
        } catch (exPdf) {
            fail("拆分已完成，但 PDF 导出中断：\n" + exPdf);
            return;
        }
    }

    // ===================== 7. 报告 =====================
    doc.selection = null;
    var modeTxt = (prm.mode === "equal" ? "等分" : "省料"), wTxt = [];
    for (var w = 0; w < widths.length; w++) wTxt.push("片" + (w + 1) + " " + widths[w].toFixed(2) + "\"");

    var msg = "拆分完成。\n\n"
        + "模式：" + modeTxt + "   料宽：" + prm.matW + "\"   overlap：" + prm.overlap + "\"\n"
        + "共 " + total + " 片，成功 " + made.length + " 片。\n"
        + "每片宽度：" + wTxt.join("，") + "\n\n"
        + "原形状已备份到锁定图层「" + bakLayer.name + "」(已隐藏)。";
    if (empties.length) msg += "\n\n注意：第 " + empties.join("、") + " 片在该区间内没有形状，已跳过。";
    if (prm.doAb) {
        msg += "\n\n已建 " + abCount + " 个导出 artboard(原 artboard 已删)，"
             + "边界框(四边外扩 " + CFG.grow + "\")在「" + CFG.framesLayer + "」图层，C99 描边、无 fill。";
    }
    if (prm.doPdf) {
        msg += "\n\n已导出 " + exportInfo.count + " 个单页 PDF";
        if (exportInfo.folder) msg += " 到：\n" + exportInfo.folder.fsName;
        msg += prm.noEditPdf ? "\nPDF：未保留 Illustrator 编辑能力。" : "\nPDF：保留 Illustrator 编辑能力。";
        if (prm.hideSrcOnExport) msg += "\n导出时已临时隐藏原始完整 shape。";
        msg += "\n导出时当前 Panel 已临时转为 Kiss-cut：无 fill，C0 M99 Y0 K0，0.5 pt。";
    }
    msg += "\n\n提醒：每片在 panel 接缝处那条贴边直边按约定保留，未删。";
    fail(msg);

})();
