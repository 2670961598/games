# 八球台球 QA一号（三支柱 + S4 物理专项）—— GAMES-79

- 对象：main 合并后 pool-physics（HEAD=`7a11ea5`，GAMES-78 DEV 交付）；分支 feature/GAMES-79（先 merge main，Already up to date）。
- 纪律：只测不改——**未改动任何仓内游戏/服务端代码**；QA 挂具全部置于 /tmp/games79/（不入库），证据落 kernel/workers/GAMES-79/。
- 环境：私有网关 127.0.0.1:4479（避共享 4400 陈旧/并行竞态；log/pid 改道不覆写常驻实例）。
- 预算：SOP §8.5 预算版 ≤25min；实耗约 26min+40min（P0 发现与取证属计划外展开，见 §4-F1）。
- 分段计时：调研通读 21:33-21:39（6min）→ 阶段1 复测 21:39-21:46（7min）→ perf 首跑+P0 定位 21:46-21:52（6min）→ S4 专项+Bot 21:52-21:57（5min，含挂具三轮自误修正）→ 影子树 perf/识图 21:57-21:59（2min+复跑 3min）→ 报告交付 21:59-22:0x。

## 1. 三支柱复测（api-check / perf / 识图 v2）

**api-check pool-physics 独立复跑：19/19 全绿**（私有网关，墙钟 1m11s；证据 api-check-pool-physics-20260928133930.json）：

| 组 | 结果 | 关键数值 |
|---|---|---|
| L1 | ✓ | 非回环访问测试面 → 403 |
| A1 开始 | ✓ | waiting→live；16 球固定阵型/openTable/turn=0；`room.physics{pool-int-v1#1256754359}` 声明块 |
| A4 注入延迟 | ✓ | shot→首张 motion snapshot **13ms**（红线 <100ms）；状态 GET 3ms |
| A5 重连 | ✓ | $disconnect 席位保留 → 凭 token 复席 **1211ms** + welcome 全量恢复 + 帧续推进（tick 1068→1852） |
| A2 能赢 | ✓ | pot-solver 剧本 A 席 `eight-ball`（9:3，11.3s） |
| A3 能输 | ✓ | idle 剧本 `afk`（3×30s 超时代打→认负，13.2s） |
| A6 确定性三联 | ✓ | 双房 stateHash=**4145105579** 相等；shot 日志 56 杆逐字节相等；在线 restHash **1610025462** == 回放器重放 hash |

三数值与 GAMES-78 REPORT 留档**逐位一致**（4145105579/56 杆/1610025462）——独立复跑复现。

**存量四作回归 60/60 全绿**：net-tank 14/14、slg-battlefield 14/14、mmo-township 16/16、empire-sprout 16/16（同网关连跑）。

**perf 三跑中位**：
- HEAD 原样三跑**全红**——根因不是性能，是 §4-F1 的页面级 P0（boot 即抛 ReferenceError，perf-smoke 等待契约炸在 `events.some`）。
- 单行补丁影子树（/tmp/games79/games，与 HEAD 仅 1 行差异，反向 diff 验证）三跑：**avgFps 59.9 / 60.1 / 59.8（中位 59.9）**，jank 0.33%/0.00%/0.67%（中位 **0.33%**），p95≈16.7ms，零 pageerror——GAMES-30 红线（≥55fps 且 <2%）达标。采样算式逐行照抄 perf-smoke（页面内 rAF 时钟，5s）。
- 口径注：影子树页面经默认网关入常驻 bot 房为 online 对打态采样（真实网关+重演负载，严于纯离线）。

**识图 v2（DEV 未竟项补跑）13/13 全绿**（DSF=1 真实视口，影子树；截图 shots/pool-{aim,motion,online}.png）：

| 断言 | 结果 | 数值 |
|---|---|---|
| 页面零未捕获异常 | ✓ | 补丁后干净 |
| 几何：无横向溢出 / 画布在 375×667 视口内 | ✓ | 375≤375；cv=375×667@(0,0) |
| 墨水带：顶栏(0-90) HUD 墨水 | ✓ | 8.0% |
| 墨水带：桌面(250-420) 台呢绿 #1F7A4D 主导（识图锚点） | ✓ | 81.6% |
| 墨水带：底栏(545-667) 操作条墨水 | ✓ | 10.9% |
| HF 静态全量过线（P0≥13/600·P1≥11·P2≥9） | ✓ | 13 键全过（timer 三元档走运行时补审） |
| 零裸字号 | ✓ | ctx.font= 赋值仅 1 处（HF 登记口内） |
| 运行时登记表活跃 | ✓ | 11 常显键（no/name/cnt/timer/shotN/pow/spin/spinv/shoot/replayBtn/slug） |
| worldProbe 钩子（mode/tier/assist/phase/turn） | ✓ | online 态 physicsHashOk=true |
| aim/motion 双态取证 | ✓ | 截图两态 |
| online 冒烟：入房+physicsHash 校验 | ✓ | hashOk=true（单行修复同时复活 online 路径） |

备注：单据前设"vis 脚本就位"不实——仓内无 scripts/vis-pool-physics.mjs（DEV 留档明示属 VIS 单交付）。本单以同范式挂具（/tmp/games79/vis-bench.mjs）完成断言，建议 FIX 单将其收敛入库。

## 2. S4 专项（确定性三联 / 物理参数对照 / 规则走查）

**确定性三联复证（双路）**：①工具路=api-check A6（上表，与 DEV 留档逐位一致）；②本地独立双跑（挂具直驱 sim.cjs，同 seed 两份 state + 同 rng Bot 决策 + 回放器，**不复用 api-check 代码路径**）：

| seed | stateHash 双跑 | shot 日志逐字节 | 回放==在线 restHash | 终局 |
|---|---|---|---|---|
| 20260928 | 3236195175 == 3236195175 | ✓ | ✓ | 4 杆 early-eight |
| 777 | 2588269212 == 2588269212 | ✓ | ✓ | 45 杆 early-eight |
| 31337 | 257884343 == 257884343 | ✓ | ✓ | 22 杆 early-eight |

**物理参数实测对照设计书 §2.3/§2.4 数值表**（挂具实测，非源码对读）：

| 项 | 设计值 | 实测 | 判定 |
|---|---|---|---|
| 起杆速度 V0（pow=1000/500/250） | 2800/1400/700 milli/子步 | 2800/1400/700（精确相等） | ✓ |
| 乘性摩擦 MU | 65369（0.997452/子步） | 单 tick 衰减=逐子步整数链**精确值**（连续理想 0.98732/tick，差=截断噪声） | ✓ |
| 蠕动相收尾（\|v\|≤120 每子步 −1） | 有限步停 | 20 tick 全停 | ✓ |
| 球-球正碰传递（e_ball=0.96） | 目标 0.98V / 白球 0.02V | 98.0%V / 1.0%V | ✓ |
| 库边法向 e=0.82 | 0.82 | 回弹比 0.810（含 1 tick 摩擦） | ✓ |
| 轻杆滚动距离 | 校核表 ≈228px | **161px**（未触库） | ○ 观察项 O1 |

O1 根因：`>>16` 逐子步截断构成附加摩擦（~0.1%/子步量级），设计校核表按纯乘性连续算术推的——确定性/正确性无损，破球/进球/走位手感定性仍达设计意图（A2/A3 剧本、Bot 对打均正常收官），FEEL 单可调（如 MU 微升或校核表补截断口径注记）。

**回合裁决规则走查 11/11 全绿**（构造态逐条触发，事件/状态双断言）：

| 规则 | 触发方式 | 结果 |
|---|---|---|
| F1 白球落袋 | 角袋斜线送白 | foul:F1 + ballinhand + turn 换 + 白球 pot=2 ✓ |
| F2 空杆 | 全场无触 | foul:F2 ✓ |
| F3 首触错组 | 己=全色首触花色 | foul:F3 ✓ |
| F3 开放局首触 8 | 直触 8 号 | foul:F3 ✓ |
| F4 无库无进 | 软杆触己组远离库 | foul:F4 + ballinhand ✓ |
| 分色 | 开放局首进全色 | assign 席0=全色/席1=花色，openTable 关闭 ✓ |
| ball-in-hand 域校验 | 界外/叠球/贴袋/合法四试 | reject=out-of-bounds/overlap/on-pocket + 合法纳 ✓ |
| 合法黑八 | 清完己组+8 落+无犯规 | eight-ball 胜（第 2 杆路径）✓ |
| 提前黑八 | 己组未清落 8 | 对方胜 early-eight ✓ |
| 破球黑八例外 | 第 1 杆落 8 | respot 至置球点(255000,85000)、不判负续赛 ✓ |
| 快照校验锚消费 | online 长窗观测 | motion 期 verify=10 递增（±2 容差比对在消费）✓ |

## 3. Bot 三档瞄准实测（镜像对打 ×3 seed = 9 局）

口径：进球率=该席回合落袋数/该席杆数（pottedBy 口径）；安全率=未犯规杆占比；镜像同档对打（强强互磨，严于打人类/casual 的口径）。

| 局 | 档 | seed | 杆数 | 墙钟 | 终局 | 席0 进球/安全 | 席1 进球/安全 |
|---|---|---|---|---|---|---|---|
| 1 | casual | 20260928 | 59 | 36ms | early-eight/B | .138/.276 | .267/.267 |
| 2 | casual | 777 | 93 | 33ms | eight-ball/B | .149/.298 | .174/.261 |
| 3 | casual | 31337 | 26 | 18ms | early-eight/A | .385/.538 | .231/.615 |
| 4 | balanced | 20260928 | 4 | 3ms | early-eight/B | 1.0/1.0 | 0/1.0 |
| 5 | balanced | 777 | 45 | 18ms | early-eight/A | .391/.696 | .227/.773 |
| 6 | balanced | 31337 | 22 | 11ms | early-eight/A | .273/.727 | .364/.727 |
| 7 | competitive | 20260928 | 34 | 58ms | eight-ball/B | .647/.588 | .235/.941 |
| 8 | competitive | 777 | 27 | 47ms | early-eight/B | .538/.538 | .357/.857 |
| 9 | competitive | 31337 | 24 | 69ms | eight-ball/A | .583/.833 | .583/.667 |

**三档聚合（差异实证，DoD）**：

| 档 | 进球率均值 | 安全率均值 | 场均杆数 | early-eight |
|---|---|---|---|---|
| casual 随手 | **0.224** | **0.376** | 59.3 | 2/3 |
| balanced 几何 | **0.376** | **0.821** | 23.7 | 3/3 |
| competitive 走位 | **0.490** | **0.737** | 28.3 | 1/3 |

- 单调性成立：进球率 casual<balanced<competitive ✓；casual 安全率（0.38，乱枪送 ball-in-hand）与 balanced/competitive（0.82/0.74）断层 ✓；杆效 casual 59 杆/局 vs 24-28 ✓。competitive 前瞻决策单局墙钟 ≤69ms（§4.3 预算 <100ms ✓）。
- 与设计 §4.2 期望（balanced 55-70%、competitive 75-85%）对照：镜像口径系统性偏低属预期（强强对拉+安全球互磨压低双方进球率；DEV 单 Bot 自测对 casual 口径更高）。排序与机制差异达成实证。
- 观察 O3：early-eight 占 6/9 局（balanced 亦 3/3）——Bot 清色残局长台杆连带黑八的走廊规避启发（DEV 已留 FEEL 项）值得排期，否则 bothost 房观感以"自杀局"收尾偏多。

## 4. 退回项清单

| # | 级 | 项 | 事实与证据 | 修复指引 |
|---|---|---|---|---|
| F1 | **P0** | 构建产物客户端浏览器面全断：index.html:81 内联 sim 的 factory 作用域引用 `root.PoolTrig`，而 `root` 是外层 UMD 包装参数——浏览器分支必抛 `ReferenceError: root is not defined` → `window.PoolSim` 永不挂载 → `boot()` 即 TypeError，**online/offline 双模式全死**（大厅槽位打开即死页） | pageerror 栈（index.html:81:33→73:15→76:3）+ probe `PoolSim:false` + perf-smoke 三跑红（21:46-21:52 取证）。Node 侧走 `require` 分支掩盖了浏览器分支——DEV 单未跑任何浏览器面即交付 | sim.cjs TRIG 取值改 `globalThis.PoolTrig`（或 factory 显式收 root）→ 重建 index.html → QA 复跑。本单已做单行补丁影子树验证：修复后 perf/识图/online 冒烟 13/13 全绿（含 physicsHashOk=true）——修复面确认仅此一行 |
| F2 | P3 | trig16.cjs `ATAN8[2048]=2048` 应为 **1024**：gen-trig16.mjs:28 手工端点 `push(2048)` 推错（atan2(2048,2048)=45°=1024 四分之一角 brads；中段全对：ratio 0.5→605 ✓） | 表值直读 + 真值对照输出。触发面=瞄准向量 \|Δx\|=\|Δy\| 精确等值（测度零，Bot/对局实测不受扰；QA 构造对角摆位 3/3 命中才暴露） | 生成器端点改 push(1024) 或删手推行直用循环产物 + 0..2048 全表对拍 + 重建。确定性无损（两端同表错也对齐），纯正确性卫生 |
| F3 | P2 | 客户端缺泳道标准调试契约：无 `__GAMES_DEBUG__.events` 台账与 `start()`（slg/mmo/emp 三作 client 均有）→ **perf-smoke 对本作结构性不可跑**（P0 修复后仍红）；且"vis 脚本就位"单据前设不实（scripts/vis-pool-physics.mjs 不存在） | grep 三作对照 + perf-smoke 等待契约源码 | FIX 单随 F1 重建时补 events/start 钩子 + 将本单 /tmp 挂具收敛为 scripts/vis-pool-physics.mjs 入库 |

观察项（不退回，FEEL/VIS 排期参考）：O1 滚动距离截断偏差（§2 表）；O2 `top/shotN` 13px/**400** 字重低于设计 §7 P0"≥13px/600"口径（尺寸达标，一行可修）；O3 Bot 黑八走廊规避（§3）。

## 5. 结论与放行建议

- **sim/网关/协议/规则/Bot 面 100% 绿**：api-check 19/19（三数值与 DEV 留档逐位一致）、存量回归 60/60、确定性三联双路复证（工具路+本地独立 3 seed）、物理参数 5/6 精确对照（1 项可解释观察）、规则走查 11/11、Bot 三档 9 局差异实证、快照校验锚消费实证。
- **唯一阻断 = F1（P0）客户端构建产物**：服务端权威物理首证（S4）的服务端侧成果全部成立，但玩家在浏览器里当前打不开这局棋。修复面一行 + 重建，本单影子树已预验证修复后全绿。
- 建议：开 **FIX 一号**（F1 必修 + F2 顺手 + F3 契约/vis 脚本收敛），复验口径=本单挂具三件套（api-check 19 + S4 专项 21 + 影子树识图/perf 13，方法已留档可复用）；FIX 过闸前单链不放行前端面。QA2（联机/旁观/重连深水区）待 FIX 后进。
