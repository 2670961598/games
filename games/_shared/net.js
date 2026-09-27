/* =====================================================================
 * GAMES 联机客户端 SDK（games/_shared/net.js · GAMES-40）——联机游戏页唯一网络出口。
 * 职责（docs/net-protocol.md §7）：连接/入房（含快速匹配）/输入上报/S1 帧与快照接收/
 * 时钟同步（ping/pong 偏移）/ping 显示/自动重连（10s 重连窗内凭 token 复席）。
 *
 * 形态：classic script（构建期内联进游戏页，server 对 /games/_* 一律 404，无外链可能），
 *       暴露全局 GNet。零依赖、单文件；协议 JSON 文本帧。
 * ===================================================================== */
(function (root) {
  'use strict';

  var GW_PORT = 4400; // 网关默认端口（协议 §1）

  /** 网关 origin：<scheme>://<hostname>:4400；?gw=<origin> 可覆盖（LAN/调试） */
  function gwOrigin() {
    var o = null;
    try { o = new URL(root.location.href).searchParams.get('gw'); } catch (e) { /* 非浏览器环境 */ }
    if (o) return o.replace(/\/+$/, '');
    if (!root.location) return 'ws://127.0.0.1:' + GW_PORT;
    var scheme = root.location.protocol === 'https:' ? 'wss' : 'ws';
    return scheme + '://' + root.location.hostname + ':' + GW_PORT;
  }

  /** 会话 sessionStorage 的重连凭证（刷新/崩溃后 ?room= 直达自动复席） */
  function saveResume(roomId, seat, token) {
    try { root.sessionStorage.setItem('gnet:resume:' + roomId, JSON.stringify({ seat: seat, token: token })); } catch (e) { /* 隐私模式 */ }
  }
  function getResume(roomId) {
    try {
      var raw = root.sessionStorage.getItem('gnet:resume:' + roomId);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function clearResume(roomId) {
    try { root.sessionStorage.removeItem('gnet:resume:' + roomId); } catch (e) { /* 忽略 */ }
  }

  var median = function (arr) {
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };

  /**
   * connect(opts) → session
   *   opts: { url?, roomId?|quick:true, gameId, mode?, level?, maxTicks?, resume?,
   *           onWelcome, onStarted, onFrame, onState, onSeat, onEnd, onClosed,
   *           onError, onStatus(status) }
   *   status: connecting → open → live → reconnecting → lost / closed
   */
  function connect(opts) {
    var url = (opts.url || gwOrigin()).replace(/^http/, 'ws') + '/ws';
    var session = {
      rttMs: 0, offsetMs: 0, status: 'connecting',
      seat: -1, role: null, token: null, roomId: null, frame: 0, tickMs: 100,
      sendInput: function (keys) { sendInput(keys); },
      sync: function () { send({ t: 'sync' }); }, // 缺帧时请求全量重同步（协议 §4.1）
      close: function () { userClose = true; try { ws.close(); } catch (e) { /* 已断 */ } },
    };

    var ws = null;
    var userClose = false;
    var roomGone = false;          // 房间已回收（曾入房后 join 得 room-gone）：重试已无意义，终结会话
    var lastFrame = 0;             // 最近收到的帧号（输入自动标 lastFrame+1）
    var rtts = [], offsets = [];
    var pingTimer = 0, backoffIdx = 0, retryTimer = 0;
    var lostAt = 0;                // 断线时刻（10s 重连窗）
    var BACKOFF = [500, 1000, 2000, 4000];

    function setStatus(s) {
      session.status = s;
      if (opts.onStatus) opts.onStatus(s);
    }
    function emit(name, arg) {
      var fn = opts[name];
      if (fn) fn(arg);
    }
    function send(obj) {
      if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; } }
      return false;
    }

    function open() {
      setStatus(session.status === 'reconnecting' ? 'reconnecting' : 'connecting');
      try {
        ws = new root.WebSocket(url);
      } catch (e) {
        emit('onError', { code: 'no-ws', message: String(e) });
        setStatus('lost');
        return;
      }
      ws.onopen = function () {
        backoffIdx = 0;
        setStatus('open');
        var resume = opts.resume || (opts.roomId ? getResume(opts.roomId) : null);
        if (opts.quick) send({ t: 'quick', gameId: opts.gameId, level: opts.level, maxTicks: opts.maxTicks });
        else send({ t: 'join', roomId: opts.roomId, mode: opts.mode || 'play', resume: resume || undefined, name: opts.name });
        pingTimer = root.setInterval(function () { send({ t: 'ping', c: root.Date.now() }); }, 2000);
      };
      ws.onmessage = function (ev) {
        var msg = null;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (!msg || typeof msg.t !== 'string') return;
        switch (msg.t) {
          case 'welcome':
            session.roomId = msg.roomId;
            session.role = msg.role;
            session.seat = msg.role === 'player' ? msg.seat : -1;
            session.token = msg.token || null;
            session.frame = msg.frame;
            session.tickMs = msg.tickMs || 100;
            lastFrame = msg.frame;
            if (msg.role === 'player') saveResume(msg.roomId, msg.seat, msg.token);
            setStatus('live');
            emit('onWelcome', msg);
            break;
          case 'started':
            emit('onStarted', msg);
            break;
          case 'frame':
            lastFrame = msg.frame;
            session.frame = msg.frame;
            emit('onFrame', msg);
            break;
          case 'state':
            session.frame = msg.frame;
            lastFrame = msg.frame;
            emit('onState', msg);
            break;
          case 'seat':
            emit('onSeat', msg);
            break;
          case 'end':
            if (session.roomId) clearResume(session.roomId);
            emit('onEnd', msg);
            break;
          case 'closed':
            if (session.roomId) clearResume(session.roomId);
            emit('onClosed', msg);
            break;
          case 'pong':
            var now = root.Date.now();
            var rtt = now - msg.c;
            if (rtt >= 0 && rtt < 10000) {
              rtts.push(rtt); if (rtts.length > 5) rtts.shift();
              session.rttMs = Math.round(median(rtts));
              var off = msg.s + rtt / 2 - now;
              offsets.push(off); if (offsets.length > 5) offsets.shift();
              session.offsetMs = Math.round(median(offsets));
            }
            emit('onPong', { rttMs: session.rttMs, offsetMs: session.offsetMs });
            break;
          case 'error':
            // BACKOFF→lost 路径同步（GAMES-51 F3）：曾入房后房已回收——清重连凭证并终结
            // 重试（否则 BACKOFF 空转 10s 后误报 reconnect-timeout，盖掉"对局已结束"语义）
            if (msg.code === 'room-gone' && session.roomId) {
              roomGone = true;
              clearResume(session.roomId);
              try { ws.close(); } catch (e) { /* 已断 */ }
            }
            emit('onError', msg);
            break;
        }
      };
      ws.onclose = function () {
        root.clearInterval(pingTimer);
        if (userClose || roomGone) { setStatus('closed'); return; }
        if (session.status === 'lost') return;
        if (!lostAt) lostAt = root.Date.now();
        if (root.Date.now() - lostAt > 10000) { // 10s 重连窗（协议 §2）
          setStatus('lost');
          emit('onError', { code: 'reconnect-timeout', message: '10s 未能重连' });
          return;
        }
        setStatus('reconnecting');
        retryTimer = root.setTimeout(open, BACKOFF[Math.min(backoffIdx++, BACKOFF.length - 1)]);
      };
      ws.onerror = function () { /* onclose 跟进，重连逻辑在那边 */ };
    }

    function sendInput(keys) {
      if (session.role !== 'player') return false;
      return send({ t: 'input', frame: lastFrame + 1, keys: keys });
    }

    open();
    return session;
  }

  root.GNet = {
    gwOrigin: gwOrigin,
    connect: connect,
    getResume: getResume,
    clearResume: clearResume,
    GW_PORT: GW_PORT,
  };
})(typeof window !== 'undefined' ? window : globalThis);
