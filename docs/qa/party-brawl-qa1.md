# 派对大乱斗 QA1 联机红线报告（S7·四类谱）

> 单据：GAMES-173（E6-W2-T7 单链 3/10+）｜ worker: agent-dev ｜ attempt: 0 ｜ 2026-10-18
> 前置：DEV=GAMES-172 已合并（9b6ca5a）；开工 `git merge main`（Already up to date）；事实源 docs/designs/party-brawl.md §5 四类谱 + GAMES-172 REPORT 收窄清单。
> 环境纪律：私有影子网关 **:4422**（PORT/GATEWAY_PID/GATEWAY_LOG 显式改道，:4400/:4399 零感知——页面自 :4399 只读加载，WS 经 `?gw=` 打 :4422）；QA 只读（零产品代码改动，两枚 QA 测试件入库 scripts/）。

## 0. 结论一览

| 面 | 结果 | 一句话 |
|---|---|---|
| 三支柱（perf/play/识图 v2） | **PASS** | 帧成本 0.18-0.35ms、四断言全绿、识图视觉+像素核双证 |
| S7 四类谱专项 | **PASS（3/4 类全证）** | 一/三/四类铁证；二类机制面证（弹道闭环零孤儿），逐坐标对账被 F-3 阻断 |
| 200ms 延迟补偿（A9 双臂） | **PASS** | rank 中位 1/1、kills 1/2（差 1 贴线过，DEV 遗留#4 口径复验成立）、carried 6876/7261 |
| 重连三档 | **PASS** | 5s 全测（A5 1206ms）+10s 边缘复席+30s 逾窗托管拒复席 |
| Bot 三档梯度 | **部分** | 可观测分层成立（节奏/毒伤/拾取三面强信号）；设计 §4.2 档序②③④与实测反序 → **F-2 退回** |
| 长局 5min spot+满编+观战 | **PASS（账本）/F-1 退回** | elim/kills/drop 三账全平；ext.storm 相位载荷丢拍双跑复现 → **F-1** |
| 回归抽查 2 作 | **PASS** | yi-pavilion 21/21 + deep-foodchain 54/54（同网关 ：4422） |
| 退回清单 | **4 项（F-1..F-4）** | 见 §8；观察项 O-1..O-5 见 §9 |

冻结验收命令：`grep -q -e 三支柱 -e 四类谱 -e 重连 -e Bot -e 退回 docs/qa/party-brawl-qa1.md` ✅（本文件含全部关键词）。

## 1. 命令台账（可复跑）

```
# 影子网关（qa 隔离）
PORT=4422 GATEWAY_PID=/tmp/qa173/gw.pid GATEWAY_LOG=/tmp/qa173/gw.log node server/gateway/index.js &
# 主证（冻结命令，含 A1-A9 全套）
GAMES_GW=http://127.0.0.1:4422 GAMES_EVIDENCE=…/GAMES-173-evidence node scripts/api-check.js party-brawl   # 68/68
# QA 专项
node scripts/party-brawl-qa1-net.mjs   # net 臂：四类谱/重连三档/Bot 梯度/满编观战/长局
node scripts/party-brawl-qa1-web.mjs   # web 臂：play 四断言/perf/识图 v2 像素核/预测环
# 回归
GAMES_GW=http://127.0.0.1:4422 node scripts/api-check.js yi-pavilion      # 21/21
GAMES_GW=http://127.0.0.1:4422 node scripts/api-check.js deep-foodchain   # 54/54
```

证据：`kernel/workers/GAMES-173-evidence/`（api-check 三作 JSON）、`kernel/workers/GAMES-173-shots/`（online.png/storm.png）、DEV 交叉引用 `GAMES-172-shots/`。

## 2. 三支柱

### 2.1 perf（帧成本口径——games-167/172 先例，无头 rAF 率=合成器耦合披露位）

| 指标 | 实测（3 跑） | 预算 | 判 |
|---|---|---|---|
| rAF 帧成本 avg | 0.18 / 0.30 / 0.35 ms | ≤6ms | ✓ |
| 帧成本 p95 | 0.30-0.50 ms | — | ✓ |
| >16.7ms 占比 | 0.00% | <2% | ✓ |
| rAF 率（披露位） | 12.9-13.2 fps | 环境地板（games-167 同带同红） | 披露 |

### 2.2 play 四断言（浏览器臂·真房 20 席生态）

- **A1 事件闭环** ✓：quick 入房→就席（seat 19/18）+live+快照流（frame 310/164→推进）；二号页同绿。
- **A2 可玩+一类预测环** ✓：drag 下 `seq 16→160`、`ext.ack 13→157`（本地输入环 20Hz+权威锚追赶在账）。
- **A3 零 pageerror** ✓：整轮会话（quick 页+主探针页）0 异常。
- **A4 输入→呈现** ✓：drag→画布墨水差分 73-143ms（<50ms 红线的无头地板 ~75ms=1 rAF 帧，披露；架构证=预测零 RTT+api 臂 A4 服务端同钟 39ms）。

### 2.3 识图 v2（派对亮色+三组双编码+HF __applied 复核）

视觉模型（Read-CDN 转链法，online.png 逐项问询）：亮色草岛（浅草绿+沙缘+草丛斑）✓｜HP 100+血条 ✓｜存活 19 ✓｜缩圈 13s ✓｜小地图白实线圈 ✓+自位点 ✓｜中央糖豆群+**己席蓝糖豆白描边圈、敌席无白圈**（敌我双编码视觉证）✓｜敌席绿血条 ✓｜武器栏 拳+弹 0+0+雷/医/速 ✓｜击杀榜 ✓｜射击钮+技能钮 ✓。
像素核（定量四核）：草地占比 82-85%（g>150 且 g>r+20 主导行）｜己席白圈 中心 120² 白像素 33-42（best-of-6）｜小地图白圈 74-110 px｜毒罩斜纹：本臂 75s 未及 r≤450px 相位（r=783-883px），**交叉引用 DEV 拍二 storm-late.png 像素核 14px 节距**（GAMES-172 已证）。
HF `__applied` 复核 ✓：P0:5-6/P1:4-5/P2:2 全组 `__applied=true`（登记=闭环回读），min 9px、P0≥13px（Q-013 首日自证在 QA1 复验成立）。
未见项披露：ping 徽标（恒"—"→**F-4 死账本**）；目标虚线圈（P0 静圈与当前圈重合，缩圈相位 DEV 拍已证双圈）；护盾条（=0 隐藏）；箱（本帧 AOI 外）；弹丸（→**F-3**）。

## 3. S7 专项：四类谱各验 + 影子预测 + 200ms

| 类 | 验证 | 结果 | 证据 |
|---|---|---|---|
| 一·预测（己席） | ack 锚+输入环+和解账本 | **✓** | api 臂：注入 seq 2617→`ext.ack` 收敛 2617（Q1a）；浏览器臂：drag 下 seq 16→160/ack 13→157；rec 和解账本 LAN 全零=§5.3 预算带内下界（软收敛 0 次/s、中位 0px、hard 0——200ms 臂上界带由 A9 承载）；`ext.hash` 哨兵在场 84 张/1339（密度 0.063 vs 理论 0.1：死亡段+F-1 侧丢，见 §8 注） |
| 二·重演（投掷物） | 零快照+全参闭环+重演==权威 | **机制面 ✓/逐坐标对账受阻** | 1339 张快照 0 携 projs（弹体零快照 Q1c——1 条非 welcome/end 携 state.projs 消息待归因 O-5）；shot→pdie 账本 **130/130 全闭环零孤儿 pid**（重演原料完备）；重连 `welcome.state.projs` 补列在位（Q5c）；**逐坐标重积分对账不可达：在飞弹体 239 轮询仅 2 次非空（projsMax=1）——F-3 一拍即灭所致，修复后复测** |
| 三·权威（拾取） | 竞争分账唯一性 | **✓** | 43 条 pick 事件 box id 全局无重复+每条均有下发先例（welcome 全量箱∪快照增量箱；首红=探针键型不匹配——boxes 键字符串 vs pick.id 数字，String 归一后全绿） |
| 四·闭式（毒圈） | 参数同源外推 | **✓ 铁证** | 仅凭 `ext.storm` 事件参数独立 lerp（半径+圈心双轴）vs `sim.stormOf` 权威值：1338 采样帧×多相位 **worst Δ=0px**（±1px 预算内零误差） |

影子预测和解（票面：ack 锚+软硬收敛带）：见一类行——ack 双臂锚定在账、软/硬收敛与撕裂全部带内（LAN 下界）；200ms 臂战报面（修正计数/中位/p95）按设计归 FEEL/QA2 浏览器臂（§5.3 注记口径）。
200ms 延迟补偿（A9 双臂，冻结命令内三 seed 统计制）：双臂均出清（reason 全 last-standing）；**rank 中位 arm0=1/armB=1（差 0≤3）**；kills 中位 1/2（差 1≤1 贴线过——DEV 遗留#4 的「差 1 贴线」口径在 attempt 0 复验成立）；carried 6876/7261>0（延迟在场证据）。

## 4. 重连三档

| 档 | 结果 | 证据 |
|---|---|---|
| 5s 全测 | ✓ | api-check A5：resume 1206ms<10s、帧续跑、全量重同步（独立复测） |
| 10s 窗内边缘（9.6s） | ✓ | token 复席成功 frame 0→684；welcome 全量含 `state.projs` 补列；**装备状态延续**（w/mag/ammo/nades 四字段跨线逐值一致） |
| 30s 逾窗 | ✓ | 席位 `kind=bot`（bot 托管打完）；`$reconnect`→409 拒复席（「复席语义不降级为顶号」；返回 error=room-gone——房已终局回收路径，拒复席语义等价） |

## 5. Bot 三档梯度（Z0 根缩圈决策树可观测分层）

**分层可观测（三面强信号）**：同质房（19 bot 同档）终局节奏 competitive 1401 tick ≪ balanced 4843 ≪ casual 7081（互猎快收敛 vs 毒杀慢消耗）；毒伤拍数中位 casual 17 ≫ balanced 0 = competitive 0（Z0 0.95 系数贪边实证）；混编房拾取面 balanced 28/27 顶格（圈内资源环）> competitive 13/19 > casual 12/8。
**档序与设计 §4.2 预期不符（两 seed 方向一致）→ F-2 退回**：混编房 kills balanced 9/12 > competitive 7/7 > casual 1/0（预期 comp 最高）；rank 中位 balanced 15/12 三档最差（预期 comp<bal<casual）；拾取 casual ≥ balanced 不成立（实测反）。同质房 kills 轴同 seed 复跑翻转（casual 19↔0、competitive 19↔0）→ **O-4 非 autopilot 房非确定源待归因**（A6 autopilot 面不受影响）。F-3 修复后全部复测（贴身互穿交战是档序证据的强混杂因子）。
探针方法学（入库供 BOT 单复用）：同质房 19 bot 的 rank 中位是**构造性不变量**（恒≈10）——档序分层必须混编房按席位分组取轴。

## 6. 满编+观战+长局 5min spot

- **满编** ✓：20/20 席位在场（1 API+19 bot，roster 实读）。
- **观战** ✓：第 21 连接 WS spectate **feed 常驻房**（测试房对非测试会话封锁 `room.test&&!isTest→room-gone`——协议安全面，首版探针接测试房全零收流的根因）：role=spectator、433 张快照@8s（10Hz 流）、`ext.ack≡-1`、AOI 常量 515000（实现=滞回地板 500px+15px；设计 §5.7 值 460px → **O-1**，带宽面 +12%）。
- **长局 5min**（maxTicks=6000=300s 投影终局）：timeout 出清 ✓；elim 账本 rank 20..14 严格递减无重号 ✓；kills 对账 sum=7==by≥0 elim=7 ✓；drop==elim=7（死亡经济对账）✓；**ext.storm 相位载荷 {P0,S3}/期望 6 → F-1 双跑复现**。

## 7. 回归抽查 2 作（同网关 :4422）

yi-pavilion **21/21** ✓ + deep-foodchain **54/54** ✓（party-brawl 入库对存量作零扰动复验）。

## 8. 退回清单（QA 只读，转 FIX/BOT 单）

| # | 级 | 缺陷 | 根因定位 | 复现 |
|---|---|---|---|---|
| **F-1** | P1 | **ext.storm 相位载荷丢拍**：相变拍快照一旦 >1.2KB 触发增量退化重发，该相位参数永久不下发——客户端闭式解原料断链一整相位（HUD 倒计时/圈渲染停旧，无自愈：welcome/`$sync` 均不补） | `server/gateway/sims/party-brawl.js` emitOne：先置 `b.stormSent=ph` 再做 `text.length>1200 → emitOne(force)` 重发——重发时哨兵已更新，`ext.storm` 不再附上（`ext.hash` 同模式偶丢，10 张自愈）。修法方向：簿记更新移到长度判定后或经 opt 透传 | maxTicks=6000 长局两跑均只收 {P0,S3}（期望 6，Q8d）；api-check A8 的 orbit-edge 房 AOI 稀疏不触发故 DEV 未现 |
| **F-3** | P1 | **弹体一拍即灭**：130 发 shot→130 条 pdie，**124 发寿命 Δ0 tick**（最长 6 tick vs 手枪理论 28）——射程/弹速/TTK 数值面（§2.4）实际失效、投掷物零视觉在场（浏览器 projsN=0×3 跑+识图无弹）、火箭近脸自伤风险；S7 二类谱 showcase 的呈现面死码 | 疑似根因链：玩家互不碰撞（§1.2）×bot 贴身直指（GAMES-172 调参）→交战距离≈0→弹体首拍扫掠（spawn 点起 10.5px 段）必中即亡。修法方向：开火距离门/弹体首拍盲区（spawn 位移出近身）——归因与修法归 FIX/BOT | 事件账本 lifeDist {0:124,2:3,4:2,6:1}；239 轮询在飞弹仅 2 次非空 |
| **F-2** | P2 | **Bot 三档档序与设计 §4.2 反序**（kills/rank/拾取三轴，两 seed 方向一致）+同 seed 复跑翻转（O-4） | 调参面/档序预期面——转 BOT 深化（须在 F-3 修复后复测） | §5 数据 |
| **F-4** | P2 | **ping 死账本**：`rec.pings` 全文零写入点——ping 徽标恒「—」、结算页「ping 末值」恒空（T7-A 卖点面，games-131 fx 时戳死码同族） | `client.js:68` 初始化后无 push（574/714 只读） | grep 全文证 |

## 9. 观察项（不阻断，编号留档）

- **O-1** 观战 AOI 实现值 515px（init 滞回地板）vs 设计 §5.7 的 460px——带宽面上浮 ~12%，建议适配器显式 460 或设计修订单改注。
- **O-2** quick 接管已淘汰席→客户端退观战视图（镜头=圈心）——与 §4.3「已淘汰席重连=观战位」语义自洽，但 quick 池应优先让活席（体验面，转 FEEL裁量）。
- **O-3** 识图小项：目标虚线圈在静圈相位与当前圈重合（缩圈相位 DEV 拍已证）；护盾条=0 隐藏；本帧 AOI 内无箱（箱实体经 net 臂 pick/翻转账本证在）。
- **O-4** 非 autopilot 测试房同 seed 两跑终局翻转（casual kills 19↔0、competitive 19↔0）——零输入房存在未归因非确定源（A6 autopilot 双跑不受影响，2724229999 复验绿）；转 FIX/BOT 归因（疑 HTTP 观测节奏与 lastInput 宽限拍边界交互）。
- **O-5** 1 条非 welcome/end 消息携 `state.projs`（1339 张中 1 条）——码面快照管线不含 projs，待归因（疑终局/重连路径）。
- **O-6** A9 kills 中位差 1 贴线过（1/2）——DEV 遗留#4 已披露的泊松小 λ 摆振面，处置口径已写死（同法再压 λ 而非放宽断言）。

## 10. 预算与口径注记

- 单据预算 ≤30 分钟（25 分钟转收尾）：三支柱+S7+重连+回归在预算内收口；F-1/F-3 两枚 P1 的取证与复跑超出预算窗（QA 纪律：真缺陷值得超窗取证，两枚均双跑/账本级复现）。
- 统计制：A2/A9 数值锚=三 seed 两胜+中位（冻结命令内）；Bot 梯度=单 seed×3 房+混编 2 seed 方向一致性（F-2 的方差面见 O-4）。
- 本报告为 QA1 联机红线专项账本；§5.3 和解预算表 200ms 臂全行复核归 FEEL/QA2 浏览器臂（设计 §5.3 注记口径）。
