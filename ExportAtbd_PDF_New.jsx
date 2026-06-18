/*
 * ExportArtboardsAsPDF.jsx  (v2 - 真·单画板隔离)
 * -------------------------------------------------------------
 * 把当前多画板 .ai 按【每个 Artboard 一个独立 PDF】导出，
 * 文件名 = 画板名，且每个 PDF：
 *   - Acrobat 打开 = 只有 1 页
 *   - Illustrator 重开 = 只有 1 个画板（不是所有画板都在）
 *   - 保留 Illustrator 可编辑性 + 图层结构（不压平）
 *
 * 原理：不碰你的实时文档。从 D:/Temp_ai 的备份副本逐画板开一份独立
 *       拷贝，删掉画板外 artwork + 其他画板，存 PDF，丢弃拷贝。
 *
 * 行为（写死，无 UI）：
 *   1. 把原 .ai 字节级复制到 D:/Temp_ai（带时间戳）= 备份 + 工作源。
 *   2. 弹窗选 PDF 输出目录。
 *   3. 全部 artboard 一把梭。
 *   4. 预设 [Illustrator Default] + Preserve Editing + 零压缩 + 不碰颜色模式。
 *   5. 跑完弹 alert 汇总。你的实时文档全程不被改动 —— 不需要担心 Ctrl+S。
 *
 * by 你 feat. LLMs
 * -------------------------------------------------------------
 */

#target illustrator

(function () {
    // ============ 可调配置 ============
    var BACKUP_DIR = "D:\Temp_ai";
    var PDF_PRESET = "[Illustrator Default]";

    // true  = Preserve Illustrator Editing Capabilities（保留图层/可编辑性）【你要的】
    // false = 不内嵌 .ai；仍可编辑但图层会压平
    var PRESERVE_EDITABILITY = true;
    // =================================

    // ---- 守卫 ----
    if (app.documents.length === 0) {
        alert("没有打开的文档。先开一个多画板 .ai 再跑。");
        return;
    }
    var doc = app.activeDocument;

    var srcFile = null;
    try { srcFile = doc.fullName; } catch (e) {}
    if (!srcFile || !srcFile.exists) {
        alert("当前文档还没存到硬盘上。\n先 Ctrl+S 存成 .ai 再跑。");
        return;
    }
    // 这个模式从硬盘副本读，所以必须先存盘（保证导出的就是你眼前的内容）
    if (doc.saved === false) {
        alert("你当前有未保存的改动。\n这个模式会从硬盘副本逐画板处理，请先 Ctrl+S，再跑。");
        return;
    }

    // 先把画板名抓出来（顺序与备份副本一致），统一清洗 + 查重
    var n = doc.artboards.length;
    var targetNames = [];
    var usedNames = {};
    for (var t = 0; t < n; t++) {
        var clean = sanitize(doc.artboards[t].name);
        if (clean === "") clean = "Artboard_" + (t + 1);
        targetNames.push(dedupe(clean, usedNames));
    }

    // ---- 1. 备份 / 工作源 ----
    var backupFolder = new Folder(BACKUP_DIR);
    if (!backupFolder.exists) {
        if (!backupFolder.create()) {
            alert("建不了备份目录：" + BACKUP_DIR);
            return;
        }
    }
    var baseName   = doc.name.replace(/\.[^\.]+$/, "");
    var backupFile = new File(backupFolder.fsName + "/" + baseName + "_" + timeStamp() + ".ai");
    if (!srcFile.copy(backupFile)) {
        alert("备份复制失败，停。\n源：" + srcFile.fsName);
        return;
    }

    // ---- 2. 选输出目录 ----
    var outFolder = Folder.selectDialog("选择 PDF 输出目录");
    if (!outFolder) {
        alert("取消了。备份已存：\n" + backupFile.fsName);
        return;
    }

    // ---- 3. PDF 选项 ----
    var opts = new PDFSaveOptions();
    try { opts.pDFPreset = PDF_PRESET; }
    catch (ePreset) {
        alert("加载不了预设：" + PDF_PRESET + "\n改成你列表里的准确字符串。\n\n" + ePreset);
        return;
    }
    opts.preserveEditability        = PRESERVE_EDITABILITY;
    opts.viewAfterSaving            = false;
    opts.optimization               = false;
    opts.compressArt                = false;
    opts.colorBitmapCompression      = CompressionQuality.None;
    opts.grayscaleBitmapCompression  = CompressionQuality.None;
    opts.monochromeBitmapCompression = MonochromeCompression.None;
    opts.colorDownsampling           = 0;
    opts.grayscaleDownsampling       = 0;
    opts.monochromeDownsampling      = 0;
    opts.saveMultipleArtboards       = true;
    // 不碰任何 color conversion / profile => CMYK/RGB 原样保留

    // ---- 4. 逐画板：开副本 -> 隔离 -> 存 -> 弃 ----
    var prevUIL = app.userInteractionLevel;
    app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS; // 压掉缺字体等弹窗

    var made = 0;
    var report = [];

    for (var i = 0; i < n; i++) {
        var tmp = null;
        try {
            tmp = app.open(backupFile);   // backupFile 与实时文档不同名 => 开成独立副本

            // (a) 删掉画板 i 之外的所有 artwork（保留图层结构）
            tmp.selection = null;
            tmp.artboards.setActiveArtboardIndex(i);
            tmp.selectObjectsOnActiveArtboard();            // 选中画板 i 上的（要保留的）
            app.executeMenuCommand("Inverse menu item");    // 反选 => 画板外的
            if (tmp.selection.length > 0) {
                app.executeMenuCommand("clear");            // 删掉画板外的
            }
            tmp.selection = null;

            // (b) 只留画板 i，删掉其他所有画板
            for (var j = tmp.artboards.length - 1; j > i; j--) { tmp.artboards.remove(j); }
            for (var c = 0; c < i; c++) { tmp.artboards.remove(0); }
            // 现在只剩 1 个画板，在 index 0

            // (c) 存 PDF
            var pdfFile = new File(outFolder.fsName + "/" + targetNames[i] + ".pdf");
            opts.artboardRange = "1";
            tmp.saveAs(pdfFile, opts);

            made++;
            report.push(targetNames[i] + ".pdf");

            tmp.close(SaveOptions.DONOTSAVECHANGES);
            tmp = null;
        } catch (eLoop) {
            report.push("[失败] AB" + (i + 1) + " (\"" + targetNames[i] + "\"): " + eLoop);
            if (tmp !== null) {
                try { tmp.close(SaveOptions.DONOTSAVECHANGES); } catch (eClose) {}
            }
        }
    }

    app.userInteractionLevel = prevUIL;

    // ---- 5. 汇总 ----
    var msg = "搞定：" + made + " / " + n + " 个 PDF\n输出：\n" + outFolder.fsName + "\n\n";
    msg += "备份/工作源：\n" + backupFile.fsName + "\n";
    msg += "（你的原文档全程没被改动，可以正常 Ctrl+S 继续干活）\n\n";
    msg += "清单：\n" + report.join("\n");
    alert(msg);

    // ========== helpers ==========
    function sanitize(s) {
        s = String(s);
        s = s.replace(/[\/\\:\*\?"<>\|\r\n\t]/g, "_");
        s = s.replace(/[\. ]+$/g, "");
        s = s.replace(/^\s+/, "");
        return s;
    }
    function dedupe(name, map) {
        var key = name.toLowerCase();
        if (!map[key]) { map[key] = 1; return name; }
        var k = map[key], candidate;
        do { candidate = name + "_" + pad2(k); k++; }
        while (map[candidate.toLowerCase()]);
        map[key] = k;
        map[candidate.toLowerCase()] = 1;
        return candidate;
    }
    function pad2(x) { return (x < 10 ? "0" : "") + x; }
    function timeStamp() {
        var d = new Date();
        function p(x) { return (x < 10 ? "0" : "") + x; }
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
               "_" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }
})();
