# 指挥官战场 QA 二号报告（slg-battlefield-qa2 · 联机红线专项）

> 单据：GAMES-48（[QA·E6-W1-T1] 指挥官战场 QA二号 · 延迟/重连/满员/长局专项，单链 7/10+，attempt 0）
> 对象：`games/multiplayer/slg-battlefield/` + `server/gateway/`（前置链 D/DEV/QA1/FIX/BOT/FEEL 均已合入 main 的交付物）
> 立场：**独立复测**——不采信任何自测，以下全部数据为本单亲测采集；只测不改代码。
> 环境：feature/GAMES-48（先 `git merge main`，Already up to date @ ba15f7f）。
> **零感知纪律**：常驻 :4399/:4400 全程未触碰（验活前后各一次，pid 12785 存活、rooms=5）。全部专项跑在**专用网关 :4410**
> （HOST=127.0.0.1，`GATEWAY_PID`/日志改道证据目录，网关代码与分支字节一致），BotHost/测试面/feed 与常驻实例完全同构。
> 工具：自研最小 RFC6455 WS 客户端（帧解析复用 `server/gateway/lib/ws.js` 单一事实源）+ 单向 100ms×2 延迟代理；
> 游戏驱动器与真客户端同款行为（帧驱动本地镜像 sim 逐步、缺帧 `sync`、input delay=1、每 2s ping/pong）。
> 证据目录：`/Volumes/BigDisk/Studio/kernel/workers/GAMES-48/`（JSON 11 份 + 网关全量日志 + 脚本 8 份）。
> 执行日：2026-09-27。

**总裁决：联机红线专项全部 PASS，无红线退回项。** 200ms 延迟下可玩、胜率无偏置；三档断线重连行为与设计书/协议一致；满员旁观+两轮让位循环稳定；长局三跑无泄漏证据；feed 全生命周期 ≤5s（实测 ≤1.3s）。附 3 项低危质量发现 + 1 项工具链建议（§6，均建议开 FIX 单酌情处理，不阻塞）。

---

## 1. 200ms 模拟延迟（可玩性评估 + 胜率对照 ≥6+6 局）

**注入方式**：本地 TCP 延迟代理（客户端⇄代理⇄网关，每方向固定 100ms ⇒ 往返 ≈200ms）。代理自证：经代理 ping/pong RTT p50=**205ms**，直连 p50=**1ms**。测试面假时钟 timeScale 不适用于延迟注入（API 虚拟会话无网络路径），故对照局全部走**真 WS 会话**。

**对照设计**：双臂同剧本——macro-push 策略（api-check 注册表同源）驱动真 WS 玩家，经 feed 挑本作 BotHost 常驻纯 bot 房 takeover 入席（seat3/队B，对局配置恒 balanced/casual/balanced，seed 随房间派生），打到终局。plain 臂直连、delay 臂经代理；每臂 6 局、2 并发，共 **12 局**。

| 指标 | plain（RTT 1ms） | delay（RTT 204ms） | 判定 |
|---|---|---|---|
| 完赛/胜率 | 6/6 完成，**6 胜 0 负** | 6/6 完成，**6 胜 0 负** | ✅ 胜率无偏置 |
| 终局方式 | score×6 | score×6 | ✅ 同通道 |
| 终局 tick 均值 | 1307（1260–1510） | 1280（1260–1330） | ✅ 差 2%（seed 方差内） |
| 单局墙钟 | 126–130s | 127–131s | ✅ 节奏不受延迟拖累 |
| 帧到达抖动 p50（相对帧时间线） | −43…+48ms | −44…+26ms | ✅ 跨臂同分布：代理只加常量平移、零抖动 |
| 注入→权威帧回显 p50 | **205ms**（p95 208，≈2 tick） | 直测 **306/409ms**（RTT+1~2 tick）；插桩局快路径 p50 **207ms**（=RTT+ε，回显滞后 1–3 tick 占 23/44） | ✅ 见下"回显时延说明" |
| 敌方 barrage 预警事件 | 14 次 | 12 次 | ✅ 见下"预警圈反应窗" |

**回显时延说明**：delay 臂汇总脚本 p50 出现 ~5s 长尾，经插桩局（`diag-delay.json`）+ 确定性微实验（`echo-sem.json`，测试面逐帧账本）定位为**诊断器对重复发送的 FIFO 误配对**（延迟臂镜像滞后 2–3 帧 → 策略重复发同一 cmd → 旧 pending 被后续同型回显晚配），非服务端时延：微实验证明每条注入 ≤2 帧内必回显（预约帧路径 1–3 tick），真实时延分布 = RTT + 0~2 tick。设计 §5.4"帧确认 ≤3 tick"在注入侧成立（plain 2 tick；delay 2 tick + RTT）。

**预警圈反应窗（Barrage）**：敌方施法事件到达滞后（锚点校正后）p50 = 5ms（plain）/ 11ms（delay），均 <1 tick——**延迟平移整条帧流而不改变预警圈与落弹的相对时序**（BARR_STAGGER=2：三连弹在施法帧 +0/+2/+4 tick，同帧流下发）。反应成本=反制指令回传单向 100ms + 人反应 250–400ms ⇒ 技能层反制（repair 预读/规避入场）预算 ≈1000−100−400=**500ms+，充裕**；本作无单位级微操 dodge（车道制 1D + 25px 格），预警圈的信息职能在 200ms 下不受损。自施法预警为本地输入即时（client.js spawnWarn 领先权威 1–2 tick），不受网络影响。

**可玩性结论：200ms 往返延迟下可玩。** 输入→权威确认 306–409ms（宏观 RTS 感知为"出兵慢半拍"，本地乐观表现即时）；帧流平稳无抖动；胜率 6/6 vs 6/6、终局 tick 差 2%，**无延迟偏置**。证据：`latency-plain.json`、`latency-delay.json`、`diag-delay.json`、`echo-sem.json`。

## 2. 断线重连专项（5s / 10s / 30s 三档）

方法：测试房（`/api/test/*`——与 WS 会话逐字节同一条 RoomManager 代码路径）ts=2 假时钟 + 真 WS 探针（T3 真房）；seed 钉死 20260948。**重同步正确性采用确定性复验**：welcome.state + 其后账本帧输入在本地经同一份 sim.cjs 逐步重放 N tick，与服务器真值 serialize **逐字节比对**。

| 档 | 断线期实测 | 复席结果 | 判定 |
|---|---|---|---|
| **5s**（活跃局：3 balanced bot 交战中） | 席位 kind=human 保留 ✅；期间注入返回 200 但被服务端静默丢弃（vctx 会话伪造面 artifact，真 WS 断线无发包可能，见 §6-T1） | `$reconnect` 200，resume=**5005ms**；welcome 全量 state 下发；**重放复验 identical=true**（welcome@tick118 重放 36 tick 至服务器 tick154，serialize 2576 字符逐字节一致）；复席后继续续玩（见下探针） | ✅ |
| **5s 冻结对照局**（全空席，仅时间驱动字段演化） | 同上，席位保留 | resume=5010ms；重放复验 identical=true（1214 字符）；units 与断线前**同 id 同存活** | ✅ "与断线前一致"的字面验证（cp/energy/tick 按收入速率前进，无任何状态回滚/错乱） |
| **10s（窗内 9.6s）** | +5s 时刻席位仍 human | `$reconnect` 200，resume=**9606ms** <10s，席位 human 未托管 | ✅ 10s 红线窗内复席续玩 |
| **10s（超窗探针）** | **+10064ms 托管转换**：kind=bot、level=**casual**、name=**Bot·托管**（=META.takeOver，设计 §5.3"逾时席位转 bot 托管（casual 档）"✅） | `$reconnect` → **409 resume-rejected（token/席位不符或已托管）** ✅ 复席语义不降级为顶号 | ✅ 边界行为正确 |
| **30s** | +10.6s 托管（casual）即刻接管决策：state.seats[0].spawned 1→2（托管 bot 出兵实证；真房更强证据见 §3：20s 窗 12–16 条 cmd 含 spawn）；**单真人房 +15s 全无连接 → abandon 终局（draw）+8s 回收** | +30s `$reconnect` → **409 room-gone**（房已回收）。SDK 侧行为（代码走查+协议一致）：net.js 以 BACKOFF [0.5,1,2,4]s 携 token 重试至 10s → status=lost → client.js 兜底横幅（§6-F3）；**真人再进**（新连接 join，旧 token resume 落入新加入路径）→ bot 让位接管**拿回原席**（§3 r1 seat3 / r2 seat2 实测归还） | ✅ 如实记录，对照设计书一致 |

**复席续玩闭环探针**（`resume-play.json`）：断线前 spawn(inf,lane0) 落地 → 断 2.0s（席位 human、CP 仅按收入 +0.4 无人代花）→ 复席 welcome → spawn(inf,lane2) 落地：spawned 0→2、己方 units=[lane0, lane2] ✅。

**30s 超窗实际行为小结**（对照设计书 §5.3/§5.4——重连窗与托管语义定义在 §5.3，§5.4 为输入缓冲）：房内无人 → 托管 bot 打完全场；房内全无连接 15s → abandon 关房（draw）；有人再进 → 让位归还。三种分支均与协议 §2/设计书一致，无"降级为观战"之外的未定义行为。附发现：abandon 终局 `result.scores` 填的是 kills 对象（rooms.js:226，§6-F2）。证据：`reconnect-tiers.json`、`probe30.json`、`resume-play.json`、`echo-sem.json`。

## 3. 满员与旁观（4 真人 + 第 5 连接，让位循环 ×2）

方法：真 WS 连接 ×5 在**真房**（BotHost 常驻房，非测试房）；4 真人依次加入（bot 让位序 seat3→2→1→0 与协议 §2"优先 seat 最大的 bot 席"一致），第 5 连接 spectate。

| 检查 | 实测 | 判定 |
|---|---|---|
| 满员 feed 卡片 | humans=4 / bots=0 / spectators=1 / **joinable=false**，welcome 后 <1s 可见 | ✅ |
| 5 连接帧对齐 | 10s 窗内 5 连接帧号流完全一致（全部推进至 frame 138；各连接起始帧差=入房时间差，符合语义） | ✅ |
| 旁观全程稳定 | 整场（75s+）帧连续接收、无 close/error、end 消息正常到达；旁观席不占席 | ✅ |
| **让位循环 r1**（p1/seat3 退出） | 退出 → 席位保留窗内 feed humans 仍=4 → **+10041ms** 托管转换（Bot·托管/casual，seat 广播到达其余 4 连接）→ feed humans=3/bots=1 **+50ms** → 托管 bot 20s 活性：**12 条 cmd（rally）** → p1b 再进 join → **拿回 seat3**（唯一 bot 席让位）→ feed humans=4 **+283ms** | ✅ |
| **让位循环 r2**（p2/seat2 退出） | **+10030ms** 托管 → feed humans=3 **+343ms** → 托管 bot 20s 活性：**16 条 cmd（rally×12 + spawn×4）** → p2b 再进 **拿回 seat2** → feed humans=4 **+159ms** | ✅ |

托管 bot 行为合理性：casual 档接管后持续决策（rally 集结 + spawn 出兵，间隔符合 casual 节奏），复席即归还（bot→human 就地转换、名册广播）。两轮循环全程 5 连接零协议错误。证据：`fullroom.json`（含 400ms feed 采样流）。

## 4. 长局稳定性（≥15 分钟局内时间 ×3）

口径：api 剧本 `maxTicks=9000`（=15 分钟局内时间）× `timeScale=8` 假时钟（帧内容与真人房同构，协议 §8.1），每跑 125s 墙钟、tick 0→9000 跑满至 timeout 终局；5s 采样网关 RSS（ps RSS）/tick 漂移/事件账本游标。会话级背景：专用网关全程 BotHost 真房滚动（net-tank 5–8s 快轮换 + slg 满时长局）。

| 跑 | 墙钟 | 终局 | RSS 前→后（KB） | ΔRSS | tick 漂移（全程 min/max） | 账本游标峰值 |
|---|---|---|---|---|---|---|
| run1 | 125s | timeout@9000 ✅ | 64000→72064 | **+8064** | **[−4, 0]** | 8192（封顶） |
| run2 | 125s | timeout@9000 ✅ | 72064→76416 | **+4352** | **[−5, −1]** | 8192（封顶） |
| run3 | 125s | timeout@9000 ✅ | 76416→77520 | **+1104** | **[−2, +2]** | 8192（封顶） |

- **tick 漂移**：9000 tick 内 |drift| ≤5 tick（ts=8 下 62.5ms 墙钟、0.06%）——定频推进的固定节奏记账无累积漂移（末样本 −248 为终局后 tick 冻结的统计口径产物，已剔除）。
- **事件日志增长曲线**：账本游标 80.6 条/s 线性增长至 **8192 后平坦**（环形截断按设计生效，MAX_LOG 不扩容）；run 内 RSS 抬升集中在分配首次触达段，后段走平（run1 后 40s 仅 +3.2MB；run3 全程 +1.1MB）。
- **无泄漏判据**：①单跑 RSS 后段走平；②跨跑增量单调收敛 8.0→4.4→1.1MB（V8 堆首次触达+GC 平台，非线性增长）；③房间计数 5→5 回落（39 次终局/回收循环后）；④`uncaught`=0、`room-error`=0（全量网关日志 161 房创建/151 终局）；⑤账本环形截断不增长。**结论：无泄漏证据，PASS**。
- 会话级：专用网关累计 RSS 64000→77520KB（含 39 个房间的创建/终局/回收循环 + 全部专项测试负载）。证据：`longrun.json`（含每跑逐 5s 采样序列）。

## 5. feed 联动（本作房间全生命周期卡片正确性 + 时延 ≤5s）

方法：真房全生命周期，400ms 轮询 `/api/matches`，与网关日志 `room-create`/`room-end` 时戳交叉验证。创建可见性用"旁观占位全部纯 bot 房 → pureBot<minLive 触发 BotHost 补房"的真实补房路径（顺带覆盖 BotHost 上线节奏）。

| 生命周期迁移 | 触发→feed 可见 | 红线 ≤5s |
|---|---|---|
| **房间创建**（BotHost 补房，新房卡片 humans=0/bots=4/joinable=true） | 占位 → **1221ms** | ✅ |
| 1 真人加入（humans=1/bots=3） | welcome → **3ms** | ✅ |
| **满员**（humans=4/bots=0/**joinable=false**，4 连接角色全 player） | 末位 welcome → **356ms** | ✅ |
| 第 5 连接旁观（spectators=1，role=spectator） | welcome → **3ms** | ✅ |
| 全员退出 → abandon 终局（draw，策略时延 15s=ABANDON_MS 语义非 feed 时延） | **room-end → 卡片消失 245ms** | ✅ |

卡片字段全程与真态一致（humans/bots/spectators/joinable/elapsedMs；§3 的托管/归还迁移同样 ≤400ms 跟随）。测试房隔离（不进 feed）已在 QA1 A1 验证、本单测试房全生命周期未出现在任何 feed 采样中。证据：`feed.json`（含网关日志时戳交叉）、`fullroom.json`。

## 6. 退回项清单与 FIX 建议

**红线退回项：无**（§1–§5 全部红线 PASS）。

**质量发现（非红线，低危，建议 FIX 单酌情处理）：**

| # | 级别 | 条目 | 证据 | 复现步骤 |
|---|---|---|---|---|
| F1 | 低（协议语义） | 离散 cmd"一次性语义"非严格一次：`input()` 同时写 pending 与 lastInput → 带 frame 预约的注入经 lastInput 通道**提前执行**（实测目标帧 3、实际执行帧 1），预约帧再到时**二次执行**（同一注入 spawned×2，后续重复被 spawnCd/CP/cd 门控拦截）。真客户端 input delay=1 恒带 frame，每条 cmd 恒走双通道；因各 cmd 自身门控（spawnCd 2 tick / 技能 cd 200+ / research 单次 / rally 幂等），实际错误结果未出现（A2/A3/确定性重放均不受扰），但语义与设计 §5.1"一次性"表述不符 | `echo-sem.json`（逐帧账本：注入 3+3 条、回显帧 1/2/4/5/6/19/20、spawned=2） | 测试房 `[null,null,null,null]` ts=1；注入 `spawn {inf,lane:1}` 3 条（frame=当前+3..+5，间隔 60ms）→ 观账本：帧 1 即执行 + 预约帧再执行 |
| F2 | 低（表现） | abandon 终局 `result.scores` 复用的是 `state.kills` 对象（`finish(room,{winner:'draw',scores:{...room.state.kills}...})`），协议 §4.2 的 scores 语义（积分）被kills 冒充——结算页分数显示口径错误（本作正常终局无此问题） | `reconnect-tiers.json` tier30；gateway log `room-end reason=abandon`（scores={A:3,B:2}=击杀数） | 建单真人房 → 断线 15s → abandon → 读 result.scores |
| F3 | 低（UX） | 10s 重连窗耗尽后客户端兜底文案"对局已结束"（client.js onError reconnect-timeout → fallbackOffline）——实际对局仍在（托管 bot 续打，再进可拿回席位），文案误导玩家放弃重进 | client.js:1006-1008；net.js:160-168（BACKOFF→lost）；§3 r1/r2 再进归还实测 | 真房中玩家断网 >10s 观察横幅；建议文案改"连接已断，可重新进入对战"或提供一键重进 |

**FIX 建议方向**（本单不修代码）：F1 在 `rooms.input()` 中当 `f` 落入预约窗时跳过 `lastInput` 写入（或 doFrame 消费 pending 后同步清 `lastInput.cmd`）；F2 abandon 分支改传 `{...state.score}`；F3 区分 reconnect-timeout 与 room-gone 文案。

**工具链建议（不阻塞交付）：**

| # | 条目 | 说明 |
|---|---|---|
| T1 | 测试面断线期注入返回 200 | `$disconnect` 后 vctx.role 仍为 'player'，游戏 op 注入返回 200 ok 但被 `rooms.input()` 静默丢弃（room=null）——API 观测面语义瑕疵（真 WS 断线不可能发包，非产品缺陷）。建议 `$disconnect` 时置 role=null 或注入预检返回 409，避免自动化剧本误判注入生效 |
| T2 | BotHost 补房判定含 spectators | pureBot 判定 `spectators===0`：旁观占位即触发补房（本单 §5 利用此行为验证创建时延，属正常语义）；报告备忘，供后续泳道测试设计参考 |
