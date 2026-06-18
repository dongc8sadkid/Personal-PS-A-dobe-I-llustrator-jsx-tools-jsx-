#target illustrator
/*
 * MultiArtboard_RegDots_NameNote.jsx   (v2)
 * -----------------------------------------------------------------------------
 * For EVERY artboard in the active document:
 *
 *  1) Register dots -> layer "Register"
 *     - 0.235" dia, Fill K100, no stroke.
 *     - WHOLE circle TANGENT INSIDE each edge (nothing pokes out / floats).
 *     - Max center-to-center gap <= 49"; tightened to <= 24" for any artboard
 *       whose width OR height exceeds 98".
 *     - CORNER CLUSTERS: each edge-end gets 0-4 dots packed close (~2-9" gaps,
 *       e.g. 4-4-4 or 2-8) so the layout reads as obviously irregular from afar.
 *       The two ends of an edge are randomized independently, every edge & board
 *       is independent -> visibly non-even.
 *     - Middle of long edges filled with IRREGULAR (jittered) spacing, gap<=24".
 *     - Overlaps deduped. Small board (only the 4 corners) -> delete one corner.
 *     - HARD non mirror-symmetry on BOTH axes (verified + nudged if needed).
 *     - No two artboards share an identical LOCAL dot pattern.
 *
 *  2) Naming: each artboard gets a label "P{index}- (NNNNNNNN)" where {index}
 *     is the 1-based artboard order and NNNNNNNN is a unique random 8-digit id
 *     (leading zeros ok). artboard.name is set to this exact label.
 *
 *  3) Note label -> layer "note"
 *     - The SAME label "P{index}- (NNNNNNNN)" at the bottom-center of each
 *       artboard, Arial 18pt PHYSICAL, Fill M100, fully inside, hugging bottom.
 *     - If it overlaps a bottom-edge dot it slides SIDEWAYS into the nearest
 *       clear gap (never raised, so it can't drift toward the cut/crease zone).
 *
 * Large-canvas aware via doc.scaleFactor (1 normal / 10 large; API coords come
 * back at 1/SF). All physical constants are divided by SF -> dots stay a true
 * 0.235", clusters a true ~4", text a true 18pt. CC2019- -> undefined -> 1.
 *
 * Re-runnable: clears the Register and note layers each run. CMYK documents.
 * -----------------------------------------------------------------------------
 */

(function () {
    if (app.documents.length === 0) { alert("Open a document first."); return; }
    var doc = app.activeDocument;

    // ---- CONFIG ------------------------------------------------------------
    var IN        = 72;
    var SF        = doc.scaleFactor || 1;
    var DOT_DIA   = 0.235 * IN / SF;
    var DOT_R     = DOT_DIA / 2;
    var GAP_STD   = 49 * IN / SF;           // default max center-to-center gap
    var GAP_BIG   = 24 * IN / SF;           // tighter gap when a board is huge
    var BIG_EDGE  = 98 * IN / SF;           // any edge > this (real ") -> use GAP_BIG
    var FONT_PT   = 18 / SF;
    var FONT_NM   = "ArialMT";
    var SLIDE_MIN = 0.4 * IN / SF;          // symmetry-break nudge range (rarely used)
    var SLIDE_MAX = 1.0 * IN / SF;
    var EPS       = 0.001 * IN;

    // corner cluster gap menus (inches, inward from the corner)
    var CL_SEQS_IN = [
        [4],[4,4],[4,4,4],
        [2,8],[8,2],[2,8,2],
        [3,6],[6,3],[3,6,3],
        [4,9],[9,4],[2,5,9]
    ];

    function mkCMYK(c,m,y,k){ var col=new CMYKColor(); col.cyan=c; col.magenta=m; col.yellow=y; col.black=k; return col; }
    var COL_DOT  = mkCMYK(0,0,0,100);       // K100
    var COL_TEXT = mkCMYK(0,100,0,0);       // M100

    // ---- layer helpers -----------------------------------------------------
    function getLayer(name){
        for (var i=0;i<doc.layers.length;i++){ if (doc.layers[i].name===name) return doc.layers[i]; }
        var L=doc.layers.add(); L.name=name; return L;
    }
    function resetLayer(name){
        var L=getLayer(name); L.locked=false; L.visible=true;
        for (var i=L.pageItems.length-1;i>=0;i--){ L.pageItems[i].remove(); }
        return L;
    }
    var regLayer  = resetLayer("Register");
    var noteLayer = resetLayer("note");

    // ---- font --------------------------------------------------------------
    var theFont=null, fontWarned=false;
    try { theFont=app.textFonts.getByName(FONT_NM); }
    catch(e1){ try { theFont=app.textFonts.getByName("Arial"); } catch(e2){ theFont=null; } }

    // ---- utils -------------------------------------------------------------
    function rk(v){ return Math.round(v/EPS); }
    function dist(a,b){ var dx=a.x-b.x, dy=a.y-b.y; return Math.sqrt(dx*dx+dy*dy); }
    function clampNum(v,a,b){ return v<a?a:(v>b?b:v); }

    function pickSeq(){
        if (Math.random()<0.15) return [];                 // occasional bare corner
        var s=CL_SEQS_IN[Math.floor(Math.random()*CL_SEQS_IN.length)];
        var o=[]; for (var i=0;i<s.length;i++) o.push(s[i]*IN/SF);
        return o;
    }

    // along-edge positions for ONE edge in [lo,hi]: corner clusters + irregular fill
    function edgeDots(lo, hi, maxGap){
        var U = hi - lo;
        if (U <= EPS) return [(lo+hi)/2];

        var out = [];
        var clusterCap = Math.min(U*0.45, 16*IN/SF);   // how far inward a cluster may reach
        var minSep = 1.0*IN/SF;

        // lo-end cluster, grows inward
        var loSeq = pickSeq();
        var p = lo; out.push(p);
        for (var i=0;i<loSeq.length;i++){
            p += loSeq[i];
            if (p - lo <= clusterCap && p < hi - minSep) out.push(p); else break;
        }
        var loInner = out[out.length-1];

        // hi-end cluster, grows inward
        var hiSeq = pickSeq();
        var q = hi; var hiPts=[q];
        for (var j=0;j<hiSeq.length;j++){
            q -= hiSeq[j];
            if (hi - q <= clusterCap && q > loInner + minSep) hiPts.push(q); else break;
        }
        var hiInner = hiPts[hiPts.length-1];

        // irregular middle fill so every gap <= maxGap (0.7 headroom + 40% jitter
        // keeps worst-case gap <= ~0.98*maxGap without any clamping)
        var span = hiInner - loInner;
        if (span > maxGap){
            var n = Math.ceil(span / (maxGap*0.7));
            var base = span / n;
            for (var m=1;m<n;m++){
                var jit = (Math.random()-0.5) * base * 0.8;
                out.push(loInner + m*base + jit);
            }
        }
        for (var h=0;h<hiPts.length;h++) out.push(hiPts[h]);
        return out;
    }

    function dedupe(dots){
        var out=[];
        for (var i=0;i<dots.length;i++){
            var keep=true;
            for (var j=0;j<out.length;j++){ if (dist(dots[i],out[j]) < DOT_DIA-EPS){ keep=false; break; } }
            if (keep) out.push(dots[i]);
        }
        return out;
    }

    function mirrorSym(dots,cx,cy){
        var keys={};
        for (var i=0;i<dots.length;i++){ keys[rk(dots[i].x)+","+rk(dots[i].y)]=true; }
        var v=true,h=true;
        for (var j=0;j<dots.length;j++){
            if (v && !keys[rk(2*cx-dots[j].x)+","+rk(dots[j].y)]) v=false;
            if (h && !keys[rk(dots[j].x)+","+rk(2*cy-dots[j].y)]) h=false;
            if (!v && !h) break;
        }
        return { v:v, h:h };
    }

    function slideAlongEdge(d,L,T,R,B){
        var amt=(Math.random()<0.5?-1:1) * (SLIDE_MIN + Math.random()*(SLIDE_MAX-SLIDE_MIN));
        var onTB=(Math.abs(d.y-(T-DOT_R))<EPS)||(Math.abs(d.y-(B+DOT_R))<EPS);
        var onLR=(Math.abs(d.x-(L+DOT_R))<EPS)||(Math.abs(d.x-(R-DOT_R))<EPS);
        if (onTB){ var lo=L+DOT_R,hi=R-DOT_R,nx=d.x+amt; d.x=clampNum(nx,lo,hi); }
        else if (onLR){ var lo2=B+DOT_R,hi2=T-DOT_R,ny=d.y+amt; d.y=clampNum(ny,lo2,hi2); }
    }

    function localKey(dots,L,B){
        var arr=[];
        for (var i=0;i<dots.length;i++){ arr.push(rk(dots[i].x-L)+":"+rk(dots[i].y-B)); }
        arr.sort(); return arr.join("|");
    }

    function buildDots(rect, seenKeys, maxGap){
        var L=rect[0],T=rect[1],R=rect[2],B=rect[3];
        var cx=(L+R)/2, cy=(T+B)/2;

        function ring(){
            var raw=[], a, k;
            a=edgeDots(L+DOT_R, R-DOT_R, maxGap); for(k=0;k<a.length;k++) raw.push({x:a[k], y:T-DOT_R}); // top
            a=edgeDots(L+DOT_R, R-DOT_R, maxGap); for(k=0;k<a.length;k++) raw.push({x:a[k], y:B+DOT_R}); // bottom
            a=edgeDots(B+DOT_R, T-DOT_R, maxGap); for(k=0;k<a.length;k++) raw.push({x:L+DOT_R, y:a[k]}); // left
            a=edgeDots(B+DOT_R, T-DOT_R, maxGap); for(k=0;k<a.length;k++) raw.push({x:R-DOT_R, y:a[k]}); // right
            return dedupe(raw);
        }

        var attempts=0, dots;
        do {
            attempts++;
            dots = ring();

            if (dots.length<=4){                                   // tiny board: 4 corners
                if (dots.length>0) dots.splice(Math.floor(Math.random()*dots.length),1); // drop one corner
                if (dots.length>0) slideAlongEdge(dots[Math.floor(Math.random()*dots.length)], L,T,R,B);
            }

            // HARD guarantee: not mirror-symmetric on either axis
            var guard=0;
            while (guard++<8){
                var sym=mirrorSym(dots,cx,cy);
                if (!sym.v && !sym.h) break;
                slideAlongEdge(dots[Math.floor(Math.random()*dots.length)], L,T,R,B);
            }

            dots = dedupe(dots);
            var key = localKey(dots,L,B);
            if (!seenKeys[key]){ seenKeys[key]=true; return dots; }
        } while (attempts<16);

        return dots;
    }

    // text horizontal clear: nearest center X (to cx) that keeps the text 'reach'
    // away from every bottom-edge dot, staying inside [loB,hiB]. null if no slot.
    function findClearX(cx, reach, xs, loB, hiB){
        if (loB > hiB) return null;
        var ints=[];
        for (var i=0;i<xs.length;i++){
            var a=xs[i]-reach, b=xs[i]+reach;
            if (b<loB || a>hiB) continue;
            ints.push([Math.max(a,loB), Math.min(b,hiB)]);
        }
        if (ints.length===0) return clampNum(cx, loB, hiB);
        ints.sort(function(p,q){ return p[0]-q[0]; });
        var merged=[ints[0].slice()];
        for (var k=1;k<ints.length;k++){
            var last=merged[merged.length-1];
            if (ints[k][0] <= last[1]+EPS) last[1]=Math.max(last[1],ints[k][1]);
            else merged.push(ints[k].slice());
        }
        var feas=[], cur=loB;
        for (var f=0;f<merged.length;f++){
            if (merged[f][0]-EPS > cur) feas.push([cur, merged[f][0]]);
            cur=Math.max(cur, merged[f][1]);
        }
        if (cur < hiB-EPS) feas.push([cur, hiB]);
        if (feas.length===0) return null;
        var best=null, bestD=1e18;
        for (var g=0;g<feas.length;g++){
            var cand=clampNum(cx, feas[g][0], feas[g][1]);
            var dd=Math.abs(cand-cx);
            if (dd<bestD){ bestD=dd; best=cand; }
        }
        return best;
    }

    // ---- main loop ---------------------------------------------------------
    var abs=doc.artboards;
    var seenKeys={}, usedIds={}, totalDots=0;

    function gen8(){ var s=""; for(var k=0;k<8;k++) s+=String(Math.floor(Math.random()*10)); return s; }
    function uniqueId8(){ var s; do { s=gen8(); } while (usedIds[s]); usedIds[s]=true; return s; }

    for (var n=0;n<abs.length;n++){
        var rect=abs[n].artboardRect;            // [L,T,R,B], y up
        var L=rect[0], T=rect[1], R=rect[2], B=rect[3];
        var cx=(L+R)/2;
        var maxGap=((R-L)>BIG_EDGE || (T-B)>BIG_EDGE) ? GAP_BIG : GAP_STD;

        // dots
        var dots=buildDots(rect, seenKeys, maxGap);
        var boardDots=[];
        for (var d=0;d<dots.length;d++){
            var c=dots[d];
            var el=regLayer.pathItems.ellipse(c.y+DOT_R, c.x-DOT_R, DOT_DIA, DOT_DIA);
            el.stroked=false; el.filled=true; el.fillColor=COL_DOT;
            boardDots.push(c);
        }
        totalDots+=dots.length;

        // label "P{index}- (NNNNNNNN)" -- same string for artboard name + note
        var label = "P" + (n+1) + "- (" + uniqueId8() + ")";
        abs[n].name = label;

        // note label: centered, hugging bottom, fully inside
        var tf=noteLayer.textFrames.pointText([cx, B]);
        tf.contents=label;
        var ca=tf.textRange.characterAttributes;
        ca.size=FONT_PT;
        if (theFont) ca.textFont=theFont; else fontWarned=true;
        ca.fillColor=COL_TEXT;
        tf.textRange.paragraphAttributes.justification=Justification.CENTER;
        var gb=tf.geometricBounds; tf.translate(0, B-gb[3]);     // settle bottom onto edge

        // collision -> slide SIDEWAYS into nearest clear gap (never raise)
        gb=tf.geometricBounds;
        var halfW=(gb[2]-gb[0])/2;
        var reach=halfW + DOT_R + DOT_DIA*0.4;
        var bxs=[];
        for (var q=0;q<boardDots.length;q++){
            if (Math.abs(boardDots[q].y-(B+DOT_R)) < DOT_DIA) bxs.push(boardDots[q].x);
        }
        var newX=findClearX(cx, reach, bxs, L+halfW+EPS, R-halfW-EPS);
        if (newX!==null) tf.translate(newX-cx, 0);               // null => no slot, leave centered
    }

    var msg="Done.\nArtboards: "+abs.length+"\nRegister dots: "+totalDots+"\nscaleFactor: "+SF;
    if (fontWarned) msg+="\n\n(!) Arial not found - note text left in the default font. Install Arial or edit FONT_NM.";
    if (SF!==1)     msg+="\n\n(!) Large canvas (SF="+SF+"). Eyeball the 18pt note once; if it lands ~"+SF+"x off, flip the FONT_PT divide to a multiply.";
    alert(msg);
})();
