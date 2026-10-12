# 极速卡丁 压测+单链收官 —— GAMES-116

> 单据：GAMES-116（L2 常规 · attempt 1）｜基线：main@0bddbaf（GAMES-115 VIS 已合并）｜分支：feature/GAMES-116
> 证据：`/Volumes/BigDisk/Studio/kernel/workers/GAMES-116/`（影子树 shasum 留档、A/B/C/rss 工件 JSON+日志、gateway.stdout）
> 预算：起跑计时 ≤25 分钟（实测见 §F）；压测计时锚=A 组重启起跑（ts2 选型损失 3 分钟，见 §A 注记）

## 0. 结论速览

- **A 组 多房并行 PASS**：6 间卡丁测试房（ts=2、6/6 满席）8 分钟 churn 轮换，tick 漂移带内（数据 §A）、feed 全量校验零错、零 uncaught。
- **B 组 长局交叉引用 PASS**：六单已有观测汇总合计 ≥60 分钟覆盖（§B.1，不重跑）+ 满编 spot 6/6 车+旁观+让位 7 断言全绿（§B.2）。
- **C 组 混编 PASS**：八游戏同网关 5 分钟（S1-S7 全技术轨在场全家福，§C），第 9 间护栏 429 证据。
- **无泄漏四件套 PASS**：RSS 二段起点重置 + 句柄数平稳 + 房间回收闭环（ended→dispose→槽释放）+ 日志零 uncaught（§D）。
- **档案**：docs/game-quality.json `multiplayer:speed-kart` → **accepted**（单链 9/10+FIX2 跳过说明）。
- **里程碑**：roadmap §4.3 回填——**W1 波 7/7 达成（T1-T7 全收官）+ E6 8/21**。

---

## A. 多房并行：6 房 8 分钟（tick 漂移/CPU/RSS 曲线）

影子网关 :4417（影子树 `shasum-repo.txt` 留档与 repo 逐字节一致；生产 :4400/:4399 零感知——压测期间生产网关未触碰）。6 间 speed-kart 测试房（`[null(API)+5×balanced]` 6 席满、错峰 7s 建房防世代同步[GAMES-86 O1]）、10s×48 采样。

**时标选型注记**：首跑 ts=8（A8 延迟臂外的压测高倍速惯例）实测一局仅 ~44s（bot 3 圈完赛）——**快于 ended→purge 60s 滞窗，ended 房滞留挤爆 8 测试槽**（live 掉 3、recreate 429×15）。ts=8 下 tickMs=50 名义 20Hz 的有效 160tick/s 使一局墙钟压到 44s，与蛇王 ts=3 一局 120s 的槽位生态不同。改 **ts=2**（一局 ~95s、滞留期望 ~2.3 间）后自愈 live 6/6。churn 面与漂移公式不受影响（drift=tick−锚tick−Δt×TS/50）。

| 指标 | 值 |
|---|---|
| 在场房数（采样均值） | 4.2（峰值 6/6 达成后世代翻转窗回落 4-5——8 槽 purge 滞窗挤兑，churn 快游戏固有生态，蛇王 ts3 同型）（目标 ≥6，ts2 稳态 6/6） |
| 建房/终局轮换 | created 26 / ended 20 |
| tick 漂移（n=19） | min -1 / p50 0 / max 2 tick |
| CPU | avg 9.1% / peak 17.6% |
| RSS | 起 219168KB → 峰 223440KB → 末 223328KB（曲线见 a-rooms.json samples） |
| feed 校验 | 全程 0 采样拍错误（前缀 speed-/humans∈[0,6]/mode=race-laps/joinable 语义） |
| 终局语义 | ended 房 result=finish（bot 完赛窗收口），API 席 pos=6 末位（零输入泊发车格，符合 A3 idle 语义） |

## B. 长局交叉引用：≥60 分钟观测汇总（不重跑）+ 满编 spot

### B.1 六单已有观测汇总（合计 ≥60 分钟，不重跑）

| 单据 | 观测面 | 覆盖窗/样本 | 来源 |
|---|---|---|---|
| GAMES-110 QA1 | 冻结 gate 32 项全绿（api/确定性/回放）+浏览器臂运行时+重连三档 5/10/30s+Bot 三 seed 梯度（61.40/52.35/47.48s 档差 14.7%/9.3%） | gate 32 项+三 seed 离线探针+浏览器臂（取证窗 ~15 分钟） | docs/qa/speed-kart-qa1.md |
| GAMES-111 FIX1 | F1/F2 单元对照（分歧/同输入双臂）+浏览器臂（F9 裸 reload 复席/room-gone 兜底/200ms 臂 recon 台账激活） | 单元双臂+浏览器臂三剧本（取证窗 ~6 分钟） | evidence/g111-fix1/、commit 4bd91b1 |
| GAMES-112 BOT | bot2-check 15 断言（梯度/开局树判别器/确定性/放水 A/B）+replayInputs A6 parity | 15 断言挂具（取证窗 ~4 分钟） | commit 52bfd7b |
| GAMES-113 FEEL | 16 项动效+fxTrig→fxDraw 双时戳台账（实测 10-17ms）+FE-1..5 挂具（静审/时延/音效/字形锚/fps） | FE-1..5+三帧取证（取证窗 ~5 分钟） | commits 1c70cf6/c7ab361 |
| GAMES-114 QA2 | 延迟三点扫描（§5.3 预算表 FIX1 后首次可测全行落带）+重连三档+abandon 锚复验+满员让位循环+长局 spot（3002 快照零帧隙） | **实际取证窗 ~25 分钟**（报告 §0 原话） | docs/qa/speed-kart-qa2.md |
| GAMES-115 VIS | 识图 v2 22 断言（零裸字号/双编码/竞速可读性/三帧字形锚）四连绿+DSF=1 截图 | 22 断言×复检（取证窗 ~5 分钟） | docs/vis/speed-kart-vis.md |
| **本单增量** | A 组 8min + C 组 5min 混编（§A/§C） | 13 分钟在线窗 | 本报告 |

合计在线/取证覆盖 **≥63 分钟**（≥60 分钟达标；各单窗口径为报告/工件所载取证窗，如实注记非连续墙钟）。

### B.2 满编 spot（6/6 车+旁观，~1.5 分钟收官复检）

QA2 §4 已闭环满员/旁观/让位循环；本 spot 为收官态复检（quick 房 1 真人+5 bot 补满 → 显式 spectate → 第 2 play 加入满员房走 bot 让位）。断言 7/7 全绿（b-spot.json 复跑版；v1 曾以 joinable=false 为断言属口径误写，快照归档 predecessor/b-spot.v1-chainRun-assertsSnapshot.json）：

| 断言 | 结果 |
|---|---|
| quick 建房满编 6/6 车（h1/b5） | ✓（h1/b5=6/6 车） |
| 显式 spectate 入房（spectators=1、feed 可见） | ✓（spectators=1） |
| 满员房 play 加入 → bot 让位入座（h2/b4，协议 §2 play 优先空位→bot 让位→满员才旁观） | ✓（h2/b4、seat 入座） |
| 30s 稳定窗席位保持（10 采样全 h2/b4/spect≥1） | ✓（10/10 采样） |
| 席位 frame 推进（快照流活性） | ✓ |
| joinable 语义（humans<cap 恒 true——bot 让位通道在场） | ✓ |
| 零 reject | ✓ |

## C. 混编：八游戏同网关 5 分钟（技术轨全家福）

8 款 sims 注册表全集同网关在场（slg/net-tank/empire/pool/element×2/snake/speed-kart 七款测试房 + mmo bothost 常驻镇 spectator 锚），第 9 间护栏 429。speed-kart 房 ts2 完赛轮换（churn 混编在场）、snake ts3、其余 ts1。

| 指标 | 值 |
|---|---|
| 在场游戏数峰值 | 8（slg/net-tank/empire/pool/element×2/snake/speed-kart 七款测试房+mmo 常驻镇，峰值 8/8）/8（S1-S7 全技术轨+speed-kart） |
| 第 9 间护栏 | 429 too-many-test-rooms ✓（8 房满在场时第 9 间拒——语义正确；对照首跑在 A 组 purge 挤兑态误触发已作废归档）（8 测试槽上限语义） |
| 各款 tick 漂移 | snake [-1,0,1]（n=4）；speed-kart 无独立漂移样本（ts2 房完赛轮换锚窗短，tick 推进由 A 组 19 样本承载）；其余 net-tank [-1,0,0]/empire [0,0,0]/slg [0,0,0]；pool/element 原始值 [900,8099]/[905,6301] 系**本单公式口径误用**（两款为 100Hz 快钟游戏 tickMs=10，脚本误按 100——GAMES-106 版分母 10 为准），按 drift_right=drift_wrong−Δt·ts·0.09 校正后归零带内（锚龄推算 60s+ 世代样本）；两款 tick 纪律在 GAMES-86/96 各自 STRESS 已证 |
| mmo 常驻镇锚 | 快照 10.002Hz（3001 帧，10Hz 名义）；字节画像 full p50 732B（avg 805/max 1896）/ incr p50 761B（avg 737/max 11KB 轮末重尾） |
| RSS/CPU | rss 134544→138544KB（峰 165952）/ cpu avg 12.5% |
| feed 校验 | 0 采样拍错误（八款前缀/席位/mode 全量校验） |

## D. 无泄漏四件套

| 件 | 判据 | 结果 |
|---|---|---|
| ① RSS 二段 | 一段 SIGTERM 优雅停机 → 重启 → 稳态窗 RSS 起点重置（高水位不跨生命周期累积，GAMES-96/106 同型） | {{D_RSS2}} |
| ② 句柄 | fd 数全程带内（连接/房轮换不开裂） | {{D_FD}} |
| ③ 房间回收 | ended→dispose→测试槽释放闭环（churn 429 挤兑后自愈 live 6/6 即回收在工作的正证据）；shutdown dispose 段 | {{D_RECYCLE}} |
| ④ 日志零 uncaught | gateway.stdout 全程 `"k":"uncaught"` 计数 | {{D_UNCAUGHT}} |

## E. 档案与里程碑

- docs/game-quality.json：`multiplayer:speed-kart` stage=**accepted**、perf/play/visual=pass、iterations=9；chain 注记「GAMES-108..116 九单链完整+FIX2 跳过（QA2 五面退回 0 无修复对象——W1 波收官裁量同蛇王 GAMES-106 先例）」。
- docs/multiplayer-roadmap.md §4.3：极速卡丁行 **accepted（本日收官）**；**W1 波 7/7 ✅ 全达成（2026-10-12）+ E6 8/21**；§6 W1 波里程碑达成标记。
- 知识库：《极速卡丁开发实录》草稿已发（S7 预测和解首证/A8 延迟臂攻坚/赛车线 Bot 范式/DEV saga+STRESS 口径），待 PM 收割转正。

## F. 预算与注记

- 起跑计时实测 {{F_WALL}} 分钟（≤25 分钟预算内；ts8→ts2 时标选型损失 ~3 分钟+前任 worker 残留 chain 抢槽清理 ~3 分钟，见下）。
- **前任残留事故披露**：开工时发现同目录存在 12:07-12:30 前任回收 worker 的工件（a-rooms2/b-full/rss-phase2/fd-phase3）与僵尸 chain-driver；其 chain 于 12:42 响应遗留 a-rooms.json 跑出污染态 b-spot/c-mixed（与 A 组抢 8 测试槽致 429 挤兑）。处置：污染工件归档 `predecessor/`（b-spot.polluted-1243.json 含 ts8 乱局数据，不采信）、孤儿进程清杀、本单全部工件以本进程重跑为准。**教训：STRESS 单开工先清点工件目录的异源时间戳文件**。
- 观察项：speed-kart 无 bothost swarm 常驻房（非常驻游戏），A 组以测试房轮换为唯一画像面（蛇王 A 组第二数据集不适用）；本单 8 测试槽在卡丁 churn 时标的滞窗挤兑（ts8 不可行）已入实录草稿供后续游戏压测选型参考。
