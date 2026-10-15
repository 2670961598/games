# 街头足球 QA2 全链红线专项报告（GAMES-142）

- 单据：[QA·E6-W2-T3] 街头足球 QA2 联机红线专项二轮（BOT/FEEL 上线后复验+全链红线复核）单链 6/10+
- 分支：feature/GAMES-142（基线 badff77 = GAMES-141 FEEL 已合并，merge main 无前进）
- 日期：2026-10-15 ｜ 角色：QA（只读纪律：零产品代码改动，测试件为 `scripts/street-soccer-qa2-{net,mercy,web}.mjs`）
- 环境：私有影子网关 `:4416`（`PORT/GATEWAY_PID/GATEWAY_LOG` 显式改道防覆盖常驻实例）+私有静态臂 `:4417`（`WEB_DIR=web` 同构复刻生产 web 源——本环境 :4399 未常驻，`:4400/:4399` 全程零感知）；剧本房一律 `/api/test/*` 隔离测试房；放水链走 WS quick 真实路径（协议 §2，见 §3 结构性论证）
- 结论：**产品红线全绿，无 P0/P1 退回项**（冻结 39/39+net 34/34+web 9/9+回归 2 作）；放水链在线验证部分完成（mercy 6/9——3 失败均为 QA harness 制败侧阶梯未爬完，产品行为零异常观测，数字锚转 O-7）；QA1 观察项 O-1/O-2/O-3 抽验闭合；观察项 O-4/O-5/O-6/O-7 新增（均低危口径注记）

## 0. 冻结验收命令（自跑）

```
cd /Volumes/BigDisk/Studio/projects/GAMES/repo && node scripts/api-check.js street-soccer && test -f docs/qa/street-soccer-qa2.md
```

结果：`api-check street-soccer` 39/39 绿（A1-A8+统计制面，A8 确定性三等 stateHash=2364577099：双跑同 hash+inLog 逐字节 2982 条+replay==在线——与 BOT 单 A2 复验锚一致，FEEL 未扰动引擎）+ 本报告落盘 → 退出码 0。

## 1. 全链红线复验总表

| 面 | 载体 | 结果 |
|---|---|---|
| api-check 39 面（统计制口径） | 冻结命令 | 39/39 ✓（hash 锚 2364577099 与 GAMES-140 A8 交付一致） |
| 确定性三等 | 冻结命令 A+ deterministic | ✓ 两房同 hash+输入日志逐字节+回放==在线 |
| 200ms 延迟对照（FEEL 后触球反馈链） | qa2-net N1（d0/d200 双房） | ✓ 34 断言全绿（见 §2） |
| 重连三档（手感层状态延续） | qa2-net N2 | ✓ 含 FEEL 服务端延续面四键（stam/lungeT/stumbleT/tackleCd） |
| 长局 spot（8min 交叉引用） | qa2-net N3 + qa2-mercy M6 | ✓ 6000-tick 硬顶房全程+8min 连续对局窗交叉引用 |
| 放水链在线验证 | qa2-mercy M1-M7（WS quick） | ◐ 部分：链路存在性+ctl 基线锚 n=11 零漂移+生态位+8min 窗+清零语义 ✓；L1/L2 数字锚未采样完（harness 制败侧，见 §3/O-7） |
| 满编 2v2+第 5 人观战（FEEL 焦点光圈） | qa2-web W2/W3 | ✓ 4 真人四席+F11 焦点环台账+环形金墨水探针（见 §4） |
| 回归抽查 2 作 | api-check pool/mini-moba | pool-physics 19/19 ✓ ｜ mini-moba 22/22 ✓ |

## 2. 200ms 延迟对照（qa2-net 34/34 绿——`scripts/street-soccer-qa2-net.mjs`）

- **N1 时延带**（250ms 弃样窗=O-2 口径复用）：d0 房 shot P95 48ms(n=7)+tackle P95 143ms(n=12)（帽 600）✓；d200 房 tackle P95 247ms(n=15)（帽 900）✓；shot/pass 持球窗盲窗弃样（reject 在账 30 例=受理回路完好，QA1 已知采样劣势口径）✓
- **仲裁不偏向低延迟者**（§5.4⑤）：tackle 胜率 0ms=5% vs 200ms=13%（|Δ|=8%<35%）✓——服务器权威仲裁无延迟项
- **S3/S4 和解通道在 200ms 垫臂完整**：ext.ack 单调不减（×692）+ext.hash 周期在场（×68，末例 1066537894）✓——预测/确定性链路不受垫臂破坏
- **触球反馈链数据源**：touch 事件×192+增量快照球 owner 镜像 692/692 恒带 ✓——FEEL 层触球反馈（F01 形变等）的伺服端数据源在 200ms 下不缺失；首绘 ≤80ms 红线由 FEEL 单 feel-check 17 面证（交叉引用）
- **N3 长局 spot**：maxTicks=6000 硬顶房 spot×9 tick 单调（末 tick=3624）+终局 time-up winner=B tick=3680（终态锚 stateHash=3255398145 在场）✓；goal 事件==终态队分（A6 口径同源）✓
- **N4 O-3 混跑抽验**（BOT 单 N4 决策级 A/B 的在线方向性，双 seed 聚合）：comp 队进球 6:0 压制 casual 队 ✓+comp 触球 76>casual 33（站位卡线+接散球路径压制）✓；steal/tackle 数据面披露（行为谱差异非压制失败——QA1 §4 注同源）

## 3. 放水链在线验证（qa2-mercy——`scripts/street-soccer-qa2-mercy.mjs`）

**路径结构性论证**：pulse 台账（rooms.js `finish()` 按 `META.pulseTeam` 记账）为 WeakMap keyed **conn**、跨房累积——testapi 房每房一次性 vctx、单局即弃，**结构性不可累积 pulse**（这正是 sim 注释「api 剧本房单局 pulse 恒 0」的机制面）。故在线验证走 **WS quick 真实路径**：真人 W 单 conn 连续对局（quick 自建房=全 balanced bot，W 让位入席 seat3，敌席 0/2、队友席 1），败局自然累积台账 → doFrame 每拍算 foeLose 注入 botEnv → sim brain 放水链。

**数字信号锚**（quick 自建全 balanced 房独有——档位信号不受 seed 影响）：balanced 射门门 `distG<140k` → pow 恒 650 档；L1 让力 `powMul=85%` → 恒 552 档；L2 降档 bal→cas（CASUAL pow 400-800 ×85% = 340-680 散布）。

<!-- MERCY-RESULTS -->
**6/9（部分完成——3 失败均为 harness 制败侧阶梯未爬完（n=0 类），产品行为零异常观测）**，墙钟 668s/35 局尝试（三跑迭代：首跑死锁三因见 O-5；终跑=全档 fresh 自建 1600-tick 局）

**结构链全量代码实证**（在线路径存在性）：`rooms.js:432-438` finish 按 `META.pulseTeam(seat,winner)`（street-soccer.js:141 席位奇偶→队属）记 WeakMap 台账（胜=断连败/负=连败++）→`rooms.js:362-375` doFrame 每拍算 `foeLose[seat]`=对席真人连败最大值注入 `botEnv`→sim brain 放水链；台账 keyed conn 跨 quick 房存续（W 单 conn 35 局尝试全程零断链实证）。队友席同取 foeLose=生态位让位链（设计面，非泄漏）。

- **M2 基线锚 ✓**：ctl 局（连败<2）敌席 balanced 射门 pow≡650——**n=11 值域 650-650 零漂移**（m1 ×5/m3 ×4/m33 ×2，跨 goal-cap 与 time-up 两型终局）
- **M1b O-1 抽验 ✓**：quick bot 房真人让位入席 fresh 房 ×4（席位让位=网关 join 路径）
- **M5 生态位让位在线观测 ✓**：放水档（台账活性局）队友席 pass→W 9 次/局 vs ctl ≈4.7 次/局（让球权方向性成立；软锚口径同 BOT 单）
- **M6 8min 墙钟窗交叉引用 ✓**：墙钟 668s+逐局 goal 事件==终态队分 4/4（A6 口径同源）+hash 哨兵 ×945——长局 spot 的真实路径侧证（与 net 臂 N3 6000-tick 硬顶房互文）
- **M7 WS 面零异常 ✓**：无 error 消息/无断链（errs=0 closed=0）
- **胜即断连败语义在线实证**：m15（loseIn=2，台账活性中——敌席处于 L1 放水态）W 队 3:1 反胜（time-up）→台账立即清零回 0——协议「胜=断连败」按设计生效，且该局结局与「敌席被让力后战力下降」方向一致（间接证据，非数字锚）
- **M1 ✗/M3 ✗/M4 ✗（harness 侧披露）**：连败阶梯未爬完（局序 c败→c败→L胜→c败=3 败，未达 L1/L2 采样窗的成局样本）——制败器（est 乌龙策略）依赖 W 持球，bothost 房流+goal 庆祝墙钟（暂停比赛钟但走墙钟，高分局可拖 ~20s 过帽）+队友 bot carry 逆胜三因叠加，11min 帽内不可稳定达 lose≥4。**L1 让力 pow≡552/L2 降档散布两数字锚在线未采样**——行为档已由 BOT 单（GAMES-140）决策级 A/B 离线闭合，本单在线面=链路存在性+基线+生态位+清零语义全证，数字锚留观察项（O-7）后续复跑

## 4. 满编 2v2+第 5 人观战·FEEL 焦点光圈（qa2-web）

<!-- WEB-RESULTS -->
**9/9 绿**（`QA_WEB`/`QA_GW_WS` 环境改道：页面源=私有静态臂 `:4417`（`WEB_DIR=web`，与生产 :4399 同源零感知——QA1 期 :4399 生产常驻在本环境未起，故同构复刻），WS=`?gw=` 影子网关 :4416）

- **W1 quick 页·让位入席（O-1 客户端面）**：真人优先顶替 bot 席（seat=3）✓+F08 让位提示环台账在案（就席=席位让位完成时点）✓+roomId 落 sessionStorage（?room= 拓扑入口）✓
- **W2 满编 2v2 真实路径**（QA1 P4 复刻·FEEL 后复验）：4 真人四席互异 `[3,2,1,0]`（bot 全让位）✓
- **W3 第 5 人观战**（FEEL 后）：seat=-1（welcome 实证非初始假信号——QA1 假信号锚口径）✓+快照流同观（ball.x 175000→196665 同流推进）✓+**F11 观战焦点球光圈台账**在案（lat=36ms）✓
- **焦点环页内墨水（FEEL F11 落地闭环）**：球屏位环形 r10-18×36 采样×3 帧——观战页命中 7/60、5/60、5/60 vs **对照=球员页同环 0/60** ✓（金晕 #FFD86B 脉动仅在观战导演位着墨；F03 拖尾瞬态被持续帧滤除）；零 pageerror 全轮 ✓
- 截图证据：`kernel/workers/GAMES-142-shots/qa2-{spectate-focus,fullhouse}.png`

## 5. QA1 观察项复核

- **O-1 让位语义（抽验闭合）**：mercy 臂 W 全程 quick bot 房让位入席（席位=网关 join 路径，M1b 断言 fresh 房入席×4）+web 臂 F08 让位提示环台账（就席=席位让位完成时点，FEEL 面）。BOT 单 N5 复核无缺陷结论维持；观战入口语义（?room= 到 bot 房让位入席/满员房旁观）与 QA1 记录一致，无新证据。
- **O-2 时延对齐伪带（已记案例，复核不复发）**：本单 N1 全程 250ms 弃样窗口径，d0/d200 两房带均在帽内且量级符合「受理+组包+垫臂」物理预期（d0 shot 48/tackle 143ms vs d200 tackle 247ms），未见 ~700ms 伪带复发——QA1 归因（错配到下一次注入受理=策略节拍伪影）维持。
- **O-3 混跑对位（抽验闭合）**：N4 双 seed 在线聚合——comp 进球压制+触球压制方向性成立；QA1 预留的「预判档对蜂群档」拦截压制数据面由 BOT 单 N4 决策级 A/B 闭合+本单在线方向性复证。

## 6. 退回项清单

**无 P0/P1 退回项。** 产品红线全过（冻结命令 39/39+qa2-net 34/34+qa2-web 9/9+回归 2 作）。qa2-mercy 3 失败（M1 连败 3<4/M3 L1 n=0/M4 L2 n=0）均为 harness 制败侧阶梯未爬完——全程观测到的产品行为（650 基线零漂移、胜即清零、goal==队分、WS 零异常）全部符合协议设计，无产品缺陷证据，故不入退回清单（口径：退回=产品行为违背设计）。

## 7. 观察项（低危，接 QA1 编号）

<!-- OBSERVATIONS -->
- **O-4（低危·口径注记）N2-r5 手感层 stam 断言弱**：断言名「复席后快照续流体力值在场且演化」实作仅在场性检查（`typeof number && !== -1`）——本跑 welcome stam=100000→续流 100000 同值，未获「演化」正样本（断线 5s 窗内席位静止零消耗所致）。四键延续面（stam/lungeT/stumbleT/tackleCd）在场性已证；后续复验若需证演化，应断线前先制造体力消耗再复席采样。蓄力为本地瞬时态随断线弃、不属服务器延续面——脚本内口径注记维持。
- **O-5（低危·QA 件口径，非产品缺陷）mercy 制败链首跑死锁三因+终跑两残余**：死锁①est 帽 105s<ambient 房局长 180s（bothost 默认 3600 ticks，est 容忍入龄房→结构性 no-end）②no-end 弃房回灌 quick 池→ambient-abort 连环（弃局不记账致连败停滞）③skip 日志打印错字段（顶层 `fail` 而非 `m.fail`，显 `[undefined]` 掩盖 no-end 真因）。二跑修订：全档 fresh 自建房+局长 1600 ticks+帽式对齐（详见 §9 修订披露）。终跑残余（阶梯仍未爬完的两因）：④goal 庆祝相位暂停比赛钟但走墙钟——高分局 5 庆祝×~4s 可把 80s 局拖过 92s 帽（终跑仍见 no-end）⑤est 制败依赖 W 持球，队友 bot 可 carry 逆胜（m15 3:1）→「胜即断连败」清零台账。放水链本体（台账/注入/行为档）无恙——死锁全程在 harness 制败侧。
- **O-6（低危·字段面披露）F08 让位提示环台账 lat=null**：web 臂 W1 读 FEEL fx 台账 F08（让位提示环）`lat=nullms`——台账条目在场但 lat 字段缺省（对照 F11 lat=36ms 有值）。就席时点类 fx 无时延语义或漏记，建议 FEEL 台账统一 lat 口径（不影响本单判据：F08 判据为在案非时延）。
- **O-7（低危·复跑项）L1/L2 放水数字锚在线未采样完**：连败让力 L1（pow≡552）/L2 降档（340-680 散布）两数字锚的在线触发未在 11min 帽内完成采样（harness 制败侧三因见 O-5，终跑局序 c败→c败→L胜→c败）。行为档本身已由 GAMES-140 决策级 A/B 离线闭合+本单链路存在性/基线/生态位/清零语义在线全证；建议后续单以「est 帽 ≥115s（goal 庆祝墙钟余量）+禁 mate 档位依赖+可多次重试的连败爬档器」复跑补锚。

## 8. 回归抽查 2 作（共享 harness 面）

- `api-check pool-physics`：19/19 绿（S3/S4 先例作，共享 testapi/rooms/sims harness 零扰动）
- `api-check mini-moba`：22/22 绿（放水链同源作——pulse/foeLose 链框架面无扰动）

（结果 /tmp/qa2-142/reg-{pool,moba}.log；报告 kernel/workers/GAMES-41/api-check-{pool-physics-20261015004029,mini-moba-20261015004148}.json——本单实测复跑）

## 9. QA 件清单（本单新增，零产品代码改动）

- `scripts/street-soccer-qa2-net.mjs`——net 臂 34 断言（N1 延迟对照/N2 重连三档+手感层延续/N3 长局/N4 混跑抽验）
- `scripts/street-soccer-qa2-mercy.mjs`——放水链在线验证（WS quick 真实路径+饱和器+燃位器）
- `scripts/street-soccer-qa2-web.mjs`——浏览器臂（满编+观战 F11 焦点环）
- 复跑：影子网关 `PORT=4416 HOST=127.0.0.1 GATEWAY_LOG=/tmp/qa2-142/gw.log GATEWAY_PID=/tmp/qa2-142/gw.pid WEB_DIR=web node server/gateway/index.js &` + 静态臂 `PORT=4417 HOST=127.0.0.1 DATA_DIR=<tmp> WEB_DIR=web node server/index.js &` 后依次跑三脚本（`QA_GW`/`QA_WEB`/`QA_GW_WS`/`QA_SHOTS` 可覆写）
- **二跑修订（首跑 PM 抢救件自测暴露，均 QA 件非产品码）**：mercy 终态=全档 fresh 自建 1600-tick 局+帽式对齐（`MATCH_TICKS*50+12s`）+skip 日志打 `m.fail`（演进：105s 帽→138s 帽→fresh 自建，见 O-5 三因五残余全记录）；web 页面源/截图目录 env 化（:4399 未常驻环境可复跑）+环形探针 NaN 坐标守卫（ball 态瞬态缺键曾致 getImageData 崩）
