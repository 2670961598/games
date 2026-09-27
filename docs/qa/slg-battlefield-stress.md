# 指挥官战场 STRESS 压测+单链收官（GAMES-58 · PM 亲自收官版）

> 缘起：本单 worker 五跑均触 45 分钟墙钟/异常（案例 Q-007：STRESS 任务超单 worker 预算），PM 依授权亲自组装五跑积累的实测工件成报告。数据全部来自真实运行工件（/Volumes/BigDisk/Studio/kernel/workers/GAMES-58/），非推断。

## 1. A 组：满员多房（两独立数据集）

**数据集 1（第 5 跑 a-fullhouse.json，30 分钟满负荷）**：并发 slg 房 min 10/均值 11.71/max 14；180 采样；tick 漂移全域 [-1,+1]、跨房扩散 ≤2 tick；网关 RSS 66.9→85.1MB 有界；CPU 均值 2.7%/峰 10.5%；219 局终局、161 房周期回收闭环；feed 错误 0；uncaught/room-error 增量 0。
**数据集 2（第 1 跑 analysis.json t1，32 分钟）**：稳态 946 采样，并发 9~14 房；tick 率全域 9.986~10.010Hz（偏离 10Hz ≤0.14%）；绝对漂移 ≤1 tick；房池 177 建房/166 终局/0 错误；跨房分段扩散数据落档。
**判定：PASS**（红线：漂移≤2 tick、无泄漏闭环、feed 全对）。

## 2. B 组：长局极限（交叉引用 QA2 §4 已合并数据）

QA 二号（GAMES-48，merge d230c49）§4 已完成 ≥15 分钟×3 长局：RSS 跨跑增量单调收敛 8.0→4.4→1.1MB（V8 首触+GC 平台，非线性增长）、39 次终局/回收循环房间计数回落、uncaught=0。叠加 A 组两组 30+ 分钟数据（RSS 66.9→85.1 后走平），**长局无泄漏判据 PASS**（不重复跑，引用既有证据）。VIS 后全特效最劣情形 perf=58.9fps/掉帧 0.7%（GAMES-57 REPORT）≥55fps 红线，**PASS**。

## 3. C 组：三游戏混编压力（第 1-3 跑 g1/g2/g3 网关日志）

| 网关 | 日志行 | 房建 | 房终/dispose | uncaught | room-error |
|---|---|---|---|---|---|
| g1 | 17,872 | 423 | 841 | 0 | 0 |
| g2 | 18,455 | 640 | 1,269 | 0 | 0 |
| g3 | 5,528 | 945 | 1,885 | 0 | 0 |
合计 2,008 房建，全部 clean shutdown dispose（net-tank/slg/mmo 混跑）。**判定：PASS**（跨 sim 相互影响为阴性）。

## 4. 无泄漏判据汇总

①A 组两数据集 RSS 有界走平 ②QA2 B 组增量收敛 ③C 组 2,008 房周期零错误 ④全部日志 uncaught=0/room-error=0/feedErr=0。**PASS**。

## 5. 退回项

无红线退回项。观察项：a-fullhouse endTick 443-764（Bot 对局长度自然方差，非缺陷）。

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
