/* AI 음성 지시 — 검토 패널 (CEP, Node 사용).
 * 데몬(127.0.0.1:47613)과 Node http로 통신한다. 브라우저 fetch를 쓰지 않는 이유: CORS 사전 요청을 피하고
 * 토큰 파일을 그대로 읽어 헤더에 싣기 위해서. 실시간 갱신은 /events(SSE)를 Node로 읽는다. */
(function () {
  'use strict';
  var http = require('http');
  var fs = require('fs');
  var path = require('path');
  var os = require('os');

  var PORT = 47613;
  var ROOT = process.env.VOICE_ORDERS_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'wmbb-premiere-mcp', 'voice-orders');
  var TPS = 254016000000; // Premiere ticks per second
  var cs = typeof CSInterface === 'function' ? new CSInterface() : null;

  var STYLE = { narration: '내레이션', situation: '상황', reaction: '리액션', item: '아이템' };
  var ANCHOR = { center: '가운데', top_left: '왼쪽 위', top: '위', top_right: '오른쪽 위', left: '왼쪽', right: '오른쪽', bottom_left: '왼쪽 아래', bottom: '아래', bottom_right: '오른쪽 아래' };

  var state = { orders: [], status: {}, selected: null, editing: null, glossaryFor: null, up: false, recording: false };
  var $ = function (id) { return document.getElementById(id); };

  function token() {
    try { return fs.readFileSync(path.join(ROOT, 'token'), 'utf8').trim(); } catch (e) { return ''; }
  }

  function api(method, p, body) {
    return new Promise(function (resolve, reject) {
      var data = body === undefined ? null : JSON.stringify(body);
      var req = http.request({
        host: '127.0.0.1', port: PORT, method: method, path: p,
        headers: Object.assign({ 'x-voice-orders-token': token() }, data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
      }, function (res) {
        var s = '';
        res.setEncoding('utf8');
        res.on('data', function (c) { s += c; });
        res.on('end', function () {
          var j; try { j = JSON.parse(s); } catch (e) { j = { success: false, error: s }; }
          if (res.statusCode >= 400) reject(new Error(j.error || ('HTTP ' + res.statusCode))); else resolve(j);
        });
      });
      req.setTimeout(method === 'POST' && p === '/apply' ? 600000 : 8000, function () { req.destroy(new Error('timeout')); });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  // ---------- live updates ----------
  var sse = null, retryTimer = null;
  function connect() {
    clearTimeout(retryTimer);
    var req = http.get({ host: '127.0.0.1', port: PORT, path: '/events?token=' + encodeURIComponent(token()) }, function (res) {
      if (res.statusCode !== 200) { res.resume(); setDown(true); retryTimer = setTimeout(connect, 3000); return; }
      setDown(false);
      refresh();
      var buf = '';
      res.setEncoding('utf8');
      res.on('data', function (c) {
        buf += c;
        var i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          var chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          var ev = (chunk.match(/^event: (.*)$/m) || [])[1];
          var dat = (chunk.match(/^data: (.*)$/m) || [])[1];
          if (ev === 'status') { try { setStatus(JSON.parse(dat)); } catch (e) {} }
          else refresh();
        }
      });
      res.on('end', function () { setDown(true); retryTimer = setTimeout(connect, 2000); });
    });
    req.on('error', function () { setDown(true); retryTimer = setTimeout(connect, 3000); });
    sse = req;
  }

  // While the user is typing (caption edit, time, glossary — Korean IME composition included),
  // a background refresh must not rebuild the rows and wipe the input.
  function busyTyping() {
    var a = document.activeElement;
    return !!(state.editing || state.glossaryFor || (a && a.tagName === 'INPUT' && a.type !== 'checkbox' && $('rows').contains(a)));
  }

  function refresh() {
    return api('GET', '/orders').then(function (j) {
      state.orders = j.orders || [];
      setStatus(j.status || {});
      if (busyTyping()) { state.stale = true; return; }
      render();
    }).catch(function () { setDown(true); });
  }

  function setDown(down) {
    state.up = !down;
    $('down').style.display = down ? 'flex' : 'none';
  }

  function setStatus(s) {
    state.status = s || {};
    var rec = !!state.status.recording || state.recording;
    $('rec').className = 'pill' + (rec ? ' rec' : '');
    $('recText').textContent = rec ? '녹음 중' : '대기';
    $('meta').textContent = state.status.model ? '모델: ' + String(state.status.model).replace('claude-', '').replace(/-/g, ' ') : '';
    var w = [];
    if (state.status.bridge === false) w.push('MCP Bridge 패널에서 Start Bridge 필요 (지시는 계속 쌓임)');
    if (state.status.stt === false) w.push('받아쓰기 준비 안 됨');
    $('warn').textContent = w.join(' · ');
  }

  // ---------- helpers ----------
  function fmt(t) {
    if (t === null || t === undefined) return '--:--';
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function parseTime(v) {
    var m = String(v).trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
    if (!m) return null;
    return (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.style.display = 'block';
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.style.display = 'none'; }, ms || 4000);
  }
  function fail(e) { toast('실패: ' + (e && e.message ? e.message : e), 6000); }
  var APPLICABLE = { ready: 1, unpolished: 1, apply_failed: 1 };

  function seek(t) {
    if (!cs || t === null || t === undefined) return;
    cs.evalScript("if (app.project.activeSequence) app.project.activeSequence.setPlayerPosition('" + Math.round(t * TPS) + "')");
  }

  // ---------- render ----------
  function understood(o) {
    var p = o.payload;
    switch (o.status) {
      case 'processing': return '<span class="badge b-wait">처리 중</span><span class="sub">받아쓰기 · 다듬는 중…</span>';
      case 'no_speech': return '<span class="badge b-fail">인식 안 됨</span><span class="sub">인식된 말이 없음 — 녹음은 보관됨</span>';
      case 'failed': return '<span class="badge b-fail">실패</span><span class="sub">' + esc(o.error || '받아쓰기 실패') + ' — 녹음은 보관됨</span>';
    }
    var head = '';
    if (p && p.kind === 'caption') head = '<span class="badge b-' + p.style + '">' + (STYLE[p.style] || p.style) + '</span>' + esc(p.text) + (p.placement === 'after_previous' ? ' <span class="sub">· 앞 자막 뒤에 붙임</span>' : '');
    else if (p && p.kind === 'zoom') head = '<span class="badge b-zoom">확대</span>' + p.scale + '% · ' + (ANCHOR[p.anchor] || p.anchor) + ' · ' + p.holdSec + '초';
    var tail = '';
    if (o.status === 'unpolished') tail = ' <span class="sub">· 다듬기 안 됨(받아쓴 그대로)</span>';
    if (o.status === 'no_position') tail = ' <span class="sub">· 위치 모름 — 시간을 입력하세요</span>';
    if (o.status === 'applied') tail = ' <span class="badge b-done">적용됨</span>';
    if (o.status === 'apply_failed') tail = ' <span class="badge b-fail">적용 실패</span><span class="sub">' + esc(o.error || '') + '</span>';
    if (!o.checked && o.status !== 'applied') tail += ' <span class="sub">· 체크 해제됨</span>';
    return head + tail;
  }

  function editor(o) {
    var p = o.payload || {};
    if (p.kind === 'zoom') {
      var opts = Object.keys(ANCHOR).map(function (k) { return '<option value="' + k + '"' + (k === p.anchor ? ' selected' : '') + '>' + ANCHOR[k] + '</option>'; }).join('');
      return '<div class="edit" data-edit="' + o.id + '">배율 <input type="number" id="e-scale" min="100" max="300" value="' + p.scale + '">% ' +
        '위치 <select id="e-anchor">' + opts + '</select> 유지 <input type="number" id="e-hold" min="0.5" max="10" step="0.5" value="' + p.holdSec + '">초 ' +
        '<button data-act="save">저장</button><button class="link" data-act="cancel">취소</button></div>';
    }
    var styles = Object.keys(STYLE).map(function (k) { return '<option value="' + k + '"' + (k === p.style ? ' selected' : '') + '>' + STYLE[k] + '</option>'; }).join('');
    return '<div class="edit" data-edit="' + o.id + '"><select id="e-style">' + styles + '</select>' +
      '<input type="text" class="wide" id="e-text" value="' + esc(p.text || o.transcript || '') + '">' +
      '<button data-act="save">저장</button><button class="link" data-act="cancel">취소</button></div>';
  }

  function glossaryForm(o) {
    return '<div class="edit" data-edit="' + o.id + '">사전에 추가: 들린 말 <input type="text" id="g-heard" placeholder="예: 에이케이에스 세븐"> → 표기 <input type="text" id="g-term" placeholder="예: AKS.7">' +
      '<button data-act="gsave">추가</button><button class="link" data-act="gcancel">닫기</button></div>';
  }

  function render() {
    state.stale = false;
    var rows = state.orders;
    $('empty').style.display = rows.length ? 'none' : 'block';
    var html = rows.map(function (o) {
      var said = o.transcript ? '"' + esc(o.transcript) + '"' : '<span class="sub">(녹음)</span>';
      var acts = '';
      if (o.status === 'failed' || o.status === 'no_speech') acts += '<button class="link" data-act="retry">↻ 다시 처리</button>';
      else if (o.status !== 'processing' && o.status !== 'applied') {
        acts += '<button class="link" data-act="edit">✎ 고치기</button>';
        if (o.payload && o.payload.kind === 'caption') {
          acts += '<button class="link" data-act="paren" title="자막을 괄호로 감싸기/풀기">( ) 괄호</button>';
          acts += '<button class="link" data-act="repolish" title="같은 말을 Claude에게 다시 다듬게 함 (새로 녹음하지 않음)">↻ 다시 다듬기</button>';
        }
      }
      if (o.status !== 'processing') acts += '<button class="link" data-act="del" title="삭제">🗑</button>';
      var extra = '';
      if (state.editing === o.id) extra = editor(o);
      else if (state.glossaryFor === o.id) extra = glossaryForm(o);
      else if (o.status === 'no_position') extra = '<div class="edit" data-edit="' + o.id + '">시간 <input type="text" id="t-' + o.id + '" placeholder="02:05" size="7"><button data-act="settime">저장</button></div>';
      var cls = 'row' + (state.selected === o.id ? ' sel' : '') + (o.checked ? '' : ' off');
      var disabled = o.status === 'applied' || o.status === 'processing' ? ' disabled' : '';
      return '<tr class="' + cls + '" data-id="' + o.id + '">' +
        '<td class="chk"><input type="checkbox" data-act="check"' + (o.checked ? ' checked' : '') + disabled + '></td>' +
        '<td class="pos">' + fmt(o.timeSec) + '</td>' +
        '<td class="said">' + said + '</td>' +
        '<td>' + understood(o) + extra + '</td>' +
        '<td class="acts">' + acts + '</td></tr>';
    }).join('');
    $('rows').innerHTML = html;
    var n = rows.filter(function (o) { return o.checked && APPLICABLE[o.status] && o.timeSec !== null; }).length;
    $('count').innerHTML = '<b>' + rows.length + '개</b> 지시 · <b>' + n + '개</b> 적용 예정 · 줄을 누르면 그 위치로 이동';
    $('apply').textContent = '체크한 ' + n + '개 적용';
    $('apply').disabled = n === 0 || state.applying;
  }

  // ---------- actions ----------
  $('rows').addEventListener('click', function (ev) {
    var tr = ev.target.closest('tr.row'); if (!tr) return;
    var id = tr.getAttribute('data-id');
    var o = state.orders.find(function (x) { return x.id === id; }); if (!o) return;
    var act = ev.target.getAttribute('data-act');
    if (ev.target.closest('.edit') && !act) return; // typing in an input
    if (!act) { state.selected = id; seek(o.timeSec); render(); return; }
    ev.stopPropagation();
    var enc = encodeURIComponent(id);
    var done = function () { return refresh(); };
    switch (act) {
      case 'check': api('PATCH', '/orders/' + enc, { checked: ev.target.checked }).then(done, fail); break;
      case 'edit': state.editing = id; state.glossaryFor = null; render(); break;
      case 'cancel': state.editing = null; render(); break;
      case 'save': {
        var payload;
        if (o.payload && o.payload.kind === 'zoom') {
          payload = { kind: 'zoom', scale: Number($('e-scale').value), anchor: $('e-anchor').value, holdSec: Number($('e-hold').value) };
        } else {
          var text = $('e-text').value.trim();
          if (!text) return toast('자막 문구가 비어 있습니다');
          payload = { kind: 'caption', style: $('e-style').value, text: text, placement: (o.payload && o.payload.placement) || 'playhead' };
        }
        api('PATCH', '/orders/' + enc, { payload: payload }).then(function () {
          state.editing = null;
          // 받아쓴 말과 다르게 고쳤으면 사전에 넣을 기회를 준다.
          if (payload.kind === 'caption' && o.transcript && payload.text !== o.transcript) state.glossaryFor = id;
          return refresh();
        }, fail);
        break;
      }
      case 'gsave': {
        var heard = $('g-heard').value.trim(), term = $('g-term').value.trim();
        if (!heard || !term) return toast('들린 말과 표기를 모두 적어 주세요');
        api('POST', '/glossary', { term: term, heard: heard }).then(function () { state.glossaryFor = null; toast('사전에 추가했습니다: ' + heard + ' → ' + term); render(); }, fail);
        break;
      }
      case 'gcancel': state.glossaryFor = null; render(); break;
      case 'paren': {
        // 누르는 즉시 괄호를 씌우거나 벗긴다. 괄호 자막은 '상황', 벗기면 '내레이션'.
        var cur = String(o.payload.text || '').trim();
        var wrapped = /^\(.*\)$/.test(cur);
        var next = wrapped ? cur.slice(1, -1).trim() : '(' + cur + ')';
        var p2 = { kind: 'caption', style: wrapped ? 'narration' : 'situation', text: next, placement: o.payload.placement || 'playhead' };
        o.payload = p2; render(); // 화면에 바로 반영
        api('PATCH', '/orders/' + enc, { payload: p2 }).then(done, function (e) { fail(e); refresh(); });
        break;
      }
      case 'repolish': toast('같은 말을 Claude에게 다시 다듬게 합니다 (새로 녹음하지 않음)'); api('POST', '/orders/' + enc + '/repolish').then(done, fail); break;
      case 'retry': api('POST', '/orders/' + enc + '/retry').then(done, fail); break;
      case 'del': api('DELETE', '/orders/' + enc).then(done, fail); break;
      case 'settime': {
        var t = parseTime($('t-' + id).value);
        if (t === null) return toast('시간 형식: 02:05 또는 125');
        api('PATCH', '/orders/' + enc, { timeSec: t }).then(done, fail);
        break;
      }
    }
  });

  $('apply').addEventListener('click', function () {
    state.applying = true; render();
    $('apply').textContent = '적용 중…';
    api('POST', '/apply').then(function (r) {
      var msg = (r.applied || []).length + '개 적용';
      if ((r.failed || []).length) msg += ', ' + r.failed.length + '개 실패\n' + r.failed.map(function (f) { return '· ' + f.error; }).join('\n');
      if (r.error) msg = '적용 안 됨: ' + r.error;
      toast(msg, r.failed && r.failed.length ? 9000 : 4000);
    }, fail).then(function () { state.applying = false; return refresh(); });
  });

  $('panelRec').addEventListener('click', function () {
    var start = !state.recording;
    api('POST', start ? '/record/start' : '/record/stop').then(function () {
      state.recording = start;
      $('panelRec').textContent = start ? '■ 녹음 끝내기' : '● 패널에서 녹음';
      setStatus(state.status);
    }, function (e) { fail(e.message.indexOf('helper') >= 0 ? new Error('단축키 앱(VoiceHotkey)이 꺼져 있습니다') : e); });
  });

  $('rows').addEventListener('focusout', function () {
    setTimeout(function () { if (state.stale && !busyTyping()) { state.stale = false; render(); } }, 0);
  });

  connect();
  setInterval(function () { if (state.up) refresh(); }, 15000);
})();
