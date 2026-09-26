/* =====================================================================
 * 指挥官战场 slg-battlefield —— S1 帧同步共享确定性模拟（GAMES-43）
 * 单一事实源：服务端（server/gateway/sims/slg-battlefield.js 经 require 载入本文件）
 * 与客户端（构建期内联进 index.html，设 window.SLGSim）跑同一份代码。
 * 设计事实源：docs/designs/slg-battlefield.md（GAMES-42 评审通过版）。
 *
 * 确定性纪律（设计书 §5.2，红线，QA 按此核验）：
 *   - 全整数模拟：位置/速度 milli-px（int32 范围内），HP/伤害/造价整型，
 *     CP 用 milli 单位整型（上限 200 = 200_000）；运算只有 + - * 与 >>，
 *     无 Math.random、无 Date.now、无浮点字面量进判定路径。
 *   - Q8 定点乘子：克制/技能乘数全定点（×1.5=384 ×1.75=448 ×2/3=171 ×2=512），
 *     伤害 dmg = base*multQ8>>8。
 *   - 车道制 1D 移动：单位绑定 {lane, dir, y}，每 tick y += dir*spdMilli；
 *     无 A*、无碰撞解算。横向视觉散布是渲染层的事（按 unit id 偏移）。
 *   - 索敌全序 tie-break：dist2 = (Δlane*125_000)² + Δy²（整数精确，<2^53），
 *     候选按 (dist2, entityId) 字典序取最小；AOE/遍历按 entityId 升序。
 *   - 距离平方用普通整数乘法（值域 < 3.2e11 « 2^53，IEEE754 整数精确，
 *     跨平台一致；不用 Math.imul——32 位截断会破坏距离全序）。
 *   - sim 本体零随机：seed = fnv1a32(roomId) 仅记录在 state（演出层预留），
 *     判定路径不消耗。随机只存在于 Bot 决策（brain，服务端侧消耗 rng）。
 *   - 同 tick 固定结算序（§5.2.7）：
 *     research → spawn/drop 落地 → 移动 → 医疗光环 → 普攻/AOE（攻击者 id 升序）
 *     → barrage 落弹 → 占点 → 能量/CP/积分结算 → 胜负判定。
 * ===================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; // Node（.cjs）
  root.SLGSim = api;                                                      // 浏览器内联（classic script）
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------- §5.6 PRNG 参考实现（与 games/_shared/common.js 逐字一致，冻结；仅 Bot 用） ---------- */
  function fnv1a32(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; }
  function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  /* ---------- 常量（全整数，milli-px 单位；数值表=设计书 §1/§2 抄录） ---------- */
  const SEATS = 4;
  const ROW_M = 25000;                 // 1 格 = 25px
  const LANE_M = 125000;               // 车道间距 125px
  const FIELD_H_M = 500000;            // 战场 20 行 × 25px = 500px
  const BASE_Y = { A: 19 * ROW_M + 12500, B: 12500 };        // row 19 / row 0 中心
  const DIR = { A: -1, B: 1 };                               // A 在下向上攻，B 在上向下攻
  const MAX_TICKS = 2700;               // 4.5 分钟（§1.3）
  const CP0 = 40000, CP_MAX = 200000;   // 开局 CP=40；上限 200（milli）
  const CP_BASE = 200, CP_TOWER = 100;  // 基础 2 CP/s + 每塔 1 CP/s（milli/tick）
  const E_MAX = 100, SCORE_WIN = 400;
  const BASE_HP = 1500, DTOWER_HP = 500;
  const POP_MAX = 12, SPAWN_CD = 2;     // 出兵卡冷却 2 tick（§5.1 天然限速）
  const CAP_R2 = 40000 * 40000;         // 占点半径 40px（平方）
  const CAP_MAX = 100, CAP_INF_BONUS = 2;   // inf 占点速度 ×2
  const AOE2 = 30000 * 30000;           // arty AOE 半径 30px
  const BARR_R2 = 45000 * 45000;        // barrage 半径 45px
  const BARR_DMG = 40, BARR_STAGGER = 2;    // 3 发，命中帧 0/+2/+4
  const DROP_TICKS = 15;                // 空降下落 15 tick（无敌）
  const SURGE_Q8 = 171, SURGE_MIN_INT = 4;  // 号令：interval*171>>8，下限 4

  /* ---------- 兵种 × 三阶数值表（§2.1 抄录；速度/射程/攻速三阶不变） ---------- */
  const UNITS = {
    inf:    { cn: '步兵',   costs: [20, 30, 40],    hps: [60, 85, 120],    atks: [8, 10, 14],   interval: 8,  range: 30000,  spd: 4500, cap2: true },
    razor:  { cn: '装甲车', costs: [45, 65, 85],    hps: [180, 250, 360],  atks: [16, 21, 29],  interval: 9,  range: 35000,  spd: 6000 },
    arty:   { cn: '炮兵',   costs: [70, 100, 130],  hps: [90, 125, 180],   atks: [26, 34, 47],  interval: 18, range: 120000, spd: 3200, aoe: true },
    sniper: { cn: '狙击手', costs: [60, 85, 115],   hps: [70, 100, 140],   atks: [34, 44, 61],  interval: 22, range: 150000, spd: 3800 },
    medic:  { cn: '军医',   costs: [35, 50, 65],    hps: [80, 115, 160],   atks: [0, 0, 0],     interval: 0,  range: 0,      spd: 4200, heal: [60, 80, 110], aura: 45000 },
    heavy:  { cn: '重坦克', costs: [110, 155, 210], hps: [520, 730, 1040], atks: [46, 60, 83],  interval: 15, range: 40000,  spd: 2800 },
  };
  const UNIT_CODES = ['inf', 'razor', 'arty', 'sniper', 'medic', 'heavy'];
  const isUnit = (c) => UNIT_CODES.indexOf(c) >= 0;

  /* 克制表（Q8 定点）：atk[u][v] —— inf→arty ×1.5 / razor→inf ×1.5 / arty→razor ×1.75 / sniper→inf ×2 / heavy→建筑 ×2 */
  const COUNTER = { inf: { arty: 384 }, razor: { inf: 384 }, arty: { razor: 448 }, sniper: { inf: 512 }, medic: {}, heavy: {} };
  const HEAVY_VS_BLD = 512;

  /* 指挥官技能表（§2.2；id 与输入编码一致） */
  const SKILLS = [
    { id: 0, code: 'barrage', cn: '火力覆盖', cost: 60, cd: 200, aim: true },
    { id: 1, code: 'repair', cn: '紧急维修', cost: 40, cd: 250, aim: false },
    { id: 2, code: 'drop', cn: '空降突击', cost: 70, cd: 300, aim: true },
    { id: 3, code: 'surge', cn: '集结号令', cost: 50, cd: 240, aim: false, dur: 50 },
  ];

  /* 基地升阶（§1.2 第四循环） */
  const RESEARCH = { 2: { cost: 150000, ticks: 300 }, 3: { cost: 300000, ticks: 450 } };

  const META = {
    gameId: 'slg-battlefield', title: '指挥官战场', seats: SEATS, tickMs: 100, maxTicks: MAX_TICKS,
    mode: '2v2-commander', teams: { A: [0, 2], B: [1, 3] },
    cmdInput: true,           // 离散指令输入（rooms.js 宽限沿用=静默、cmd 一次性语义）
    takeOver: 'casual',       // 断线逾时托管档（§4：casual 托管断线真人，体验友好）
    W: 375, H: 667, fieldH: 500, rows: 20, cell: 25, lanes: 3,
  };

  const teamOf = (seat) => (seat % 2 === 0 ? 'A' : 'B');
  const clamp0 = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /* 距离平方（全序比较用；整数精确 <2^53，禁 imul——32 位截断破坏全序） */
  function laneDist2(ul, uy, tl, ty) { const dl = (ul - tl) * LANE_M, dy = uy - ty; return dl * dl + dy * dy; }

  /* ---------- 初始态（字段序固定，序列化比对用） ---------- */
  function create(seed, opts) {
    const maxTicks = (opts && Number.isInteger(opts.maxTicks) && opts.maxTicks > 0) ? opts.maxTicks : MAX_TICKS;
    const seats = [];
    for (let i = 0; i < SEATS; i++) {
      seats.push({
        seat: i, team: teamOf(i), cp: CP0, energy: 0, tier: 1,
        research: null,            // {tier, due} 研发中
        rally: [-1, -1, -1],       // 每车道集结行（-1 = 无 → 推进到敌基地）
        cd: [0, 0, 0, 0], spawnCd: 0, surgeUntil: 0,
        spawned: 0, kills: 0,      // 战报统计
      });
    }
    return {
      v: 1, seed: (seed >>> 0), tick: 0, maxTicks,
      seats, units: [], shells: [],
      bld: [                       // 建筑（id 即 tie-break 序；base 全宽 → 距离只算 Δy）
        { id: 1, kind: 'base', team: 'A', hp: BASE_HP, max: BASE_HP, y: BASE_Y.A, lane: 0 },
        { id: 2, kind: 'base', team: 'B', hp: BASE_HP, max: BASE_HP, y: BASE_Y.B, lane: 0 },
        { id: 3, kind: 'dtower', team: 'B', hp: DTOWER_HP, max: DTOWER_HP, y: 2 * ROW_M + 12500, lane: 1 },
        { id: 4, kind: 'dtower', team: 'A', hp: DTOWER_HP, max: DTOWER_HP, y: 17 * ROW_M + 12500, lane: 1 },
      ],
      towers: [                    // 信号塔（占领点，§1.1：Alpha 车道0 row6 / Bravo 车道2 row13）
        { i: 0, name: 'alpha', lane: 0, row: 6, y: 6 * ROW_M + 12500, owner: null, cap: 0 },
        { i: 1, name: 'bravo', lane: 2, row: 13, y: 13 * ROW_M + 12500, owner: null, cap: 0 },
      ],
      score: { A: 0, B: 0 }, kills: { A: 0, B: 0 },
      nextId: 100,                 // 建筑 id 1..4，单位 id 从 100 起（tie-break：同距建筑先）
    };
  }

  /* ---------- 小工具 ---------- */
  function popOf(state, seat) { let n = 0; for (let i = 0; i < state.units.length; i++) { const u = state.units[i]; if (u.seat === seat && u.hp > 0) n++; } return n; }
  function towersHeld(state, team) { let n = 0; for (let i = 0; i < state.towers.length; i++) if (state.towers[i].owner === team) n++; return n; }
  function baseOf(state, team) { for (let i = 0; i < state.bld.length; i++) { const b = state.bld[i]; if (b.kind === 'base' && b.team === team) return b; } return { hp: 0, y: BASE_Y[team] }; }

  function pushUnit(state, seat, code, lane, y, dropping) {
    const s = state.seats[seat], spec = UNITS[code], t = s.tier - 1;
    const u = {
      id: state.nextId++, seat, team: s.team, code, tier: s.tier,
      lane: lane, y: y, dir: DIR[s.team],
      hp: spec.hps[t], maxHp: spec.hps[t], atk: spec.atks[t],
      rng: spec.range, spd: spec.spd, interval: spec.interval, cd: 0,
      drop: dropping ? DROP_TICKS : 0, cost: spec.costs[t],
    };
    state.units.push(u);          // id 升序插入（nextId 单调递增，数组天然按 id 全序）
    return u;
  }

  /* 索敌：候选 = 敌方单位（非下落）+ 敌方建筑；按 (dist2, id) 字典序取最小，再验射程 */
  function findTarget(state, u) {
    let best = null, bd = 0, bid = 0;
    const units = state.units;
    for (let i = 0; i < units.length; i++) {
      const t = units[i];
      if (t.hp <= 0 || t.drop > 0 || t.team === u.team) continue;
      const d = laneDist2(u.lane, u.y, t.lane, t.y);
      if (best === null || d < bd || (d === bd && t.id < bid)) { best = t; bd = d; bid = t.id; }
    }
    const bld = state.bld;
    for (let i = 0; i < bld.length; i++) {
      const b = bld[i];
      if (b.hp <= 0 || b.team === u.team) continue;
      const dy = u.y - b.y;
      const d = b.kind === 'base' ? dy * dy : laneDist2(u.lane, u.y, b.lane, b.y);
      if (best === null || d < bd || (d === bd && b.id < bid)) { best = b; bd = d; bid = b.id; }
    }
    if (best === null || bd > u.rng * u.rng) return null;
    return best;
  }

  /* 军医：光环内有受伤友军 → 站定治疗 */
  function hurtAllyInAura(state, u) {
    const r2 = UNITS.medic.aura * UNITS.medic.aura;
    const units = state.units;
    for (let i = 0; i < units.length; i++) {
      const t = units[i];
      if (t.hp <= 0 || t.team !== u.team || t.id === u.id || t.hp >= t.maxHp) continue;
      if (laneDist2(u.lane, u.y, t.lane, t.y) <= r2) return true;
    }
    return false;
  }

  /* 号令期间攻速：interval ×2/3（Q8 171>>8 即 ×0.668，下限 4） */
  function effInterval(state, u) {
    if (state.tick < state.seats[u.seat].surgeUntil) {
      const v = (u.interval * SURGE_Q8) >> 8;
      return v < SURGE_MIN_INT ? SURGE_MIN_INT : v;
    }
    return u.interval;
  }

  /* ---------- 伤害结算（每帧每受击者聚合一条 hit 事件，§5.1） ---------- */
  function applyDmg(state, hits, tgt, dmg, bySeat) {
    if (tgt.hp <= 0 || dmg <= 0) return;
    tgt.hp -= dmg;
    if (tgt.kind) { // 建筑
      const key = 'b' + tgt.id;
      const h = hits[key];
      if (h) h.dmg += dmg;
      else hits[key] = { bld: tgt, seat: teamSeat(tgt.team), by: bySeat, dmg: dmg };
    } else {       // 单位
      const key = 'u' + tgt.id;
      const h = hits[key];
      if (h) h.dmg += dmg;
      else hits[key] = { unit: tgt, seat: tgt.seat, by: bySeat, dmg: dmg };
    }
  }
  const teamSeat = (team) => (team === 'A' ? 0 : 1); // 建筑归属席位（战报事件用，取该队首席）

  function flushHits(state, ev, hits) {
    const keys = Object.keys(hits).sort();       // 受击者 id 升序结算（AOE/遍历序固定）
    for (let i = 0; i < keys.length; i++) {
      const h = hits[keys[i]];
      if (h.unit) {
        const u = h.unit;
        ev.push({ k: 'hit', seat: u.seat, by: h.by, dmg: h.dmg });
        if (u.hp <= 0) {
          const killer = state.seats[h.by];
          if (killer && killer.team !== u.team) {   // 友伤（barrage 敌我不分）不计击杀/能量
            state.kills[killer.team]++;
            killer.kills++;
            killer.energy = clamp0(killer.energy + ((u.cost + 9) / 10 | 0), 0, E_MAX); // 击杀 +⌈造价/10⌉
          }
          ev.push({ k: 'die', seat: u.seat, by: h.by, unit: u.code });
        }
      } else {
        const b = h.bld;
        ev.push({ k: 'hit', seat: teamSeat(b.team), by: h.by, dmg: h.dmg });
        if (b.hp <= 0) {
          if (b.kind === 'base') ev.push({ k: 'basehp', seat: teamSeat(b.team), hp: 0 });
          else ev.push({ k: 'die', seat: teamSeat(b.team), by: h.by, unit: 'tower' });
        }
      }
    }
  }

  /* ---------- 指令校验（畸形=静默 noop；全部字段整数/枚举，§5.1） ---------- */
  const intIn = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi) ? v : null;

  function execCmd(state, seat, cmd, ev) {
    if (!cmd || typeof cmd.k !== 'string') return;
    const s = state.seats[seat];
    if (cmd.k === 'spawn') {
      const unit = isUnit(cmd.unit) ? cmd.unit : null;
      const lane = intIn(cmd.lane, 0, 2);
      if (!unit || lane === null) return;
      const cost = UNITS[unit].costs[s.tier - 1] * 1000;
      if (s.spawnCd > 0 || s.cp < cost || popOf(state, seat) >= POP_MAX) return; // 权威帧拒绝（无事件回流）
      s.cp -= cost; s.spawnCd = SPAWN_CD; s.spawned++;
      pushUnit(state, seat, unit, lane, BASE_Y[s.team], false);
      ev.push({ k: 'spawn', seat: seat, unit: unit, lane: lane });
    } else if (cmd.k === 'skill') {
      const id = intIn(cmd.id, 0, 3);
      if (id === null) return;
      const sk = SKILLS[id];
      if (s.energy < sk.cost || s.cd[id] > 0) return;
      if (sk.aim) {
        const lane = intIn(cmd.lane, 0, 2), row = intIn(cmd.row, 0, 19);
        if (lane === null || row === null) return;
        if (id === 0) {          // barrage：3 发炮击，命中帧 0/+2/+4
          const y = row * ROW_M + 12500;
          for (let n = 0; n < 3; n++) state.shells.push({ id: state.nextId++, seat: seat, team: s.team, lane: lane, y: y, landAt: state.tick + n * BARR_STAGGER });
        } else {                 // drop：3 个当前阶 inf，中心+前后 1 格固定编队（无视 pop）
          for (let r = row - 1; r <= row + 1; r++) {
            const rr = clamp0(r, 0, 19);
            pushUnit(state, seat, 'inf', lane, rr * ROW_M + 12500, true);
          }
        }
      } else if (id === 1) {     // repair：己方基地 +250 + 全体友军 +50
        const b = baseOf(state, s.team);
        b.hp = clamp0(b.hp + 250, 0, b.max);
        ev.push({ k: 'basehp', seat: teamSeat(s.team), hp: b.hp });
        const units = state.units;
        for (let i = 0; i < units.length; i++) { const u = units[i]; if (u.seat === seat && u.hp > 0) u.hp = clamp0(u.hp + 50, 0, u.maxHp); }
      } else {                   // surge：全体友军攻速 ×2/3，持续 50 tick
        s.surgeUntil = state.tick + SKILLS[3].dur;
      }
      s.energy -= sk.cost; s.cd[id] = sk.cd;
      ev.push({ k: 'skill', seat: seat, id: id, lane: intIn(cmd.lane, 0, 2) === null ? 0 : cmd.lane, row: intIn(cmd.row, 0, 19) === null ? 0 : cmd.row });
    } else if (cmd.k === 'rally') {
      const lane = intIn(cmd.lane, 0, 2), row = intIn(cmd.row, 0, 19);
      if (lane === null || row === null) return;
      s.rally[lane] = row;       // 无事件：集结线在 state 内，客户端镜像同步
    } else if (cmd.k === 'research') {
      const tier = intIn(cmd.tier, 2, 3);
      if (tier === null || s.tier !== tier - 1 || s.research !== null) return;
      const r = RESEARCH[tier];
      if (s.cp < r.cost) return;
      s.cp -= r.cost; s.research = { tier: tier, due: state.tick + r.ticks };
      ev.push({ k: 'research', seat: seat, tier: tier, done: 0 });
    }
    /* 'noop' 与未知 k：静默 */
  }

  /* ---------- 单帧推进（inputs: {<seat>:{cmd:{…}}}；缺 cmd = noop） ---------- */
  function step(state, inputs) {
    const ev = [];
    const hits = {};
    const T = state.tick;

    /* 1) research 完成 */
    for (let i = 0; i < SEATS; i++) {
      const s = state.seats[i];
      if (s.research !== null && T >= s.research.due) {
        s.tier = s.research.tier; s.research = null;
        ev.push({ k: 'research', seat: i, tier: s.tier, done: 1 });
      }
    }

    /* 2) 指令执行（席位升序）+ 空降落地计数在移动相位 */
    for (let i = 0; i < SEATS; i++) {
      const inp = inputs[i] || inputs[String(i)];
      const cmd = inp && inp.cmd;
      if (cmd) execCmd(state, i, cmd, ev);
    }

    /* 3) 移动（id 升序）：下落倒数 → 站定判定（射程内有敌/军医有伤员）→ 车道推进（集结线/战场边界夹取） */
    const units = state.units;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.hp <= 0) continue;
      if (u.drop > 0) { u.drop--; continue; }          // 空降下落中（无敌，不可行动）
      const hold = u.atk > 0 ? !!findTarget(state, u) : hurtAllyInAura(state, u);
      if (hold) continue;
      let ny = u.y + u.dir * u.spd;
      const rl = state.seats[u.seat].rally[u.lane];
      if (rl >= 0) { const ry = rl * ROW_M + 12500; ny = u.dir < 0 ? (ny < ry ? ry : ny) : (ny > ry ? ry : ny); }
      u.y = clamp0(ny, 0, FIELD_H_M);
    }

    /* 4) 医疗光环（每 10 tick；同光环不叠加取最高 → 先收集每单位最大治疗量再统一应用） */
    if (T % 10 === 0) {
      const healPlan = [];
      for (let i = 0; i < units.length; i++) {
        const m = units[i];
        if (m.hp <= 0 || m.code !== 'medic' || m.drop > 0) continue;
        const amt = UNITS.medic.heal[m.tier - 1];
        const r2 = UNITS.medic.aura * UNITS.medic.aura;
        for (let j = 0; j < units.length; j++) {
          const t = units[j];
          if (t.hp <= 0 || t.team !== m.team || t.id === m.id || t.hp >= t.maxHp) continue;
          if (laneDist2(m.lane, m.y, t.lane, t.y) <= r2) healPlan.push({ id: t.id, amt: amt }); // id 升序遍历
        }
      }
      if (healPlan.length) {
        const best = {};                                    // 单位 id → 最大治疗量（同光环不叠加取最高）
        for (let i = 0; i < healPlan.length; i++) { const h = healPlan[i]; if (!best[h.id] || best[h.id] < h.amt) best[h.id] = h.amt; }
        const ids = Object.keys(best).sort();               // 结算序固定（id 升序）
        for (let i = 0; i < ids.length; i++) {
          const want = Number(ids[i]), amt = best[ids[i]];
          for (let j = 0; j < units.length; j++) if (units[j].id === want) { units[j].hp = clamp0(units[j].hp + amt, 0, units[j].maxHp); break; }
        }
      }
    }

    /* 5) 普攻/AOE（攻击者 id 升序；阵亡者即时退出后续目标候选） */
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.hp <= 0 || u.drop > 0 || u.atk <= 0) continue;
      if (u.cd > 0) { u.cd--; continue; }
      const tgt = findTarget(state, u);
      if (!tgt) continue;
      const mult = tgt.kind ? (u.code === 'heavy' ? HEAVY_VS_BLD : 256) : (COUNTER[u.code][tgt.code] || 256);
      const dmg = (u.atk * mult) >> 8;
      applyDmg(state, hits, tgt, dmg, u.seat);
      if (UNITS[u.code].aoe && !tgt.kind) {                // arty AOE：目标点半径 30px 敌军全额伤害
        for (let j = 0; j < units.length; j++) {
          const o = units[j];
          if (o.hp <= 0 || o.team === u.team || o.id === tgt.id || o.drop > 0) continue;
          if (laneDist2(tgt.lane, tgt.y, o.lane, o.y) <= AOE2) applyDmg(state, hits, o, dmg, u.seat);
        }
      }
      u.cd = effInterval(state, u);
    }

    /* 6) barrage 落弹（敌我不分；按 shell id 升序=创建序） */
    if (state.shells.length) {
      const live = [];
      for (let i = 0; i < state.shells.length; i++) {
        const sh = state.shells[i];
        if (sh.landAt > T) { live.push(sh); continue; }
        for (let j = 0; j < units.length; j++) {
          const o = units[j];
          if (o.hp <= 0 || o.drop > 0) continue;
          if (laneDist2(sh.lane, sh.y, o.lane, o.y) <= BARR_R2) applyDmg(state, hits, o, BARR_DMG, sh.seat);
        }
      }
      state.shells = live;
    }

    /* 7) 占点（tower i 升序；同半径仅单队在场才推进，inf ×2；被夺方先衰减到 0 归中立） */
    for (let ti = 0; ti < state.towers.length; ti++) {
      const tw = state.towers[ti];
      let a = 0, b = 0, aSeat = -1, bSeat = -1;
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (u.hp <= 0 || u.drop > 0) continue;
        if (laneDist2(tw.lane, tw.y, u.lane, u.y) > CAP_R2) continue;
        const w = u.code === 'inf' ? CAP_INF_BONUS : 1;
        if (u.team === 'A') { a += w; if (aSeat < 0) aSeat = u.seat; }
        else { b += w; if (bSeat < 0) bSeat = u.seat; }
      }
      let changed = false, completed = -1;
      if (a > 0 && b === 0) {
        if (tw.owner === 'B') { tw.cap -= a; if (tw.cap <= 0) { tw.cap = 0; tw.owner = null; } changed = true; }
        else if (tw.owner !== 'A') { tw.cap += a; if (tw.cap >= CAP_MAX) { tw.cap = CAP_MAX; tw.owner = 'A'; completed = aSeat; } changed = true; }
      } else if (b > 0 && a === 0) {
        if (tw.owner === 'A') { tw.cap -= b; if (tw.cap <= 0) { tw.cap = 0; tw.owner = null; } changed = true; }
        else if (tw.owner !== 'B') { tw.cap += b; if (tw.cap >= CAP_MAX) { tw.cap = CAP_MAX; tw.owner = 'B'; completed = bSeat; } changed = true; }
      }
      if (completed >= 0) {
        const s = state.seats[completed];
        s.energy = clamp0(s.energy + 15, 0, E_MAX);        // 占点完成 +15（§1.2）
        state.score[s.team] += 0;                            // 分数在相位 8 按持有结转
      }
      if (changed) ev.push({ k: 'cap', tower: tw.i, alpha: tw.cap, owner: tw.owner, capTeam: tw.owner || (a > 0 && b === 0 ? 'A' : b > 0 ? 'B' : null) });
    }

    /* 8) 能量/CP/积分结算 */
    for (let i = 0; i < SEATS; i++) {
      const s = state.seats[i];
      s.cp = clamp0(s.cp + CP_BASE + CP_TOWER * towersHeld(state, s.team), 0, CP_MAX);
      if (s.spawnCd > 0) s.spawnCd--;
      for (let c = 0; c < 4; c++) if (s.cd[c] > 0) s.cd[c]--;
    }
    if ((T + 1) % 10 === 0) {
      for (let i = 0; i < SEATS; i++) { const s = state.seats[i]; s.energy = clamp0(s.energy + 1, 0, E_MAX); } // 自然 +1/s
      state.score.A += 2 * towersHeld(state, 'A');          // 每守信号塔每秒 +2 分（§1.3）
      state.score.B += 2 * towersHeld(state, 'B');
    }

    /* 清扫阵亡（保序 filter；events 已在 flushHits 结算） */
    flushHits(state, ev, hits);
    if (units.some((u) => u.hp <= 0)) state.units = units.filter((u) => u.hp > 0);
    state.bld = state.bld.filter((b) => b.hp > 0);

    state.tick = T + 1;

    /* 9) 胜负判定（双通道先到者胜，§1.3） */
    const baseA = state.bld.find((b) => b.kind === 'base' && b.team === 'A');
    const baseB = state.bld.find((b) => b.kind === 'base' && b.team === 'B');
    const deadA = !baseA, deadB = !baseB;
    if (deadA || deadB) {
      return { events: ev, over: true, result: { winner: deadA && deadB ? 'draw' : (deadA ? 'B' : 'A'), scores: { ...state.score }, kills: { ...state.kills }, reason: 'eliminated' } };
    }
    if (state.score.A >= SCORE_WIN || state.score.B >= SCORE_WIN) {
      const w = state.score.A === state.score.B ? 'draw' : (state.score.A > state.score.B ? 'A' : 'B');
      return { events: ev, over: true, result: { winner: w, scores: { ...state.score }, kills: { ...state.kills }, reason: 'score' } };
    }
    if (state.tick >= state.maxTicks) {
      let w;
      if (state.score.A !== state.score.B) w = state.score.A > state.score.B ? 'A' : 'B';
      else {
        const hpA = baseA.hp, hpB = baseB.hp;              // 平局比基地 HP 百分比（双方上限同为 1500）
        w = hpA === hpB ? 'draw' : (hpA > hpB ? 'A' : 'B');
      }
      return { events: ev, over: true, result: { winner: w, scores: { ...state.score }, kills: { ...state.kills }, reason: 'timeout' } };
    }
    return { events: ev, over: false };
  }

  const serialize = (state) => JSON.stringify(state);
  const deserialize = (json) => JSON.parse(json);

  /* =====================================================================
   * Bot 决策 brain(state, seat, level, rng) → {cmd:{…}}
   * 三档策略表=设计书 §4 抄录。rng 由调用方持有（服务端每 bot 一个 mulberry32；
   * 离线模式客户端自持）。决策记忆存 WeakMap（键=state 对象，不入模拟状态、
   * 不入帧协议——服务端侧消耗，客户端只回放输入，不破坏确定性）。
   * ===================================================================== */
  const FIRST = { casual: 150, balanced: 30, competitive: 8 };      // 首行动 tick
  const DECIDE = { casual: 50, balanced: 20, competitive: 10 };     // 决策间隔
  const SAVE_WIN = 300;                                             // F2：competitive 克制储蓄窗口上限（tick）
  const NOOP = { cmd: { k: 'noop' } };

  const botMem = new WeakMap();
  function memOf(state, seat) {
    let m = botMem.get(state);
    if (!m) { m = {}; botMem.set(state, m); }
    let s = m[seat];
    if (!s) {
      s = { lastDecide: -1, seenTick: -1, seen: new Set(), enemyLog: [], wanted: null,
            rot: 0, laneFlip: 0, openerInf: 0, openerRallied: false, towerHad: [null, null],
            retowerUntil: -1, retowerIdx: -1, rallySet: [false, false, false], lastRallyRow: [-9, -9, -9],
            saveFor: null, saveSince: -1, saveSpawned: -1 };
      m[seat] = s;
    }
    return s;
  }

  /* 敌方最近出兵情报（每次 brain 调用增量登记，服务端视角信息） */
  function trackEnemy(state, seat, mem) {
    if (mem.seenTick === state.tick) return;
    mem.seenTick = state.tick;
    const my = teamOf(seat);
    for (let i = 0; i < state.units.length; i++) {
      const u = state.units[i];
      if (u.team === my || mem.seen.has(u.id)) continue;
      mem.seen.add(u.id);
      mem.enemyLog.push(u.code);
      if (mem.enemyLog.length > 8) mem.enemyLog.shift();
    }
  }

  /* 最近 n 次敌方出兵众数 */
  function enemyMode(mem, n) {
    const log = mem.enemyLog.slice(-n);
    const cnt = {};
    let best = null, bn = 0;
    for (let i = 0; i < log.length; i++) { cnt[log[i]] = (cnt[log[i]] || 0) + 1; if (cnt[log[i]] > bn) { bn = cnt[log[i]]; best = log[i]; } }
    return best;
  }

  /* 克制选择：inf↔razor↔arty 三角、多 sniper→razor、多 heavy→arty（§4） */
  const COUNTER_PICK = { inf: 'razor', razor: 'arty', arty: 'inf', sniper: 'razor', heavy: 'arty', medic: 'razor' };
  const TIER_PICK = ['inf', 'razor', 'heavy'];   // 无情报 → 按己方科技阶最优性价比

  /* 敌方集群：最大同车道 45px 窗（barrage 口径） */
  function bestCluster(state, enemyTeam) {
    let best = null;
    const units = state.units, r2 = BARR_R2;
    for (let i = 0; i < units.length; i++) {
      const e = units[i];
      if (e.hp <= 0 || e.drop > 0 || e.team !== enemyTeam) continue;
      let c = 0;
      for (let j = 0; j < units.length; j++) {
        const o = units[j];
        if (o.hp <= 0 || o.drop > 0 || o.team !== enemyTeam) continue;
        if (laneDist2(e.lane, e.y, o.lane, o.y) <= r2) c++;
      }
      if (!best || c > best.count) best = { lane: e.lane, y: e.y, count: c };
    }
    return best;
  }

  function weakestLane(state, enemyTeam) {
    const cnt = [0, 0, 0];
    for (let i = 0; i < state.units.length; i++) { const u = state.units[i]; if (u.hp > 0 && u.drop === 0 && u.team === enemyTeam) cnt[u.lane]++; }
    let min = cnt[0] + cnt[1] + cnt[2] + 1;
    for (let l = 0; l < 3; l++) if (cnt[l] < min) min = cnt[l];
    if (cnt[1] === min) return 1;          // 平手偏好中车道（推家最短路径旁有塔，权衡取中）
    if (cnt[0] === min) return 0;
    return 2;
  }

  function canCast(state, seat, id) {
    const s = state.seats[seat];
    return s.energy >= SKILLS[id].cost && s.cd[id] <= 0;
  }

  function affordable(state, seat, code) {
    const s = state.seats[seat];
    return s.cp >= UNITS[code].costs[s.tier - 1] * 1000;
  }

  function popOfSeat(state, seat) { return popOf(state, seat); }

  const myBaseRow = (team) => (team === 'A' ? 19 : 0);
  const enemyBaseRow = (team) => (team === 'A' ? 0 : 19);
  const rowOf = (y) => clamp0((y / ROW_M) | 0, 0, 19);

  function brain(state, seat, level, rng) {
    const s = state.seats[seat];
    if (!s) return NOOP;
    const mem = memOf(state, seat);
    trackEnemy(state, seat, mem);

    if (mem.lastDecide < 0) { if (state.tick < FIRST[level]) return NOOP; mem.lastDecide = state.tick; }
    else if (state.tick - mem.lastDecide < DECIDE[level]) return NOOP;
    mem.lastDecide = state.tick;

    const my = s.team, foe = my === 'A' ? 'B' : 'A';
    const myBase = baseOf(state, my);

    /* ---- 技能战术（三档差异主战场） ---- */
    if (level === 'casual') {
      // 有能量+冷却好 30% 概率随机放（barrage 常放空）
      if (rng() < 0.3) {
        const ids = [];
        for (let i = 0; i < 4; i++) if (canCast(state, seat, i)) ids.push(i);
        if (ids.length) {
          const id = ids[(rng() * ids.length) | 0];
          if (id === 0 || id === 2) return { cmd: { k: 'skill', id: id, lane: (rng() * 3) | 0, row: (rng() * 20) | 0 } };
          return { cmd: { k: 'skill', id: id } };
        }
      }
    } else if (level === 'balanced') {
      if (myBase.hp < 900 && canCast(state, seat, 1)) return { cmd: { k: 'skill', id: 1 } };                    // repair：基地 <60%
      const cl = bestCluster(state, foe);
      if (cl && cl.count >= 4 && canCast(state, seat, 0)) return { cmd: { k: 'skill', id: 0, lane: cl.lane, row: rowOf(cl.y) } }; // barrage：敌集群 ≥4
      let pushing = false;
      let own = 0;
      for (let i = 0; i < state.units.length; i++) { const u = state.units[i]; if (u.seat === seat && u.hp > 0) { own++; if (Math.abs(u.y - baseOf(state, foe).y) < 150000) pushing = true; } }
      if (pushing && own >= 6 && canCast(state, seat, 3)) return { cmd: { k: 'skill', id: 3 } };                 // surge：≥6 单位推家
    } else { // competitive
      if (myBase.hp < 1125 && canCast(state, seat, 1)) return { cmd: { k: 'skill', id: 1 } };                   // repair：<75% 即用
      let foeSurge = false;
      for (let i = 0; i < state.seats.length; i++) if (state.seats[i].team === foe && state.tick < state.seats[i].surgeUntil) foeSurge = true;
      const cl = bestCluster(state, foe);
      if (canCast(state, seat, 0) && ((cl && cl.count >= 4) || foeSurge)) {
        const tgt = cl || { lane: 1, y: baseOf(state, my).y + (my === 'A' ? -125000 : 125000) };
        return { cmd: { k: 'skill', id: 0, lane: tgt.lane, row: rowOf(tgt.y) } };                                // barrage：集群 ≥4 或敌 surge 期间
      }
      if (canCast(state, seat, 2)) {                                                                            // drop：抢点/断兵线
        for (let ti = 0; ti < state.towers.length; ti++) {
          const tw = state.towers[ti];
          if (tw.owner === my) continue;
          let near = 0;
          for (let i = 0; i < state.units.length; i++) { const u = state.units[i]; if (u.seat === seat && u.hp > 0 && laneDist2(tw.lane, tw.y, u.lane, u.y) <= CAP_R2) near++; }
          if (near === 0 && (state.tick < 400 || tw.owner === foe)) return { cmd: { k: 'skill', id: 2, lane: tw.lane, row: tw.row } }; // 抢点（前期/被夺反攻）
        }
        if (state.tick > 200 && state.tick % 100 === 0 && popOfSeat(state, seat) < POP_MAX) {                     // 断兵线：砸敌基地门口
          const eb = baseOf(state, foe);
          return { cmd: { k: 'skill', id: 2, lane: weakestLane(state, foe), row: clamp0(enemyBaseRow(my) + (my === 'A' ? 2 : -2), 0, 19) } };
        }
      }
      let pushing = false, own = 0;
      for (let i = 0; i < state.units.length; i++) { const u = state.units[i]; if (u.seat === seat && u.hp > 0) { own++; if (Math.abs(u.y - baseOf(state, foe).y) < 150000) pushing = true; } }
      if (pushing && own >= 6 && canCast(state, seat, 3)) return { cmd: { k: 'skill', id: 3 } };
    }

    /* ---- 研究（攒钱闸门：档位阈值后停止出兵直至凑够研发费，防"有 CP 即花"永不升阶） ---- */
    let saving = 0;
    if (level === 'balanced') {
      if (state.tick >= 600 && s.tier === 1 && !s.research) {
        if (s.cp >= RESEARCH[2].cost) return { cmd: { k: 'research', tier: 2 } };
        saving = 2;
      }
    } else if (level === 'competitive') {
      if (s.tier === 1 && state.tick >= 400 && !s.research) {
        if (s.cp >= RESEARCH[2].cost) return { cmd: { k: 'research', tier: 2 } };
        /* F2 补（GAMES-45）：敌方众数非 inf（razor/arty/heavy 压场）时 T2 储蓄让位——
           被克制压制期零出兵攒 150CP ≈ 整段战线白给（razor 铺场探针：恰逢储蓄窗被拆家），
           优先走 F2b 克制储蓄应对；敌无情报/主 inf（未被针对）时照旧攒 T2 */
        const mode = enemyMode(mem, 3);
        if (!mode || mode === 'inf') saving = 2;
      } else if (s.tier === 2 && state.tick >= 900 && !s.research && s.cp >= RESEARCH[3].cost) {
        /* F2 补（GAMES-45）：T3 改机会式升阶——原硬储蓄 300CP 在基础收入下 ≈1250 tick 零出兵，
           对会玩对手等于后半局弃权（QA 实证 t1900 起双塔尽失被 score 反杀 400-300）。
           T2 储蓄保留（前期经济封闭、QA 实测 @1028 达成）；T3 只在 CP 恰好攒够时升，其余照常出兵。 */
        return { cmd: { k: 'research', tier: 3 } };
      }
    }

    /* ---- 出兵 ---- */
    if (saving) return NOOP;                       // 研发储蓄期不出兵（研究期间出兵照常是 sim 规则，此处是策略）
    let spawnCode = null, spawnLane = 0;
    if (level === 'casual') {
      // 解锁池内 rng 均匀；攒到 2× 造价才出。
      // F1 修复（GAMES-45）：闸门夹取 CP 上限内——heavy 2×110=220 > 上限 200 时原闸门永不可达，
      // wanted 只在成功出兵后重掷 → 掷中即整局零出兵、CP 顶死（QA bots-casual g3 seat2 实证）。
      // 夹到 CP_MAX−1000 后任意兵种闸门必可达，"攒 2×"的慢节奏意图不变。
      if (!mem.wanted) mem.wanted = UNIT_CODES[(rng() * 6) | 0];
      const cost = UNITS[mem.wanted].costs[s.tier - 1] * 1000;
      const gate = Math.min(cost * 2, CP_MAX - 1000);
      if (s.cp >= gate && popOfSeat(state, seat) < POP_MAX) { spawnCode = mem.wanted; mem.wanted = null; }
      spawnLane = (rng() * 3) | 0;
    } else if (level === 'balanced') {
      // 固定轮换 inf→razor→arty；开局 2×inf 试探（tick 30/50）
      if (state.tick <= 60) spawnCode = 'inf';
      else spawnCode = ['inf', 'razor', 'arty'][mem.rot % 3];
      if (!affordable(state, seat, spawnCode) || popOfSeat(state, seat) >= POP_MAX) return NOOP;
      mem.rot++;
      spawnLane = mem.laneFlip === 0 ? 0 : 2;      // 两车道轮换
      mem.laneFlip = 1 - mem.laneFlip;
    } else { // competitive
      // 快攻开局：先集结最近塔车道 → 3×inf（首兵驻塔占点，余二压中路）+ drop 抢点（技能段）
      if (mem.openerInf < 3) {
        const tw = state.towers[my === 'A' ? 1 : 0];  // A 最近 Bravo(lane2 row13) / B 最近 Alpha(lane0 row6)
        if (!mem.openerRallied) {
          mem.openerRallied = true; mem.lastRallyRow[tw.lane] = tw.row;
          return { cmd: { k: 'rally', lane: tw.lane, row: tw.row } };
        }
        spawnCode = 'inf';
        spawnLane = mem.openerInf === 0 ? tw.lane : 1;
        if (!affordable(state, seat, spawnCode) || popOfSeat(state, seat) >= POP_MAX) return NOOP;
        mem.openerInf++;
      } else {
        const mode = enemyMode(mem, 3);
        spawnCode = mode ? COUNTER_PICK[mode] : TIER_PICK[s.tier - 1];
        /* 保命压顶（GAMES-45）：敌方单位逼近己方基地（5 行内）→ 出兵车道让位协防
           （razor 铺场探针实证：保塔弃中路被穿透拆家）。只改车道不停克制储蓄——
           克制兵恰是守家主力（arty 120px 射程覆盖基地前沿），攒够即送防区 */
        let threatLane = -1;
        for (let i = 0; i < state.units.length; i++) {
          const u = state.units[i];
          if (u.hp <= 0 || u.drop > 0 || u.team !== foe) continue;
          if (Math.abs(u.y - myBase.y) <= 5 * ROW_M) { threatLane = u.lane; break; }
        }
        /* F2a 争塔（GAMES-45）：未持有的信号塔且点上己方不足 2 → 出兵优先送塔。
           原版只有"己方持有后被夺"的 10s 反攻窗（下方集结段），从未持有则永久弃塔 →
           让出双信号塔被积分通道推平（QA competitive-probe 实证）。塔=CP 收入+积分双通道。
           阈值取 <2 而非 <1：添油式单 inf 会被"驻军 1 + 补位"的对手逐个吃掉（macro-push
           实测后半局 14 连 inf 白给），攒够局部 2v1 才动手；inf 占点 ×2、克制兵清守军，编队互补。 */
        let contestLane = -1;
        for (let ti = 0; ti < state.towers.length && contestLane < 0; ti++) {
          const tw = state.towers[ti];
          if (tw.owner === my) continue;
          let near = 0;
          for (let i = 0; i < state.units.length; i++) { const u = state.units[i]; if (u.seat === seat && u.hp > 0 && laneDist2(tw.lane, tw.y, u.lane, u.y) <= CAP_R2) near++; }
          if (near < 2) contestLane = tw.lane;
        }
        if (!affordable(state, seat, spawnCode)) {
          /* F2b 克制储蓄（GAMES-45）：目标兵买不起 → 停手攒钱，不再"有 CP 即花"直接降 inf
             （原互锁：2CP/s 收入下 45/70CP 克制兵永攒不齐，5 局 0 次非 inf 出兵，
             克制表名存实亡——QA bots-competitive 实证）。储蓄期零出兵零花费（cp 只进不出，
             集结段照常执行）；被动期由 SAVE_WIN=300 tick 封顶，超窗/攒钱目标不可达
             （T3 heavy 210 > CP 上限 200）/己方全灭/敌迫家门（保命压顶）→ 降级 inf 保底
             （支付档降级：inf 先出、攒够换克制）。期间一旦出兵（spawned 计数变动，
             含争塔 inf）→ 窗口重开续攒；情报目标切换（mode 变）→ 窗口随 saveFor 重置。
             储蓄与争塔不互斥：攒够的克制兵直送争塔车道。 */
          const reachable = UNITS[spawnCode].costs[s.tier - 1] * 1000 <= CP_MAX - 1000;
          const saveOk = spawnCode !== 'inf' && reachable && popOfSeat(state, seat) > 0;
          if (saveOk && (mem.saveFor !== spawnCode || mem.saveSpawned !== s.spawned)) {
            mem.saveFor = spawnCode; mem.saveSince = state.tick; mem.saveSpawned = s.spawned;
          }
          if (saveOk && state.tick - mem.saveSince <= SAVE_WIN) spawnCode = null;   // 储蓄中：不出兵（落到下方集结段）
          else spawnCode = 'inf';                                                   // 超窗/不可达/全灭 → 支付档降级
        }
        spawnLane = threatLane >= 0 ? threatLane : contestLane >= 0 ? contestLane : weakestLane(state, foe);
        if (!spawnCode || !affordable(state, seat, spawnCode) || popOfSeat(state, seat) >= POP_MAX) spawnCode = null;
      }
    }
    if (spawnCode) return { cmd: { k: 'spawn', unit: spawnCode, lane: spawnLane } };

    /* ---- 集结/信号塔 ---- */
    if (level === 'balanced') {
      // 路过顺占：≥2 单位经过未持信号塔 → 该车道集结到塔位
      for (let ti = 0; ti < state.towers.length; ti++) {
        const tw = state.towers[ti];
        if (tw.owner === my) continue;
        let near = 0;
        for (let i = 0; i < state.units.length; i++) { const u = state.units[i]; if (u.seat === seat && u.hp > 0 && laneDist2(tw.lane, tw.y, u.lane, u.y) <= CAP_R2) near++; }
        if (near >= 2 && !mem.rallySet[tw.lane]) {
          mem.rallySet[tw.lane] = true; mem.lastRallyRow[tw.lane] = tw.row;
          return { cmd: { k: 'rally', lane: tw.lane, row: tw.row } };
        }
      }
      // 前线 1/2 深度集结（每车道一次）
      const frontRow = my === 'A' ? 9 : 10;
      for (let l = 0; l < 3; l++) {
        if (!mem.rallySet[l]) { mem.rallySet[l] = true; mem.lastRallyRow[l] = frontRow; return { cmd: { k: 'rally', lane: l, row: frontRow } }; }
      }
    } else if (level === 'competitive') {
      // 专职占塔：首个决策派 1×inf 走最近塔（出兵段已优先）；点被夺 10s 内反攻
      for (let ti = 0; ti < state.towers.length; ti++) {
        const tw = state.towers[ti];
        if (mem.towerHad[ti] === my && tw.owner !== my) { mem.retowerUntil = state.tick + 100; mem.retowerIdx = ti; }
        mem.towerHad[ti] = tw.owner;
      }
      let rallyLane = -1, rallyRow = -1;
      if (mem.retowerIdx >= 0 && state.tick <= mem.retowerUntil && state.towers[mem.retowerIdx].owner !== my) {
        rallyLane = state.towers[mem.retowerIdx].lane; rallyRow = state.towers[mem.retowerIdx].row;
      } else {
        /* F2c 持续争塔（GAMES-45）：还有未持有的信号塔（含从未持有——原版反攻窗只覆盖
           "己方持有后被夺"）→ 该塔车道集结到塔位，单位驻点争塔（与出兵段 F2a 的争塔 inf、
           技能段 drop 抢点三路配合）；双塔在手才转动态前线推进 */
        let contesting = false;
        for (let ti = 0; ti < state.towers.length && !contesting; ti++) {
          const tw = state.towers[ti];
          if (tw.owner !== my) { rallyLane = tw.lane; rallyRow = tw.row; contesting = true; }
        }
        if (!contesting) {
          // 动态：随战团位置（各车道己方最前单位行）
          for (let l = 0; l < 3; l++) {
            let front = -1;
            for (let i = 0; i < state.units.length; i++) { const u = state.units[i]; if (u.seat === seat && u.hp > 0 && u.lane === l) { const r = rowOf(u.y); if (front < 0 || (my === 'A' ? r < front : r > front)) front = r; } }
            const target = front >= 0 ? front : enemyBaseRow(my);
            if (Math.abs(target - mem.lastRallyRow[l]) >= 2) { rallyLane = l; rallyRow = target; break; }
          }
        }
      }
      if (rallyLane >= 0 && (rallyRow !== s.rally[rallyLane])) {
        mem.lastRallyRow[rallyLane] = rallyRow;
        return { cmd: { k: 'rally', lane: rallyLane, row: rallyRow } };
      }
    }

    return NOOP;
  }

  const LEVELS = ['casual', 'balanced', 'competitive'];

  return { META, UNITS, SKILLS, RESEARCH, LEVELS, create, step, execCmd, serialize, deserialize, brain, fnv1a32, mulberry32,
           consts: { POP_MAX, CP_MAX, E_MAX, SCORE_WIN, BASE_HP, DTOWER_HP, ROW_M, LANE_M, FIELD_H_M, BASE_Y, CAP_MAX } };
});
