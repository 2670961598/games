# 迷你MOBA 压测+单链收官 —— GAMES-136

> 单据：GAMES-136（L2 常规 · attempt 0）｜基线：main@173dd9f（GAMES-135 VIS 已合并）｜分支：feature/GAMES-136
> 证据：`/Volumes/BigDisk/Studio/kernel/workers/GAMES-136/`（影子树 shasum 留档、A/B/C/rss 工件 JSON+日志、gateway.stdout/.2nd、chain-driver.log 事故实录）
> 预算：起跑计时 ≤25 分钟（实测见 §F——超帽 ~8min 全部为工具侧事故，逐条披露）；压测计时锚=A 组起跑
> 里程碑：**平台第 10 条完整单链（E6 双位数）+ W2 波第二款收官 + E6 总进度 10/21**（战图 §4.3 已回填）

## 0. 结论速览

- **A 组 多房并行 PASS**：6 间迷你MOBA 3v3 测试房（[null(API 席)+balanced×5]，6/6 满载、实体量=前几作最重：英雄×6+兵线+塔+圣所）8 分钟 ts2 churn，12 世代全终局、tick 漂移 **p50=0 tick / 包络 [-2,+1] tick**（ts2 下 1 tick=50ms → p50≈0ms、包络 [-100,+50]ms）、feed 全量校验零错、零 429、零 uncaught（§A）。
- **B 组 长局交叉引用 PASS**：十单已有观测汇总合计 ≥60 分钟覆盖（§B.1，不重跑）+ 满编 spot 3v3 满员+第 7 人观战 9 断言全绿（§B.2，b-spot v2；v1 两枚探针口径缺陷如实披露归档）。
- **C 组 混编 PASS**：十游戏同网关 5 分钟（E6 全家福——S1-S7 全技术轨在场，mini-moba 为第 10 款 sims 注册表成员），第 9 间测试房护栏 429 证据（§C）。
- **无泄漏四件套 PASS**：RSS 二段起点重置 + 句柄数平稳 + 房间回收闭环（ended→dispose→槽释放→shutdown dispose）+ 日志零 uncaught（§D）。
- **档案**：docs/game-quality.json `multiplayer:mini-moba` → **accepted（单链 10/10 完整无跳过）**；战图 §4.3 E6 10/21 回填。
- **实录**：知识库草稿《迷你MOBA开发实录》已投递（S2 复用第二款/S2+S5 边界首证/A3 剧本口径/O5 推塔调参/观战导演 UI）。

---

## A. 多房并行：6 房 8 分钟（tick 漂移/CPU/RSS 曲线）

影子网关 :4426（影子树 `shasum-repo.txt` 留档与 repo 逐字节一致——server/ 全拷+games/web 符号链接、data 随影子路径隔离、GATEWAY_PID 改道；生产 :4400/:4399 零感知——压测期间生产网关 pid 1983/70073 原样应答，rss2 终检 pidsUnchanged）。6 间 mini-moba 测试房（`[null(API 席)+balanced×5]` 6 席满 3v3、错峰 5s 建房防世代同步）、10s×48 采样、dispose 感知 churn（ended→DELETE→立即重建，GAMES-116 A2/GAMES-125 范式）。

**时标选型**：ts=2（tickMs=100 名义 10Hz → 有效 20tick/s）+maxTicks=3600（ts2 下 ≈180s 一世代 → 8 分钟窗 2 世代/房）。实测全部 12 世代终局 tick=3600（maxTicks 硬顶）——ts2 压缩局、API 席挂机无真人 carry 下 core-down 不抢先，与 GAMES-125「afk 语义终局」同型：**churn 由硬顶驱动、终局语义正确即达标**（core-down 终局语义已由 FIX2 A2/A3 真实收局实证，见 §B.1）。

| 指标 | 值 |
|---|---|
| 在场房数（采样均值/峰值） | 5.75 / 6（6/6 目标达成；世代翻转窗瞬时回落 5-6=ended 滞留挤兑，churn 固有生态，GAMES-116/125 同型） |
| 建房/终局轮换 | created 18（6 初始+12 重建）/ ended 12 世代（全部 timeout@3600t 硬顶；testDispose=21 含前置清障） |
| tick 漂移（n=258） | p10 -1 / **p50 0** / p90 +1 / min -2 / max +1 tick（ts2 下 1 tick=50ms：p50≈0ms、包络 [-100,+50]ms——10Hz 名义钟裕量大，调度抖动带优于战棋 100Hz 快钟 ±50ms 带与卡丁 20Hz [-1,+2]tick 同墙钟量级） |
| CPU | avg 16.74% / peak 36%（6×3v3 实体量重载下 <40% 单核占用） |
| RSS | 起 236256KB → 峰 239472KB → 末 239408KB（12 世代 churn 后 Δ+3.2MB≈零累积；曲线见 a-rooms.json samples） |
| 句柄 | 44→47→46→46→…→46（12 世代后平台稳定 46——与世代数不成比例=无按代累积） |
| feed 校验 | 全程 0 采样拍错误（mini-moba 第 10 款入 SEAT_CAP=6/PREFIX='moba-'/mode='3v3-moba' 九→十款注册表口径；测试房不进 feed=协议设计，feed 内 moba 房=bothost 常驻房 2 间） |
| 429/轮询失败 | recreate429=0 / pollFail=0 |

**工勘披露（前缀事实）**：房间前缀以 sim `META.roomPrefix='moba'` 为准（feed 字典序 element<empire<moba<mmo，设计 §7 有意为之）——首版 lib 登记想当然写 'mini-'（gameId.split('-')[0] 推导）全量假红，已修正。**教训：前缀登记表抄 META.roomPrefix，不脑补。**

## B. 长局交叉引用：≥60 分钟观测汇总（不重跑）+ 满编 spot

### B.1 十单已有观测汇总（合计 ≥60 分钟，不重跑）

| 单据 | 观测面 | 覆盖窗/样本 | 来源 |
|---|---|---|---|
| GAMES-126 D | 设计书（S2 复用第二款设计态：10Hz 二式快照/AOI 战争迷雾/草丛/ext.ack 预测和解/ruling 化战斗事件账本/数值表） | 设计态无运行窗 | docs/designs/mini-moba.md |
| GAMES-127 DEV | api-check 22/22 全绿（冻结命令）+浏览器冒烟+网关 96-tick 真实拍频 vs 剧本相位门 | 取证窗 ~10 分钟 | commit 系/kernel 工件 api-check-*.json |
| GAMES-128 QA1 | S2 专项 27/28（二式快照账本 **2400 张逐张复盘**=4 分钟连续流：节拍 1.000/退化阈值不变量/重建一致/AOI 零违例/ack 逐拍回显）+延迟锚 ms 级+O1 带宽峰值超预算/O2 梯度倒挂双观察项 | 取证窗 ~15 分钟 | docs/qa/mini-moba-qa1.md |
| GAMES-129 FIX1 | entView 白名单修复（先 grep 消费者：dmgLog 簿记占全量一半）+O2 半修（comp>balanced 3/3+casual 残项转后续）+冻结面复验 | 取证窗 ~6 分钟 | commit 系 |
| GAMES-130 BOT | 放水观测面塔杀污染修复（真人站中线安全位+kill 归因「被英雄杀」）+META.pulseTeam 团队作放水信号源+pickFoe 副产物 comp-vs-casual 残项转绿 | 取证窗 ~5 分钟 | commit 系 |
| GAMES-131 FEEL | fx 时戳 Date.now/rAF 混用存量死码修复（飘字从未可见）+无头 vsync 封顶时延口径+慢放负 age 钳零 | 取证窗 ~6 分钟 | commit 系 |
| GAMES-132 QA2 | 延迟/重连/满员预算版：D1 各局 12s×6+D2c 30s+D2d 全程快照流连续无断裂（长局 5 分钟面按任务书交叉引用 QA1 2400 tick 账本不重跑）+A3 剧本口径三坑定位 | 取证窗 ~25 分钟（预算版口径报告载明） | docs/qa/mini-moba-qa2.md |
| GAMES-133 FIX2 | O5 core-down 终局死码修复（A2 首次 core-down@4872 真实收局/A3 @4255 落设计带 3900-6300/镜像换席对称 5425/3903）+席位对称两候选实验定界 | 取证窗 ~8 分钟 | commit 821c477 |
| GAMES-135 VIS | 识图 v2 25 断言（home/play/settle/spec 四帧 DSF=1）+观战导演 UI+HF 字号 __applied 生效往返自证 | 取证窗 ~5 分钟 | docs/vis/mini-moba-vis.md |
| **本单增量** | A 组 8min + B spot ~2min + C 组 5min + rss2 二段（§A/§B.2/§C/§D） | ~16 分钟在线窗 | 本报告 |

合计在线/取证覆盖 **≥95 分钟**（≥60 分钟达标；各单窗口径为报告/工件所载取证窗，如实注记非连续墙钟）。

### B.2 满编 spot（3v3 满员+第 7 人观战，~2 分钟收官复检）

quick 真人 A（bot 补 5 席=3v3 满）→ 显式 spectate（第 7 人）→ 30s 稳定窗 10 采样。断言 **9/9 全绿**（b-spot.json v2 终版）：

| 断言 | 结果 |
|---|---|
| A quick 入房（role=player） | ✓（seat 入座，quick 单真人 bot 补席通道在场） |
| quick bot 补席 3v3 满编（humans=1/bots=5） | ✓ |
| joinable 语义（humans<6→true=bot 让位通道在场，协议 §2） | ✓（humans=1 → joinable=true） |
| 第 7 人 spectate welcome | ✓（role=spectator） |
| 30s 稳定窗席位保持（10/10 humans=1/bots=5/spect≥1/joinable 语义） | ✓（10/10） |
| 房活性（下行 frame 推进，MOBA 实时钟） | ✓（frame 1885→2185=300 帧/30s=**10Hz 名义钟正合**） |
| 房活性（feed elapsedMs 推进） | ✓（188522→218628ms） |
| 观战下行在流（第 7 人有字节流） | ✓（msgs=302/bytes=228469） |
| 零 reject（玩家席+观战席全程） | ✓（0/0） |

**探针勘误实录（v1→v2，如实披露）**：v1 版 6/9 两枚口径缺陷——① joinable 断言抄了战棋 2 席满员口径（joinable=false），但网关协议语义是 `joinable = humans < 席位cap`（bot 让位通道在场：满 6 席时第 7 名**玩家**仍可加入顶掉 bot），1 真人+5 bot 时 true 是协议正解；② 活性探针读 `m.tick`/`m.state.tick` 但 MOBA 下行帧真值在顶层 `frame` 字段（sim tick 只在 state 壳内、增量帧不带），tick 冻结 2266 而 msgs/elapsedMs 持续推进——GAMES-125 战棋 v5「勿猜消息字段层级」教训在实时帧游戏重演。v2 改 frame 口径+joinable 语义后 9/9。废弃工件归档 `b-spot.v1-joinableSemantics-frameField.json`（口径缺陷，非产品缺陷——v1 席位/满编/观战/字节流/零 reject 断言均绿）。

## C. 混编：十游戏同网关 5 分钟（E6 全家福画像）

十款 sims 注册表全集同网关在场（moba/slg/net/emp/pool/element/snake/speed 八款测试房 + mmo bothost 常驻镇 spectator 锚 + tactics bothost 常驻房 = feed 十款游戏），第 9 间测试房护栏 429。TICK_MS 分母按各款真值（pool/element/tactics=10、snake/moba=100、speed=50——GAMES-116 §C 口径教训沿用）；moba ts2 maxTicks 3600、snake ts3、speed ts2、其余 ts1。

| 指标 | 值 |
|---|---|
| 在场游戏数 | **10/10 全窗 30/30 采样**（E6 全家福：S1-S7 全技术轨+S1+S5 双技术复用款+S2 第二款；feed 房 19 间全窗稳定=8 测试房+mmo 常驻镇+bothost 常驻轮换房） |
| 第 9 间测试房护栏 | 429 too-many-test-rooms ✓（8 测试槽满载时第 9 间拒——语义正确） |
| 各款 tick 漂移 | mini-moba [0,1]（n=11）；empire [-1,0]（n=9）；net-tank [-1,0]（n=4）；pool [-4,0]（n=5）；slg [0,1]（n=3）；snake [0,0]（n=1）；speed-kart [-3,-1]（n=2）；**element n=0**——快钟短局 churn 后 anchor 随房丢弃（GAMES-125 tactics n=0 同型：`since` 增量轮询对高频短局游戏的稀疏 tick 观察面，探针口径非产品缺陷；本款 tick 纪律由 A 组 n=258 样本承载 p50=0） |
| churn 世代 | created 34 / ended 26 世代（net-tank 12/slg 4/speed·pool·snake·element 各 2/moba 1/emp 1——八款全部走通 ended→dispose→重建闭环；recreate429=0/pollFail=0） |
| mmo spectator 锚 | frameHz **10.002**（n=3052 帧；bytesFull p50=781B/bytesIncr p50=614B——S2 常驻镇双式快照账本画像） |
| MOBA 观战画像 | 本窗 openSpectator welcome-timeout 1 次（spectOpenFail=1，画像缺失如实注记）；MOBA spectate 通道本身由 §B.2 满编 spot 9/9 实证（welcome/role=spectator/字节流 228KB/frame 10Hz） |
| CPU / RSS | avg 18.5% / peak 33.5%；RSS 134016→228944KB（随 8 测试房+世代重建爬坡，终值=清场前快照；清场释放见 §D） |
| feed 校验 | 全程 30/30 采样零错误（十款注册表口径全量校验） |



## D. 无泄漏四件套

| 件 | 证据 | 结果 |
|---|---|---|
| ① RSS 二段起点重置 | 一段（pid 1398）：A 组 6×3v3 重载峰 **239472KB** → C 组清场后回落 123296KB → SIGTERM 优雅停机（shutdownDispose=29）→ 二段重启（pid 13557）：seg2b 补采样 4×15s **125680→126192KB**（60s 窗 Δ512KB 平稳、rooms 19-23 bothost 基线带） | ✓ 高水位随进程重置（二段起点≈一段清场基线、远低于一段峰值 239MB——非跨生命周期累积；GAMES-96/106/116/125 同型口径） |
| ② 句柄数平稳 | A 组 12 世代：44→47→46→…→46 平台（与世代数不成比例）；rss2 段末 42 → 二段 40 恒定 | ✓ 无按代/按时间累积 |
| ③ 房间回收闭环 | ended→dispose→槽释放全通道：A 组 12 世代+created 18/recreate429=0（8 槽无挤兑）；C 组 26 世代（八款全走通 ended→DELETE→重建）；gateway 全周期 room-dispose=ended 222（bothost 轮换）+test-cleanup 21+shutdown 29×2；清场后 healthz rooms 回落 19-23=bothost 常驻基线、feed 19 间全窗稳定 | ✓ 回收闭环+测试房零残留 |
| ④ 日志零 uncaught | gateway.stdout（一段全程，A/B/C 主窗）**0 条**；gateway.stdout.2nd 仅 1 条=双开事故孪生网关启动 EADDRINUSE（ts 19:28:10，§F.3 已披露事故窗内，非游戏/网关逻辑缺陷）；当前网关（13557）零 uncaught | ✓（事故窗单条如实归因披露） |

**rss2 工勘披露**：rss-phase2 首版 seg2 采样 rssKb/cpuPct/fd 全 -1/0——lib 的 PID 常量在 import 时冻结于 SIGTERM 前旧值（工具缺陷），seg2b 补采样按 pid 文件现值直读修复（rss-phase2.json `seg2b_supplemental` 节留痕）。生产零感知终检：:4399/:4400 pid 1983/70073 压测前后不变+healthz 应答正常（pidsUnchanged=true）。



## E. 档案与战图回填

- docs/game-quality.json：`multiplayer:mini-moba` → stage **accepted** / perf·play·visual=pass / iterations=10 / net.chain=GAMES-126..136 十单链完整（GAMES-134 为别单占用非本链）。
- docs/multiplayer-roadmap.md §4.3：迷你MOBA 行（T2 二款 · S2 · accepted 2026-10-14 收官）+ **E6 总进度 10/21（平台第 10 条完整单链·双位数里程碑）** + W2 波 2/7。
- 知识库草稿《迷你MOBA开发实录》经网关投递（PM 巡田转正）。

## F. 预算与工勘实录（超帽披露）

预算 ≤25 分钟、超 20 分钟转收尾。实测 ~33 分钟（起跑 19:07:56 → 冻结命令绿），**超帽 ~8 分钟全部为工具侧事故、产品零缺陷**，逐条披露（chain-driver.log 全程留痕）：

1. **前缀误登**（~1.5min）：首版 lib 前缀登记 'mini-'（按 gameId 拆词脑补），实际 META.roomPrefix='moba' → 全量 feed 校验假红，停机修正重发（§A 工勘披露）。
2. **僵尸测试房挤兑**（~2.5min）：首跑弃案后清理只对了 feed 卡片口径，6 间僵尸占满 8 测试槽 → 重发 A 组 #3 起 429 静默死循环（createWithRetry 无 429 日志）——按网关日志 test-room-create 全量幂等 DELETE 清算后恢复。教训：**弃案清障以网关日志为准，不以客户端账本为准；429 重试要落日志**。
3. **接力器双开**（~3min）：事故 1 停机时 pkill 旧 chain.sh 未命中（argv=./chain.sh 无路径）且重发时再起一实例 → 两实例同候 A-DONE、19:27:03/05 双双点火 C → 双 rss2 竞态：SIGTERM 打在活网关上（优雅 shutdown dispose、非崩溃）、pid 文件双写错位（11167 假尸/11172 真听）、一段垃圾采样。止血：杀双实例+假尸、pid 文件正写 11172、污染工件归档 `*.botched-doublefire`/`*.botched-doubleRss2`、单发 chain3 重跑——终版 A/B/C/rss2 证据全部单源干净。**教训：接力器单实例锚（pid 文件或锁），pkill 匹配用绝对路径。**
4. **openSpectator throw 路径悬挂**（~3.5min）：C 组 moba 观战锚 welcome-timeout 后 socket 未关 → c-mixed 打完 C-DONE 事件环被悬挂、接力链卡死至人工 kill（证据已落盘后 kill，无损）——**GAMES-125 同坑原样复现**（该教训在知识库有档，工具复刻时未落到 catch 分支）。附带 rss2 PID import 冻结缺陷（§D 披露）。**教训：范式复刻要把「教训条目」一并复刻进 catch 分支，不是只复刻主路径。**

产品面全程：零 uncaught、零 reject 异常、零 429（护栏语义外）、feed 十款全窗零校验错。
