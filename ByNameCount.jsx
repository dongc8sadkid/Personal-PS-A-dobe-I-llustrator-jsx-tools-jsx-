/**********************************************************************
 * MultiplyArtboards_ByNameCount.jsx
 * ---------------------------------------------------------------
 * 按画板名里的 "<n>x" 标签，把每个画板（连同其 artwork）复制 n 份，
 * 用 shelf packing 重新铺成一个 grid，并保证最终顺序是连续的：
 *   "A 10x" -> A_01 ~ A_10
 *   "B 5x"  -> B_01 ~ B_05
 *   ...     -> 依此类推（A 的全部排完，再排 B，再排 C ...）
 *
 * 重要说明：
 * - "n 份" 包含原始那一个（原始画板会被吸收/删除，由复制件取代）。
 * - 这是破坏性操作。脚本运行前会先把当前文件存盘并复制一份带时间戳的
 *   备份 (..._pre-multiply_yyyymmdd_hhmmss.ai)，结果本身不会自动保存，
 *   你检查满意后请手动另存。
 * - clip group 若内容（含被裁掉的隐藏部分）跨越多个 target 画板，会直接
 *   报错并选中它，请自行 rasterize 后重跑。
 * - 锁定 / 隐藏图层上的对象不会被捕获，也不参与侵入检测。
 *
 * @author  Chao Dong feat. LLMs
 *********************************************************************/

#target illustrator

(function () {

    // ===================== 可调参数 =====================
    var GUTTER_PT       = 72;     // 画板间距，真实点值 (72pt = 1 真实 inch)。
                                  // 脚本会自动按 doc.scaleFactor 换算，所以在
                                  // Large Canvas 文档里这里依然填真实点值，不会被
                                  // ×10 放大成 10 寸。
    var COLS            = 0;      // 每行画板数。0 = 自动（≈ 正方形网格，列数取 √总数）。
                                  // 想固定列数就填正整数（如 8）；想要「一行尽量多放」
                                  // 的老行为，把它设成一个很大的数（如 999）。
    var MAX_ROW_WIDTH   = 16383;  // 单行宽度硬上限（≈ AI canvas 上限），仅作兜底，
                                  // 一行真超了才换行 / 报错。日常由 COLS 控制形状。
    var CANVAS_MAX      = 16383;  // 整体宽/高的安全上限（API 单位，两种模式通用），超过即报错。
    var INTERSECT_TOL   = 1.0;    // 侵入判定容差(pt)，避免发丝级接触误报。
    // ====================================================

    if (app.documents.length === 0) { alert("没有打开任何文档。"); return; }
    var doc = app.activeDocument;

    try {
        main();
    } catch (err) {
        alert("脚本中止：\n" + err.message);
    }

    // ---------------------------------------------------------------
    function main() {

        // ---- 0. 文件必须已存盘到磁盘上 ----
        var docFolder = null;
        try { docFolder = doc.path; } catch (e) {}
        if (!docFolder || !docFolder.exists) {
            alert("请先把文件保存到磁盘 (Ctrl+S) 再运行，脚本需要先生成备份。");
            return;
        }

        // ---- 0b. Large Canvas 缩放因子 (普通=1, large=10) ----
        // large canvas 模式下 API 坐标是真实值 ÷ scaleFactor，所以把 gutter
        // 从「真实点」换算成「API 单位」，1 寸永远是 1 寸。画布上限 CANVAS_MAX
        // 本身就是 API 单位，两种模式通用，无需换算。
        var sf = 1;
        try { if (doc.scaleFactor) sf = doc.scaleFactor; } catch (e) {}
        var gutter = GUTTER_PT / sf;

        // ---- 1. 解析画板名里的 "<n>x" ----
        var targets = [];   // { abIndex, name, base, count, rect, w, h, items }
        var skipped = [];   // { name, reason }
        var i, ab, parsed;
        for (i = 0; i < doc.artboards.length; i++) {
            ab = doc.artboards[i];
            parsed = parseCount(ab.name);
            if (parsed === null) {
                skipped.push({ name: ab.name, reason: "未找到 <n>x 标签" });
                continue;
            }
            if (parsed.count < 1) {
                skipped.push({ name: ab.name, reason: "数量为 0 或非法" });
                continue;
            }
            var r = ab.artboardRect; // [L, T, R, B]，T > B
            targets.push({
                abIndex: i,
                name: ab.name,
                base: parsed.base,
                count: parsed.count,
                rect: [r[0], r[1], r[2], r[3]],
                w: r[2] - r[0],
                h: r[1] - r[3],
                items: null
            });
        }

        if (targets.length === 0) {
            alert("没有找到任何带 <n>x 标签的画板。\n\n未处理的画板：\n" + listSkipped(skipped));
            return;
        }

        // ---- 2. 侵入检测（clip group / 跨画板对象）----
        var offenders = findIntrusions(targets);
        if (offenders.length > 0) {
            var sel = [];
            var clipCount = 0, otherCount = 0, msgLines = [];
            for (i = 0; i < offenders.length; i++) {
                sel.push(offenders[i].item);
                if (offenders[i].hasClip) clipCount++; else otherCount++;
                if (i < 12) {
                    msgLines.push("  • " + offenders[i].item.typename +
                        (offenders[i].hasClip ? "  (clip group → 请栅格化)" : "  (跨画板 → 请拉开间距)"));
                }
            }
            try { doc.selection = sel; } catch (e) {}
            alert("发现 " + offenders.length + " 个对象的真实几何跨越了多个 target 画板，已为你选中：\n\n" +
                  msgLines.join("\n") +
                  (offenders.length > 12 ? "\n  …(其余略)" : "") +
                  "\n\n其中 clip group " + clipCount + " 个、其它 " + otherCount + " 个。\n" +
                  "clip group 请 rasterize，其它请拉开间距，处理后重跑。\n（未做任何改动。）");
            return;
        }

        // ---- 3. 存盘 + 备份 ----
        var backupFile;
        try {
            doc.save(); // 把当前状态刷到磁盘，使备份 = 运行前状态
            var srcFile   = doc.fullName;
            var nameNoExt = srcFile.name.replace(/\.[^\.]+$/, "");
            backupFile = new File(docFolder.fsName + "/" + nameNoExt + "_pre-multiply_" + tstamp() + ".ai");
            if (!srcFile.copy(backupFile)) throw new Error("File.copy 返回 false");
        } catch (e) {
            alert("生成备份失败，已中止（未做任何改动）：\n" + e.message);
            return;
        }

        // ---- 4. 快照每个 target 的 artwork ----
        for (i = 0; i < targets.length; i++) {
            doc.artboards.setActiveArtboardIndex(targets[i].abIndex);
            doc.selection = null;
            doc.selectObjectsOnActiveArtboard();
            var s = doc.selection, arr = [];
            for (var k = 0; k < s.length; k++) arr.push(s[k]);
            targets[i].items = arr;
        }
        doc.selection = null;

        // ---- 5. 计算 shelf packing 布局（顺序固定，不重排）----
        var order = [];                       // { t, j }，按 A1..An, B1..Bn ... 排
        for (i = 0; i < targets.length; i++)
            for (var j = 1; j <= targets[i].count; j++)
                order.push({ t: targets[i], j: j });

        // 先用相对坐标排版：rx 向右、ry 向下，原点 (0,0)
        var cx = 0, cy = 0, rowH = 0, usedW = 0;
        for (i = 0; i < order.length; i++) {
            var o = order[i], w = o.t.w, h = o.t.h;
            if (w > MAX_ROW_WIDTH)
                throw new Error("单个画板宽度 " + Math.round(w) + "pt 超过每行上限 " +
                                MAX_ROW_WIDTH + "pt，放不下。请切换 Large Format 或调大 MAX_ROW_WIDTH。");
            if (cx > 0 && (cx + w) > MAX_ROW_WIDTH) { cy += rowH + gutter; cx = 0; rowH = 0; }
            o.rx = cx; o.ry = cy; o.w = w; o.h = h;
            cx += w + gutter;
            if (h > rowH) rowH = h;
            if (cx - gutter > usedW) usedW = cx - gutter;
        }
        var totalH = cy + rowH;
        if (usedW > CANVAS_MAX || totalH > CANVAS_MAX)
            throw new Error("整体尺寸 " + Math.round(usedW) + "×" + Math.round(totalH) +
                            "pt 超过画布上限 " + CANVAS_MAX + "pt，放不下。\n" +
                            "请切换 Large Format、减少数量，或调小 MAX_ROW_WIDTH。");

        // 锚点：把整个 grid 的中心对齐到所有 target 画板【并集的中心】。
        // 源画板本身一定在合法画布内，从其中心四向展开最不易越界 (避免 AOoC)。
        var uL = Infinity, uT = -Infinity, uR = -Infinity, uB = Infinity;
        for (i = 0; i < targets.length; i++) {
            var rr = targets[i].rect;
            if (rr[0] < uL) uL = rr[0];
            if (rr[1] > uT) uT = rr[1];
            if (rr[2] > uR) uR = rr[2];
            if (rr[3] < uB) uB = rr[3];
        }
        var ucx = (uL + uR) / 2, ucy = (uT + uB) / 2;
        var anchorX = ucx - usedW / 2;    // grid 左上角 X
        var anchorY = ucy + totalH / 2;   // grid 左上角 Y（顶部，y 向上为正）

        // 探测画布绝对边界，把整个 grid 夹进去，避免 AOoC 越界。
        // 探测失败 (返回 null) 则保持居中，靠下面的 add() try/catch 兜底。
        var cb = getCanvasBounds(targets[0].rect);
        if (cb) {
            var M = 4; // 留一点边距防浮点误差
            if (anchorX < cb.left + M)              anchorX = cb.left + M;
            if (anchorX + usedW > cb.right - M)     anchorX = cb.right - M - usedW;
            if (anchorY > cb.top - M)               anchorY = cb.top - M;
            if (anchorY - totalH < cb.bottom + M)   anchorY = cb.bottom + M + totalH;
        }

        for (i = 0; i < order.length; i++) {
            var aL = anchorX + order[i].rx;
            var aT = anchorY - order[i].ry;
            order[i].rect = [aL, aT, aL + order[i].w, aT - order[i].h];
        }

        // ---- 6. 复制 artwork + 新建画板 ----
        var totalStamps = 0;
        for (i = 0; i < order.length; i++) {
            var stamp = order[i], t = stamp.t;
            var dx = stamp.rect[0] - t.rect[0];   // 与源画板左上角的位移
            var dy = stamp.rect[1] - t.rect[1];   // translate: +dy 向上，dy<0 向下
            for (var m = 0; m < t.items.length; m++) {
                var dup = t.items[m].duplicate();
                dup.translate(dx, dy);
            }
            var newAb;
            try {
                newAb = doc.artboards.add(stamp.rect);
            } catch (e) {
                throw new Error("新建第 " + (i + 1) + " 个画板时越界 (AOoC)：\n  rect=[" +
                    Math.round(stamp.rect[0]) + ", " + Math.round(stamp.rect[1]) + ", " +
                    Math.round(stamp.rect[2]) + ", " + Math.round(stamp.rect[3]) + "]\n" +
                    "整个 grid 超出了 Illustrator 合法画布区域。\n" +
                    "请把源画板移到画布中心区域、减少数量、调小 MAX_ROW_WIDTH，" +
                    "或切到 Large Format 后重跑。\n" +
                    "（文档已被部分修改但未保存，请用 Ctrl+Z 撤销，或直接打开备份文件。）");
            }
            newAb.name = t.base + "_" + pad(stamp.j, padWidth(t.count));
            totalStamps++;
        }

        // ---- 7. 删除原始 artwork + 原始 target 画板 ----
        for (i = 0; i < targets.length; i++)
            for (var n = 0; n < targets[i].items.length; n++)
                try { targets[i].items[n].remove(); } catch (e) {}

        var idxs = [];
        for (i = 0; i < targets.length; i++) idxs.push(targets[i].abIndex);
        idxs.sort(function (a, b) { return b - a; });          // 高 -> 低
        for (i = 0; i < idxs.length; i++)
            try { doc.artboards.remove(idxs[i]); } catch (e) {}

        try { doc.artboards.setActiveArtboardIndex(0); } catch (e) {}
        doc.selection = null;

        // ---- 8. 汇报 ----
        var summary = [];
        for (i = 0; i < targets.length; i++)
            summary.push(targets[i].base + " ×" + targets[i].count);

        var msg = "完成！共生成 " + totalStamps + " 个画板：\n  " + summary.join("、") +
                  "\n\ngutter = " + GUTTER_PT + "pt 真实间距" +
                  (sf !== 1 ? "（Large Canvas scaleFactor=" + sf + "，已自动换算）" : "") +
                  "\n\n备份已存：\n  " + backupFile.fsName +
                  "\n\n⚠ 当前结果尚未保存，请检查后手动另存（建议另存新文件）。";
        if (skipped.length > 0)
            msg += "\n\n以下画板未标注 <n>x，已原样保留，请手动检查：\n" + listSkipped(skipped);
        alert(msg);
    }

    // ===================== helpers =====================

    // 探测画布的绝对边界，返回 {left, top, right, bottom}(artboardRect 坐标，y 向上)，
    // 失败返回 null。原理：新建空 pathItem 默认落在画布左上角附近，由此反推画布角。
    // (改编自 Sergey Osokin "Absolute artboard coordinates"。坐标全是 API 内部单位，
    //  画布恒为 16383 单位见方，普通 / large canvas 通用。)
    function getCanvasBounds(refRect) {
        try {
            var aLayer = doc.activeLayer;
            var fakePath = aLayer.pathItems.add();
            var cnvsDelta = 1 + ((fakePath.position[0] * 2 - 16384) -
                                 (fakePath.position[1] * 2 + 16384)) / 2;
            var pp = [fakePath.position[0] - cnvsDelta, fakePath.position[1] + cnvsDelta];
            var cnvsPath = aLayer.pathItems.rectangle(pp[0], pp[1], 300, 300);
            cnvsPath.filled = false; cnvsPath.stroked = false;
            var w = refRect[2] - refRect[0], h = refRect[1] - refRect[3];
            var abPath = aLayer.pathItems.rectangle(refRect[1], refRect[0], w, h);
            abPath.filled = false; abPath.stroked = false;
            var absLeft = abPath.position[0] - cnvsPath.position[0];
            var absTop  = cnvsPath.position[1] - abPath.position[1];
            fakePath.remove(); cnvsPath.remove(); abPath.remove();

            if (absLeft < -2 || absTop < -2 || absLeft > 16385 || absTop > 16385) return null;
            var cl = refRect[0] - absLeft;
            var ct = refRect[1] + absTop;
            // 自检：参考画板必须确实落在算出来的画布框内，否则判定为探测失败
            if (refRect[0] < cl - 2 || refRect[2] > cl + 16383 + 2 ||
                refRect[1] > ct + 2 || refRect[3] < ct - 16383 - 2) return null;
            return { left: cl, top: ct, right: cl + 16383, bottom: ct - 16383 };
        } catch (e) { return null; }
    }

    // 解析 "A 10x" / "D15x" -> {count, base, ...}；取最后一个 <n>x；无匹配返回 null
    function parseCount(name) {
        var re = /(\d+)x/g, m, last = null;
        while ((m = re.exec(name)) !== null) last = m;
        if (last === null) return null;
        var base = (name.substring(0, last.index) +
                    name.substring(last.index + last[0].length)).replace(/^\s+|\s+$/g, "");
        if (base === "") base = "AB";
        return { count: parseInt(last[1], 10), base: base };
    }

    // 找出真实几何(含 clip 隐藏内容)跨越 >1 个 target 画板的对象
    function findIntrusions(targets) {
        var offenders = [];
        for (var li = 0; li < doc.layers.length; li++)
            processLayer(doc.layers[li], targets, offenders);
        return offenders;
    }

    function processLayer(L, targets, offenders) {
        if (!L.visible || L.locked) return;          // 不可选 -> 不会被捕获，跳过
        var i;
        for (i = 0; i < L.pageItems.length; i++) {
            var pi = L.pageItems[i];
            if (pi.parent !== L) continue;           // 只看直接子项（顶层对象）
            if (pi.hidden || pi.locked) continue;
            var acc = { fp: null, hasClip: false };
            gatherLeaves(pi, acc);
            if (!acc.fp) continue;
            var touched = 0;
            for (var t = 0; t < targets.length; t++)
                if (intersects(acc.fp, targets[t].rect, INTERSECT_TOL)) touched++;
            if (touched > 1) offenders.push({ item: pi, hasClip: acc.hasClip, fp: acc.fp });
        }
        for (i = 0; i < L.layers.length; i++) processLayer(L.layers[i], targets, offenders);
    }

    // 递归收集叶子节点的真实 geometricBounds（含被裁掉的隐藏内容）
    function gatherLeaves(item, acc) {
        var tn = item.typename;
        if (tn === "GroupItem") {
            if (item.clipped) acc.hasClip = true;
            for (var k = 0; k < item.pageItems.length; k++) gatherLeaves(item.pageItems[k], acc);
        } else if (tn === "CompoundPathItem") {
            for (var p = 0; p < item.pathItems.length; p++) gatherLeaves(item.pathItems[p], acc);
        } else {
            if (item.clipping === true) acc.hasClip = true; // 蒙版本身
            try { acc.fp = unionB(acc.fp, item.geometricBounds); } catch (e) {}
        }
    }

    // bounds = [L, T, R, B]，T > B
    function unionB(a, b) {
        if (!a) return [b[0], b[1], b[2], b[3]];
        return [Math.min(a[0], b[0]), Math.max(a[1], b[1]),
                Math.max(a[2], b[2]), Math.min(a[3], b[3])];
    }

    function intersects(a, b, tol) {
        if (a[2] - b[0] <= tol) return false; // a 在 b 左
        if (b[2] - a[0] <= tol) return false; // a 在 b 右
        if (a[1] - b[3] <= tol) return false; // a 在 b 下
        if (b[1] - a[3] <= tol) return false; // a 在 b 上
        return true;
    }

    function pad(n, width) { var s = String(n); while (s.length < width) s = "0" + s; return s; }
    function padWidth(count) { var w = String(count).length; return w < 2 ? 2 : w; }

    function listSkipped(skipped) {
        var out = [];
        for (var i = 0; i < skipped.length; i++)
            out.push("  • " + skipped[i].name + "  (" + skipped[i].reason + ")");
        return out.join("\n");
    }

    function tstamp() {
        var d = new Date();
        function p(x) { return (x < 10 ? "0" : "") + x; }
        return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" +
               p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }

})();
