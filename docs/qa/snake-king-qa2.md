# 蛇王争霸 QA二号（联机红线·预算版）——GAMES-104

> 单链 7/10+（FEEL=GAMES-103 f5d1e35 后）。证据目录 `kernel/workers/GAMES-104/`（私口网关 :4414 从本分支起、:4399/:4400 零感知；脚本 qa2.mjs/phases.mjs，证据 t1-plain/t1-delay/freeze-ts3/t2-reconnect/t3-fullroom/t4-longrun 六 JSON + gateway.log）。
> 方法复用 GAMES-48 QA2 范式：真 WS 客户端（掩码帧+网关 parseFrames 同源）+ TCP 单向延迟代理（每向 100ms，FIFO 保序）；swarm 巨房 takeover 入席。

## 1. 200ms 延迟对照（3+3 局，真 WS·swarm 房 takeover）

| 臂 | RTT p50 | welcome | ack p50 / p95max / max（n） | 冻结窗 max | 增量均/全量均 | 全量占比 | 错误 |
|---|---|---|---|---|---|---|---|
| plain×3 | 0-1ms | 172-177ms | **55 / 102 / 209ms**（441） | **1 tick**(100ms)，1 例 | 656B / 8.9KB | ~1% | 0 |
| delay×3 | 204-205ms | 568-571ms | **253 / 309 / 362ms**（438） | **2 tick**(200ms)，9 例 | 661B / 9.7KB | ~1% | 0 |

- **ack≈RTT+1 tick 零排队**：delay 臂 p50 253ms = RTT 205 + tick 地板 ~50ms 中位；无超线性长尾（max 362ms < RTT+2tick）。快照帧零跳变（frameGapMax=1/tick 全程）、零 srv-error、两臂死亡/复活生态同分布（1/0 vs 0/1，5min spot 11/11 稳态）。
- **冻结窗判据**（「应在转而未转」：|权威角−指令角|>ω+1 且帧推进而角零步进）：plain ≤1 tick、delay ≤2 tick=恰为注入 RTT——延迟无排队放大/无死锁。
- **AOI 快照 ack 时延**（S6 验证点 A）：真房 10Hz tick=100ms 为自然地板——p50 55ms（<100ms 红线 ✓）；一局 p95 102/max 209 为 2-tick 尾（O-3，见 §6）。
- **timeScale=3+15ms 轮询冻结窗复验**（freeze 相，测试房 19 bot+API 席，tick 实测 33ms）：输入→ack p50=37ms（≈1 tick）/p95=62ms/max=184ms，inputOk 100%；「帧推进而 ack 不动」多为 1-tick 交替模式（O-2：疑 ack 构建时点与输入到达相位交错，非输入饥饿——真 WS 面 ≤1-2 tick 佐证）。QA1「timeScale=3 下 15ms 每 tick 两拍⇒输入冻结窗消失」在 ack 时延与冻结双口径下无反证。

## 2. 断线重连三档（真 WS resume）+ GAMES-84 abandon 锚

| 档 | 实测 | 结果 |
|---|---|---|
| 5s（全测） | 断 5177ms 复席 | **全绿**：同席复席（reconnect 日志）；welcome 全量重同步 **ents=201**；自身状态连续 n=12/sc=12/k2=0 且 path 在；首快照 full=1 带 `ext.aoi{r=422000,n=12}`+`ext.me`；帧续推 12076→12101 |
| 10s | gap=10479ms | 复席成功（窗=RECONNECT_MS+tickMs=10.1s，服务端侧落窗内；网关 reconnect 行） |
| 30s | 在场 20s 后断 | 超窗 → **seat-bot 托管**（网关日志 `seat-bot` 实锤） |

- **abandon 锚（在场>15s 臂）**：蛇王 swarm 房 `META.persistent`（§1.1 常驻竞技场）→ 无 abandon 通道：唯一真人（在场 20s>15s）离场后房间 45s 观察窗内**恒在 feed、恒 live/joinable**（+5s 在、+45s 在；GAMES-84 F1 若回归则 <1s 瞬消——未复现 ✓）。
- 席位生态对拍（网关日志）：`reconnect`（5s/10s 档）、`seat-bot`（30s 档托管）、`swarm-bot-leave`（真人入席让位）三类行齐。

## 3. 满员与旁观（24 连接序列 + 第 25 连接）

- 真人让位循环（swarm 生态位）：humans 4/8/12/16/20/21/24 ↔ feed bots 17/16/10/4/4/3/0——空位优先→bot 让位→calibrate 超员退场三机制均在 feed 可目击；满 24 后 `joinable=false`。
- **满 24+1 旁观**：第 25 连接 welcome `role=spectator`，旁观 8s 收 81 快照（10.1/s、帧 13705→13785 连续）稳定。
- 满 20 后第 21-24 真人继续入座（实体 21-24 ≤ cap.snake 24）——**设计 §2.1「seats=24 硬顶留拥挤余量」的有意口径**（20=bot 补员目标非真人帽），见 O-1。

## 4. 长局 spot（5 分钟单连接）+ feed 新鲜度 2 点

- 3002 快照（10.0/s）**零帧隙**（frameGapMax=1 tick）；死亡 11/复活 11 稳态循环；零错误零 srv-error。
- 网关 RSS 94272→103216KB（Δ+8.9MB/5min，温和非单调趋势待 STRESS 二段口径，参 GAMES-93 O-2）。
- feed 新鲜度两点：elapsedMs 616785→917100（Δ=300315ms≈5min 精确走表）、两点均可见且 joinable。
- **交叉引用不重跑**：QA1（GAMES-100）AOI 账本增量均 726B/全量占比 1.7%（红线 ≤850B/≤8%）、掉落公式 89/72/43 例全对、A6 排行榜全程 0 违例；BOT（GAMES-102）三档生态位+放水链（房内 deaths/kills 口径）。本单 t1 增量均 656-661B 与 QA1 726B 同量级（AOI 视野内蛇数波动内），互洽。

## 5. 红线判定

**五项全 PASS，红线退回 0。** 延迟容忍（ack=RTT 零排队+冻结≤注入 RTT）、重连三档+锚语义、满员旁观稳定、长局+feed、观察项如实记录于 §6。

## 6. 观察项（不构成退回）

- **O-1 满员口径**：满员=24 席（第 25 连接旁观），非「20+1」；20 为 swarm bot 补员目标。设计 §2.1 有意（留观战/拥挤余量），任务书措辞与实现差异提示 PM 裁量。
- **O-2 测试房 ack 交替模式**：timeScale=3 下「帧推进而 ack 不动」占 37%（541 推进/322 不动，多为 1-tick 交替+1 例 25-tick 疑死亡边界）——ack=seats[].lastSeq 收到即记，疑快照构建时点（帧首）与 HTTP 输入到达相位的节拍交错，非输入饥饿（输入→ack p50=1 tick）。留 FIX2/专项对拍 ack 构建时点。
- **O-3 WS 面 ack 尾巴**：真房 10Hz 下 p95 102/max 209ms=2-tick 尾，A4「<100ms」红线口径为 api-check 驱动面（15ms 轮询），WS 面 p50 55ms 达标；如需 WS 面硬红线建议按「≤2 tick」另立。
- **O-4 持久房无 abandon**：30s 档终态=seat-bot 托管+房恒 live（非 pool/element 的 room-gone）——设计 §1.1 常驻竞技场语义，abandon 锚在本作复验形态=「离场不瞬消」。

## 7. 工具备忘（本单踩坑，Article 素材）

`WsClient.send` 内部已 `JSON.stringify`，调用侧再 stringify=双重编码→服务端 `bad-msg missing t`（ping 亦中招）；采集器闭包捕获建时 seat 参数、后置 `col.seat` 需闭包内改读 `c.seat`；冻结窗判据须含「应在转」条件（对齐后角恒定≠冻结，首版假阳性 13-21t）。
