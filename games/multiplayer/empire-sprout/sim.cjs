/* =====================================================================
 * 帝国萌芽 empire-sprout —— S3 混合同步共享确定性模拟（GAMES-68）
 * 单一事实源：服务端（server/gateway/sims/empire-sprout.js 经 require 载入本文件）
 * 与客户端（构建期内联进 index.html，设 window.EMPSim）跑同一份代码。
 * 设计事实源：docs/designs/empire-sprout.md（GAMES-66 评审通过版）。
 *
 * S3 双层一钟（设计 §5.1，核心节）：
 *   - 单一 tick 源：state.tick 同时是建设层快照序与战斗层帧号（无相位漂移）。
 *   - 建设层（S2，服务器权威）：资源/建筑/队列/兵池/CD——客户端零判定，快照渲染。
 *   - 战斗层（S1，确定性帧同步）：客户端镜像 battleStep（与 slg §5.2 八条纪律全套继承）。
 *   - attack 桥（§5.4 唯一玩家可见跨层路径）：o 壳出征在建设层 tick T 结算 →
 *     合成 {k:'attack'} cmd 写入战斗帧 T+1 的输入集（本 step 内桥投喂，时序承诺零相位运气）。
 *   - 静默期：tick < 1800 战斗通道不下发（本文件 battle 段不推进）；
 *     首战斗帧 frame=1800（inputs 全 noop + events [{k:'erupt'}]）。
 *
 * 确定性纪律（slg §5.2 全套继承，红线）：
 *   - 全整数模拟：位置/速度 milli-px，HP/伤害/资源（milli 单位）整型；
 *     运算只有 + - * 与 >>，无 Math.random/Date.now/浮点字面量进判定路径。
 *   - Q8 定点乘子：克制/攻城乘数全定点（×1.25=320 ×1.5=384 ×1.75=448 ×2=512）。
 *   - 索敌全序 tie-break：dist2 = (Δlane*125_000)² + Δy²（墙/城心全宽 → 只算 Δy），
 *     候选按 (dist2, entityId) 字典序取最小；AOE/遍历按 entityId 升序。
 *   - sim 本体零随机：seed=fnv1a32(roomId) 仅记录（判定路径不消耗）；
 *     随机只在 Bot brain（服务端侧 rng，客户端只回放输入）。
 *   - 同 tick 固定结算序（§5.2/§5.3）：建设 ops→资源产出→训练推进→attack 结算/桥投喂
 *     →战斗（attack 入场→移动→医疗光环→普攻/AOE→战功→胜负）→投影→组包。
 * ===================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; // Node（.cjs）
  root.EMPSim = api;                                                      // 浏览器内联（classic script）
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------- §5.6 PRNG 参考实现（与 games/_shared/common.js 逐字一致，冻结；仅 Bot 用） ---------- */
  function fnv1a32(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  /* ---------- 常量（数值表=设计书 §1/§2 抄录；全整数 milli 单位） ---------- */
  const SEATS = 4;
  const ROW_M = 25000, LANE_M = 125000, FIELD_H_M = 500000;   // 战场 20 行×25px（§2.1）
  const ERUPT_AT = 1800;                                      // 爆发帧（§1.1 固定，非触发式）
  const MAX_TICKS = 7200;                                     // 12 分钟硬顶（§1.1）
  const MARCH_CD = 200;                                       // 出征 CD 20s/席（§1.2）
  const POOL_MAX = 12;                                        // 兵池上限/席（§2.3）
  const QUEUE_MAX = 5;                                        // 每营队列串行 ≤5（§2.3）
  const TRAIN_TICKS = [60, 90, 120];                          // T1/T2/T3 每单位训练时长
  const WALL_HP = 800, KEEP_HP = 1200;                        // 城墙/城心（§1.3）
  const AOE2 = 30000 * 30000;                                 // arty AOE 半径 30px
  const PLOTS = 4;                                            // 每席建筑位（§2.2）

  /* 被动产出（milli/秒 → milli/tick）：粮 3/木 2/铁 1（§1.2） */
  const PASSIVE = { g: 300, w: 200, i: 100 };
  /* 建筑 × 等级表（§2.2；造价 milli，产出 milli/秒→/tick×0.1） */
  const BUILDS = {
    farm:   { cn: '农田',   cost: [{ w: 40000 }, { w: 80000, i: 20000 }, { w: 140000, i: 50000 }], yield: [{ g: 400 }, { g: 900 }, { g: 1500 }] },
    lumber: { cn: '伐木场', cost: [{ w: 30000 }, { w: 60000, i: 15000 }, { w: 110000, i: 40000 }], yield: [{ w: 300 }, { w: 700 }, { w: 1200 }] },
    mine:   { cn: '铁矿场', cost: [{ w: 50000, i: 10000 }, { w: 90000, i: 30000 }, { w: 150000, i: 70000 }], yield: [{ i: 200 }, { i: 500 }, { i: 900 }] },
    camp:   { cn: '步兵营', cost: [{ w: 60000, i: 40000 }, { w: 100000, i: 80000 }, { w: 160000, i: 140000 }], pool: ['inf', 'medic'] },
    works:  { cn: '车械厂', cost: [{ w: 80000, i: 60000 }, { w: 130000, i: 110000 }, { w: 200000, i: 180000 }], pool: ['razor', 'heavy'] },
    range:  { cn: '靶场',   cost: [{ w: 70000, i: 50000 }, { w: 110000, i: 90000 }, { w: 170000, i: 150000 }], pool: ['arty', 'sniper'] },
  };
  const BUILD_CODES = ['farm', 'lumber', 'mine', 'camp', 'works', 'range'];

  /* 兵种 × 三阶数值表（§2.3；速度/射程/攻速三阶不变，D4 已 ×0.9 取整；
   * cost=[T1,T2,T3] 各 [粮,铁]，HP/攻同 slg T2/T3 表；D3 heavy 间隔 16） */
  const UNITS = {
    inf:    { cn: '步兵',   cost: [[100, 0], [150, 0], [200, 0]],       hp: [60, 85, 120],    atk: [8, 10, 14],   interval: 8,  range: 30000,  spd: 4100 },
    razor:  { cn: '装甲车', cost: [[225, 90], [325, 130], [425, 170]],  hp: [180, 250, 360],  atk: [16, 21, 29],  interval: 9,  range: 35000,  spd: 5400 },
    arty:   { cn: '炮兵',   cost: [[350, 140], [500, 200], [650, 260]], hp: [90, 125, 180],   atk: [26, 34, 47],  interval: 18, range: 120000, spd: 2900, aoe: true },
    sniper: { cn: '狙击手', cost: [[300, 120], [425, 170], [575, 230]], hp: [70, 100, 140],   atk: [34, 44, 61],  interval: 22, range: 150000, spd: 3400 },
    medic:  { cn: '军医',   cost: [[175, 0], [250, 0], [325, 0]],       hp: [80, 115, 160],   atk: [0, 0, 0],     interval: 0,  range: 0,      spd: 3800, heal: [60, 80, 110], aura: 45000 },
    heavy:  { cn: '重坦克', cost: [[550, 220], [775, 310], [1050, 440]], hp: [520, 730, 1040], atk: [46, 60, 83],  interval: 16, range: 40000,  spd: 2500 },
  };
  const UNIT_CODES = ['inf', 'razor', 'arty', 'sniper', 'medic', 'heavy'];
  const isUnit = (c) => UNIT_CODES.indexOf(c) >= 0;
  /* 编队展开序（§5.3：兵种代码字母序 arty→heavy→inf→medic→razor→sniper） */
  const FORMA_ORDER = ['arty', 'heavy', 'inf', 'medic', 'razor', 'sniper'];

  /* 克制表（Q8 定点，§2.3/§2.4 D2：sniper→inf ×1.75=448）；
   * 对建筑（§2.4 D5）：inf ×1.25=320、heavy ×2.0=512（D3 校核 §2.5b） */
  const COUNTER = { inf: { arty: 384 }, razor: { inf: 384 }, arty: { razor: 448 }, sniper: { inf: 448 }, medic: {}, heavy: {} };
  const BLD_MULT = { inf: 320, heavy: 512 };

  const META = {
    gameId: 'empire-sprout', title: '帝国萌芽', seats: SEATS, tickMs: 100, maxTicks: MAX_TICKS,
    mode: '2v2-empire', teams: { A: [0, 2], B: [1, 3] },
    cmdInput: true,           // 离散指令输入（rooms.js 宽限沿用=静默、cmd/o/c 一次性语义）
    takeOver: 'casual',       // 断线逾时托管档（§4：casual 慢发展，体验友好）
    tech: 'S3',               // 混合同步（建设 S2 快照 + 战斗 S1 帧，单 tick 源）
    roomPrefix: 'emp',        // 房间 ID 前缀（§7：feed 字典序 mmo-<net-<slg- 之后）
    W: 375, H: 667, fieldH: 500, rows: 20, cell: 25, lanes: 3, eruptAt: ERUPT_AT,
  };

  const teamOf = (seat) => (seat % 2 === 0 ? 'A' : 'B');
  const clamp0 = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /* 距离平方（全序比较用；整数精确 <2^53，禁 imul） */
  function laneDist2(ul, uy, tl, ty) { const dl = (ul - tl) * LANE_M, dy = uy - ty; return dl * dl + dy * dy; }

  /* =====================================================================
   * 初始态（§2.1 战场骨架 + §5.2 建设实体）
   * ===================================================================== */
  function create(seed, opts) {
    const maxTicks = (opts && Number.isInteger(opts.maxTicks) && opts.maxTicks > 0) ? opts.maxTicks : MAX_TICKS;
    const seats = [];
    for (let i = 0; i < SEATS; i++) {
      seats.push({
        seat: i, team: teamOf(i),
        res: { g: 0, w: 0, i: 0 },                 // 三资源（milli；被动即刻起算）
        plots: [null, null, null, null],            // 4 建筑位（null=空位；{kind,lv}）
        queues: [],                                 // [{kind(营), unit, n, prog}]（串行 ≤5/营）
        pools: { inf: [], razor: [], arty: [], sniper: [], medic: [], heavy: [] }, // 兵池（出生即快照：元素=档位）
        marchCd: 0, trained: 0, marched: 0,
      });
    }
    return {
      v: 1, seed: (seed >>> 0), tick: 0, maxTicks,
      build: { seats },
      battle: {
        units: [],
        bld: [                                  // 固定 id 实体（§5.3：1=A墙 2=A心 3=B墙 4=B心；全宽→距离只算 Δy）
          { id: 1, kind: 'wall', team: 'A', hp: WALL_HP, max: WALL_HP, y: 18 * ROW_M + 12500, lane: 0 },
          { id: 2, kind: 'keep', team: 'A', hp: KEEP_HP, max: KEEP_HP, y: 19 * ROW_M + 12500, lane: 0 },
          { id: 3, kind: 'wall', team: 'B', hp: WALL_HP, max: WALL_HP, y: 1 * ROW_M + 12500, lane: 0 },
          { id: 4, kind: 'keep', team: 'B', hp: KEEP_HP, max: KEEP_HP, y: 0 + 12500, lane: 0 },
        ],
        rally: [[-1, -1, -1], [-1, -1, -1], [-1, -1, -1], [-1, -1, -1]], // 每席每车道集结行（-1=无→推进到底）
        merit: { A: 0, B: 0 }, kills: { A: 0, B: 0 },
        nextId: 100,
      },
      teams: { A: { wall: WALL_HP, keep: KEEP_HP, merit: 0 }, B: { wall: WALL_HP, keep: KEEP_HP, merit: 0 } }, // 只读投影（§5.2）
      bridge: {},   // 席位 → {k:'attack',lane,units}（本 step 内桥投喂，§5.4）
      cDefer: {},   // 席位 → 被桥让路的 c 壳 cmd（下一拍补发，确定性）
    };
  }

  /* ---------- 小工具 ---------- */
  const poolTotal = (s) => { let n = 0; for (let i = 0; i < UNIT_CODES.length; i++) n += s.pools[UNIT_CODES[i]].length; return n; };
  const queuedN = (s, kind) => { let n = 0; for (let i = 0; i < s.queues.length; i++) if (!kind || s.queues[i].kind === kind) n += s.queues[i].n; return n; };
  function campOf(s, kind) { for (let p = 0; p < PLOTS; p++) if (s.plots[p] && s.plots[p].kind === kind) return { plot: p, lv: s.plots[p].lv }; return null; }

  /* =====================================================================
   * 建设层 ops（o 壳；畸形=静默 noop，reject 走 events——§5.2）
   * ===================================================================== */
  function execOp(st, seat, op, ev) {
    if (!op || typeof op.k !== 'string') return;
    const s = st.build.seats[seat];
    if (op.k === 'build') {
      const plot = Number.isInteger(op.plot) && op.plot >= 0 && op.plot < PLOTS ? op.plot : null;
      const kind = BUILD_CODES.indexOf(op.kind) >= 0 ? op.kind : null;
      if (plot === null || kind === null) return;
      const cur = s.plots[plot];
      if (cur) {
        if (cur.kind !== kind || cur.lv >= 3) { ev.push({ k: 'reject', seat, op: 'build', why: cur.kind !== kind ? 'kind-mismatch' : 'max-lv' }); return; }
        const cost = BUILDS[kind].cost[cur.lv];
        for (const r in cost) if (s.res[r] < cost[r]) { ev.push({ k: 'reject', seat, op: 'build', why: 'res' + r }); return; }
        for (const r in cost) s.res[r] -= cost[r];
        cur.lv++;
        ev.push({ k: 'built', seat, plot, kind, lv: cur.lv });
      } else {
        // 同类每席至多 1 座（§2.2）
        if (campOf(s, kind)) { ev.push({ k: 'reject', seat, op: 'build', why: 'dup-kind' }); return; }
        const cost = BUILDS[kind].cost[0];
        for (const r in cost) if (s.res[r] < cost[r]) { ev.push({ k: 'reject', seat, op: 'build', why: 'res' + r }); return; }
        for (const r in cost) s.res[r] -= cost[r];
        s.plots[plot] = { kind, lv: 1 };
        ev.push({ k: 'built', seat, plot, kind, lv: 1 });
      }
    } else if (op.k === 'train') {
      const kind = ['camp', 'works', 'range'].indexOf(op.kind) >= 0 ? op.kind : null;
      const unit = isUnit(op.unit) ? op.unit : null;
      const n = Number.isInteger(op.n) && op.n >= 1 && op.n <= 5 ? op.n : null;
      if (!kind || !unit || n === null) return;
      const camp = campOf(s, kind);
      if (!camp) { ev.push({ k: 'reject', seat, op: 'train', why: 'no-camp' }); return; }
      if (BUILDS[kind].pool.indexOf(unit) < 0) { ev.push({ k: 'reject', seat, op: 'train', why: 'not-in-pool' }); return; }
      if (queuedN(s, kind) + n > QUEUE_MAX) { ev.push({ k: 'reject', seat, op: 'train', why: 'queue-full' }); return; }
      if (poolTotal(s) + queuedN(s) + n > POOL_MAX) { ev.push({ k: 'reject', seat, op: 'train', why: 'pool-full' }); return; }
      const c = UNITS[unit].cost[camp.lv - 1];
      if (s.res.g < c[0] * 1000 || s.res.i < c[1] * 1000) { ev.push({ k: 'reject', seat, op: 'train', why: 'res' }); return; }
      s.res.g -= c[0] * 1000; s.res.i -= c[1] * 1000;
      s.queues.push({ kind, unit, n, prog: 0, tier: camp.lv });   // 入队档位快照（升级不回溯 §2.2）
      ev.push({ k: 'train-q', seat, kind, unit, n });
    } else if (op.k === 'attack') {
      const lane = Number.isInteger(op.lane) && op.lane >= 0 && op.lane <= 2 ? op.lane : null;
      if (lane === null || !op.units || typeof op.units !== 'object') return;
      let total = 0;
      const want = {};
      for (const c in op.units) {
        if (!isUnit(c)) continue;
        const n = Number.isInteger(op.units[c]) && op.units[c] > 0 ? op.units[c] : 0;
        if (n > 0) { want[c] = n; total += n; }
      }
      if (total < 1 || total > POOL_MAX) { ev.push({ k: 'reject', seat, op: 'attack', why: 'bad-units' }); return; }
      if (st.tick < ERUPT_AT) { ev.push({ k: 'reject', seat, op: 'attack', why: 'peace' }); return; }         // 和平期出征（§5.2）
      if (s.marchCd > 0) { ev.push({ k: 'reject', seat, op: 'attack', why: 'cd' }); return; }
      for (const c in want) if (s.pools[c].length < want[c]) { ev.push({ k: 'reject', seat, op: 'attack', why: 'pool' + c }); return; }
      const tiers = {};                                       // 出生即快照：出征档位随军团移交战斗层（§2.2）
      for (const c in want) tiers[c] = s.pools[c].splice(0, want[c]);   // FIFO 扣池
      s.marchCd = MARCH_CD; s.marched++;
      st.bridge[seat] = { k: 'attack', lane, units: want, tiers };  // 桥投喂（§5.4：本 step 战斗相位消费→帧 T+1）
      ev.push({ k: 'march', seat, lane, units: want });
    }
    /* 'noop' 与未知 k：静默 */
  }

  /* =====================================================================
   * 战斗层 battleStep（S1；服务端 step 与客户端镜像同函数）
   * inputs: {<seat>:{cmd:{…}}}（缺=noop）；结算序 §5.3：
   * attack 入场（含桥注入）→ 移动 → 医疗光环 → 普攻/AOE（攻击者 id 升序）→ 战功 → 胜负
   * ===================================================================== */
  function battleStep(st, inputs) {
    const bt = st.battle, ev = [], hits = {};
    const T = st.tick;

    /* 1) attack 入场（含桥注入；编队表 §5.3：字母序展开，每 3 单位一行向己方纵深） */
    for (let i = 0; i < SEATS; i++) {
      const inp = inputs[i] || inputs[String(i)];
      const cmd = inp && inp.cmd;
      if (!cmd || cmd.k !== 'attack') continue;
      const lane = Number.isInteger(cmd.lane) && cmd.lane >= 0 && cmd.lane <= 2 ? cmd.lane : null;
      if (lane === null || !cmd.units || typeof cmd.units !== 'object') continue;
      const team = teamOf(i);
      let seq = 0;                                            // 编队序（字母序展开后的第几个单位）
      for (let f = 0; f < FORMA_ORDER.length; f++) {
        const code = FORMA_ORDER[f];
        const n = Number.isInteger(cmd.units[code]) && cmd.units[code] > 0 ? cmd.units[code] : 0;
        for (let j = 0; j < n; j++) {
          const tier = cmd.tiers && cmd.tiers[code] ? (cmd.tiers[code][j] || 1) : 1;   // 桥注入档位快照（出生即快照）；直发默认 T1
          const row = team === 'A' ? 17 - ((seq / 3) | 0) : 2 + ((seq / 3) | 0);
          if (row < 0 || row > 19) continue;
          pushUnit(bt, i, code, tier, lane, row * ROW_M + 12500);
          ev.push({ k: 'spawn', seat: i, unit: code, lane, row });
          seq++;
        }
      }
    }

    /* 2) rally（集结线：state 内镜像同步，无事件） */
    for (let i = 0; i < SEATS; i++) {
      const inp = inputs[i] || inputs[String(i)];
      const cmd = inp && inp.cmd;
      if (!cmd || cmd.k !== 'rally') continue;
      const lane = Number.isInteger(cmd.lane) && cmd.lane >= 0 && cmd.lane <= 2 ? cmd.lane : null;
      const row = Number.isInteger(cmd.row) && cmd.row >= 0 && cmd.row <= 19 ? cmd.row : null;
      if (lane === null || row === null) continue;
      bt.rally[i][lane] = row;
      ev.push({ k: 'rally', seat: i, lane, row });
    }

    /* 3) 移动（id 升序）：站定判定（射程内有敌/军医有伤员）→ 车道推进（集结线夹取） */
    const units = bt.units;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.hp <= 0) continue;
      const hold = u.atk > 0 ? !!findTarget(bt, u) : hurtAllyInAura(bt, u);
      if (hold) continue;
      let ny = u.y + u.dir * u.spd;
      const rl = bt.rally[u.seat][u.lane];
      if (rl >= 0) { const ry = rl * ROW_M + 12500; ny = u.dir < 0 ? (ny < ry ? ry : ny) : (ny > ry ? ry : ny); }
      u.y = clamp0(ny, 0, FIELD_H_M);
    }

    /* 4) 医疗光环（每 10 tick；同光环不叠加取最高——先收集每单位最大治疗量再统一应用） */
    if (T % 10 === 0) {
      const healPlan = [];
      for (let i = 0; i < units.length; i++) {
        const m = units[i];
        if (m.hp <= 0 || m.code !== 'medic') continue;
        const amt = UNITS.medic.heal[m.tier - 1];
        const r2 = UNITS.medic.aura * UNITS.medic.aura;
        for (let j = 0; j < units.length; j++) {
          const t = units[j];
          if (t.hp <= 0 || t.team !== m.team || t.id === m.id || t.hp >= t.maxHp) continue;
          if (laneDist2(m.lane, m.y, t.lane, t.y) <= r2) healPlan.push({ id: t.id, amt });
        }
      }
      if (healPlan.length) {
        const best = {};
        for (let i = 0; i < healPlan.length; i++) { const h = healPlan[i]; if (!best[h.id] || best[h.id] < h.amt) best[h.id] = h.amt; }
        const ids = Object.keys(best).sort();
        for (let i = 0; i < ids.length; i++) {
          const want = Number(ids[i]), amt = best[ids[i]];
          for (let j = 0; j < units.length; j++) if (units[j].id === want) { units[j].hp = clamp0(units[j].hp + amt, 0, units[j].maxHp); break; }
        }
      }
    }

    /* 5) 普攻/AOE（攻击者 id 升序；阵亡者即时退出后续目标候选） */
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.hp <= 0 || u.atk <= 0) continue;
      if (u.cd > 0) { u.cd--; continue; }
      const tgt = findTarget(bt, u);
      if (!tgt) continue;
      const mult = tgt.kind ? (BLD_MULT[u.code] || 256) : (COUNTER[u.code][tgt.code] || 256);
      const dmg = (u.atk * mult) >> 8;
      applyDmg(bt, hits, tgt, dmg, u.seat, ev);
      if (UNITS[u.code].aoe && !tgt.kind) {
        for (let j = 0; j < units.length; j++) {
          const o = units[j];
          if (o.hp <= 0 || o.team === u.team || o.id === tgt.id) continue;
          if (laneDist2(tgt.lane, tgt.y, o.lane, o.y) <= AOE2) applyDmg(bt, hits, o, dmg, u.seat, ev);
        }
      }
      u.cd = u.interval;
    }

    /* 6) 战功结算（受击者 id 升序；击杀+2/破墙+40/城心命中+1——§1.3） */
    flushHits(bt, ev, hits);
    if (units.some((u) => u.hp <= 0)) bt.units = units.filter((u) => u.hp > 0);
    bt.bld = bt.bld.filter((b) => b.hp > 0);
    return ev;
  }

  function pushUnit(bt, seat, code, tier, lane, y) {
    const spec = UNITS[code], t = tier - 1;
    bt.units.push({
      id: bt.nextId++, seat, team: teamOf(seat), code, tier,
      lane, y, dir: teamOf(seat) === 'A' ? -1 : 1,
      hp: spec.hp[t], maxHp: spec.hp[t], atk: spec.atk[t],
      rng: spec.range, spd: spec.spd, interval: spec.interval, cd: 0,
    });
  }

  /* 索敌：候选 = 敌方单位 + 敌方墙/心（全宽只算 Δy）；按 (dist2, id) 字典序取最小，再验射程 */
  function findTarget(bt, u) {
    let best = null, bd = 0, bid = 0;
    const units = bt.units;
    for (let i = 0; i < units.length; i++) {
      const t = units[i];
      if (t.hp <= 0 || t.team === u.team) continue;
      const d = laneDist2(u.lane, u.y, t.lane, t.y);
      if (best === null || d < bd || (d === bd && t.id < bid)) { best = t; bd = d; bid = t.id; }
    }
    const bld = bt.bld;
    for (let i = 0; i < bld.length; i++) {
      const b = bld[i];
      if (b.hp <= 0 || b.team === u.team) continue;
      const dy = u.y - b.y;
      const d = dy * dy;                                       // 全宽实体（slg base 同式）
      if (best === null || d < bd || (d === bd && b.id < bid)) { best = b; bd = d; bid = b.id; }
    }
    if (best === null || bd > u.rng * u.rng) return null;
    return best;
  }

  function hurtAllyInAura(bt, u) {
    const r2 = UNITS.medic.aura * UNITS.medic.aura;
    const units = bt.units;
    for (let i = 0; i < units.length; i++) {
      const t = units[i];
      if (t.hp <= 0 || t.team !== u.team || t.id === u.id || t.hp >= t.maxHp) continue;
      if (laneDist2(u.lane, u.y, t.lane, t.y) <= r2) return true;
    }
    return false;
  }

  /* 伤害结算（每帧每受击者聚合一条 hit 事件；战功随落账——城心命中+1） */
  function applyDmg(bt, hits, tgt, dmg, bySeat, ev) {
    if (tgt.hp <= 0 || dmg <= 0) return;
    tgt.hp -= dmg;
    const key = tgt.kind ? 'b' + tgt.id : 'u' + tgt.id;
    const h = hits[key];
    if (h) h.dmg += dmg;
    else hits[key] = { unit: tgt.kind ? null : tgt, bld: tgt.kind ? tgt : null, by: bySeat, dmg };
  }

  function flushHits(bt, ev, hits) {
    const keys = Object.keys(hits).sort();
    for (let i = 0; i < keys.length; i++) {
      const h = hits[keys[i]];
      const byTeam = teamOf(h.by);
      if (h.unit) {
        const u = h.unit;
        ev.push({ k: 'hit', seat: u.seat, by: h.by, dmg: h.dmg });
        if (u.hp <= 0) {
          bt.kills[byTeam]++;
          bt.merit[byTeam] += 2;                                // 击杀 +2（§1.3）
          ev.push({ k: 'die', seat: u.seat, by: h.by, unit: u.code });
        }
      } else {
        const b = h.bld;
        ev.push({ k: b.kind === 'wall' ? 'wallhp' : 'keephp', team: b.team, hp: Math.max(0, b.hp) });
        if (b.kind === 'keep' && b.hp > 0) bt.merit[byTeam] += 1;  // 城心命中 +1
        if (b.hp <= 0) {
          if (b.kind === 'wall') { bt.merit[byTeam] += 40; ev.push({ k: 'walldown', team: b.team }); } // 破墙 +40
          else ev.push({ k: 'keepdown', team: b.team });
        }
      }
    }
  }

  /* =====================================================================
   * step(state, inputs, room) —— 单 tick 双层推进（服务端权威；客户端离线模式同函数）
   * 返回 { events(建设), battleInputs, battleEvents, over, result, dirty }
   * ===================================================================== */
  function step(st, inputs, room) {
    const ev = [];
    const dirty = new Set();

    /* 1) 建设 ops（o 壳；席位升序） */
    for (let i = 0; i < SEATS; i++) {
      const inp = inputs[i] || inputs[String(i)];
      if (inp && inp.o) { execOp(st, i, inp.o, ev); dirty.add(i); }
    }

    /* 2) 资源产出（被动 + 建筑；milli/tick） */
    for (let i = 0; i < SEATS; i++) {
      const s = st.build.seats[i];
      s.res.g += PASSIVE.g; s.res.w += PASSIVE.w; s.res.i += PASSIVE.i;
      for (let p = 0; p < PLOTS; p++) {
        const b = s.plots[p];
        if (!b) continue;
        const y = BUILDS[b.kind].yield ? BUILDS[b.kind].yield[b.lv - 1] : null;   // 营类无产出（§2.2 经济三选）
        for (const r in y) s.res[r] += y[r];
      }
      if (st.tick % 10 === 0) dirty.add(i);                    // 资源整秒粒度（§5.2：省 90% 增量字节）
    }

    /* 3) 训练队列推进（串行；完成入池）+ 出征 CD */
    for (let i = 0; i < SEATS; i++) {
      const s = st.build.seats[i];
      if (s.queues.length) {
        const q = s.queues[0];
        q.prog++;
        const dur = TRAIN_TICKS[(q.tier || 1) - 1];            // 入队时档位快照（§2.2：升级期间按升级前档位照常练）
        if (q.prog >= dur) {
          q.prog = 0; q.n--;
          s.pools[q.unit].push(q.tier || 1);                   // 出生即快照（§2.2：升级不回溯）
          s.trained++;
          ev.push({ k: 'train-done', seat: i, unit: q.unit });
          dirty.add(i);
          if (q.n <= 0) s.queues.shift();
        }
      }
      if (s.marchCd > 0) { s.marchCd--; if (s.marchCd === 0) ev.push({ k: 'cd', seat: i, remain: 0 }); }
    }

    /* 4) 战斗相位（静默期后；§5.1：tick+1 ≥ ERUPT_AT 才推进，首帧 frame=1800） */
    let battleInputs = null, battleEvents = null;
    if (st.tick + 1 >= ERUPT_AT) {
      battleInputs = {};
      for (let i = 0; i < SEATS; i++) {
        const inp = inputs[i] || inputs[String(i)];
        const c = inp && inp.c && typeof inp.c === 'object' ? inp.c : null;
        if (st.bridge[i]) {
          // 桥优先（§5.4 时序承诺：建设 tick T 结算 → 战斗帧 T+1）；同拍 c 让路延后一拍（确定性）
          battleInputs[i] = { cmd: st.bridge[i] };
          if (c) st.cDefer[i] = c;
        } else if (c) battleInputs[i] = { cmd: c };
        else if (st.cDefer[i]) { battleInputs[i] = { cmd: st.cDefer[i] }; delete st.cDefer[i]; }
        else battleInputs[i] = { cmd: { k: 'noop' } };
      }
      st.bridge = {};
      battleEvents = battleStep(st, battleInputs);
      if (st.tick + 1 === ERUPT_AT) battleEvents.unshift({ k: 'erupt' }); // 爆发演出（首战斗帧）
    }

    /* 5) 投影（战斗→建设只读镜像，§5.4 规则 2） */
    const wa = st.battle.bld.find((b) => b.kind === 'wall' && b.team === 'A');
    const ka = st.battle.bld.find((b) => b.kind === 'keep' && b.team === 'A');
    const wb = st.battle.bld.find((b) => b.kind === 'wall' && b.team === 'B');
    const kb = st.battle.bld.find((b) => b.kind === 'keep' && b.team === 'B');
    st.teams.A.wall = wa ? wa.hp : 0; st.teams.A.keep = ka ? ka.hp : 0; st.teams.A.merit = st.battle.merit.A;
    st.teams.B.wall = wb ? wb.hp : 0; st.teams.B.keep = kb ? kb.hp : 0; st.teams.B.merit = st.battle.merit.B;

    st.tick++;

    /* 6) 终局判定（战斗层权威，§5.4 规则 3：keep ≤0 或 tick 硬顶） */
    const deadA = !ka || ka.hp <= 0, deadB = !kb || kb.hp <= 0;
    if (deadA || deadB) {
      const result = {
        winner: deadA && deadB ? 'draw' : (deadA ? 'B' : 'A'), reason: 'eliminated',
        scores: { A: st.battle.merit.A, B: st.battle.merit.B }, kills: { ...st.battle.kills },
      };
      return { events: ev, battleInputs, battleEvents, over: true, result, dirty };
    }
    if (st.tick >= st.maxTicks) {
      let w;
      const hpA = ka ? ka.hp : 0, hpB = kb ? kb.hp : 0;
      if (hpA !== hpB) w = hpA > hpB ? 'A' : 'B';              // 比城心 HP%（同 max 即比 HP）
      else if (st.battle.merit.A !== st.battle.merit.B) w = st.battle.merit.A > st.battle.merit.B ? 'A' : 'B';
      else w = 'draw';
      const result = { winner: w, reason: 'timeout', scores: { A: st.battle.merit.A, B: st.battle.merit.B }, kills: { ...st.battle.kills } };
      return { events: ev, battleInputs, battleEvents, over: true, result, dirty };
    }
    return { events: ev, battleInputs, battleEvents, over: false, result: null, dirty };
  }

  const serialize = (st) => JSON.stringify(st);
  const deserialize = (json) => JSON.parse(json);

  /* =====================================================================
   * Bot 决策 brain(st, seat, level, rng, env?) → {o:…}|{c:…}|{}
   * §4 三档（建设倾向 × 战斗时机双轴）：单 brain 双通道输出——建设 op 走 o 壳、
   * 战斗 cmd 走 c 壳，与真人逐字节同路径。绝对 tick 为"顺序与风格"非字面
   * （slg 接线先例：资源就绪门控 + 攒钱闸门实现）。
   *   casual 慢发展：农本 build order（lumber→farm→farm Lv2→camp）、inf 连练池 6 止步、
   *     爆发后池 ≥6 且 CD 好才征（首征常 2100+）、固定 lane1、无 rally、被破墙 30% 补征。
   *   balanced 均衡：farm→mine→camp→works（经济先手）、camp Lv2@~1500、混编 inf:razor 2:1、
   *     池 ≥8 即征、敌方最薄车道、前线 1/2 rally、被破墙即满池再征、营 Lv2 后回补经济。
   *   competitive 军备竞速：farm→camp→mine→works（camp 抢先=军备）、camp Lv2@~1200+Lv3@~2400、
   *     情报克制（读敌最近军团构成）无情报 inf:heavy 2:1、tick1800 CD 即满池 timing attack、
   *     双线分压 lane0/2 交替+破墙后集火 lane1、动态 rally、被破墙即征+补 mine 转 heavy。
   *
   * ── 建造死锁三例警示（GAMES-70 跨游戏教训，改本段前必读）──────────────────
   * REFINE v1 共性根因 P1（docs/qa/refine-v1.md §3）：设计书与实现只定义 happy path
   * 的状态转移，不为"进入不可达/无进展状态"定义逃逸路径。三例同构，全在边界
   * 类（槽位/闸门/窗口）上翻车——边界条件必须显式处理越界，禁止假设"总能成功"：
   *   ① 槽位类（empire F1·GAMES-70）：build order 5 项 > PLOTS=4 → indexOf(null)=-1
   *     永不建造且 mem.bi 卡死 → 升级线 else 分支永不可达。教训：order 项数必须
   *     ≤ 槽位数（升級项不占新槽除外），且选址失败要有 bi++ 溢出兜底（防卡死）。
   *   ② 闸门类（slg QA1 F2·GAMES-31）："有 CP 即花"闸门互锁 → 克制兵 45/70CP 在
   *     2CP/s 收入下永不可攒，5 局 0 次非 inf 出兵。教训：闸门门槛必须 ≤ 收入上限
   *     可达（可达性钳制），否则闸门=永久关闭。
   *   ③ 窗口类（empire F2·GAMES-70）：heavy 触发窗 (pool+q)%3===2 依赖池态取模——
   *     出征清池/练兵完成的非线性跳变会让窗口系统性错位（实测唯一窗口 10%3=1）；
   *     加上 4 槽占满 → 危机补 mine 分支死 + 被动铁 100/tick 撑不起 T1 铁系兵。
   *     教训：节奏窗口用决策侧计数器（mem.trainSeq）不用池态取模；铁系兵前置
   *     mine 进线性 order；克制/混编兵支付不起时降级 inf（先 inf 后换装）不断档。
   * ===================================================================== */
  const DECIDE = { casual: 50, balanced: 20, competitive: 10 };
  /* order 项数必须 ≤ PLOTS=4（警示①：5 项时第 5 座 indexOf(null)=-1 永不建造+bi 卡死）。
   * F1/F2 修复口径：farm+mine+camp+works 四件套为必集（粮/铁/两营——缺 mine 则被动铁
   * 100/tick 撑不起 razor 90k/heavy 220k 的 T1 铁价，缺 farm 则粮 300/tick 练不满池），
   * 让出 lumber（被动木 200/tick 足够付四件 230k 造价 + 升级线）；balanced 经济先手
   * （mine 先），competitive 军备竞速（camp 先）保档差。 */
  const BUILD_ORDER = {
    casual: [['lumber', 0], ['farm', 0], ['farm', 1], ['camp', 0]],                       // 农本（军事最后）
    balanced: [['farm', 0], ['mine', 0], ['camp', 0], ['works', 0]],                      // 均衡：经济先手
    competitive: [['farm', 0], ['camp', 0], ['mine', 0], ['works', 0]],                   // 军备：camp 抢先
  };
  const botMem = new WeakMap();
  function memOf(st, seat) {
    let m = botMem.get(st);
    if (!m) { m = {}; botMem.set(st, m); }
    let s = m[seat];
    if (!s) {
      s = { lastDecide: -1, bi: 0, lastRallyRow: [-9, -9, -9], laneFlip: 0, seenTick: -1, seen: new Set(), enemyLog: [], provoked: -1, firstAt: -1 };
      m[seat] = s;
    }
    return s;
  }
  const poolN = (s) => poolTotal(s);

  function brain(st, seat, level, rng, env) {
    const s = st.build.seats[seat];
    if (!s) return {};
    const mem = memOf(st, seat);
    const my = teamOf(seat), foe = my === 'A' ? 'B' : 'A';
    if (mem.lastDecide < 0) mem.lastDecide = st.tick;
    else if (st.tick - mem.lastDecide < (DECIDE[level] || 20)) return {};
    mem.lastDecide = st.tick;

    /* 情报（competitive 克制）：读敌方最近军团构成（服务器侧合法，§4） */
    if (mem.seenTick !== st.tick) {
      mem.seenTick = st.tick;
      const units = st.battle.units;
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (u.team === my || mem.seen.has(u.id)) continue;
        mem.seen.add(u.id);
        mem.enemyLog.push(u.code);
        if (mem.enemyLog.length > 8) mem.enemyLog.shift();
      }
    }
    const enemyMode = (() => {
      const log = mem.enemyLog.slice(-4), cnt = {};
      let best = null, bn = 0;
      for (let i = 0; i < log.length; i++) { cnt[log[i]] = (cnt[log[i]] || 0) + 1; if (cnt[log[i]] > bn) { bn = cnt[log[i]]; best = log[i]; } }
      return best;
    })();
    const COUNTER_PICK = { inf: 'razor', razor: 'arty', arty: 'inf', sniper: 'razor', heavy: 'arty', medic: 'razor' };

    /* ---- 建设（build order 查表 + 资源就绪门控 + 升级线） ---- */
    const wallDown = st.teams[my].wall <= 0;                   // 危机态（被破墙）
    const order = BUILD_ORDER[level] || BUILD_ORDER.balanced;
    if (mem.bi < order.length) {
      const [kind, upLv] = order[mem.bi];
      const camp = campOf(s, kind);
      const wantLv = upLv + 1;
      if (camp && camp.lv >= wantLv) { mem.bi++; }
      else {
        // 找空位（同类至多 1 座；已有则原位升级）
        const lv = camp ? camp.lv : 0;
        const cost = BUILDS[kind].cost[lv];
        let afford = true;
        for (const r in cost) if (s.res[r] < cost[r]) afford = false;
        if (afford) {
          const plot = camp ? camp.plot : s.plots.indexOf(null);
          if (plot >= 0) { mem.bi++; return { o: { k: 'build', plot, kind } }; }
          mem.bi++;   // 溢出兜底（警示①）：目标不可达（无空位）也推进 bi——防 bi 永卡把升级线 else 分支饿死
        } else if (level === 'competitive' && lv === 0 && s.res.w >= cost.w * 2) { /* 快开档硬等 */ }
      }
    } else {
      /* 升级线（档位差异化） */
      const upCamp = (lvGate) => {
        for (const kind of ['camp', 'works', 'range']) {
          const camp = campOf(s, kind);
          if (camp && camp.lv === lvGate && camp.lv < 3) {
            const cost = BUILDS[kind].cost[camp.lv];
            let afford = true;
            for (const r in cost) if (s.res[r] < cost[r]) afford = false;
            if (afford) return { o: { k: 'build', plot: camp.plot, kind } };
          }
        }
        return null;
      };
      if (level === 'balanced' && st.tick >= 1500) { const u = upCamp(1); if (u) return u; }
      if (level === 'competitive') {
        if (st.tick >= 1200 && st.tick < 2400) { const u = upCamp(1); if (u) return u; }
        if (st.tick >= 2400) { const u = upCamp(2); if (u) return u; }
      }
      if (level === 'balanced' && st.tick >= 1800) {          // 营 Lv2 后回补经济 Lv2
        for (const kind of ['farm', 'lumber', 'mine']) {
          const b = campOf(s, kind);
          if (b && b.lv === 1) {
            const cost = BUILDS[kind].cost[1];
            let afford = true;
            for (const r in cost) if (s.res[r] < cost[r]) afford = false;
            if (afford) return { o: { k: 'build', plot: b.plot, kind } };
          }
        }
      }
      /* 危机补 mine（警示①③：mine 已进线性 order 常态提前建成，此分支退化为兜底；
       * plot>=0 显式判空——槽满时静默让路，不做永假死分支） */
      if (level === 'competitive' && wallDown && !campOf(s, 'mine')) {  // 危机补 mine 采铁转 heavy
        const plot = s.plots.indexOf(null);
        const cost = BUILDS.mine.cost[0];
        if (plot >= 0 && s.res.w >= cost.w && s.res.i >= cost.i) return { o: { k: 'build', plot, kind: 'mine' } };
      }
    }

    /* ---- 出征（战斗时机差异化，§4 主轴；置于练兵前——CD 好即压上不被练兵饿死） ---- */
    if (st.tick >= ERUPT_AT && s.marchCd <= 0) {
      const pool = poolN(s);
      const gate = level === 'casual' ? 6 : level === 'balanced' ? 8 : 10;
      if (mem.firstAt < 0) mem.firstAt = 2050 + ((rng() * 150) | 0);   // casual 首征慢半拍（§4：常 tick 2100+）
      /* 危机反应（§4）：破墙后 casual 30% 补征 / 其余档即征；城墙受损（未破）= 回防警报，
         全档即征——空城流不被首波白拆（§1.3 预期对局长的前提） */
      const wallHurt = st.teams[my].wall > 0 && st.teams[my].wall < WALL_HP;
      const crisis = (wallDown && (level === 'casual' ? rng() < 0.3 : true)) || wallHurt;
      if (pool >= gate && (level !== 'casual' || st.tick >= mem.firstAt || crisis) || (crisis && pool >= 4)) {
        const units = {};
        for (let i = 0; i < UNIT_CODES.length; i++) { const c = UNIT_CODES[i]; if (s.pools[c].length) units[c] = s.pools[c].length; }
        let lane = 1;
        if (level === 'balanced') {                            // 敌方最薄车道（slg F2 同款计数法）
          const cnt = [0, 0, 0];
          for (let i = 0; i < st.battle.units.length; i++) { const u = st.battle.units[i]; if (u.team === foe && u.hp > 0) cnt[u.lane]++; }
          let min = cnt[0] + cnt[1] + cnt[2] + 1;
          for (let l = 0; l < 3; l++) if (cnt[l] < min) min = cnt[l];
          lane = cnt[1] === min ? 1 : cnt[0] === min ? 0 : 2;
        } else if (level === 'competitive') {
          lane = st.teams[foe].wall <= 0 ? 1 : (mem.laneFlip === 0 ? 0 : 2); // 破墙后集火 lane1，否则双线分压
          mem.laneFlip = 1 - mem.laneFlip;
        }
        return { o: { k: 'attack', lane, units } };
      }
    }

    /* ---- 练兵（营池内；池上限门控；混编三重防线——警示③教训逐层叠加：
       ① 池态取模 (pool+q)%3 会被出征清池/练兵完成的非线性跳变系统性错位；
       ② 发单序计数也不够——works 建成前 inf 已把池填满（pool+queued 恒=上限，
         完成只是挪位不开新窗），special 永挤不进 → 首征纯 inf；
       正解 a=铁系预留：inf 只填到出征 gate（casual 不混编不留），works 兵走余位；
       正解 b=比例自纠：inf 份额不足 2:1 即发 special，出征清池后从 0:0 重建） ---- */
    const camps = ['camp', 'works', 'range'].filter((k) => campOf(s, k));
    if (camps.length) {
      const pool = poolN(s);
      const wantPool = level === 'casual' ? 6 : 12;
      if (pool + queuedN(s) < wantPool) {
        let unit = 'inf', kind = 'camp';
        const campKindOf = (u) => (u === 'inf' || u === 'medic') ? 'camp' : (u === 'razor' || u === 'heavy') ? 'works' : 'range';
        const unitN = (c) => { let n = s.pools[c].length; for (let i = 0; i < s.queues.length; i++) if (s.queues[i].unit === c) n += s.queues[i].n; return n; };
        const gate = level === 'casual' ? 6 : level === 'balanced' ? 8 : 10;                  // 与出征 gate 同值（铁系预留位=wantPool-gate）
        const infCap = level === 'casual' ? wantPool : gate;                                  // casual 无混编不留位
        const special = (2 * unitN(level === 'competitive' ? 'heavy' : 'razor') <= unitN('inf'));   // inf:special ≥2:1 断言
        if (level === 'balanced') {
          if (camps.indexOf('works') >= 0 && special) { unit = 'razor'; kind = 'works'; }
        } else if (level === 'competitive') {
          if (enemyMode) { unit = COUNTER_PICK[enemyMode]; kind = campKindOf(unit); }          // 情报克制
          else if (campOf(s, 'works') && special) { unit = 'heavy'; kind = 'works'; }          // 无情报 inf:heavy 2:1
        }
        if (!campOf(s, kind)) kind = camps[0];
        if (BUILDS[kind] && BUILDS[kind].pool.indexOf(unit) < 0) unit = BUILDS[kind].pool[0];
        const nInf = unitN('inf');
        const camp = campOf(s, kind);
        const c = UNITS[unit].cost[camp.lv - 1];
        const roomN = Math.min(QUEUE_MAX - queuedN(s, kind), POOL_MAX - poolN(s) - queuedN(s));
        if (unit !== 'inf' && roomN >= 1 && s.res.g >= c[0] * 1000 && s.res.i >= c[1] * 1000) {
          return { o: { k: 'train', kind, unit, n: Math.min(5, roomN) } };   // n 夹池/队列余量（防 >12 永拒卡死）
        }
        /* 支付档降级（警示②：克制/混编兵铁价付不起时先练 inf 不断档——"先 inf 后
           换装"；比例断言未被满足，铁价后续拍自然补上铁系）+ 预留位护栏（inf 到
           infCap 即停，给 works 铁系留位） */
        if (unit !== 'inf' && nInf < infCap && campOf(s, 'camp')) {
          const ic = campOf(s, 'camp'), ci = UNITS.inf.cost[ic.lv - 1];
          const roomI = Math.min(QUEUE_MAX - queuedN(s, 'camp'), POOL_MAX - poolN(s) - queuedN(s));
          if (roomI >= 1 && s.res.g >= ci[0] * 1000 && s.res.i >= ci[1] * 1000) {
            return { o: { k: 'train', kind: 'camp', unit: 'inf', n: Math.min(5, roomI) } };
          }
        }
        if (unit === 'inf' && nInf < infCap && roomN >= 1 && s.res.g >= c[0] * 1000 && s.res.i >= c[1] * 1000) {
          return { o: { k: 'train', kind, unit, n: Math.min(5, roomN) } };
        }
      }
    }

    /* ---- rally（战斗层 c 壳；动态随战团——slg competitive 同款前导式：集结线=己方
       最前单位行再前导 2 行，战线推进则集结线随之前压（静态线会把军团钉死在中场
       永不能攻城）；balanced 初值=前线 1/2 深度（§4）；competitive 破墙后压敌城心行 ---- */
    if (st.tick >= ERUPT_AT && level !== 'casual') {
      for (let l = 0; l < 3; l++) {
        let front = -1;
        for (let i = 0; i < st.battle.units.length; i++) {
          const u = st.battle.units[i];
          if (u.seat !== seat || u.hp <= 0 || u.lane !== l) continue;
          const rr = (u.y / ROW_M) | 0;
          if (front < 0 || (my === 'A' ? rr < front : rr > front)) front = rr;
        }
        let target;
        if (level === 'competitive' && st.teams[foe].wall <= 0) target = my === 'A' ? 0 : 19;      // 破墙后压敌城心行
        else if (front < 0) target = my === 'A' ? 9 : 10;                                          // 无兵：中线集结位
        else target = my === 'A' ? Math.max(0, front - 2) : Math.min(19, front + 2);               // 随战团前压（2 行前导）
        if (Math.abs(target - mem.lastRallyRow[l]) >= 2) { mem.lastRallyRow[l] = target; return { c: { k: 'rally', lane: l, row: target } }; }
      }
    }
    return {};
  }

  const LEVELS = ['casual', 'balanced', 'competitive'];

  return { META, UNITS, BUILDS, LEVELS, FORMA_ORDER, create, step, battleStep, execOp, serialize, deserialize, brain, fnv1a32, mulberry32,
           consts: { ERUPT_AT, MARCH_CD, POOL_MAX, QUEUE_MAX, TRAIN_TICKS, WALL_HP, KEEP_HP, ROW_M, LANE_M, FIELD_H_M, PASSIVE } };
});
