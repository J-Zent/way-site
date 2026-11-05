/*
 * export.js: download the map sheet as SVG, PNG or PDF, at its true paper size.
 *
 * Fonts travel with the file: the SVG carries DM Mono inside it, the PDF embeds it, and the PNG
 * is drawn with it. So a print shop or another computer never swaps in a different font.
 *
 *   MapExport.download("pdf", svgElement, { name: "friday-harbor-a3", dpi: 300, onStatus })
 *   MapExport.svgText(svgElement)  // for Copy
 */
(function (root) {
  "use strict";
  const BASE = "/maps/";
  const FONTS = [
    { file: "DMMono-Regular.ttf", weight: 400, style: "normal", pdf: "normal" },
    { file: "DMMono-Medium.ttf", weight: 500, style: "normal", pdf: "500normal" },
    { file: "DMMono-Italic.ttf", weight: 400, style: "italic", pdf: "italic" },
    { file: "DMMono-MediumItalic.ttf", weight: 500, style: "italic", pdf: "500italic" }
  ];
  const fontCache = {};

  function b64(buf) {
    const u8 = new Uint8Array(buf); let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function fonts() {
    await Promise.all(FONTS.map(async f => {
      if (fontCache[f.file]) return;
      const res = await fetch(BASE + "fonts/" + f.file);
      if (!res.ok) throw new Error("Couldn't load the map font (" + res.status + ")");
      fontCache[f.file] = b64(await res.arrayBuffer());
    }));
    return FONTS.map(f => ({ ...f, data: fontCache[f.file] }));
  }
  function loadScript(src) {
    return new Promise((ok, bad) => {
      if (document.querySelector(`script[src="${src}"]`)) return ok();
      const s = document.createElement("script"); s.src = src; s.onload = ok;
      s.onerror = () => bad(new Error("Couldn't load the PDF tools"));
      document.head.appendChild(s);
    });
  }

  // A clean copy of the sheet: no drag offset left on the map.
  function cleanClone(svg) {
    const c = svg.cloneNode(true);
    c.removeAttribute("style");
    const pan = c.querySelector(".pan"); if (pan) pan.removeAttribute("transform");
    c.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return c;
  }
  function paperMM(svg) {
    return { w: parseFloat(svg.getAttribute("width")), h: parseFloat(svg.getAttribute("height")) };
  }
  async function svgText(svg, withFonts) {
    const c = cleanClone(svg);
    if (withFonts) {
      const fs = await fonts();
      const css = fs.map(f => `@font-face{font-family:"DM Mono";font-weight:${f.weight};font-style:${f.style};src:url(data:font/ttf;base64,${f.data}) format("truetype")}`).join("");
      const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
      style.textContent = css;
      const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
      defs.appendChild(style);
      c.insertBefore(defs, c.firstChild);
    }
    return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(c);
  }

  function save(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  // ---------- PNG ----------
  async function png(svg, dpi) {
    const { w, h } = paperMM(svg);
    // keep within what browsers can draw: no side over 16,000 px, no more than ~60 megapixels
    let px = dpi / 25.4, W = Math.round(w * px), H = Math.round(h * px);
    const k = Math.min(1, 16000 / Math.max(W, H), Math.sqrt(60e6 / (W * H)));
    W = Math.round(W * k); H = Math.round(H * k);
    const text = (await svgText(svg, true)).replace(/<svg([^>]*?) width="[^"]*" height="[^"]*"/, `<svg$1 width="${W}" height="${H}"`);
    const url = URL.createObjectURL(new Blob([text], { type: "image/svg+xml" }));
    try {
      const img = new Image(); img.src = url;
      await img.decode();
      await new Promise(r => setTimeout(r, 120));          // let embedded fonts settle
      const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
      const ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0, W, H);
      const blob = await new Promise(r => cv.toBlob(r, "image/png"));
      if (!blob) throw new Error("This map is too large for a PNG in this browser. Try PDF, or 150 dpi.");
      return { blob, dpi: Math.round(dpi * k), W, H };
    } finally { URL.revokeObjectURL(url); }
  }

  // ---------- PDF ----------
  // svg2pdf draws text but not text set along a path, and not halos drawn under the letters.
  // So, from the live sheet, every letter is placed at its exact position, and haloed text is
  // split into a halo copy (stroke) under a plain copy (fill).
  function flattenText(liveSvg, clone) {
    const live = liveSvg.querySelectorAll("text"), copies = clone.querySelectorAll("text");
    const NS = "http://www.w3.org/2000/svg";
    for (let i = 0; i < live.length; i++) {
      const t = live[i], c = copies[i], n = t.getNumberOfChars();
      const cs = getComputedStyle(t);
      const g = document.createElementNS(NS, "g");
      const tf = t.getAttribute("transform"); if (tf) g.setAttribute("transform", tf);
      const base = { "font-family": "DM Mono", "font-size": cs.fontSize, "font-weight": cs.fontWeight, "font-style": cs.fontStyle };
      const halo = cs.paintOrder && /^stroke/.test(cs.paintOrder.trim()) && cs.stroke !== "none" && parseFloat(cs.strokeWidth) > 0;
      const layers = halo
        ? [{ fill: "none", stroke: cs.stroke, "stroke-width": cs.strokeWidth, "stroke-opacity": cs.strokeOpacity, "stroke-linejoin": "round" },
           { fill: cs.fill, "fill-opacity": cs.fillOpacity, stroke: "none" }]
        : [{ fill: cs.fill, "fill-opacity": cs.fillOpacity, stroke: "none" }];
      const chars = [];
      for (let k = 0; k < n; k++) {
        let p, r;
        try { p = t.getStartPositionOfChar(k); r = t.getRotationOfChar(k); } catch (e) { continue; }
        const ch = t.textContent[k]; if (!ch || ch === " ") continue;
        chars.push({ ch, x: p.x, y: p.y, r });
      }
      for (const L of layers) {
        const lg = document.createElementNS(NS, "g");
        for (const [k, v] of Object.entries({ ...base, ...L })) if (v != null && v !== "") lg.setAttribute(k, v);
        for (const ch of chars) {
          const e = document.createElementNS(NS, "text");
          e.setAttribute("x", ch.x.toFixed(2)); e.setAttribute("y", ch.y.toFixed(2));
          if (Math.abs(ch.r) > 0.01) e.setAttribute("transform", `rotate(${ch.r.toFixed(2)} ${ch.x.toFixed(2)} ${ch.y.toFixed(2)})`);
          e.textContent = ch.ch;
          lg.appendChild(e);
        }
        g.appendChild(lg);
      }
      c.parentNode.replaceChild(g, c);
    }
    clone.querySelectorAll("defs path[id]").forEach(p => { if (!clone.querySelector(`[href="#${p.id}"]`)) p.remove(); });
  }
  async function pdf(svg) {
    await loadScript(BASE + "lib/jspdf.umd.min.js");
    await loadScript(BASE + "lib/svg2pdf.umd.min.js");
    const fs = await fonts();
    const { w, h } = paperMM(svg);
    const doc = new root.jspdf.jsPDF({ unit: "mm", format: [w, h], orientation: w > h ? "landscape" : "portrait", compress: true });
    for (const f of fs) { doc.addFileToVFS(f.file, f.data); doc.addFont(f.file, "DM Mono", f.pdf); }
    // measuring needs the live sheet with the drag offset removed
    const pan = svg.querySelector(".pan"), old = pan && pan.getAttribute("transform");
    if (pan) pan.removeAttribute("transform");
    const clone = cleanClone(svg);
    try { flattenText(svg, clone); } finally { if (pan && old) pan.setAttribute("transform", old); }
    const holder = document.createElement("div");
    holder.style.cssText = "position:absolute;left:-99999px;top:0;width:10px;height:10px;overflow:hidden";
    holder.appendChild(clone); document.body.appendChild(holder);
    try { await doc.svg(clone, { x: 0, y: 0, width: w, height: h }); }
    finally { holder.remove(); }
    return doc.output("blob");
  }

  async function download(format, svg, o = {}) {
    const say = o.onStatus || (() => {});
    const name = (o.name || "map").replace(/[^a-z0-9-]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "map";
    if (format === "svg") {
      say("Preparing SVG…");
      save(new Blob([await svgText(svg, true)], { type: "image/svg+xml" }), name + ".svg");
      return "SVG downloaded, at the paper's real size with its fonts inside.";
    }
    if (format === "png") {
      say("Drawing PNG…");
      const r = await png(svg, o.dpi || 300);
      save(r.blob, name + ".png");
      return `PNG downloaded: ${r.W.toLocaleString()} × ${r.H.toLocaleString()} px (${r.dpi} dpi${r.dpi < (o.dpi || 300) ? ", the most this browser allows at this size" : ""}).`;
    }
    say("Building PDF…");
    save(await pdf(svg), name + ".pdf");
    return "PDF downloaded: vector, at the paper's real size, fonts embedded.";
  }

  root.MapExport = { download, svgText };
})(window);
