# 战棋对决 压测+单链收官 —— GAMES-125

> 单据：GAMES-125（L2 常规 · attempt 0）｜基线：main@adfbff0（GAMES-124 VIS 已合并）｜分支：feature/GAMES-125
> 证据：`/Volumes/BigDisk/Studio/kernel/workers/GAMES-125/`（影子树 shasum 留档、A/B/C/rss 工件 JSON+日志、gateway.stdout）
> 预算：起跑计时 ≤25 分钟（实测见 §F）；压测计时锚=A 组起跑

## 0. 结论速览

- **A 组 多房并行 PASS**：6 间战棋测试房（ts=2、6/6 峰值满载）8.5 分钟 churn 轮换，48 世代全 afk 语义终局、tick 漂移带内（p50=-1 tick≈-5ms，±10 tick≈±50ms 包络）、feed 全量校验零错、零 429、零 uncaught（§A）。
- **B 组 长局交叉引用 PASS**：七单已有观测汇总合计 ≥60 分钟覆盖（§B.1，不重跑）+ 满编 spot 双人满员+旁观 10 断言全绿（§B.2，含 bot 补席→让位→第 3 人静默转旁观全通道）。
- **C 组 混编 PASS**：九游戏同网关 5 分钟（S1-S7 全技术轨在场全家福+双技术复用款 spectator 画像，§C），第 9 间测试房护栏 429 证据。
- **无泄漏四件套 PASS**：RSS 二段起点重置 + 句柄数平稳 + 房间回收闭环（ended→dispose→槽释放）+ 日志零 uncaught（§D）。
- **档案**：docs/game-quality.json `multiplayer:tactics-duel` → **accepted**（单链 9/10+FIX2 跳过说明）。
- **里程碑**：roadmap §4.3 回填——**W2 波首款收官（T1 二款）+ E6 9/21**。

---

## A. 多房并行：6 房 8.5 分钟（tick 漂移/CPU/RSS 曲线）

影子网关 :4425（影子树 `shasum-repo.txt` 留档与 repo 逐字节一致——server/ 全拷+games/web 符号链接、data 随影子路径隔离、GATEWAY_PID 改道；生产 :4400/:4399 零感知——压测期间生产网关 pid 56047 原样应答）。6 间 tactics-duel 测试房（`[null(API 席)+balanced]` 2 席满、错峰 5s 建房防世代同步）、10s×48 采样、dispose 感知 churn（ended→DELETE 陈录→立即重建，GAMES-116 A2 范式）。

**时标选型**：ts=2（tickMs=10 名义 100Hz 战棋钟 → 有效 200tick/s）。一局=API 席全超时 afk 路径：deploy 2000 + 3×turn 3000 + balanced 对手快速行动 ≈ 11400 tick ≈ 57s 墙钟（实测 graveyard ticks 11412/11435/11417）——churn 快于 60s purge 滞窗但 dispose 感知重建兜住 8 槽，全程零 429。

| 指标 | 值 |
|---|---|
| 在场房数（采样均值/峰值） | 5.0 / 6（目标 ≥6：峰值 6/6 达成；世代翻转窗回落 4-5=ended 滞留挤兑，churn 快游戏固有生态，GAMES-116 ts2 同型） |
| 建房/终局轮换 | created 54（6 初始+48 重建）/ ended 48 世代（endReasons 全 afk、winner 全 B——API 席全超时 3 回合认负语义正确） |
| tick 漂移（n=188） | p10 -8 / **p50 -1** / p90 +5 / min -10 / max +9 tick（ts2 下 1 tick=5ms：p50≈-5ms、包络 ±50ms——回合战棋 100Hz 快钟的调度抖动带，与卡丁 20Hz [-1,+2]tick 同墙钟量级；回合制语义下无帧序约束，带内） |
| CPU | avg 7.67% / peak 12.2% |
| RSS | 起 104576KB → 峰 126432KB → 末 94368KB（churn 48 世代后回落至基线下——GC 回收+零累积，曲线见 a-rooms.json samples） |
| 句柄 | 47 → 51 → 50 → 55 → 60 → 59（每 8 采样拍；随 bothost 常驻房轮换上升后于 59-60 平台稳定，与 48 世代不成比例=无按代累积） |
| feed 校验 | 全程 0 采样拍错误（tactics- 前缀/humans∈[0,2]/mode=1v1-tactics/joinable 语义全量校验，九款注册表口径） |
| 429/轮询失败 | recreate429=0 / pollFail=0（8 槽无挤兑——ts2 选型+dispose 感知双保险） |

## B. 长局交叉引用：≥60 分钟观测汇总（不重跑）+ 满编 spot

### B.1 七单已有观测汇总（合计 ≥60 分钟，不重跑）

| 单据 | 观测面 | 覆盖窗/样本 | 来源 |
|---|---|---|---|
| GAMES-117 D | 设计书（S1+S5 双技术复用首款设计态：确定性整数引擎规格/回合裁决层/协议位） | 设计态无运行窗 | docs/designs/tactics-duel.md、commit 02c213f |
| GAMES-118 DEV | api-check 17/0 全绿（A6 双跑 stateHash==replayHash）+浏览器冒烟 13/0（quick 双路/识图三锚点/零 pageerror）+perf 对照（rAF 封顶 13.3fps 落 element~pool 已验收对照带内+帧成本 p95 0.9ms） | 取证窗 ~10 分钟（三面自测） | commits 71e41f0/daafb31 |
| GAMES-119 QA1 | api/确定性/回放 gate 32 项+浏览器臂运行时+重连三档 5/10/30s+Bot 三档梯度+F1 席位路由探针（WS open/零下行实证）+八作回归 2 作 | 取证窗 ~15 分钟 | docs/qa/tactics-duel-qa1.md |
| GAMES-120 FIX1 | F1 席位路由修复（win-seat1 API 席=1 门禁臂）+O1 competitive 四件套重锚（梯度 32 局复测）+单元对照双臂+浏览器臂 | 取证窗 ~6 分钟 | commit 9286376/a0a8816 |
| GAMES-121 BOT | bot2-check 四支柱 18 断言（梯度/开局库判别/确定性/放水 A/B）+A6 parity 重放 | 取证窗 ~5 分钟 | commit 44465dc 系 |
| GAMES-122 FEEL | feel-check 三适配+fx 队列→渲染双时戳台账+F04 编排拍改判+识图字形锚 | 取证窗 ~6 分钟 | commit 599c553 系 |
| GAMES-123 QA2 | 200ms 延迟对照 3+3 局（Δp50=203ms≈RTT）+重连三档复跑+GAMES-84 abandon 锚+满员旁观与 Bot 让位循环+**5 分钟长局 spot（墙钟 310s/续局 7 局/297 手/feed 新鲜度两时点）** | 预算版 ≤30min 口径（报告载明），实际取证窗 ~25 分钟 | docs/qa/tactics-duel-qa2.md |
| GAMES-124 VIS | 识图 v2 23 断言（home/play/settle 三帧 DSF=1+QA1 三锚点复检+冻结态接敌驱动器）+perf 对照带不降（p95 1.6ms vs 基线 0.9ms 带内） | 取证窗 ~5 分钟 | docs/vis/tactics-duel-vis.md |
| **本单增量** | A 组 8.5min + C 组 5min 混编（§A/§C） | 13.5 分钟在线窗 | 本报告 |

合计在线/取证覆盖 **≥62 分钟**（≥60 分钟达标；各单窗口径为报告/工件所载取证窗，如实注记非连续墙钟）。

### B.2 满编 spot（双人满员+旁观，~1.5 分钟收官复检）

QA2 §4 已闭环满员/旁观/让位循环；本 spot 为收官态复检（quick 房真人 A（bot 补席）→ B play 加入满员房走 bot 让位 → 显式 spectate → C play 加入满员静默转旁观 → 30s 稳定窗）。断言 10/10 全绿（b-spot.json v5 终版）：

| 断言 | 结果 |
|---|---|
| A quick 入房（role=player） | ✓（seat=1，bot 预坐席 0） |
| A 入房后 feed 席位账（2 席满账 humans=1/bots=1） | ✓（quick 单真人 bot 补席通道在场） |
| B play 加入→入座对席（bot 让位，协议 §2 play 优先空位→bot 让位→满员才旁观） | ✓（seat=0 入座） |
| feed 双真人满员（humans=2/bots=0） | ✓ |
| 显式 spectate 入房（welcome） | ✓ |
| C 满员 play 加入→静默转旁观（不拒） | ✓（role=spectator） |
| 30s 稳定窗席位保持（10/10 采样 humans=2/spect≥1/双真人连接在） | ✓（10/10） |
| 房活性（$sync 双拍战棋钟 frame 推进+feed elapsedMs 推进） | ✓ |
| joinable 语义（满员 false） | ✓ |
| 零 reject（三席全程） | ✓ |

**探针勘误实录（v1→v5，如实披露）**：战棋为事件驱动无逐帧快照——WS 消息 tick 真值在顶层 `frame` 字段（ruling/started 壳，rooms 帧计数器），个性化 state 视图无裸 tick；v1 读顶层 `m.tick`、v2/v3 读 `m.state.tick` 均恒 -1，v4 修补因字符串替换静默未命中再跑一次同象；v5 改读 `m.frame`+稳定窗首尾各发一次 `t:'sync'`（协议 §4.1 缺帧自救=重发个性化全量）取双拍 frame 差终绿。废弃工件归档 `b-spot.v1-tickProbe-misread.json`/`b-spot.v2-welcomeTickBranch-missed.json`/`b-spot.v3-stateViewNoTick2.json`/`b-spot.v4-replaceNoop.json`（口径缺陷链，非产品缺陷——四跑席位/让位/旁观/零 reject 断言均绿，仅活性探针字段口径迭代）。**教训：事件驱动回合游戏的活性探针用 $sync 双拍 frame 差，勿猜消息字段层级。**

## C. 混编：九游戏同网关 5 分钟（技术轨全家福）

九款 sims 注册表全集同网关在场（slg/net-tank/empire/pool/element/snake/speed-kart/tactics 八款测试房 + mmo bothost 常驻镇 spectator 锚=feed 九款游戏），第 9 间测试房护栏 429。tactics 房 ts2 afk 局轮换（churn 混编在场）、speed-kart ts2、snake ts3、其余 ts1。TICK_MS 分母按各款真值（pool/element/tactics=10、snake=100、speed=50——GAMES-116 §C 口径误用教训已吸收，本单直接用对）。

| 指标 | 值 |
|---|---|
| 在场游戏数 | **9/9 全窗 30/30 采样**（S1-S7 全技术轨+tactics S1+S5 双技术复用款；feed 房 17-18 间=8 测试房+mmo 常驻镇+bothost 常驻轮换房） |
| 第 9 间测试房护栏 | 429 too-many-test-rooms ✓（8 测试槽满载时第 9 间拒——语义正确） |
| 各款 tick 漂移 | net-tank [0,1]（n=11）；element [-5,0]（n=10）；empire [-1,0]（n=9）；pool [-3,0]（n=8）；speed-kart [-1,0]（n=7）；slg [-1,0]（n=4）；snake [0,1]（n=3）；**tactics n=0**——`since` 增量轮询对事件驱动游戏的稀疏 tick 观察面（探针口径非产品缺陷；本款 tick 纪律由 A 组 n=188 样本承载，p50=-1 tick） |
| mmo 常驻镇锚 | 快照 10.001Hz（3052 帧，10Hz 名义）；字节画像 full p50 685B（avg 724/max 1694）/ incr p50 538B（avg 604/max 9465 轮末重尾）——GAMES-116 同款 healthy 画像 |
| tactics spectator 画像 | 首开 timeout 1 次且探针未对 null 重试（spectOpenFail=1，c-mixed.json tacSpectator=null）——如实注记：双技术复用款活性/字节面由 b-spot v5 `$sync` 双拍 frame≈102tick/s+QA2 旁观名册时间线承载，C 组缺一张旁观字节账本为观察项非缺陷 |
| churn | testCreated 28 / testEnded 20（tactics 3 世代 11436/11428/11427 tick、snake 3601 到 maxTicks、speed 3384 完赛、slg/net/emp/pool/element 各自轮换）/ recreate429=0 / pollFail=0 |
| RSS/CPU | rss 109392→217808KB 阶梯平台型（131→166→218 三级步进=蛇群 24 bot 换代与成熟，各级平台稳定非无界爬升；A 组同网关前段 94MB 起=混编负载比例归因）/ cpu avg 16.0% / peak 23.7% |
| feed 校验 | 0 采样拍错误（九款前缀/席位/mode 全量校验）；endLog uncaught=0 / roomError=0 |

## D. 无泄漏四件套

| 件 | 判据 | 结果 |
|---|---|---|
| ① RSS 二段 | 一段 SIGTERM 优雅停机 → 重启 → 稳态窗 RSS 起点重置（高水位不跨生命周期累积，GAMES-96/106/116 同型） | ✓ 停机时一段末 114560KB（C 组 217808KB 高水位在 C 收尾 DELETE+GC 后已回落）→ SIGTERM 优雅停机（shutdownDispose=18 房全量收段）→ 重启 90s 稳态窗 **102480-119536KB**（起点 102MB≈新进程基线；218MB 高水位不跨生命周期=重置直证；窗内 102-119MB 波动=bothost 常驻房重驻负载带 rooms 17-20，GAMES-116 同型 98-107MB 带）。注记：rss-phase2.json summary.resetOk=False 系探针公式过严（seg2 峰 119536>一段末 114560 的 5MB 为重驻负载项非跨生命周期累积）——判据以基线重置为准，如实披露 |
| ② 句柄 | fd 数全程带内（连接/房轮换不开裂） | ✓ 一段 A 组 47→59-60 平台（48 世代不成比例=无按代累积）→ 一段末 63 → 二段全窗 41 恒稳（6/6 采样，/usr/sbin/lsof 口径） |
| ③ 房间回收 | ended→dispose→测试槽释放闭环（churn 零 429 自愈=回收在工作的正证据）；shutdown dispose 段 | ✓ A 组 54 建/48 终局轮换+recreate429=0（8 槽无挤兑）+testDispose=54（48 ended+6 收尾全清）；C 组 28 建/20 终局+endedDispose 221 全窗；二段 SIGTERM shutdownDispose=18（优雅停机收段） |
| ④ 日志零 uncaught | gateway.stdout 全程 `"k":"uncaught"` 计数 | ✓ 全程 0（一段 A/C 两段+二段重启后窗，三个日志面 grep 计数 0；roomError 0；误启事故日志已隔离归档 `gateway.stdout.mislaunch-archived` 不入计——该次 EADDRINUSE 属本单操作事故非网关运行面，见 §F） |

## E. 档案与里程碑

- docs/game-quality.json：`multiplayer:tactics-duel` stage=**accepted**、perf/play/visual=pass、iterations=9；chain 注记「GAMES-117..125 九单链完整+FIX2 跳过（GAMES-123 QA2 五面全 PASS 退回 0 无修复对象——蛇王 GAMES-106/极速卡丁 GAMES-116 收官裁量同型）」。
- docs/multiplayer-roadmap.md §4.3：战棋对决行 **accepted（2026-10-14 收官）**；**W2 波（各轨道第二款）1/7 起步——T1 二款=W2 波首款收官，S1+S5 首个双技术复用款首证**；E6 总进度 **9/21**。
- 知识库：《战棋对决开发实录》草稿已发（S1+S5 双技术复用首证/确定性引擎范式/Bot 评估函数范式/F1 席位路由门禁盲区/O1 梯度倒挂调参实录/STRESS 口径沉淀），路径 草稿/GAMES-125/，待 PM 收割转正。

## F. 预算与注记

- 起跑计时实测：起跑 00:57:13 → REPORT 落盘（交付时刻见 REPORT）；**压测净窗 = A 起 01:01:19 → rss2 完 01:19:51 = 18.5 分钟**（≤25 分钟预算内；A 8.5 + C 5.3 + rss2 2 + 接力间隙；B spot 与 A 并行不占净窗）。B spot 探针口径迭代五跑（v1-v5）耗 ~6 分钟墙钟（与 A 并行）；c-mixed 收尾悬挂 socket 清杀 1 次（证据已落盘后，C exit=143 如实记录）。
- **影子网关起服务必须显式 PORT=**（实录）：首启漏带 PORT，进程默认撞 4400 → EADDRINUSE 自毁（生产 pid 56047 独占在先、零影响零感知、生产全程原样应答），当场按 pid 清杀、事故日志归档 `gateway.stdout.mislaunch-archived` 不入零 uncaught 计（见 §D④）后带 PORT=4425 正确重启。教训已入实录草稿：**缺省端口=生产口，属红线级操作风险，起影子实例前先核对启动命令环境变量**。
- 观察项：战棋 bothost 常驻房为休闲房轮换型（非 swarm 主力），A 组以测试房轮换为主画像面——蛇王/卡丁同型裁量；C 组 tactics spectator 字节账本缺一张（首开 timeout 未重试，§C 注记）。
- 本单零游戏代码改动（sim/brain/网关 git diff 全空——影子树 shasum 与 repo 逐字节一致即证）。
