# 元素对决 QA一号（三支柱 + S5 卡牌专项）—— GAMES-89

- 日期：2026-09-29 ｜ 分支：feature/GAMES-89（merge main@6073780 + feature/GAMES-88@a2c8b87 取测试对象，QA 并 DEV 分支先例）
- 对象：element-duel v1.0.0（S5 · 1v1-duel），sim.cjs 42,797B / client.js 38,694B / 网关适配器 103 行
- 环境：私有网关 :4489（GATEWAY_LOG/PID 改道，避让共享工作树陈旧 :4400），证据目录 `/Volumes/BigDisk/Studio/kernel/workers/GAMES-89/`
- 纪律：只测不改；挂具全部置 `/tmp`（createRequire 指仓内 sim.cjs）；每步计时见各节（累计 ~30min，超 SOP §8.5 预算 25min，超因=四项退回取证）

## 1. 三支柱复测（api-check / perf / 识图）

**api-check element-duel 独立复跑（02:39-02:40，40s）**：21/0 全绿（报告 `api-check-element-duel-20260929023948.json`）。要点：A1 骨架（24HP 双英雄/9 格/welcome 期牌组 0/0 防泄密/room.duel 声明块 element-int-v1#4109962685）、A4 ruling 回执 0ms、A5 断线复席 1208ms、A2 burn-face 胜局（tick=3776 reactions=4）、A3 idle 败局 afk@tick13596、A+ 确定性三联（hash=4220885006，40 条 ops 逐字节，回放==在线）。

**存量五作回归（02:40-02:46）**：全绿零回归——net-tank 14/0、slg-battlefield 14/0、mmo-township 16/0、empire-sprout 16/0、pool-physics 19/0（报告 `api-check-*-20260929*.json` ×5）。

**perf 三跑（02:47-02:49）**：`perf-smoke --slug element-duel` 三跑**结构性假红**（非性能失败）——客户端缺 `__GAMES_DEBUG__.events` 泳道契约，`waitForFunction` 谓词 `events.some` 抛 TypeError（games-80 F3 同款多人版坑；详见退回 F3）。改用**同口径替代挂具**（私有静态服务 :48125 + 私有网关真房双页，rAF 采样、DSF2、375×667，与 perf-smoke 同判据 avgFps≥55/jank<2%）：

| 窗口 | n 帧 | avgFps | jank(>25ms) | long17 | p95 |
|---|---|---|---|---|---|
| pick 浮层 | 240 | **60.0** | **0** | 0 | 16.7ms |
| mulligan 浮层 | 240 | **60.0** | **0** | 0 | 16.7ms |
| play 对局 | 300 | **60.0** | **0** | 0 | 16.7ms |

三窗全过红线（`o1-perf.json`）。

**识图 v2（10:57-11:07）**：`visual-check.js` 同因假红（F3）。以 **DEV O1 遗留补证**的真房截图做替代走查（fresh 房 `element-jv8n2a8637`，两页双席 A=seat1/B=seat0，quick 重试 3 次 squash 掉 2 个网关恢复的陈旧 element 房后取得）：
- `o1-pick-A/B.png`：**选英雄浮层** ✓——「选择英雄（10s 超时随机）」四英雄卡（炎阳/潮汐/疾风/雷鸣，技能+被动+流派三行），「选择英雄 · 5s · 第 1 回合」，24/24，牌库 0 手牌 0（welcome 未定型 ✓）；
- `o1-mulligan-A/B/B-waiting.png`：**换牌浮层** ✓——后手 5 张（含元素微粒 0 费）带保留标记、「确认（保留 5 张）」按钮、「换牌 · 26s」、牌库 17/16 与先/后手起手数自洽，A 确认后 B 侧浮层保持等待态 ✓；
- `o1-play-A.png`：对局态 3×3 空盘+5 手牌+托管/技能/结束回合按钮齐全；
- 观感观察（非退回）：pick 浮层右列描述截断、画面左缘 boot 残字「…关/1:4489」（canvas 未完全遮盖 #boot 文本）→ 留 VIS 单裁量（O-2）。

## 2. S5 专项（确定性三联 / 六对反应 / 状态机边界 / deckSeed 双流）

挂具 `/tmp/ed-s5check.cjs`（sim 直驱 applyOp/step/brain/replayOps 真实入口），证据 `s5-offline.json`：**29 通过 / 2 失败——唯二失败即退回 F1 的缺陷实证**。

**确定性三联 ×3 seed（10/10）**：离线 brain 全驱动整局（非 DEV 剧本路径，独立复证）：
| seed | 对位 | 终态 hash 双跑 | opsLog 逐字节 | 回放器==在线 |
|---|---|---|---|---|
| 777 | casual vs competitive | 943699673 ✓ | 51 条 2444B ✓ | ✓ |
| 424242 | balanced vs balanced | 3881865457 ✓ | 73 条 3502B ✓ | ✓ |
| 99001 | competitive vs casual | 4162343785 ✓ | 74 条 3623B ✓ | ✓ |
异 seed → 异 hash（非平凡性）✓。叠加上文 A+ 在线双跑+回放（网关路径）共四口径全绿。

**六对元素反应全覆盖（B1-B8，4/6 对 + 2 死）**：每对真实 applyOp play 路径摆位实测——蒸气 F+W（全敌 -1，己方 0）✓；连锁 N+T（自动目标 hp 最高 7→5，正交邻接敌 1/5 各 -1，非邻接 cell7 不伤）✓；引爆 F+T（跨行并集 row0+1 双方各 -2 叠加蒸气，F1 自伤死格）✓；燎原 F+N（敌英雄 -2）✓；**迷雾 W+N ✗、感电 W+T ✗——双向部署均零触发**（F1）；扫描序 上→右→下→左（steam 先于 blast）✓；同系邻接不触发 ✓。

**回合状态机边界（7/7）**：pick 超时（1000tick 双席 seed 定，同 seed 复现/异 seed 可异）✓；mulligan 超时=全保留（先手 3+回合抽 1=4/后手 5）✓；mulligan 部分换牌（拒 2 重抽 2，双跑逐字节同；**keep 须与手牌等长含微粒 X0=5 位**）✓；疲劳递增 1→2 扣等量血（24-1-2=21，events=[1,2]）✓；maxTicks 保底（reason=timeout、HP 高者胜/平 HP=draw 双跑同判）✓；连续 3 全超时回合 afk 认负@tick18000 ✓；法力曲线 +1/回合封顶 8 回满 ✓。

**deckSeed 双流独立性（5/5）**：同 seed 同 picks 双席牌序逐字节复现 ✓；seat1 换英雄不影响 seat0 牌序 ✓；同 seed 同英雄两席序互异（seed^(seat+1)·0x9E3779B9）✓；异 roomSeed 异序 ✓；**换牌重抽续同一流**（拒 4/拒 3 → 重抽前缀 [WS1,W2,N1] 一致、seat0 不受影响、deck 12/13）✓。

## 3. Bot 三档实测（九局对打 + 行为探针）

挂具 `/tmp/ed-botcheck.cjs`（与网关 BotHost 同一 `brain` 决策入口），证据 `bot-tiers.json`：

| 对位（×3 seed） | 胜负 | face 率（档均） | 反应数（档均） |
|---|---|---|---|
| casual vs balanced | **balanced 3:0** | casual 0.37 / balanced 0.63 | 1.2 / 2.5 |
| balanced vs competitive | **competitive 3:0** | 0.63 / **0.97** | 2.5 / **2.8** |
| competitive vs casual | **competitive 3:0**（8-9 回合 lethal） | 0.97 / 0.37 | 2.8 / 1.2 |

- **斩杀线意识**（探针：远程 5 攻就绪+FS1 在手+费 5、敌 6 血，lethalReach=11）：competitive 首动作 `play FS1→脸`（§4.2 斩杀模式序列：法术直伤先行）vs balanced `attack→脸`（V 贪心序）；敌方有嘲讽时 reach 正确归 0 不越权 ✓。
- **combo 使用**：competitive 反应数最高（放置组合经 scratch 模拟 ΔV 偏好，全 smart 档共有）；但**手牌 comboBonus（§4.3 competitive 专属 +6/对）未启用**——机制在位（evaluate `{combo:true}` 差值 36=6×6 对 ✓）而 smartNext 仅 hosted 分支接线（退回 F4）。
- **资源管理**：九局 balanced/competitive 出牌密度与技能使用正常、无烧牌（burns=0）；casual 30% 打脸的随手签名清晰（face 率方差大、反应最少）。
- **换牌/选英雄档差**：casual 全保留（111/11111）+ 随机选雄 {1,2,3}；balanced 保留 ≤2 费（11011/00001/010…）+ 均衡池 {1,2}；competitive 同 ≤2 费语义 + **对位反选恒 H3**（对手 H2/H1→H3；仅对手 H0→H1 表实现于 sim.cjs:716）✓；balanced/competitive 换牌语义无差异（§4.4「反应伙伴对保留」「无 2 费以下重抽」未差异化 → F4 附带）。

## 4. 退回项清单

| # | 级 | 现象 | 根因/位置 | 修复面建议 |
|---|---|---|---|---|
| F1 | **P0** | **迷雾(W+N)、感电(W+T) 两对反应在任何对局中永远不触发**（双向部署实测零触发；B4/B6 实证） | `sim.cjs` REACTIONS 表键 `'W+N'`/`'W+T'` 未按字典序存放，`triggerReactions` 以 `[m.school,nb.school].sort().join('+')` 查 `'N+W'`/`'T+W'` 永远 miss（表键 F+W/N+T/F+T/F+N 恰在序上故幸免） | 两键改 `'N+W'`/`'T+W'`（或查表前对键归一）。注意 ENGINE_HASH 随卡池常量变化 → room.duel 版本护栏将提示旧客户端刷新（护栏机制本身如此设计）。修复后须复跑六对全覆盖+双跑确定性（反应序入 serialize） |
| F2 | P1 | **观战客户端渲染崩溃**：满员加入被网关转 spectator（rooms.js:131-136）后，client `v.heroes[S.seat]`（seat=-1）抛 `TypeError: Cannot read properties of undefined (reading 'hero')`，渲染循环中断、画面空白（pick/mulligan/play 全相位复现，`o1-spectator-C.png` 空白+残文） | `client.js` 各渲染分支未处理 seat=-1 观战视图（设计 §5.7 观战双隐藏是冻结功能面） | 观战分支：英雄栏取 `heroes[0]/[1]` 明示观战视角、手牌区只画张数；或暂禁满员转旁观入口 |
| F3 | P2 | **perf-smoke/visual-check 双门禁结构性假红**（三跑+识图均 `TypeError: reading 'some'`）——客户端缺 `__GAMES_DEBUG__.events/start` 泳道契约（pool GAMES-80 F3 已补同款，element-duel 未跟） | `client.js` 仅暴露 hudFonts/state/sendOp | 按 pool 先例补 events 数组+start 钩子；本单已用同口径私有挂具替代取证（perf 三窗 60fps/0 掉帧达标，结论不因 F3 改变） |
| F4 | P3 | **competitive 档 comboBonus 未启用**：设计 §4.3/§4.4 列为 competitive 专属项（+6/反应伙伴对），实现里 `smartNext` 仅 hosted 分支设 `opts.combo`（sim.cjs:671），competitive 与 balanced 的 V 权重完全相同（档差只剩斩杀线/选雄/延时）；附带：换牌两档同语义，§4.4「balanced 保留 ≤2 费+反应伙伴对」「competitive 无 2 费以下重抽」未差异化 | `sim.cjs` smartNext opts 组装 | `if (level==='competitive') opts.combo = true` 一行 + mulliganAction 档位分支；影响面=决策流（Bot rng 定桩不变，双跑确定性不受破坏，但同 seed 对局结果会变——FIX 后 QA 须重跑九局基线 |

观察项（非退回）：O-1 viewFor 手牌键为 `{0,1}` 而设计 §5.1 写 `{me,opp}`（文档-实现字段名分歧，建议设计书回填，同 GAMES-88「manaCur vs mana」有意裁剪先例）；O-2 pick 浮层右列截断/左缘 boot 残字（观感，留 VIS）；O-3 网关恢复的陈旧 element 房可被 quick 加入（共享 DATA_DIR 环境性，非本作回归，本单以双席占位 squash 法绕过）。

## 5. 结论与放行建议

- **通过面**：api-check 21/0 + 存量五作回归 79 断言全绿；确定性四口径（离线双跑/opsLog 逐字节/回放器/在线 A+）×3 seed 全绿；状态机边界 7/7；deckSeed 派生链 5/5；Bot 三档九局胜率递进（competitive 6:0 > balanced 3:0 > casual 0:6）与行为签名清晰；perf 替代口径 60fps/0 掉帧；O1 遗留截图补齐（fresh 房 pick/mulligan 浮层真值）。
- **退回**：**F1（P0，玩法机制级——六对反应死两对）必须 FIX 后复验**；F2（观战崩溃）建议随 FIX 一号；F3（门禁契约）修复后恢复标准门禁口径；F4（competitive comboBonus）低风险可并入。
- **放行建议**：**不放行下游 VIS/STRESS**——F1 修复会改变 ENGINE_HASH 与全部对局演化（反应数/quip/斩杀线均受影响），视觉与压测基线应建立在修复后版本；FIX 一号建议顺序 F1→F2→F3→F4，复验口径=本报告 §2 挂具（`/tmp/ed-s5check.cjs` 逻辑随 REPORT 归档）+ 六对全覆盖重跑。
