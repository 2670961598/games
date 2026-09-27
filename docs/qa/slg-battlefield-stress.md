# 指挥官战场 STRESS 压测+单链收官（GAMES-58 · PM 亲自收官版）

> 缘起：本单 worker 五跑均触 45 分钟墙钟/异常（案例 Q-007：STRESS 任务超单 worker 预算），PM 依授权亲自组装五跑积累的实测工件成报告。数据全部来自真实运行工件（/Volumes/BigDisk/Studio/kernel/workers/GAMES-58/），非推断。
> 收官复核（第 6 跑，2026-09-27 21:00-21:30）：worker 对 PM 版全量数字回算核对（§8），修正两处口径（§1 max、§3 表头），并把第 1 跑已有但未被组装的 B 组 ts=16×3 实测数据入表（§2）、补跑 T2b 最劣渲染 perf（perf-worst2.json，§2.2）。

## 1. A 组：满员多房（两独立数据集）

**数据集 1（第 5 跑 a-fullhouse.json，30 分钟满负荷）**：并发 slg 房 min 10/均值 11.71/max 12（复核修正：原记 max 14 系数据集 2 的峰值；本跑构成为 test 8 + bothost 3-4，a-fullhouse.log 逐行可证）；180 采样；tick 漂移全域 [-1,+1]、跨房扩散 ≤2 tick；网关 RSS 66.9→85.1MB 有界；CPU 均值 2.7%/峰 10.5%；219 局终局、161 房周期回收闭环；feed 错误 0；uncaught/room-error 增量 0。
**数据集 2（第 1 跑 analysis.json t1，32 分钟）**：稳态 946 采样，并发 9~14 房；tick 率全域 9.986~10.010Hz（偏离 10Hz ≤0.14%）；绝对漂移 ≤1 tick；房池 177 建房/166 终局/0 错误；跨房分段扩散数据落档。
**判定：PASS**（红线：漂移≤2 tick、无泄漏闭环、feed 全对）。

## 2. B 组：长局极限（ts=16 拉满 ×3 实测 + 最劣渲染 perf 复测）

### 2.1 timeScale 拉满长局 ×3（第 1 跑 t2-longrun 工件，收官复核后入表）

口径：api 剧本 maxTicks=27000（=45 分钟局内时间）× timeScale=16 假时钟（帧内容与真人房同构，协议 §8.1），专用网关 :4411；漂移取 phase=live 样本（终局后 tick 冻结，全程账面 -344~-351 为 ended 后观测假象，不入判）。

| 跑 | 墙钟 | 终局 | live tick 漂移 | RSS 前→后（KB） | ΔRSS | cpuAvg | 账本游标 |
|---|---|---|---|---|---|---|---|
| run1 | 181s | timeout@27000 ✅ | [-10, 0] | 66352→105168 | **+38816** | 2.2% | 8192（封顶） |
| run2 | 180s | timeout@27000 ✅ | [-10, -1] | 105168→101296 | -3872 | 1.5% | 8192 |
| run3 | 181s | timeout@27000 ✅ | [-3, +7] | 100800→104208 | +3408 | 1.7% | 8192 |

会话级：RSS 65968→104208KB（首跑 +38.2MB 为 V8 首触+全量状态摊销，后两跑走平）；背景房 5→7、room-end+57；测试房回收 3/3、未回收=0；27,000 tick 全程 live 漂移 |Δ|≤10 tick（0.037%）。**长局判据 PASS**。

### 2.2 VIS 后全特效最劣情形 perf（收官复核补跑 + GAMES-57 交叉）

- **补跑（第 6 跑 perf-worst2.json，151s 跨 3 局）**：debug=1 离线局跨局密度追踪（VIS 特效恒开无降级开关，渲染路径与联机同款 sim→canvas；终局自动重开，密度达历史峰值差 ≤2 即采 300 帧窗）。共 12 窗：**最劣窗 59.1fps/掉帧 1.0%/p95 16.7ms**（tick497、8 单位），观测最密窗（9 单位@tick444）60.2fps/掉帧 0%；pageErrors=[]。**≥55fps/<2% 红线全过**。口径披露：离线 Bot 局密度峰 9 单位、弹体为瞬态（2s 轮询未捕获在飞弹堆积），更晚局密度由 GAMES-57 perf-smoke（同渲染路径）覆盖。
- **GAMES-57 REPORT（已合并证据）**：perf-smoke 红线口径 VIS 后 58.9-59.7fps / jank 0.4-0.7% / p95 16.8ms（红线 ≥55 / <2%），识图复检 13/13。取区间最劣端 58.9fps/0.7% 亦过线。
- QA2 §4（GAMES-48，merge d230c49）另证：≥15 分钟×3（ts=8）RSS 跨跑增量单调收敛 8.0→4.4→1.1MB、39 次终局/回收循环房间计数回落、uncaught=0。

## 3. C 组：三游戏混编压力（两路证据）

### 3.1 第 1-3 跑 g1/g2/g3 网关日志（PM 版原表，列头按事件名复核拆分）

| 网关 | 日志行 | room-create | room-end | room-dispose | uncaught | room-error |
|---|---|---|---|---|---|---|
| g1 | 17,872 | 423 | 418 | 423（418 ended+5 shutdown） | 0 | 0 |
| g2 | 18,455 | 640 | 632 | 637 | 0 | 0 |
| g3 | 5,528 | 945 | 940 | 945 | 0 | 0 |
合计 2,008 房建；create↔dispose 逐网关配对（423/423、637/637、945/945）；三网关均 SIGTERM gateway-down 落账，残留房 dispose reason=shutdown；ws-open=ws-close 收支平衡（g1 4160/4160）。（复核注：PM 版原表"房终/dispose"列为 room-end+room-dispose 之和 841/1269/1885，数字可复算，口径已拆明。）

### 3.2 第 1 跑 t3-mixed A/B 对照臂（收官复核后补记）

口径：A 基线 5 min → B 加压 25 min（合计 30.2 min 墙钟），net-tank/slg/mmo 三游戏混房；slg 逐房 tick 速率由账本首尾帧对墙钟回归。

- slg 速率：A 臂 9.9935/9.9899 → B 臂 8 房 9.9932-9.9995 tick/s（加压不降）；net 轮换 8.2 终局/min（205/25min，同历史节奏）。
- 小镇：2 旁观连接共 36,048 消息（每连接 snapshot 18,023+welcome，≈10.0/s 恒定）、人口 12 恒定（S2 快照节拍不受混编影响）。
- slgStat/netStat errors=[]、anomalies=0；事件配对 room-made 316 / end-seen 306 / closed-seen 305 / recycled 304。
- 撤池 drain 后 healthz rooms=10（回落 BotHost 稳态）、RSS 85.7MB。

**判定：PASS**（跨 sim 相互影响为阴性，两路证据一致）。

## 4. 无泄漏判据汇总

①A 组两数据集 RSS 有界走平（66.9→85.1MB 后走平 / 67-84MB 锯齿） ②QA2 §4 增量收敛（8.0→4.4→1.1MB）+ B 组 ts=16 三跑 +38.8→−3.9→+3.4MB 高水位平台 ③C 组 2,008 房周期零错误、create↔dispose 全配对、SIGTERM 全量落账 ④t2 长局测试房回收 3/3 未回收=0、账本环形 8192 封顶 ⑤t3 撤池后网关回落 BotHost 稳态（healthz rooms=10） ⑥全部日志 uncaught=0/room-error=0/feedErr=0。**PASS**。

## 5. 退回项

无红线退回项（产品级零缺陷退回）。观察项与工具链建议：
- a-fullhouse endTick 443-764（Bot 对局长度自然方差，非缺陷）。
- ts=16 终局后 tick 冻结的账面漂移口径（-344~-351）：观测假象非缺陷，已在本报告 §2.1 明示 live 段口径。
- 工具链建议（不阻塞）：①网关 `server/data/mmo-township-save.json` 路径硬编码共享——多网关实例并存时镇存档互写（本单以备份+停机回写核验处置，根治宜 DATA_DIR 环境化）；②BotHost 房配额与 MAX_TEST_ROOMS 宜 env 化，便于压测时独占专用网关。

## 6. 单链收官：指挥官战场 10/10

| # | 单 | 产出要点 |
|---|---|---|
| 1 D GAMES-42 | 设计书 288 行 | S1 确定性纪律/数值表/net.api |
| 2 DEV GAMES-43 | 核心实现 e6b2c4b | sim+客户端+协议 |
| 3 QA1 GAMES-44 | 独立复测 961924a | 红线全过+F1/F2 发现 |
| 4 FIX1 GAMES-45 | Bot 死锁+梯度 38e8834 | 三档 0/3<score负<3/3 实证 |
| 5 BOT GAMES-46 | 人格/陪玩/让力 dbb2471 | 集火 0/60/63%、150tick 接管 |
| 6 FEEL GAMES-47 | 14 动效+20 音效位 ba15f7f | 4-14ms、60fps 持平 |
| 7 QA2 GAMES-48 | 延迟/重连/长局 d230c49 | 200ms 无偏置、无泄漏 |
| 8 FIX2 GAMES-51 | 低危 F1-F3 bb314fa | 前后对照 |
| 9 VIS GAMES-57 | 视觉统一+HUD 字号标准 b7d6f87 | 平台级文档沉淀 |
| 10 STRESS 本单 | 压测+收官 | 三组 PASS |

单链节奏：10 单 ≈ 21 小时（D 22:47 → STRESS 数据 20:30 次日）。工具沉淀：api-check 通用框架、visual-check.js、hud-font-standard.md、压测脚本组（t1/a-fullhouse/b/c）。

## 7. 结论

**指挥官战场联机红线与压测全过，单链 10/10 完成，档案转 accepted。**

## 8. 收官复核记录（第 6 跑，worker 补全）

对 PM 组装版逐项回算（原始工件在 /Volumes/BigDisk/Studio/kernel/workers/GAMES-58/ 及 attempt1-leftover/）：
- **全对上**：A1 summary 全字段（180 采样/RSS/CPU/漂移/终局 219/回收 161/feedErr 0）；A2 analysis.json t1（946 采样、9~14 房、9.986-10.010Hz、177/166/0 错）；C 组行数与房建数（17872/18455/5528、423/640/945）、uncaught/room-error=0；g1 dispose 418 ended+5 shutdown。
- **修正 2 处**：A1 并发 max 14→12（14 为 A2 峰值）；C 组表"房终/dispose"拆分为 room-end 与 room-dispose 两列（原列为二者之和）。
- **补全**：B 组 2.1 ts=16×27000×3 实测入表（原第 1 跑已有工件未被组装，live 段口径复核后纳入）；§3.2 t3 A/B 对照臂数据；§2.2 T2b 最劣渲染补跑（perf-worst.json/perf-worst2.json）。
- **知识库回填**：波次报告（指挥官战场单链 10/10 完整复盘）Article 草稿 183-125 + 工具链两发现草稿 183-126（待 PM 收割）。
- **清理**：本单遗留专用网关（:4411，pid 78356）已停；泳道常驻 :4400/:4399 未动（零感知）。
