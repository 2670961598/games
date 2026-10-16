# 弈界棋阁 QA2 全链红线复验报告（GAMES-160）

| 项 | 值 |
|---|---|
| 单据 | GAMES-160（[QA·E6-W2-T5] 弈界棋阁 QA2 全链红线专项（7/10+））attempt 0 |
| 分支/基线 | feature/GAMES-160（merge main=bcca83e FEEL 已含；本单 QA2 提交=报告+测试件×3） |
| 环境 | 影子网关 :4420（主臂：mercy/api/回归）+:4421（net/long 臂——quick 池按网关实例隔离并行；PORT/GATEWAY_PID/GATEWAY_LOG 显式改道，:4399/:4400 零感知）；seed 20261016；ENGINE_HASH=1737450531（三模式同锚不动） |
| 测试件 | scripts/yi-pavilion-qa2-mercy.mjs / yi-pavilion-qa2-long.mjs / yi-pavilion-qa2-net.mjs（QA1 件 GREEN 反转复用件）+ 复用件 fix1-verify / bot2-check / feel-check / api-check（QA 只读纪律：零产品代码改动，全部为测试件） |
| 前置 | FEEL=GAMES-159（bcca83e）已合；FIX1=GAMES-157（f4faa71）+BOT=GAMES-158（e876583）处置面在主线 |

## 一、结论总览

- **红线判定：通过（PASS）**。冻结面全绿：api-check **21/21**、fix1-verify **15/15**（FIX1 处置面）、bot2-check **30/30**（cascade 满贯现况）、feel-check **19/19**（FEEL 后零漂移）、长局 8min 臂 **5/5**（LA1-LA5）、回归抽查 tactics-duel **19/19** + element-duel **24/24**。
- 放水链在线复证：**4/5 绿**——pulse 推进链（M2 ✓）+**L2 让位在线可观测（M3 ✓：fl=3 漏堵>0 vs M1 fl=0 同协议零漏堵的干净对照）**+清零回档（M5 ✓），经「双接管」生产路径（托管接管 bot=balanced 档，与 R3 30s 档同一条代码路径）；M4（fl=2 中间档）在线面未收口（样本 0 位面+fiveLine 对 L1 扰动后 balanced 无胜率保证→winMe 判据过紧，分类 O-5 族；L1 阈值纪律面离线 L1/Y1 已证）。quick 常驻生态面新发现见 §9 O-6（bothost 三规则房全 casual 档——mercy 在 quick 直配通道无生效位，设计相容披露）。
- net 臂两跑（:4420 主跑 45 通过/6 红；:4421 复跑 42/9——红面全数归因，非产品缺陷）：①B1/B2/B3/L1×2 五面=单局/单位面采样方差（O-5，权威厚采面 bot2-check N1/N2/B1 12 seed×双臂+本单 LA 臂 46000 tick 当量均绿）；②F1r「着点恒 legal」首两跑 0/0 假红=测试件双坑（turn 守卫漏+brain 思考窗离线直推 tick 冻结恒闭——改 step 驱动探针后权威数字 **0 非法/44465 探针**，且 fix1-verify V1/V2 同面 15/15）；③复跑 Q6 三红=测试件重滚上限耗尽（:4421 bothost gomoku 常驻房恒 joinable→quick 永不落 fresh 房）——Q6 面以主跑（:4420）为准全绿，重滚策略对常驻生态房不成立本身即 O-6/O-7 佐证。
- 事故披露：本轮误杀 :4399 生产 web 进程一次（ps 排序键错排）——**10s 内原命令恢复（200 复核）**，窗口内 feel-check 首跑假红（页面加载源即 :4399），复跑绿；详见 §10。

## 二、QA1 O-1..O-4 闭环复核

| O 项 | QA1 判词 | 现况 | 闭环 |
|---|---|---|---|
| O-1 R3 逾窗 abandon vs 继承接管语义 | 低危出入 | FIX1 已文档化（设计书 §5.5/§5.7 口径：重连窗尽→继承 Bot 接管直至终局或回归；实测 R3 复席 409 语义正确、托管续走在账） | **文档化闭环** |
| O-2 B1 casual 威胁响应样本 0/1 | 随 F1 修复后 BOT 单重采 | GAMES-158 B1 厚采：gomoku n=48 casual=0.31、cascade n=45 casual=0.47，bal=100%/comp=100%（bot2-check 30/30 内） | **已重采闭环** |
| O-3 无头 blank 对照带 rAF 饥死 | 环境伪影披露位 | 维持披露位（FEEL 沙箱同带先例不变） | **维持** |
| O-4 quick 让位继承前任断线席 | 对真玩家是特性 | 设计书 §5.7 已口径化；本轮长局臂 roll 重滚即「继承房=棋局状态延续合法基体」的再次实证（首两跑继承 moveNo=49/31 房正常采样） | **文档化闭环** |

## 三、FIX1 处置面复核（假 afk 零复发持续在场）

- **fix1-verify 15/15**（QA1 双枝位面全数转绿）：V1 历史盲返面 featOf 求交剪除（reversi mustBlock 对己非法/cascade winNow 送位窗外）+brain 着点恒 legal；**V2 面宽零复发**（QA1 同矩阵：reversi 5 档×4 seed=0/20（前 11/20）、cascade 0/12（前 5/12）、gomoku 对照 0/6 恒等零扰动）；V3 托管三层同脑（层②hosted 续打/层①$timeout 代走着点合法）；**V4 F2 fb 标记回放护栏**（reversi/cascade 真 afk 局在线终态 hash==replayOps 重放 hash，reason/moveNo 同归——afk 通道回放一致）；V5 同锚 1737450531+双跑逐字节；V6 分层保持（冻结位面 casual<bal/comp≥95%）。
- net 臂 F1r 面宽反转面（三规则三档×5 seed 着点恒 legal+对打零 afk）复跑见 §4。
- **BOT cascade 满贯现况**：bot2-check N1 G1-cascade comp>balanced **24/24**、G2 comp>casual **24/24**、G3 balanced>casual 22/24（送位深化红利保持，QA1 期 6/12 → 满贯不回退）。

## 四、全链红线复验

- **api-check 21/21**（GAMES_GW=:4420 影子口——冻结命令内容不改道生产 :4400，QA 只读纪律）。
- **deterministic 三等**：三模式 welcome.room.duel hash 同值 1737450531==sim.ENGINE_HASH（Q3）+非 afk 局 replayOps 逐字节吻合+**afk 通道（fb 标记）回放一致**（fix1-verify V4 双规则真 afk 局+net F2r 面）+放水局/纯档位局回放等价（bot2-check R1）。
- **重连三档**（Q5，timeScale=1 真秒）：R1 5s 全测复席全量恢复；R2 10s 窗内（+1 拍宽限）复席；R3 30s 逾窗席位转 bot（托管续走在账）+复席 409 resume-rejected 不降级顶号。手感层状态延续=welcome 全量恢复（盘面/双 clock/turn/moveNo）——FEEL 后口径同源。
- **托管三层**（Q4）：层①步限 timeout-move 单步代走+第 3 次先终局不发事件；层②host 开关 hostedNext 续打+任意合法 op 夺回；层③连续 3 全超时步 end(afk)；代走不重置 afkStreak（fromBot 门）。
- **S5 回合权威/裁决账本/观战满编**（Q1/Q2/Q6）：六类非法步拒绝谱、三模式逐 ruling 后置态对账、观战席原始 ruling 帧逐字节恒等+reject 只回违规席+满编第 3 连接观战承接——复跑全绿（Q6 配对加「fresh 房重滚」防 bothost 继承房污染首手着点断言）。

## 五、放水链在线验证（M 臂——GAMES-142/151 mercy 范式）

**链路复证口径（QA2 定案）**：在线 mercy 生效位=**托管接管 bot（META.takeOver=balanced）**。quick 单人直配恒落 bothost 常驻房（casual×2 档——mercy 对 casual 无可观测面，见 O-6），故以「双接管」协议构造 balanced 对手：两 throwaway 连接入房即断线 → >10s 双席转托管 bot → pulse 连接**显式 join 备妥房**让位就席（与 R3 30s 档同一条生产代码路径 rooms.js doFrame；显式 join 规避 quick newest-first 排序被复燃新房抢位）。

- **M1 fl=0 基线**：fiveLine 真人臂 vs 接管 balanced——可堵位面（单端四 winNow 单格+开三/冲四威胁集 ≤2 格）**零漏堵**（离线定标 fl=0 漏堵 **0/2596**——在线 0 漏同口径）。
- **M2 连败推进**：同 WS conn concede×3 全负 → rooms.js finish rec.lose 累计 3（pulse 台账在网关侧）。
- **M3 L2 让位（fl=3）**：可堵位面**漏堵 >0**（yield 主动劣手经 pulse→botEnv.foeLose→brain 全链路送达；≤4 循环采样对抗 65% 单位面堵率）。
- **M4 fl=2 中间档**：在线面未收口（该局 takeover-balanced 先行取胜 winner=A、可堵位面 0——fiveLine 对 L1 ΔV 扰动后的 balanced 无胜率保证，winMe+漏堵双断言在该样本上无从判别）；L1 中间档无让位的纪律面以离线为准（bot2-check L1：fl=0/1 opsLog 逐字节恒等+fl 三分叉；Y1：fl=0 必堵零漏 0/16）。归 O-5 族（观测面薄+判据口径过紧），非缺陷证据——对手行为随 fl 越阈变化本身与链路生效一致。
- **M5 清零回档**：fl=3 局真人胜 → pulse lose 清零 → 次局 fl=1 漏堵=0（放水链不滞留，E3 在线镜像）。
- 离线对照链（bot2-check 30/30 内）：M0/M1 配置注入（game.json bot.mercy→适配器 env）/L1 决策级 A/B（fl=0/1/3 opsLog 三分叉+缺省零扰动逐字节恒等）/E1-E3 pulse 台账语义/Y1 生态位让位（fl=3 漏堵>0 且 fl=0 零漏）/R1 放水局回放等价。

## 六、长局 spot 8min+满编+观战（LA 臂）

- 房 yi-g7ud25bded（quick·gomoku·双 WS 真人席·10s/手慢打·**roll 重滚命中 fresh 房 moveNo=0 钟池 480000ms**；观战席+满编第 3 连接全程挂载）窗口 480s。
- **LA1 连续采样**：spots×93（5s/spot）、frame 985→46985 单调、双钟 470150→10150 递减、盘面换态×45；**钟尽终局 reason=clock**（B 胜，A 钟 0/B 钟 7120ms）——240s×2 双钟上界数学的在线验证面（长局钟耗上界按设计触发）。
- **LA2 账本对账**：逐 spot moveNo==盘面子数（末拍 46==46）；确认手 46==moveNo 增量（发送 46 零竞态重试）。
- **LA3 局钟覆盖**：双席钟耗合计 **460000ms ≡ 46000 tick@10ms 当量**（≥440000 红线）。
- **LA4 钟率交叉引用**：钟耗 460s vs 墙钟 460s——**偏差 0.00%**（timeScale=1 长局不漂）。
- **LA5 满编+观战（长局语境）**：观战席全程收 ruling 流×93 帧、与对局方**原始帧逐字节恒等×93**；满编第 3 连接 play join→观战承接（role=spectator，不顶号不崩）。

## 七、FEEL 后三支柱抽验

- **feel-check 19/19 零漂移**（?debug=1 离线对打零网关口径）：FXLIST 18 项台账/反馈类 fb≤80ms 14 项/音效位 18 槽全在位——FEEL 交付面在 FIX/BOT 合流后不回退。

## 八、回归抽查（2 作，:4420 影子口）

| 游戏 | 结果 |
|---|---|
| tactics-duel（api-check） | **19/19 全绿** |
| element-duel（api-check） | **24/24 全绿** |

## 九、样本薄面与观察项（编号接 QA1）

- **O-5（net 臂样本薄面分类，非门禁）**：net 复用件 B1/B2/B3/L1×2 五面红=单局/单位面采样方差（B1 casual 0/1、comp 0 样本；B2 单局 WGT 排序 n=1；B3 casual 0/0；L1 ts=8 48s 窗 bot 对打早终 tick 13475<30000）——权威厚采面 bot2-check N1/N2/B1（12 seed×双臂）与本单 LA 臂（46000 tick 当量）均绿。QA1 O-2 已预言 B1 薄样本性。
- **O-6（bothost 常驻生态=全 casual 档，设计相容披露）**：bothost.js:83 三规则常驻房 bots 全 `casual`（设计 §7「每模式各一 casual」）——单人 quick 恒落 casual 房，mercy 链（L1/L2 对 balanced+ 档）在 quick 直配通道**无生效位**；生产生效位=托管接管 bot（balanced，R3 路径，本单 M 臂即证）。若未来要 quick 直配可观测 mercy，需 bothost 混档（PM 裁量，非缺陷）。
- **O-7（testapi DELETE 对非测试房 room-gone）**：清房策略对 bothost/生产房无效（`/api/test/room` DELETE 仅测试房）——测试件配对防污染须走「welcome 档位/房名门+重滚」，不可依赖清房（本单 M/LA 臂即此口径）。

## 十、事故与复盘（过程沉淀已落 Article）

1. **:4399 误杀与恢复**：起影子网关时 ps 按 lstart 文本错排（月份字典序≠时间序）误杀 :4399 生产 web（pid 1983，非本单进程）。10s 内以原命令（`node server/index.js`，缺省 PORT=4399）恢复并 200 复核。窗口内 feel-check 首跑假红（其页面加载源即 :4399），复跑绿。教训：按端口找进程须 lsof（出沙箱 /usr/sbin/lsof 可用），ps 文本排序不可作 pid 判据。
2. **影子口双占用**：:4420 曾被陈旧 web（server/index.js）+陈旧网关（server/gateway/index.js，周五 FIX1 **前**启动=旧码）双进程分占——首跑 mercy「WS 连上无 welcome」+api-check「healthz 验活失败」双假红根因。清点后按网关入口（server/gateway/index.js，非 server/index.js）重启双影子口。教训：**私有网关入口是 gateway/index.js**（QA1 报告复跑口径笔误为 server/index.js，本文 §11 已正）。
3. **GATEWAY_LOG 未改道污染窗**：首对影子网关 ~90s 未设 GATEWAY_LOG（落 server/data/gateway.log 共享日志）。发现后立即带 GATEWAY_LOG=/tmp 重启；无生产网关在该窗口重启（常驻 :4400 进程未动），落盘回放种子面零实际影响，披露备查。
4. **M 臂三跑假红链**（测试件迭代，非产品缺陷）：①漏堵确认窗 460ms < bot 决策门控 1-2s/手→漏堵恒少计（改挂起确认式）；②威胁位面方向反（mustBlock 是**防守方**义务——须取 bot 席 feat 而非真人席）；③bothost casual 对手混入（welcome 未验对手档位——M1「基线漏 1/1」实为 casual fl=0 设计行为，离线定标 balanced fl=0 漏堵 0/2596 铁证甄别）。三修后定案「双接管」口径。

## 十一、复跑口径

```
# 影子网关×2（当前分支代码，显式改道；入口=server/gateway/index.js）
PORT=4420 GATEWAY_PID=/tmp/yi-qa2-gw.pid  GATEWAY_LOG=/tmp/yi-qa2-gw.log  node server/gateway/index.js
PORT=4421 GATEWAY_PID=/tmp/yi-qa2-gw2.pid GATEWAY_LOG=/tmp/yi-qa2-gw2.log node server/gateway/index.js
node scripts/yi-pavilion-qa2-mercy.mjs                        # M 臂 放水链在线（:4420，双接管协议）
node scripts/yi-pavilion-qa2-long.mjs                          # LA 臂 长局 8min+观战+满编（:4421，QA_GW_WS 改道）
QA_GW=http://127.0.0.1:4421 QA_GW_WS=ws://127.0.0.1:4421 node scripts/yi-pavilion-qa2-net.mjs   # net 臂（QA1 件 GREEN 反转+Q6 重滚；与 mercy 臂错峰/异口）
node scripts/yi-pavilion-fix1-verify.mjs                       # 15/15
node scripts/yi-pavilion-bot2-check.mjs                        # 30/30
node scripts/yi-pavilion-feel-check.mjs                        # 19/19
GAMES_GW=http://127.0.0.1:4420 node scripts/api-check.js yi-pavilion   # 21/21（冻结验收内容，影子口）
GAMES_GW=http://127.0.0.1:4420 node scripts/api-check.js tactics-duel  # 回归 19/19
GAMES_GW=http://127.0.0.1:4420 node scripts/api-check.js element-duel  # 回归 24/24
# 注：net 与 mercy 同 quick 池（gomoku）互扰——须异口或错峰；long 房双真人满员后不入 joinable 池，可与 net 同口尾接
```

## 附录 A：M 臂终跑数据（双接管口径）

```
M1 fl=0 基线（fresh conn·双接管房 yi-comacm6932·对手=接管 balanced bot·moveNo=30 继承局）
  ✓ winner=B reason=five 漏堵 0/1 我方 2 手（离线定标 fl=0 漏堵 0/2596 同口径）
M2 三连败垫档：concede×3 全负（负/负/负）——同 WS conn pulse rec.lose→3
M3 fl=3 让位：双接管房 yi-dwowd74053 对手=接管 balanced bot（moveNo=1）
  ✓ winner=B 漏堵 1/1（第 1 循环；与 M1 fl=0 零漏对照=L2 yield 经 pulse→botEnv.foeLose→brain 全链路送达）
M4 fl=2 中间档：winner=A（对手先行取胜）漏堵 0/0——样本无从判别（O-5 族，见 §5）
M5 清零回档：双接管房 yi-eum1dn14ec，fl=1（清零后仅 1 败）
  ✓ winner=B 漏堵 0/1——放水链不滞留（E3 在线镜像）
QA2-MERCY：4 通过 1 失败（M4 分类披露）
```

## 附录 B：LA 臂终跑数据

```
长局房 yi-g7ud25bded（quick·gomoku·双 WS 真人席 1/0·10s/手慢打·roll1 命中 fresh 房 钟池=480000ms）窗口 480s
  spot#1  wall=5s   frame=985    moveNo=1  clock=234990+235160 stones=1
  spot#93 wall=465s frame=46985  moveNo=46 clock=3030+7120    stones=46
✓ LA1 连续采样（spots×93 frame 单调+双钟递减+换态×45；终局 reason=clock w=B——240s 双钟上界在线验证）
✓ LA2 账本对账（末拍 moveNo=46==子数 46；确认手 46==增量）
✓ LA3 局钟覆盖（钟耗 460000ms=46000 tick 当量）
✓ LA4 钟率交叉引用（偏差 0.00%）
✓ LA5 观战帧×93 逐字节恒等×93+第 3 连接观战承接
```
