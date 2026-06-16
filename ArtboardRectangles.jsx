#target illustrator

/*
 * ArtboardRectangles.jsx
 * ----------------------
 * 读取当前文档中每一个画板（Artboard）的尺寸，
 * 并为每个画板绘制一个与其边缘完全重合的矩形。
 *
 * 用法：Illustrator 菜单 → 文件 → 脚本 → 其他脚本… → 选择本文件
 */

(function () {

    // ===== 可调选项 =====================================
    var STROKE_ON   = true;   // 是否描边
    var FILL_ON     = false;  // 是否填色
    var STROKE_W    = 1;      // 描边宽度（点 pt）
    var NEW_LAYER   = true;   // true = 把矩形放到单独图层；false = 放到当前图层
    var LAYER_NAME  = "Artboard Rectangles";
    // ====================================================

    if (app.documents.length === 0) {
        alert("没有打开的文档。请先打开一个文件再运行。");
        return;
    }

    var doc       = app.activeDocument;
    var artboards = doc.artboards;
    var count     = artboards.length;

    // 决定矩形放在哪个图层
    var target;
    if (NEW_LAYER) {
        try {
            target = doc.layers.getByName(LAYER_NAME);
        } catch (e) {
            target = doc.layers.add();
            target.name = LAYER_NAME;
        }
    } else {
        target = doc.activeLayer;
    }

    for (var i = 0; i < count; i++) {
        var ab   = artboards[i];
        var rect = ab.artboardRect;   // [left, top, right, bottom]，单位为点

        var left   = rect[0];
        var top    = rect[1];
        var right  = rect[2];
        var bottom = rect[3];

        var width  = right - left;
        var height = top - bottom;

        // rectangle(top, left, width, height) —— 坐标系与 artboardRect 一致，
        // 因此矩形会与画板边缘精确重合。
        var p = target.pathItems.rectangle(top, left, width, height);
        p.name = "Rect_" + ab.name;

        p.stroked = STROKE_ON;
        p.filled  = FILL_ON;
        if (STROKE_ON) p.strokeWidth = STROKE_W;
    }

    alert("完成！已为 " + count + " 个画板创建矩形。");

})();
