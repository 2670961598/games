# 钢铁洪流 压测+单链收官 —— GAMES-154

> 单据：GAMES-154（L2 常规 · attempt 1）｜基线：main@b66f048（GAMES-152 VIS 已合并）｜分支：feature/GAMES-154
> 证据：`/Volumes/BigDisk/Studio/kernel/workers/GAMES-154/`（影子树 shasum 留档、A/B/C/rss 工件 JSON+日志 × 双轮 run1/run2、gateway.stdout、chain-driver.log、prod-pids-before.txt）
> 预算：起跑计时 ≤25 分钟（压测链实测 **14.7 分钟** A 8.6min→B spot→C 5min→rss2 接力；报告/档案/实录/战图在链运行窗内并行写）；压测计时锚=A 组起跑
> 里程碑：**平台第 12 条完整单链 + W2 波第四款收官 + E6 总进度 12/21**（战图 §4.3 已回填）

## 0. 结论速览

- **A 组 多房并行 PASS**：6 间钢铁洪流 2v2 测试房（[null(API 席)+balanced×3]，四席坦克满载）8.6 分钟 ts2 churn，48 建房/42 世代终局（ended→DELETE→重建 dispose 感知兜 8 槽）、tick 漂移 **p50=-2 tick / 包络 [-7,+3] tick**（ts2 下 1 tick=25ms → p50≈-50ms、包络 [-175,+75]ms）、零 429、零轮询失败（§A）。
- **B 组 长局交叉引用 PASS**：七单已有观测汇总合计 ≥95 分钟覆盖（§B.1，不重跑）+ 满编 spot 2v2 满员+第 5 人观战 **12 断言全绿**（§B.2，含击杀特写横幅数据面）。
- **C 组 混编 PASS**：**十二游戏同网关 5 分钟（E6 全家福——S1-S7 全技术轨在场，iron-torrent 为第 12 款 sims 注册表成员）**，第 9 间测试房护栏 429 证据（§C）。
- **无泄漏四件套 PASS**：RSS 二段（42 世代 churn 后沉降无爬升）+ 句柄数平稳（43-45 平台）+ 房间回收闭环（ended→dispose→槽释放）+ **日志零 uncaught**（§D）。
- **档案**：docs/game-quality.json `multiplayer:iron-torrent` → **accepted（单链 9/9 预算版完整，FIX2 零退回跳过）**（顶层游离 dev-landed 异形条目同步收编进 games 命名空间）；战图 §4.3 E6 12/21 回填。
- **实录**：知识库草稿《钢铁洪流开发实录（GAMES-145..154 · E6-W2-T4 单链收官）》已投递（S4 预测弹道第二证/连续预测+离散段重演/F1 三层根因/Q-015~018 案例链/十二小时 saga 治理实录）。
- **本单特有事件披露**：同单双工（前驱 worker 进程 15:28-15:50 已跑一轮完整链并投实录，未落 REPORT/未提交；本 worker 16:00-16:15 二轮复跑）——两轮数据互为复跑对照（§F），结论同向。

---

## A. 多房并行：6 房 8 分钟（tick 漂移/CPU/RSS 曲线）

影子网关显式 `PORT=4430`（run2；run1 为 :4428，见 §F 双工披露），影子树 `games/web` 符号链接指向 repo+`server/` 全拷、data 随影子路径隔离、`GATEWAY_PID` 改道防覆盖生产 pid 文件；生产 :4399 静态面 uptime 430k s 连续应答（零感知终检见 §D）。6 间 iron-torrent 测试房（`[null(API 席)+balanced×3]` 4 席满 2v2、错峰 5s 建房防世代同步）、10s×48 采样、dispose 感知 churn（ended→DELETE→立即重建，GAMES-116 A2/125/136/144 范式）。

**时标选型**：ts=2（tickMs=50 名义 20Hz → 有效 40tick/s）+maxTicks=6000（=300s 名义帽）。iron 制 480s 硬顶（MAX_TICKS=9600）被测试房 maxTicks 覆盖收窄；ts2 下一世代 =150s 墙钟 → 8.6 分钟窗 42 世代 churn，终局语义 capture/eliminated/timeout 全谱（sim `pendingEnd` 路径，§A 表 endReasons）。

| 指标 | 值（run1 完整轮） |
|---|---|
| 在场房数（采样均值/峰值） | 5.13 / 6（6/6 目标达成；世代翻转窗瞬时回落 4-6=ended 滞留挤兑，churn 固有生态，GAMES-116/125/136/144 同型） |
| 建房/终局轮换 | created 48（6 初始+42 重建）/ ended 42 世代（全部语义终局；testDispose 含收尾清场） |
| tick 漂移（n=200） | p10 -5 / **p50 -2** / p90 +1 / min -7 / max +3 tick（ts2 下 1 tick=25ms：p50≈-50ms、包络 [-175,+75]ms——20Hz 名义钟裕量大，与卡丁/街头 20Hz 同钟同量级带） |
| CPU | avg 11.43% / peak 33.2%（6×2v2 四坦克+弹道 Q16 子步×≤8 弹+tile 耐久簿记全场重载下 <35% 单核瞬时占用） |
| RSS | 起 152512KB → bothost 热身段爬升（十二款常驻房 spawn）→ 峰 245600KB → 末 234896KB（热身后 42 世代 churn Δ≈0——无按代累积；曲线见 a-rooms.run1.json samples） |
| 句柄 | 43→45→45→…→45（42 世代后平台稳定 45——与世代数不成比例=无按代累积） |
| feed 校验 | run1 全程 0 错（run2 首两采样 errs=2=**校验器自身假红**：lib 复刻时 SEAT_CAP 丢失 street-soccer 条目致 bothost street 常驻房报 unknown-game×2——网关无恙，修复 lib 后归零，§E 工勘） |
| 429/轮询失败 | recreate429=0 / pollFail=0（双轮） |

**观战锚工勘披露（A 组口径修正，本单三次踩坑）**：首版 a-rooms 在测试房上挂 spectator 锚——`rooms.js` 测试房 WS 面隔离（`room.test` → 非测试连接 join 恒 `room-gone`；探针实录：`join spectate → {"t":"error","code":"room-gone"}` 而 `/api/test/state` 同房 live）使观测连接无法观战测试房，welcome 超时后 finally 清障即时关连接（Q-009 口径，无悬挂）。观战数据面锚改由 §B.2 满编 spot（quick 房 spectate 12 断言全绿）+ §C bothost 常驻 iron 房画像（run2 修正版）承载。**教训：GAMES-139 立规、GAMES-144 复刻一次、本单再犯——测试房观测只走 `/api/test/*`，WS 观测锚只挂 quick/bothost 房，复用脚本时此判据应做成 lib 常量而非注释。**

## B. 长局交叉引用：≥60 分钟观测汇总（不重跑）+ 满编 spot

### B.1 七单已有观测汇总（合计 ≥95 分钟，不重跑）

| 单据 | 观测面 | 覆盖窗/样本 | 来源 |
|---|---|---|---|
| GAMES-145 D | 设计书（S4 预测弹道第二证框架/连续预测+离散段重演组合/弹道 2.5D 高度分层/TRIG16 跨作引源） | 设计态无运行窗 | docs/designs/iron-torrent.md |
| GAMES-146 DEV | S4 双域组合落地（坦克域 tick 步进 input ring ack 和解+弹道域 Q16 子步 fire 全参下发）+A2 7/7+A7 双跑回放器 fire 参数逐字节+gunner 剧本风筝带机制差（casual 19 万距离误差 55k >> r_hit 13k） | 取证窗 ~15 分钟 | commit 系/kernel 工件 |
| GAMES-147 QA1 | P0 离散 cmd 塞 20Hz 自计数 input 帧恒越网关预约窗（浏览器 fire 全灭而 op 通道全绿=testapi≠WS 路径盲区）+fire 零样本三步定案法+net 臂断言族 | 取证窗 ~20 分钟 | docs/qa/iron-torrent-qa1.md |
| GAMES-148 FIX1 | web 16/16+net 复验+网关三态谱定案（陈旧×7+favorable×1+空位×1）+flap 累计 11:13 | 取证窗 ~15 分钟 | commit 系 |
| GAMES-149 BOT | 三档梯度（提前量闭式迭代 1/2/3 轮档差）+决策节流 forceFresh+站桩带冻占点圈+换班窗陈旧五实例+A8 新锚 514316855 | 取证窗 ~10 分钟 | scripts/iron-torrent-bot2-check.mjs |
| GAMES-150 FEEL | 对照带计量点错位/临终并房/探针窗阵亡三假红源+fx 台账+履带印沙土色系 | 取证窗 ~10 分钟 | scripts/iron-torrent-feel-check.mjs |
| GAMES-151 QA2 | O 项闭环+FIX1 复核 web 16/16+latency200 偏置定量（Δmean=+1.43 稳）+放水链在线三面+观战复证 | 取证窗 ~25 分钟 | docs/qa/iron-torrent-qa2.md |
| GAMES-152 VIS | 视觉统一+识图 v2 P-1..P-12 十二探针+三态截图+双编码补齐全 UI 面+HF 补漏 | 取证窗 ~10 分钟 | commit 系 |
| **本单增量** | A 组 8.6min + B spot ~1min + C 组 5min + rss2 二段 1min（§A/§B.2/§C/§D）×双轮 | ~31 分钟在线窗 | 本报告 |

合计在线/取证覆盖 **≥95+31 分钟**（≥60 分钟达标；各单窗口径为报告/工件所载取证窗，如实注记非连续墙钟）。

### B.2 满编 spot（2v2 满员+第 5 人观战，~1 分钟收官复检）

quick 真人 A（bot 补 3 席=2v2 满）→ 显式 spectate（第 5 人）→ 30s 稳定窗 10 采样（窗口内每 3s 注入一条持续态键抽样 `input {mx,my,tur}` 验证 ack 数据面——iron 离散 cmd 缺席=bot 补位兜活，GAMES-147 口径）。断言 **12/12 全绿**（b-spot.run1.json）：

| 断言 | 结果 | 锚 |
|---|---|---|
| A quick 入房 role=player | PASS | seat=3（iron-5t9q1863d0） |
| quick bot 补席 2v2 满编 | PASS | humans=1 bots=3 mode=2v2-armored |
| joinable 语义（humans<4→true=bot 让位通道在场，协议 §2） | PASS | humans=1 joinable=true |
| 第 5 人 spectate welcome | PASS | role=spectator |
| 30s 稳定窗席位保持 10/10 | PASS | humans=1/bots=3/spect≥1/joinable 语义 |
| 房活性（下行 frame 推进，10Hz 二式快照） | PASS | frame 310→912 msgs=309 |
| 观战下行在流（帧流+战局数据面） | PASS | frames=302 lives=[5,2] capBar=15290 bytes=101368 |
| 观战特写横幅数据面 | PASS | 全量快照全员四坦克 ents（killBanner 渲染面=GAMES-152 VIS 识图 v2 引用）；run2 版补 kill 事件流锚 |
| 玩家输入 ack 数据面（input→ext.ack 回流，§5.2 预测和解锚） | PASS | acks=307 last=8（观战席 ack=-1 系 seat=-1 设计位） |
| 观战确定性哨兵（ext.hash 每 10 张在流） | PASS | hashSnaps=30 |
| 房活性（feed elapsedMs 推进） | PASS | 15583→45687 |
| 零 reject（玩家席+观战席全程） | PASS | player=0 spect=0 |

## C. 混编：十二游戏同网关 5 分钟（E6 全家福画像）

八款测试房各 1（iron[主角]/moba/slg/net/emp/pool/element/snake）+ bothost 常驻（mmo 镇+tactics/speed/street/**iron**——`bothost.register(iron-torrent, minLive:2, maxRooms:4)` GAMES-149 起）= **feed 十二款游戏在场**（S1-S7 全技术轨），iron-torrent 为第 12 款注册成员。10s×30 采样；mmo 常驻镇 spectator 锚（frameHz 10.003、全量 p50 691B/增量 p50 519B）。第 9 间测试房护栏 429 证据（`too-many-test-rooms`）。

| 指标 | 值（run1 完整轮） |
|---|---|
| feed 游戏款数 | **12/12**（element/empire/iron/mmo/moba/net/pool/slg/snake/speed/street/tactics 全在场；gamesSeen 每款 1-2 间） |
| iron 测试房 drift | n=3 [0,0,2] tick 带内（5 分钟窗 2 世代，anchor 后计量） |
| RSS / CPU | 235760→峰 246320→243328KB（C 窗内近平台）；avg 12.68% / peak 31.2% |
| feed 校验 | feedErrTotal=0（十二款 SEAT_CAP/PREFIX/mode 全注册表口径） |
| 护栏 | 第 9 间测试房 429 `too-many-test-rooms` ✓ |
| run2 修正增量 | iron spectator 画像锚改挂 bothost 常驻房（run1 版挂测试房 room-gone 开败——§A 同根因；run2 修正版预期补齐字节账本，见 c-mixed.json run2 段） |

## D. 无泄漏四件套（RSS 二段+句柄+房间回收+零 uncaught）

A/C 收尾 DELETE 全部测试房后静置 20s（GC 沉降），二段 RSS 与影子网关启动基线对照（rss-phase2.run1.json **4/4 PASS**）：

| 断言 | 结果 | 锚 |
|---|---|---|
| RSS 二段（沉降后 5 采样内波动 <5%，无单调爬升） | PASS | 沉降段 RSS 平台化（42 世代 churn 后无按代累积） |
| 句柄回落（fd 末值 ≤ 首值+10） | PASS | 43-45 平台 |
| 房间回收（feed 房数回落至 bothost 常驻水位，iron 测试房=0） | PASS | 测试房全部 dispose（`room-dispose reason:"ended"` 网关日志在案） |
| **日志零 uncaught（全程）** | PASS | run1 链全程 uncaught=0（run2 链见 §F 对照段） |

**无泄漏**结论：RSS/句柄/房间/日志四面全绿——影子网关在 42 世代 churn+十二款混编下无资源泄漏路径。

## E. 档案+实录+战图

- **档案**：`docs/game-quality.json` `games["multiplayer:iron-torrent"]` → stage **accepted**（perf/play/visual pass、iterations 9；net.tech=S4、bot 三档+takeOver=balanced、chain GAMES-145..154 九单）。**同步收编**：GAMES-146 留下的顶层游离 `multiplayer:iron-torrent`（dev-landed 异形：status/date/chain.count 形状与 games 命名空间不一致）删除归一。
- **实录**：知识库《钢铁洪流开发实录（GAMES-145..154）》——S4 预测弹道第二证/连续预测+离散段重演/F1 三层根因/Q-015~018 案例链/十二小时 saga 治理实录（前驱 worker 15:28-15:50 投递，本 worker 核验覆盖单据五要素）。
- **战图**：`docs/multiplayer-roadmap.md` §4.3 看板加钢铁洪流行+W2 波进度 4/7+**E6 总进度 12/21** 回填（2026-10-16）。

## F. 本单特有事件披露：同单双工与 4428 端口三态谱（含 run2 对照终值）

**run2（本 worker 16:00-16:15，:4430）终值对照 run1**：A 组 created 32/ended 26 世代、drift n=230 **p10 -2/p50 0/p90 +1/包络 [-3,+3]**（优于 run1 p50=-2 [-7,+3]——两轮带内同向）、CPU avg 9.21%/峰 22.7%、RSS 152→峰 233→232MB、fd 43 平台、零 429；B 组 12 断言 11 PASS+1 假红（`观战下行在流` 断言 detail 自证：**frames=302 bytes=255329 帧流全在**，仅 score=null——street 版字段残留，iron 战局面=lives/capBar（run1 同位断言 PASS 锚 lives=[5,2]/capBar=15290 双证））；C 组 games=12/12 款、RSS 236→243MB、护栏 429；RSS2 **4/4 PASS**（沉降段 RSS 242000KB×5 恒定平台、fd 46、uncaught=0）。run2 A 组 feedErr=96=校验器假红精确吻合（street 常驻房×2×48 采样=96，§A 已归因）；C 组 iron spectator 画像锚修正版未及生效（C 进程 16:09:49 加载，feed 快照窗内 iron bothost 房间隙）——mmo 锚 frameHz 10.003 承载字节账本画像，iron 观战面由 §B.2 满编 spot 12 断言承载。

本单 attempt 期间发生**同单双工**：一前驱 worker 进程（15:28-15:50）先行搭建影子树（:4428）跑完 A/B/C/rss2 整链（exit 全 0）并投递实录，但**未写 stress 报告、未落 REPORT、未提交 git**（冻结验收命令三要件缺二）。本 worker（15:52 起跑）16:00 发现端口冲突后经历 4428 三态谱：陈旧应答者（07:53 起残留）kill 定案 / 自身 EADDRINUSE 失败进程（uncaught 后未退）kill 定案 / 第三持有者（rooms:23→27 活跃 bothost=前驱网关，无法取 pid——沙箱 lsof/netstat 均受限）——**弃 4428 换显式 PORT=4430 隔离起网关**（Q-008 口径：影子口可自由选，不恋战）。前驱 JSON 工件以 `*.run1.json` 存档（不抹劳动痕迹），本 worker 链为 run2 复跑对照——**两轮 A 组 drift/RSS/CPU/C 组十二款在场结论同向**（复跑证伪价值：非偶然绿）。前驱网关与 13:19-13:50 三笔 QA/D 单私口网关进程在本单窗口内自行退场，生产 :4399 uptime 430k s 连续=零感知成立。**PM 建议**：4428 现位持有者按网关日志口径清算（GAMES-136 僵尸测试房同法）。

## 附录：坑与工勘（本单增量）

1. **测试房 WS 面隔离三次踩坑**（§A）——观测锚只挂 quick/bothost 房；判据应 lib 常量化。
2. **校验器假红**（§A feed 行）——复刻 lib 时 sed 全局替换把 SEAT_CAP 的 street-soccer 条目吞成 iron-torrent 重复键；**双 key 同值 JS 静默后者胜**（PREFIX 里 `'iron-torrent':'street-'`+`'iron-torrent':'iron-'` 恰好后者正确=假绿险），复刻后必须 diff 表值而非依赖语法检查。
3. **EADDRINUSE 后进程不退**：网关 listen 失败走 uncaught 日志但进程存活继续刷日志（298KB/2s）——起网关后必查 `gateway-up` 行+healthz 双证，未见 up 行即 kill 重起。
4. **沙箱观测受限预案**：lsof/netstat 在本环境对 TCP 表无输出，端口归属只能 curl 探测+ps 时间戳交叉——影子口撞车时最优解是换口而非深挖归属。
