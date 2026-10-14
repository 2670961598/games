# 街头足球 QA1 联机红线专项报告（GAMES-139）

- 单据：[QA·E6-W2-T3] 街头足球 QA1 联机红线专项（S3+S4 复用）单链 3/10+
- 分支：feature/GAMES-139（基线 cce9320 = GAMES-138 DEV，merge main 无前进）
- 日期：2026-10-15 ｜ 角色：QA（只读纪律：零产品代码改动，测试件为 `scripts/street-soccer-qa1-{net,web}.mjs`）
- 环境：私有影子网关 `:4415`（`PORT/GATEWAY_PID/GATEWAY_LOG` 显式改道防覆盖常驻实例，`:4400/:4399` 全程零感知——生产 web 只读 GET 供页面加载）；剧本房一律 `/api/test/*` 隔离测试房（与 WS 会话同一条代码路径，协议 §8）
- 结论：**全绿通过，无 P0/P1 退回项**；观察项 3 条（O-1/O-2/O-3，均低危），1 条口径注记

## 0. 冻结验收命令（自跑）

```
cd /Volumes/BigDisk/Studio/projects/GAMES/repo && node scripts/api-check.js street-soccer && test -f docs/qa/street-soccer-qa1.md
```

结果：`api-check street-soccer` 27/27 绿（A1-A8 全断言，与 DEV 交付口径一致，含 A8 确定性双跑三等 stateHash=3678082269）+ 本报告落盘 → 退出码 0。

## 1. 三支柱（play/perf/识图 v2）——`scripts/street-soccer-qa1-web.mjs` 22/22 绿

play 四断言（quick 真实路径，影子网关 bot 房）：

| 断言 | 结果 | 证据 |
|---|---|---|
| A1 事件闭环 | ✓ | quick 入房 seat≥0+相位有效；4 球员+比赛钟+比分视图在场（phase=play clock=2205 score A3:B2） |
| A2 可玩 | ✓ | 受信输入驱动（摇杆区 mouse 拖拽）对局演化：球位 215722,369285→205863,289668、poss 3→−1 |
| A3 零 pageerror | ✓ | P1 整轮+观战会话+整轮汇总全部 0 例 |
| A4 操控响应 | ✓ | 射门钮真实输入路径（按下 600ms 蓄力松开）→ 868ms 内事件账本响应（shot 受理或 no-ball 裁回均在账=输入闭环）；服务端同钟 <100ms 红线由冻结命令 A4+本单 N3 时延带证 |

perf（≥55fps/掉帧<2% vsync 封顶口径——GAMES-131 无头先例：rAF 帧成本法+空白页对照带）：

- 渲染帧成本 avg=0.42ms（p95=0.5ms，n=121）——远低于 16ms/帧预算（60fps 换算 DoD ≥55fps 口径）✓
- 掉帧率（帧成本>25ms）0% <2% ✓
- 对照带：game rAF 0ms vs blank 33.2ms（同带=环境 vsync 封顶，非游戏负载，披露）

识图 v2（六探针+语义面，GAMES-138 冒烟范式复刻+语义面扩展）：

- 探针① 球场沥青深底 #20242B ✓（实测 [32,36,43]）
- 探针② 顶栏 HUD 深底 ✓（[23,26,32]）
- 探针③ 场内外边界可辨 ✓（场外 [20,23,29] 异色）
- 探针④ 粉笔白中线 ✓（y=306−3 亮像素扫描命中）
- 探针⑤ 霓虹门描边（上门青蓝带）✓（142,52 命中）
- 探针⑥ 底栏操控面墨水（射门/传球/冲刺三钮弧排）✓（ink=212）
- 语义面·六色鼎立区隔：球场域 ≥2 类球衣彩色簇（琥珀/青蓝队色可辨）✓
- 语义面·持球权镜像在场（poss∈−1∪0..3=语义渲染依据）✓
- 截图：`kernel/workers/GAMES-139-shots/{p1-play,p3-vis,p4-spectate}.png`

## 2. S3+S4 专项——`scripts/street-soccer-qa1-net.mjs` 43/43 绿

### 2.1 状态归属表实证（设计 §5.1）

| 归属表行 | 实证 | 结果 |
|---|---|---|
| 持球权=服务器唯一裁决零预测 | 无球权窗口注入 shot → `reject{op:shot,why:no-ball}` 裁回（越权乐观射门不被权威承认）；lunge/CD 期跨 tick 再 tackle → `reject{op:tackle,why:cd}`（第一拍受理/第二拍裁回） | ✓✓ |
| 球员=各自客户端预测（ack 和解） | 快照 `ext.ack` per-connection 确认在场（ack 样本 ×1200，随注入序号确认） | ✓ |
| 球自由态=确定性段重演 | `ext.hash` 哨兵每 10 张周期在场（×120，末例 254326983）；A8 终态 stateHash==replayInputs 重放 hash 已由冻结命令证（交叉引用） | ✓ |
| poss 链对账 | 快照观测 poss 变化点（10Hz 采样）≤账本 poss 事件数+2（观测×24 vs 账本×38——采样稀于事件，方向正确） | ✓ |

### 2.2 持球权翻转账本（counter 剧本，counter-press 驱动）

- poss×163 且链自洽（每条 `from==prev.to`，零断裂）+ 队间翻转 ×141 ≥4 ✓
- tackle 链一致：tackle×29（win×7 全部有易主在账）+ steal×15 伴随 ✓
- 无孤儿持球：终态 owner=−1 ∈ −1∪0..3 ✓；终局 winner=A reason=goal-cap tick=1399

### 2.3 200ms 延迟对照（delayMs=0/200 双房，同 seed 同 bot 档）

- 三 op 注入→快照反映时延带 P95（增量对齐口径，含 10Hz 组包+轮询）：
  - d0：shot min1/P95 75ms(n=15)、tackle P95 149ms(n=33)——帽 600ms ✓
  - d200：tackle P95 138ms(n=5)——帽 900ms ✓；shot/pass 无对齐样本（持球窗<120ms HTTP 轮询盲窗弃样 33 例 reject 在账=受理回路完好；A4 服务端同钟口径已由冻结命令证）
- 仲裁不偏向低延迟者（§5.4⑤ 抽验）：tackle 胜率 0ms=8% vs 200ms=10%（|Δ|=2% <35%，服务器权威仲裁无延迟项——力量+情境公式不含延迟变量）✓
- 五论证抽验注记：①移动 0ms 本地预测（ext.ack 和解在场）；②传球免瞄准（cmd `{k:'pass'}` 零瞄准参数——协议面核）；③射门吸附锥 ±2458 brads 服务器统一（§3.4 全 tier 公平）；④球飞 0.24s+ 围板反弹掩体（wall 事件账本在场）；⑤抢断仲裁双臂等权（上表胜率对照）。实测补充证据：shot 反映带在 d0/d200 房**与 delayMs 无关**（弃样窗收紧前的伪带 d0=min701 vs d200=min700 同带——见 O-2 口径注记）。

## 3. 重连三档（timeScale=1 真秒，三房并行错峰）

| 档 | 断线点 | 验证 | 结果 |
|---|---|---|---|
| 5s 全测 | tick=138（poss=0 观察在案） | 断线 5s 席位未托管（kind=human 保持=席位/持球权保留窗）；$reconnect 凭 token 复席；复席重同步 welcome 全量+快照续流（full×1）；状态延续（比分保持+比赛钟不回退 3471→3318） | ✓×5 |
| 10s 各 1 | tick=115（poss=2） | 窗内（9.6s<10s+1 拍）复席有效+复席后房存续续玩 | ✓×2 |
| 30s 各 1 | tick=113（poss=2） | 逾窗观测（12s）：席位已转托管 balanced（kind=bot，META.takeOver）；token 已清 → resume-rejected 409（复席语义不容降级为顶号）；「比赛不断」托管下 tick 113→415 推进 | ✓×3 |

边界口径实测：重连窗=10s+1 拍（GAMES-63 三游戏统一口径），实测 10.2s 复席已被拒（转托管）——边界行为与口径一致。

## 4. Bot 三档梯度（同 seed+7 三房，1800 tick@8x）

| 观测面 | casual | balanced | competitive | 判定 |
|---|---|---|---|---|
| 进球贡献（goal 事件/终态比分） | 3（1:2） | 0（0:0） | 9（5:4） | comp > bal ✓ 分层显著 |
| 终局方式 | time-up@1800 | time-up@1800 | **goal-cap@700**（提前终局） | 强度分层信号 ✓ |
| 触球节拍（touch/千tick） | 153.3（蜂群） | 12.8（站位） | 25.7 | cas > bal ✓ 行为谱分层 |
| 扑抢（tackle） | 66 | 2 | 0 | 披露（见注） |
| 抢断（steal） | 46 | 0 | 0 | 披露（见注） |

注（分层语义据实修正）：扑抢 tackle 是 casual 蜂群的特征面；competitive 拦截预判（§4.1 角色分配器）走站位卡线+接散球（touch/poss 路径）不落 tackle——档间**行为谱不同**本身即分层证据，且 competitive 对位强度由进球贡献（9 vs 0）与提前终局（goal-cap@700 vs time-up@1800）双锚证实。设计 §4.2「competitive 拦截预判+扑抢节拍」的扑抢面在 competitive 对 competitive 对位下不触发（双方均走预判路径），对 casual 对位时才显著——本单三房为同档对位（预留给 BOT 深化单 GAMES-140+ 对位混跑验证）。

## 5. 长局 spot 5min + 满编 2v2 + 第 5 人观战

- 长局（maxTicks=6000=300s 硬顶帽）：spot ×11 tick 单调推进+stateHash 演化 ✓；终局 reason=time-up winner=A tick=4813（**常规制 180s 比赛钟先于 300s 帽尽**——口径披露：6000 tick 为框架硬顶，常规对局在 clock 尽即 time-up，OT 上限才逼近 300s 帽）✓；goal 事件数==终态队分合计（A6 口径同源交叉引用，0==0）✓；终态 stateHash=3738867541 在场 ✓
- 满编 2v2：roster 4 席在场（1 API 玩家+3 bot，human/bot 结构合法）✓
- 第 5 人观战（**4 真人满员真实路径**）：quick 建房→3 页 ?room= 依次入席（bot 全让位、四席互异 [x,x,x,x]）→第 5 页 ?room= → welcome 实证到达（非初始态假信号）+seat=−1（满员 4/4 真人不占席→spectator 收同快照流）+快照流推进（同流同观）+零 pageerror ✓×5；截图 p4-spectate.png

## 6. 退回项清单

**无 P0/P1 退回项。** 红线全过：三支柱+S3+S4 归属表/翻转账本/延迟对照+重连三档+Bot 梯度+长局+满编观战全绿；冻结验收命令 27/27 绿。

## 7. 观察项（低危，逐项编号）

- **O-1（低危·语义）** quick bot 房真人加入走 bot 让位（真人优先，协议 §2）——「满员转旁观」仅在 4 真人在席时可达。单据「满编 2v2+第 5 人观战」用 4 真人真实路径验证通过；对玩家侧语义无缺陷，仅记录：想围观任意 bot 房的入口需显式 spectate mode（本作客户端 ?room= 到满员房即旁观，到 bot 房则会让位入席——期望行为，记录为玩法语义供设计知悉）。
- **O-2（低危·测试口径）** HTTP 注入对 shot/pass 的持球窗采样劣势：API 席轮询 120ms vs 持球窗（常 <120ms@8x），shot cmd 到达时球权易已易主（no-ball reject 33 例在账）。服务器同钟 A4（<100ms）不受影响（冻结命令已证）；浏览器臂 A4 实测 868ms 含轮询窗为粗上界。**注记**：QA 时延对齐初版曾测得 shot ~700ms 恒带——实为对齐算法伪影（错配到「下一次注入的受理」=策略 cool 节拍），收紧弃样窗 250ms 后真对齐=1-75ms；两房（d0/d200）伪带同值恰反证 shot 路径与 delayMs 无关。
- **O-3（低危·观测面）** balanced 档对 balanced 对位 steal/tackle 数为 0（站位型对位互相不扑抢），终局 0:0 time-up——观测面分层依赖对位组合。建议 BOT 深化单（GAMES-140+）补 casual-vs-competitive 混跑对位，验证「预判档对蜂群档」的拦截压制数据面。

## 8. 回归抽查 2 作（共享 harness 面）

- `api-check pool-physics`：19/19 绿（共享 testapi/rooms/sims harness 零扰动）
- `api-check mini-moba`：22/22 绿

（结果见 /tmp/qa1-139/reg-{pool,moba}.log；两作均为 S3/S4 先例作，共享面=网关 testapi+快照账本+S4 hash 锚）

## 9. QA 件清单（本单新增，零产品代码改动）

- `scripts/street-soccer-qa1-net.mjs`——net 臂 43 断言（N1-N7）
- `scripts/street-soccer-qa1-web.mjs`——浏览器臂 22 断言（P1-P4）
- 复跑：影子网关 `PORT=4415 HOST=127.0.0.1 GATEWAY_LOG=/tmp/x/gw.log GATEWAY_PID=/tmp/x/gw.pid WEB_DIR=web node server/gateway/index.js &` 后依次跑两脚本（QA_GW 可覆写网关地址）
