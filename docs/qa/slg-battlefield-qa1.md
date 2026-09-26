# 指挥官战场 QA 一号报告（slg-battlefield-qa1）

> 单据：GAMES-44（[QA·E6-W1-T1] 指挥官战场 QA一号 · 单链 3/10+，attempt 0）
> 对象：`games/multiplayer/slg-battlefield/` + `server/gateway/sims/slg-battlefield.js`（GAMES-43 已合入 main 的交付物）
> 立场：**独立复测**——不信任 DEV REPORT 自测，以下全部数据为本单亲测采集。
> 环境：feature/GAMES-44（先 `git merge main`，Already up to date @ e6b2c4b）；网关 :4400 + 平台 :4399 常驻进程；
> 伺服内容与本分支字节一致校验：`/games/multiplayer/slg-battlefield/index.html` shasum `6366b972d02cc588` 双侧相符。
> 证据目录：`/Volumes/BigDisk/Studio/kernel/workers/GAMES-44/`（JSON 8 份 + shots 6 张）。
> 执行日：2026-09-27（本机 LAN，无头 Chromium/Playwright）。

**总裁决：全部红线 PASS，无红线退回项。** 附 2 项 Bot 平衡类质量发现 + 1 项工具链健壮性建议，均建议开 FIX 单（见 §7）。

---

## 1. api-check（五断言 + net-tank 回归）

命令：`node scripts/api-check.js slg-battlefield`（剧本来自 game.json `net.api`：seed=20260926、timeScale=4x、win=macro-push vs 3×casual、lose=idle vs 3×competitive）。证据：`api-check-slg-battlefield-20260926171029.json`。

**slg-battlefield：14/14 全绿，退出码 0。**

| 断言 | 结果 | 实测值 |
|---|---|---|
| P0 网关在线 | ✅ | rooms=4（net-tank×2 + slg×2 BotHost 常驻房，本作上线节奏符合设计 §8） |
| L1 测试面仅本机 | ✅ | 经 LAN 地址 192.168.31.25:4400 实测 403 local-only |
| A1 建房/boot waiting | ✅ | 4 席就绪，API 席 seat=0 human；测试房不进大厅 feed（隔离） |
| A1 boot→live 开赛 | ✅ | started 事件闭环 |
| A4 注入→帧反映 <100ms | ✅ | **39ms**（timeScale=4x，服务端同钟）；状态快照 GET 往返 2ms |
| A5 断线席位保留 | ✅ | 1.2s 断线期内 kind=human 未转 bot |
| A5 凭 token 复席+全量重同步 | ✅ | resume=**1209ms**，welcome 重同步下发，tick 53→92 续玩，全程 <10s 红线窗 |
| A2 能赢 | ✅ | winner=**A**（期望 A）reason=eliminated，tick=720，scores A:236/B:0，墙钟 18.7s |
| A3 能输 | ✅ | winner=**B**（期望 B）reason=eliminated，tick=1378，scores A:192/B:322，墙钟 35.1s |

离散 cmd 一次性语义（GAMES-43 集成坑）在本单 120ms 轮询注入下无重放迹象：A2/A3 终局 tick 与设计预算一致，无"同一条 spawn 逐帧重放"导致的异常快局。

**net-tank 回归：14/14 全绿（A4=16ms、A2 tick=22、A3 tick=23），退出码 0。** 证据：`api-check-net-tank-20260926171132.json`。本作合入未回归基座游戏。

## 2. perf（性能红线：fps / <30fps 帧占比 / 冷启 / 内存）

命令：`node scripts/perf-smoke.js --all --slug slg-battlefield --ms 5000` ×3（`--all` 必带，PILOT_TYPES 不含 multiplayer；每跑自起临时 server + 随机端口 + 隔离 DATA_DIR）。证据：`perf-slg-run{1,2,3}.json`、`perf-slg-extra.json`。

| 红线 | 口径 | run1 | run2 | run3 | **中位** | 判定 |
|---|---|---|---|---|---|---|
| 平均帧率 ≥55fps | 5s rAF 采样 | 58.9 | 60.1 | 59.7 | **59.7** | ✅ |
| 掉帧占比 <2% | perf-smoke 口径 >25ms | 0.7% | 0.0% | 0.3% | **0.3%** | ✅ |
| <30fps 帧占比 <2% | 帧间隔 >33.4ms（quality-pipeline §性能口径） | — | — | — | **0.0%**（599 帧中 0 帧） | ✅ |
| p95 帧间隔 | 参考 | 16.8ms | 16.7ms | 16.8ms | 16.8ms | — |
| 冷启动 <3s | goto→boot 3 轮中位（pageBoot/wall 双口径） | 12/13ms | 13/14ms | 34/35ms | **13ms** | ✅（自包含 92.7KB 单文件、零外链） |
| 内存无持续增长 | CDP Performance.getMetrics，活跃局 60s×13 采样 | — | — | — | 2.46–3.24MB 区间震荡；首 1/3 均值 2.66MB vs 尾 1/3 均值 3.00MB，斜率 0.44MB/min，尾三样本 3.23→2.86→2.70 **回落**；DOM Nodes 40→82 后持平、Listeners 19→21 后持平 | ✅ 无持续增长（GC 正常回收） |

采样期间 sim 推进 633 tick（bot 交战活跃态，非静止页）；整轮零 pageerror。

## 3. net-check 回归 + 本作浏览器面（feed 卡 / 入房 <2s / 旁观）

**net-check 回归（net-tank 主体的三支柱 play E2E）：三跑取证，1 全绿 + 2 跑各撞 1-2 项同源竞态。**

- run3：**25/25 全绿（NET-CHECK OK）**——大厅 21 槽/几何净、入房 44ms、让位 humans=1/bots=3、重连复席、N6 play 四断言、N7 feed 新鲜度 1s、N8 满员旁观、BotHost 补房。
- run1 两败（N2 首卡陈卡竞态）与 run2 一败（N7 目标房自然终局竞态）：均定位为**测试脚本选房/点卡与 net-tank bot 房 5-8s 快速轮换之间的竞态**（网关日志 `room-end` 连环实证：net-4xyub076cc→net-5xwhb68402 每 5-8s 一轮终局）。客户端行为正确（room-gone → 离线兜底横幅），非产品缺陷，非本作引入（feed 按 roomId 字典序 net<slg，首卡恒为 net-tank）。已列工具链建议（§7 T1）。

**本作专属浏览器面（自建脚本，断言 12/12 全绿）**：大厅 feed 渲染本作卡片 2 张（`指挥官战场 · 均衡房 / 2v2-commander / 真人 0 Bot 4 / 加入`）→ 点击 **64ms 可操作**（红线 <2s ✅）→ 在线模式未降级 → bot 让位 humans=1 → `cmd(spawn)` 注入经权威帧回流（镜像 units 5→6，~250ms）+ CP 权威扣减 103.0→83.9 → 3 真人 WS 补满 4 席 → 第 5 连接 role=spectator → feed 1s 内反映 humans=4。零 pageerror。截图：`shots/lobby-slg.png`、`shots/play-slg-online.png`。

## 4. visual（SOP §8.4 v2：几何断言先行 + 中性 prompt 识图）

几何断言（地面真值，headless Chromium `--force-device-scale-factor=1`，375×667）：证据 `visual-geometry.json` + `shots/slg-visual-{battle,result}-375.png`。

- **文档级**：`scrollWidth−clientWidth = 0px`（overflow=0）；全 DOM 元素越界 **0**；canvas 布局盒 (0,0,375,667) 且后备存储 375×667（DPR=1 无缩放残差）。
- **画布三带结构**（墨水带分析，getImageData）：顶栏 60px（底色 [13,16,22]≈#0d1117）/ 战场 500px / 底栏 107px 三带背景分明；y=60 分界行 125/125 采样列有墨；y=560 分界像素 [31,35,41] 与上（战场）下（底栏 #0d1117）均相异。
- **底栏结构**：出兵卡行（y=586..632）恰 **6 块**、宽 56-60px（几何常量 CARD_W=58.7）；技能行（y=632..666）恰 **4 块**、宽 86-88px（SKILL_W=87.3）——设计 §7 识图锚点"6 宫格出兵卡"成立。
- **阵营双色**：战场带琥珀 #E8A33D 60 采样 + 青 #3DC8E8 89 采样（双方单位在场）；顶栏带双色墨水 275/323（双向血条/积分条）。
- **结算页**：DOM overlay display:flex、(0,0,375,667) 视口内；按钮 [再来一局, 战报回放（即将推出·灰置）, 回大厅] 与设计 §7 一致（回放灰置预留 VIS 单链 #9）。

视觉模型（glm 系）中性 prompt 判读：三带布局/顶栏双色血条/双信号塔 Alpha·Bravo/6 出兵卡/4 技能钮名称与能量（火力覆盖60/紧急维修40/空降突击70/集结号令50）全部与几何真值一致。**一处冲突已按协议裁决**：1× 图上模型读"狙击 80CP/军医 95CP"，与 sim 权威（UNITS 表 T1：60/35）冲突 → 3× 放大重读得 60/35 与权威一致 → 判定为 8px 小字 OCR 级误读，非 UI 缺陷（几何/权威优先）。裁决留档：`shots/slg-cardrow-3x.png`。

## 5. Bot 三档差异实测（设计书 §4 参数真实性）

方法：`/api/test/*` 隔离房，`[null, T, T, T]`（API 席 seat0 属 A 队跑 macro-push 参考策略——与 api-check A2 同源），timeScale=4，每档 3 局；逐帧记账 bot 席 cmd 流（首行动 tick/决策间隔/兵种直方图/研究/技能），另跑克制探针局（API 席 razor 铺场制造敌方众数 mode=razor）。证据：`bots-{casual,balanced,competitive,competitive-probe}.json`（含 rawCmds + 每 100tick CP 轨迹）。

**行为参数表（三档 vs 设计 §4）——参数真实生效：**

| 指标 | 设计值 | casual 实测 | balanced 实测 | competitive 实测 |
|---|---|---|---|---|
| 首行动 tick | 150 / 30 / 8 | **≥150**（150-700，含攒钱等待） | **=30**（9/9 席全部精确 30） | **=8**（9/9 席全部精确 8） |
| 决策间隔 | 50 / 20 / 10 | 50（执行动作间距 ≥50） | 20（动作间距 100-220 受购买力门控） | 10（medGap 10-60，快攻密集） |
| 出兵决策量（cmd 数/席/局） | — | 2-7（被动） | 7-16 | 19-21（最勤） |
| 兵种选择 | rng 均匀 / 轮换 inf→razor→arty / 克制表 | 全池随机（sniper/medic/arty/razor/inf 都出现） | inf 为主的轮换（razor/arty 被购买力截断） | **纯 inf**（克制表被饿死，见 F2） |
| 研究 | 从不 / tick600 起 T2 / T200 T2（经济门控） | **0/9 席**（从不 ✅） | g3 三席 T2 完成 @tick 1310/1610（600 起攒 150CP 的经济时滞） | T2 完成 @tick 1028（400 起门控；短局敌席未及完成） |
| 技能 | 30% 随机 / 条件放 / 全条件 | 随机 repair/surge 出现 ✅ | barrage/surge/repair 条件放 ✅ | repair/barrage/drop 条件放 ✅ |
| 车道 | rng / 两道轮换 / 最弱道 | 随机 0/1/2 ✅ | 0/2 轮换 ✅ | 最弱道+抢点 rally ✅ |

**胜负比（vs macro-push 参考策略，A 队=参考策略+同档队友）：**

| 档位 | 局数 | A 胜 | 终局 | 备注 |
|---|---|---|---|---|
| casual | 3（另 3 局先导跑 2胜1负） | 3/3 | eliminated@774 / score@1130×2 | 首跑败局系我方 casual 队友掷中 heavy 死锁（F1），实为 1v2.5 |
| balanced | 3 | 3/3 | score@1310×2 / score@2040 | 有来有回但决策慢半拍，积分通道败 |
| competitive | 3（+探针 2） | 3/3（+2/2） | score@1240-1250 / 探针 eliminated@711 | **razor 铺场即可推平竞技档**（探针局） |

同 seed 复跑各席 cmd 流逐条一致（bot rng 流房间 seed 派生、策略确定性）——bot 侧行为可复现。

**发现 F1（casual·heavy 攒钱死锁）**：casual 掷中 heavy 后 2×闸门=220CP **> CP 上限 200**（设计 §1.2），且 `wanted` 仅在成功出兵后重掷 → 该席永久挂机（CP 顶死 200000、整局 spawned=0，仅随机技能）。实测 bots-casual g3 seat2 CP 轨迹 132.6k→200k 顶死、rawCmds 仅 2 条 repair。9 席样本出现 2 次（同 rng 流跨跑复现）。

**发现 F2（三档强度无梯度 + 克制表不可达）**：三档对参考策略全败 0/3，competitive 亦被积分通道推平（让出双信号塔 ~100s 无反制——retower 逻辑仅覆盖"己方持有后被夺"，从未持有则永久弃塔）；克制出兵被"有 CP 即花"参数互锁饿死：5 局 competitive 合计 **0 次非 inf 出兵**（克制目标 razor 45CP/arty 70CP 在 2CP/s 收入下永不可攒），razor 铺场探针（mode=razor→应出 arty）三席仍纯 7×inf、且被 razor 克 inf ×1.5 反向推平。sim 克制表本身工作正常（战斗结算正确），是 bot 决策参数的互锁问题。

## 6. 确定性抽检（S1 纪律）

方法：网关录局（seed=20260926、三档混编 [null, casual, balanced, competitive]、四类 op 帧预约注入 spawn/rally/skill/research 共 10 条）→ 1062 帧输入日志 → 三方重放比对。证据：`determinism.json`。

| 检查 | 结果 |
|---|---|
| B) 本地 sim.cjs 同日志重放 ×2 | 终局 serialize **逐字节一致**（2360 字符）✅ |
| C) 服务端终局 vs 本地重放 | **逐字段深比对 0 差异**（tick=1062、winner=A、reason=eliminated）✅ |
| D) 浏览器内联 SLGSim（index.html 构建期内联副本）vs sim.cjs | 终局 serialize **逐字节一致** ✅ |
| 终局指纹 | fnv/sha256 前 16 位 `cc410d3115cf4a1d`（三方相同） |
| 静态纪律（§5.2） | create/step/execCmd 判定路径 grep `Math.random\|Date.now\|浮点字面量` 零命中（命中均为注释）✅；Q8 定点乘子/全序 tie-break/固定结算序经代码走查与 §5 重放双重印证 |

**结论：同 seed 同输入剧本连跑，终局状态逐字段一致——S1 确定性红线 PASS。**（重放即"确定性回放"机制的等价抽证，回放 UI 预留 VIS 单链 #9。）

## 7. 退回项清单与 FIX 建议

**红线退回项：无**（§1-§4、§6 全部红线 PASS；§5 为参数真实性核验，非红线门禁）。

**质量发现（非红线，建议开 FIX 单）：**

| # | 级别 | 条目 | 证据 | 复现步骤 |
|---|---|---|---|---|
| F1 | 中（玩法平衡） | casual bot 掷中 heavy 即永久死锁：2×110=220CP 闸门 > CP 上限 200，wanted 不重掷 → 整局零出兵、CP 顶死，被当"软柿子"或坑队友（先导跑 macro-push 因此 1/6 败给三休闲） | `bots-casual.json` g3 seat2 cpTrace/rawCmds；`sim.cjs` casual 分支（wanted 门控） | 建隔离房 `[null,casual,casual,casual]` seed=20260977，观 seat2：CP 至 200000 顶死、spawned=0 |
| F2 | 中（玩法平衡） | 三档强度对会玩目标的对手无梯度（competitive 也 0/3 被积分通道推平）；克制出兵表实测不可达（"有 CP 即花"永攒不够 45/70CP 克制兵，5 局 0 次非 inf 出兵）；competitive 弃塔无"从未持有"反制分支 | `bots-{competitive,competitive-probe}.json`；razor 铺场探针 2/2 推平竞技档 | 建房 `[null,competitive,competitive,competitive]`，API 席只铺 razor → ~711 tick 被 eliminated；或纯占塔流 → ~1250 tick score 400 胜 |

**FIX 建议方向**（供 FIX 单参考，本单不修代码）：F1 将 casual 攒钱闸门改为 `min(2×cost, CP_MAX−ε)` 或闸门不可达时重掷 wanted；F2 给 competitive 增加"短暂储蓄窗口购买克制兵"与"未持有信号塔的持续争塔"分支，或克制兵支付档降级（inf 先出、攒够换克制）。

**工具链建议（不阻塞交付）：**

| # | 条目 | 说明 |
|---|---|---|
| T1 | net-check 选房/点卡竞态 | N2 首卡与 N7 目标房撞 net-tank bot 房 5-8s 自然轮换（陈卡/临终房），三跑两撞。建议：点卡失败自动换卡重试、N7 目标房选 slg（对局长，房间稳定）或加"临终房过滤"（elapsedMs 阈值）。非本作缺陷、非本作引入 |

**SOP/协议观察（无需行动）**：设计 §4 绝对 tick（如 competitive tick200 研 T2）与实现的资源门控时滞（实测 1028+）符合 GAMES-43 已知结论"设计书时间轴是顺序与风格不是字面"；本报告数据均以实测 tick 记录。
