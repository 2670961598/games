# 迷你MOBA QA一号（GAMES-128 · 单链 3/10+）

> 独立复验 + S2/S5 双技术专项走查。基线 main@09a1c8f（GAMES-127 DEV 已合并）；分支 feature/GAMES-128。
> 口径：三支柱复跑 / S2 专项（二式快照·AOI 迷雾·ext.ack·带宽画像）/ S5 边界（ruling 原子性·事件不丢）
> / 重连三档（5s/10s+1拍/30s）+ 观战位 + GAMES-84 abandon 锚 / Bot 三档梯度（P0-P8）/ 九作回归 2 作。
> 本单零修复：发现观察项 **O1**（带宽峰值超设计预算）+ **O2**（competitive 梯度倒挂），均转 FIX 候选。

## 结论速览

| 面 | 结果 | 要点 |
|---|---|---|
| 冻结门禁 api-check | ✅ 22/22 | A1-A7 全过（含 A5 重连 1211ms/A6 推塔链/A7 团战账本 21 条） |
| perf | ⚠️ 环境归因带内 | 帧成本 avg 0.9ms<16.7ms 预算（n=87）；对照臂 tactics 13.7fps 同窗同 p95 133.3ms=无头 rAF 封顶（历次 QA1 同口径，绝对 55fps 不可测） |
| 识图 v2 | ✅ | HUD/比分计时/技能弧排（6级角标）/外塔+血条/L1 星法师/圣所 4m 计时在场，零渲染异常；兵线不在场=对局 18s 首波 30s 未出（时序正常） |
| S2 专项 | ✅ 27/28（1 红=O1） | 二式快照账本 2400 张逐张复盘：节拍 1.000/退化阈值不变量/重建一致/AOI 零违例/ack 逐拍回显/带宽常态 13.4KB/s 带内、**峰值 35.4KB/s 超预算** |
| S5 边界 | ✅ 12/12 内含 | kill 唯一裁决/streak/bounty/respAt/助攻窗复算全对；双连接事件零丢失（服务端 1734 条 ⊆ 快照流） |
| 重连三档+观战 | ✅ 23/23 | R1 5s 复席 5008ms+全量重同步+续流；R2 10s+1拍=托管 balanced+复席拒绝+局仍活；R3 30s 托管续打（tick 1391→1699）+bot 让位复席+观战席语义 0/308 违例；R4 abandon=15041ms（15s 窗判别性） |
| Bot 三档梯度 | ⚠️ O2 倒挂 | P0-P8 分层活性真实（op 流互异/技能 comp 188:bal 116:casual 0）；competitive 战损优（kills 7:1/5:0）而存塔分劣 → 0/4 胜（balanced>casual 2/2 正常） |
| 九作回归 2 作 | ✅ | mmo-township 16/0（S2 姊妹）、tactics-duel 19/0（S1+S5 姊妹） |

## 1. 三支柱复跑

- `node scripts/api-check.js mini-moba`（冻结命令）→ **exit=0，22/22**。报告 kernel/workers/GAMES-41/api-check-mini-moba-20261013222753.json。
- perf：绝对 fps 在无头环境不可测（rAF 封顶 ~13fps；对照臂 tactics-duel 13.7fps/jank 86.9%/p95 133.3ms，与战棋 QA1 的 13.4fps 同带=环境归因）。本作帧成本直证（真网关对局 87 帧采样 `__GAMES_DEBUG__.perf()`）：**avg 0.9ms / max 20.1ms < 16.7ms/帧预算** → 60fps 可达（GAMES-118 口径）。
- 识图 v2（`scripts/mini-moba-qa1-smoke.mjs` 截图 + 视觉模型核验）：见上表；HF 字号登记 {p0:13,p0n:13,p1:11,p1b:11,p2:9} 与 hud-font-standard 三级一致。低危观察：「圣所 4m」深底绿字对比度略低。

## 2. S2 专项走查（`scripts/mini-moba-qa1-s2.mjs`，sim 级 2400 tick 账本复盘，小镇 GAMES-53 范式）

- **二式快照**：节拍 snapsPerTick=1.000；snapSeq/frame 逐张 +1（**弃帧不耗号**——小镇 F3 的 +2 跳号缺陷在本作代码序中不存在：字节退化检查先于 `b.seq++`）；全量校准间隔最大 301（FULL_EVERY=300 增量+1，语义正确）；**增量字节 ≤0.7×上次全量不变量违例 0**（实测最大占比 69.9%——增量常贴阈值，为 O1 之成因）；增量 ents=完整实体非差分壳。
- **重建一致性**（67 张全量对拍）：extra=0（leave 账不漏）+ 全量新增实体 15 个均入视野圆；全量帧 `leave:[]` 不带 leave 由客户端替换语义覆盖（client.js:120 prune 实证），tick 284 实例（h4 出圈恰逢连续退化全量窗）定性良性。
- **AOI 迷雾**：violFar=0（视野外动态实体零下发，全程最大半径 334.4px<335 滞回）；预算峰值 ents=18≤41（预算余量大，§5.2 预估成立）；自身实体恒在 ents 首位（和解锚）；**leave 全归因**（出圈/草丛 14 张/消亡，无解释 leave=0——草丛加层真实生效）。
- **ext.ack**：逐拍 ack=seq 无滞后（2400/2400）。
- **观战席**（sim 级 + 网关级双证）：ack=-1/无 me/同 AOI 圆/预算同限（网关 308 张 0 违例）；导演镜头随 kill/tower 质心运动（366 拍位移）。
- **带宽画像**（对照设计 §5.6）：常态对线 13.4KB/s（带内 10-16）；全程均值 10.9KB/s；**1s 滑窗峰值 35.4KB/s 超 <25KB/s 预算 1.4×**（峰值窗=连续 10 张字节退化全量 3.6KB×10Hz；事件字节仅占 2%，实体载荷主导）→ **O1**。

## 3. S5 边界走查（同剧本 S5 节）

- **ruling 原子性**：kill×8（世界击杀 5 条零账）同拍零重复；streak 连击账本复算（击杀+1/受害清零）全对；bounty=150+30×(streak−1) 帽 300 全对；respAt=frame+(5+2×lv)s 全对；**助攻 ∈5s 伤害窗**（hit 账本反查零违例）。
- **无敌链不变量**：2400 拍全程 T1 活则 T2/水晶零掉血、有塔活则水晶零掉血（A6 驱动版另在门禁绿）。
- **超时裁定优先序**：620 tick 短局强制 timeout → 复算水晶HP%→存塔分→击杀→draw 优先序一致（draw 复算=draw）。
- **S2/S5 边界事件不丢**：服务端事件账本 1734 条 vs 玩家连接/观战连接快照流逐一多重集对拍，**零丢失**（含全量帧退化窗）；kill ruling 8 条全部经快照流下发。

## 4. 重连三档 + 观战位 + abandon 锚（`scripts/mini-moba-qa1-net.mjs`，私有网关 :4415，:4399/:4400 零感知）

- **R1 5s 档**：断线→复席 5008ms（<10s 红线）→welcome×2 全量重同步→快照续流（23 张，tick 148→370）→金/等级/装备恢复（gold 225→585 托管期经济增长）。
- **R2 10s+1拍边界**：10.5s 逾窗→席位转 bot 托管（takeOver=balanced ✓）→复席 409 拒绝（复席语义不降级为顶号）→局仍活续推（tick 502→527）。
- **R3 30s 档**（真 WS 非 test 房）：真人输入 ack 回显（ack=48/sent=49）→掉线 30s 托管续打（旁观账本 tick 1391→1699、事件 258 条含 kill/recall/reject）→**fresh join 走 bot 让位复席**（seat 5 复得+快照续流+welcome 全量恢复 gold=2776/lv=3）。
- **R4 GAMES-84 abandon 锚**：独真人在场 16s→掉线 +6s 房仍 live（判别性：若锚=join 时刻首拍即 abandon）→**+15041ms 终局离场**（15s 窗精确）。
- 观战位客户端导演 UI 仍未做（DEV 已披露；本单以 sim+网关双证覆盖协议面）。

## 5. Bot 三档梯度（`scripts/mini-moba-qa1-bot.mjs`，sim 级 3v3 配对 ×2 seed，maxTicks=3000 超时裁定）

| 配对 | 结果 | teamKills | 存塔 | 技能使用 |
|---|---|---|---|---|
| balanced vs casual | **A 胜 2/2** | 8:0 | 1:0 | 58:0 |
| competitive vs casual | **B 胜 2/2** ⚠️ | 7:1 | 0:1 | 94:0 |
| competitive vs balanced | **B 胜 2/2** ⚠️ | 5:0 | 0:1 | 86:52 |

- 分层活性 ✓：同 seed 三档前 400 拍 op 流指纹互异（非死档）；技能使用 comp>bal>casual=0（P1 连招高档专属接线真实）。
- **O2 倒挂**：competitive 击杀领先（7:1、5:0）但存塔分落后 → 超时裁定（水晶HP%→存塔分→击杀）判负。候选根因（未验证）：P1/P2 连招+P7 游走占比高，push-lane 目标（推塔序）在行为栈中被战斗态抢占；终局多为 timeout 时存塔分权重决定胜负。**与战棋 GAMES-119 O1 同族**（最高档打法与胜利条件错配）。转 FIX 候选：调参+梯度回归剧本。

## 6. 九作回归抽查 2 作

- mmo-township（S2 姊妹，快照管线同源）：**16/0**。
- tactics-duel（S1+S5 姊妹，ruling 族）：**19/0**。
- 均 :4400 隔离 test 房（生产网关零干扰）。

## 7. 遗留与移交

| 项 | 级别 | 去向 |
|---|---|---|
| O1 带宽峰值 35.4KB/s > 设计 §5.6 <25KB/s（1s 窗，退化全量串×10Hz，实体载荷主导） | 中（预算偏差非正确性；常态带内） | FIX 候选：实体字段瘦身（如 buffs/cd 数组稀疏化）或全量字节阈值下调（0.7→0.5 提前重锚 lastFullBytes） |
| O2 competitive 梯度倒挂（战损优/存塔劣→超时败） | 中（体验：设计主张 competitive 最高档） | FIX 候选：P 栈优先级/pushTarget 让位调参+梯度回归剧本（含 seed ×2） |
| 观战位客户端导演 UI | 低 | DEV 已披露未做项；协议面已证（本单 §4） |
| 「圣所 4m」对比度 | 低（识图观察） | UI 打磨清单 |
| perf 55fps 绝对值 | 环境 | 帧成本+对照带证据链已足；绝对值留具备环境的单 |

## 8. 自测命令清单（退出码见 REPORT）

```
node scripts/api-check.js mini-moba                     # 22/22（冻结命令）
node scripts/mini-moba-qa1-s2.mjs                       # S2/S5 专项 27/28（1 红=O1）
node scripts/mini-moba-qa1-net.mjs                      # R1/R2/R4 + R3 重跑 23/23
node scripts/mini-moba-qa1-bot.mjs                      # 5/7（2 红=O2 观察项）
node scripts/mini-moba-qa1-smoke.mjs                    # 冒烟+perf 探针+截图（exit 0）
node scripts/perf-smoke.js --slug mini-moba --ms 6000   # boot 超时（无 offline 模式，转帧成本口径）
node scripts/perf-smoke.js --slug tactics-duel --ms 6000 # 对照臂 13.7fps 环境带
node scripts/api-check.js mmo-township                  # 16/0
node scripts/api-check.js tactics-duel                  # 19/0
```
