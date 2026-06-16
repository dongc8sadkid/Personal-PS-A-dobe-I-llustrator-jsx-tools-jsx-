#target illustrator

/*
 * ArtboardHalfCircles.jsx
 * -----------------------
 * 在每个画板内部铺满半圆(行列网格)。
 *
 *  - 半圆 = 6"宽 × 3"高:一个 6×6" 的圆删掉上半部分,
 *    弧面朝下、上方【不封口】——只保留下方那条弧线(开放路径)。
 *  - 相邻半圆按【中心间距】排成网格,间距 = SPACING_INCHES(建议 24~30")。
 *  - 整组半圆在可用区域内居中。
 *  - 任何半圆的外接框距画板任一边缘 ≥ EDGE_MARGIN_IN(12")。
 *  - 放不下的画板(过小)会被自动跳过。
 *
 * 用法:文件 → 脚本 → 其他脚本… → 选择本文件
 */

(function () {

    // ===== 可调选项 ==========================================
    var SPACING_INCHES = 27;   // 半圆中心间距(建议在 24~30 之间任选)
    var EDGE_MARGIN_IN = 12;   // 半圆距画板边缘的最小距离
    var SHAPE_W_IN     = 6;    // 半圆宽(= 原圆直径)
    var SHAPE_H_IN     = 3;    // 半圆高(= 原圆半径)
    var STROKE_ON      = true; // 是否描边
    var FILL_ON        = false;// 是否填色
    var STROKE_W       = 1;    // 描边宽度(pt)
    var LAYER_NAME     = "Half Circles";
    // =========================================================

    if (app.documents.length === 0) {
        alert("没有打开的文档。请先打开一个文件再运行。");
        return;
    }

    var PT = 72;                         // 每英寸 72 点
    var KAPPA = 0.5522847498;            // 90° 圆弧的贝塞尔系数

    var doc = app.activeDocument;
    var abs = doc.artboards;

    // 大画布(Large Canvas)处理:画板任一边 > 227" 时,Illustrator 会把
    // 整个文档按 1/10 缩放,API 读到的尺寸是真实值的 1/10。
    // scaleFactor:普通文档 = 1,大画布 = 10(CC 2020 之前没有此属性,默认按 1 处理)。
    var SF = (doc.scaleFactor ? doc.scaleFactor : 1);
    function inch(n) { return n * PT / SF; }   // 真实英寸 → 文档内部点值

    // 目标图层(没有就新建)
    var layer;
    try { layer = doc.layers.getByName(LAYER_NAME); }
    catch (e) { layer = doc.layers.add(); layer.name = LAYER_NAME; }

    var spacing = inch(SPACING_INCHES);
    var margin  = inch(EDGE_MARGIN_IN);
    var radius  = inch(SHAPE_W_IN) / 2;  // 圆半径 = 宽/2 = 3"
    var halfW   = inch(SHAPE_W_IN) / 2;  // 外接框半宽 = 3"
    var halfH   = inch(SHAPE_H_IN) / 2;  // 外接框半高 = 1.5"

    var totalShapes = 0;
    var skipped     = 0;

    for (var i = 0; i < abs.length; i++) {
        var rect = abs[i].artboardRect;  // [left, top, right, bottom]
        var L = rect[0], T = rect[1], R = rect[2], B = rect[3];

        // 半圆【中心】可放置范围(保证外接框距边 ≥ margin)
        var cMinX = L + margin + halfW;
        var cMaxX = R - margin - halfW;
        var cMinY = B + margin + halfH;
        var cMaxY = T - margin - halfH;

        // 装不下就跳过这个画板
        if (cMaxX < cMinX || cMaxY < cMinY) { skipped++; continue; }

        var xs = axisPositions(cMinX, cMaxX, spacing);
        var ys = axisPositions(cMinY, cMaxY, spacing);

        var grp = layer.groupItems.add();
        grp.name = abs[i].name + " halfcircles";

        for (var xi = 0; xi < xs.length; xi++) {
            for (var yi = 0; yi < ys.length; yi++) {
                drawLowerSemicircle(grp, xs[xi], ys[yi], radius);
                totalShapes++;
            }
        }
        if (grp.pageItems.length === 0) grp.remove();
    }

    alert("完成!\n共放置 " + totalShapes + " 个半圆。\n跳过(过小放不下)的画板:" + skipped + " 个。"
          + (SF !== 1 ? "\n(检测到大画布文档,缩放系数 " + SF + ",已自动校正)" : ""));

    // ---- 计算一条轴上的中心坐标:固定步长,整组居中 ----
    function axisPositions(cMin, cMax, step) {
        var span = cMax - cMin;
        var n    = Math.floor(span / step) + 1;   // 个数
        if (n < 1) n = 1;
        var used  = (n - 1) * step;
        var start = cMin + (span - used) / 2;      // 居中放置
        var arr = [];
        for (var k = 0; k < n; k++) arr.push(start + k * step);
        return arr;
    }

    // ---- 画一个下半圆弧:外接框中心在 (cx, cy) ----
    // 弧面朝下,由两段 90° 贝塞尔弧组成的开放路径,上方不封口。
    function drawLowerSemicircle(parent, cx, cy, r) {
        var yFlat = cy + r / 2;          // 平边的 y(外接框上沿)
        var kr    = KAPPA * r;

        var Ax = cx - r, Ay = yFlat;     // 左端点
        var Bx = cx,     By = yFlat - r; // 最低点
        var Cx = cx + r, Cy = yFlat;     // 右端点

        var p = parent.pathItems.add();
        p.setEntirePath([[Ax, Ay], [Bx, By], [Cx, Cy]]);
        p.closed = false;                // 开放路径:上方不封口,只留弧线

        var pp = p.pathPoints;

        // A:左端 —— 端点,只向 B 方向出弧
        pp[0].anchor         = [Ax, Ay];
        pp[0].leftDirection  = [Ax, Ay];
        pp[0].rightDirection = [Ax, Ay - kr];

        // B:底部 —— 两侧都是弧(平滑点)
        pp[1].anchor         = [Bx, By];
        pp[1].leftDirection  = [Bx - kr, By];
        pp[1].rightDirection = [Bx + kr, By];

        // C:右端 —— 端点,只从 B 方向进弧
        pp[2].anchor         = [Cx, Cy];
        pp[2].leftDirection  = [Cx, Cy - kr];
        pp[2].rightDirection = [Cx, Cy];

        p.filled  = FILL_ON;
        p.stroked = STROKE_ON;
        if (STROKE_ON) p.strokeWidth = STROKE_W / SF;  // 除以缩放系数,保证视觉宽度一致
        return p;
    }

})();
