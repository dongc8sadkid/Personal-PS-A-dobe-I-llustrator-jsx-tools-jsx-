// ============================================================
//  工单封面生成脚本  (Adobe Illustrator / ExtendScript .jsx)
//  流程：选一个或多个 PDF → 选模式 → 逐个抓上级文件夹名当材料 →
//        新建 8.5x11 页面（材料栏 / 缩略图 / 文件名栏）→
//        存到源文件同一目录： 原名_workorder.pdf → 自动关闭工单文档
//
//  运行方式： 文件 > 脚本 > 其他脚本…  选中本文件运行
//  （或把本文件放进 Illustrator 的 Presets/.../脚本 文件夹，重启后在菜单里直接点）
//
//  本文件请以 UTF-8 编码保存。若对话框中文变成乱码，
//  把下面几处中文改成英文即可，不影响功能。
// ============================================================

// ---------- 可调参数（你最可能想改的都在这） ----------
var PAGE_W      = 612;   // 8.5 inch * 72
var PAGE_H      = 792;   // 11  inch * 72
var MARGIN      = 36;    // 四周留白 (0.5 inch)
var MAT_SIZE    = 36;    // 材料栏字号
var MAT_FONT    = "Arial-BoldMT";   // 材料栏字体（粗体）。找不到则用默认字体
var NAME_SIZE   = 30;    // 文件名栏字号
var NAME_FONT   = "ArialMT";        // 文件名栏字体
var STRIP_EXT   = true;  // 文件名栏是否去掉 ".pdf" 后缀
var SKIP_MATERIAL_FOLDERS = ["done","on process"]; // PDF 如果在这些文件夹里，就不拿这个文件夹当材料名，而是往上找一层。大小写不敏感
var CONTACT_COLS = 3;    // 联系表每行放几张缩略图
var CONTACT_ROWS = 3;    // 联系表每列放几张缩略图；3 x 3 = 每张工单最多 9 页
var CONTACT_MAX = 180;   // 联系表缩略图长边上限：2.5 inch * 72 pt/inch
var CONTACT_PAD = 8;     // 联系表缩略图之间的间距 (pt)
var BOARD_PAD   = 36;    // 自动新增 artboard 之间的间距 (pt)
var BOARD_COLS  = 4;     // 多张 artboard 在 Illustrator 工作区中每行排几张
var RASTER_DPI  = 72;    // 置入的 PDF 页面最终栅格化分辨率
var CROP_TO     = 1;     // 缩略图取哪个框: 0=BoundingBox 1=Crop 2=Trim 3=Bleed 4=Media 5=Art
                         // （看不到完整版面就换个数字试，最常用 1 或 4）
var START_ROOT  = "Z:";  // 工单文件所在盘符。脚本会自动按今天日期拼出当天目录，
                         // 例如 Z:/2026/2026-06/06-03；目录不存在就逐级回退
// ------------------------------------------------------

(function () {

    // 1) 选一个或多个源 PDF —— 选择框默认停在「当天目录」，逐级回退
    var d  = new Date();
    var yy = String(d.getFullYear());
    var mm = ("0" + (d.getMonth() + 1)).slice(-2);
    var dd = ("0" + d.getDate()).slice(-2);
    var base = START_ROOT + "/" + yy;      // Z:/2026
    var ym   = yy + "-" + mm;              // 2026-06
    var md   = mm + "-" + dd;              // 06-03
    var candidates = [ base + "/" + ym + "/" + md, base + "/" + ym, base, START_ROOT + "/" ];
    var startFolder = null;
    for (var ci = 0; ci < candidates.length; ci++) {
        if (Folder(candidates[ci]).exists) { startFolder = candidates[ci]; break; }
    }

    var srcFiles;
    var filter = "PDF文件:*.pdf,所有文件:*.*";   // Windows 字符串过滤器；Mac 也兼容
    if (startFolder) {
        // 关键：每次都把「当前目录」强制设回当天目录，
        // 抢在 Windows 文件框「记住的上次位置」之前，覆盖掉它
        Folder.current = new Folder(startFolder);
        srcFiles = File(startFolder + "/_.pdf").openDlg(
            "选择一个或多个要生成工单的 PDF", filter, true);
    } else {
        // 盘符没挂上等情况：退回默认行为
        srcFiles = File.openDialog("选择一个或多个要生成工单的 PDF", filter, true);
    }
    if (!srcFiles) return;
    if (Object.prototype.toString.call(srcFiles) !== "[object Array]") {
        srcFiles = [srcFiles];
    }
    if (srcFiles.length < 1) return;

    // 2) 只选一次模式；这批 PDF 都使用相同的缩略图模式
    var dlg = new Window("dialog", "工单生成");
    dlg.alignChildren = "left";
    dlg.add("statictext", undefined, "已选择 " + srcFiles.length + " 个 PDF 文件。");
    dlg.add("statictext", undefined, "缩略图模式：");
    var rbFirst = dlg.add("radiobutton", undefined, "仅第一页");
    var rbAll   = dlg.add("radiobutton", undefined, "所有页面（联系表）");
    rbFirst.value = true;
    var g  = dlg.add("group");
    g.add("button", undefined, "确定",  { name: "ok" });
    g.add("button", undefined, "取消", { name: "cancel" });
    if (dlg.show() != 1) return;
    var allPages = rbAll.value;

    // 3) 逐个处理：每个联系表都确认页数，每份工单保存后立即关闭。
    var completed = [];
    var failed = [];
    var skipped = [];

    for (var fileIndex = 0; fileIndex < srcFiles.length; fileIndex++) {
        var srcFile = srcFiles[fileIndex];
        var fileName = decodeURI(srcFile.name);

        try {
            var pageCount = 1;

            if (allPages) {
                var guess = detectPageCount(srcFile);
                var ans = prompt(
                    "文件 " + (fileIndex + 1) + " / " + srcFiles.length + ":\n" +
                    fileName + "\n\n检测到约 " + (guess > 0 ? guess : "?") +
                    " 页。\n请确认或修改总页数：",
                    String(guess > 0 ? guess : 1));

                // 取消只跳过当前文件，不中断后面的批量任务。
                if (ans === null) {
                    skipped.push(fileName);
                    continue;
                }

                pageCount = parseInt(ans, 10);
                if (isNaN(pageCount) || pageCount < 1) pageCount = 1;
            }

            var outFile = makeWorkorder(srcFile, allPages, pageCount);
            completed.push(outFile.fsName);
        } catch (err) {
            failed.push(fileName + ": " + err);
        }
    }

    var summary = "工单处理完成。\n\n成功：" + completed.length +
                  "\n失败：" + failed.length +
                  "\n跳过：" + skipped.length;

    if (completed.length === 1) {
        summary += "\n\n已保存：\n" + completed[0];
    } else if (completed.length > 1) {
        summary += "\n\n工单已保存到各自源 PDF 所在的文件夹。";
    }

    if (failed.length > 0) {
        summary += "\n\n失败的文件：\n" + failed.join("\n");
    }

    if (skipped.length > 0) {
        summary += "\n\n跳过的文件：\n" + skipped.join("\n");
    }

    alert(summary);


    // -------------------- 工具函数 --------------------

    function makeWorkorder(srcFile, allPages, pageCount) {
        var doc = null;

        try {
            // 4) 每个 PDF 单独抓取材料名和文件名。
            var materialFolder = getMaterialFolder(srcFile);
            var material = titleCase(decodeURI(materialFolder.name));
            var nameStr = decodeURI(srcFile.name);
            if (STRIP_EXT) nameStr = nameStr.replace(/\.pdf$/i, "");

            // 5) 联系表遇到确认后只有 1 页的 PDF，自动使用普通单页布局。
            var useContactSheet = allPages && pageCount > 1;
            // Illustrator 的文档 rulerUnits 是只读属性；先改 General Units，
            // 再新建文档，确保这份工单本身也以 Inches 为单位。
            setIllustratorUnits();
            doc = app.documents.add(DocumentColorSpace.RGB, PAGE_W, PAGE_H);
            var firstRect = doc.artboards[0].artboardRect;
            var cols = useContactSheet ? CONTACT_COLS : 1;
            var rows = useContactSheet ? CONTACT_ROWS : 1;
            var pagesPerBoard = cols * rows;
            var boardCount = Math.ceil(pageCount / pagesPerBoard);

            for (var boardIndex = 0; boardIndex < boardCount; boardIndex++) {
                var rect;

                if (boardIndex === 0) {
                    rect = firstRect;
                } else {
                    // 工作区里的 artboard 按多列排列，避免一路向右排得过长。
                    var boardCol = boardIndex % BOARD_COLS;
                    var boardRow = Math.floor(boardIndex / BOARD_COLS);
                    var offsetX = boardCol * (PAGE_W + BOARD_PAD);
                    var offsetY = boardRow * (PAGE_H + BOARD_PAD);
                    rect = [firstRect[0] + offsetX,
                            firstRect[1] - offsetY,
                            firstRect[2] + offsetX,
                            firstRect[3] - offsetY];
                    doc.artboards.add(rect);
                }

                var L = rect[0], T = rect[1], R = rect[2], B = rect[3];

                // 6) 当前 artboard 的版面分区（单位 pt，T 在上、B 在下）。
                var headTop = T - 24;
                var headH = 54;
                var footTop = B + 150;
                var footH = 140;
                var areaTop = T - 96;
                var areaBot = B + 160;
                var areaLeft = L + MARGIN;
                var areaRight = R - MARGIN;
                var areaW = areaRight - areaLeft;
                var areaH = areaTop - areaBot;

                // 每张 artboard 都重复材料名和文件名，单独打印也能识别。
                makeText(doc, material, headTop, areaLeft, areaW, headH, MAT_SIZE, MAT_FONT);

                // 7) 单页文件单张占满；多页联系表固定 3 x 3。
                var pad = useContactSheet ? CONTACT_PAD : 0;
                var cellW = (areaW - pad * (cols - 1)) / cols;
                var cellH = (areaH - pad * (rows - 1)) / rows;

                for (var slot = 0; slot < pagesPerBoard; slot++) {
                    var pageIndex = boardIndex * pagesPerBoard + slot;
                    if (pageIndex >= pageCount) break;

                    var p = placePage(doc, srcFile, pageIndex + 1);
                    if (!p) continue;

                    var originalW = p.width;
                    var originalH = p.height;
                    var sc = Math.min(cellW / originalW, cellH / originalH);

                    if (useContactSheet) {
                        // 按长边限制，保证宽和高都不会超过 2.5 inch。
                        sc = Math.min(sc, CONTACT_MAX / Math.max(originalW, originalH));
                    }

                    p.width = originalW * sc;
                    p.height = originalH * sc;

                    var c = slot % cols;
                    var r = Math.floor(slot / cols);
                    var cl = areaLeft + c * (cellW + pad);
                    var ct = areaTop - r * (cellH + pad);
                    p.position = [cl + (cellW - p.width) / 2,
                                  ct - (cellH - p.height) / 2];

                    // 尺寸和位置确定后再栅格化，避免 72 dpi 图像被二次缩放。
                    rasterizePlacedItem(doc, p);
                }

                // 8) 当前 artboard 的文件名栏。
                makeText(doc, nameStr, footTop, areaLeft, areaW, footH, NAME_SIZE, NAME_FONT);
            }

            // 9) 保存前再次确保当前文件与 Illustrator 默认单位均为：
            //    General = Inches、Stroke = Inches、Type = Points。
            setIllustratorUnits();

            // 10) 保存后只关闭脚本刚新建的文档，不动用户原本打开的文件。
            var outBase = srcFile.name.replace(/\.pdf$/i, "");
            var outFile = new File(srcFile.path + "/" + outBase + "_workorder.pdf");
            doc.saveAs(outFile, new PDFSaveOptions());
            doc.close(SaveOptions.DONOTSAVECHANGES);
            doc = null;

            return outFile;
        } catch (err) {
            // 哪怕单个文件出错，也尽量收掉它的工单文档再处理下一个。
            if (doc) {
                try { doc.close(SaveOptions.DONOTSAVECHANGES); } catch (closeErr) {}
            }
            throw err;
        }
    }

    function makeText(doc, str, top, left, w, h, size, fontName) {
        var rp = doc.pathItems.rectangle(top, left, w, h);   // (top,left,width,height)
        var tf = doc.textFrames.areaText(rp);
        tf.contents = str;
        tf.textRange.characterAttributes.size = size;
        tf.textRange.paragraphAttributes.justification = Justification.CENTER;
        try { tf.textRange.characterAttributes.textFont = app.textFonts.getByName(fontName); } catch (e) {}
        return tf;
    }

    function placePage(doc, file, pageNum) {
        try {
            app.preferences.setIntegerPreference("plugin/PDFImport/PageNumber", pageNum);
            try { app.preferences.setIntegerPreference("plugin/PDFImport/CropTo", CROP_TO); } catch (e2) {}
            var p = doc.placedItems.add();
            p.file = file;
            return p;
        } catch (e) { return null; }
    }

    // 把已经完成缩放和定位的 PlacedItem 栅格化。
    // White Background = transparency false + backgroundBlack false；
    // Preserve Spot Colors 关闭 = convertSpotColors true。
    function rasterizePlacedItem(doc, item) {
        var options = new RasterizeOptions();
        options.resolution = RASTER_DPI;
        options.transparency = false;
        options.backgroundBlack = false;
        options.antiAliasingMethod = AntiAliasingMethod.ARTOPTIMIZED;
        options.convertSpotColors = true;
        options.clippingMask = false;
        options.padding = 0;

        var bounds = item.geometricBounds;
        return doc.rasterize(item, bounds, options);
    }

    // Illustrator 偏好设置中的单位代码：0 = Inches，2 = Points。
    // rulerType 同时决定当前/新建文档的 General Units。
    function setIllustratorUnits() {
        app.preferences.setIntegerPreference("rulerType", 0);
        app.preferences.setIntegerPreference("strokeUnits", 0);
        app.preferences.setIntegerPreference("text/units", 2);
    }

    // 决定“材料栏”应该抓哪个文件夹名。
    // 默认：抓 PDF 所在文件夹。
    // 特例：如果 PDF 所在文件夹名在 SKIP_MATERIAL_FOLDERS 里，就往上抓一层。
    function getMaterialFolder(file) {
        var folder = file.parent;

        try {
            // 用 while 是为了防一手极端情况：.../Material/done/DONE/file.pdf
            while (folder && folder.parent && shouldSkipMaterialFolder(folder.name)) {
                folder = folder.parent;
            }
        } catch (e) {}

        return folder;
    }

    function shouldSkipMaterialFolder(folderName) {
        try {
            folderName = decodeURI(folderName).replace(/^\s+|\s+$/g, "").toLowerCase();
        } catch (e) {
            folderName = String(folderName).replace(/^\s+|\s+$/g, "").toLowerCase();
        }

        for (var i = 0; i < SKIP_MATERIAL_FOLDERS.length; i++) {
            var ruleName = String(SKIP_MATERIAL_FOLDERS[i]).replace(/^\s+|\s+$/g, "").toLowerCase();
            if (folderName === ruleName) return true;
        }
        return false;
    }

    // 把首字母大写；已是全大写的词（如 PVC、3M）保持原样
    function titleCase(s) {
        s = s.replace(/^\s+|\s+$/g, "");
        var w = s.split(/\s+/);
        for (var i = 0; i < w.length; i++) {
            if (w[i].length > 1 && w[i] === w[i].toUpperCase()) continue;
            w[i] = w[i].charAt(0).toUpperCase() + w[i].substr(1);
        }
        return w.join(" ");
    }

    // 读文件头尾，正则猜页数；猜不到返回 0
    function detectPageCount(file) {
        try {
            var size = file.length, chunk = 262144;
            file.encoding = "BINARY";
            file.open("r");
            var head = file.read(Math.min(size, chunk));
            var tail = "";
            if (size > chunk) { file.seek(Math.max(0, size - chunk), 0); tail = file.read(); }
            file.close();
            var blob = head + "\n" + tail, m, max = 0;
            var re = /\/Count\s+(\d+)/g;
            while ((m = re.exec(blob)) !== null) { var n = parseInt(m[1], 10); if (n > max) max = n; }
            if (max > 0) return max;
            var re2 = /\/Type\s*\/Page[^s]/g, c = 0;
            while (re2.exec(blob) !== null) c++;
            return c;
        } catch (e) { return 0; }
    }

})();
