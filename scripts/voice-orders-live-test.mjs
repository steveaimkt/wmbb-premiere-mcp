#!/usr/bin/env node
// 음성 지시 적용 경로 실측 (프리미어 26.5.2 + MCP Bridge "Start Bridge" 상태).
// 이름이 "[VO-TEST]"로 시작하는 시퀀스에서만 돈다 — 원본 시퀀스는 건드리지 않는다.
// 실행: npm run build && PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge node scripts/voice-orders-live-test.mjs
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { PremiereProBridge } from '../dist/bridge/index.js';
import { PremiereProTools } from '../dist/tools/index.js';
import { BridgePremierePort } from '../dist/voiceOrders/premiere.js';
import { newOrder } from '../dist/voiceOrders/store.js';
import { layoutCaptions, zoomKeyframes } from '../dist/voiceOrders/timing.js';
import { DEFAULT_SETTINGS } from '../dist/voiceOrders/types.js';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const T0 = Number(process.env.VO_TEST_AT ?? 120); // 이 시각 근처에 자막·확대를 놓는다
const settings = { ...DEFAULT_SETTINGS, captionTemplatePath: join(repo, 'cep-plugin', 'assets', 'voice-orders-caption.mogrt') };
const parse = (r) => (typeof r === 'string' ? JSON.parse(r) : r);
const fails = [];
const check = (ok, what, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? '  ' + detail : ''}`); if (!ok) fails.push(what); };

const bridge = new PremiereProBridge();
await bridge.initialize();
const tools = new PremiereProTools(bridge);
const port = new BridgePremierePort(bridge, tools, () => settings);

const seqs = parse(await tools.executeTool('list_sequences', {}));
const seq = (seqs.sequences ?? []).find((s) => String(s.name).startsWith('[VO-TEST]'));
if (!seq) { console.log('FAIL  "[VO-TEST]" 시퀀스가 없음 — 테스트용 복사 시퀀스를 먼저 만드세요'); process.exit(1); }
const seqId = seq.id;
console.log(`시퀀스: ${seq.name} (${seqId}), 기준 ${T0}s`);

// 1) 자막 3개: 같은 시각 2개 + 4초 뒤 1개 → layoutCaptions가 겹치지 않게 배치
const caps = [
  newOrder({ sequenceId: seqId, timeSec: T0, recordingPath: null, status: 'ready', payload: { kind: 'caption', style: 'narration', text: '여기서 상자를 열었는데 아무것도 없었다', placement: 'playhead' } }),
  newOrder({ sequenceId: seqId, timeSec: T0, recordingPath: null, status: 'ready', payload: { kind: 'caption', style: 'situation', text: '(누가 밖에서 빠르게 뛰어온다)', placement: 'playhead' } }),
  newOrder({ sequenceId: seqId, timeSec: T0 + 4, recordingPath: null, status: 'ready', payload: { kind: 'caption', style: 'item', text: 'AKS.7', placement: 'playhead' } }),
];
const existing = await port.existingCaptions(seqId);
const placed = layoutCaptions(caps, existing);
check(placed.length === 3, 'layoutCaptions가 3개 배치', JSON.stringify(placed.map((p) => [p.startSec, p.endSec])));
for (const p of placed) {
  const r = await port.placeCaption(seqId, p);
  check(r.ok, `자막 배치 "${p.text}"`, r.error ?? '');
}
const after = await port.existingCaptions(seqId);
for (const p of placed) {
  const hit = after.find((c) => Math.abs(c.startSec - p.startSec) < 0.05 && Math.abs(c.endSec - p.endSec) < 0.05);
  check(!!hit, `재조회: AI 자막 트랙에 ${p.startSec.toFixed(2)}~${p.endSec.toFixed(2)}`);
}

// 1b) 기존 자막보다 앞에 넣기: 새 자막은 다음 자막 시작 전에 끝나야 하고, 기존 자막은 하나도 바뀌면 안 됨
const early = newOrder({ sequenceId: seqId, timeSec: T0 - 2, recordingPath: null, status: 'ready', payload: { kind: 'caption', style: 'narration', text: '되감아서 앞에 넣은 아주 긴 자막 문장입니다', placement: 'playhead' } });
const [ep] = layoutCaptions([early], after);
check(ep.endSec <= T0 + 0.01, '앞에 넣는 자막은 다음 자막 전에 끝남', `${ep.startSec}~${ep.endSec}`);
const er = await port.placeCaption(seqId, ep);
check(er.ok, '앞에 자막 배치(기존 자막 보존 검증 포함)', er.error ?? '');
const after2 = await port.existingCaptions(seqId);
for (const p of placed) check(after2.some((c) => Math.abs(c.startSec - p.startSec) < 0.05 && Math.abs(c.endSec - p.endSec) < 0.05), `기존 자막 ${p.startSec.toFixed(2)}~ 그대로`);
// 겹치는 범위에 직접 넣으면 거부해야 함(덮어쓰지 않음)
const ov = parse(await tools.executeTool('place_mogrt_text', { sequenceId: seqId, templatePath: settings.captionTemplatePath, trackName: settings.captionTrackName, startSec: T0 + 1, endSec: T0 + 2, text: '겹침 테스트' }));
check(ov.success === false && /overlaps/.test(ov.error ?? ''), '겹치는 위치는 거부', ov.error ?? '');
const after3 = await port.existingCaptions(seqId);
check(after3.length === after2.length, '거부 후 자막 수 그대로', `${after2.length} → ${after3.length}`);

// 2) 확대 1개 (V1 클립에 키프레임 4개)
const zt = Number(process.env.VO_ZOOM_AT ?? T0 + 8);
const z = await port.zoom(seqId, zt, zoomKeyframes(zt, 120, 2, 'center'));
check(z.ok, `확대 120% @${zt}s`, z.error ?? '');

// 3) 마커 생성 → 갱신(이동·색 변경)
const o = newOrder({ sequenceId: seqId, timeSec: T0, recordingPath: null, transcript: '라이브 테스트', payload: { kind: 'caption', style: 'narration', text: '마커 테스트', placement: 'playhead' } });
const mid = await port.setMarker(o, 'orange');
check(!!mid, '마커 생성(주황)', String(mid));
const moved = await port.setMarker({ ...o, markerId: mid, timeSec: T0 + 1 }, 'green');
check(moved === mid, '같은 마커를 1초 뒤로 옮기고 초록으로', String(moved));

const ph = parse(await tools.executeTool('get_playhead', { sequenceId: seqId }));
check(ph.success && typeof ph.timeSec === 'number', 'get_playhead', String(ph.timeSec));

console.log(fails.length ? `${fails.length} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
