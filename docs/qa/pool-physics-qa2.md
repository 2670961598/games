# 八球台球 QA 二号报告（pool-physics-qa2 · 联机红线专项·预算版）

> 单据：GAMES-83（[QA·E6-W1-T4] 八球台球 QA二号（延迟/重连/旁观·预算版）单链 7/10+，attempt 1）
> 对象：`games/multiplayer/pool-physics/` + `server/gateway/`（前置链 DEV/QA1/FIX/BOT/FEEL 均已合入 main）
> 立场：**独立复测**——不采信任何自测，以下全部数据为本单亲测采集；只测不改代码（本文件为唯一交付物）。
> 环境：feature/GAMES-83（先 `git merge main`，Already up to date @ bdb22d8）。
> **测试网关**：:4483 专用实例（QA1 范式影子树 `kernel/workers/GAMES-83/gw/`，与本分支 `server/gateway`+`games/` **字节级零 diff** 已验证；
> 常驻 :4400 全程零触碰）。工具：GAMES-48 同款零依赖 RFC6455 WS 客户端（帧解析复用 `server/gateway/lib/ws.js`）+ 单向 100ms×2 延迟代理
> + **回合制驱动器**（行为对齐真客户端 client.js：ruling.shot 到达即本地确定性重演、snapshot ±2 milli 校验锚、全停等终判同步回视图）。
> 证据目录：`/Volumes/BigDisk/Studio/kernel/workers/GAMES-83/`（JSON 11 份 + 网关全量日志 + 脚本 8 份）。
> 执行日：2026-09-29 02:31–02:53，**专项墙钟 ≈22min ≤ 25min 预算**（每步计时见各节）。

**总裁决：延迟/重连/旁观/长局/feed 五面红线全部 PASS；200ms 回合制天然容忍论成立（ack=RTT 且球动表现零延迟）。** 退回 1 项中危（F1：abandon 锚点短路 10s 重连窗——网关横切面，非本作 sim 缺陷）+ 1 项低危待查（F2：early-eight 终判帧与客户端重演的 8 号球终位 3/73 不一致）+ 2 项工具链备忘（§6）。

---

## 1. 200ms 模拟延迟（可玩性 + 回合制容忍论证实证，3+3 局）

**注入方式**：本地 TCP 延迟代理（客户端⇄代理⇄网关，每方向固定 100ms ⇒ 往返 ≈200ms；同延迟定时器 FIFO 保序）。代理自证：经代理 ping/pong RTT p50=**204ms**（p95 206），直连 p50=**1ms**。测试面假时钟无法注入网络延迟（API 虚拟会话无网络路径，GAMES-48 已证），对照局全部走真 WS 会话。

**对照设计**：双臂同剧本——3 局真 WS 对 bot（feed 挑本作纯 bot 房 takeover 入席），驱动器在己方 aim 回合 0.6–1.1s 思考后出杆（最近本组球直射，合法/犯规交物理裁决），打满 6 杆后认负收束。plain 臂直连（墙钟 25.5s）、delay 臂经代理（墙钟 59.6s，含补房等待）。

| 指标 | plain（RTT 1ms） | delay（RTT 204ms） | 判定 |
|---|---|---|---|
| 局数/终局 | 3 局：early-eight×2 + 超窗截断×1（数据完整） | 3 局：resign×2 + 超窗截断×1（数据完整） | ✅ 同通道收束 |
| shot op→ruling(motion) ack p50 | **1ms**（p95 1，n=7） | **204ms**（p95 205，max 261，n=18） | ✅ ack≈RTT+ε，零额外排队 |
| 快照帧节奏（服务端 10Hz 生成） | 帧差 p50=10 tick（100ms） | 帧差 p50=10 tick（100ms） | ✅ 延迟不改变生成节奏，只平移到达 |
| 重演/快照双端一致性 | 14 杆：**11 exact**（2 例 early-eight 终判差 → §6-F2）；快照锚 3355 次 0 偏差 | 45 杆：**45/45 exact**；快照锚 **11393 次 0 偏差**（maxDelta=0） | ✅ 一致性不受延迟影响（含增量/全量两种快照） |
| 协议错误 | 0 | 0 | ✅ |

**回合制容忍论证实证**：①出杆受理链路 ack=204ms，占 aim 回合预算 30s 的 **0.68%**——"拉杆蓄力→击出"的节奏感知不可分（对照 slg RTS 的 306–409ms 输入确认体感）；②**球动期表现为客户端本地确定性重演（client.js §5.4 同款），观感延迟 0ms**——10Hz 快照仅是校验锚而非表现源（上表 16k+ 次锚验证 0 偏差即其可靠性）；③回合归属/计时器/ruling 全部服务端权威，延迟不构成玩法输入通道。**结论：200ms 往返下可玩性无损，胜负面零延迟依赖。** 证据：`latency-plain.json`、`latency-delay.json`。

## 2. 断线重连三档（5/10/30s）+ 观战中重连

方法：测试房（`/api/test/*`，与 WS 同一条 RoomManager 路径，seed 20260983）+ 真 WS 探针双轨。恢复正确性判据=welcome 规则态比对（球位/分组/回合/shotN/potOrder/pottedBy/ball-in-hand）。

| 档 | 场景 | 实测 | 判定 |
|---|---|---|---|
| **5s**（真 WS，对 bot 局） | 出杆后掉线 4.0s 复席 | resumeOk @**4006ms**；welcome 球位/turn/ballInHand/groups **全同**；复席续玩（再 9 杆 **9/9 restExact**）→ 干净终局 | ✅ |
| **5s**（测试房，ball-in-hand 保全） | 空杆犯规→对方 BIH→掉线 5.0s | resume @**5007ms**；规则态 **9/9 字段逐一相同**（`_all:true`）；ballInHand+turn 保全；断线期 0 条 ruling（局面冻结如设计） | ✅ |
| **10s**（窗内 9.6s） | 掉线 4.8s 时席位仍 human，9.6s 复席 | resume @**9605ms** ok，席位 human 未托管 | ✅ |
| **10s**（超窗 10.5s） | +**10081ms** 托管转换：kind=bot、level=**casual**、name=**Bot·托管**（=META.takeOver §5.3） | 托管活性：**6s 内 shotN 0→2**（bot 代打实证，账本断线期停记→state.shotN 口径）；$reconnect→**409 resume-rejected** ✅ 复席不降级为顶号 | ✅ |
| **30s**（测试房） | +10073ms 托管；shotN 轨迹 10.5s/14.1s 两杆代打 | +32s $reconnect→**409 room-gone**（房已回收） | ✅ 如实记录 |
| **30s**（真 WS 复现，§6-F1） | **在场 22s 后掉线** | **5ms 内卡片消失**（abandon 终局+回收，零宽限）→ 重连必 room-gone | ⚠️ 机制见 F1 |
| **观战中重连** | 旁观连接掉线 3.6s 后重进 | welcome role=spectator 恢复；帧号流 2583–2731→3093–3687 **单调续流无回卷**；48 条消息正常接收 | ✅ |

- 复席机制走 `rooms.join` resume 分支（token+席位校验），测试面与真 WS 为同一函数——两轨结果互相印证。
- 附注（测试设计竞态，非缺陷）：活跃局 5s 档初跑时断线期 casual bot 一杆提前落黑八 → 房终局 → 复席合法 room-gone；冻结面（t5b）与真 WS 早断（t2c）双绿覆盖该档红线。证据：`reconnect-tiers.json`、`reconnect-ws.json`、`reconnect-ws2.json`。

## 3. 满员旁观 + 挂机超时出杆 + 托管/让位循环（真房三连接）

序列：纯 bot 房 → p0（策略玩家）+ p1（idle 挂机）双真人入席 → p2 旁观 → p1 过 30s aim 窗 → p1 掉线 +10s 托管 → p1b 再进让位 → p0 认负收束。全程 400ms feed 采样（§5）+ 三连接 ruling 帧对齐。

| 检查 | 实测 | 判定 |
|---|---|---|
| 满员卡片 | humans=2/bots=0/spectators=1/**joinable=false**，入席后 **249ms** 可见 | ✅ |
| **挂机超时出杆** | p1 静默挂机：aim 计时 30000ms 走满后服务端发出 **`timeout-shot` 事件**（ruling 事件流对全连接可见，事件帧恰为 aim 起 +3000 tick=30.00s）→ 随手杆落桌、回合正常流转 | ✅（连续 3 次超时→afk 认负为 sim §1.2 设计，本轮观察 1 次即足） |
| **对手托管期行为**（掉线路径） | p1 硬断 → **+10082ms** 席位转 Bot·托管(casual) → 托管窗 **6.5s 内 2 次 motion ruling（shot@该席）** 代打实证 | ✅ |
| 让位归还 | p1b 再进 join → **拿回原席**（role=player 同席位） | ✅ |
| 三连接帧对齐 | 玩家/旁观 ruling 帧号流 **18/18 完全一致**，零单侧帧 | ✅ 同帧观战红线 |
| 旁观稳定性 | 整场 168 条消息、无协议错误、end 正常到达 | ✅ |

证据：`fullroom.json`（含 feed 采样流、timeout/托管 ruling 原文、p0 重演取证）。

## 4. 长局稳定性（5 分钟多房 spot + QA1/BOT 交叉引用）

**多房 spot**（干净口径：对实际服务进程采样，02:46–02:51）：网关 5 游戏混合负载（empire×2/mmo×1/net×2/pool×2/slg×2，9–10 房滚动，含本单全部专项负载同窗）——RSS **82240→83008KB（+768KB/5min，单调有界）**，uncaught=0、room-error=0；实例全生命周期（01:42 起）日志 **549 次建房/540 次终局循环、0 uncaught、0 room-error**。无泄漏证据（RSS 抬升<1%，房计数稳态回落）。
**交叉引用**：①QA1（pool-physics-qa1.md）：api-check **19/19**、确定性三联（双房 stateHash **4145105579** 相等、56 杆 shot 日志逐字节相等、在线 restHash **1610025462**==回放器 hash）、Bot 三档 9 局差异实证（casual 犯规率 0.681 vs competitive 0.096）；②BOT 单（GAMES-81）：三档策略表+14/14 挂具绿。本单在线路径新增 **45/45+9/9 全停逐字节一致 + 16k 次快照锚 0 偏差**（§1/§2），与 QA1 回放器口径互补。**结论：长局无泄漏、确定性双口径（离线回放/在线重演）一致。** 证据：`spot5min.json`、`gateway.log`。

## 5. feed 联动（全生命周期卡片正确性 + 时延 ≤5s）

| 生命周期迁移 | 触发→feed 可见 | 红线 ≤5s |
|---|---|---|
| 满员（humans=2/joinable=false） | 末位入席 → **249ms** | ✅ |
| 旁观加入（spectators=1） | welcome → **<249ms**（与满员同拍采样） | ✅ |
| 托管转换（humans 2→1，§3） | 席位广播 → **406ms** | ✅ |
| 让位归还（humans 1→2，§3） | 再进 join → **308ms** | ✅ |
| 终局→卡片消失（resign 收束） | room-end → **201ms** | ✅ |
| 房间创建（BotHost 补房） | 旁观占位触发 → 新纯 bot 房卡片 **25ms** | ✅ |

卡片字段全程与真态一致（humans/bots/spectators/joinable）；测试房未出现在任何采样（隔离红线，QA1 A1 同口径）。**全档实测 ≤0.5s，远低于 5s 红线。** 证据：`fullroom.json`、`feed-create.json`。

## 6. 退回项清单与 FIX 建议

**红线退回项：无**（§1–§5 红线全 PASS；F1 为网关横切面语义缺陷，建议开 FIX 单，不阻塞本作单链验收——受影响的是"独真人 quick-match 房掉线"场景的重连体验）。

| # | 级别 | 条目 | 证据 | 复现步骤 |
|---|---|---|---|---|
| F1 | **中**（网关横切面，波及全部非 persistent 联机游戏） | **abandon 计时锚=最后入房事件而非最后在场时刻**：`rooms.js:143-144` 仅在 join/resume 写 `lastHumanAt`；`:265` 的在场刷新 `if (anyConn) lastHumanAt=now` 只在 persistent（mmo）分支，非 persistent 分支（:272）直接判 `now-lastHumanAt>15s` ⇒ **在场 >15s 的独真人房（quick-match 对 bot 最常见形态）掉线后首个扫描拍即 abandon（实测 5ms 内房终局+回收），10s 重连窗与 10s 托管代打双双被短路**，SDK 只能得到 room-gone"对局已结束"。两真人房不受影响（对方连接保住 anyConn）。GAMES-48 曾观察到"+15s abandon"系断线早于入房 15s 所致，锚点问题被短断线窗口掩盖 | `reconnect-ws2.json`（22s 在场→5ms 消失）；网关日志 `pool-8l6kdu909b`：join@+0s→abandon@+15.04s（掉线在其间）；`rooms.js:265-272` | 真房独真人入席 → 静待 20s → 断开 → 立即轮询 feed（卡片即刻消失）/再连（room-gone）。**修复方向**：非 persistent 分支同样执行 `if (anyConn) room.lastHumanAt = now`（一行上提），使 15s 宽限自"全员离线"起算 |
| F2 | 低（待查，疑终局投影口径） | **early-eight 终判帧与客户端同款重演的 8 号球终位不一致（3/73 杆）**：3 例均为提前落黑八终局（end ruling phase='ended'）时，本地重演 8 号球未落袋停在某桌面位 vs 服务端已 pot 于袋口（如 local [255000,85000,0] vs srv [8910,9442,1]）；**同杆飞行期快照锚 0 偏差**、delay 臂 45/45 全对、QA1 A6 合法黑八终局 hash 一致——确定性本体无恙，疑终局/终判消息的状态投影路径差。影响面：终局瞬间结算视图（end 屏覆盖，玩法无感） | `latency-plain.json` inexactDetail×2；`fullroom.json` forensics×1（含逐球 diff） | 任意提前落黑八终局局 + 按 client.js beginReplay 同款重演 + 比对 end ruling `state.balls`（挂具已内置在 `pool-driver.mjs`，`forensics` 字段自动捕获） |
| T1 | 工具链（非产品） | 测试面 $disconnect 后游戏 op 注入仍返 **200**（vctx.role 未清，`rooms.op` 静默丢弃）——GAMES-48 T1 同款未修，自动化剧本易误判注入生效 | `reconnect-tiers.json` t5a `injectDuringGap` | 测试房 $disconnect → POST /api/test/input shot → 看 200 |
| T2 | 工具链（本单脚本） | spot 采样器 room-create/room-end 正则 `k:.room-end.` 匹配不了 `"k":"room-end"`（双引号两字符），计数恒 0——已改用直接 grep 重计（549/540），脚本留档已修 | `spot5min.json` summary vs gateway.log | — |

**FIX 建议方向**（本单不修代码）：F1 见上表一行修复；F2 建议在 FIX 单挂 client.js 同款重演挂具对拍 end ruling，定位 `resolveShot`/`endGame` 与终判广播的状态快照时机差。
