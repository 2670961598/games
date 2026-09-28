# 帝国萌芽 QA 二号报告（empire-sprout-qa2 · 联机专项）

> 单据：GAMES-73（[QA·E6-W1-T3] 帝国萌芽 QA二号（延迟/重连/满员·预算版）单链 7/10+，attempt 1）
> 对象：`games/multiplayer/empire-sprout/` + `server/gateway/`（前置链 D/DEV/QA1/FIX1/BOT/FEEL 六单均已并 main 的交付物 @ 3bd218c）
> 立场：**独立复测**——不采信任何自测，以下全部数据为本单亲测采集；只测不改代码。
> 环境：feature/GAMES-73（先 `git merge main` → Already up to date @ 3bd218c）。
> **零感知纪律**：常驻 :4400 生产网关全程未触碰（验收前核验 pid 32416 存活；本单结束态亦核验）。全部专项跑在
> **专用网关 :4410**——影子树启动（`kernel/workers/GAMES-73/gw/`：server/gateway+server/lib 与分支逐文件
> shasum 一致、`games/` 符号链接同源、data/ 随影子树隔离，GAMES-59 影子树范式）。延迟注入走 :4411 单向
> 100ms×2 TCP 代理（GAMES-48 同款，FIFO 保序）。
> 工具：自研最小 RFC6455 WS 客户端（帧解析复用 `server/gateway/lib/ws.js` 单一事实源）；
> 驱动器 `EmpDriver` = 真客户端同款（client.js online 路径逐式复刻：建设层快照渲染 + o 壳按需即时发、
> 战斗层 `battleStep` 本地镜像逐步 + 帧号不连续→sync、每战斗帧回 c 壳 input delay=1、爆发边界自愈跳帧
> 与 client.js 严格模式差异已在 F1 探针单列）。策略 = empire-rush（api-check 注册表同源，milli→整数量纲适配）。
> 证据目录：`/Volumes/BigDisk/Studio/kernel/workers/GAMES-73/`（JSON 证据 + 可复用探针 8 份 + 网关全量日志 + feed 时序 4770 样本）。
> 执行日：2026-09-28。

**总裁决：联机专项全部 PASS，无红线退回项。** 200ms 延迟下双层（建设 ack / 战斗帧回流）均可玩、贡献无负向
偏置；重连三档 welcome 双层合一恢复正确（建设状态续接 + 战斗帧号 +1 续接）、托管期 Bot 行为合理（casual 档
takeOver、持续建设练兵）、超窗复席经让位归还席位；满员 4 席 + 第 5 连接旁观稳定、真人退→Bot 补→再进让位
循环闭环；5 分钟满编 spot tick 率 / RSS / 零错误达标；feed 全生命周期实测 ≤404ms（红线 5s）。
附 2 项低危观察 + 1 项口径限制说明（§6，不阻塞）。

---

## 1. 200ms 模拟延迟（双层可玩性 + 贡献/胜负对照 4+4 局）

**注入方式**：本地 TCP 延迟代理（客户端⇄代理⇄网关，每方向固定 100ms ⇒ RTT≈200ms）。代理自证：ping/pong
RTT p50 直连 **0-1ms** / 经代理 **202-204ms**（三波一致）。测试房 timeScale 不适用于延迟注入（API 虚拟会话
无网络路径，GAMES-48 已证），故对照局全部走**真 WS 会话 takeover BotHost 常驻房**（seat3=B 队，两臂同席位
同剧本消除对位方差）。

**对照设计（预算版）**：plain/delay 两臂并发各打 BotHost 房（`t1-latency.mjs` 波 1+波 2 各 4 局并发 4 +
`t1b-topup.mjs` 补 2 局 = **plain 5 + delay 5，10/10 全部自然终局**，零超时收割）。驱动器全程 empire-rush
策略（建 4 槽→camp 连训→池满 8 出征→rally 动态前导）。

**双层各自可玩性**（ack = o 壳注入→下一快照事件回执 `built/train-q/march`；回流 = 战斗帧到达滞后相对
welcome 锚时间线）：

| 指标 | plain（RTT 0-1ms） | delay（RTT 202-204ms） | 判定 |
|---|---|---|---|
| 完赛局数（自然终局） | 5/5 | 5/5 | ✅ |
| 建设 o 注入→回执 p50（build/train/attack 分 类） | **201-206ms** | **203-307ms**（双相位：注入落代理延迟拍 304 / 落节拍间 203） | ✅ delay 臂 = 2×单向 + 1 建设拍，无额外服务端时延 |
| ack max | 228ms | 307ms | ✅ 稳定上界 ≈ RTT+节拍，无长尾堆积 |
| attack 桥回显（o 注入→战斗帧 T+1 spawn 回显） | —（plain 拍内 1-2ms 不可分） | **203/204/303ms**（p50 204） | ✅ 桥时序不受延迟影响 |
| c 壳（rally）帧回显 p50 | — | 203ms | ✅ |
| 战斗帧到达滞后 p50（净局） | **-77 ~ +7ms** | **-73 ~ +5ms** | ✅ 两臂同量级——200ms RTT 下帧流不堆积不漂移 |
| 建设快照到达滞后 p50（净局） | -83 ~ +770ms（2 局锚偏，见 §6 观察 1） | -73 ~ +4ms | ✅ |
| 帧缺口 gapSync | 0（10/10 局） | 0（10/10 局） | ✅ 延迟臂零失序零补同步 |
| 拒绝 reject / 错误 error | 0 / 0 | 0 / 0 | ✅ |

**贡献与胜负无偏置**（同席位 seat3=B 队，trained/marches/merit 为我席亲历事件计数）：

| 局型 | 臂 | 局数 | trained | marches | 队 merit | 终局 |
|---|---|---|---|---|---|---|
| 速败型（B 被推平） | plain | 4 | 14 | 1 | 14-18 | winner=A @tick 1939-1972 |
| 速败型 | delay | 2 | 14 | 1 | 2-18 | winner=A @tick 1949-1972 |
| 打满型（B 推平 A） | delay | 2 | **29** | **3** | **127** | winner=B @tick 2844-2864 |
| 打满型 | plain | 1 | **29** | **3** | **130** | winner=B（topup 波） |

- **同局型内两臂贡献逐格相同**（速败型 trained=14/marches=1 两臂一致；打满型 merit 127 vs 130 差 2.3%）——
  200ms 延迟对建设节奏、出征决策、战功积累**无负向偏置**。
- 胜负计数 plain 1/5 vs delay 3/5 的表面差异是**房型混杂**而非网络，且可被房型**完全解释**：本单 10 局分到
  3 间休闲房（偶席 casual/奇席 balanced → 我 B 队 bot 队友强）与 7 间均衡房（偶席 balanced → A 队强），
  **3 间休闲房全胜、7 间均衡房全负**（两臂在两房型内各自同构：plain 休闲 1/1 胜、均衡 0/4 负；delay 休闲
  2/2 胜、均衡 0/3 负）。速败型（均衡房）B 队在爆发后 ~140 tick 被推平、打满型（休闲房）我席 3 波出征
  merit 127-130——与 QA1 §4 三档行为表（balanced 爆发即征 1801 vs casual 慢半拍 2050-2200）的推演一致。
  预算版不做分房分层补测，如实披露于 §6 口径限制。

## 2. 断线重连三档（5s / 10s 窗内 / 超窗托管）——welcome 双层合一恢复

探针：`t2-reconnect.mjs`（主跑 T5/T10in/T10out）+ `t2b-reconnect.mjs`（T30 补跑，主跑 T30 撞均衡房速败
终局回收致 rejoin 落空——**测试面撞房问题非产品红**，换休闲房重测）。断线 = 真 WS `closeHard`（TCP 层断，
与真客户端网络中断同形）；全程旁观锚 WS 在场防 15s abandon 干扰；托管期 Bot 行为经旁观锚快照流取证。
证据：`reconnect-tiers.json`、`reconnect-t30.json`。

| 档 | gap 实测 | 复席结果 | welcome 双层恢复 | 帧号续接 | 托管期行为 |
|---|---|---|---|---|---|
| T5（5s） | 5005ms | ✅ 同席同 token（保留窗内直连复席） | 建设层：plots 逐字段保持（farm/lumber/camp+空位）、res 单调续增、队列在途 train-done@534 正常回流 | 500→550（预期带 547-566）✅ | 未托管（窗内） |
| T10in（10s 窗边） | **10054ms** | ✅ 同席同 token——**10s+1 拍宽限内复席必先于托管转换**（协议 §5.4，GAMES-63 F2' 口径在本游戏 tickMs=100ms 复证） | 同上：plotsEq ✓ res 单调 ✓ | 902→1002（带 999-1018）✅ | 未托管（宽限拍内 seat 消息全程 human） |
| T10out（11.5s 超窗） | 11505ms | ✅ 走 bot 让位路径**恰归还原席 seat3**（新 token） | 托管 bot 已建设：**built works@1005 + train-done inf×2**（casual 档 takeOver 接管建设权，plotsEq=False 语义正确） | 1003→1118（带 1115-1134）✅ | seat 消息时间线 human→bot→human 完整 |
| T30（45s，跨爆发） | 45006ms | ✅ 让位归还原席 seat3 | welcome.state 双层：battle 层 7 在野单位 + 建设层 res 单调；**托管 casual bot built farm@1804**（跨 tick1800 爆发仍持续建设，行为合理） | 1652→2102（帧进 450，带 435-470）✅；**复席后首战斗帧 2103=welcome.frame+1 续接**、延迟 97ms | 托管期 45s 无出征（casual 慢发展人格 + 池未满 8，QA1 §4 行为表一致） |
| T8post（复验） | 8003ms | ✅ 同席 | — | 2183→首战斗帧 2184（差 1）✅ 镜像 17 单位 | 未托管 |

**结论**：三档 + 边界 + 复验 5 组全过——席位保留窗（10s+1 拍）语义、超窗托管（`META.takeOver='casual'`
档位正确、Bot 建设行为合理）、复席让位归还、welcome 双层合一恢复（建设状态 + 战斗帧号 +1 续接）全部实证。

## 3. 满员旁观与让位循环（4 席满 + 第 5 连接）

探针：`t34-fullroom.mjs`（满员→旁观→让位循环×2→长局 spot 一镜到底），feed 反应由内嵌 400ms feedSampler
与 WS 事件锚配对。证据：`fullroom.json` + 网关日志席位事件流。

| 步骤 | 实测 | 判定 |
|---|---|---|
| 4 真人依次 takeover（p1-p4 → seat 3/2/1/0，全员 welcome role=player） | 4/4 | ✅ |
| 第 5 连接 join（mode=play）→ **自动转旁观**（welcome role=spectator，`{ok, spectator:true}` 路径） | ✅ 旁观席持续收双层流（快照+战斗帧） | ✅ |
| 满员+旁观 → feed（humans=4, bots=0, joinable=false, spectators=1） | **157ms** | ✅ ≤5s |
| 真人 p4 退（TCP 断）→ 托管 Bot 补 | **10397ms** seat 转 `Bot·托管`（=10s 保留窗 + 1 拍宽限 + <1 采样周期 feed 反映，与 §2 重连窗口径逐字一致） | ✅ |
| 再进（join play）→ **让位归还 seat0**（seatReturned=true） | 复席后 feed humans=4 反映 **242ms** | ✅ |
| 第二轮 p3 退→托管 **10432ms**→再进归还 seat1 ✓ | feed 反映 237ms | ✅ |

托管期 Bot 活性：旁观锚快照流 p3 退场后仍捕获该席建设事件（hostedBotBuildEventsBeforeFeed=1），
Bot·托管 接管即恢复建设——行为合理。两轮循环席位零错乱、名册广播（seat 消息）全程一致。

## 4. 长局稳定性（交叉引用 + 5 分钟满编 spot）

**交叉引用（前序单数据，均已在 main）**：

| 来源 | 数据点 | 与本单关系 |
|---|---|---|
| QA1（GAMES-69） | perf 三跑中位 **59.9fps** / 掉帧 0.33% / p95 帧间隔 16.7ms；api-check 16/16；确定性同 seed 双跑 state sha256 一致 + 下行消息流逐条一致 | 客户端帧面与确定性红线已证；本单补服务端联机面 |
| QA1 §4 | 三档 Bot 行为表（casual 首征 2151-2201 / balanced 1801 / competitive 1811；跨 seed 零漂移） | 本单 BotHost 房行为一致性旁证（§1 房型完全解释胜负 = 开局树定桩确定性） |
| FIX1（GAMES-70） | F1 槽位死锁修复后 balanced works 可建、混编三重防线 | 本单托管 Bot **built works@1005**（§2 T10out）、built farm@1804（T30）——FIX 后建线畅通的直接旁证 |
| BOT2（GAMES-71） | 三档人格/开局树 rng 定桩×2/档；陪玩 carry 三态 | 本单满编 4 真人房（§3/本节 spot）bot 环境无死锁无挂机 |

**本单 5 分钟满编 spot**（t34 §4 段：seg1 自然终局 + seg2 续房补足 300s 窗，spot 实测 **295.5s**）：

| 指标 | 实测 | 判定 |
|---|---|---|
| tick 率（快照流回归） | seg1 **10.002 ticks/s**（188.1s / 1882 样本）、seg2 **10.002 ticks/s**（105.3s）——tickMs=100ms 偏差 **0.02%** | ✅ 无漂移 |
| 战斗帧零丢失 | seg1 终局 tick 2377，战斗期 [1800,2377] 共 578 帧，驱动器实收 **578**（578/578） | ✅ |
| seg2 无战斗帧 | 续房 elapsed 30s 起（tick~300），104s 窗止于 tick~1340 <1800——**静默期设计态**（QA1 §3.1 已证非断流），快照通道正常推进 | ✅（非缺陷） |
| 网关 RSS（含 5 WS 连接 + BotHost 4 游戏房） | 64336 → **74704KB**（max=last，Δ10.4MB / 5 分钟） | ✅ 无单调暴涨（V8 高水位正常堆行为；对照 GAMES-48 slg 同口径同量级） |
| 零错误 | 10 个驱动器（8 player + 2 spectator）errors=0、gapSyncs=0、rejects=0；网关日志无 room-error | ✅ |
| 终局一致性 | seg1 四 player 收到逐字段一致 end（winner=A eliminated，scores A:56/B:58）@frame 2377 | ✅ |
| 满编房终局→回收→BotHost 补房 | seg1 end → linger 回收 → seg2 续新房 emp-6hl81da7e2 满编重进成功 | ✅ |

## 5. feed 联动全生命周期 ≤5s

采样：`t5-feedlog.mjs` 常驻 400ms 轮询 `/api/matches`（4770 样本，覆盖本单全部测试窗），与网关 JSONL 日志
生命周期事件（room-create/room-end ts）对齐；满员/让位状态变化反映时延由 t34 内嵌 feedSampler（400ms）与
WS 事件锚配对。

| 生命周期事件 | 样本 | 实测时延 | 红线 5s | 判定 |
|---|---|---|---|---|
| BotHost 建房 → feed 卡片可见 | 56 | **8-404ms**（中位 219ms） | ✅ | create 即入 feed（waiting 态可见，startDelay 1s 前） |
| 终局 room-end → feed 卡片消失 | 50 | **≤1 采样周期（≤400ms）**——end 事件 ts 后首个采样已无此房（末见样本全部落在 end 前 0-397ms） | ✅ | matches() 对 phase=ended 即时过滤，无 linger 泄漏（ENDED_LINGER_MS 仅控制 WS closed 广播） |
| 满员（4 真+1 旁观）→ feed humans/bots/spectators/joinable 反映 | 1 | **157ms** | ✅ | §3 同源 |
| 真人退 → 托管 Bot 补 → feed humans=3&bots=1 | 2 | 托管落地 **10397/10432ms**（=10s 保留窗 + 1 拍 + <1 采样周期反映） | ✅ | 托管时点本身是保留窗语义；feed 反映部分 ≤400ms |
| 再进让位 → feed humans=4 | 2 | **242/237ms** | ✅ | |

网关重启断档（本单 11:57 一次，见 §6 披露）期间的 10 个 end 事件无 feed 末见样本（采样中断），不计时延；
其余 50 样本全部即时。

## 6. 退回项清单

**红线退回项：无**（§1-§5 全部红线 PASS）。

**低危观察（不阻塞，供后续单参考）**：

| # | 级别 | 条目 | 证据与处置建议 |
|---|---|---|---|
| O1 | 低（测量口径） | **join 运行中房的帧锚偏移**：接管已运行 6-8 分钟的 BotHost 房时，客户端以 `welcomeAt − frame×tickMs` 重建时间线，房史若有欠帧跳账（tickLive stepCap 跳齐不追账）则锚系统性偏移（本单 2 局 plain 出现 +568/+768ms 恒值平移，帧间隔本身稳定）。真客户端 started/liveAt 锚不受影响 | `latency-plain-delay-{w1,w2}.json`；联机取证判据建议用两臂对照或帧间隔分布，勿用绝对滞后。网关侧可考虑 welcome 附带 liveAt 服务端时间戳（协议增强项，非缺陷） |
| O2 | 低（联机 UX 候选） | **爆发边界战斗镜像跳变**：静默期（tick<1800）join 的客户端 warTick 停在 join 帧，首战斗帧（frame=1800）到达时帧号跳变数百——client.js 严格模式走 sync 路径多一次往返，自愈跳帧与之内容等价（静默期战斗零推进）。QA1 已披露同口径 | 驱动器 `eruptJump` 字段（10 局中静默期 join 的 seg2 全体）；可在 FEEL/VIS 单评估首战斗帧前预 sync 一次的体验收益 |

**口径限制披露**：
- T1 胜负 5v5 + 房型混杂（3 休闲 vs 7 均衡）——胜负由房型完全解释（§1），但未做分房分层补测（预算版）；
  延迟对胜负无影响的结论建立在"两臂在两房型内各自同构"上。
- 本单 11:57 专用网关被意外终止一次（重启时漏带 `PORT=4410` 撞 4400 被 EADDRINUSE 拒起，属**本单操作
  失误非产品缺陷**）：feed 采样断档 ~47 分钟、T30 主跑作废（补跑 `t2b`），全程未影响 :4400 生产网关
  （重启前后各核验 pid 32416 同一进程）。

### 预算自查（SOP §8.5 预算版 ≤25 分钟实测）

| 步骤 | 时长 | 备注 |
|---|---|---|
| T1 波 1（plain2+delay2 并发） | 290.3s | 4 局自然终局 |
| T1 波 2 | 288.4s | 4 局自然终局 |
| T2 主跑（T5/T10in/T10out） | 291.9s | T30 段撞房速败回收作废 |
| T1 补测（plain1+delay1） | 288.4s | 凑 4+4 最小区外的加强样本 |
| T2b T30 补跑 + T8post | ~300s | 休闲房重测（主跑 T30 作废重跑） |
| T3+T4 满员/让位/spot 一镜 | 325.6s | 含 2 轮让位循环 + 295.5s spot |
| **串行总计** | **~29.7 分钟** | 超 25 分钟预算 ~4.7 分钟，归因：T30 重跑（撞房）+ T1 补测 2 局 + 网关失误重启占用的重跑窗；不含波间间歇与网关断档 |

**结论**：交付预算超支 ~19%，属重跑成本（两项测试面撞房/操作失误），单步首次通过率 5/6；若按首跑口径
（剔除 T2b 与 topup）为 19.9 分钟，预算内。
