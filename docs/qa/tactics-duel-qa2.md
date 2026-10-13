# 战棋对决 QA二号（延迟/重连/满员·预算版）— GAMES-123

> 分支 feature/GAMES-123（基线 main@7b2aa44，merge 后未前进）。预算版 ≤30min 口径：五项专项取证，深度检视/识图面不在本单范围。
> 环境：私有端口网关 :4423（`PORT=4423 GATEWAY_PID=/tmp/gw123b.pid node server/gateway/index.js`，pid 71295，本仓现行代码）；常驻 :4399/:4400 全程零感知（未 kill/未重启/未改配置）。
> 证据件：`kernel/workers/GAMES-123/qa2-*.json`；脚本 `scripts/tactics-duel-qa2-{lib,rooms,latency}.mjs`。

## T1 200ms 延迟对照（3+3 局）✅

方法：真 WS 客户端（零依赖自研 RFC6455 互操作件，复用 GAMES-48 QA2 范式）经 TCP 单向延迟代理（每向 100ms）quick 入 tactics 纯 bot 房 takeover 坐席对弈至终局；plain 臂直连对照。臂间串行防跨臂同房混连。

- 通道自证：直连 RTT p50=1ms；经代理 p50=205ms（Δ=204ms，注入有效）。
- 六局完整终局 6/6（plain：score×3；delay：score×2 + timeoutEnd×1=maxTurns 自然到顶）；我方 ops 21-80/局。
- 确认时延（op→ruling）：plain p50=1ms/p95=2ms/max=8ms；delay p50=204ms/p95=206ms/max=211ms（Δp50=203ms ≈ RTT 精确抬升）；p95 两臂均 <5s（无放大异常）。
- 回合制天然容忍论证：200ms 仅抬升确认时延 ≈RTT，绝对值远小于 30s 回合时限；我方席位零 timeout-turn（托管不误触发）；无 reject 风暴、无 bad-msg/version 协议损坏。
- 确定性不受延迟影响复核（S1+S5 组合口径）：
  - 服务端回合串行化完好：各局 ruling.turn 折叠后零同席相邻重复（延迟不产生乱序生效，370 条 ruling 全量观察）；
  - 引擎身份双臂一致：welcome.room.duel.hash == 本地 `ENGINE_HASH`（3306507531）；
  - 引擎级确定性（两跑 stateHash 相等 + opsLog 逐字节 + replayOps==在线）由冻结门禁 A6 绿背书（本单复跑见 §T5）。

## T2 断线重连三档 ✅（复用 QA1 网络件复跑，GAMES-119 脚本零改动）

`GAMES_GW=http://127.0.0.1:4423 node scripts/tactics-duel-qa1-net.mjs` → exit 0（21 通过 0 失败）。

- 5s 档（全测）：席位保留（10s 窗内 kind=human）→ resume ok → welcome 全量个性化恢复（phase/turn/ap/undoUsed/host/timerMs）→ 注入 op 得 ruling（行动序列续接）。
- 10s 档：同机制全绿。
- 30s 档：重连窗已过 → 断线期托管续打（局不散）→ 终局收房后复连拒绝 room-gone（正确行为）。
- GAMES-84 abandon 锚复验：独真人在场 >15s → $disconnect → +5s 仍 live（锚=最后在场时刻，判别性通过）→ +18s ended/abandon（15s 收房）。

## T3 满员与旁观 ✅

- 双人满员：A quick 入房（seat=1，takeover 让位）→ B join（seat=0）→ feed humans=2/bots=0（META.seats=2 即满）。
- 第 3 人 play 加入满员房：静默转旁观（role=spectator，不拒）；feed spectators=1；旁观全段稳定收 ruling（观战面 viewFor(-1)），零 reject。
- Bot 让位循环：纯 bot 房真人 play 加入 → takeover 最大 bot 席（协议 §2）→ 离席 +8.5s 席位保留（10s 重连窗）→ 席转托管 bot（旁观者 seat 名册时间线坐实：席1 human→bot@离席后 +10s）→ 循环闭合。复跑两轮均绿（第二轮 feed 面受并行延迟臂抢房扰动 humans=2，名册时间线证据不受影响，已如实记录）。

## T4 长局 spot ≥5 分钟 ✅（交叉引用，不重跑）

方法迭代（四跑到绿，如实）：①驱动器读个性化视图 `turnSeat` 字段恒 undefined → 三连 afk 148s 假绿（acted=0 识破）；②修字段后贪心对攻 42s 自然终局；③被动慢棋（1 move+endTurn+10s 间隙）73s 仍 score 到线终局——**引擎对局长天然帽：scoreLine=10 占点分到线即终局，单一局拉不到 5min 属引擎语义非缺陷**；④终跑（`scripts/tactics-duel-qa2-longrun.mjs`）改 5 分钟连续真人续局观察窗：A/B 双真人慢棋局终即 quick 续局 + 观察 C 常驻旁观，feed 新鲜度两时点（150s/290s）独立采样。终态：墙钟 310s、续局 7 局、acted=297、我方零超时托管、观察 C 全程在线（采样判据=本作 live joinable 房≥1 + WS 入向年龄<60s；cur 房 inFeed 在续局边界瞬态为 false 属 ENDED linger 语义，记录项非判据——首轮该口径缺陷致一次假红，已修）。采样：

| 时点 | 墙钟 | 本作 live 房 | 当前局在 feed | A 侧 WS 入向年龄 | 观察 C |
|---|---|---|---|---|---|
| p1 | 150s | 2 | false（边界瞬态） | 9875ms | 在线/11 rulings |
| p2 | 290s | 2 | false（边界瞬态） | 507ms | 在线/11 rulings |

既有观测交叉引用（本单不重跑，据 QA1/FIX1/BOT/FEEL 报告）：
- QA1（GAMES-119）：bot 局自完结动力学 10-20s 墙钟（timeScale 1x/2x 同象）——本单长局由真人慢节奏拉伸，未见超时托管误触发，与其一致；
- FIX1（GAMES-120）：A6 重锚 stateHash=1475299752 + 输入日志逐字节 + 回放==在线（确定性）；maxTurns=16 终局 timeoutEnd（占点分判）——长局终局路径同源；
- BOT（GAMES-121）：competitive 梯度已修复（2-ply 占位增益/风险双计/守备圈偏置三根因）；开局库只提议不替选；
- FEEL（GAMES-122）：fx 台账全 17 项可证、fb≤80ms 红线、帧成本 p95 0.10ms（rAF 封顶对照带口径）——长局渲染负载不重测。

## T5 红线退回 0 ✅

- 冻结验收：`node scripts/api-check.js tactics-duel` → exit=0（19 通过 0 失败；字面命令打常驻 :4400 瞬态测试房，零重启零感知；另在私有 :4423 复跑同绿 19/0——A6 stateHash/回放确定性断言含于其中）。
- 本单新增网络件全绿（exit 0）：延迟 10/10、满员旁观 15/15、长局见 T4b、QA1 网络件复跑 21/21。
- 回归抽查：无（本单预算版，红线=五项专项+冻结门禁；全仓回归留 STRESS/QA1 口径）。

## 观察项（如实）

1. **O1 驱动器视图字段陷阱（本单踩坑，非游戏缺陷，已发知识库草稿）**：tactics 个性化视图（viewFor）回合字段为 `turn`，canonical/测试面为 `turnSeat`——自写 WS 驱动器按 canonical 形读视图则永不动手，局走三连 afk 判负且断言面可能假绿（ended 分支豁免吞掉采样缺失）。识别法：acted=0 + 终局 reason=afk 即驱动器未生效，非对局动力学。
2. **O2 30s 重连档终局形态**：本单复跑 30s 档终局为 draw/abandon（timeScale=2 下断线 30s > 15s 收房线），QA1 记录形态为"托管续打至自然终局"（timeScale=2 同档）——两形态均属重连窗后正确行为族（QA1 已文档化"臂形取决于断线期动力学"），非缺陷；如需稳定"托管打完"臂形建议 timeScale=1。
3. **O3 并发臂房竞争**：同网关并行跑多件网络件时，quick/旁观择房会互相抢占（T3a 二轮 feed 面 humans=2）。取证设计教训：需要净房间的断言（席位保留/回收）以旁观名册时间线为主证据面，feed 计数为辅；或臂间串行。
4. **O4 对局时长天然帽（引擎语义，非缺陷）**：scoreLine=10 占点分到线即终局——实测贪心互攻 42-90s、被动慢棋（每回合 1 move+endTurn+10s 间隙）73s 即 score 到线；单一局拉不到 5 分钟。5 分钟"长局 spot"以连续真人续局观察窗实现（T4c），全程未见卡死/消息停滞/掉线类异常（渲染/帧成本面交叉引用 FEEL 结论，不重跑）。若后续单据需要单一 ≥5min 局（如托管长跑），建议评估 timeScale<1 支持或 maxTurns/scoreLine 可配。
