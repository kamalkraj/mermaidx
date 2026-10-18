// getBBox() of an SVG <path>, the way Chrome computes it, in float32 like Chrome does.
//
//   Blink  parses `d` and builds an SkPath: relative coordinates are turned absolute, H/V become lines, S/T
//          reflect the previous control point, an elliptical arc is handed to SkPath::arcTo (conics).
//   Skia   SkPath::computeTightBounds() then takes the end points plus the derivative-root extrema of every
//          quad/cubic/conic (SkFindQuadExtrema, SkFindCubicExtrema, SkFindUnitQuadRoots, SkEval*At, SkConic).
//
// Skia and Blink geometry is float32: every value is rounded with Math.fround where Chrome stores a float.
// Installs itself as globalThis.__pathBBox (and __parseSvgNumber); nothing here calls back into the host.
globalThis.__pathBBox = (function () {
  "use strict";
  const F = Math.fround;
  const CMD_CHARS = "MmLlHhVvCcSsQqTtAaZz";
  const ARGC = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7, Z: 0 };
  const NUM_RE = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/y;

  // Blink's number parser (svg_parser_utilities.cc) accumulates digits in float32, not a correctly rounded
  // decimal-to-float conversion: the last bit can differ from parseFloat.
  function parseNumber(text) {
    let i = 0, sign = 1;
    if (text[i] === "+") i++; else if (text[i] === "-") { sign = -1; i++; }
    let integer = 0, decimal = 0, frac = 1;
    while (i < text.length && text[i] >= "0" && text[i] <= "9") integer = F(F(integer * 10) + (text.charCodeAt(i++) - 48));
    if (text[i] === ".") {
      i++;
      while (i < text.length && text[i] >= "0" && text[i] <= "9") {
        frac = F(frac * F(0.1));
        decimal = F(decimal + F((text.charCodeAt(i++) - 48) * frac));
      }
    }
    let number = F(sign * F(integer + decimal));
    if (text[i] === "e" || text[i] === "E") {
      i++;
      let expSign = 1;
      if (text[i] === "+") i++; else if (text[i] === "-") { expSign = -1; i++; }
      let exponent = 0;
      while (i < text.length) exponent = exponent * 10 + (text.charCodeAt(i++) - 48);
      number = F(number * F(Math.pow(10, expSign * exponent)));
    }
    return number;
  }
  // Shared with the DOM shim: SVGLength attributes (x, y, dx, dy, ...) go through the same parser in Blink.
  globalThis.__parseSvgNumber = parseNumber;
  const WS_RE = /[\s,]/;

  // ---- Skia (SkGeometry.cpp) --------------------------------------------------------------------------

  // Returns t in (0, 1) for numer/denom, or -1 when there is none.
  function validUnitDivide(numer, denom) {
    if (numer < 0) { numer = -numer; denom = -denom; }
    if (denom === 0 || numer === 0 || numer >= denom) return -1;
    const r = F(numer / denom);
    if (r !== r || r === 0) return -1;
    return r;
  }

  function findUnitQuadRoots(A, B, C) {
    const roots = [];
    const push = (t) => { if (t >= 0) roots.push(t); };
    if (A === 0) { push(validUnitDivide(-C, B)); return roots; }
    let dr = B * B - 4 * A * C; // doubles, like Skia
    if (dr < 0) return roots;
    dr = Math.sqrt(dr);
    const R = F(dr);
    if (!isFinite(R)) return roots;
    const Q = B < 0 ? F(-F(B - R) / 2) : F(-F(B + R) / 2);
    push(validUnitDivide(Q, A));
    push(validUnitDivide(C, Q));
    if (roots.length === 2) {
      if (roots[0] > roots[1]) roots.reverse();
      else if (roots[0] === roots[1]) roots.pop();
    }
    return roots;
  }

  function quadExtremaTs(a, b, c) {
    const t = validUnitDivide(F(a - b), F(F(F(a - b) - b) + c));
    return t >= 0 ? [t] : [];
  }

  function cubicExtremaTs(a, b, c, d) {
    const A = F(F(d - a) + F(3 * F(b - c)));
    const B = F(2 * F(F(F(a - b) - b) + c));
    const C = F(b - a);
    return findUnitQuadRoots(A, B, C);
  }

  function evalQuad(p0, p1, p2, t) {
    const A = F(F(p2 - F(2 * p1)) + p0), B = F(2 * F(p1 - p0));
    return F(F(F(F(A * t) + B) * t) + p0);
  }

  function evalCubic(p0, p1, p2, p3, t) {
    const A = F(F(p3 + F(3 * F(p1 - p2))) - p0);
    const B = F(3 * F(F(p2 - F(2 * p1)) + p0));
    const C = F(3 * F(p1 - p0));
    return F(F(F(F(F(F(A * t) + B) * t) + C) * t) + p0);
  }

  // Conic (rational quadratic) with weight w: derivative-root extremum and evaluation (SkConic).
  function conicExtremumT(p0, p1, p2, w) {
    const P20 = F(p2 - p0), P10 = F(p1 - p0), wP10 = F(w * P10);
    const roots = findUnitQuadRoots(F(F(w * P20) - P20), F(P20 - F(2 * wP10)), wP10);
    return roots.length === 1 ? roots[0] : -1;
  }

  function evalConic(p0, p1, p2, w, t) {
    const p1w = F(p1 * w);
    const nA = F(F(p2 - F(2 * p1w)) + p0), nB = F(2 * F(p1w - p0)), nC = p0;
    const dB = F(2 * F(w - 1)), dA = F(0 - dB), dC = 1;
    const numer = F(F(F(F(nA * t) + nB) * t) + nC);
    const denom = F(F(F(F(dA * t) + dB) * t) + dC);
    return F(numer / denom);
  }

  // ---- SkPath::arcTo (SVG endpoint arc) ---------------------------------------------------------------

  const NEARLY_ZERO = 1 / 4096;
  const snap = (v) => (Math.abs(v) <= NEARLY_ZERO ? 0 : v);
  // SkMatrix is float32 [sx, ky, kx, sy]: x' = sx*x + kx*y, y' = ky*x + sy*y.
  function rotM(deg) {
    const rad = F(F(deg * F(Math.PI)) / 180);
    const sin = snap(F(Math.sin(rad))), cos = snap(F(Math.cos(rad)));
    return [cos, sin, F(-sin), cos];
  }
  const mulM = (m, n) => [
    F(F(m[0] * n[0]) + F(m[2] * n[1])), F(F(m[1] * n[0]) + F(m[3] * n[1])),
    F(F(m[0] * n[2]) + F(m[2] * n[3])), F(F(m[1] * n[2]) + F(m[3] * n[3])),
  ];
  const mapM = (m, x, y) => [F(F(m[0] * x) + F(m[2] * y)), F(F(m[1] * x) + F(m[3] * y))];

  // Calls conicTo(x1, y1, x2, y2, w) per piece; returns false when the arc is just a line.
  function arcTo(x0, y0, rxIn, ryIn, angle, large, sweep, x, y, conicTo) {
    let rx = F(Math.abs(rxIn)), ry = F(Math.abs(ryIn));
    if (!rx || !ry) return false;
    if (x0 === x && y0 === y) return false;

    const mid = mapM(rotM(-angle), F(F(x0 - x) * 0.5), F(F(y0 - y) * 0.5));
    const radiiScale = F(F(F(mid[0] * mid[0]) / F(rx * rx)) + F(F(mid[1] * mid[1]) / F(ry * ry)));
    if (radiiScale > 1) { const sq = F(Math.sqrt(radiiScale)); rx = F(rx * sq); ry = F(ry * sq); }

    const toUnit = mulM([F(1 / rx), 0, 0, F(1 / ry)], rotM(-angle));
    const u0 = mapM(toUnit, x0, y0), u1 = mapM(toUnit, x, y);
    let dx = F(u1[0] - u0[0]), dy = F(u1[1] - u0[1]);
    const dd = F(F(dx * dx) + F(dy * dy));
    let scale = F(Math.sqrt(Math.max(F(F(1 / dd) - 0.25), 0)));
    if (large === sweep) scale = -scale;
    dx = F(dx * scale); dy = F(dy * scale);
    const cx = F(F(F(u0[0] + u1[0]) * 0.5) - dy), cy = F(F(F(u0[1] + u1[1]) * 0.5) + dx);

    const theta1 = F(Math.atan2(F(u0[1] - cy), F(u0[0] - cx)));
    const theta2 = F(Math.atan2(F(u1[1] - cy), F(u1[0] - cx)));
    let thetaArc = F(theta2 - theta1);
    if (thetaArc < 0 && sweep) thetaArc = F(thetaArc + F(2 * F(Math.PI)));
    else if (thetaArc > 0 && !sweep) thetaArc = F(thetaArc - F(2 * F(Math.PI)));
    if (Math.abs(thetaArc) < F(F(Math.PI) / 1000000)) return false;

    const toEllipse = mulM(rotM(angle), [rx, 0, 0, ry]);
    const segments = Math.ceil(Math.abs(F(thetaArc / F(F(2 * F(Math.PI)) / 3))));
    const thetaWidth = F(thetaArc / segments);
    const t = F(Math.tan(F(0.5 * thetaWidth)));
    if (!isFinite(t)) return true;
    const w = F(Math.sqrt(F(0.5 + F(F(Math.cos(thetaWidth)) * 0.5))));
    let startTheta = theta1;
    for (let i = 0; i < segments; i++) {
      const endTheta = F(startTheta + thetaWidth);
      const sinE = snap(F(Math.sin(endTheta))), cosE = snap(F(Math.cos(endTheta)));
      const ex = F(cosE + cx), ey = F(sinE + cy);
      const c = mapM(toEllipse, F(ex + F(t * sinE)), F(ey - F(t * cosE)));
      const e = i === segments - 1 ? [x, y] : mapM(toEllipse, ex, ey); // the arc ends exactly on its target
      conicTo(c[0], c[1], e[0], e[1], w);
      startTheta = endTheta;
    }
    return true;
  }

  // ---- path building + SkPath::computeTightBounds -----------------------------------------------------

  // Walks `d` the way Blink builds its SkPath and reports every piece to the handlers h.move/line/quad/cubic/conic
  // (and h.close, optional). Shared by getBBox and getTotalLength so both see exactly the same path.
  function walk(d, h) {
    let cx = 0, cy = 0, startX = 0, startY = 0;
    let cmd = null, prevType = null, lastCtrlX = 0, lastCtrlY = 0;
    let firstPairOfCmd = true;
    let i = 0;
    const n = d.length;

    while (i < n) {
      const ch = d[i];
      if (CMD_CHARS.indexOf(ch) !== -1) {
        i += 1;
        if (ch === "Z" || ch === "z") { // closes the sub-path right here: nothing follows a Z that it could wait for
          if (h.close) h.close(cx, cy, startX, startY);
          cx = startX; cy = startY; prevType = "Z"; cmd = null;
          continue;
        }
        cmd = ch; firstPairOfCmd = true;
        continue;
      }
      if (WS_RE.test(ch)) { i += 1; continue; }
      if (cmd === null) { i += 1; continue; }

      const upper = cmd.toUpperCase();
      const isRel = cmd !== upper;
      const group = [];
      while (group.length < ARGC[upper]) {
        NUM_RE.lastIndex = i;
        const m = NUM_RE.exec(d);
        if (!m) break;
        group.push(parseNumber(m[0]));
        i = NUM_RE.lastIndex;
        while (i < n && WS_RE.test(d[i])) i += 1;
      }
      if (group.length < ARGC[upper]) break; // malformed tail: keep what was built so far

      const type = upper === "M" && !firstPairOfCmd ? "L" : upper;
      const absX = (v) => (isRel ? F(cx + v) : v);
      const absY = (v) => (isRel ? F(cy + v) : v);
      let nx, ny;

      if (type === "M") {
        nx = absX(group[0]); ny = absY(group[1]);
        h.move(nx, ny);
        startX = nx; startY = ny;
      } else if (type === "L") {
        nx = absX(group[0]); ny = absY(group[1]);
        h.line(nx, ny);
      } else if (type === "H") {
        nx = absX(group[0]); ny = cy;
        h.line(nx, ny);
      } else if (type === "V") {
        nx = cx; ny = absY(group[0]);
        h.line(nx, ny);
      } else if (type === "C") {
        const x1 = absX(group[0]), y1 = absY(group[1]), x2 = absX(group[2]), y2 = absY(group[3]);
        nx = absX(group[4]); ny = absY(group[5]);
        h.cubic(cx, cy, x1, y1, x2, y2, nx, ny);
        lastCtrlX = x2; lastCtrlY = y2;
      } else if (type === "S") {
        const x2 = absX(group[0]), y2 = absY(group[1]);
        nx = absX(group[2]); ny = absY(group[3]);
        const smooth = prevType === "C" || prevType === "S";
        const x1 = smooth ? F(F(2 * cx) - lastCtrlX) : cx, y1 = smooth ? F(F(2 * cy) - lastCtrlY) : cy;
        h.cubic(cx, cy, x1, y1, x2, y2, nx, ny);
        lastCtrlX = x2; lastCtrlY = y2;
      } else if (type === "Q") {
        const x1 = absX(group[0]), y1 = absY(group[1]);
        nx = absX(group[2]); ny = absY(group[3]);
        h.quad(cx, cy, x1, y1, nx, ny);
        lastCtrlX = x1; lastCtrlY = y1;
      } else if (type === "T") {
        nx = absX(group[0]); ny = absY(group[1]);
        const smooth = prevType === "Q" || prevType === "T";
        const x1 = smooth ? F(F(2 * cx) - lastCtrlX) : cx, y1 = smooth ? F(F(2 * cy) - lastCtrlY) : cy;
        h.quad(cx, cy, x1, y1, nx, ny);
        lastCtrlX = x1; lastCtrlY = y1;
      } else { // A
        nx = absX(group[5]); ny = absY(group[6]);
        let px = cx, py = cy;
        const drawn = arcTo(cx, cy, group[0], group[1], group[2], group[3] !== 0, group[4] !== 0, nx, ny,
          (x1, y1, x2, y2, w) => { h.conic(px, py, x1, y1, x2, y2, w); px = x2; py = y2; });
        if (!drawn) h.line(nx, ny);
      }

      prevType = type;
      cx = nx; cy = ny;
      firstPairOfCmd = false;
    }
  }

  function pathBBox(d) {
    const empty = { x: 0, y: 0, width: 0, height: 0 };
    if (!d) return empty;

    let minX = NaN, minY = NaN, maxX = NaN, maxY = NaN;
    const add = (x, y) => {
      if (minX !== minX) { minX = maxX = x; minY = maxY = y; return; }
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    };

    const lineTo = (x, y) => add(x, y);
    const quadTo = (x0, y0, x1, y1, x2, y2) => {
      for (const t of quadExtremaTs(x0, x1, x2)) add(evalQuad(x0, x1, x2, t), evalQuad(y0, y1, y2, t));
      for (const t of quadExtremaTs(y0, y1, y2)) add(evalQuad(x0, x1, x2, t), evalQuad(y0, y1, y2, t));
      add(x2, y2);
    };
    const conicTo = (x0, y0, x1, y1, x2, y2, w) => {
      const tx = conicExtremumT(x0, x1, x2, w), ty = conicExtremumT(y0, y1, y2, w);
      if (tx >= 0) add(evalConic(x0, x1, x2, w, tx), evalConic(y0, y1, y2, w, tx));
      if (ty >= 0) add(evalConic(x0, x1, x2, w, ty), evalConic(y0, y1, y2, w, ty));
      add(x2, y2);
    };
    const cubicTo = (x0, y0, x1, y1, x2, y2, x3, y3) => {
      for (const t of cubicExtremaTs(x0, x1, x2, x3)) add(evalCubic(x0, x1, x2, x3, t), evalCubic(y0, y1, y2, y3, t));
      for (const t of cubicExtremaTs(y0, y1, y2, y3)) add(evalCubic(x0, x1, x2, x3, t), evalCubic(y0, y1, y2, y3, t));
      add(x3, y3);
    };

    walk(d, { move: add, line: lineTo, quad: quadTo, conic: conicTo, cubic: cubicTo });

    if (minX !== minX) return empty;
    return { x: minX, y: minY, width: F(maxX - minX), height: F(maxY - minY) };
  }

  // ---- getTotalLength ------------------------------------------------------------------------------------
  //
  // Chrome's answer is the true arc length to within float32 noise (measured against Chrome 153 on every distinct
  // `d` in tests/samples, see tests/data/chrome_path_length.json): a Q/C segment of 11.36 px is off by 1e-6, one
  // of 11362 px by 1e-3. That rules out Skia's default SkContourMeasure (resScale 1, tolerance 0.5), which stops
  // halving a curve once it is within half a pixel of its chord and so comes out ~0.6 px short on every rounded
  // corner. The exact formula Blink uses is not known; this is the same halving scheme (de Casteljau at t = 1/2,
  // t as a 30-bit fixed point fraction, chords summed in float32) run until the curve is flat to 1/2048 px.
  // Exact for straight lines and within ~1e-5 relative for curves, far below any rendering difference.
  const TOLERANCE = 0.5 / 1024;
  const dist = (x0, y0, x1, y1) => {
    const dx = F(x1 - x0), dy = F(y1 - y0);
    return F(Math.sqrt(F(F(dx * dx) + F(dy * dy))));
  };
  const halfLerp = (a, b) => F(a + F(F(b - a) * 0.5)); // SkScalarInterp(a, b, 0.5), exact in float32
  const tSpanBigEnough = (span) => (span >> 10) !== 0;

  function quadTooCurvy(x0, y0, x1, y1, x2, y2) {
    const dx = F(F(x1 * 0.5) - F(F(F(x0 + x2)) * 0.25));
    const dy = F(F(y1 * 0.5) - F(F(F(y0 + y2)) * 0.25));
    return Math.max(Math.abs(dx), Math.abs(dy)) > TOLERANCE;
  }

  function cubicTooCurvy(x0, y0, x1, y1, x2, y2, x3, y3) {
    const third = F(1 / 3), twoThirds = F(F(2) / 3);
    const lerp = (a, b, t) => F(a + F(F(b - a) * t));
    const exceeds = (px, py, x, y) => Math.max(Math.abs(F(x - px)), Math.abs(F(y - py))) > TOLERANCE;
    return exceeds(x1, y1, lerp(x0, x3, third), lerp(y0, y3, third)) ||
           exceeds(x2, y2, lerp(x0, x3, twoThirds), lerp(y0, y3, twoThirds));
  }

  function pathLength(d) {
    if (!d) return 0;
    const K_MAX_T = 0x3FFFFFFF;
    let total = 0, curX = 0, curY = 0;
    const addChord = (x0, y0, x1, y1) => {
      const next = F(total + dist(x0, y0, x1, y1));
      if (next > total) total = next; // Skia drops zero-length segments
    };
    const quadSegs = (x0, y0, x1, y1, x2, y2, mint, maxt) => {
      if (tSpanBigEnough(maxt - mint) && quadTooCurvy(x0, y0, x1, y1, x2, y2)) {
        const ax = halfLerp(x0, x1), ay = halfLerp(y0, y1), bx = halfLerp(x1, x2), by = halfLerp(y1, y2);
        const mx = halfLerp(ax, bx), my = halfLerp(ay, by);
        const half = (mint + maxt) >> 1;
        quadSegs(x0, y0, ax, ay, mx, my, mint, half);
        quadSegs(mx, my, bx, by, x2, y2, half, maxt);
      } else {
        addChord(x0, y0, x2, y2);
      }
    };
    const cubicSegs = (x0, y0, x1, y1, x2, y2, x3, y3, mint, maxt) => {
      if (tSpanBigEnough(maxt - mint) && cubicTooCurvy(x0, y0, x1, y1, x2, y2, x3, y3)) {
        const abx = halfLerp(x0, x1), aby = halfLerp(y0, y1);
        const bcx = halfLerp(x1, x2), bcy = halfLerp(y1, y2);
        const cdx = halfLerp(x2, x3), cdy = halfLerp(y2, y3);
        const abcx = halfLerp(abx, bcx), abcy = halfLerp(aby, bcy);
        const bcdx = halfLerp(bcx, cdx), bcdy = halfLerp(bcy, cdy);
        const mx = halfLerp(abcx, bcdx), my = halfLerp(abcy, bcdy);
        const half = (mint + maxt) >> 1;
        cubicSegs(x0, y0, abx, aby, abcx, abcy, mx, my, mint, half);
        cubicSegs(mx, my, bcdx, bcdy, cdx, cdy, x3, y3, half, maxt);
      } else {
        addChord(x0, y0, x3, y3);
      }
    };

    walk(d, {
      move(x, y) { curX = x; curY = y; },
      line(x, y) { addChord(curX, curY, x, y); curX = x; curY = y; },
      quad(x0, y0, x1, y1, x2, y2) { quadSegs(x0, y0, x1, y1, x2, y2, 0, K_MAX_T); curX = x2; curY = y2; },
      cubic(x0, y0, x1, y1, x2, y2, x3, y3) {
        cubicSegs(x0, y0, x1, y1, x2, y2, x3, y3, 0, K_MAX_T); curX = x3; curY = y3;
      },
      // Elliptical arcs reach here as conics. Skia measures them through a quad approximation of its own; a
      // dense evaluation of the conic is within a hair of that and arcs are rare in mermaid output.
      conic(x0, y0, x1, y1, x2, y2, w) {
        const N = 256;
        let px = x0, py = y0;
        for (let i = 1; i <= N; i++) {
          const t = i / N;
          const x = evalConic(x0, x1, x2, w, t), y = evalConic(y0, y1, y2, w, t);
          addChord(px, py, x, y);
          px = x; py = y;
        }
        curX = x2; curY = y2;
      },
      close(cx, cy, sx, sy) { addChord(cx, cy, sx, sy); curX = sx; curY = sy; },
    });
    return total;
  }
  globalThis.__pathLength = pathLength;

  return pathBBox;
})();
