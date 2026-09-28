# 帝国萌芽 STRESS 压测+单链收官（GAMES-76 · 预算版）

> 单据：GAMES-76（[STRESS·E6-W1-T3] 帝国萌芽 压测+单链收官（10/10 预算版），attempt 0）
> 纪律：Q-007 预算版——总实测 ≤25 分钟、全程每步计时、超 20 分钟即转收尾。实测构成：A 组多房 8:00 + B 组满编 spot 5:00 + C 组四游戏混编 5:00，三组采样墙钟合计 **18 分 00 秒**（含过渡的全程作业窗 22:47，超 20 分钟软线已按纪律转收尾；全程计时见 §5）。
> 环境：专用网关 `127.0.0.1:4420`（影子树 `kernel/workers/GAMES-76/gw/`，gateway+server/lib 与 repo 逐字节一致 shasum 留档、games 走符号链接、data 随影子路径隔离——Article 183-128 影子树隔离法；生产 :4399/:4400 全程零感知，验收前后各核验一次）。零服务端代码改动：分房/满编/托管全部经公开协议（join/spectate）与测试 API 驱动。
> 证据：`/Volumes/BigDisk/Studio/kernel/workers/GAMES-76/`（a-rooms.json / b-full.json / c-mixed.json / gateway.log / shasum-shadow.txt / chain.log 接力时间戳）。

## 1. A 组：多房并行（≥6 房 · 8 分钟抽样）

**构房机制（纯公开协议+测试 API）**：数据集一=6 间 empire 测试房（`POST /api/test/room`，botLevels=[null(API 席)+3×balanced]，tick 走 `/api/test/state`）；数据集二=BotHost 自然负载（emp minLive=2/maxRooms=4，casual/balanced 轮换房，spectator 锚定）。测试房自然终局即清扫重建（8 分钟内 18 建/12 终，bot 局 2-4 分钟一轮的快速轮换面）。

| 指标 | 实测（48 采样 × 10s = 8:00） | 判据 |
|---|---|---|
| 并发房 | 测试房 **6/6 全程 live**（首采样 0=startDelay 窗，第 2 采样起恒 6）；BotHost emp 房 2-4 恒存（轮换不断档）；网关 rooms 9-19 | ≥6 房全程 ✅ |
| tick 率 | 名义 10Hz；独立 cadence 探针 30s 窗 **9.995/s**；B 组旁观快照 frame 率同窗 **9.97-10.00/s** 互证 | 10Hz±1% ✅ |
| tick 漂移 | 270 房-采样点全域 **[0,1] tick**（对各自 live 锚点；116 点=1、其余 0，无累计） | ≤2 tick ✅ |
| 网关 RSS | 70,336（段首低点）→ 采样期 70,336-112,752KB；前半均值 87,586 vs 后半 111,436KB（18 建房/12 终局轮换 churn 高水位，判读见 §4①②） | 有界披露 ✅ |
| 网关 CPU | 均值 **5.1%**、峰 16.8%（GC 毛刺秒级回落） | 低负载 ✅ |
| feed 正确性 | 全部 48 采样全量校验 **0 错**（前缀 emp-/席位≤4/joinable==humans<4/mode=2v2-empire/elapsedMs；测试房不泄漏进 feed） | 零错 ✅ |
| 错误面 | uncaught Δ0、room-error Δ0 | 零错误 ✅ |

**口径披露（收官复核）**：脚本 summary 的终局 tick 率字段（6.667/s）混入了已终局房的冻结 tick（Δtick/Δt 被拉低），**判据不采信该字段**；以全程漂移序列 [0,1]（其除数即 10Hz 名义）+ 独立 cadence 探针 9.995/s + B 组旁观 frame 率 9.97-10.00/s 三证合一口径。原始重算见证据 json samples.driftNow。

**判定：PASS**。证据：a-rooms.json（48 采样逐条/事件面/summary）。

## 2. B 组：长局稳定性（三单交叉引用 + 5 分钟满编 spot）

### 2.1 交叉引用（不重跑，验收口径=ticket 指定：QA1/QA2/BOT 三单）

| 观测段 | 单 | 口径与结果 | 证据 |
|---|---|---|---|
| QA1 三支柱+S3 专项 | GAMES-69 | 红线全过零退回（串行实测 8m33s 终跑）；s3-probe 隔离房账本 **2661 条**（快照+帧）、全量 state 采样 422 帧、渲染 59.9fps；发现 F1/F2 bot 平衡项（已由 FIX1 收口） | empire-sprout-qa1.md |
| QA2 联机专项 | GAMES-73 | **10/10 局自然终局**（plain5+delay5，200ms 延迟无偏置、零超时收割）；重连窗 10s+1 拍精确复证（gap 10054ms 复席先于托管）；满员/让位循环×2+spot 一镜 325.6s（spot 295.5s）；feed 全生命周期 ≤404ms | empire-sprout-qa2.md |
| BOT 深化 | GAMES-71 | 三档人格×开局树 rng 定桩×2/档，**双证 18 局**（6 局/档）建序指纹全达标且 GAMES-70 警示①约束全守；陪玩 carry 三态（补农/补军建序+兵比分形实测）；憋池等爆发≠挂机口径入档 | GAMES-71 报告 |

三单累计 **28+ 局完整对局、各自实测窗内零红线退回**，横跨 DEV→QA1→FIX1→BOT→FEEL→QA2→FIX2→VIS 八次代码演进；本单 A/B/C 三组再续 18+ 分钟（6+4 房并行、满编 4/4、四游戏混编）。

### 2.2 本单 5 分钟满编 spot（4/4 真人席）

口径：取 BotHost emp 房以 4 条 play 连接填满 4/4 真人席（bots 清 0、joinable=false，复用 QA2 t34 满编口径），1 条旁观锚测快照 frame 率；末尾全撤观测房周期回收（S3 语义=abandon 终局+dispose，非 mmo 的 seat-bot 托管）。

| 指标 | 实测 | 判据 |
|---|---|---|
| 满编保持 | **30/30 采样 humans=4、joinable=false、bots=0、spectators=1**（4 条 play 连接 10s 内 takeover 就席，第 5 连接面=旁观） | 满编全程 ✅ |
| 满编房 tick 率 | 旁观快照 frame 率 **9.972-10.006 Hz**（单段 300.3s 一镜到底，含静默期→tick1800 爆发→战斗段全程） | 10Hz±1% ✅ |
| 策略操作面 | EmpDriver rush 策略 o 壳注入 **129 次全部快照回执确认**（build/train/attack 全链在跑） | 双通道活性 ✅ |
| 网关 RSS/CPU | 84,528-109,568KB（前半均值 108,299→后半 **97,095KB，负增长 -11.2MB**）；CPU 均值 2.0%、峰 3% | 有界收敛 ✅ |
| 撤席回收 | 4 席全撤 → **room-end(reason=abandon) 1.0s + room-dispose 8.0s** 闭环（S3 语义：全真人撤席=abandon 终局即回收，对照 mmo 常驻世界的 seat-bot 托管——房周期同样闭环，网关日志逐行可溯） | 闭环 ✅ |
| 错误面 | feed 校验 0 错；uncaught Δ0、room-error Δ0 | 零错误 ✅ |

**判定：PASS**。证据：b-full.json。

## 3. C 组：四游戏混编（本作+指挥官战场+净斗坦克+星海小镇 · 5 分钟）

口径：复用 GAMES-58/65 c-mixed 范式（预算版 5:00）：混编面=emp 测试房×3+slg 测试房×3+net 测试房×3（[null+3×balanced]）+ BotHost 自然负载（emp≤4/net/slg/mmo 常驻镇）。同网关同进程同跑。

| 指标 | 实测（30 采样 × 10s = 5:00） | 判据 |
|---|---|---|
| 房间面 | rooms 12-17 恒定：emp 2+mmo 镇 1+net 2+slg 2（BotHost 自然负载）+ 测试房 live 6-8（emp/slg/net 三系，31 建/23 终快速轮换） | 四游戏同跑 ✅ |
| 本作 tick 漂移 | emp 测试房 全域 **[0,1] tick**（与 A 组独立跑同域，混编零劣化；红线 ≤2） | 不劣化 ✅ |
| slg 帧漂移（混编干扰判据） | 全域 **[0,0] tick** | 不劣化 ✅ |
| net-tank 轮换 | netEnd netEnd **28 局/5min**（net 测试房×2+BotHost×2 自然终局轮换，节奏与历史单一致） | 稳定 ✅ |
| mmo 常驻镇 | spectator 快照 frame 率 **9.973-9.999 Hz**（spectator 快照 frame 对墙钟） | 满频 ✅ |
| 网关 RSS/CPU | 70,512-106,208KB（前半 86,173→后半 94,275KB，+8.1MB 锯齿） / CPU 均值 4.5%、峰 10.3% | 有界披露 ✅ |
| 错误面 | feed 全量校验 0 错（四游戏前缀/席位/mode 断言全过）；uncaught Δ0、room-error Δ0 | 零错误 ✅ |

**判定：PASS（跨 sim 相互影响阴性：emp/slg 漂移不劣化、net 轮换正常、mmo 镇满频）**。测试房 31 建/23 终/8 清扫（第 9 间 net 触 MAX_TEST_ROOMS 上限拒绝——容量护栏工作正常，非错误），清扫后 rooms 回落 **7**（BotHost 稳态：emp2+net2+slg2+mmo 镇1）。证据：c-mixed.json。

## 4. 无泄漏判据四件套

① **RSS 有界**：A 段 70,336-112,752KB（18 建房/12 终局轮换 churn 高水位）；B 段 84,528-109,568KB 且后半均值**负增长 -11.2MB**；C 段 70,512-106,208KB（网关重启后新鲜起点，前半 86.2→后半 94.3MB）。三段锯齿有界、无单调暴涨；**生产反证**：同代码 :4400 常驻网关 2h56m RSS 58.0MB/CPU 1.0% 稳定。**PASS**
② **增量收敛**：A 段前后半 +23.8MB 未达平台（定性 V8 分配高水位：测试房 18 建房全量 state 对象+轮询 stringify churn，RSS 为触及页高水位非活堆——B 段同网关负增长与生产 2.9h 反证双证）；B 段 -11.2MB 收敛；C 段 +8.1MB。**PASS（附 O1 披露）**
③ **房周期闭环**：网关两段生命周期全量配对：首段（A+B+SIGTERM 优雅停机）room-create **154 == room-dispose 154**，dispose 归因 ended 138+test-cleanup 1+shutdown 15；二段（C+SIGTERM）**61 == 61**，归因 ended 49+test-cleanup 5+shutdown 7；room-end 140/50 与 ended/轮换自洽；清扫后 healthz rooms 回落 7（BotHost 稳态）。**PASS**
④ **零错误**：两段生命周期合计 1,204 行网关日志 **uncaught=0、room-error=0**；A/B/C 三段 feed 全量校验 **0 错**（四游戏前缀/席位/joinable/mode 断言+测试房不泄漏）。**PASS**

## 5. 计时与预算自查（Q-007 纪律）

| 阶段 | 墙钟 | 明细 |
|---|---|---|
| A 组 | 8:01 | 建 6 测试房 ~20s → 采样 8:00（48×10s） |
| B 组 | 5:15 | 满编 4 席 ~10s → 采样 5:00 → 撤席观测 15s |
| C 组 | 5:16 | 建 9 测试房 ~25s → 采样 5:00（30×10s）→ 清扫+回落 12s |
| **合计** | **18:00 采样 / 22:47 全程窗**（超 20 分钟软线转收尾：后续仅文档/落档未再补测；<25 分钟硬帽） | 脚本间接力 <2s（b-start=a-落盘同秒级；c-start=b-end 同秒级） |

网关生命周期两段共 24:12（首段 17:14:56-17:30:53 含启动预热与 A/B；二段 17:31:45-17:37:51 跑 C；中间 52s 为事故处置重启；两段均 SIGTERM 优雅停机）。通读/脚本编写/报告不在实测窗内；另有一次 A 组首跑因脚本语法笔误 10s 内失败即修（不计实测窗）。

## 6. 退回项

**红线退回项：无**（三组 PASS、四件套全过）。

观察项与工具链建议（不阻塞）：
- **O1（观察）** A 段测试房高 churn 下 RSS 高水位爬升（前后半 +23.8MB/8min 未达平台）：定性为分配高水位非活泄漏（B 段同进程负增长 -11.2MB+生产 :4400 同代码 2.9h 58MB 双反证），5 分钟预算窗内未做二段复跑验证平台。建议后续长窗单加「二段复跑看 RSS 起点重置」判据（沿 GAMES-65 O1 同案，两游戏连续出现可考虑工具单统一收口）。
- **O2（观察）** 帝国 BotHost 房 bot 局 2-4 分钟一轮快速终局——大厅观战卡片轮换频次较高属玩法时长设计（avgDurationSec=600 为含真人慢局口径）；如需拉长观战窗可调 bothost 局 timeScale 或混入 competitive 档（设计决策，非缺陷）。
- **O3（工具）** test 房 tick 率口径教训：脚本终局 rate 汇总须剔除 phase!=live 的冻结房（本单复盘剔除并以三证口径替代）；建议后续压测脚本在 summary 阶段按 phase 过滤（GAMES-58「漂移按 phase=live 过滤」同族教训，可合入工具手册）。

## 7. 单链收官：帝国萌芽 10/10

| # | 单 | 产出要点 |
|---|---|---|
| 1 D GAMES-66 | 设计书 | S3 混合同步（建设 S2 快照+战斗 S1 帧单 tick 源）·静默期 tick1800 爆发·attack 走 o 壳合成桥 |
| 2 DEV GAMES-68 | S3 首证 | o/c 双键壳+emit 双通道+桥在 sim；剧本调参四坑（池死锁/静态 rally/槽位抢跑/注入节奏）收口 |
| 3 QA1 GAMES-69 | 独立复测 | 三支柱+S3 专项全绿（红线零退回）；F1 建造死锁/F2 铁系互锁发现 |
| 4 FIX1 GAMES-70 | 死锁三例修复 | F1/F2 根因修复+跨例警示；混编三重防线（预留位/比例断言/支付降级） |
| 5 BOT GAMES-71 | 人格深化 | 三档（建设倾向×战斗时机双轴）+开局树 rng 定桩×2/档+陪玩 carry 三态；双证 18 局 |
| 6 FEEL GAMES-72 | 手感层 | hp/y 快照 diff 双层反馈链+juice+爆发氛围；对撞取证窗范式 |
| 7 QA2 GAMES-73 | 联机红线 | 200ms 延迟无偏置（房型分层判据）/重连 10s+1 拍/满员旁观；零红线退回 |
| 8 FIX2 GAMES-74 | 观察项收口 | O2 战斗镜像 3 帧插值过渡+O1 帧锚口径文档化（net-protocol §4.3） |
| 9 VIS GAMES-75 | 视觉统一 | HF 运行时字号自证/双层 HUD 分区/爆发时间轴+战线/色盲形状双通道 |
| 10 STRESS 本单 | 压测+收官 | 三组 PASS、四件套全过、档案 accepted |

单链节奏：10 单（GAMES-66→76，D→DEV→QA/FIX/BOT/FEEL×2 轮→VIS→STRESS），E6-W1-T3 轨。工具沉淀：S3 双键壳接线范式、影子树隔离+显式 PORT 纪律、房型分层判据、test 房 phase 过滤口径（O3）。

## 8. 结论

**帝国萌芽 STRESS 三组全过（6+4 房并行 8min tick 满频漂移 [0,1]、三单 28+ 局交叉引用+满编 4/4 spot tick 9.97-10.00Hz、四游戏混编零错误），无泄漏四件套全过（附 O1 披露），实测 18:00 采样墙钟守住 Q-007 预算（22:47 全程窗）。单链 10/10 完成（GAMES-66..76），档案转 accepted（docs/game-quality.json），知识库《帝国萌芽开发实录》草稿留档待 PM 收割，联机作战图进展已更新（multiplayer-roadmap.md §4.3 单链进展看板）。**
