# 深海食物链 QA1 联机红线专项报告（GAMES-165）

| 项 | 值 |
|---|---|
| 单据 | GAMES-165（[QA·E6-W2-T6] 深海食物链 QA1 联机红线专项（S6·吞噬裁决）3/10+）attempt 0 |
| 分支/基线 | feature/GAMES-165 @ merge main=0d5382d（DEV=GAMES-164 单链 2/10+，goal 双条件成对绑定已收红） |
| 环境 | 私有影子网关 :4421（PORT/GATEWAY_PID/GATEWAY_LOG 显式改道，:4399/:4400 零感知——页面自 :4399 生产 web 只读加载）；无头 chromium（playwright）；剧本房 seed=20261017；TCP 延迟代理 :4431（每向 100ms） |
| 测试件 | scripts/deep-foodchain-qa1-net.mjs / -web.mjs / -bot.mjs / -full.mjs（QA 只读纪律：零产品代码改动，四件均为测试件） |
| 证据 | kernel/workers/GAMES-165/{net-evidence,web-evidence,bot-evidence}.json + GAMES-165-shots/（p1-quick.png + p3-debug-{0,3}.png）；门禁 JSON GAMES-41/api-check-deep-foodchain-20261016235554.json |

## 一、结论总览

- **红线判定：通过（退回清单 0 项）**。三支柱、S6 专项（海量实体/吞噬裁决权威/质量守恒/K1.25 边界/AOI 体型分级/200ms 延迟）、重连三档、Bot 三档梯度、长局 spot+满编+观战全绿。
- 冻结门禁独立复跑：`node scripts/api-check.js deep-foodchain`（影子网关）**54 通过/0 失败 exit 0**。
- 回归抽查 2 作：snake-king（S6 首证）**44/44**、yi-pavilion **21/21**。
- 观察项 **O-1..O-4**（§七）；本单 5 处脚本侧假红复盘留档（§九，皆测试件口径错非产品缺陷）。

## 二、三支柱

### 2.1 perf（P2）——绿
- 帧成本口径（rAF 回调执行耗时，免疫无头 vsync 封顶——games-155 先例）：**avg=0.21ms p95=0.3ms n=140**（红线换算 <16ms≈≥55fps 预算，余量 ~76×），掉帧率（>25ms）**0%**（红线 <2%）。
- 采样面=quick 真实活局（20 鱼房+粒+HUD+小地图密度点在跑）。对照带 blank n/a（无头 about:blank rAF 饥死，O-2 披露；yi-pavilion QA1 同况先例）。

### 2.2 play 四断言（P1）——绿
- **A1 事件闭环**：quick 秒进 swarm 房 welcome 就席（两次运行 seat=20/19，round=2 常驻房中途入局按剩余轮计），mode=playing+AOI 全量快照 ents=201；S6 声明块 `welcome.room.fish`（engine=deep-foodchain-sim#1，K=1.25，cap fish24/site180/drop240/M4000）。
- **A2 可玩**：摇杆拖动→**权威位姿收敛**（cam 沿拖向持续位移 385235,142067 mpx≈385px/1.5s——服务器快照驱动的镜头锁身闭环，非本地幻影）；群生态在场（全房密度点 mm=20/21）。
- **A3**：零 pageerror（quick 活局+debug 渔场整轮）。
- **A4 操控响应**：drag→cam 收敛 <1.5s（LAN 口径；<100ms 服务端同钟由冻结命令 A4 交叉引用：实测 **31ms**@ts3）。

### 2.3 识图 v2（P3，?debug=1 幽灵渔场——同渲染路径）——绿
- **深海军绿底**（票面指定 #061410→#0C2B1E 纵向渐变）：行中位法 top=rgb(7,23,18)→bot=rgb(14,49,36)，上暗下亮+G 通道主导（军绿色相）。
- **四档形色双编码**：T0 淡青 #8FD8C8 / T1 银蓝 #6FA8FF / T2 灰蓝 #5C7A99 / T3 深蓝 #3D5A80 像素核峰值 **549/233/402/34px**（4 载累积；幽灵位随机+LOD 远端淡化，T3 偏薄见 O-3；形通道深度核验留 VIS 单）。
- **食物三色资源语言**：荧藻青 #7FE8D8=51px/磷虾粉紫 #C98FE8=41px/晶簇金 #FFD700=82px（跨作同语义暖橙尸粒归 QA2 观测）。
- **小地图 20 密度点**（Ø96 全房实时——巨房卖点 HUD 内显）：mm=20。
- **HF `__applied` 生效自证**（票面首日断言位）：`__applied=true`（登记值==ctx.font 回读值闭环，Q-013 前置清偿成立）；分级 **P0=13/P1=11/P2=9** 全达标。

## 三、S6 专项

### 3.1 海量实体实证（Q1）——绿
秒配：首拍活鱼=20（bot 开场即 live，feed 恒 live）；资源位 180（荧藻 120/磷虾 40/晶簇 20），首拍已被吃 26 位（进食活性侧证）；活鱼下界采样 min=20；实体三顶声明块在场（§2.2 A1）。

### 3.2 吞噬裁决权威（QA 独立复跑，Q2/Q2b/Q3）——绿
- **一裁三账逐条对账**：满轮 2min 混编房 **devour×29 全对**（gain==floor(mv×11/20)、drops==clamp(ceil(dropT/2),3,30)；首例 mv=38 gain=20 drops=9）；冻结门禁 hunt 三 seed **15/25/19 例全对**；长局 5min devour×83。
- **质量守恒残差 A8**：满轮+长局 30 采样+重连三档后+门禁 10 局终态，**残差全 0**（终态账本例：ΣM+Σ粒+expired(7721)−endow(2040)−ate(3632)−gained(2936)−dropped(2938)+dashed(481)=0——吞噬转移在账本内自消）。
- **K=1.25 临界定档双向**（离线 sim 直驱+纯函数表）：
  - 纯函数表全扫 rV 8-43 共 36 档：临界 rM=ceil(5×rV/4) 恰可吞（≥ 语义含等号）、−1 不可吞；
  - **活体临界对** r10/r8（M60/M22 同点接触）devour×1 by=猎手（正向临界成立）；
  - **逆向恒不成立**：canSwallow(8,10)=false（K>1 互斥——A 可吞 B ⇒ B 必不可吞 A）+等体互穿透；亚临界 1.125× 同点接触零吞噬双活（无墙死佐证）；
  - **定档滞回**：升档即时（M 达上界）+降档带下界×0.95 恰留档（285/950/76 留，284/949/75 降）——13 锚全对，dash 掉质量不抖档。
- **开局吞噬空窗的行为侧证**：首 10s devour×0（全场 M=20 等体互不吞——K>1 互斥的生态学显现）。

### 3.3 AOI 体型分级（Q4，离线 emit 直驱）——绿
- **视野半径随体型单调**：ext.aoi.r 逐档 **380<440<500<560px**（机制/带宽/Bot 三面同源表，"档即视野"）。
- **15px 滞回带双向**：探针移出 rr+margin 入带内（+8px）不踢；出带（+16px）`leave:[id]` 淡出——边界抖动防线在场。
- **观战位 r 固定 460**（镜头点订阅，不占实体预算）。

### 3.4 200ms 延迟补偿（Q7，TCP 每向 100ms 代理+真 WS quick 房）——绿
快照节拍 **n=321 med=102ms max=110ms**（10Hz 无停摆）；**ack 回执 299ms** 首达（含双向 200ms 代理，闭环成立）；**转向收敛双段**（目标 200° 收敛后换 20° 仍收敛，末拍距目标 0°——连续模拟量转向 200ms 只造成曲线差）；事件流照常（eat×172 devour×9）。

## 四、重连三档（Q5，timeScale=1 真秒）——绿

| 档 | 断线窗 | 复席 | 状态延续 | 账本 |
|---|---|---|---|---|
| **5s 全测** | 5s | welcome 复席 ✓ | skin 恒同 0、kills 0→0、score 口径恒成立（M 轨迹 20→21） | A8 残差 0 |
| **10s 窗内（边缘 9.3s）** | 9.3s | welcome 复席 ✓ | M 21→22、口径恒成立 | A8 残差 0 |
| **30s 逾窗** | 31s（bot 接管） | 重连**夺回** ✓ | M 22→29（托管期照常觅食成长——「回来看战果」语义）、score 5→7 | A8 残差 0 |

- 三档断线期间**席位鱼恒活**（dead=0——世界不因掉线缺鱼）；质量/体型状态经 welcome 全量快照延续（点实体无 path 恢复轻）。
- 冻结命令 A5 交叉引用：席位保留 kind=human、resume **1211ms** 全量重同步、断线→复席 <10s 红线窗。

## 五、Bot 三档梯度（Q6，体型键控四问树可观测分层）——绿

满轮 2min 混编房（3 comp/6 bal/10 cas，补测件 deep-foodchain-qa1-bot.mjs——首跑字段口径教训见 §九）：

| 观测面 | competitive | balanced | casual | 断言 |
|---|---|---|---|---|
| 吞噬数 kills | **17** | 5 | 7 | comp>cas ✓（Q2 猎物评估+拦截闭式解 vs 恒空） |
| 死亡数 deaths | 3 | 7 | **14** | cas>comp ✓（饲料位弱避险 vs 猎手规避） |
| dash 采样 | 14 | 17 | **0/617** | casual 恒不 dash ✓（质量换速度是猎/逃技） |
| 末位平均档位 | 0.51 | 0.57 | 0.32 | comp≥cas ✓（bal 最高见 O-4） |
| eat 事件 | 332 | 777 | 689 | 密度场觅食可观测（披露位） |

## 六、长局 spot 5min+满编+观战（Q8/Q6f）——绿

- **长局**（ts2×5min=6000 tick，跨 1 轮界）：**round rollover** round.n 1→2+**crown×1**（房不 ended 恒 live——轮入 state 语义）；devour×83；A8 残差 30 采样全 0；活鱼 min=17（O-1 观察项）；排行榜全程一致（top10 非增+榜首 argmax——修正口径后构造性成立，门禁 A6 独立证 2528-2742 抽样/局 0 违例）。
- **满编**：24 连接 play 全部就席（seats=24 硬顶内，bots 全让位——humans≤24 实体红线恒守）；**第 25 连接 play→观战位承接**（role=spectator、mySeat=-1 不顶号不崩、快照流+ext.lb 下行）；**显式 spectate join→spectator**（AOI r=460 固定，观战不占实体预算）。

## 七、退回清单与观察项

**退回清单：无（0 项）**——QA 只读，本轮零产品缺陷红线。

- **O-1 长局瞬态活鱼 17**（<19 口径线）：5min 长局 30 采样 1 次跌至 17（3 尾重叠 3s 重生窗的瞬态；1.5s 内恢复）。冻结门禁 full20 场景 min=20 通过（3/3）；红线「20+ 实体稳定」绝大多数采样成立。建议 QA2/STRESS 观测重生窗重叠率，无需修复。
- **O-2 perf blank 对照带 n/a**：无头 about:blank rAF 饥死（15s/25s 双超时均降级）；帧成本法为主证（yi-pavilion QA1 同况先例）。有头环境复测留 STRESS。
- **O-3 T3 深蓝色通道峰值 34px**（四档最薄）：debug 幽灵渔场 T3 仅 3/20 尾+LOD 远端淡化+镜头随机；颜色通道在场可辨但弱，形通道（宽巨形+金描边）深度核验留 VIS 单。
- **O-4 balanced 平均档位 0.57 ≥ competitive 0.51**：comp dash 燃烧（dashed 481）+追击质量成本所致；设计断言口径 comp≥cas 成立（0.51≥0.32），「三档=生态位不是难度条」的自洽佐证，非缺陷。

## 八、回归抽查与冻结验收

- 回归抽查 2 作（影子网关）：**snake-king 44/44**（S6 首证，`deep-` 前缀 feed 排首不影响其断言）、**yi-pavilion 21/21**。
- 冻结验收命令（本单 DoD）：`git grep --all-match -e 三支柱 -e 吞噬裁决 -e 质量守恒 -e 重连 -e Bot -e 退回 -e O- -- docs/qa/deep-foodchain-qa1.md` → 命中本文（关键字全部在场，见 §一/§三/§四/§五/§七）。

## 九、假红复盘（测试件口径错 5 处——工程留档）

1. **testapi 原始 state 字段≠快照字段**：鱼档位原始 state 是 `.tier`（`fishFull` 快照路径才映射 `.t`）——按快照名读原始 state 得 NaN（Q6 首跑）。
2. **async 采样器收口竞态**：Q6 收口早于后台采样器终局（105s vs 128s）→ 台账截尾全零；收口须 await 采样器完成标志。
3. **排行榜长度口径**：state.leaderboard 为 **top10**（HUD top5+tap 展开），非 ≤5——判据写窄 30/30 假红。
4. **食物密度「初始全 on」时序错**：首拍已被吃 26 位（进食活性），断言应为觅食后在场率非初始全量。
5. **emit 离线直驱的连接形状**：网关 seat.conn 是包装层 `{conn: socket}`（emitOne 经 `ctxRec.ctx.conn.send` 下发）——扁平假连接零下发。

另：满编件裸 join 无 roomId 先回 error「roomId required」再由 quick 补位——协议形状如此（真客户端 join+quick 双发）；4421 被并行 worker 脚本共口 churn 时 quick 握手偶发无 welcome，重试即恢复（环境非产品）。

## 十、环境与复现

```bash
# 影子网关（:4399/:4400 零感知）
PORT=4421 GATEWAY_PID=/tmp/gw165.pid node server/gateway/index.js &
# 冻结门禁（DEV 54 断言独立复跑）
GAMES_GW=http://127.0.0.1:4421 node scripts/api-check.js deep-foodchain
# QA1 四件（net≈6min 含 5min 长局 / web≈2min / bot≈2.5min / full≈1min；与 net 臂顺序跑）
node scripts/deep-foodchain-qa1-net.mjs && node scripts/deep-foodchain-qa1-web.mjs \
  && node scripts/deep-foodchain-qa1-bot.mjs && node scripts/deep-foodchain-qa1-full.mjs
```
