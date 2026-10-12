# 战棋对决 QA一号（GAMES-119 · 单链 3/10+）

> 独立复验 + S1+S5 双技术专项走查。基线 main@bff5b35（GAMES-118 DEV 已合并）；分支 feature/GAMES-119。
> 口径：三支柱复跑 / S1+S5 专项（确定性·回合裁决边界·个性化分路）/ 重连三档 / Bot 三档梯度 / 八作回归抽查 2 作。
> 本单修复 **F1**（单文件级，网关 tactics 适配器）；观察项 **O1**（Bot 梯度倒挂，转 FIX1 候选）。

## 结论速览

| 面 | 结果 | 要点 |
|---|---|---|
| 冻结门禁 api-check | ✅ 17/17（修复后复跑同绿） | A1-A6 全过；A6 双跑+回放 1475299752 |
| perf-smoke | ⚠️ 环境归因带内 | 13.4fps / jank76.5%——对照 element 15.0 / pool 14.3 同窗同 p95；帧成本 p50=0.00/p95=0.10ms 超 16.7ms 占 0%（§4） |
| 识图 v2（冒烟三锚点） | ✅ 13/13（F1 修复后） | 双色格 26+25/64、令牌双阵营、AP 灯珠实/空 |
| S1 确定性专项 | ✅ 48/48（sim 级四图） | 四 mapId 双跑+回放逐字节；$timeout/afk 局重放一致 |
| S5 裁决边界专项 | ✅ 48/48 内含 | 并发冲突三类 / 悔棋整体恢复+限次 / 托管三层 / 视图分路 |
| 重连三档 | ✅ 5s/10s 全绿；30s=托管至终局 | welcome 六字段恢复+op 续接；30s 档「局仍活」臂不可达（§5.3） |
| GAMES-84 abandon 锚 | ✅ 判别性断言过 | 双断+5s 仍 live（锚=最后在场）→ +18s abandon |
| Bot 三档梯度 | ⚠️ O1 倒挂 | balanced(9/9) > competitive(7/12) > casual(0/9)；分层活性互异 ✓（§6） |
| 八作回归 2 作 | ✅ element 24/0、snake-king 绿 | 网关重启后 snake 复跑（首跑撞重启窗口伪红） |

## 1. 三支柱复跑

- `node scripts/api-check.js tactics-duel` → **exit=0，17/17**（P0/L1/A1/A4/A5/A2 win score 10:1/A3 lose afk/A6 双跑 stateHash=1475299752+输入日志 74 条逐字节+回放==在线）。
- F1 修复改网关码后**复跑同绿**（对 pid 重启网关：旧 42322 → 新 45289，重启后 17/17）。
- perf：绝对值在本机不可达（headless rAF 封顶 ~14fps，DEV 已披露）；本单补齐证据链：
  - 对照臂：element-duel 15.0 / pool-physics 14.3（已验收 perf=pass 两作同窗同 p95 133.3ms——环境归因，非本作代码）；
  - 帧成本直证（`tactics-duel-qa1-frame.mjs`，rAF 内 BFS 移动域+目标域复算 n=240）：p50=0.00ms p95=0.10ms max=0.40ms，超 16.7ms 帧占 0%。
- 识图 v2：冒烟脚本三锚点（8×8 双色微差格/六兵种令牌双阵营描边/AP 灯珠实空）修复后全过；截图 kernel/workers/GAMES-118-shots/{online,offline}.png（本单复跑覆盖）。

## 2. F1（本单修复）：席 1 操作者 ruling 静默丢弃

- **症状**：quick 入 bot 房坐席 1 的真人，任意合法 op（move/attack/skill/endTurn）**无 ruling 回执也无 reject**——客户端视图停在 welcome 态（冒烟「move op 裁决」「AP 灯珠」两断言红即此根因的级联）。
- **取证**（`tactics-duel-qa1-f1probe.mjs`，addInitScript 劫持 WebSocket）：WS open、`{"t":"op","k":"move",...}` 已发、服务器**零下行**——排除客户端发送侧。
- **根因**（server/gateway/sims/tactics-duel.js drainOutbox）：`players = room.seats.filter(s=>s.conn)` 过滤后**按席位号索引** `players[p.vis]`——「席 0 无连接（bot/断线）+ 操作者=席 1」时 `players[1]=undefined`，vis=1 的操作者实时 ruling 整体丢弃。reject 路径 `room.seats[seat].conn` 直取无恙——故合法 op 无声、非法 op 反而有回执。
- **为何门禁没拦住**：api-check 全剧本 API 席=0（botLevels [null,x]）——players[0] 恒在；真人 quick 对局才坐席 1。测试面盲区实锤。
- **横向**：element-duel 适配器为全连接广播+personalize 改写（无席位索引）——不受影响，缺陷隔离在 tactics 适配器 vis 分路。
- **修复**：vis 席位路由改 `room.seats[p.vis].conn` 直取（带 conn 判空），2 行。修复后：冒烟 13/13（含中途入局 move 裁决+AP 灯珠）、WS 劫持探针见 ruling 回执、门禁 17/17 复绿。

## 3. S1+S5 专项走查（`tactics-duel-qa1-sim.mjs`，48/48）

- **D1 确定性（DEV A6 的四图扩展）**：seed 20261012-15（mapId 0-3 全遍历）各双跑——终态 stateHash 相等、部署段逐字节、`replayOps` 重放==在线；终态覆盖 score/wipe 多通道。
- **D2 并发冲突三类（§5.4）**：a 双击重复提交→第二条 reject（not-idle，幂等安全）；b endTurn vs 超时——tick 先到→timeout-turn 入账+casual 代打+换手，后到 endTurn reject not-your-turn；c undo 与在途 op 交错——撤销前意图 op（组包起点=已移格）按恢复后态校验 reject bad-path。
- **D3 悔棋**：快照整体恢复（units/own/scores/ap 与 turnStart 逐字节相等）；二次 undo reject undo-used；跨回合复位；非回合席 reject not-your-turn。
- **D4 托管三层**：超时单回合=casual 代打（$timeout 入账，恰好一次口径下正确换手）；主动托管=host on 任意相位合法+续打入账+任意合法 op 即夺回（hostOn 自动清）；afk 三分离——连续 3 全超时回合认负（B/afk），代打 op 不入计数。
- **D5 个性化视图分路**：deploy 互密置（对方/观战 deploys=null）；act 操作者=实时 canonical（含本回合 move+AP 实时 3），对手/观战=边界态（单位在起点+AP 4）；viewFor 无副作用（canonical hash 不变）；终局 reveal 双方部署全披露。
- **D6 系统事件回放**：afk 局（含 $timeout 代打段）重放==在线终态 hash。

## 4. 重连三档（`tactics-duel-qa1-net.mjs`）

- **5s/10s 档全绿**：回合态建立（AP=3/moved）→ $disconnect → 席位保留（10s 窗 human）→ $reconnect 复席 → welcome 全量个性化恢复（phase/turn/ap/undoUsed/host/timerMs 六字段）→ 注入 op 得 ruling（行动序列续接）。
- **30s 档**：断线期托管续打已证（局推进 turnNo=6 至自然终局 B/wipe 而非停滞/abandon；8x 与 2x 两口径同象）。「断线 30s 后局仍活再复席」臂在 bot 对手自完结动力学下**不可达**（bot 出手即 endTurn，整局 10-20s 墙钟自完结）——非缺陷，产品无此慢局形态；welcome 恢复+续接机制已由 5s/10s 档同机制覆盖。终局收房后复连拒绝（room-gone）=正确行为。
- **GAMES-84 abandon 锚复验**：独真人房在场 16s → $disconnect → **+5s 仍 live**（判别性断言：若锚=join 时刻则首个扫描拍已 abandon——证锚=最后在场时刻）→ +18s ended/abandon（断线后 18014ms，15s 窗）。

## 5. Bot 三档梯度（O1 观察项）

- **配对对抗**（sim 级，T0 同部署）：balanced vs casual **3/3+6/6=9/9**；competitive vs casual **1/3（seat0）+6/6（seat1）=7/12**；competitive vs balanced **0/3+0/6=0/9**——**balanced > competitive > casual**。
- **分层活性**：同 seed 同部署三档 op 流（逐 tick hash 序）互异——非死档，评估函数分层真实接线。
- **定性**：设计 §4 主张 competitive 为最高档（precise/formation/killBonus/2-ply 四件套）——实测强化反而降强度。候选根因（未验证）：2-ply 纯移动臂的 worst 早停阈值 -12 过保守/precise 集火风险叠加导致避战失点。终局多为 score（占点分）——保守打法跑分不利。**转 FIX1 调参+梯度回归剧本**（非单文件级：调参须重验三档梯度与 A3 lose 剧本）。

## 6. 八作回归抽查

- element-duel：**24/0**（S5 姊妹作——F1 横向排查确认其适配器不受影响）。
- snake-king：首跑输出截断为崩溃栈尾部——**撞本单网关重启窗口（kill 42322）**，非游戏回归；重启后复跑绿（api-check 全断言通过）。

## 7. 遗留与移交

| 项 | 级别 | 去向 |
|---|---|---|
| O1 competitive 梯度倒挂 | 中（体验/设计主张不符） | FIX1：调参+三档梯度回归剧本（含 seat 交换臂） |
| F1 测试面盲区 | 低（流程） | 建议：api-check S5/S1+S5 剧本增加「API 席=1」臂（botLevels ['x',null]）——已留知识库草稿 |
| 30s 档「局仍活」臂 | 记录 | bot 自完结动力学下不可达；如需测须人为慢局夹具 |
| perf 55fps 绝对值 | 环境 | 帧成本+对照带证据链已足；绝对值留具备环境的单 |

## 8. 自测命令清单（全部 exit 码见 REPORT）

```
node scripts/api-check.js tactics-duel            # 17/17（修复前后两跑）
node scripts/perf-smoke.js --slug tactics-duel --ms 6000   # + element/pool 对照臂
node scripts/tactics-duel-smoke.mjs               # 13/13（F1 修复后）
node scripts/tactics-duel-qa1-sim.mjs             # 48/48
node scripts/tactics-duel-qa1-net.mjs             # R1 5s/10s + R2 abandon 全绿
node scripts/tactics-duel-qa1-f1probe.mjs         # F1 取证（WS 劫持）
node scripts/tactics-duel-qa1-bot{,2}.mjs         # 梯度抽查（O1 红即观察项）
node scripts/tactics-duel-qa1-frame.mjs           # 帧成本 p95=0.10ms
node scripts/api-check.js element-duel            # 24/0
node scripts/api-check.js snake-king              # 绿（重启后复跑）
```
