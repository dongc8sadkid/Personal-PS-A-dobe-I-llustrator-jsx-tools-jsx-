/*
    LinkLabeler_NameOrAmount.jsx
    --------------------------------------------------------------------
    Tags every LINKED file in the active Illustrator doc with a text label
    pinned to its top-left corner, for later "Select > Same > Fill Color"
    harvesting.

    Label style : ArialMT, 24 pt, fill C0 M99 Y0 K0 (99% Magenta), no stroke.
    Labels live on a dedicated layer "LinkLabels".
    To clean up everything: just delete that layer (one action).

    On run you choose:
      - Paste full name : "<filename.ext>"
      - Paste amount    : the "<N>pcs" / "<N>pc" token pulled from the name.
                          0 matches OR >1 matches  ->  falls back to full name.

    Behaviour / assumptions
    -----------------------
      * CMYK documents only (aborts on RGB so the magenta stays exact).
      * Only LINKED art (placedItems) is processed; embedded art is skipped.
      * Items that are hidden OR locked -- or sit on a hidden/locked layer or
        group -- are skipped. Lock/hide things you don't want labelled.
      * Amount match is case-insensitive (pc/PC/pcs/PCS/Pcs all count).
      * Separator between number and pc/pcs: none or space(s) only.
        Underscore / hyphen do NOT count as a separator.
      * The number = the run of consecutive digits directly before pc/pcs.
        Walking left, the first non-digit ends it.
      * The matched field is pasted verbatim (original case + inner space kept).
      * SAFETY GUARD: pc/pcs must not be glued to another letter, so "pcb",
        "pcr" etc. won't match. Want looser matching? Delete the (?![a-z])
        lookahead marked below in extractAmount().

    Chao Dong feat. LLMs
*/

#target illustrator

(function () {

    // ----------------------------- config -----------------------------
    var CFG = {
        layerName : "LinkLabels",
        fontName  : "ArialMT",   // Arial Regular PostScript name (Win & Mac)
        fontSize  : 24,
        offsetPt  : 2,           // inward nudge from the image's top-left corner
        magenta   : 99           // 0-100  (sentinel colour C0 M99 Y0 K0)
    };

    // ----------------------------- guards -----------------------------
    if (app.documents.length === 0) { alert("No document open."); return; }
    var doc = app.activeDocument;

    if (doc.documentColorSpace !== DocumentColorSpace.CMYK) {
        alert("This script needs a CMYK document.\nCurrent doc is RGB \u2014 aborting.");
        return;
    }
    if (doc.placedItems.length === 0) {
        alert("No linked (placed) items found in this document.");
        return;
    }

    // ------------------------- ask: name | amount ---------------------
    var mode = askMode();                 // "full" | "amount" | null (cancel)
    if (mode === null) return;

    // ----------------------------- layer ------------------------------
    var layer = getOrMakeLayer(CFG.layerName);
    layer.locked  = false;
    layer.visible = true;

    // ----------------------------- font -------------------------------
    var font = null, fontMissing = false;
    try { font = app.textFonts.getByName(CFG.fontName); }
    catch (e) { fontMissing = true; }

    // ---------------------------- colours -----------------------------
    var fill = new CMYKColor();
    fill.cyan = 0; fill.magenta = CFG.magenta; fill.yellow = 0; fill.black = 0;
    var noStroke = new NoColor();

    // ------------------------------ run -------------------------------
    var items = doc.placedItems;
    var made = 0, skipped = 0, fellBack = 0, broken = 0;

    for (var i = 0; i < items.length; i++) {
        var pi = items[i];

        if (hiddenOrLocked(pi)) { skipped++; continue; }

        var fname;
        try { fname = decodeURI(pi.file.name); }
        catch (e1) {
            try { fname = pi.file.name; }
            catch (e2) { broken++; continue; }     // missing / broken link
        }

        var label;
        if (mode === "full") {
            label = fname;
        } else {
            var amt = extractAmount(fname);
            if (amt === null) { label = fname; fellBack++; }  // 0 or >1 -> full name
            else              { label = amt; }
        }

        var b = pi.visibleBounds;            // [left, top, right, bottom], top > bottom
        makeLabel(layer, label,
                  b[0] + CFG.offsetPt,       // x: right of left edge
                  b[1] - CFG.offsetPt,       // y: below top edge
                  font, CFG.fontSize, fill, noStroke);
        made++;
    }

    doc.selection = null;

    // ---------------------------- report ------------------------------
    var msg = "Done.\n\n"
            + "Labelled:                " + made + "\n"
            + "Skipped (hidden/locked): " + skipped + "\n"
            + "Broken links skipped:    " + broken;
    if (mode === "amount")
        msg += "\nFell back to full name (0 or >1 match): " + fellBack;
    if (fontMissing)
        msg += "\n\nWARNING: font '" + CFG.fontName + "' not found \u2014 used default font.";
    msg += "\n\nTo remove all tags: delete the '" + CFG.layerName + "' layer.";
    alert(msg);


    // =========================== helpers ==============================

    function askMode() {
        var dlg = new Window("dialog", "Link Labeler");
        dlg.alignChildren = "fill";

        var p = dlg.add("panel", undefined, "What to paste:");
        p.alignChildren = "left";
        p.margins = 16;
        var rFull = p.add("radiobutton", undefined, "Paste full name  (with extension)");
        var rAmt  = p.add("radiobutton", undefined, "Paste amount  (NNpcs / NNpc)");
        rFull.value = true;

        var g = dlg.add("group");
        g.alignment = "right";
        var ok = g.add("button", undefined, "Run", { name: "ok" });
        g.add("button", undefined, "Cancel", { name: "cancel" });

        var out = null;
        ok.onClick = function () { out = rAmt.value ? "amount" : "full"; dlg.close(1); };
        dlg.show();                          // Cancel/Esc/close -> out stays null
        return out;
    }

    function extractAmount(name) {
        // (\d+)        consecutive digits (the natural number)
        // \s*          optional space(s) only  (no _ or -)
        // (pcs?)       "pc" or "pcs", any case via /i
        // (?![a-z])    <-- SAFETY GUARD: pc/pcs not glued to another letter.
        //                  Delete this lookahead for looser matching.
        var re = /(\d+)\s*(pcs?)(?![a-z])/gi;
        var hits = [], m;
        while ((m = re.exec(name)) !== null) hits.push(m[0]);
        return (hits.length === 1) ? hits[0] : null;   // exactly one wins
    }

    function getOrMakeLayer(nm) {
        for (var i = 0; i < doc.layers.length; i++)
            if (doc.layers[i].name === nm) return doc.layers[i];
        var l = doc.layers.add();
        l.name = nm;
        return l;
    }

    function hiddenOrLocked(item) {
        var o = item;
        while (o && o.typename !== "Document") {
            if (o.locked === true) return true;          // pageItems, groups, layers
            if (o.typename === "Layer") {
                if (o.visible === false) return true;     // layer hidden
            } else {
                if (o.hidden === true) return true;       // pageItem / group hidden
            }
            o = o.parent;
        }
        return false;
    }

    function makeLabel(layer, txt, x, yTop, font, size, fill, noStroke) {
        var tf = layer.textFrames.add();      // point text
        tf.contents = txt;
        var ca = tf.textRange.characterAttributes;
        if (font) ca.textFont = font;
        ca.size        = size;
        ca.fillColor   = fill;
        ca.strokeColor = noStroke;
        tf.left = x;                           // position AFTER styling
        tf.top  = yTop;
    }

})();
