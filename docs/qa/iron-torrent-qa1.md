# 钢铁洪流 QA1 联机红线专项报告（GAMES-147）

- 单据：[QA·E6-W2-T4] 钢铁洪流 QA1 联机红线专项（S4 预测弹道）（3/10+）
- 分支：feature/GAMES-147（基线 = GAMES-146 DEV 6368aae + PM 抢救件 53b535c（首跑 worker 两臂脚本落枝，本单续作实跑取证）；merge main 无前进）
- 日期：2026-10-15 ｜ 角色：QA（只读纪律：零产品代码改动；测试件 `scripts/iron-torrent-qa1-{net,web}.mjs`，二跑对 web 臂修 3 处测试面缺陷——详见 §7 注记）
- 环境：私有影子网关 `:4418`（`PORT/GATEWAY_PID` 显式改道，`:4400/:4399` 全程零感知——:4400 仅冻结命令按需建房；生产 web :4399 只读 GET 供页面加载）；剧本房一律 `/api/test/*` 隔离测试房（与 WS 会话同一条代码路径，协议 §8）。`/tmp/gw-iron-147.log` 网关侧日志在档
- 结论：**红线专项净绿（net 臂 41/41 + 冻结命令 52/52），但浏览器 play 面抓到 1 项 P0 退回（F1：fire 离散 cmd 在 WS input 通道恒被网关预约窗丢弃——真实玩家开炮不可用）**；另有观察项 4 条（O-1..O-4，均低危/设计态披露）

## 0. 冻结验收命令（自跑）

```
cd /Volumes/BigDisk/Studio/projects/GAMES/repo && node scripts/api-check.js iron-torrent && test -f docs/qa/iron-torrent-qa1.md
```

结果：`api-check iron-torrent` **52/52 绿**（A1-A8 全断言+A+ 三附加臂：deterministic 双跑 stateHash=2094083972 三等、fire 参数 67 发双跑逐字节相等、在线终态==回放器重放、latency200 双臂完赛且击毁差 0）+ 本报告落盘 → 退出码 0。明细 `/tmp/iron147-apicheck.log`（本机在档）。

## 1. 三支柱——`scripts/iron-torrent-qa1-web.mjs` 14/16（2 红=F1 的两个观测面，见 §7）

play 四断言（quick 真实路径，影子网关 bot 房）：

| 断言 | 结果 | 证据 |
|---|---|---|
| A1 事件闭环 | ✓ | quick 入房 welcome 就席 seat=3 + **S4 声明块在浏览器面 engine=iron-int-v1**（physicsHash=1271929229，§5.2 版本护栏前提）+快照流推进 |
| A2 可玩·驾驶面 | ✓ | 受信输入驱动（左半屏摇杆 CDP 拖拽）对局演化：非底色墨水 48307→48519（坦克位演化） |
| A2 可玩·fire 面 | ✗ | **F1（P0）**：fire 钮 12×0.7s 真实触控全零回执（无 fire 事件亦无 reject——根因见 §7.1，非 CD/阵亡窗运气） |
| A3 零 pageerror | ✓ | 整轮 0 例 |
| A4 操控响应 | ✗ | 同 F1（fire 无权威样本故无时延可测；服务端同钟 <100ms 红线由冻结命令 A4 证绿，交叉引用） |

perf（≥55fps/掉帧<2% vsync 封顶口径——GAMES-131 帧成本法+空白页对照带）：

- 渲染帧成本 avg=0.35ms（p95=0.6ms，n=140）——远低于 16ms/帧 60fps 预算 ✓
- 掉帧率（帧成本>25ms）0% <2% ✓
- 对照带：game 0.35ms vs blank n/a（后台 tab rAF 节流超时降级披露——bringToFront 仍被节流，环境面非游戏负载；一跑挂死根因与修复见 §7 注记）

识图 v2（铁灰战场+双编码+HF 生效自证——DEV 冒烟独立复跑）：

- 铁灰战场底 #2B2E33 ±10 ✓（非底色占比 28.1%>3% 门槛）
- 混凝土掩体簇 #5A5F66 ±22 ✓（wall px=10722）
- 阵营双色簇（色通道双编码）：A 琥珀 #E8A33D=247px + B 青 #3DC8E8=108px ✓（形通道核验归 VIS 单）
- 弹道预览线墨水（琥珀 55% 透明混合带≈#936E37——§5.5 三面同源的玩家面）✓（preview px=646）
- HF `__applied=true` 生效往返自证（Q-013 第一断言位）✓
- HF 分级 P0=13/P1=11/P2=9（n=3611/1269/1172，当帧登记）✓
- 截图：`kernel/workers/GAMES-147-shots/p3-vis.png`

## 2. S4 预测弹道专项——`scripts/iron-torrent-qa1-net.mjs` 全绿（与 §7.1 F1 无交集：testapi 走 `rooms.op` 通道，见 §7.1 归因）

| 项 | 结果 | 证据 |
|---|---|---|
| S4-1 三面同源·权威重演 | ✓ | fire 事件参数（ang/vx/vy/vz）经 `sim.previewTrace`（同一积分器）重演落点==服务器 splash 弹着：落地样本×44 偏差带 ≤4500 milli 全过（**max=0 milli**）；HE 直击×3 另计（弹终=坦克位，AOE 面归 S4-4） |
| S4-2 三面同源·预览中心线 | ✓ | 服务器确认炮塔角（快照 ents tur@fire）的散布中心线落点 vs splash 偏差 ≤ 散布带（定角射击×8 偏差 726-3148m｜散布角 4-17 brads，均在 ±146 brads×射程带内） |
| S4-3 fire 参数逐字节自洽 | ✓ | vz==AMMO.vz 逐字节（ELEV 固定烘焙）+|v_h|≈vh（±3）+ang==atan2(vx,vy)（±2 brads 量化）：fire×216（AP×160/HE×56）三查全过=216/216/216；跨房逐字节等值=A7 冻结命令证（交叉引用） |
| S4-4 弹着点权威归属（裁决面） | ✓ | hp 逐快照对账：kill 分段守恒（段内 hp 降幅==hit.dmg、kill 段容 overkill）+降幅 ±12 tick 邻近 hit——伤害唯一来源=服务器 hit 事件，客户端预测零伤害写入；hp 下降×39 邻近对账×29 分段守恒成立（观测缺档段×3=hit 在账而 hp 快照缺档，观测面非记账面，O-3） |
| S4-5 越权裁回 | ✓ | CD 期跨 tick 再 fire → `reject(cd)`（第一拍受理/第二拍裁回——fire 是服务器校验离散 op） |
| S4-6 200ms 天然容忍 | ✓ | delayMs=200 房 gunner 注入命中在账（fire×4 hit×3）；弹道飞行 0.5-1.1s 内命中裁决不受传输差影响；冻结命令 latency200 双臂击毁差 0 交叉引用 |

## 3. 重连三档（timeScale=1 真秒，弹道在飞断线=fire 后 ~60ms $disconnect）

| 档 | 结果 | 证据 |
|---|---|---|
| 5s 全测 | ✓ | 断线 5s 席位未托管（kind=human 保持=席位保留窗）→ $reconnect 凭 token 复席（seat=0）→ 复席重同步（full=1）+房存续续玩（tick 173→348 phase=play） |
| 弹道在飞续拍语义 | ✓ | 断线期间弹着按服务器裁决落定：掩体弹着=耐久归账可证；开阔地弹着（重演落点 z=0 @314,430px）=断线窗事件面账本盲+无持久状态——§5.6 设计态（重连不补发事件，O-2 披露），续拍语义由状态延续断言承载 |
| 10s 窗内 | ✓ | 9.6s<10s+1 拍复席有效（10.2s 逾窗即托管拒=street 口径同构）；复席后房存续续玩（tick=401） |
| 30s 逾窗 | ✓ | 席位转托管 balanced（META.takeOver，seat0 kind=bot）+token 已清→resume-rejected 409（复席语义不容降级为顶号）+「战局不断」托管下对局继续推进（tick 179→462） |

## 4. Bot 三档梯度（同 seed=SEED+7 对照房，可观测分层）

| 档 | 命中率 | 提前量/战术面 | 占点贡献 |
|---|---|---|---|
| casual | rate=0.41（30/74） | HE×8=弹尽兜底（brain ammo fallback）；crumble=2（AP 拆木箱=设计内「可为但亏」） | capPeak=0 |
| balanced | rate=0.18（8/44） | HE×21=射程环压制（战术使用>casual ✓） | capPeak=0 |
| competitive | rate=0.73（32/44）✓>casual | HE×3（AP 精准向） | capPeak=110（开局 1 人先占）✓>0 |

三档分层成立：命中率 competitive>casual ✓、HE 战术面 balanced>casual ✓、占点 competitive>0 且 casual==0 ✓（kills 7/2/8、终局 timeout/timeout/eliminated@1033——competitive 压制力终结对局）。

## 5. 长局 spot+满编+观战

- L1 长局 spot（maxTicks=9600=480s 硬顶）：spot×20 tick 单调+stateHash 演化（末 spot tick=8092，>5min 观测窗覆盖）✓
- L2 命池对账：kills↔lives 闭合（A 队被击杀×5/B×4，终态 lives=[0,1]）✓
- L3 掩体对账：crumble↔tileHp 归零增量一致（归零 419→421（Δ2）vs crumble×2）✓；终局裁定闭环+确定性锚 stateHash=500165795 在场 ✓
- N7 满编 2v2：4 席在场（1 API 玩家+3 bot，human/bot 结构合法）✓
- SP1 观战数据面：4 真人满员房第 5 连接 join → spectator 位（不占席）+收同快照流（full=1 首张+frame 286→292 推进+projs 同流+ack=-1 观战席锚）✓（观战转场 UI 未做=DEV 披露归 VIS，本单数据面验证通过）

## 6. DEV v1 收窄清单复核（口径确认，无缺陷项）

| 收窄项 | 复核结果 |
|---|---|
| HE 撞掩体=弹终+tile 伤害（不炸坦克 AOE） | ✓ 弹着点在存活掩体 tile 且敌坦克在 AOE 圈内的样本零 splash 命中记账（本批该形态样本×0——形态未触发，披露） |
| AOE 只伤敌队 | ✓ 爆心 30000 内己方队友在场样本零命中记账（队友在爆心样本×1 违例×0） |
| 掩体锚点表=通用边路路线点 | 口径确认（非缺陷：Bot 导航面简化，行为谱 B1-B3 分层仍成立） |
| 他人坦克=快照直渲染+速度外推 1 拍 | 口径确认（100ms 插值缓冲归 FEEL/VIS 单） |
| 观战转场 UI 未做 | 协议位已通（SP1 证），归 VIS |
| mercy 参数位预留未启用 | 口径确认（BOT 深化单范围） |
| 客户端后坐三件套/履带印/集锦回放 | 归 FEEL/VIS 单 |

## 7. 退回项清单（QA 只读，代码零改动）

### F1（P0，建议 FIX 一号首位）浏览器 fire/swap 离散 cmd 在 WS input 通道恒被网关预约窗丢弃——真实玩家开炮不可用

- **现象**（三重独立取证）：①浏览器臂 fire 钮真实触控 12×0.7s+8×2.6s+4×1.4s 三轮共 24 tap 全零回执（无 fire 事件**亦无 reject**）；②纯 WS 探针（无浏览器，复刻客户端协议）`alive=1 cd=0` 连发 12 次 `{t:'input',frame:seq++,keys,cmd:{k:'fire',ammo:0}}` 全零回执；③同房间 Bot fire 事件流正常（事件面/渲染面无恙）。
- **根因链**：`server/gateway/rooms.js` input()（L247-258）离散 cmd 的唯一执行通道是预约帧 pending：`frame∈(room.frame, room.frame+8]` 才 `s.pending.set(f, keys)`（cmd 随帧执行）；越窗落 else 分支只写 `s.lastInput`——**连续键（mx/my）沿用生效、cmd 静默丢弃**（GAMES-51 F1 一次性语义的预约面）。而 `games/multiplayer/iron-torrent/client.js` L254 `frame: seq++` 是 20Hz 客户端自计数（S2 ack 语义，设计 §5.2 原文），room.frame 是 10Hz 房帧——两钟 2:1 漂移，**接房 ~0.8s 后 seq 恒 > room.frame+8，cmd 永久越窗**。sim.cjs L252-268 的 `e.cmd` 消费位（execCmd）本身健康——是网关投递面与客户端计钟面的语义错配。
- **为何红线专项其余全绿**：testapi（net 臂）与冻结命令（api-check）的游戏 op 走 `rooms.op`（t:'op' 通道，GAMES-78 首证）直入 `sim.op` 权威校验——**服务端开炮裁决面全程绿**（S4-1..S4-6/fire×216/latency200 皆此通道）；唯浏览器客户端被设计书 §5.2 指到 input.cmd 通道，恰落在预约窗死区。iron 是首个把离散 cmd 塞进 20Hz 自计数 input 帧的客户端（pool 走 t:'op'、street 离散动作走连续键面）——两语义（S1 目标帧预约 vs S2 客户端序号 ack）在同一入口的冲突首次被踩实。
- **玩家面后果**：fire/swap 双钮全部无效（swap 同路径）；乐观开炮的本地弹道起段照播（uiTap 门内 `me.alive&&me.cd<=0` 通过即 push projsLocal）——**玩家看见自己开炮、炮弹落地、零伤害零校准**（无权威 fire 事件回校）。可玩性破面。
- **修复方向**（二选一，FIX 单裁决）：a) 客户端改走 `t:'op'` 通道发 fire/swap（与 testapi/冻结命令同入口，服务端零改动——sim.op 已在）；b) 网关 input() 对 S4 类游戏（META 标记）的 cmd 增加 ack 语义投递（如 lastInput 附带一次性 cmd 槽）。方向 a 改动面最小且被本单 52+41 断言间接全绿背书。
- **连带测试件注记**：web 臂 A2/A4 两断言即 F1 的两个观测面（回执在页/时延样本），F1 修复后应直接转绿——测试件无需再改。

### 观察项（不退回）

- **O-1（低危· matchmaking）**：quick 会并入房龄 49s+ 的在打房（探针 frame=554@join）——中途接手 Bot 坦克（继承 hp/cd/位置）。非缺陷（让位语义设计内），但 QA/玩家「入局即战」体验与 fresh spawn 预期有差；观战转场/入场保护归 VIS/FEEL 议题。
- **O-2（设计态披露）**：断线窗内开阔地弹着无事件补发（§5.6 重连不补发事件）——弹着无持久状态，重连后不可追溯；掩体弹着有耐久归账可证。口径=设计态，非缺陷。
- **O-3（观测面）**：S4-4 对账 hp 下降×39 中 3 段观测缺档（hit 在账而 hp 快照缺档）——增量快照相邻批把 hp 降与 hit 拆批的观测缝隙，记账面守恒成立。
- **O-4（测试件面，已修）**：二跑对 web 臂修 3 处测试缺陷——①blank 对照页后台 tab rAF 节流挂死（bringToFront+15s 超时降级披露——首跑 worker 逝于交付前的环境面之一）；②welcome emitDbg 是扁平 payload（engine 读法 `payload.engine` 非嵌套 `room.physics`——修正后 A1 附带证得 S4 声明块在浏览器面）；③fire 重试节奏（CD_FIRE=50 tick=5s，0.7s×12 密集重试排除窗口运气后 F1 才定案）。net 臂标签「:4415」为文案硬编码（实际 `QA_GW` 注入 :4418，roomId 与 `/tmp/gw-iron-147.log` 对账可证），不影响证据。

## 8. 回归抽查 2 作（零产品改动，抽查=同门禁复验）

- street-soccer（同泳道近邻）：api-check 复跑结果见下表
- pool-physics（S4 同门首证）：api-check 复跑结果见下表

| 作 | 结果 |
|---|---|
| street-soccer | api-check **39/39 绿**（exit=0，明细 `/tmp/iron147-reg-street.log`） |
| pool-physics | api-check **19/19 绿**（exit=0，明细 `/tmp/iron147-reg-pool.log`） |

## 9. 证据索引

- net 臂全量输出：`/tmp/iron147-net.log`（41/41）
- web 臂三轮+定案轮：`/tmp/iron147-web{,2,3}.log`（14/16，2 红=F1）
- 冻结命令：`/tmp/iron147-apicheck.log`（52/52，exit=0）
- 网关侧：`/tmp/gw-iron-147.log`（影子网关 :4418，pid 36309，与 net 臂 roomId 全量对账）
- 截图：`kernel/workers/GAMES-147-shots/p3-vis.png`（识图 v2 定案帧）
- 探针（F1 定案件，未入枝）：纯 WS 复刻客户端 12 连发零回执日志（本报告 §7.1 ②）
