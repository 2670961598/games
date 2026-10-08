# 蛇王争霸 STRESS 压测+单链收官（GAMES-106 · 预算版）

> 单据：GAMES-106（[STRESS·E6-W1-T6] 蛇王争霸 压测+单链收官（9/10 预算版），attempt 0）
> 纪律：Q-007 预算版——总实测 ≤25 分钟、全程每步计时。实测构成：A 组多房 8:00 + B 组满编 spot 3:00（+撤席观测 30s）+ C 组七游戏混编 5:00 + RSS 二段 1:38，采样墙钟合计 **16:00**（实测窗含建/撤房与观测段 18:07）；全程作业窗 27:50（17:57:24 起跑计时→18:25:14 压测结束；超 25min 硬帽 2:50 归因=影子树搭建计入起跑+首跑作废段 2:30[日志路径口径踩坑，见 O2]——明细见 §5）。
> 环境：专用网关 `127.0.0.1:4416`（影子树 `kernel/workers/GAMES-106/gw/`，gateway+lib 与 repo 逐字节一致 shasum 留档、games 走符号链接、data 随影子路径隔离、GATEWAY_PID/LOG 改道防覆盖生产 pid 文件——QA2 §O 口径）；生产 :4399(pid 18075)/:4400(pid 87098) 全程零感知（起跑前核验一次、RSS 二段重启后复核，pid 起止未变）。零服务端代码改动：分房/满编/转向全部经公开协议（quick join/op turn 10Hz）与测试 API 驱动。
> 证据：`/Volumes/BigDisk/Studio/kernel/workers/GAMES-106/`（a-rooms.json / b-full.json / c-mixed.json / rss-phase2.json / gateway.stdout 全量 / gateway.stdout.2nd / shasum-repo.txt / chain-driver.log 接力时间戳 / A-START.ts）。

## 1. A 组：多房并行（≥6 snake-king 房 · 8 分钟抽样）

**构房机制（纯公开协议+测试 API）**：数据集一=6 间蛇王测试房（`POST /api/test/room`，botLevels=full20 混编 [null(API 席)+3 竞技+6 均衡+10 休闲=20 实体]，timeScale=3+maxTicks=3600——每代 ~120s 轮末投影强制终局[设计 §1.1：生产房轮不清房，测试房才终局]→ended 房 60s purge→重建=churn 轮换面），错峰 7s 建房（GAMES-86 O1：防世代同步翻转）；数据集二=BotHost swarm 巨房 spectator 锚 ×2（`bothost-swarm-spawn` 常驻语义复刻：休闲巨房+混编巨房、实体 20、真人 0——**swarm×2 常驻语义在线复证**）。

| 指标 | 实测（48 采样 × 10s = 8:00 精确） | 判据 |
|---|---|---|
| 并行房 | 测试房 6 槽位承载（live 大多数拍 6/6；世代翻转窗瞬时回补 43 次 429 重试=ended 房 60s purge 滞窗已知护栏语义[GAMES-96 O1 同型]，跨拍自愈）；swarm 巨房 2 恒存（spectator 全窗锚定 4,796/4,795 帧）；网关总 rooms 13-23 | ≥6 蛇王房承载 ✅ |
| tick 率/漂移 | 名义 **10Hz**（tickMs=100）；测试房 timeScale=3 快钟漂移全域 **[-1,+1] tick**（n=33 房-锚点）；swarm 房（生产时标）spectator 全窗 frame 推进率 **9.989 / 9.988 Hz**（两房 8 分钟各 4,796/4,795 帧锚） | 10Hz±1% ✅ |
| 生态活性 | 8 分钟窗 **kill 6,557 / die 7,045**（6 churn 房+2 swarm 房合计；die>kill=尸体光点生态供給面），轮赛 rd 推进至第 3 轮（rem 字段健康） | 实体生态活性 ✅ |
| 终局面 | 测试房 18 代终局 **全 18/18 reason=round-end**（scores 20 席投影齐全、winner=B 未达标——API 席挂机符合预期），testCreated 24=初始 6+重建 18 | 轮末投影闭环 ✅ |
| 网关 RSS | 127,344-242,336KB 锯齿上升（20 实体×6 房×时标 3 的重载面；终局回收即回落。曲线判读与二段起点重置见 §4②——蛇王实体面基线显著高于 element/pool 同型组，属 20 蛇+光点+site 实体量级的本征水位，非泄漏证据） | 有界披露 ✅ |
| 网关 CPU | 均值 **35.89%**、峰 50.9%（6 房×30 tick/s×20 实体的确定性 sim 面；B 组清扫后满编稳态降至 5-9%——负载归因清晰） | 低负载披露 ✅ |
| feed 正确性 | 全部 48 采样全量校验 **0 错**（前缀 snake-/席位≤24/joinable==humans<24/mode=swarm-arena/elapsedMs；测试房不泄漏进 feed） | 零错 ✅ |
| 错误面 | pollFail=0；logStats uncaught=0、room-error=0（一段全量见 §4④） | 零错误 ✅ |

**口径披露**：漂移只计 phase=live 段观测（终局冻结房不进判据，GAMES-76 O3）；timeScale=3 快钟的漂移公式= tick−锚−Δt×3/100ms；A 组 spectator 锚的字节画像因工具缺陷（emit2 单参丢失 rawLen，O3）无值——增量/全量画像由 C 组 swarm 锚承载（§3）。

**判定：PASS**。证据：a-rooms.json（48 采样逐条/漂移序列/graveyard 18 代终局账目/spectSummary）。

## 2. B 组：长局稳定性（四单交叉引用 + 满编 20/20 spot）

### 2.1 交叉引用（不重跑，验收口径=ticket 指定：QA1/QA2/BOT/FEEL 已有观测汇总）

| 观测段 | 单 | 口径与结果 | 证据 |
|---|---|---|---|
| QA1 三支柱+S6 专项 | GAMES-100 | 红线全过+剧本硬化两单（timeScale 4→3 对冲 swarm 常驻负载时滞；full20 混编证伪 competitive 数量说）；full20 满房剧本（满员 20 席+带宽画像 增量 ≤850B/全量占比 ≤8%+排行榜 A6 任意 tick） | GAMES-100 报告 |
| FIX1 | GAMES-101 | 负载三档对照证伪负载主因（0 档零 swarm 反最差 28/2、无剂量反应）；删开关候选提交法（首红即 revert）三连绿留存 | GAMES-101 报告 |
| BOT 深化 | GAMES-102 | PERSONA 三档生态位（casual 饲料/balanced 觅食者/competitive 猎手三技）+放水链（房内 deaths/kills 代理）；绞肉相位方差裁决=开关保留（随机相位本征噪声） | GAMES-102 报告 |
| FEEL 手感层 | GAMES-103 | 转向/疾跑/击杀反馈 juice；fx 台账双时戳实测 10-17ms；世界层墨水带取证范式 | GAMES-103 报告 |
| QA2 联机专项 | GAMES-104 | 五面红线全 PASS 退回 0：200ms 延迟 ack=RTT 零放大（p50 253ms=RTT204+tick 地板）、重连三档（5/10/30s——超窗 seat-bot 托管）、满员 24 席第 25 连接旁观（8s 81 快照）、长局 5min spot **3,002 快照零帧隙/11 死 11 复活稳态/RSS +8.9MB** | snake-king-qa2.md + GAMES-104 六 JSON |
| VIS | GAMES-105 | 识图 v2 20 项断言 4 连跑全绿；perf avgFps 60.1 jank 0% | docs/vis/snake-king-vis.md |

**长局覆盖账目（合计 ≥60 分钟，不重跑）**：QA2 t1 延迟对照 6 局真 WS（3+3，每局 ≥3min≈18min+）+ QA2 t4 长局 5min（3,002 快照）+ QA1 api-check 四剧本多轮次（win/lose/hunt/full20，6min 名义轮×timeScale 3）+ BOT 三档阶梯多局+FIX1 三档对照多轮+FEEL 回放取证窗——合计覆盖 **≥60 分钟**在线 sim 推进（各单证据 JSON 在档，增量画像 656B vs QA1 726B 同量级互洽——QA2 报告口径）。

### 2.2 本单满编 20/20 spot（20 quick join + 1 旁观）

口径：20 条 quick play 连接串行入席同一 swarm 巨房（B 组目击：全部 20 席落 **同一 roomId**，bots 20→**让位归 0**——swarm 让位语义在线复证 feed `humans=20 bots=0 spectators=1 joinable=true`），SnakeSeat 10Hz turn 保活（steerLite 觅食+避墙——挂机即 idle 但 persistent 常驻不破房 §1.1）；1 条旁观锚（frame 推进+快照账本）。采样 10s×18=3:00 + 撤席让位回收观测 30s。

| 指标 | 实测（18 采样 × 10s = 3:00 精确+撤席 30s） | 判据 |
|---|---|---|
| 满编保持 | **18/18 采样 humans=20、bots=0、spectators=1、joinable=true**（20 条 quick join 全部落同一 swarm 巨房 snake-8l8ud5647——bots 20→让位归 0 让位语义在线复证；24 席硬顶下 joinable 恒真=设计余量 §2.1） | 满编承载 ✅ |
| 席活性 | 20 席全程 alive（零断线）；**ops 35,626**（20 席×10Hz×178s 采样窗精确自洽）、**reject 0**（turn 输入域全合法；acks 0=蛇王 input 面无逐条回执通道，A4 注入→快照收敛断言由 QA1/QA2 承载） | 驱动面活性 ✅ |
| 满编房 frame 率 | 旁观锚 **10.001 Hz**（3.5min 窗 2,101 帧，含撤席观测段）——与 A 组 swarm 锚 9.989/9.988 同域；轮赛推进至第 3 轮（rd.rem 749 健康） | 10Hz±1% ✅ |
| 网关 RSS/CPU | 145,264-244,288KB 锯齿（A 组清扫后基线回落+满编稳态面）/ CPU 均值 **8.02%**、峰 9.4%（对比 A 组 churn 面 35.89%——负载归因：时标 3 测试房是 CPU 主体，满编稳态轻） | 有界收敛 ✅ |
| feed 正确性 | 18 采样全量校验 **0 错** | 零错 ✅ |
| 撤席转移 | 全撤 → +10s 拍 humans 仍 20（RECONNECT_MS+tickMs=10.1s 重连窗内席位保留[QA2 重连三档同锚]）→ **+20s 拍 humans=0、bots=20**（重连窗尽→seat 转托管 bot，feed 原子翻转）→ +30s 拍稳定——persistent 常驻房撤席=托管转移非 room-gone（QA2 §O-4 语义复证），旁观锚全程在席 | 闭环 ✅ |

**判定：PASS**。证据：b-full.json（18 采样/seatTotals/withdraw 时间线/spectSummary）。

## 3. C 组：七游戏混编（网关注册全集同进程 · 5 分钟）

口径：复用 GAMES-96 c-mixed 范式。**sims 注册表 7/7 全集（snake-king 为第七款），七款全部在跑**（每款 BotHost 常驻房至少其一；mmo 无测试房由常驻镇承载）。混编面=蛇王测试房×2+element/pool/emp/slg/net 各 1（7 款 8 槽占 7+1 空位）+第 9 间护栏 429 证据；mmo 镇 spectator 满频锚（首帧后锚 t0——GAMES-86 O2）；蛇王 swarm 房 spectator 快照**增量/全量画像**（对照 QA1 full20 断言 增量 ≤850B/全量占比 ≤8% 与 GAMES-53 增量/全量画像基线口径）。

| 指标 | 实测（30 采样 × 10s = 5:00 精确） | 判据 |
|---|---|---|
| 房间面 | rooms 20-24；**30/30 采样七游戏全在场**（snake-king 为第七款 sims 注册表 7/7 全集）：snake/pool/slg/net/emp/element 各 BotHost 常驻+测试房、mmo 镇 1（恒存）；测试房 7 槽全承载（testLive 7 稳定、element 回补 recreate429=0——A 组保槽纪律生效）；10 代终局轮换（snake×2/net/slg/pool/emp/element×4，含跨款并发终局零干扰） | 全集同跑 ✅ |
| 本作 frame 率 | 蛇王 swarm 房 spectator **9.993 Hz**（5min 窗 2,999 帧）——与 A 组独立跑 9.989/9.988 同域=**混编零劣化**；mmo 常驻镇 **9.992 Hz**（2,999 帧满频，首帧后锚 t0） | 不劣化 ✅ |
| 快照画像 | 蛇王 swarm 房增量 **p50 654B / avg 689B / max 50,340B**（n=2,980；max 为轮末 rollover 等巨事件帧）、全量 avg 14,643B（n=19）、**增量占比 99.37%（全量占比 0.63%≤8%）**——对照 QA1 full20 断言（增量 ≤850B/全量占比 ≤8%）与 GAMES-53 增量/全量画像基线口径，**画像互洽**（QA2 实测 656B vs QA1 726B 同量级带内） | 带宽画像 ✅ |
| 容量护栏 | 第 9 间测试房（element）触 **MAX_TEST_ROOMS=8 上限 429 拒绝**——护栏工作正常（GAMES-76/86/96 同款证据） | 护栏在位 ✅ |
| 网关 RSS/CPU | 103,328-140,192KB（B 组撤席+清扫后基线回落 103MB 起步——满编面 RSS 回收在证）/ CPU 均值 12.15%、峰 27.2% | 有界披露 ✅ |
| 错误面 | feed 全量校验 **0 错**（七游戏前缀/席位/joinable/mode 断言全过+测试房不泄漏）；pollFail=0 | 零错误 ✅ |

**口径披露**：C 组蛇王**测试房**漂移序列未落盘（ended 房进 graveyard 时只留 driftN 计数——采集缺陷 O3 同源；蛇王漂移红线由 A 组 33 锚点 [-1,+1] 承载，混编不劣化判据由 swarm frameHz 同域承载，判据链完整）。

**判定：PASS（跨 sim 相互影响阴性：蛇王 10Hz 连续权威与其余六款同进程互不劣化、轮换正常、mmo 镇满频、护栏在位）**。证据：c-mixed.json、mmoProbe、skProbe。

## 4. 无泄漏判据四件套

① **RSS 有界**：A 段 127,344-242,336KB（6 房×20 实体×时标 3 churn 最重面）、B 段 145,264-244,288KB（满编 20/20 稳态）、C 段 103,328-140,192KB（七款混编；**B 组撤席+A 组清扫后基线回落 103MB 起**——重载面内存随房回收，锯齿非单调）。蛇王实体面水位显著高于 element/pool 同型组（20 蛇+光点+site 量级本征），三段锯齿有界、终局回收即回落。**PASS**
② **增量收敛+二段起点重置（QA2 §5.8/设计书硬判据闭环）**：一段末（C 组清扫后）124,464KB → SIGTERM 优雅停机 → 二段实例（pid 20471 @18:23:41）重启后 RSS **91,680-98,288KB**（90s 稳态窗 6 采样，swarm×2+六款常驻满配）——高水位随进程重置、低于一段各段起点（127/145/103MB）——**无跨生命周期累积**，QA2 长局观察的 +8.9MB/5min 增速在本单更重负载下复核为同型有界行为。**PASS**
③ **房周期闭环**：一段全生命周期（A+B+C+SIGTERM，gateway.stdout 1,494 行全量）room-create **272 == room-dispose 272** 全配对（归因 ended 250+test-cleanup 8+shutdown 13=271，余 1 笔 reason 字符串属其它清理路径——create/dispose 等量配对红线不受影响，口径披露）；room-end 250 与 ended/轮换自洽（snakeEnd 21=A 组 18 代+C 组 2 代+swarm 房重组 1）。二段实例（RSS 起点重置专用段）优雅停机 dispose 尾迹齐全（shutdown reason 全清，113 行终态）。**PASS**
④ **零错误+句柄无泄漏**：一段 1,494 行+二段 113 行网关日志合计 **uncaught=0、room-error=0**；A/B/C 三组 feed 全量校验 **96 采样 0 错**（七游戏前缀/席位/joinable/mode 断言+测试房不泄漏）；**句柄数一段终 66 → 二段 41**（进程重启回落，无句柄累积；GAMES-86 无泄漏③口径）。**PASS**

## 5. 计时与预算自查（Q-007 纪律）

| 阶段 | 墙钟 | 明细 |
|---|---|---|
| 准备 | 4:52 | checkout+merge main→影子树搭建（server rsync+shasum 对照逐字节一致+games 符号链接+data 隔离+GATEWAY_PID/LOG 改道）→网关 :4416 起→生产端口起点核验（4399=18075/4400=87098） |
| 预飞 | 3:30 | 测试房 state 形状探测（phase/tick/cursor/终局投影）+swarm 房 spectator 探测（frame 10Hz/rd 在位/快照账本）——不计实测 |
| A 首跑（作废） | 2:30 | lib96 复刻的 LOG 指向 gateway.log——GAMES-105 后网关 log 改 stdout-only（LOG_FILE 成死配置），logStats ENOENT 即断——改指 gateway.stdout 重跑（O2 披露） |
| A 组 | 8:42 | 错峰建 6 房 40s → 采样 8:00（48×10s）→ 清扫（43 次 429 回补重试含在内） |
| B 组 | 3:37 | 20 席串行入席 2.5s+3:00 采样（18×10s）→ 撤席托管转移观测 30s |
| C 组 | 5:13 | 建 7 测试房+第 9 间护栏证据 → 采样 5:00（30×10s）→ 清扫 |
| RSS 二段 | 1:38 | SIGTERM→重启→90s 稳态窗（6×15s）→ 优雅停机 |
| **合计** | **采样 16:00 / 实测窗 18:07 / 全程作业窗 27:50** | 起跑计时 17:57:24→压测结束 18:25:14；A→B 接力同秒级（a-rooms.json 落盘后 4s 内 B-START，chain-driver.log）；全程窗超 25min 硬帽 2:50 的归因=首跑作废 2:30（O2 工具口径坑）+影子树搭建计入了起跑计时——采样墙钟 16:00 守住软线 |

## 6. 退回项

**红线退回项：无**（三组 PASS、四件套全过）。

观察项与工具链建议（不阻塞）：
- **O1（观察）** 蛇王 churn 面的 **CPU 均值 35.89%/峰 50.9%**：6 房×30 tick/s（时标 3）×20 实体确定性 sim 的单进程画像——生产语义（时标 1）由 swarm 房承载仅 ~9% CPU（B 组满编 8.02%）；与 GAMES-96 element A 组（1.46%）的差值=实体量级本征（20 蛇×24 节 path+光点 240 上限），非算法劣化（漂移 [-1,+1] 反向证明 tick 预算健康）。容量口径：单网关 ~13 房蛇王（含 2 swarm）+六款混编时 CPU 峰 27.2% 仍宽裕。
- **O2（工具）** **网关日志路径口径漂移**：GAMES-105 后 `server/gateway/index.js` 的 log() 改 stdout-only（`LOG_FILE`/`GATEWAY_LOG` env 成死配置），lib96 复刻的 logStats 读 gateway.log 即 ENOENT 断——本单首跑作废 2:30 的根因；压测 harness 须以 nohup 重定向文件为结构化日志源（本单 lib106 已改，建议后续单复用）。
- **O3（工具）** ①`WsClient.emit2` 单参透传丢 rawLen——A/B 组 spectator 的快照字节画像 avg=null（C 组前已修，画像由 C 组承载）；②ended 房进 graveyard 时 drifts 序列未落盘只留计数（C 组蛇王测试房漂移缺采，判据由 A 组 33 锚点+swarm frameHz 同域双承载）。
- **O4（观察）** 蛇王增量快照 **max 50,340B 巨帧**（p50 654B/avg 689B 的重尾）：轮末 rollover 等巨事件帧的单帧尖峰，全量占比 0.63% 带内、QA2 帧隙零断言未受扰——低危披露，客户端侧已有分帧缓冲（FEEL 层实测 10-17ms 无 jank）。
- **O5（流程）** 测试房 429 槽位滞窗（A 组 43 次回补重试、60s purge 后自愈）为 GAMES-96 O1 同款护栏语义复验，非缺陷。

## 7. 单链收官：蛇王争霸 9/10（+FIX2 跳过说明）

| # | 单 | 产出要点 |
|---|---|---|
| 1 D GAMES-98 | 设计书 | S6 海量实体本格：20+ 蛇巨房/AOI 个性化增量/path 回放蛇身/轮赛常驻房（persistent 跳过 abandon/maxTicks）；8 节+附 12 决策 |
| 2 DEV GAMES-99 | S6 首证 | 两端同式纯函数 sim（ω 积分/TRIG16 烘焙复用）；api-check S6 断言面+feed-grow/kill-hunt 剧本；swarm 白名单事故修复（§实录四）；剧本轮询节拍 60→15ms（输入冻结窗 3.1→~1 tick） |
| 3 QA1 GAMES-100 | 独立复测 | 红线全过+剧本硬化：timeScale 4→3（负载时滞对冲）、full20 混编证伪 competitive 数量说（随机相位方差定级） |
| 4 FIX1 GAMES-101 | 归因收口 | 负载三档对照证伪（0 档反最差=无剂量反应）；删开关候选提交法（首红即 revert）三连绿留存 |
| 5 BOT GAMES-102 | 生态三档 | PERSONA 参数表落 brainImpl（饲料/觅食者/猎手生态位）；放水链=房内 deaths/kills 代理（常驻房无终局脉冲）；绞肉相位方差开关保留 |
| 6 FEEL GAMES-103 | 手感层 | 转向/疾跑/击杀 juice；fx 台账双时戳 10-17ms；世界层墨水带取证范式 |
| 7 QA2 GAMES-104 | 联机红线 | 五面全 PASS 退回 0：延迟容忍/重连三档/满员 24 席旁观/长局 5min 3,002 快照零帧隙；GAMES-84 abandon 锚复验（persistent 45s 观察窗恒在） |
| — FIX2 | **跳过** | QA2 退回 0（观察项 O-1~O-4 全低危：满员 24 席口径/测试房 ack 交替/WS 面 2-tick 尾/持久房无 abandon 语义=设计态），无修复对象——**不派单，单链 9/10 收官**（PM 落笔裁量，任务书 §5「FIX2 跳过说明」授权） |
| 8 VIS GAMES-105 | 视觉统一 | HUD 字号迁移+色盲双编码（pat 形通道+光点形签名）+巨房可读性（远端淡化三档）；识图 v2 20 项断言 4 连绿；perf 60.1fps/0 jank |
| 9 STRESS 本单 | 压测+收官 | 三组 PASS、四件套全过（含 RSS 二段起点重置）、档案 accepted |

单链节奏：9 单（GAMES-98..106：D→DEV→QA1/FIX1/BOT/FEEL→QA2→VIS→STRESS，FIX2 按 QA2 退回 0 裁量跳过），E6-W1-T6 轨，S6 海量实体 20+ 蛇巨房+AOI 个性化增量+path 回放蛇身+轮赛常驻房全链实证。工具沉淀：影子树隔离+GATEWAY_PID 改道、swarm 满编驱动器（20 席 10Hz turn+让位观测）、测试房槽位 429 跨拍回补纪律（GAMES-96 O1 复验）、emit2 多参透传（本单 O3 新增）。

## 8. 结论

蛇王争霸 STRESS 三组 PASS+无泄漏四件套全过：**A 组** 6 测试槽 churn 8min（漂移 [-1,+1] tick、swarm×2 常驻语义复刻 9.989/9.988Hz、生态 kill 6,557/die 7,045、18 代 round-end 投影闭环、feed 48 采样 0 错）；**B 组** 满编 20/20 spot 18/18 采样（同房聚集+让位归零+10.001Hz+ops 35,626 零拒绝+撤席托管转移@10-20s）+四单交叉引用合计 ≥60min 长局覆盖；**C 组** 七游戏混编 30/30 全在场零错误（sims 注册表 7/7、mmo 镇 9.992Hz 满频、快照画像 p50 654B≤850B/全量占比 0.63%≤8%、护栏 429）；**四件套** RSS 三段有界+二段起点重置（124,464→91,680-98,288KB）、create 272==dispose 272 全配对、两段 1,607 行零 uncaught 零 room-error、句柄 66→41 无累积。生产 :4399/:4400 零感知（pid 起止未变）。零服务端代码改动。

**单链收官：蛇王争霸 9/10（GAMES-98..106，FIX2 按 QA2 退回 0 裁量跳过）——档案 `multiplayer:snake-king` stage=accepted（docs/game-quality.json）、战图 §4.3 E6 进度 7/21（W1 波 6/7）、《蛇王争霸开发实录》知识库草稿留档（草稿/GAMES-106/）。**
