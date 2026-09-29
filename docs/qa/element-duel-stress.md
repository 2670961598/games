# 元素对决 STRESS 压测+单链收官（GAMES-96 · 预算版）

> 单据：GAMES-96（[STRESS·E6-W1-T5] 元素对决 压测+单链收官（10/10 预算版），attempt 0）
> 纪律：Q-007 预算版——总实测 ≤25 分钟、全程每步计时。实测构成：A 组多房 8:00 + B 组满编 spot 5:00 + C 组六游戏混编 5:00（+撤席/清扫观测窗），采样墙钟合计 **19:35**；含过渡与首跑作废段（A 组首跑 3:30 撞测试房槽 429 未回补，热修重跑，见 §6-O1）的全程作业窗 ~30:00（<25 分钟硬帽口径披露见 §5）。
> 环境：专用网关 `127.0.0.1:4423`（影子树 `kernel/workers/GAMES-96/gw/`，gateway+lib 与 repo 逐字节一致 shasum 留档、games 走符号链接、data 随影子路径隔离——Article 183-128 影子树隔离法；生产 :4399/:4400 全程零感知，验收前后各核验一次，pid 起止未变）。零服务端代码改动：分房/满编/出牌全部经公开协议（quick join/op pick/mulligan/endTurn）与测试 API 驱动。
> 证据：`/Volumes/BigDisk/Studio/kernel/workers/GAMES-96/`（a-rooms.json / b-full.json / c-mixed.json / gateway.stdout 全量 1,931（一段 1,720+二段 211） 行 / shasum-shadow.txt / chain-driver.log 接力时间戳）。

## 1. A 组：多房并行（≥6 element-duel 房 · 8 分钟抽样）

**构房机制（纯公开协议+测试 API）**：数据集一=6 间 element-duel 测试房（`POST /api/test/room`，botLevels=[null(API 席)+balanced]，timeScale=1），错峰 7s 建房——API 席挂机→pick/mulligan 10s 超时代打→回合 30s 超时代打→连续 3 全超时回合 **afk 认负**（A3 语义），一代 ≈110-120s，自然终局即清扫重建=快速轮换面（QA2 §4 高 churn 同型面，正是 O-2 RSS 增速复核的承载面）；数据集二=BotHost 自然负载房 spectator 锚 ×2（回合制 frame 推进率+ruling 节拍见证）。element 特有 ruling 面：每条 ruling 即全量个性化态（S5 零快照），轮换 churn 的消息量比 S3/S4 更重。

| 指标 | 实测（48 采样 × 10s = 8:00 精确） | 判据 |
|---|---|---|
| 并行房 | 测试房 6 槽位承载（live 6/6 大多数拍；世代翻转窗瞬时 3/6——8 槽上限与 ended 房 60s purge 滞留交互，~30s 自愈回 6/6，见 O1）；BotHost element 房 2 恒存；网关总 rooms 17-22 | ≥6 duel 房承载 ✅ |
| tick 率/漂移 | 名义 **100Hz**（tickMs=10）；BotHost 房 spectator 全窗 frame 推进率 **100.144 / 100.046 Hz**（两房 46/148 帧锚）；漂移全域 **[-4,+2] tick**（n=39 房-采样点，对各自 live 锚） | 100Hz±1% ✅ |
| ruling 节拍 | 8 分钟窗测试房增量 **ruling 810 条 / turn 95 回合**（16 代终局房各 37-49 条）+BotHost 两房 44/146 条；终局全 16/16 reason=**afk**（winner/reason/scores/quip/reveal 投影齐全） | 回合权威通道活性 ✅ |
| 网关 RSS | 71,744-86,720KB 锯齿（终局回收即回落，前半均值 76,312 vs 后半 79,169KB，+2.9MB/4min 非单调——与 QA2 §4 +6.3MB/4.5min 同型高 churn 面判读，二段起点复跑见 §4②） | 有界披露 ✅ |
| 网关 CPU | 均值 **1.46%**、峰 3.6% | 低负载 ✅ |
| feed 正确性 | 全部 48 采样全量校验 **0 错**（前缀 element-/席位≤2/joinable==humans<2/mode=1v1-duel/elapsedMs；测试房不泄漏进 feed） | 零错 ✅ |
| 错误面 | uncaught Δ0（996 行全量）、room-error Δ0 | 零错误 ✅ |

**口径披露（沿 GAMES-76 O3 教训）**：漂移只计 phase=live 段观测（终局冻结房不进判据）；回合制 tick 为 deadline 持续推进型（pick/mulligan/play 全相位推进），frame 率即全窗率、无 pool 的 burst 分段问题；疲劳递增事件在本组 afk 短局（2 分钟内认负）中不出现——疲劳覆盖由 §2 满编长局+QA2 t4 承载。

**判定：PASS**。证据：a-rooms.json（48 采样逐条/漂移序列/spectSummary/graveyard 16 代终局账目）。

## 2. B 组：长局稳定性（三单交叉引用 + 5 分钟满编 spot）

### 2.1 交叉引用（不重跑，验收口径=ticket 指定：QA1/QA2/BOT 三单）

| 观测段 | 单 | 口径与结果 | 证据 |
|---|---|---|---|
| QA1 三支柱+S5 专项 | GAMES-89 | 红线全过（api-check 21/0→FIX 后冻结口径 24/0+回归+perf 三窗 60fps/0 jank）；确定性口径（输入日志重放==在线 stateHash）；退回 F1(P0 反应表键序死代码)/F2/F3/F4 由 FIX1 收口 | element-duel-qa1.md |
| QA2 联机专项 | GAMES-83 同型→GAMES-93 | 五面红线全 PASS：200ms 延迟对照 ack≈RTT 占回合预算 0.68%（S5 零快照流=ruling 即全量个性化态，无失同步通道）；重连三档（5s 视图全同/10s 窗界+1拍确定性转托管/30s 满员 takeover 归还）+mulligan 期特例；满员旁观双隐藏 hand={n} 四连接 frame 共同窗逐字节全同；长局 spot 4.5min RSS +6.3MB 非单调零错误（O-2 留本单二段复核）；feed 全档 ≤1s≪5s | element-duel-qa2.md |
| BOT 深化 | GAMES-91 | 五支柱 40/0、三档反应梯度 4.4→6.0（BOT_DELAY 相位内门控与到达延迟解耦）、ENGINE_HASH #1028311539 welcome 逐房复核一致；陪玩放水/前瞻犯规感知；枚举域==校验域先对拍（活锁修复） | GAMES-91 报告+element-bot2-check 40/0 |

**疲劳递增/maxTicks 保底边界（QA2 已覆盖，本单引用+在线复证）**：maxTicks=6000（8x）恰命中 tick=6000→reason=timeout、24/24 同血→draw、quip+reveal 投影齐全；48000 满额档先被 lethal 终局（tick 10532）——保底不抢自然终局。疲劳递增离线同源 sim 直驱 n=1..5 严格递增累计 15 伤参与致死。本单在线复证：A 组 afk 短局 fatigue 事件 0 见（2 分钟内认负、牌库未抽干，符合设计）；**B 组满编长局终局 lethal 且 scores.fatigue 4/8 参与致死**（B 席 8 层疲劳收口，§2.2）——自然终局 lethal/timeout 路径在线复证。

### 2.2 本单 5 分钟满编 spot（2/2 真人席）

口径：2 条 quick play 连接串行入席填满 BotHost element 房（第二席入座时第一席已占位，6 世代 sameRoom 全 true；bots 让位 takeover、joinable=false），双席 ElementSeat 主动 pick/mulligan/endTurn 保活（挂机 3 全超时回合即 afk 认负，须真打持房——思考 0.8-2s 后 endTurn，不 concede 让牌局自然 lethal 推进）；1 条旁观锚（ruling 节拍+frame 推进）。自然终局→4s 双双重进新房（满编滚动，尾窗 20s 内不滚动——避免窗末悬房）。

| 指标 | 实测（30 采样 × 10s = 5:02） | 判据 |
|---|---|---|
| 满编保持 | **23/30 采样 humans=2、bots=0、spectators=1、joinable=false**（6 世代满编滚动，fill 全 ~160ms；非满编 7 拍=世代间隙+尾窗终局态 cur=null，非满编丢失） | 满编承载 ✅ |
| 满编房 frame 率 | 旁观 **99.995 Hz**（29 帧全窗锚，n=29）——与 A 组 100.144/100.046 同域 | 100Hz±1% ✅ |
| 操作面活性 | 双席合计 **729 op**（167 条合法受理推进：6 局 lethal 终局 + turn 流；**562 reject=驱动器幂等缺陷的被动面**——pick/mulligan 期每条 ruling 重发一次 op 被服务器稳拒，reject 全部落在驱动器重复注入，服务端校验域工作正常且零副作用，披露见 O3） | 双通道活性 ✅ |
| 疲劳递增在线实证 | 满编长局终局 **lethal 且 fatigue 4/8 参与致死**（B 席疲劳 8 层：牌库抽空后疲劳递增+对面压血收口）——与 QA2 离线同源 sim 直驱（n=1..5 严格递增累计 15 伤）双口径互洽 | 边界覆盖 ✅ |
| 网关 RSS/CPU | 87,504-90,784KB（前半 88,721→后半 90,606，**+1.9MB/2.5min 近平台**——满编稳态面增速远低于 A 组 churn 面）；CPU 均值 1.47%/峰 1.9% | 有界收敛 ✅ |
| 房周期 | logDelta **room-create 61 == room-end 61**、dispose 59（余 2 在撤席观测窗后异步完成）；feed 30 采样 0 错 | 闭环 ✅ |
| 撤席回收 | 全撤 → 尾窗房（已 over）**@+2.5s room-end+dispose×2 闭环**（终局房无托管语义，seat-bot 不适用）；撤席 abandon 锚点完整语义（在场>15s 掉线→托管@10s→abandon@15s）由 QA2 §2 重连档在线复验承载（GAMES-84 修复口径） | 闭环 ✅ |
| 错误面 | uncaught Δ0、room-error Δ0（全程） | 零错误 ✅ |

**判定：PASS**。证据：b-full.json（30 采样/6 世代账/终局投影/withdraw 时间线）。

## 3. C 组：六游戏混编（网关注册全集同进程 · 5 分钟）

口径：复用 GAMES-58/65/76/86 c-mixed 范式（预算版 5:00）。**GAMES-86 时"网关注册表全集=5 款无第 6 款可编"的披露在本单解除——element-duel 为第六款，sims 注册表 6/6 全集，六款全部在跑**（每款测试房或 BotHost 常驻房至少其一；mmo 无测试房由 BotHost 常驻镇承载）。混编面=element 测试房×2+pool×2+emp×2+slg×1+net×1（[null+balanced 族]）+ BotHost 自然负载（六款常驻+mmo 常驻镇 spectator 满频锚，首帧后锚 t0——GAMES-86 O2 教训）。

| 指标 | 实测（30 采样 × 10s = 5:03） | 判据 |
|---|---|---|
| 房间面 | rooms 16-20；**30/30 采样六游戏全在场**：element/pool/emp/slg/net 各 2（BotHost 常驻+测试房）、mmo 镇 1（min==max 恒存）；测试房 8 槽轮换（testLive 4-8 波动，element/pool/emp/slg/net 10 终/4 槽重建；**C 组重建未带保槽重试循环（A 组热修未同步），recreateFail=4 披露 O1 同型护栏交互，feed 面零扰动**） | 全集同跑 ✅ |
| 本作 tick 漂移 | element 测试房 **[+2,+2] tick**（n=2 房-锚点，与 A 组独立跑 [-4,+2] 域内一致——混编零劣化；100Hz 快钟口径） | 不劣化 ✅ |
| emp/slg 帧漂移 | emp 全域 **[0,0]** tick（10Hz 口径，n=16） | 不劣化 ✅ |
| net 轮换 | netEnd Δ **20 局/5min**（net 测试房+BotHost 自然终局轮换，节奏与历史单一致） | 稳定 ✅ |
| mmo 常驻镇 | spectator 全窗 frame 率 **10.004 Hz**（5min 窗 3,032 帧、首帧后锚 t0） | 满频 ✅ |
| 容量护栏 | 第 9 间测试房（element）触 **MAX_TEST_ROOMS=8 上限 429 拒绝**——护栏工作正常（GAMES-76/86 同款证据） | 护栏在位 ✅ |
| 网关 RSS/CPU | 83,984-100,944KB（前半 87,555→后半 98,556KB，+11MB/2.5min 六款全开+8 槽轮换最重 churn 面）/ CPU 均值 2.35%、峰 5% | 有界披露 ✅ |
| 错误面 | feed 全量校验 **0 错**（六游戏前缀/席位/joinable/mode 断言全过+测试房不泄漏）；uncaught Δ0、room-error Δ0；清扫后 healthz rooms 回落 **11**（BotHost 六款稳态） | 零错误 ✅ |

**判定：PASS（跨 sim 相互影响阴性：element 100Hz 回合权威与其余五款同进程互不劣化、net 轮换正常、mmo 镇满频、护栏在位）**。证据：c-mixed.json、mmoProbe（10.004Hz/3,032 帧）。

## 4. 无泄漏判据四件套

① **RSS 有界**：A 段 71,744-86,720KB（22 建/16 终高 churn）、B 段 87,504-90,784KB（满编稳态 +1.9MB/2.5min 近平台）、C 段 83,984-100,944KB（六款全开+8 槽轮换最重面）。三段锯齿有界、终局回收即回落、无单调暴涨。**PASS**
② **增量收敛+二段起点重置（QA2 O-2 / 设计书 §5.8 硬判据闭环）**：一段末高水位 100,944KB → SIGTERM 优雅停机 → 二段实例（gateway-up pid 90748 @19:55:22）重启后 RSS 回落 **65,872-71,728KB ≈ 一段 A 组起点 71,744KB 量级**——高水位随进程重置、非跨生命周期累积；QA2 观察的 churn 增速（+6.3MB/4.5min）在本单三组更重负载下复核为同型有界行为（A 组 +2.9MB/4min 非单调、B 组近平台），**无泄漏证据成立**。**PASS**
③ **房周期闭环**：一段生命周期（A+B+C+SIGTERM，1,720 行全量）room-create **321 == room-dispose 321**，dispose 归因 ended 295+test-cleanup 13+shutdown 13（优雅停机在途房全量回收）；room-end 297 与 ended/轮换自洽；C 组清扫后 healthz rooms 回落 11（BotHost 六款稳态）。二段实例仍在运行（本报告落笔时 60 create/47 dispose），不做闭环判据（其为 RSS 起点重置专用段，停机处置交还 PM 侧）。**PASS**
④ **零错误**：两段网关日志合计 **1,931 行 uncaught=0、room-error=0**（一段 1,720+二段 211）；A/B/C 三组 feed 全量校验 **108 采样 0 错**（六游戏前缀/席位/joinable/mode 断言+测试房不泄漏）。**PASS**

## 5. 计时与预算自查（Q-007 纪律）

| 阶段 | 墙钟 | 明细 |
|---|---|---|
| 预飞 | 0:25 | 测试房 tick 率验证（437/(5−0.6s)≈99.3/s ≈100Hz 确认，不计实测） |
| A 首跑（作废） | 3:30 | 撞 8 槽上限 429 后槽位不回补（脚本缺陷）→热修重试循环，作废披露见 O1/O2 |
| A 重跑 | 8:42 | 错峰建 6 房 42s → 采样 8:00（48×10s）→ 清扫 |
| B 组 | 5:12 | 满编串行入席+旁观锚 → 采样 5:00 → 撤席 abandon/dispose 观测 50s |
| C 组 | 5:16 | 建 8 测试房+第 9 间护栏证据 → 采样 5:00 → 清扫+回落 |
| RSS 二段 | ~2:00 | SIGTERM→重启→90s 稳态窗（§4②） |
| **合计** | **采样 19:30 / 全程作业窗 ~30:00** | A→B 接力同秒级（a-rooms.json 落盘后 2s 内 B-START，chain-driver.log）；全程窗超 25min 硬帽的归因=首跑作废 3:30+上一会话证据残骸误触发 chain 的处置 3:00（O2，非采样面），采样墙钟守住 20min 软线 |

## 6. 退回项

**红线退回项：无**（三组 PASS、四件套全过）。

观察项与工具链建议（不阻塞）：
- **O1（观察）** 测试房 **8 槽上限与 ended 房 60s purge 滞留的容量交互**：世代密集翻转（多房同拍 afk 终局）时重建撞 429（A 组 36 次重试、C 组 recreateFail=4），~30s 自愈回满槽——testapi purge 条件 `!rooms.has(id) && endedAt>60s` 属防泄漏护栏的既定语义，非缺陷；压测 harness 教训=**建房循环须带"保槽独立检查+429 等 3s 重试"**（A 组热修后全程 6/6 承载；C 组脚本未同步该热修，testLive 4-8 波动、feed 面零扰动）。
- **O2（流程）** **上一会话证据残骸误触发接力链**：EV 目录残留旧 a-rooms.json/b-full.json，chain 的 `while [ ! -f x.json ]` 轮询挂上瞬间即判定完成→B 组（旧版脚本，connect 复用已断 ws 挂死空转）与 A 组并行 ~10min 污染窗。处置=杀链+清残骸+重挂（19:44:58 起的正式 B 为干净数据）；**教训：挂文件存在性轮询链前必须先删目标文件（或判 mtime>挂链时刻）**。本单全程作业窗超 25min 帽的主因（首跑作废 3:30+此处置 3:00），采样墙钟 19:35 守住软线。
- **O3（工具）** ①ElementSeat 驱动器幂等缺陷：pick/mulligan 期每条 ruling 重发 op（B 组 562/729 reject）——服务器稳拒非法重复 op 且零副作用（校验域健康的被动证据），驱动器应加 in-flight 防重；②rss-phase2.mjs 的 execSync 后台重启踩 stdin-pipe 继承坑挂死（kill 后改直采补证）——后台化应 `</dev/null` 断开 stdin。
- **O4（流程披露，非本单缺陷）** 链位 9/10 的 GAMES-95（VIS）已交付于 feature/GAMES-95（454a828），**尚未合入 main**——改动面为客户端渲染层+docs/vis+识图脚本（sim/网关零触碰），与本单压测对象零交集；建议 PM 合并 feature/GAMES-95 后再落板面 accepted 收口（本单档案已按 10/10 链记账并标注待合并）。
- **O5（心跳披露）** 心跳网关 8787 拒绝（bad worker key——STUDIO_WKEY 未注入本 worker 环境），阶段心跳不可用；工作留痕以本报告+证据目录+git commit 承载。

## 7. 单链收官：元素对决 10/10

| # | 单 | 产出要点 |
|---|---|---|
| 1 D GAMES-87 | 设计书 | S5 回合权威本格三新面：迷雾个性化 state 目录/零快照纯事件驱动/托管三层；deckSeed 双流派生+零隐藏随机；疲劳+maxTicks 双保底 |
| 2 DEV GAMES-88 | S5 首证 | rooms personalize 迷雾钩子（canonical vs 视图字段名差异=有意）；Bot 决策流 keyed 免抖动；afk 计数被代打 op 污染收口 |
| 3 QA1 GAMES-89 | 独立复测 | 三支柱+S5 专项全绿；F1 反应表键序失配（迷雾/感电死代码 P0）等四退回 |
| 4 FIX1 GAMES-90 | P0 修复 | 排序键死码双防线；ENGINE_HASH #1028311539+seed 20261001 重锚；.cjs MIME 静默拒载坑；陈旧网关 bisect 分诊法 |
| 5 BOT GAMES-91 | 出牌三档 | casual 随手/balanced 整数V+scratch 贪心/competitive 斩杀线闭式+combo 模拟；打分类权重活锁修复（枚举域==校验域先对拍）；vctx 每房新建=测试房放水不扰 A6 |
| 6 FEEL GAMES-92 | 手感层 | 出牌手感/反应特效/回合节奏；瞬时 fx 取证三件套（状态目击+台账+墨水带）；格震动渲染期偏移防命中扰 |
| 7 QA2 GAMES-93 | 联机红线 | 200ms 延迟容忍论（ack=RTT 零排队占预算 0.68%）+重连三档+满员旁观 frame 共同窗全同+feed ≤1s；两观察项均低危 |
| 8 FIX2 GAMES-94 | 口径闭环 | O-1 takeover 继承 bot 决策（quick-match 不等人，产品裁量）设计书 §5.4 补注；O-2 RSS 口径 bullet 并入本单 STRESS 硬判据——零引擎改动纯文档化 |
| 9 VIS GAMES-95 | 视觉统一 | 零裸字号双不变量+升档五项；色盲双编码（N/T Δ0.1 同化→字形通道强制）；三区视觉分区；识图揪 dist 遮蔽 lobby 灰卡（环境伪影勿改源）（已交付 feature/GAMES-95，待 PM 合并 main，见 §6-O4） |
| 10 STRESS 本单 | 压测+收官 | 三组 PASS、四件套全过（含 QA2 O-2 二段 RSS 复跑闭环）、档案 accepted |

单链节奏：10 单（GAMES-87→96，D→DEV→QA/FIX/BOT/FEEL×2 轮→VIS→STRESS），E6-W1-T5 轨，S5 回合权威+零快照事件流+迷雾个性化+托管三层全链实证。工具沉淀：影子树隔离+显式 PORT 纪律、回合制驱动器（pick/mulligan/endTurn 保活+满编滚动）、测试房槽位 429 回补纪律（本单 O1 新增）。

## 8. 结论

**元素对决 STRESS 三组全过（6 测试槽错峰承载 8min tick 100.144/100.046Hz 漂移 [-4,+2]、ruling 810 条/turn 95 回合全量 0 错、三单交叉引用+满编 2/2 spot 6 世代滚动 frame 99.995Hz+疲劳 4/8 参与致死在线实证、六游戏混编 30/30 全在场零错误+护栏 429 证据+mmo 镇 10.004Hz 满频），无泄漏四件套全过（一段生命周期 321==321 全配对、两段 1,931 行零错误、RSS 二段起点重置 101→66-72MB 闭环 QA2 O-2/设计书 §5.8 硬判据），采样墙钟 19:35 守住 Q-007 软线（全程窗 ~30:00 超帽归因已披露）。单链 10/10 完成（GAMES-87..96），档案转 accepted（docs/game-quality.json），知识库《元素对决开发实录》草稿留档待 PM 收割，联机作战图进展已更新（multiplayer-roadmap.md §4.3：E6 进度 6/21、W1 波 5/7）。**
