// ============================================================
//  工单封面生成脚本  (Adobe Illustrator / ExtendScript .jsx)
//  流程：选 PDF → 选模式 → 抓上级文件夹名当材料 →
//        新建 8.5x11 页面（材料栏 / 缩略图 / 文件名栏）→
//        存到源文件同一目录： 原名_workorder.pdf
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
var CROP_TO     = 1;     // 缩略图取哪个框: 0=BoundingBox 1=Crop 2=Trim 3=Bleed 4=Media 5=Art
                         // （看不到完整版面就换个数字试，最常用 1 或 4）
var START_ROOT  = "Z:";  // 工单文件所在盘符。脚本会自动按今天日期拼出当天目录，
                         // 例如 Z:/2026/2026-06/06-03；目录不存在就逐级回退
// ------------------------------------------------------

(function () {

    // 1) 选源 PDF —— 选择框默认停在「当天目录」，逐级回退
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

    var srcFile;
    var filter = "PDF文件:*.pdf,所有文件:*.*";   // Windows 字符串过滤器；Mac 也兼容
    if (startFolder) {
        // 关键：每次都把「当前目录」强制设回当天目录，
        // 抢在 Windows 文件框「记住的上次位置」之前，覆盖掉它
        Folder.current = new Folder(startFolder);
        srcFile = File(startFolder + "/_.pdf").openDlg("选择要生成工单的 PDF", filter);
    } else {
        // 盘符没挂上等情况：退回默认行为
        srcFile = File.openDialog("选择要生成工单的 PDF", filter);
    }
    if (!srcFile) return;

    // 2) 选模式
    var dlg = new Window("dialog", "工单生成");
    dlg.alignChildren = "left";
    dlg.add("statictext", undefined, "缩略图模式：");
    var rbFirst = dlg.add("radiobutton", undefined, "仅第一页");
    var rbAll   = dlg.add("radiobutton", undefined, "所有页面（联系表）");
    rbFirst.value = true;
    var g  = dlg.add("group");
    g.add("button", undefined, "确定",  { name: "ok" });
    g.add("button", undefined, "取消", { name: "cancel" });
    if (dlg.show() != 1) return;
    var allPages = rbAll.value;

    // 3) 页数
    var pageCount = 1;
    if (allPages) {
        var guess = detectPageCount(srcFile);
        var ans = prompt(
            "检测到约 " + (guess > 0 ? guess : "?") + " 页。\n请确认或修改总页数：",
            String(guess > 0 ? guess : 1));
        if (ans === null) return;
        pageCount = parseInt(ans, 10);
        if (isNaN(pageCount) || pageCount < 1) pageCount = 1;
    }

    // 4) 文本内容
    var material = titleCase(decodeURI(srcFile.parent.name));     // 上级文件夹名 -> 材料
    var nameStr  = decodeURI(srcFile.name);
    if (STRIP_EXT) nameStr = nameStr.replace(/\.pdf$/i, "");

    // 5) 新建文档
    var doc  = app.documents.add(DocumentColorSpace.RGB, PAGE_W, PAGE_H);
    var rect = doc.artboards[0].artboardRect;   // [left, top, right, bottom]
    var L = rect[0], T = rect[1], R = rect[2], B = rect[3];

    // 版面分区（单位 pt，T 在上、B 在下）
    var headTop   = T - 24;            // 材料栏
    var headH     = 54;
    var footTop   = B + 150;           // 文件名栏（往上铺）
    var footH     = 140;
    var areaTop   = T - 96;            // 缩略图区
    var areaBot   = B + 160;
    var areaLeft  = L + MARGIN;
    var areaRight = R - MARGIN;
    var areaW     = areaRight - areaLeft;
    var areaH     = areaTop - areaBot;

    // 6) 材料栏
    makeText(doc, material, headTop, areaLeft, areaW, headH, MAT_SIZE, MAT_FONT);

    // 7) 缩略图（第一页模式 = 单张占满；联系表 = 网格）
    var cols = Math.ceil(Math.sqrt(pageCount));
    var rows = Math.ceil(pageCount / cols);
    var pad  = 8;
    var cellW = (areaW - pad * (cols - 1)) / cols;
    var cellH = (areaH - pad * (rows - 1)) / rows;

    for (var i = 0; i < pageCount; i++) {
        var p = placePage(doc, srcFile, i + 1);
        if (!p) continue;
        var sc = Math.min(cellW / p.width, cellH / p.height);
        p.width  = p.width  * sc;
        p.height = p.height * sc;
        var c = i % cols, r = Math.floor(i / cols);
        var cl = areaLeft + c * (cellW + pad);
        var ct = areaTop  - r * (cellH + pad);
        p.position = [ cl + (cellW - p.width) / 2,
                       ct - (cellH - p.height) / 2 ];
    }

    // 8) 文件名栏
    makeText(doc, nameStr, footTop, areaLeft, areaW, footH, NAME_SIZE, NAME_FONT);

    // 9) 存到源文件同目录
    var outBase = srcFile.name.replace(/\.pdf$/i, "");
    var outFile = new File(srcFile.path + "/" + outBase + "_workorder.pdf");
    doc.saveAs(outFile, new PDFSaveOptions());

    alert("完成：\n" + outFile.fsName);


    // -------------------- 工具函数 --------------------

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
