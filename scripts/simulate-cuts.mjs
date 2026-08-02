/**
 * Cut-plan simulation harness.
 *
 * Generates a large batch of synthetic transcripts — random plus hand-built
 * adversarial edge cases — runs analyzeSegments over each, and asserts the
 * invariants that a trustworthy cut MUST always satisfy. Any violation is a real
 * bug: on real footage it would mean a wrong, over-, or unrecoverable cut.
 *
 * Run: node scripts/simulate-cuts.mjs [count]   (default 150)
 *
 * This targets the pure plan logic (no Whisper, no Premiere), so it runs in
 * milliseconds and is deterministic under a fixed seed.
 */

import { analyzeSegments } from '../dist/utils/speechAnalysis.js';

// ---- seeded RNG (mulberry32) so failures reproduce ----
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = (min, max, r) => min + (max - min) * r();

// ---- build a segment from words ----
let WID = 0;
function seg(text, words) {
  return { text, start: words[0].start, end: words[words.length - 1].end, words };
}
function words(specs) {
  return specs.map(([w, s, e]) => ({ word: w, start: round(s), end: round(e), prob: 0.9 }));
}
function round(n) { return Math.round(n * 1000) / 1000; }

const SENTENCES = [
  '유튜브 채널 운영은 손이 많이 갑니다',
  '오늘은 제가 그걸 보여드릴게요',
  '헤르메스를 설치하고 키미로 연결합니다',
  '이 두 가지가 강화됐습니다',
  '여기가 오늘의 핵심인데요',
  '실행해볼게요',
  '설치 스크립트를 붙여넣겠습니다',
  '비용이 상당히 합리적입니다',
];

/** Generate one random scenario. Returns { segments, duration, opts, label }. */
function scenario(r, i) {
  const nSent = Math.floor(R(1, 8, r));
  const opts = {
    minGapSec: 0.6,
    paddingSec: pick([0, 0.15, 0.3], r),
    longGapSec: pick([4, 5, 6], r),
    lookbackSec: pick([15, 25], r),
    removeFillers: r() < 0.4,
    similarityThreshold: pick([0.7, 0.75, 0.8], r),
  };
  const segs = [];
  let t = R(0, 8, r); // head gap (intro) 0..8s
  for (let s = 0; s < nSent; s++) {
    const base = pick(SENTENCES, r);
    const toks = base.split(' ');
    const ws = [];
    for (const tok of toks) {
      const dur = R(0.2, 0.7, r);
      ws.push([tok, t, t + dur]);
      t += dur + R(0, 0.25, r); // small intra-sentence gaps
    }
    segs.push(seg(base, words(ws)));

    // sometimes a retake: same sentence again after a gap (flub -> reset -> retake)
    if (r() < 0.25) {
      t += R(0.5, 22, r); // reset gap (could be long)
      const ws2 = [];
      let tt = t;
      for (const tok of toks) { const d = R(0.2, 0.7, r); ws2.push([tok, tt, tt + d]); tt += d + R(0, 0.2, r); }
      segs.push(seg(base, words(ws2)));
      t = tt;
    }

    // inter-sentence gap: pause, or a long demo gap
    t += r() < 0.3 ? R(5, 40, r) : R(0.3, 3, r);
  }
  const tail = R(0, 20, r); // outro gap
  const duration = round(t + tail);
  return { segments: segs, duration, opts, label: `rand#${i} sent=${nSent}` };
}
function pick(arr, r) { return arr[Math.floor(r() * arr.length)] ?? arr[0]; }

/** Hand-built adversarial edge cases. */
function edgeCases() {
  const cases = [];
  cases.push({ label: 'empty', segments: [], duration: 0, opts: {} });
  cases.push({ label: 'single word', segments: [seg('안녕', words([['안녕', 5, 5.5]]))], duration: 20, opts: {} });
  cases.push({ label: 'no words in segment', segments: [{ text: 'x', start: 1, end: 2, words: [] }], duration: 10, opts: {} });
  // back-to-back identical retakes (retake chain)
  const w = (s) => words([['같은', s, s + 0.4], ['문장', s + 0.5, s + 0.9]]);
  cases.push({ label: 'retake chain x3', segments: [seg('같은 문장', w(1)), seg('같은 문장', w(3)), seg('같은 문장', w(6))], duration: 10, opts: {} });
  // huge intro then speech (hook-protection)
  cases.push({ label: 'huge intro 30s', segments: [seg('시작합니다', words([['시작합니다', 30, 30.6]]))], duration: 40, opts: {} });
  // a long gap that sits between a flub and its retake (must be consumed by duplicate, not longGap)
  cases.push({
    label: 'retake across 20s gap',
    segments: [seg('핵심 문장', words([['핵심', 2, 2.4], ['문장', 2.5, 2.9]])), seg('핵심 문장', words([['핵심', 23, 23.4], ['문장', 23.5, 23.9]]))],
    duration: 30, opts: { longGapSec: 5 },
  });
  // zero padding, tiny gaps
  cases.push({ label: 'zero padding tiny gaps', segments: [seg('a b', words([['a', 1, 1.5], ['b', 2.2, 2.7]]))], duration: 5, opts: { paddingSec: 0, minGapSec: 0.6 } });
  // malformed: overlapping words (end > next start)
  cases.push({ label: 'overlapping words', segments: [seg('x y', words([['x', 1, 3], ['y', 2, 4]]))], duration: 10, opts: {} });
  // all one long gap (silence heavy)
  cases.push({ label: 'two words far apart', segments: [seg('처음', words([['처음', 1, 1.5]])), seg('끝', words([['끝', 50, 50.5]]))], duration: 60, opts: { longGapSec: 5 } });
  return cases;
}

// ---- invariants ----
const EPS = 0.02;
function overlaps(a, b) { return a.start < b.end - EPS && b.start < a.end - EPS; }

function checkInvariants(res, sc) {
  const errs = [];
  const { duration } = sc;
  const rec = res.suggestedRemovals;

  // I2 sorted, I1 non-overlapping, I3 in range, I4 valid duration
  for (let i = 0; i < rec.length; i++) {
    const s = rec[i];
    if (Number.isNaN(s.start) || Number.isNaN(s.end) || Number.isNaN(s.duration)) errs.push(`I9 NaN in span ${i}`);
    if (s.end <= s.start) errs.push(`I4 non-positive span ${i}: ${s.start}->${s.end}`);
    if (Math.abs((s.end - s.start) - s.duration) > EPS) errs.push(`I4 duration mismatch span ${i}`);
    if (s.start < -EPS || s.end > duration + EPS) errs.push(`I3 out of [0,${duration}] span ${i}: ${s.start}->${s.end}`);
    if (i > 0) {
      if (rec[i - 1].start > s.start + EPS) errs.push(`I2 not sorted at ${i}`);
      if (overlaps(rec[i - 1], s)) errs.push(`I1 overlap between ${i - 1} and ${i}`);
    }
  }

  // I6/I7 never cut more than exists
  const cut = rec.reduce((a, s) => a + s.duration, 0);
  if (cut > duration + EPS) errs.push(`I6 cut ${cut.toFixed(2)} > duration ${duration}`);

  // I5 hook/demo protection: no held-back span may appear in suggestedRemovals
  const heldKinds = new Set(['intro', 'outro', 'longGaps']);
  for (const p of res.proposals) {
    if (!heldKinds.has(p.kind)) continue;
    for (const hs of p.spans) {
      if (rec.some((r) => overlaps(r, hs) || (Math.abs(r.start - hs.start) < EPS && Math.abs(r.end - hs.end) < EPS))) {
        errs.push(`I5 held-back ${p.kind} span ${hs.start}->${hs.end} leaked into the cut`);
      }
    }
  }

  // I14 category placement
  const recKinds = new Set(res.proposals.filter((p) => p.recommended).map((p) => p.kind));
  for (const k of recKinds) if (!['duplicates', 'pauses', 'fillers'].includes(k)) errs.push(`I14 unexpected recommended kind ${k}`);
  for (const p of res.proposals) {
    if (p.kind === 'intro' || p.kind === 'outro' || p.kind === 'longGaps') if (p.recommended) errs.push(`I14 ${p.kind} must not be recommended`);
  }

  // I8 a duplicate removeSpan must not overlap its own keepSpan
  for (const d of res.duplicateTakes) {
    if (overlaps(d.removeSpan, d.keepSpan)) errs.push(`I8 removeSpan overlaps keepSpan (${d.removeSpan.start}->${d.removeSpan.end} vs ${d.keepSpan.start}->${d.keepSpan.end})`);
    if (d.removeSpan.start >= d.keepSpan.start) errs.push(`I8b removeSpan not before keepSpan`);
  }

  // I12 pause/longGap thresholds
  const longGapSec = sc.opts.longGapSec ?? 5;
  for (const p of res.proposals) {
    if (p.kind === 'pauses') for (const s of p.spans) if (s.duration >= longGapSec + EPS) errs.push(`I12 pause ${s.duration} >= longGap ${longGapSec}`);
    if (p.kind === 'longGaps') for (const s of p.spans) if (s.duration < longGapSec - EPS) errs.push(`I12 longGap ${s.duration} < ${longGapSec}`);
  }

  // I13 within-category non-overlap
  for (const p of res.proposals) {
    const sp = [...p.spans].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sp.length; i++) if (overlaps(sp[i - 1], sp[i])) errs.push(`I13 overlap within ${p.kind}`);
  }

  // I11 cutPoints in range
  for (const c of res.cutPoints) if (c < -EPS || c > duration + EPS) errs.push(`I11 cutPoint ${c} out of range`);

  return errs;
}

// ---- semantic regressions (exact expected behavior, not just invariants) ----
function semanticChecks() {
  const errs = [];
  const w = (word, s, e) => ({ word, start: s, end: e, prob: 0.9 });

  // 1) retake immediately follows with only silence between → swallow the dead air:
  //    flub [2..3], 20s silence, retake [23..24]. removeSpan must run 2 → 23.
  {
    const segs = [
      { text: '핵심 문장', start: 2, end: 3, words: [w('핵심', 2, 2.5), w('문장', 2.5, 3)] },
      { text: '핵심 문장', start: 23, end: 24, words: [w('핵심', 23, 23.5), w('문장', 23.5, 24)] },
    ];
    const res = analyzeSegments(segs, 30, { longGapSec: 5 });
    const d = res.duplicateTakes[0];
    if (!d) errs.push('SEM1 retake not detected');
    else if (Math.abs(d.removeSpan.end - 23) > 0.1) errs.push(`SEM1 expected removeSpan.end≈23, got ${d.removeSpan.end}`);
  }

  // 2) real content between a flub block and its retake must NEVER be cut.
  //    A[1..2] B[3..4] C[6..7 UNIQUE] A[10..11] B[12..13]. A+B are a paragraph
  //    retake (removing take-1 A,B is fine), but C is unique content sitting in
  //    the reset gap — it must survive. This is the over-cut guard.
  {
    const segs = [
      { text: '문장 에이', start: 1, end: 2, words: [w('문장', 1, 1.5), w('에이', 1.5, 2)] },
      { text: '문장 비', start: 3, end: 4, words: [w('문장', 3, 3.5), w('비', 3.5, 4)] },
      { text: '고유한 콘텐츠 씨', start: 6, end: 7, words: [w('고유한', 6, 6.4), w('콘텐츠', 6.4, 6.8), w('씨', 6.8, 7)] },
      { text: '문장 에이', start: 10, end: 11, words: [w('문장', 10, 10.5), w('에이', 10.5, 11)] },
      { text: '문장 비', start: 12, end: 13, words: [w('문장', 12, 12.5), w('비', 12.5, 13)] },
    ];
    const res = analyzeSegments(segs, 20, {});
    // C is [6,7]; no removal span may overlap it.
    for (const r of res.suggestedRemovals) {
      if (r.start < 7 - 0.02 && 6 < r.end - 0.02) errs.push(`SEM2 over-cut: unique content C[6-7] hit by removal ${r.start}->${r.end}`);
    }
    for (const d of res.duplicateTakes) {
      if (d.removeSpan.start < 7 - 0.02 && 6 < d.removeSpan.end - 0.02) errs.push(`SEM2 over-cut: dup removeSpan ${d.removeSpan.start}->${d.removeSpan.end} swallowed C`);
    }
  }

  // 3) hook protection: a big intro gap is NEVER in the recommended cut.
  {
    const segs = [{ text: '시작', start: 12, end: 12.6, words: [w('시작', 12, 12.6)] }];
    const res = analyzeSegments(segs, 30, {});
    if (res.suggestedRemovals.some((s) => s.start < 1)) errs.push('SEM3 intro gap leaked into the cut');
    if (!res.proposals.some((p) => p.kind === 'intro')) errs.push('SEM3 intro not proposed for review');
  }
  return errs;
}

// ---- run ----
const count = parseInt(process.argv[2] || '150', 10);
const seed = parseInt(process.argv[3] || '20260724', 10);
const r = rng(seed);
const scenarios = [...edgeCases()];
const nRandom = Math.max(0, count - scenarios.length);
for (let i = 0; i < nRandom; i++) scenarios.push(scenario(r, i));

let failures = 0;
const failDetails = [];
for (const sc of scenarios) {
  let res;
  try {
    res = analyzeSegments(sc.segments, sc.duration, sc.opts);
  } catch (e) {
    failures++; failDetails.push(`[${sc.label}] THREW: ${e.message}`); continue;
  }
  // idempotence (I10)
  const res2 = analyzeSegments(sc.segments, sc.duration, sc.opts);
  if (JSON.stringify(res.suggestedRemovals) !== JSON.stringify(res2.suggestedRemovals)) failDetails.push(`[${sc.label}] I10 not idempotent`), failures++;

  const errs = checkInvariants(res, sc);
  if (errs.length) { failures++; failDetails.push(`[${sc.label}] ${errs.join(' | ')}`); }
}

const semErrs = semanticChecks();
if (semErrs.length) { failures += semErrs.length; semErrs.forEach((e) => failDetails.push(`[semantic] ${e}`)); }

console.log(`Simulated ${scenarios.length} scenarios (${edgeCases().length} edge + ${scenarios.length - edgeCases().length} random) + ${3} semantic regressions.`);
console.log(`PASS: ${scenarios.length + 3 - failures}   FAIL: ${failures}`);
if (failDetails.length) {
  console.log('\n--- violations (first 25) ---');
  failDetails.slice(0, 25).forEach((d) => console.log('  ✗ ' + d));
  process.exit(1);
}
console.log('All invariants held. ✅');
