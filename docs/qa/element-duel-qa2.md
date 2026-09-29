# 元素对决 QA 二号报告（element-duel-qa2 · 联机红线专项·预算版）

> 单据：GAMES-93（[QA·E6-W1-T5] 元素对决 QA二号（延迟/重连/旁观·预算版）单链 7/10+，attempt 0）
> 对象：`games/multiplayer/element-duel/` + `server/gateway/`（前置链 DEV/QA1/FIX/BOT/FEEL 已合入 main）
> 立场：**独立复测**——不采信任何自测，以下全部数据为本单亲测采集；只测不改代码（本文件为唯一仓内交付物）。
> 环境：feature/GAMES-93（先 `git merge main`，Already up to date @ f24e842）。
> **测试网关**：:4487 专用实例（`PORT=4487 GATEWAY_PID/GATEWAY_LOG 改道`，起前 `lsof` 验空；常驻 :4400 全程零触碰）。
> 工具：GAMES-48/83 同款零依赖 RFC6455 WS 客户端（帧解析复用 `server/gateway/lib/ws.js`）+ 单向 100ms×2 延迟代理
> + element-duel 驱动器（只依据个性化视图 + sim 常量出 op，服务器权威校验，reject 计入协议面）+ Playwright 双页/旁观探针（私有静态服 :48130 + 私有网关 :4489，与主取证零互扰）。
> 证据目录：`/Volumes/BigDisk/Studio/kernel/workers/GAMES-93/`（qa2-main / qa2-fix / qa2-fix2 / t4-longrun / t3b-browser / spot5min 六 JSON + 网关全量日志 gateway.stdout + 截图 ×3 + 脚本 7 份）。
> 执行日：2026-09-29 15:16–15:52，**专项墙钟 ≈23min（脚本实测 t1 77.5s + t2 99.8s + t3 79.9s + 补证两轮 ≈150s + 5min spot 采样与主线并行）**；端到端含报告落笔略超 25min 预算，超因=pick 期新鲜房两跑均赶上 mulligan、旁观对齐切窗口径重跑一次（见 §6-T2）。

**总裁决：延迟/重连/旁观/长局/feed 五面红线全部 PASS；200ms 回合制天然容忍论成立（ack=RTT 且零延迟偏置）。红线退回项 0**；观察项 2（§6）+ 工具备忘 2。GAMES-84 F1 修复（abandon 锚=最后在场时刻）在本作复验通过（§2 在场>15s 臂）。

---

## 1. 200ms 模拟延迟（可玩性 + 回合制容忍论证实证，3+3 局）

**注入方式**：本地 TCP 延迟代理（客户端⇄代理⇄网关，每方向固定 100ms ⇒ 往返 ≈200ms；同延迟定时器 FIFO 保序，GAMES-48/83 同款）。测试面假时钟无法注入网络延迟（API 虚拟会话无网络路径），对照局全部走真 WS 会话。

**对照设计**：双臂同剧本——各 3 局真 WS 对 bot（feed 挑本作纯 bot 房 takeover 入席），驱动器走完整相位（pick→mulligan keep 全真→play 期每回合：最廉可付随从进场 + 无目标法术 + 远程打脸 + endTurn），打满 4 个己方回合后认负收束。

| 指标 | plain（直连） | delay（RTT 204ms） | 判定 |
|---|---|---|---|
| 局数/收束 | 3 局全 resign（4 回合/局） | 3 局全 resign（4 回合/局） | ✅ 同通道收束 |
| op→ruling ack p50 | **1ms**（p95 2，n=19） | **204ms**（p95 205，max 206，n=32） | ✅ ack≈RTT+ε，零额外排队 |
| 协议错误/断言错误 | 0 | 0 | ✅ |
| reject（驱动器启发式目标域） | 0 | 3（play/attack 目标域外，服务器正确拒绝） | ✅ 拒绝即回执，无死牌 |
| Bot 事件量/局（行为无偏置） | 21 / 27 / 22 | 20 / 28 / 31 | ✅ 同分布——bot 拟人延时=相位内相对 tick 门控（`BOT_DELAY`），与到达延迟解耦 |
| room.duel 版本护栏 | 6/6 welcome 声明 `element-int-v1#1028311539` | 同左 | ✅ 与 GAMES-91 冻结口径一致 |

**回合制容忍论证实证**：①op 受理链路 ack=204ms，占 30s 回合预算 **0.68%**——回合制无连续输入流，ack 时延不进入玩法节奏；②S5 零快照流：ruling 即附**全量个性化 state**（无预测/无重演），服务端单权威，延迟只平移到达、不存在失同步通道；③回合归属/计时器（timerMs 由服务端 deadline 推导）全部权威侧。**结论：200ms 往返下可玩性无损，胜负面零延迟依赖；bot 对局零延迟偏置。** 证据：`qa2-main.json` t1（六局逐局 acks 样本、事件计数、房号）。

## 2. 断线重连三档（5/10/30s）+ pick/mulligan 期特例 + 在场>15s 臂

方法：真 WS 探针（join→掉线 closeHard→`join{resume:{seat,token}}`），网关日志（`gateway.stdout`）逐房对拍 join/reconnect/seat-bot/room-end 时序——**席位恢复、托管转换、abandon 均以日志为地面真值**。恢复正确性判据=复席 welcome 视图与断线前最后 ruling 视图逐字段比对（手牌牌面/场面/坟场/牌库数/HP/回合归属/相位）。

| 档 | 场景 | 实测 | 判定 |
|---|---|---|---|
| **5s** | 己方回合打一张进场后断 5.0s | 复席 @**5054ms**（日志 `reconnect`，无 `seat-bot`）；welcome 视图**全同**（handEq/boardEq/deckN 6=6/graveN 7=7/hp 7=7/turn 仍=己）；复席后 endTurn **1ms 受理** | ✅ |
| **10s**（窗内 9.6s） | 断 9.66s 复席 | 日志 `reconnect`（未托管）；席位 human 保持；视图**全同**（handEq/boardEq/deckN 11=11/graveN 0=0/hp 24=24） | ✅ |
| **10s**（超窗 10.66s） | 断 10.655s | 日志：`seat-bot`@**掉线后 10.65s**（=RECONNECT_MS 10s+1 拍宽限 10ms，确定性命中）→ 席位转 **Bot·托管（level=hosted**，META.takeOver）；复席连接 resume 拒（token 已清）→ **按新加入走让位路径**（日志记 `join takeover` 非 `reconnect`）→ **拿回原席**（对席 bot 席号小，让位取最大 bot 席=原席）；复席后视图现时正确（托管期己方回合已被代打交回，turn 1→0 如实） | ✅ 托管+复席归还双证 |
| **30s**（§3 满员房，有人锚房） | p1 断 32.06s（p0+旁观在场，abandon 短路） | `seat-bot`@**10137ms**（level=hosted）；托管期 **8 次代打 op**（play/attack/endTurn 事件流）；p1b 复进 → **拿回原席 0**，名册回 human | ✅ |
| **30s**（独玩家房，无人锚房） | 在场 **22s** 后断线 | 卡片于 **15172ms** 消失（日志 `seat-bot`@+10.1s → `room-end abandon draw`@+15.4s）；再连 = **room-gone** | ✅ 语义如实：托管先行、15s abandon 兜底——**GAMES-84 F1 修复（abandon 锚=最后在场时刻，非入房时刻）在本作复验通过**（在场 22s 掉线不再是即刻蒸发） |
| **pick/mulligan 期特例** | 新鲜房（BotHost 补房）入席即断 | mulligan 期：断 **7054ms** → 复席同席、phase=mulligan、**手牌逐张还原含 X0 微粒**（`["N1","FS1","N4","N2","X0"]`），keep 全真受理 → 到 play（turn=0/mana=0/deckN=16 自洽） | ✅ |
| pick 期（未单独取证） | 两跑均赶上 mulligan（bot 席 1.5–2.5s 已代选、10s pick 窗极窄） | resume 分支与相位无关（`rooms.join` 同一代码路径，welcome.phase 直读 st.phase）；QA1 A5 测试面 `$disconnect/$reconnect` 已证同路径 | ⚠️ 如实披露，见 §6-T1 |

- 复席机制=token+席位校验（`rooms.js:98-110`）；超窗不降级为顶号（resume 拒绝后走让位，pool QA2 F2' 同口径）。托管档=**hosted**（牌风化 balanced 续打，§5.4）而非 balanced，实测代打行为正常收回合。
- 断线期"账本停记"再次印证（GAMES-48）：托管代打活性经对席/旁观连接的 ruling 事件流与网关日志取证。
- 附注（设计内现象）：pm 探针房未认负即离场 → +9.2s 托管 → +15.4s abandon——与 30s 档同语义。证据：`qa2-main.json` t2 + `qa2-fix.json` pickMull2 + `gateway.stdout` 时序对拍（房号 bm662b06f6 / c4p52ga516 / cfza2m3bcb / ctpw2p90b9 / denl2vf27f / kuab4j6382）。

## 3. 满员旁观（2 席满 + 第 3/4 连接；F2 修复后渲染验证 + ruling 流对齐）

序列：新鲜房 p0+p1 双真人入席 → pick → mulligan → play → spec 以 `mode:'spectate'` 入 → p3 以 `mode:'play'` 撞满员 → p1 断 32s（托管→让位归还，§2）→ p0 认负收束。浏览器面（Playwright 三 context 双席+旁观页）独立复跑渲染验证。

| 检查 | 实测 | 判定 |
|---|---|---|
| 满员转旁观 | p3 play 模式撞 2/2 满员 → welcome `role=spectator`（非拒绝） | ✅ |
| **观战双隐藏（迷雾）** | spec 视图 `hand={"0":{"n":3},"1":{"n":4}}`——两侧均只张数不见牌面（观战视角 §5.3） | ✅ |
| **F2 修复后渲染（浏览器面）** | A/B/C 三页 **pageerror 全 0**；C 页 `seat=-1`、phase=play 渲染正常、观战 4s 后仍稳定（bot 期 ruling 持续到达零异常）；截图 `t3b-spectator-C.png` / `-late.png` / `t3b-player-A.png`（53–86KB 非空帧） | ✅ GAMES-90 F2（seat=-1 渲染死）不复现 |
| 旁观输入禁用 | spec 发 `op endTurn` → 网关 role≠player 静默忽略，连接无异常、视图无变化（客户端侧另有观战零输入防线） | ✅ |
| **ruling 流对齐（同帧观战红线）** | 四旁观连接（含满员转旁观众）**frame≥480 共同窗内 28/28/28/28 条逐字节全同**（frame|事件|turn|相位四元组）——零单侧帧、零乱序 | ✅ |
| 托管/让位循环 | 见 §2 30s 档（seat-bot@10.1s → 8 次代打 → 复进拿回原席 → 名册 human） | ✅ |

证据：`qa2-main.json` t3、`qa2-fix2.json` specAlign、`t3b-browser.json` + 截图 ×3。

## 4. 长局稳定性（5 分钟 spot + 疲劳/maxTicks 保底 + QA1/BOT 交叉引用）

**多房 spot（15:21–15:26，与全部主线负载同窗）**：网关 6 游戏混合负载 11–12 房滚动（element×2 常驻 + 本单 51 间 element 房建/收 churn）——RSS **67376→73696KB（+6.3MB/4.5min）且非单调**（中途回落 65360KB），uncaught=0、room-error=0；实例全生命周期（15:16 起 ~35min）**172 次建房/161 次终局、0 uncaught、0 room-error**；element 房终局分布 lethal 35/resign 11/abandon 2/timeout 1（bot 对局 1–3min 自然收束，BotHost 补房闭环正常）。无泄漏直接证据（增速<10%、房间计数稳态、零错误），增速高于 pool QA2 口径（+768KB/5min）归因于 element 房 churn 快 + ruling 全量态消息更重，**留 STRESS 单二段复跑复核**（§6-O2）。
**maxTicks 保底边界**：测试房 timeScale=8、maxTicks=6000 → 终态 `tick=6000` 恰命中、reason=**timeout**、24/24 同血 → **draw**、quip+reveal 投影齐全——硬顶"HP 高者胜/平"落地（§1.7）。48000 满额档（8x）先被 lethal 终局（tick 10532）——保底不抢自然终局，语义正确。
**疲劳递增**：离线同源 sim 直驱（brain vs brain，25 回合、9998 tick）——席 1 牌库打空后 fatigue 事件 **n=1,2,3,4,5 严格递增**（首伤 tick 4286，累计 1+2+3+4+5=15 伤害），并参与致死（heroHp 过冲 -1，终局 lethal、胜方 fatigue=0）——**疲劳递增数（scoring.s3）与疲劳致死路径实测成立**。
**交叉引用**：①QA1（element-duel-qa1.md）：api-check 21/0（FIX 后 GAMES-90 冻结口径 24/0）、确定性四口径（3 seed 离线双跑+回放==在线）、perf 三窗 60fps/0 jank；②BOT 单（GAMES-91）：五支柱 40/0、三档反应梯度 4.4→6.0、ENGINE_HASH #1028311539——本单在线 6 局 welcome 逐房复核 hash 一致；③FIX 单（GAMES-90）：F1 反应表/F2 观战/F3 debug 契约——本单 §3 浏览器面零 pageerror 复证 F2。**结论：长局无泄漏证据、确定性/版本护栏与本单在线路径互洽。** 证据：`spot5min.json`、`t4-longrun.json`、`qa2-fix2.json`、`gateway.stdout`。

## 5. feed 联动（全生命周期卡片正确性 + 时延 ≤5s）

250ms 轮询（§3 全程），迁移逐条记录（18 条 element 迁移）：

| 生命周期迁移 | 触发→feed 可见 | 红线 ≤5s |
|---|---|---|
| 双真人满员（humans 0→2，joinable→false） | 入席 → **253ms** | ✅ |
| 旁观加入（spectators 0→1→2） | welcome → **<253ms**（同拍采样） | ✅ |
| 托管转换（humans 2→1 / bots 0→1 / joinable→true） | seat-bot 广播 → **≤250ms** | ✅ |
| 让位归还（humans 1→2） | 再进 join → **≤250ms** | ✅ |
| 终局→卡片消失（resign 收束） | room-end → **~1s**（ended 不见客+下一拍轮询） | ✅ |
| 房间创建（BotHost 补房） | onEnded→ensure → 新纯 bot 房卡片 **≤250ms**（窗内 4 间新建实证） | ✅ |

卡片字段全程与真态一致（humans/bots/spectators/joinable）；**测试房未见于任何 feed 采样**（matches() 的 test 排除同一路径，QA1 A1 同口径）。**全档实测 ≤1s，远低于 5s 红线。** 证据：`qa2-main.json` t5.transitions / allTransitions。

## 6. 退回项清单与观察项

**红线退回项：无**（§1–§5 红线全 PASS）。

| # | 级别 | 条目 | 证据 | 说明/复现 |
|---|---|---|---|---|
| O-1 | 低（产品裁量，非缺陷） | **takeover 继承 bot 已作决策**：BotHost 纯 bot 房在 pick/mulligan 期被真人接管时，席位此前的 pick/keep 由 bot 代作（实测入席即 mulligan、heroUnchosen=false）——10s pick 窗内晚入的玩家失去英雄选择权 | `qa2-fix.json` pickMull2.phaseAtJoin | 新鲜房创建后 1.5–2.5s 内 bot 已选；quick-match 语义下可接受（牌局不等人），若要保留选择权需让位时重置相位（改动面大，不建议本链动） |
| O-2 | 低（留 STRESS 复核） | 高 churn 下 RSS +6.3MB/4.5min（非单调、零错误、房间稳态）——element 房 1–3min 快速建/收 + ruling 全量态消息，增速高于 pool 口径 | `spot5min.json` | 无泄漏直接证据；建议 STRESS 单做二段复跑（平台稳定性硬判据） |
| T1 | 工具链（本单） | **pick 期重连真 WS 未单独取证**：两跑新鲜房均赶上 mulligan（bot 代选+10s 窗窄）；resume 路径相位无关 + QA1 A5 同路径已证，风险低 | `qa2-fix.json` | 复现需 room-live 后 <2s 入席（BotHost 补房瞬间） |
| T2 | 工具链（本单） | 旁观对齐首跑 ts 切窗把"到达时差"误计入序列（nPerConn 28/29/31/31 假不等）——改 frame≥F 共同窗后 28/28/28/28 全同；已留 `t-fix2.mjs` 正确口径 | `qa2-main.json` t3.align（作废）vs `qa2-fix2.json` | 后续同型断言一律按 frame 窗，不按墙钟 ts |

**FIX 建议**：无（本单无产品缺陷退回）。O-1 建议产品侧裁量后在设计书备注，O-2 并入 STRESS 单口径。
