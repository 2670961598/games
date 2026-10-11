# 极速卡丁 QA一号（三支柱+S7 专项）—— GAMES-110

> 单据：GAMES-110（L2 常规 · attempt 0）｜基线：main@1f83a28（GAMES-109 DEV 交付）｜分支：feature/GAMES-110
> 证据：`kernel/workers/GAMES-110/`（gate 日志/JSON、浏览器臂日志、单元复现、离线探针）+ `evidence/g110-qa1/`（仓内探针脚本与产物）

## 0. 结论速览

- 三支柱：冻结 gate **32/0 全绿**；perf 红线 **环境态不可测**（凌晨显示休眠封顶，空白页差分 22.5fps<游戏 25.4fps，同 GAMES-109 态，非代码缺陷）；识图 v2 **PASS**（几何✓ 墨水✓）。
- S7 专项：确定性口径全绿（A+ 双房 hash 相等+逐字节输入+在线==回放）；**和解观测面两处结构性死码（F1/F2，退回 FIX1）**——玩法不受损（视觉 EMA 仍平滑、gate 全绿），但 §5.3 预算表不可实测、200ms 态假降级横幅已在浏览器臂运行时复现。
- 重连三档：`?room=` 显式复席路径 5s/10s/30s 全绿；**quick 局 reload 丢 roomId→resume 不可达（F9，产品缺陷）**。
- Bot 三档梯度：分层清晰（61.4/52.35/47.5s，档差 14.7%/9.3%）。
- 七作回归抽查：net-tank 14/0、element-duel（见 §6）。

## 1. 三支柱独立复跑

| 支柱 | 命令 | 结果 |
|---|---|---|
| 冻结 gate | `node scripts/api-check.js speed-kart` | **exit=0，32 通过 0 失败**（A1/A4/A5 建房-迁移-延迟-重连、A2/A3 win/lose 圈速账本+防切道+jumpViol=0、A+ deterministic stateHash=3312836306 双房相等+输入日志逐字节相等+在线==回放器、A7 完赛账本逐圈全对、A2 carried=2796、A8 双臂完赛+圈速中位差 5.30%≤25%+双臂 carried>0） |
| perf-smoke | `--slug speed-kart --ms 8000` | avgFps 25.4 / jank 77.3% ——**红线违例=环境态**：about:blank rAF 同采样 22.5fps（零 JS 零 canvas 仍低于游戏），凌晨 WindowServer 降频封顶复现 GAMES-109 态；单帧 JS 成本 GAMES-109 已测 ~1.5ms（预算 9%）。**复测条件=显示器活跃时段，勿以本态数值定级** |
| 识图 v2 | `node scripts/visual-check.js --slug speed-kart` | **PASS** 几何✓ 墨水✓（play带 top10% upper31% lower31% thumb68%；素材 evidence/g110-qa1/shots/） |

## 2. S7 专项走查

### 2.1 影子预测核心审计（确定性口径）✓
- 单源同式：服务端 sims/speed-kart.js 与客户端 index.html 引同一 shared.cjs（UMD）；预测器只走 integrate/progress 同函数同常量；倒计时「先翻相再积分」两端同拍。运行时：A+ 在线==回放 + 双房逐字节输入相等（gate 内含）+ SM1/SM2 hash 哨兵在欠跑态零分歧。
- 输入序号确认：A4 快照 ack 反映 <100ms（gate）；ack 语义瑕疵见 F3。

### 2.2 和解行为抽样 ✗→退回（F1 死码，预算表不可实测）
- **F1 [P1] 和解 Δ 测量结构性为零**：`client.js applySnapshot` 中 `before`/`after` 均为权威锚点+重放后的同一终态（第二次 `advanceTo(S.simTick)` 空转，修正前预测态在 `anchor()` 已被覆盖）→ `dPx≡0`。
  - 后果链：`S.recon` 台账永空（HUD「和解修正(10s)」恒 0、§3.3 详情卡死）→ 6px/512brads 软硬分流、120ms 混合带（`S.blend` 唯一写点）、≤2.5px/帧撕裂预算全部死代码。实际生效路径=「逐快照静默重锚 + 视觉 0.35/帧 EMA 逼近」——玩家侧平滑度近似软收敛（体验不受损），但 §5.3 预算表五个 QA 靶全部不可测。
  - 单元复现（`evidence/g110-qa1/s7-recon-repro.mjs` 直驱 shared.cjs 复刻和解序列）：simTick=F/F+2/F+4 三态 dPx 全 0，而影子实际前移 0/29.5/60.8px。
- SM2（200ms 代理臂）recon 0 事件**≠落带**——假绿风险如实披露。

### 2.3 A8 双臂复证 ✓（附观察）
- api 臂：arm0 49.1s vs armB 46.5s 中位 → 差 5.30%，≤25% 判据余量 19.7pp；双臂 finish 3/3 圈；carried 双臂>0（1645/1571）。
- 浏览器臂：TCP 双向各 100ms 代理 → ping 徽标 204ms（200±40 ✓）。**观察 O-2：armB 反快于 arm0 5.3%**（GAMES-109 测 3.48% 同向）——timeScale=2+虚拟会话节拍口径下影子预测决策收益可超延迟代价，方向性存疑但判据只约束 |差|；≤1.5%/≤2% 精确公平性口径归 QA2 浏览器双臂（附决策 12），本单未测（quick 房异 seed 不可对照，如实留档）。

### 2.4 hash 哨兵与重放安全 ✗→退回（F2 运行时实锤）
- **F2 [P1] hash 比对错拍**：客户端 `hashKart(S.pred.kart(), m.frame)` 哈希的是**本地 simTick 拍的影子**、配**权威 F 帧前缀**；服务器哈希权威@F。simTick>F 即必分歧（单元复现：领先 2/4 拍均分歧，影子已前移 29.5/60.8px）。
  - 运行时实锤：SM2 200ms 臂 `hashBad=0 但 hashWarn=true`（闩锁）——延迟把本地钟推到权威帧前，≥3 连续假分歧 → HUD 常驻「⚠ 网络模式降级（校验分歧）」（client.js:709）+ 每分歧发 `sync` 逼服务端全量（§5.5 带宽预算外洪泛）。**恰在 S7 红线的 200ms 态触发**。
  - GAMES-109 冒烟 hashBad=0 的测量条件缺陷：fps 封顶环境本地 sim 欠跑、simTick 恒被快照顶回 m.frame → 欠跑态偶然全绿（环境掩盖）。
- F3 [P3] `ext.ack`=最后**收到** seq（rooms.js:232 收到即写）而非最后消费——pending 路径（f≤frame+8）下 ack 领先消费 ≤8 tick，客户端可把未生效输入当已确认（≤2 快照自愈）。
- F4 [P3] 预测环 `at=simTick+flight` 单调性：flight EMA 单步可降 ≥2 + simTick 下钳（快照断流恢复）→ at 倒序可致输入迟消费/错分类；>96 条 pending 静默丢最旧。

## 3. 重连三档（预测续跑语义）
- v1 探针（reload 不带 ?room=）4 红 → 归因**探针口径+真缺陷并存**：seat 5→4/tick 倒退=进了新房（quick 重进），非复席路径。
- **F9 [P2] quick 局 resume 不可达**：resume 存 `sessionStorage['spk-'+真实roomId]`，reload 后 `rid=q.get('room')=null` → 读 `spk-null` 落空 → quick 进新房；断线横幅「连接已断开（10s 内重连可夺回席位）」（client.js:710）对 quick 主流程玩家是**不可兑现的承诺**（无自动重连，唯一手动路径=刷新）。
- v2（?room= 显式复席，`evidence/g110-qa1/reconnect-3tier.mjs`）：

| 档 | 入座 | tick 单调 | 复席保号 | 预测对齐（hashWarn 未闩） | pageerror |
|---|---|---|---|---|---|
| 5s | ✓ seat 5→5 | ✓ 1648→1882 | ✓ | ✓（hashBad=1 瞬态，见 F2） | 0 |
| 10s | ✓ seat 5→5 | ✓ 241→569 | ✓ | ✓（hashBad=1 瞬态） | 0 |
| 30s | ✓ seat 5→5（逾窗托管后让位复归原席） | ✓ 229→954 | n/a（窗外语义） | ✓（hashBad=2 瞬态） | 0 |

窗内语义=10s+1拍（rooms.js:342）复现正确；重连后清缓冲+全量重锚+pending 重放行为正常（hashWarn 未闩、recon 无失控）。

## 4. Bot 赛车线三档梯度（圈速分层）✓
离线直驱单源 shared.cjs（`evidence/g110-qa1/bot-gradient.mjs`，replayInputs 同式 per-seat rng）：三 seed 全 bot 房，champion 平均圈中位——casual 61.40s / balanced 52.35s / competitive 47.48s，**严格分层**（casual-balanced +14.74%、balanced-competitive +9.30%），档间零重叠（min/max：61.37-61.90 / 52.00-52.37 / 47.38-47.50s）。样本=各房 champion（赛制完赛窗内仅头名完赛 3 圈，如实注记）。

## 5. 七作回归抽查 2 作
- net-tank（S1 基座）：**14/0 exit=0**。
- element-duel（S5，最近 FIX2）：**24/0 exit=0**。

## 6. 退回清单（转 FIX1 建议）与观察项
**退回（代码级，建议 FIX1 单）**：
- F1 和解 Δ 观测面死码（recon 台账/软硬分流/混合带/撕裂预算）——client.js 单文件可修：anchor 前捕获修正前预测态作 before。
- F2 hash 哨兵错拍——修法=对**合并权威态@F**（authMerge 产物）取 hash 比对（合并完整性校验，与注释声称意图一致）；顺带解 200ms 假降级横幅+sync 洪泛。
- F9 quick 局 resume 不可达——quick 入房后 history.replaceState 回写 ?room= 或断线横幅改口+自动重连。
- F3 ack 收到/消费口径、F4 环 at 单调性——低危同批。

**观察项（不动码）**：
- O-1 玩法体验无损证据：F1/F2 下 SM1/SM2 全程零 pageerror、驾驶连续、飞行窗自校准 flight=1（0ms）——静默重锚+EMA 在两臂均未产生可感知撕裂（主观体感项归 QA2 日间复测）。
- O-2 A8 armB 反快 5.3%（方向性观察）。
- O-3 接管局 lapSrv 首圈 lapLocal 必空（本地账从锚点起算，§3.4 对照条口径——设计如此，注记）。
- O-4 宽限=整 tick 粘性沿用（无 20ms 子拍窗）、carried 混计丢拍/挂机——判据力度注记。
- O-5 welcome.room.prediction 声明块客户端零消费（版本护栏未建）。
- O-6 软收敛 0.35/帧 vs 设计 20%/帧（文件头注释仍写 20%）；混合带系数无 ≤2.5px/帧封顶（F1 激活前无意义）。
- O-7 game.json latency200 assert 文本仍写 ≤1.5%，实现=≤25%（api 臂补偿口径+附决策 12 注记已在 check 标题）——声明文本建议随 FIX1 对齐。
- O-8 perf 红线环境态不可测（§1），复测条件=显示器活跃时段。

## 7. 工具与口径备忘
- 200ms 浏览器臂注入=本仓 TCP 双向各 100ms 代理（net.createServer 逐 chunk setTimeout，evidence/g110-qa1/browser-qa.mjs 内嵌）——与 GAMES-93/104 QA2 代理垫同法，免 sudo netem。
- 浏览器探针曾临时扩 netProbe 暴露 reconPx/hashWarn（client.js 测量后已 git 还原，交付树零残留）；三支柱均跑在还原前的干净树上。
- 静态页私口 :4398（:4399/:4400 零感知）；网关 :4400 pid 53790 起于 10-12 02:33（晚于基线 checkout 02:27，加载码=1f83a28 无陈旧窗口）。
