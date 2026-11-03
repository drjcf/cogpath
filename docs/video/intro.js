'use strict';
/*
 * Opening animation for the cogpath demo video. A pure function of time: window.seek(t) draws the frame at t seconds.
 * Cues (seconds) are the start of each voice-over sentence; re-time the clip by passing ?cues=s1,s2,s3,s4,s5,s6,end
 * (see docs/DEMO.md). Tokens follow web/DESIGN.md.
 */
const NS = 'http://www.w3.org/2000/svg';
const C = {
  paper: '#fbfbf9', card: '#ffffff', ink: '#15202b', muted: '#5f6b76', rule: '#dce1e6', ruleS: '#b9c2cb',
  recall: '#2f5fa8', analyze: '#0f8b8d', evaluate: '#c47f17', synthesize: '#7b3fa0',
  recallBg: '#e9eff9', analyzeBg: '#e3f3f3', evaluateBg: '#faf0df', synthesizeBg: '#f1e8f7',
  pass: '#237a57', passBg: '#e6f3ec', fail: '#b23a2e', hl: 'rgba(255,214,0,.45)', keyBg: '#eceff2',
};
const query = new URLSearchParams(location.search);
const cues = (query.get('cues') || '0,4.29,10.94,16.29,21.08,30.26,31.25').split(',').map(Number);
const [S1, S2, S3, S4, S5, S6, SEND] = cues;
window.DURATION = Number(query.get('dur')) || SEND + 0.6;

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const prog = (t, a, b) => clamp((t - a) / (b - a));
const eo = (x) => 1 - Math.pow(1 - x, 3);
const eio = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const fade = (t, a, b) => eo(prog(t, a, b));
const lerp = (a, b, x) => a + (b - a) * x;
function keys(t, ks) {
  if (t <= ks[0][0]) return ks[0][1];
  for (let i = 1; i < ks.length; i++) if (t <= ks[i][0]) return lerp(ks[i - 1][1], ks[i][1], eio(prog(t, ks[i - 1][0], ks[i][0])));
  return ks[ks.length - 1][1];
}

const svg = document.getElementById('stage');
const S = (tag, a = {}, par = svg) => { const e = document.createElementNS(NS, tag); for (const k in a) e.setAttribute(k, a[k]); par.appendChild(e); return e; };
const G = (par = svg) => S('g', {}, par);
const TX = (s, a, par = svg) => { const e = S('text', { 'text-anchor': 'middle', fill: C.ink, ...a }, par); e.textContent = s; return e; };
const op = (e, v) => e.setAttribute('opacity', clamp(v).toFixed(3));
const at = (e, x, y, s = 1) => e.setAttribute('transform', `translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${s.toFixed(4)})`);
const show = (e, x, y, f) => { op(e, f); at(e, x, y + (1 - f) * 16); };
const draw = (e, p) => { const L = e.getTotalLength(); e.setAttribute('stroke-dasharray', L); e.setAttribute('stroke-dashoffset', (L * (1 - p)).toFixed(2)); e.setAttribute('opacity', p > 0 ? 1 : 0); };

function person(par, x, y, s, sw = 4) {
  S('circle', { cx: x, cy: y - 0.22 * s, r: 0.24 * s, fill: C.paper, stroke: C.ink, 'stroke-width': sw }, par);
  S('path', { d: `M ${x - 0.5 * s} ${y + 0.55 * s} Q ${x - 0.5 * s} ${y + 0.1 * s} ${x} ${y + 0.1 * s} Q ${x + 0.5 * s} ${y + 0.1 * s} ${x + 0.5 * s} ${y + 0.55 * s}`, fill: C.paper, stroke: C.ink, 'stroke-width': sw, 'stroke-linecap': 'round' }, par);
}
function arrow(par, x1, x2, y, col = C.ruleS) {
  const g = G(par);
  S('line', { x1, y1: y, x2: x2 - 12, y2: y, stroke: col, 'stroke-width': 3, 'stroke-linecap': 'round' }, g);
  S('path', { d: `M ${x2 - 16} ${y - 9} L ${x2} ${y} L ${x2 - 16} ${y + 9}`, fill: 'none', stroke: col, 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
  return g;
}
function check(par, cx, cy, r, filled) {
  const g = G(par); at(g, cx, cy);
  S('circle', { r, fill: filled ? C.pass : C.passBg, stroke: C.pass, 'stroke-width': 3 }, g);
  S('path', { d: `M ${-r * 0.4} ${r * 0.02} L ${-r * 0.08} ${r * 0.36} L ${r * 0.45} ${-r * 0.3}`, fill: 'none', stroke: filled ? '#fff' : C.pass, 'stroke-width': Math.max(3, r * 0.17), 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
  return g;
}
/** An exam item as a card: stem bars and four options. set(p) draws the bars in order; marks are reviewer comments. */
function itemCard(par, keyRow = -1) {
  const g = G(par), bars = [];
  S('rect', { x: -110, y: -75, width: 220, height: 150, rx: 8, fill: C.card, stroke: C.ruleS, 'stroke-width': 3 }, g);
  const rows = [[-4, 120], [18, 98], [40, 126], [62, 88]];
  const keyRect = keyRow >= 0 ? S('rect', { x: -100, y: rows[keyRow][0] - 11, width: 200, height: 22, rx: 4, fill: C.keyBg, stroke: C.recall, 'stroke-width': 2.5 }, g) : null;
  const bar = (x1, x2, y, col) => { bars.push({ l: S('line', { x1, y1: y, x2: x1, y2: y, stroke: col, 'stroke-width': 6, 'stroke-linecap': 'round' }, g), x1, x2 }); };
  bar(-92, 88, -50, C.muted); bar(-92, 30, -30, C.muted);
  rows.forEach(([y, len]) => { S('circle', { cx: -90, cy: y, r: 6, fill: 'none', stroke: C.ruleS, 'stroke-width': 2.5 }, g); bar(-72, -72 + len, y, C.ruleS); });
  const marks = G(g);
  [-40, -5, 30].forEach((y) => S('line', { x1: 126, y1: y, x2: 148, y2: y, stroke: C.fail, 'stroke-width': 5, 'stroke-linecap': 'round' }, marks));
  const badge = check(g, 110, -75, 24, true);
  const set = (p) => bars.forEach((b, i) => { b.l.setAttribute('x2', (b.x1 + (b.x2 - b.x1) * clamp(p * bars.length - i)).toFixed(1)); });
  return { g, set, marks, badge, keyRect };
}

async function main() {
  await Promise.all(['400 20px "IBM Plex Sans"', '500 20px "IBM Plex Sans"', '600 20px "IBM Plex Sans"', '400 20px "IBM Plex Mono"'].map((f) => document.fonts.load(f)));
  S('rect', { width: 1920, height: 1080, fill: C.paper });

  // ---- old flow ----
  const old = G(), dim = G(old);
  const title = TX('How an exam item is made today', { x: 96, y: 128, 'text-anchor': 'start', 'font-size': 40, 'font-weight': 500 }, dim);
  S('line', { x1: 150, y1: 700, x2: 1770, y2: 700, stroke: C.rule, 'stroke-width': 3 }, dim);
  const station = (par, label) => { const g = G(par); TX(label, { x: 0, y: 130, 'font-size': 34, 'font-weight': 500 }, g); return g; };
  const art = station(old, 'Source article');
  S('rect', { x: -60, y: -80, width: 120, height: 160, rx: 6, fill: C.card, stroke: C.ruleS, 'stroke-width': 3 }, art);
  const hlRect = S('rect', { x: -50, y: -26, width: 100, height: 20, rx: 3, fill: C.hl }, art);
  [84, 70, 84, 76, 84, 60, 80].forEach((len, i) => S('line', { x1: -42, y1: -50 + i * 17, x2: -42 + len, y2: -50 + i * 17, stroke: C.ruleS, 'stroke-width': 5, 'stroke-linecap': 'round' }, art));
  const writer = station(dim, 'Item writer'); person(writer, 0, 0, 110);
  const comm = station(dim, 'Review committee'); [-100, 100, 0].forEach((x) => person(comm, x, 0, 84, 3.5));
  const appr = station(dim, 'Approved item'); check(appr, 0, 0, 52, false);
  const ar1 = arrow(dim, 330, 590, 470), ar2 = arrow(dim, 730, 1090, 470), ar3 = arrow(dim, 1410, 1590, 470);
  const revise = G(dim);
  S('path', { d: 'M 1250 372 V 330 Q 1250 300 1220 300 H 680 Q 650 300 650 330 V 360', fill: 'none', stroke: C.ruleS, 'stroke-width': 3, 'stroke-linecap': 'round' }, revise);
  S('path', { d: 'M 641 346 L 650 362 L 659 346', fill: 'none', stroke: C.ruleS, 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, revise);
  TX('revise', { x: 950, y: 280, 'font-size': 32, fill: C.muted }, revise);
  const clock = G(dim);
  S('circle', { r: 46, fill: C.card, stroke: C.ink, 'stroke-width': 4 }, clock);
  [[0, -46, 0, -36], [46, 0, 36, 0], [0, 46, 0, 36], [-46, 0, -36, 0]].forEach(([a, b, c, d]) => S('line', { x1: a, y1: b, x2: c, y2: d, stroke: C.ink, 'stroke-width': 3 }, clock));
  const hand = S('line', { x1: 0, y1: 0, x2: 0, y2: -32, stroke: C.ink, 'stroke-width': 5, 'stroke-linecap': 'round' }, clock);
  TX('hours', { x: 0, y: 112, 'font-size': 38, fill: C.muted }, clock);
  const cal = G(dim), cells = [];
  for (let i = 0; i < 8; i++) {
    S('rect', { x: -204 + i * 52, y: -22, width: 44, height: 44, rx: 5, fill: C.card, stroke: C.ruleS, 'stroke-width': 3 }, cal);
    cells.push(S('rect', { x: -200 + i * 52, y: -18, width: 36, height: 36, rx: 3, fill: C.muted, opacity: 0 }, cal));
  }
  TX('weeks', { x: 0, y: 112, 'font-size': 38, fill: C.muted }, cal);
  const hc = itemCard(dim);

  // ---- the shortcut: one prompt, a key the source states ----
  const mdl = G();
  const mnode = G(mdl);
  S('rect', { x: -120, y: -55, width: 240, height: 110, rx: 12, fill: C.card, stroke: C.ink, 'stroke-width': 3 }, mnode);
  TX('Model', { x: 0, y: 15, 'font-size': 44, 'font-weight': 600 }, mnode);
  const mlabel = TX('one prompt', { x: 950, y: 352, 'font-size': 32, fill: C.muted }, mdl);
  const mc = itemCard(mdl, 2);
  const mdown = S('path', { d: 'M 950 485 V 612', stroke: C.ink, 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round' }, mdl);
  const mdownHead = S('path', { d: 'M 941 598 L 950 614 L 959 598', fill: 'none', stroke: C.ink, 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, mdl);
  const elbow = S('path', { d: 'M 312 414 H 340 Q 360 414 360 394 V 245 Q 360 215 390 215 H 770 Q 800 215 800 245 V 708 Q 800 738 830 738 H 836', fill: 'none', stroke: C.recall, 'stroke-width': 4, 'stroke-linecap': 'round' }, mdl);
  const elbowHead = S('path', { d: 'M 822 727 L 838 738 L 822 749', fill: 'none', stroke: C.recall, 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, mdl);
  const elbowLabel = TX('the key is a sentence the source already states', { x: 360, y: 190, 'text-anchor': 'start', 'font-size': 32, fill: C.recall, 'font-weight': 500 }, mdl);

  // ---- EdAI ----
  const edai = G();
  const edName = TX('EdAI Systems', { x: 960, y: 490, 'font-size': 120, 'font-weight': 600, style: 'letter-spacing:-0.01em' }, edai);
  const edRule = S('path', { d: 'M 700 540 H 1220', stroke: C.ink, 'stroke-width': 3, fill: 'none', 'stroke-linecap': 'round' }, edai);
  const edSub = TX('assessment items for credentialing exams', { x: 960, y: 630, 'font-size': 44, fill: C.muted }, edai);

  // ---- the path ----
  const FS = 36, steps = [['Recall', '4', 'recall', 'facts and spans'], ['Analyze', 'causal', 'analyze', 'relations'], ['Evaluate', 'efficacy, safety', 'evaluate', 'strategies scored'], ['Synthesize', 'management plan', 'synthesize', 'plan adapted to the case']];
  const pathG = G(), pills = [];
  steps.forEach(([name, arg, opn]) => {
    const g = G(pathG);
    const bg = S('rect', { rx: FS * 0.95, ry: FS * 0.95, height: FS * 1.9, y: -FS * 0.95, fill: C[opn + 'Bg'] }, g);
    const nm = TX(name, { x: FS * 0.75, y: FS * 0.36, 'text-anchor': 'start', 'font-size': FS, 'font-weight': 600, fill: C[opn] }, g);
    const ar = TX(arg, { x: 0, y: FS * 0.34, 'text-anchor': 'start', 'font-size': FS * 0.82, fill: C[opn], class: 'mono' }, g);
    const nw = nm.getComputedTextLength();
    ar.setAttribute('x', FS * 0.75 + nw + FS * 0.4);
    const w = FS * 0.75 * 2 + nw + FS * 0.4 + ar.getComputedTextLength();
    bg.setAttribute('width', w);
    pills.push({ g, w, opn });
  });
  const RULE = FS * 1.6, total = pills.reduce((a, p) => a + p.w, 0) + RULE * 3, K = Math.min(1, 1700 / total);
  let x = -total / 2;
  const rules = [];
  pills.forEach((p, i) => {
    p.x = x; p.cx = x + p.w / 2; at(p.g, x, 0); x += p.w;
    if (i < 3) { rules.push(S('line', { x1: x + 8, y1: 0, x2: x + RULE - 8, y2: 0, stroke: C.ruleS, 'stroke-width': 3, 'stroke-linecap': 'round' }, pathG)); x += RULE; }
  });
  const gx = pills.map((p) => 960 + p.cx * K), pw = pills.map((p) => p.w * K);
  const gtxt = TX('recall(4) > analyze(causal) > evaluate(efficacy, safety) > synthesize(management plan)', { x: 960, y: 250, 'font-size': 32, fill: C.muted, class: 'mono' });
  const bx1 = gx[1] - pw[1] / 2, bx2 = gx[3] + pw[3] / 2;
  const bracket = S('path', { d: `M ${bx1} 424 V 405 H ${bx2} V 424`, fill: 'none', stroke: C.muted, 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  const blabel = TX('beyond simple recall', { x: (bx1 + bx2) / 2, y: 372, 'font-size': 34, fill: C.muted });
  const cols = G(), colEls = [];
  const pillBottom = 480 + FS * 0.95 * K;
  steps.forEach(([, , opn, cap], i) => {
    const cw = Math.max(pw[i], 250), g = G(cols), g2 = G(cols);
    S('line', { x1: gx[i], y1: pillBottom + 6, x2: gx[i], y2: 650, stroke: C.rule, 'stroke-width': 3 }, g);
    S('rect', { x: gx[i] - cw / 2, y: 650, width: cw, height: 150, rx: 8, fill: C.card, stroke: C.ruleS, 'stroke-width': 3 }, g);
    S('rect', { x: gx[i] - cw / 2, y: 650, width: 7, height: 150, rx: 3, fill: C[opn] }, g);
    TX(cap, { x: gx[i] + 3, y: 705, 'font-size': 27, 'font-weight': 500, fill: C[opn] }, g);
    S('line', { x1: gx[i] - cw * 0.3, y1: 742, x2: gx[i] + cw * 0.3, y2: 742, stroke: C.ruleS, 'stroke-width': 6, 'stroke-linecap': 'round' }, g);
    S('line', { x1: gx[i] - cw * 0.3, y1: 766, x2: gx[i] + cw * 0.1, y2: 766, stroke: C.ruleS, 'stroke-width': 6, 'stroke-linecap': 'round' }, g);
    S('line', { x1: gx[i], y1: 800, x2: gx[i], y2: 868, stroke: C.rule, 'stroke-width': 3 }, g2);
    colEls.push({ g, chk: g2, ck: check(g2, gx[i], 900, 30, false) });
  });
  const verified = TX('each step verified', { x: 960, y: 1005, 'font-size': 34, fill: C.muted });

  // ---- wordmark ----
  const mark = TX('cogpath', { x: 960, y: 470, 'font-size': 190, 'font-weight': 600, style: 'letter-spacing:-0.01em' });
  const url = TX('cogpath.org', { x: 960, y: 800, 'font-size': 46, fill: C.muted });

  window.seek = (t) => {
    // old flow
    op(old, 1 - prog(t, S4, S4 + 1.0));
    op(dim, 1 - 0.82 * prog(t, S3 + 1.0, S3 + 1.8));
    op(title, fade(t, S1, S1 + 0.6));
    show(art, 250, 430, fade(t, S1 + 0.2, S1 + 0.7));
    op(hlRect, fade(t, S3 + 3.4, S3 + 3.9));
    op(ar1, fade(t, S1 + 0.8, S1 + 1.2));
    show(writer, 650, 430, fade(t, S1 + 0.9, S1 + 1.4));
    show(comm, 1250, 430, fade(t, S2 + 4.9, S2 + 5.4)); op(ar2, fade(t, S2 + 5.0, S2 + 5.4));
    show(appr, 1670, 430, fade(t, S2 + 8.6, S2 + 9.1)); op(ar3, fade(t, S2 + 8.7, S2 + 9.1));
    op(revise, fade(t, S2 + 7.0, S2 + 7.4));
    show(clock, 650, 880, fade(t, S2 + 3.6, S2 + 4.1));
    hand.setAttribute('transform', `rotate(${(360 * 2.5 * eio(prog(t, S2 + 3.6, S2 + 5.8))).toFixed(1)})`);
    show(cal, 1250, 880, fade(t, S2 + 6.2, S2 + 6.7));
    cells.forEach((c, i) => op(c, prog(t, S2 + 6.4 + i * 0.4, S2 + 6.7 + i * 0.4)));
    const cx = keys(t, [[S2 + 5.6, 650], [S2 + 6.3, 1250], [S2 + 6.9, 1250], [S2 + 7.5, 650], [S2 + 7.9, 650], [S2 + 8.6, 1250], [S2 + 9.1, 1250], [S2 + 9.7, 1670]]);
    show(hc.g, cx, 700, fade(t, S1 + 1.6, S1 + 2.0));
    hc.set(prog(t, S1 + 2.0, S2 + 3.2));
    op(hc.marks, clamp((cx - 900) / 300) * (t < S2 + 7.7 ? 1 : 0));
    op(hc.badge, prog(t, S2 + 9.7, S2 + 10.1));
    // the shortcut
    op(mdl, 1 - prog(t, S4, S4 + 1.0));
    show(mnode, 950, 430, fade(t, S3 + 1.2, S3 + 1.7)); op(mlabel, fade(t, S3 + 1.3, S3 + 1.8));
    op(mdown, fade(t, S3 + 2.1, S3 + 2.4)); op(mdownHead, fade(t, S3 + 2.1, S3 + 2.4));
    show(mc.g, 950, 700, fade(t, S3 + 2.4, S3 + 2.8)); mc.set(prog(t, S3 + 2.6, S3 + 3.6));
    op(mc.marks, 0); op(mc.badge, 0); op(mc.keyRect, fade(t, S3 + 4.2, S3 + 4.7));
    draw(elbow, eio(prog(t, S3 + 3.6, S3 + 4.6))); op(elbowHead, prog(t, S3 + 4.45, S3 + 4.6));
    op(elbowLabel, fade(t, S3 + 4.4, S3 + 5.0));
    // EdAI
    op(edai, fade(t, S4 + 0.9, S4 + 1.7) * (1 - prog(t, S5 - 0.2, S5 + 0.4)));
    draw(edRule, eio(prog(t, S4 + 1.4, S4 + 2.4))); op(edSub, fade(t, S4 + 2.4, S4 + 3.2));
    // the path
    const e6 = eio(prog(t, S6, S6 + 0.9));
    at(pathG, 960, lerp(480, 640, e6), lerp(K, K * 0.78, e6));
    pills.forEach((p, i) => { const f = fade(t, S5 + 0.4 + 0.8 * i, S5 + 0.9 + 0.8 * i); op(p.g, f); if (i > 0) op(rules[i - 1], f); });
    const out = 1 - prog(t, S6, S6 + 0.5);
    op(gtxt, fade(t, S5 + 3.0, S5 + 3.6) * out);
    draw(bracket, eio(prog(t, S5 + 4.0, S5 + 4.8))); bracket.setAttribute('opacity', (prog(t, S5 + 4.0, S5 + 4.05) * out).toFixed(3));
    op(blabel, fade(t, S5 + 4.4, S5 + 5.0) * out);
    colEls.forEach((c, i) => { op(c.g, fade(t, S5 + 5.4 + 0.35 * i, S5 + 5.9 + 0.35 * i) * out); op(c.chk, fade(t, S5 + 7.2 + 0.3 * i, S5 + 7.6 + 0.3 * i) * out); });
    op(verified, fade(t, S5 + 8.0, S5 + 8.6) * out);
    op(mark, fade(t, S6 + 0.5, S6 + 1.1)); op(url, fade(t, S6 + 1.1, S6 + 1.6));
  };
  window.READY = true;
  window.seek(0);
}
main();
