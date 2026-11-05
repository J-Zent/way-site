/*
 * omt.js: water and trails from OpenStreetMap, read from ready-made vector tiles.
 *
 * Tiles come from OpenFreeMap (OpenMapTiles schema). They are static files on a CDN, like
 * the elevation tiles, so a map needs a few dozen small downloads instead of a live
 * database search. Output has the same shape Water.render and Trails.render already use.
 *
 *   const { water, trails } = await OMT.load({ south, west, north, east }, { signal, onProgress });
 *
 * Every geometry is clipped to its own tile's square before it is used. Pieces of one lake
 * or one stream from neighbouring tiles then meet exactly at the tile edge without
 * overlapping: lines are joined back together end to end, and polygon edges that only
 * exist because of the tile cut are left out of the shoreline.
 *
 * Credit required on every map: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap".
 */
(function (root) {
  "use strict";
  const TILEJSON = "https://tiles.openfreemap.org/planet";
  const MAXZ = 14;
  let template = null;

  async function tileTemplate(signal) {
    if (template) return template;
    const res = await fetch(TILEJSON, { signal });
    if (!res.ok) throw new Error(`Map tiles index answered ${res.status}`);
    const tj = await res.json();
    if (!tj.tiles || !tj.tiles[0]) throw new Error("Map tiles index had no tile address");
    template = tj.tiles[0];
    return template;
  }

  // ---------- protobuf / Mapbox Vector Tile decoding ----------
  function reader(buf) {
    let pos = 0;
    const r = {
      get pos() { return pos; }, set pos(v) { pos = v; },
      varint() {
        let v = 0, shift = 0, b;
        do { b = buf[pos++]; v += (b & 0x7f) * Math.pow(2, shift); shift += 7; } while (b & 0x80);
        return v;
      },
      svarint() { const v = r.varint(); return v % 2 === 1 ? (v + 1) / -2 : v / 2; },
      bytes() { const n = r.varint(), s = buf.subarray(pos, pos + n); pos += n; return s; },
      string() { return new TextDecoder().decode(r.bytes()); },
      skip(type) {
        if (type === 0) r.varint();
        else if (type === 1) pos += 8;
        else if (type === 2) pos += r.varint();
        else if (type === 5) pos += 4;
        else throw new Error("Unknown protobuf field type " + type);
      }
    };
    return r;
  }
  function decodeValue(buf) {
    const r = reader(buf); let v = null;
    while (r.pos < buf.length) {
      const tag = r.varint(), f = tag >> 3, t = tag & 7;
      if (f === 1) v = r.string();
      else if (f === 2) { v = new DataView(buf.buffer, buf.byteOffset + r.pos, 4).getFloat32(0, true); r.pos += 4; }
      else if (f === 3) { v = new DataView(buf.buffer, buf.byteOffset + r.pos, 8).getFloat64(0, true); r.pos += 8; }
      else if (f === 4 || f === 5) v = r.varint();
      else if (f === 6) v = r.svarint();
      else if (f === 7) v = !!r.varint();
      else r.skip(t);
    }
    return v;
  }
  function decodeGeometry(cmds) {
    const rings = []; let ring = null, x = 0, y = 0, i = 0;
    while (i < cmds.length) {
      const c = cmds[i++], id = c & 7, n = c >> 3;
      if (id === 1 || id === 2) {
        for (let k = 0; k < n; k++) {
          const dx = cmds[i++], dy = cmds[i++];
          x += (dx >> 1) ^ -(dx & 1); y += (dy >> 1) ^ -(dy & 1);
          if (id === 1) { ring = [[x, y]]; rings.push(ring); } else ring.push([x, y]);
        }
      } else if (id === 7) { if (ring) ring.push(ring[0].slice()); }
    }
    return rings;
  }
  function decodeLayer(buf, want) {
    const r = reader(buf); const keys = [], vals = [], feats = []; let name = "", extent = 4096;
    while (r.pos < buf.length) {
      const tag = r.varint(), f = tag >> 3, t = tag & 7;
      if (f === 1) name = r.string();
      else if (f === 2) feats.push(r.bytes());
      else if (f === 3) keys.push(r.string());
      else if (f === 4) vals.push(decodeValue(r.bytes()));
      else if (f === 5) extent = r.varint();
      else r.skip(t);
    }
    if (!want.has(name)) return null;
    const out = [];
    for (const fb of feats) {
      const fr = reader(fb); let type = 0, tags = [], geom = [];
      while (fr.pos < fb.length) {
        const tag = fr.varint(), f = tag >> 3, t = tag & 7;
        if (f === 2 || f === 4) {
          const end = fr.varint() + fr.pos, arr = [];
          while (fr.pos < end) arr.push(fr.varint());
          if (f === 2) tags = arr; else geom = arr;
        } else if (f === 3) type = fr.varint();
        else fr.skip(t);
      }
      const props = {};
      for (let k = 0; k + 1 < tags.length; k += 2) props[keys[tags[k]]] = vals[tags[k + 1]];
      out.push({ type, props, rings: decodeGeometry(geom) });
    }
    return { name, extent, features: out };
  }
  function decodeTile(buf, want) {
    const r = reader(buf), layers = {};
    while (r.pos < buf.length) {
      const tag = r.varint(), f = tag >> 3, t = tag & 7;
      if (f === 3) { const L = decodeLayer(r.bytes(), want); if (L) layers[L.name] = L; }
      else r.skip(t);
    }
    return layers;
  }

  // ---------- clipping to the tile's own square ----------
  function clipPolygonRing(ring, E) {
    // Sutherland–Hodgman against [0, E] × [0, E]
    let pts = ring.slice(0, -1);
    const edges = [
      [p => p[0] >= 0, (a, b) => { const t = (0 - a[0]) / (b[0] - a[0]); return [0, a[1] + t * (b[1] - a[1])]; }],
      [p => p[0] <= E, (a, b) => { const t = (E - a[0]) / (b[0] - a[0]); return [E, a[1] + t * (b[1] - a[1])]; }],
      [p => p[1] >= 0, (a, b) => { const t = (0 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), 0]; }],
      [p => p[1] <= E, (a, b) => { const t = (E - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), E]; }]
    ];
    for (const [inside, cut] of edges) {
      if (!pts.length) break;
      const out = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[(i + pts.length - 1) % pts.length], b = pts[i];
        if (inside(b)) { if (!inside(a)) out.push(cut(a, b)); out.push(b); }
        else if (inside(a)) out.push(cut(a, b));
      }
      pts = out;
    }
    return pts.length >= 3 ? pts : null;
  }
  function clipLine(line, E) {
    const pieces = []; let cur = null;
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i], c = line[i + 1];
      let t0 = 0, t1 = 1; const dx = c[0] - a[0], dy = c[1] - a[1]; let ok = true;
      for (const [p, q] of [[-dx, a[0]], [dx, E - a[0]], [-dy, a[1]], [dy, E - a[1]]]) {
        if (p === 0) { if (q < 0) { ok = false; break; } continue; }
        const r = q / p;
        if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
        else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
      }
      if (!ok) { if (cur) { pieces.push(cur); cur = null; } continue; }
      const A = [a[0] + dx * t0, a[1] + dy * t0], B = [a[0] + dx * t1, a[1] + dy * t1];
      if (!cur) cur = [A];
      cur.push(B);
      if (t1 < 1) { pieces.push(cur); cur = null; }
    }
    if (cur) pieces.push(cur);
    return pieces.filter(p => p.length > 1);
  }
  const onEdge = (p, E) => p[0] <= 0.01 || p[0] >= E - 0.01 || p[1] <= 0.01 || p[1] >= E - 0.01;
  const sameEdge = (a, b, E) =>
    (a[0] <= 0.01 && b[0] <= 0.01) || (a[0] >= E - 0.01 && b[0] >= E - 0.01) ||
    (a[1] <= 0.01 && b[1] <= 0.01) || (a[1] >= E - 0.01 && b[1] >= E - 0.01);

  // ---------- tile maths ----------
  const lon2x = (lon, z) => (lon + 180) / 360 * 2 ** z;
  const lat2y = (lat, z) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z; };
  function toLonLat(tx, ty, z, E) {
    return p => {
      const n = 2 ** z, x = (tx + p[0] / E) / n, y = (ty + p[1] / E) / n;
      return [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI];
    };
  }

  // join line pieces whose ends meet (tile cuts), keeping name and kind together
  function joinLines(list) {
    const key = p => p[0].toFixed(6) + "," + p[1].toFixed(6);
    const groups = new Map();
    for (const l of list) { const g = l.group; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(l); }
    const out = [];
    for (const items of groups.values()) {
      const byStart = new Map(), byEnd = new Map();
      for (const l of items) { byStart.set(key(l.coords[0]), l); byEnd.set(key(l.coords[l.coords.length - 1]), l); }
      const used = new Set();
      for (const l of items) {
        if (used.has(l)) continue;
        // walk back to the start of this chain
        let head = l, guard = 0;
        while (guard++ < items.length) { const prev = byEnd.get(key(head.coords[0])); if (!prev || used.has(prev) || prev === l) break; head = prev; }
        let coords = head.coords.slice(); used.add(head);
        for (let nx = byStart.get(key(coords[coords.length - 1])); nx && !used.has(nx); nx = byStart.get(key(coords[coords.length - 1]))) {
          used.add(nx); coords = coords.concat(nx.coords.slice(1));
        }
        out.push({ ...head, coords });
      }
    }
    return out;
  }

  const TRAIL_SUB = /^(path|bridleway)$/;
  const WATERWAY = /^(river|stream|canal)$/;
  const SEA = /^(ocean|sea)$/;

  async function load(bbox, opts = {}) {
    const signal = opts.signal;
    const tpl = await tileTemplate(signal);
    // pick the most detailed zoom that keeps the download reasonable
    let z = MAXZ, tiles;
    for (;; z--) {
      const x0 = Math.floor(lon2x(bbox.west, z)), x1 = Math.floor(lon2x(bbox.east, z));
      const y0 = Math.floor(lat2y(bbox.north, z)), y1 = Math.floor(lat2y(bbox.south, z));
      tiles = [];
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push([x, y]);
      if (tiles.length <= (opts.maxTiles || 150) || z <= 8) break;
    }
    const want = new Set(["water", "waterway", "water_name", "transportation", "transportation_name"]);
    let done = 0;
    const results = await Promise.all(tiles.map(async ([x, y]) => {
      const url = tpl.replace("{z}", z).replace("{x}", x).replace("{y}", y);
      const res = await fetch(url, { signal });
      if (res.status === 204 || res.status === 404) return null;        // empty tile (open sea, no data)
      if (!res.ok) throw new Error(`Map tile ${z}/${x}/${y} answered ${res.status}`);
      const layers = decodeTile(new Uint8Array(await res.arrayBuffer()), want);
      done++; if (opts.onProgress) opts.onProgress(done / tiles.length);
      return { x, y, layers };
    }));

    const areas = [], sea = [], shore = [], lines = [], trailPieces = [], namePieces = [], names = [];
    // Rivers are mapped twice: a centre line and the outline of their banks. Past a few km across,
    // the banks are only a millimetre or two apart on paper, and their raw outline wobbles against the
    // smoothed centre line. There the centre line alone draws the river.
    const spanKm = Math.max((bbox.north - bbox.south) * 111.32, (bbox.east - bbox.west) * 111.32 * Math.cos((bbox.north + bbox.south) / 2 * Math.PI / 180));
    const riverBanks = spanKm <= (opts.riverBanksKm || 6);
    for (const t of results) {
      if (!t) continue;
      for (const [lname, L] of Object.entries(t.layers)) {
        const E = L.extent, ll = toLonLat(t.x, t.y, z, E);
        for (const f of L.features) {
          const p = f.props;
          if (lname === "water" && f.type === 3) {
            const isSea = SEA.test(p.class || ""), rings = [];
            for (const ring of f.rings) {
              const c = clipPolygonRing(ring, E);
              if (!c) continue;
              rings.push(c.map(ll));
              // shoreline: the ring's edges that are real, not the cut along the tile square
              let run = [];
              for (let i = 0; i < c.length; i++) {
                const a = c[i], b = c[(i + 1) % c.length];
                if (sameEdge(a, b, E)) { if (run.length > 1) shore.push(run.map(ll)); run = []; continue; }
                if (!run.length) run.push(a);
                run.push(b);
              }
              if (run.length > 1) shore.push(run.map(ll));
            }
            if (!rings.length) continue;
            // continues into a neighbouring tile, or a sea: treat as big water (hatched)
            const crosses = f.rings.some(r => r.some(q => q[0] < 0 || q[0] > E || q[1] < 0 || q[1] > E));
            if (isSea) sea.push(...rings);
            else areas.push({ id: "omt", name: "", river: p.class === "river", outer: rings, inner: [], big: crosses, seasonal: !!p.intermittent });
          } else if (lname === "waterway" && f.type === 2 && WATERWAY.test(p.class || "")) {
            for (const line of f.rings) for (const piece of clipLine(line, E))
              lines.push({ group: (p.class) + "|" + (p.name || ""), kind: p.class, name: p.name || "", seasonal: !!p.intermittent, coords: piece.map(ll) });
          } else if (lname === "water_name") {
            const g = f.rings[0]; if (!g || !p.name) continue;
            const mid = g[Math.floor(g.length / 2)];
            if (!onEdge(mid, E) || f.type === 1) names.push({ name: p.name, cls: p.class || "", at: ll(mid) });
          } else if (lname === "transportation" && f.type === 2) {
            const sub = p.subclass || "", cls = p.class || "";
            const isTrail = (cls === "path" && TRAIL_SUB.test(sub)) || cls === "track";
            if (!isTrail || p.access === "no" || p.access === "private") continue;
            for (const line of f.rings) for (const piece of clipLine(line, E))
              trailPieces.push({ group: cls, kind: cls === "track" ? "track" : "trail", name: "", coords: piece.map(ll) });
          } else if (lname === "transportation_name" && f.type === 2 && p.name && /^(path|track)$/.test(p.class || "")) {
            for (const line of f.rings) for (const piece of clipLine(line, E))
              namePieces.push({ group: p.class + "|" + p.name, kind: p.class === "track" ? "track" : "trail", name: p.name, labelOnly: true, coords: piece.map(ll) });
          }
        }
      }
    }

    // names: seas and bays become sea labels; lake names go to the lake piece that holds them
    const seaNames = [];
    const insideRing = (pt, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) if ((r[i][1] > pt[1]) !== (r[j][1] > pt[1]) && pt[0] < (r[j][0] - r[i][0]) * (pt[1] - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) c = !c; return c; };
    for (const n of names) {
      if (/^(ocean|sea|bay|strait)$/.test(n.cls)) {
        seaNames.push({ name: n.name, lon: n.at[0], lat: n.at[1], bay: n.cls === "bay", rank: n.cls === "ocean" ? 0 : n.cls === "sea" ? 1 : n.cls === "strait" ? 2 : 3 });
        continue;
      }
      const hit = areas.find(a => !a.name && a.outer.some(r => insideRing(n.at, r)));
      if (hit) hit.name = n.name;
    }

    const water = { lines: joinLines(lines), areas, coast: [], sea, shore, seaNames, source: "omt" };
    const trails = joinLines(trailPieces).concat(joinLines(namePieces));
    return { water, trails, zoom: z, tiles: tiles.length };
  }

  root.OMT = { load, decodeTile, CREDIT: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" };
})(typeof window !== "undefined" ? window : globalThis);
