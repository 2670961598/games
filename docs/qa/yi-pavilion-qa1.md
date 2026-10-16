# 弈界棋阁 QA1 联机红线专项报告（GAMES-156）

| 项 | 值 |
|---|---|
| 单据 | GAMES-156（[QA·E6-W2-T5] 弈界棋阁 QA1 联机红线专项 S5·多规则引擎 3/10+）attempt 1（首跑 45min 看门狗击杀后 PM 抢救 net 臂脚本落枝 05e3bb1，本轮复用重跑） |
| 分支/基线 | feature/GAMES-156 @ 05e3bb1（merge main=4a97cf2 已合，DEV=GAMES-155 单链 3/10） |
| 环境 | 影子网关 :4420（PORT/GATEWAY_PID/GATEWAY_LOG 显式改道，:4399/:4400 零感知——页面自 :4399 生产 web 只读加载）；无头 chromium（playwright）；seed 20261016；ENGINE_HASH=1737450531 |
| 测试件 | scripts/yi-pavilion-qa1-net.mjs（PM 抢救件，本轮复跑）/ yi-pavilion-qa1-web.mjs / yi-pavilion-qa1-b3f1.mjs / yi-pavilion-qa1-long.mjs（QA 只读纪律：零产品代码改动，四件均为测试件） |
| 截图 | /Volumes/BigDisk/Studio/kernel/workers/GAMES-156-shots/（p1-net-reversi.png + p3-{gomoku,reversi,cascade}.png） |

## 一、结论总览

- **红线判定：退回（P0 一项）**。三支柱、S5 回合权威/多规则三模式/托管三层/重连三档/观战满编、Bot 梯度（补强口径后）全绿；**F1（P0）多规则特征提取器底座反应盲返非法着点 → bot/托管/代走全链假 afk 认负**，reversi/cascade 两模式面宽 11/20、5/12，在线复现在案。
- 退回清单：**F1（P0）**、**F2（P1，F1 派生）**。观察项 O-1..O-4。
- 回归抽查 2 作：tactics-duel 19/19、element-duel 24/24（api-check，:4400）。

## 二、三支柱

### 2.1 perf（P2）——绿
- 帧成本口径（rAF 回调执行耗时，免疫无头 vsync 封顶——games-155 先例）：**avg=0.56ms p95=1.0ms n=140**（红线换算 <16ms≈≥55fps 预算），掉帧率（>25ms）**0%**（红线 <2%）。
- 对照带：blank 空转 rAF 饥死（无头后台 tab 节流，15s 超时降级披露位）——非门禁，同带披露。

### 2.2 play 四断言（P1）——绿
- **A1**：quick 入房 welcome 就席 seat=1 rule=reversi，S5 声明块 engine hash 1737450531==页面同源 SIM（版本护栏浏览器面闭环）；ruling 流推进到可操作态。
- **A2**：pointer 真实输入路径落子 → 权威 place 裁决（board[cell] 0→2 归属我席）+落子墨水落位（青方子像素核 228px@落点 16×16）。
- **A3**：零 pageerror（net+三模式离线整轮）。
- **A4**：tap→权威回执 **67ms**（<1.5s LAN 口径；<100ms 服务端同钟由冻结命令 A4 交叉引用）。

### 2.3 识图 v2（P3）——绿（三模式离线确定性画面 ?debug=1&rule=）
- **宣纸亮底** #F2EBDC±10：23.9-25.7% 占比（全目录首款亮底联机作）。
- **榧木亮盘+深褐格线** #D8B878/#6B5433 三模式在场。
- **路数指纹**（列剖面法：竖格线列盘高方向深色像素 >100 计线，对归属蒙层/金环遮蔽免疫）：gomoku **15**/reversi **8**/cascade **10**（9 格线+右缘子盘粗框）——与客户端 render 循环 `i<n` 条竖线逐模式吻合。cascade 子盘粗框 #4A3A20 第二指纹 8889px 在场。
- **棋子形色双编码**：A 琥珀圆 #E8A33D / B 青方 #3DC8E8 双簇同场可辨（三模式 amber/cyan 均 ≥40px；色盲下形状通道独立成立）。
- **HF __applied 生效自证**（票面首日断言位）：三模式 `__applied=true`（登记值==ctx.font 回读值闭环）；分级 P0=13/P1=11/P2=9 全达标（n=49-73/155-230/16-24）。

## 三、S5 专项

### 3.1 回合权威·非法步拒绝（Q1）——绿（六类全谱）
越界 cell=99999→reject(bad-cell)@2ms；串手（bot 思考窗注入）→not-your-turn；已占格→occupied；黑白非夹击位→no-flip；井字送位窗外→wrong-board；井字死盘（已归属子盘）→dead-board。reject 只回违规席（Q6 浏览器/WS 双面证）。

### 3.2 合法步裁决账本（Q2）——绿
三模式逐 ruling 后置态对账：place 事件↔归属 17/17、41/41、56/56；reversi flip 全翻对账 41/41（n=cells.length）；cascade sub 定盘↔归属表即时对账 7/7（owners=1122122）；turn 事件交替+moveNo 单调（16/43/55 手）。三房均达终局（five/afk※/meta；※=F1 在线复现，见 §6）。

### 3.3 多规则引擎三模式确定性同锚（Q3）——绿（F2 例外在案）
三房 welcome.room.duel 声明块 engine='yi-board-int-v1' rule 各异 **hash 同值 1737450531==sim.ENGINE_HASH**（单哈希全量覆盖三模式=版本漂移护栏）；gomoku/cascade 终态 replayOps(opsLog) 重放 hash==在线 stateHash 逐字节吻合（1879219660 / 4294856502）。reversi afk 终局局回放分歧=F2（§6.2）。

### 3.4 托管三层单步化（Q4）——绿
- 层① 步限超时自动走子：timeout-move×2、每事件后恰 1 子（单步非批量）；第 3 次全超时步**先终局不再发事件**（单步语义面）；代走不重置 afkStreak（fromBot 门，afkStreak=[3,0]）。
- 层③ 连续 3 全超时步 → end(afk) 对方胜。
- 层② host 开关：host 事件广播+hostedNext 续打在账（我零 op 托管期落子 4，真秒档 gated 1-2s/手）；任意合法 op 夺回（host off 自动广播）。

### 3.5 断线重连三档+观战位+满编（Q5/Q6）——绿
- **R1 5s 全测**：断线席位保留（kind=human）→$reconnect 复席 seat 归位；welcome 全量恢复（盘面延续/双 clock/turn/last/moveNo 1→2/子数 1→2）；复席后我方续走（place 受理+moveNo 前进）。
- **R2 10s 档**：窗内（10s+1 拍宽限）复席成功+全量恢复（moveNo=2 clock=231010）。
- **R3 30s 档**：逾窗席位转 bot（roster.kind=bot）+托管续走在账（我席子数 1→3）；$reconnect→409 resume-rejected（不降级顶号）；棋局不断（见 O-1）。
- **Q6 quick 真实房 WS**：双真人入房 2/2 满编；观战 spectate join→welcome role=spectator 对局视图同源；**零隐藏信息：观战者收到与对局方逐字节相同的原始 ruling 帧**（833B 恒等——全公开信息恒等映射可断言，设计 §5.2 首证）；reject 只回违规席（P 收到，观战者/对家零感知）；满员后第 3 连接 play join→观战位承接（不顶号不崩）。

## 四、Bot 三档梯度（Q7+B 补强）——绿（B3 以补强口径取证）
- **B1 五子威胁响应率**（mustBlock 命中）：casual 0%（0/1）< balanced 100% ≈ competitive 100%（样本薄见 O-2）。
- **B2 黑白位置分**（count 终局局 WGT，F1 甄别口径）：casual=170 < balanced=408 < competitive=434；角 1/4/4。
- **B3 井字完美度·冻结位面执行率**（补强件 v3：随机合法手直推采集「winNow[0] 合法」决策位面 17 个，同一位面集三档决策核 casualNext/balancedNext/competitiveNext 对照）：**casual 41%（7/17）< balanced 100% = competitive 100%**（§4.1 恒执行底座反应 vs §4.2 casual 30% 底座——设计分层兑现）。
- **B4 战绩面**：五子 competitive vs casual 6/6 双侧压倒（afk=0）。
- **B5 在线抽查**：casual/balanced/competitive 三房 bot 着全走 applyOp 权威位（×62/×15/×14，终局 five）。
- 首跑 B3/B1 口径教训见 §7 复盘。

## 五、长局 spot（L1）——绿（4/4）
quick 真实房**双 WS 真人席**（testapi 输入=单 API 玩家固定席，双真人席只能走 WS）10s/手慢打 305s 窗口，5s/spot 采样（{t:'sync'} 全量重同步，视图态）：**spots×62、frame 单调 3639→34142、双棋钟递减 443610→138580ms、盘面换态×26；逐 spot 账本 moveNo==盘面子数（47==47；驱动确认手 27==moveNo 增量，竞态拒着重试另计）；局钟覆盖 钟耗 305030ms ≡ 30503 tick 当量（≥30000）；钟率交叉引用 偏差 0.01%**（wall 305s vs 钟耗 305s——timeScale=1 下 10ms 基准不漂）。5min 窗口内对局存活未终局（双席各烧 ~150s<240s 判负线）。满编+观战另见 §3.5 Q6。

## 六、退回项明细

### 6.1 F1（P0）多规则特征提取器底座反应盲返非法着点 → 全链假 afk 认负
- **根因双枝**（位面解剖，离线确定性复现）：
  - **reversi 枝**：`feat.mustBlock[0]` 可对己方非法（legal 不含该格），casual 30% 分支与 balanced/competitive 恒执行分支**无条件盲返**。位面：seed=20261016 席1——着点 0==mustBlock[0]，legal=10 格不含 0。
  - **cascade 枝**：`feat.winNow[0]` 不查送位窗（cascadeWinCells 与 legal 不求交），三档底座反应同样盲返。位面：seed=11 席1——着点 7==winNow[0]（mustBlock 空），legal=5 格不含 7。
- **失效链**：applyOp reject → 决策流 rng 定桩（同 decIdx 同 rng）→ 同格逐 tick 重试 → 烧穿 30s 步限×3 → afkStreak 认负——**有合法手一步不走**。三档 bot+托管层②hosted+超时代走层①全走同脑路径（candidates() 非 gomoku 恒返回 legal，本身干净——缺陷限 feat 底座反应两条产出通道）。
- **面宽**：reversi bot 对打假 afk **11/20**（5 档位×4 seed）；cascade **5/12**（三档×4 seed）；gomoku 对照 **0/6**（mustBlock 恒空格=合法，五子枝干净）。
- **在线复现**：Q2 reversi 房 reason=afk winner=A moveNo=43（bot 假 afk 送局）；首跑 B3 cascade comp-vs-casual 局 reason=afk。
- **建议修法**（FIX 单裁量）：底座反应产出后与 `legal(st,seat)` 求交（`lg.includes(x)?x:lg[…]` 或直接过滤 feat 产出）；A6/Bot/FEEL/STRESS 后续单均受此影响（bot 对打大面积假 afk 使 cascade/reversi 生态位失真）。

### 6.2 F2（P1，F1 派生）afk 终局局 replayOps 回放分歧——A6 确定性护栏破绽
在线 reason=afk moveNo=43 vs replayOps 重放 over=false moveNo=44：重放器重放 place 不带 fromBot=true，「人类 op 复位 afkStreak」分支误清零（GAMES-155 DEV 记忆中 fromBot 门在在线 bot 通道正确、重放通道未建模）。非 afk 终局局回放逐字节吻合（§3.3），护栏破绽限 afk 通道。F1 修复后 afk 局本身锐减，F2 建议随 F1 一并修（replayOps 补 fromBot 语义或超时事件入日志重放）。

## 七、观察项（不退回，PM 裁量）
- **O-1**：R3 30s 逾窗后单人类房最终以 abandon 终局（托管期推进在账、棋局不断断言通过）——与设计 §5.5「继承 Bot 接管直至终局」的语义存在出入（全人类撤席即回收 vs 打满）。低危（复席 409 语义正确、托管续走在账）。
- **O-2**：B1 casual 威胁响应样本 0/1（vs balanced 对手 winNow/mustBlock 机会被封锁）——B3 已用冻结位面法补足同类分层证据，B1 建议随 F1 修复后 BOT 单重采。
- **O-3**：无头环境 blank 对照带 rAF 饥死（后台 tab 节流），降级披露位非门禁（games-155 perf 沙箱同带先例）。
- **O-4**：quick 让位继承前任断线席可入中局房（moveNo 已深）——客户端正常态（设计 §5），测试件已加「concede+reload 换新房」防线；对真玩家是特性（T5-A 随手托管谱系）。

## 八、回归抽查（2 作）
| 游戏 | 结果 |
|---|---|
| tactics-duel（api-check，:4400） | **19/19 全绿** |
| element-duel（api-check，:4400） | **24/24 全绿** |

## 九、复跑口径
```
# 影子网关（当前分支代码，显式改道）
PORT=4420 GATEWAY_PID=/tmp/yi-qa1.pid GATEWAY_LOG=/tmp/yi-qa1-gw.log node server/index.js
node scripts/yi-pavilion-qa1-net.mjs     # S5 专项+重连+观战满编+Bot+F1/F2 取证（首跑 47 绿 4 红→B3/L1 由补强件收口、F1 cascade 枝归因修正）
node scripts/yi-pavilion-qa1-b3f1.mjs    # B3v3 冻结位面+F1 终版双枝解剖（4/4）
node scripts/yi-pavilion-qa1-web.mjs     # 三支柱 28/28（与 net 臂互斥：共用 quick 池会互相配对）
node scripts/yi-pavilion-qa1-long.mjs    # L1 长局 4/4（310s；与 web 臂错峰起；遗留房继承=影子对齐真实盘面）
node scripts/api-check.js yi-pavilion    # 冻结验收（:4400）
```

## 附录 A：L1 终跑数据（v8，4/4 绿）
```
长局房 yi-7rrt17e1d5d（quick·gomoku·双 WS 真人席 1/0·10s/手慢打）窗口 310s
  影子局对齐真实盘面（moveNo=20——继承遗留房，钟余 443s）
  spot#1  wall=5s   frame=3639  moveNo=21 clock=217860+225750 stones=21
  …（62 spots 每 5s）…
  spot#62 wall=310s frame=34142 moveNo=47 clock=46710+91870  stones=47
✓ 连续采样（frame 单调+双钟递减+换态×26；窗口内存活未终局）
✓ 账本对账（moveNo 47==子数 47；确认手 27==增量，发送 45 含竞态重试）
✓ 局钟覆盖（钟耗 305030ms ≡ 30503 tick 当量）
✓ 钟率交叉引用（偏差 0.01%）
```

## 附录 B：首跑复盘（45min 看门狗击杀——本轮预算内收口的三跑分离）
首跑单线程串行全量+真秒档长局烧穿 45min 墙钟。本轮拆 net（7min）/web（2min）/long（5.5min）三件异步并行+离线补强件（B3/F1），全程预算内收口。净臂三红复盘：B3 winNow 采样饿死（competitive 对手封死机会）→冻结位面法；L1 timeScale=8 双钟烧穿/bot 不烧钟 sim 上界 ~250s→双真人席慢打；F1 cascade 位面初判 mustBlock 错枝→winNow 送位窗外（candidates 恒 legal 排除）。web 臂四红复盘：getImageData 页面坐标≠画布坐标、1px 格线抗锯齿混色 ±30 不可逮（±55+列剖面法）、格线 i<n 条期望值 n+1 错设、quick 撞遗留中局房（让位继承）。L1 迭代死因四则：testapi 输入=单 API 玩家固定席（seat≠playerSeat 403）；S5 零快照 sync 应答=ruling 携 {k:'sync'} 事件+视图 state（无 opsLog/tick——账本改盘面派生、tick 覆盖改钟耗当量）；空盘影子局撞继承房实际占位格恒 reject（影子须对齐真实盘面）；驱动节流时基混用（相对判据比纪元巨数恒假→楔死 afk）。
