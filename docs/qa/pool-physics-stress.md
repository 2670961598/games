# 八球台球 STRESS 压测+单链收官（GAMES-86 · 预算版）

> 单据：GAMES-86（[STRESS·E6-W1-T4] 八球台球 压测+单链收官（10/10 预算版），attempt 0）
> 纪律：Q-007 预算版——总实测 ≤25 分钟、全程每步计时。实测构成：A 组多房 8:00 + B 组满编 spot 5:00 + C 组五游戏混编 5:00 + mmo 满频补测 1:30，采样墙钟合计 **19 分 30 秒**；含过渡的全程作业窗 22:02（超 20 分钟软线已按纪律转收尾，其后仅文档/落档；<25 分钟硬帽。全程计时见 §5）。
> 环境：专用网关 `127.0.0.1:4421`（影子树 `kernel/workers/GAMES-86/gw/`，gateway+server/lib 与 repo 逐字节一致 shasum 留档、games 走符号链接、data 随影子路径隔离——Article 183-128 影子树隔离法；生产 :4399/:4400 全程零感知，验收前后各核验一次，:4400 pid 57383 起止未变）。零服务端代码改动：分房/满编/出杆全部经公开协议（quick join/op shot/place）与测试 API 驱动。
> 证据：`/Volumes/BigDisk/Studio/kernel/workers/GAMES-86/`（a-rooms.json / b-full.json / c-mixed.json / mmo-probe.json / leak-fourcheck.json / gateway.log 全量 1,501 行 / shasum-shadow.txt / chain-driver.log 接力时间戳）。

## 1. A 组：多房并行（≥6 pool 房 · 8 分钟抽样）

**构房机制（纯公开协议+测试 API）**：数据集一=6 间 pool 测试房（`POST /api/test/room`，botLevels=[null(API 席)+balanced]，tick 走 `/api/test/state`）；数据集二=BotHost 自然负载（pool minLive=2/maxRooms=4，casual/balanced 轮换房，spectator 锚定测快照 burst 帧率）。pool 特有 churn 面：测试房 API 席挂机→30s 超时代打→连续 3 次 **afk 认负**（§1.2 设计语义），同批创建的 6 房约 110s 一代同步翻转，8 分钟内 **30 建/24 终/6 槽重建**（recreateFail=0），自然形成高轮换压测面。

| 指标 | 实测（47 采样 × 10s = 8:00） | 判据 |
|---|---|---|
| 并行房 | 测试房 6 槽位恒占用（live 均值 4.85/6，afk 世代同步翻转窗内瞬时跌 0——3/47 采样拍，见 O1 披露）；BotHost pool 房 2-4 恒存；网关总 rooms 15-21（五游戏 bot 房+测试房） | ≥6 pool 房承载 ✅（6 测试槽+BotHost 恒存，世代轮换不停档） |
| tick 率 | 名义 **100Hz**（tickMs=10 快钟）；独立 cadence 探针 19.1s 窗 **100.021/s**；BotHost 房旁观 18 房次 **150+ burst 段** frameHz 集中 97-101（域 [96.7,105.0]；段端点快照到达抖动所致，快照节拍 P50 恒 103ms≈10Hz） | 100Hz±1%（探针）✅ |
| tick 漂移 | 252 房-采样点全域 **[-4,+5] tick**（对各自 live 锚点；顺序轮询相位噪声主导——6 房串行 HTTP poll 各 ~5ms 相位差，±50ms 级） | ≤10 tick ✅ |
| 网关 RSS | 71,152（段首）→ 采样期 71,152-91,616KB；前半均值 76,709 vs 后半 87,302KB（30 建房/24 终局轮换 churn 高水位，判读见 §4①②） | 有界披露 ✅ |
| 网关 CPU | 均值 **3.3%**、峰 12.8%（GC 毛刺秒级回落） | 低负载 ✅ |
| feed 正确性 | 全部 47 采样全量校验 **0 错**（前缀 pool-/席位≤2/joinable==humans<2/mode=1v1-pool/elapsedMs；测试房不泄漏进 feed） | 零错 ✅ |
| 错误面 | uncaught Δ0、room-error Δ0 | 零错误 ✅ |

**口径披露（沿 GAMES-76 O3 教训）**：漂移只计 phase=live 段观测（终局冻结房不进判据）；tick 率不采信任何"汇总 rate"字段，以 cadence 探针 100.021/s + 全域漂移 [-4,+5]（除数即 100Hz 名义）+ B 组满编房 burst [99.65,102.43] 三证合一口径。

**判定：PASS**。证据：a-rooms.json（47 采样逐条/漂移序列/cadenceProbe/18 房次 burst 统计/事件面）。

## 2. B 组：长局稳定性（三单交叉引用 + 5 分钟满编 spot）

### 2.1 交叉引用（不重跑，验收口径=ticket 指定：QA1/QA2/BOT 三单）

| 观测段 | 单 | 口径与结果 | 证据 |
|---|---|---|---|
| QA1 三支柱+S4 专项 | GAMES-79 | 红线全过（api-check 19/19+回归 60/60+S4 专项 21 项+识图 v2 13/13）；确定性三联（双房 stateHash 4145105579 相等、56 杆 shot 日志逐字节相等、在线 restHash==回放器）；退回 F1(P0)/F2/F3 由 FIX1 收口 | pool-physics-qa1.md |
| QA2 联机专项 | GAMES-83 | 五面红线全 PASS：200ms 回合制容忍论证实证（ack=RTT/球动本地重演零延迟/双端一致 **16k 快照锚 0 偏差**）；重连三档（5s 真WS+BIH 保全/10s 窗界+托管代打/30s room-gone）；满员旁观（timeout-shot 恰 3000tick/三连接 18/18 帧齐）；长局 spot RSS +768KB/5min；feed 全档 ≤0.5s | pool-physics-qa2.md |
| BOT 深化 | GAMES-81 | 三档物理 Bot（casual 随手杆/balanced ghost-ball 几何+一库反射/competitive ≤16 次前瞻+犯规感知+走位）+开局树 rng 定桩×2/档+陪玩放水 foeLose≥2 降档实证；竞技 vs 休闲犯规率 0.176 vs 0.373 档间分离 | GAMES-81 报告+pool-bot2-check 14/14 |

三单累计 **45+ 杆在线重演全停逐字节一致、9 局三档差异实证、5 分钟多房 spot 零泄漏**，横跨 DEV→QA1→FIX1→BOT→FEEL→QA2→FIX2→VIS 八次代码演进；本单 A/B/C 三组再续 19.5 分钟（6 测试槽+BotHost 并行、满编 2/2、五游戏混编）。

### 2.2 本单 5 分钟满编 spot（2/2 真人席）

口径：2 条 quick play 连接填满 BotHost pool 房（bots 让位、joinable=false，复用 QA2 t3-fullroom 满编口径），双席 PoolSeat 主动出杆（aim 期 0.5-1.2s 思考——纯挂机会 3 次超时 afk 认负，须真打持房）；1 条旁观锚测快照 burst 帧率（球动期 frame 名义 100Hz 推进、快照 10Hz 节拍；静止期事件驱动无快照属 S4 双相快照设计）。自然终局（early-eight）→ 4s 后双双重进新房（满编滚动，计数披露）。

| 指标 | 实测 | 判据 |
|---|---|---|
| 满编保持 | **30/30 采样 humans=2、bots=0、spectators=1、joinable=false**（2 条 play 连接 takeover 就席；5 个房间世代滚动，4 次自然终局均 early-eight 后 ≤4.5s 重填） | 满编全程 ✅ |
| 满编房 tick 率 | 旁观快照 **27 burst 段全部计入：frameHz 99.65-102.43**（655 快照、节拍 P50 103ms=10Hz） | 100Hz±2.5% ✅ |
| 操作面活性 | 双席合计 **30 杆 op→ruling ack 全确认**（ack p50 0-1ms）、reject 0；终局世代 shots 15+15 | 双通道活性 ✅ |
| 网关 RSS/CPU | 85,296-91,840KB（前半均值 89,844→后半 **90,843KB，+1.0MB 近平台**）；CPU 均值 1.7%、峰 3% | 有界收敛 ✅ |
| 撤席回收 | 2 席+旁观全撤 → **seat-bot 托管 @drop+10s（Δ2）→ room-end(abandon) @drop+15.05s → room-dispose(ended) @+8.03s** 闭环 | 闭环 ✅ |
| 错误面 | feed 校验 30 采样 0 错；uncaught Δ0、room-error Δ0 | 零错误 ✅ |

**判定：PASS**。撤席语义横切复证：GAMES-84 abandon 锚点修复后口径（15s 宽限自"全员离线"起算、托管先于 abandon）在压测撤席臂精确重现。证据：b-full.json（30 采样/世代账/withdraw 事件原文）。

## 3. C 组：五游戏混编（网关注册全集同进程 · 5 分钟）

口径：复用 GAMES-58/65/76 c-mixed 范式（预算版 5:00）。**ticket"六游戏"口径披露：网关 sims 注册表全集=5 款（net/slg/mmo/emp/pool），无第 6 款可编——按"同网关全游戏混编"执行，五款全部在跑**（每款测试房或 BotHost 常驻房至少其一）。混编面=pool 测试房×3+emp×2+slg×2+net×2（[null+balanced 族]）+ BotHost 自然负载（五款常驻+mmo 常驻镇）。

| 指标 | 实测（30 采样 × 10s = 5:00） | 判据 |
|---|---|---|
| 房间面 | rooms 15-20 恒定；30/30 采样五游戏全在场：emp 2+mmo 镇 1+net 2+slg 2（BotHost）+ 测试房 live 均值 6.3（pool/emp/slg/net 四系 21 终/8 槽重建快速轮换） | 全集同跑 ✅ |
| 本作 tick 漂移 | pool 测试房全域 **[-3,+5] tick**（与 A 组独立跑同域——混编零劣化；100Hz 快钟口径） | 不劣化 ✅ |
| slg/emp 帧漂移（混编干扰判据） | slg 全域 **[0,0]**、emp 全域 **[0,0]** tick（10Hz 口径） | 不劣化 ✅ |
| net-tank 轮换 | netEnd Δ **23 局/5min**（net 测试房×2+BotHost×2 自然终局轮换，节奏与历史单一致；drift live 段 poll 未命中，见 O3） | 稳定 ✅ |
| mmo 常驻镇 | spectator 全窗 frame 率 **10.005 Hz**（90,352ms 窗 904 快照、节拍 P50 103ms；二段补测见 O2） | 满频 ✅ |
| 容量护栏 | 第 9 间测试房（net）触 **MAX_TEST_ROOMS=8 上限 429 拒绝**——护栏工作正常（GAMES-76 同款证据） | 护栏在位 ✅ |
| 网关 RSS/CPU | 91,072-109,856KB（前半 92,202→后半 99,535KB，+7.3MB 锯齿）/ CPU 均值 3.2%、峰 8.4% | 有界披露 ✅ |
| 错误面 | feed 全量校验 **0 错**（五游戏前缀/席位/joinable/mode 断言全过+测试房不泄漏）；uncaught Δ0、room-error Δ0 | 零错误 ✅ |

**判定：PASS（跨 sim 相互影响阴性：pool 快钟 100Hz 与其余四款同进程互不劣化、net 轮换正常、mmo 镇满频）**。清扫后 healthz rooms 回落 **10**（BotHost 稳态：五款常驻房+镇）。证据：c-mixed.json、mmo-probe.json。

## 4. 无泄漏判据四件套

① **RSS 有界**：A 段 71,152-91,616KB（30 建房/24 终局高 churn 高水位）；B 段 85,296-91,840KB 且后半仅 **+1.0MB 近平台**；C 段 91,072-109,856KB（混编 churn）。三段锯齿有界、无单调暴涨。**生产反证**：同代码 :4400 常驻网关（pid 57383，起 03:48）压测前后两次采样 RSS 62.5MB/CPU 1.3%（≈4h 稳定）。**PASS**
② **增量收敛**：A 段前后半 +10.6MB 未达平台（定性 V8 分配高水位：测试房全量 state 对象+轮询 stringify churn，RSS 为触及页高水位非活堆——B 段同网关 +1.0MB 与生产反证双证）；B 段 +1.0MB 收敛；C 段 +7.3MB。**二段起点重置证据（GAMES-76 O1 留验项，本单补齐）**：网关 SIGTERM 后二段（mmo 补测）重启 RSS 起点回 **71,184KB**≈一段起点 71,152KB——高水位随进程重置、非跨生命周期累积。**PASS（附 O1 披露）**
③ **房周期闭环**：两段生命周期全量配对（按 gateway-up 边界分段，含停机 dispose）：首段（A+B+C+SIGTERM 优雅停机）room-create **245 == room-dispose 245**，dispose 归因 ended 226+test-cleanup 9+shutdown 10；二段（mmo 补测+SIGTERM）**16 == 16**（ended 7+shutdown 9）；room-end 228/7 与 ended/轮换自洽；清扫后 healthz rooms 回落 10（BotHost 稳态）。**PASS**
④ **零错误**：两段生命周期合计 **1,501 行网关日志 uncaught=0、room-error=0**；A/B/C 三段 feed 全量校验 **107 采样 0 错**（五游戏前缀/席位/joinable/mode 断言+测试房不泄漏）。**PASS**

## 5. 计时与预算自查（Q-007 纪律）

| 阶段 | 墙钟 | 明细 |
|---|---|---|
| A 组 | 8:00 | 建 6 测试房 ~20s → 采样 8:00（47×10s，含嵌窗 cadence 探针 19s） |
| B 组 | 5:45 | 满编 2 席+旁观 ~10s → 采样 5:00 → 撤席 abandon/dispose 观测 45s |
| C 组 | 5:03 | 建 8 测试房（第 9 间 429 护栏证据）~20s → 采样 5:00 → 清扫+回落 13s |
| mmo 满频补测 | 1:47 | 二段网关重启 4s → 锚镇 3s → 90s 窗 → SIGTERM 5s（O2 补测，见 §6） |
| **合计** | **19:30 采样 / 22:02 全程窗**（超 20 分钟软线转收尾：其后仅文档/落档未再补测；<25 分钟硬帽） | 脚本间接力同秒（B-START 07:23:28 = a-rooms.json 落盘秒；C-START 07:29:14 = B-END 同秒） |

网关生命周期两段共 26:03（首段 07:11:21-07:34:22 含启动预热与 A/B/C；二段 07:35:39-07:37:24 跑 mmo 补测；两段均 SIGTERM 优雅停机、dispose 全配对）。通读/脚本编写/报告不在实测窗内；另有预飞冒烟两轮（测试房+PoolSeat 路径，各 ~15s，不计实测窗——GAMES-76 同口径）。

## 6. 退回项

**红线退回项：无**（三组 PASS、四件套全过）。

观察项与工具链建议（不阻塞）：
- **O1（观察）** A 组测试房 API 席挂机的 **afk 世代同步**：同批建的 6 房以 ~110s 一代集体终局（3 次超时认负叠加同刻创建），翻转窗 ~20s 内 live 计数 3/47 采样拍见 0（房槽位仍在、网关总 pool 房 ≥2+BotHost 恒存、feed/错误面零扰动）。属 harness 与 §1.2 设计语义的交互非服务端缺陷；后续 pool 类压测如需"6 房恒 live"面，可错峰建房（间隔 ~20s）或 API 席低频代打出杆防 afk。
- **O2（工具）** C 组 mmo 满频探针 t0 锚在首帧到达前（`__t0.frame=null`）致全窗率字段为 null——已按"等首批快照落地再锚"二段补测 90s 得 10.005Hz 补齐；建议压测库 spectator 探针统一"首帧后锚 t0"（本单 lib86 已固化进 mmo-probe 脚本）。
- **O3（口径）** net-tank 测试房 drift live 段观测 n=0（高轮换下 10s poll 相位未命中 live 窗）；net 判稳沿 GAMES-76 口径以轮换计数（23 局/5min）+feed 正确性承载。
- **O4（流程披露，非本单缺陷）** 链位 9/10 的 GAMES-85（VIS）已交付于 feature/GAMES-85（9883b4a，2026-09-29 06:29），**尚未合入 main**——其改动面为客户端渲染层+docs/vis+识图脚本（4 文件，sim/网关零触碰），与本单压测对象零交集；建议 PM 合并 feature/GAMES-85 后再落档案 accepted 收口（本单档案回填已按 10/10 链记账）。

## 7. 单链收官：八球台球 10/10

| # | 单 | 产出要点 |
|---|---|---|
| 1 D GAMES-77 | 设计书 | S4 服务端权威物理：纯整数定点（零 Math/TRIG16-ATAN8 烘焙表）、双相快照、确定性重演、物理 Bot 双轨 |
| 2 DEV GAMES-78 | S4 首证 | op/ruling 复用协议 S5 预留位；100Hz 快钟 stepCap 按 tickMs 归一；restHash 回放口径；定点物理三坑收口（isqrt/>>16 回绕/代打清连击） |
| 3 QA1 GAMES-79 | 独立复测 | 三支柱+S4 专项 21 项全绿（A6 双跑 stateHash/shot 日志/restHash 三联）；F1 浏览器面 P0（UMD factory 作用域）等三退回 |
| 4 FIX1 GAMES-80 | P0 修复 | F1 factory 收参；F2 ATAN8 端点对拍修；静态/网关双进程冒烟须 ?gw= 的口径入档 |
| 5 BOT GAMES-81 | 瞄准三档 | casual 随手杆/balanced ghost-ball+一库反射/competitive ≤16 次前瞻+犯规感知+走位；开局树定桩×2/档+陪玩放水 |
| 6 FEEL GAMES-82 | 手感层 | 瞄准三段+击球 juice+观战运镜夹紧；离线 aim 期 tick 冻结坑修复（Bot 永代打根因） |
| 7 QA2 GAMES-83 | 联机红线 | 200ms 回合制容忍论证实证+重连三档+满员旁观+feed ≤0.5s；退回 F1 网关 abandon 锚点（横切面）+F2 终判帧差 |
| 8 FIX2 GAMES-84 | 横切修复 | F1 rooms.js 在场刷新上提（波及五作）三臂实证；F2 重演伪杆号（投影重建丢簿记字段）client 一行修+离线双轨取证 |
| 9 VIS GAMES-85 | 视觉统一 | 字号标准自证+台面质感预烘焙+袋口真位/幽灵虚线两枚隐性渲染缺陷顺修+色盲双编码校验表（已交付 feature/GAMES-85，待 PM 合并 main，见 O4） |
| 10 STRESS 本单 | 压测+收官 | 三组 PASS、四件套全过（附二段 RSS 起点重置补证）、档案 accepted |

单链节奏：10 单（GAMES-77→86，D→DEV→QA/FIX/BOT/FEEL×2 轮→VIS→STRESS），E6-W1-T4 轨，S4 服务端权威物理+100Hz 快钟+回合制 op 通道全链实证。工具沉淀：影子树隔离+显式 PORT 纪律、回合制驱动器（ruling 即重演/快照校验锚）、burst 帧率计量口径（静止期事件驱动的快照流专用）。

## 8. 结论

**八球台球 STRESS 三组全过（6 测试槽+BotHost 并行 8min tick 100.021Hz 漂移 [-4,+5]、三单交叉引用+满编 2/2 spot burst 99.65-102.43Hz、五游戏混编零错误+护栏 429 证据），无泄漏四件套全过（两段生命周期 245==245/16==16 全配对、1,501 行零错误、RSS 二段起点重置补证），实测 19:30 采样墙钟守住 Q-007 预算（22:02 全程窗）。单链 10/10 完成（GAMES-77..86），档案转 accepted（docs/game-quality.json），知识库《八球台球开发实录》草稿留档待 PM 收割，联机作战图进展已更新（multiplayer-roadmap.md §4.3：E6 进度 5/21、W1 波 4/7）。**
