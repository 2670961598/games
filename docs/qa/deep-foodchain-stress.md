# 深海食物链 压测+单链收官报告（GAMES-170 · STRESS·E6-W2-T6）

| 项 | 值 |
|---|---|
| 单据 | GAMES-170（[STRESS·E6-W2-T6] 深海食物链 压测+单链收官（8/8 预算版 · E6 14/21 里程碑））attempt 0 |
| 分支 | feature/GAMES-170（基线 main@0a8d8a8 merge Already up to date；VIS=GAMES-169 已在基线内） |
| 影子网关 | :4433（影子树=server 拷贝+games/web 符号链接，`diff -rq --exclude=data` 逐字节一致；PORT 显式+GATEWAY_PID 改道，生产 :4400/:4399 零感知——healthz/200 前后对照见 §5） |
| 口径 | 6 间 deep-foodchain 测试房 8min ts2 **满编混档**（24 席 null+comp×3+bal×6+cas×14）+**实体量重载**（cap{fish:24, site:180, drop:240, M:4000}）+ keeper quick 房观战锚；B 组长局观测交叉引用不重跑+满编 spot（观战体型对比条）；C 组十四游戏同网关 5min；无泄漏四件套 |
| 红线判定 | **通过（PASS）**——三组+四件套全绿（详见各节） |

## 一、A 组 多房并行（≥6 房 · 8 分钟 · 满编混档+实体量重载）

- **拓扑**：6 间测试房（`POST /api/test/room {gameId:'deep-foodchain', botLevels:[null+comp×3+bal×6+cas×14], timeScale:2, maxTicks:2400}`，错峰 4s 防世代同步）+ keeper quick 房（真人席 steer 续活+观战锚挂载——常驻渔场恒不终局）+ bothost 常驻巨房 2（swarm 20）。tickMs=100 名义 10Hz → ts2 有效 20tick/s。
- **churn 画像**：wallS=491s；建房 **26**（初代 6+churn 重建 20）、终局世代 20、recreate429=0、pollFail=0；liveAvg=5.58/livePeak=6（世代间隙瞬时缺口=dispose→重建窗）。**endReasons 谱=round-end×21 全部**——测试房 maxTicks=2400 投影终局（§6 测试房专属终局路径：生产常驻渔场 maxTicks=null 恒不投影），全部到点自然终局零异常路径。
- **tick 漂移**：drift = tick − 锚tick − Δt×ts/tickMs（tickMs=100 百钟型分母，n=244）：**p50=0 / p90=+1 / p10=−2 / min=−2 / max=+2**——极窄带（对照 S5 弈界棋阁同式 −708..+252：S6 10Hz 快照房钟调度成本比 S5 200tick/s 事件驱动低两个数量级；24 席×6 房满编重载下零尾）。
- **keeper/观战锚**：keeper 1 轮全程在席（seat=20，鱼体 M 25→97 成长、score 24、档位 t=1——吞噬经济活性侧证）；观战锚 msgs=4845、frameHz≈10（spectF 6403@8min）、**体型对比条 lb 到达 485 次（1Hz 紧凑 [seat,score,M]×5）**、观战固定 AOI 460 显示单位（内部 460000mm）；**crown 加冕事件在流**（round rollover 跨轮 QA2 双轮界在线复证）；round.n=2/tick=2803 长局推进。
- **CPU/RSS 曲线**：RSS 172→257MB（活动窗 +49%，世代累积 GC 滞后——满编混档 24 席×6 房+实体三顶重载；rss2 沉降段验证回落）；CPU avg 25.06%/max 55.4%（峰值=错峰建房段）；**fd 44→44 全程恒平**（13 采样逐值相同——S6 快照连接复用无句柄爬升，对照 S5 yi 46→70 活动窗爬升）。
- **feed 全量校验**：feedErrTotal=0（48 采样×全 feed 卡片：deep 第十四款条目在场+prefix/mode=swarm-arena/humans/bots/joinable=humans<cap 语义全对——lib170 SEAT_CAP 含 street-soccer 修正条目，GAMES-162 坑②不复发）。
- **满编混档体型谱**（观战锚 lb 终值）：榜首 [seat0, score 1197, M 2228]——bot 0 号位（comp 档）M 达 2228（cap M=4000 的 56%），五档谱 {2228, 285, 67, 120, 193}——混档梯度在重载 8min 窗内拉满（QA1 Q6 体型键控四问树的在线重载版）。

## 二、B 组 长局交叉引用 + 满编 spot

### 2.1 已有观测汇总（不重跑，合计 ≥60 分钟）

| 来源 | 观测窗 | 关键观测（交叉引用） |
|---|---|---|
| QA1（GAMES-165，docs/qa/deep-foodchain-qa1.md） | net≈6min（含 5min 长局 spot）+web 2+bot 2.5+full 1 ≈ **11.5min** | 秒配 20 鱼+资源位 180（荧藻120/磷虾40/晶簇20）+实体三顶声明块；一裁三账逐条对账（devour×29 gain/drops 公式全对）；K1.25 临界定档双向+档位滞回（降档带 −5%）；AOI 体型四档 {380,440,500,560}+15px 滞回带双向；重连三档（5s 全测/10s 复席/30s 逾窗接管夺回）；200ms 延迟补偿；长局 5min round rollover+crown×1+A8 残差 30 采样全 0 |
| BOT（GAMES-166） | bot2-check 18 面全绿 ≈ **10min** | 放水三层（降问+失误注入+让位）/avoid 转实职/单 seed 击杀方差统计制/persona 覆写 env 注入；AFK 放水靶收窄 afk.t≥600 |
| FEEL（GAMES-167） | feel-check 19 面全绿 ≈ **12min** | 同 tick 探针批×calm 清场竞态/SEAT 占位符/注入采样首帧 106ms 迟滞；动效/音效位/反馈 juice |
| QA2（GAMES-168，docs/qa/deep-foodchain-qa2.md） | net≈9min（含 8min 长局）+web 1+full 1+mercy2 6 ≈ **17min** | 长局 8min ts2=9849tick 跨 7200 双轮界 crown×2+devour×156+A8 残差 0；deterministic 三房指纹交集（在线范式）；放水台账重生清零/轮末 deaths 重置；O-1 活鱼<20 泊松口径收口 |
| VIS（GAMES-169） | 48 探针 34 面全绿+FEEL 19/19 复验 ≈ **15min** | 视觉统一+识图扩容；freeze 复绘竞态/rotate(π) 尾鳍翻面/AOI 底缘角带 Δ 采样 |
| **合计** | **≈65.5min ≥60min ✓** | 不重跑（预算版纪律） |

### 2.2 满编 spot（swarm 巨房双真人让位+第 3 人观战 · 体型对比条）

B_SPOT_SUMMARY：**18/18 全 PASS**（首轮 13/18 五红系探针形状坑两族——①aoiR 断言按显示单位 460 而下行是内部 mm 单位 460000（×1000）；②quick 配到 bothost swarm 巨房（bot 目标 20 非满 24），席位账断言按「24 席全占」设计错位+ack 语义=席位级 lastSeq 游标（让位顶替旧席残留 seq 被新连接 frame 重置=正常）；断言面按巨房让位语义重校后复跑全绿，首轮工件留痕 b-spot.run1.json）。要点：

- quick 真人 A（seat=19，bot 让位 20→19）+ 真人 B 显式 join（seat=20，再让位 19→18）→ **humans=2/bots=18、joinable=true（humans<24 巨房语义，与 feed 校验同式）**，30s 稳定窗 10/10 保持。
- **welcome room.fish 声明块**：`{engine:'deep-foodchain-sim', v:1, K:1.25, aoiR:[380,560], cap:{fish:24, site:180, drop:240, M:4000}}`——engine+临界比+AOI 档界+实体三顶四合一护栏；观战席同形（零隐藏恒等映射）。
- **观战体型对比条**（本单任务点）：ext.lb=[seat,score,M]×5 ·1Hz 到达 3+ 次/30s 窗、score 榜单调非增；**观战固定 AOI=460 显示单位**（=内部 460000mm；对局席按体型 {380..560} 显示单位分档——Q4 口径在线复证）。
- **input ack 回执**：A/B steer 后 ext.ack=各自最后发送帧号（确定性回执——席位级 lastSeq 游标）；30s 窗内 A.ack 持续=frameSeq（每 3s steer 逐帧对齐）。
- **快照节拍**：A/S 同 frame 基准（6982→7282 差 0 tick——同房 tick 时基恒等）；**生态事件流 eats=223/devours=11 到达对局席**（S6 events 通道）；观战 AOI 快照含 fish 实体（entsFish=5）。

## 三、C 组 混编（十四游戏同网关 5 分钟 · 全家福）

- **拓扑**：8 间测试房（yi[gomoku]/slg/net/emp/pool/element/iron/moba）+ bothost 常驻（mmo 镇 spect 锚/tactics/speed/street/snake/yi 三规则房/deep 巨房 2）+ deep 主角 keeper quick 房（观战锚）= feed **14 款游戏在场**（E6 全家福，deep-foodchain 第 14 款注册成员——deep- 前缀字典序排首，§5.8 feed 有意设计）；第 9 间测试房 8 槽护栏 **429 `too-many-test-rooms`** ✓。
- **画像**（30×10s 采样）：**feedGames=14/14 每采样恒定**（30/30）；gamesSeen 终值 14 款全名册（deep 2=bothost 巨房×2、yi 3、mmo 镇 1、余 11 款各 2）；测试房 28 建/20 终局 dispose 感知重建、recreate429=0、pollFail=0。
- **drift per game**（tickMs 分母分游戏口径）：net p50=0/max=1（n=11）、moba p50=0/max=0（n=10）、emp p50=0（n=7）、pool p50=+2/max=3（n=6）、iron p50=0（n=5）、element p50=−3/max=−1（n=3）、slg p50=+1（n=1）——全带内。
- **deep keeper 观战锚**（全家福画像主角面）：msgs=3001、frameHz=10.000（S6 名义节拍恒等）、**体型对比条 300 次（1Hz）**、round.n=3（第三轮推进）；**lb 榜首 [seat0, score 2200, M 4000]——满编混档窗内 comp 档把体型拉满到 cap M=4000 上界封顶**（A 组 8min 到 2228，C 组窗内 4000 封顶——混档梯度+守恒账本上界的在线重载实证）；观战 AOI 固定 460 显示单位恒等。
- **mmo 镇锚**（全家福画像旁证）：S2 快照流与 S6 二式快照同网关并存无相互干扰。
- **RSS/CPU**：RSS 256→258MB 稳定带（A 组活动窗峰值之上零额外爬升）、沉降后恒平（见 §四）；CPU avg 11.41%/max 14.7%；**feedErrTotal=0**（deep 第十四款条目+13 款既有条目全对——lib170 SEAT_CAP 全 14 款含 street-soccer 修正，GAMES-162 坑②不复发）。

## 四、无泄漏四件套（RSS 二段+句柄+房间回收+日志零 uncaught）

四件全 PASS（沉降 12s 前置+5×4s 采样）：

1. **RSS 二段**：257440KB → 257440KB，**Δ=0%**（5 采样逐字节同值，无单调爬升）；对照 A 组活动窗 172→257MB（+49% 满编重载世代累积）——churn 世代累积在收尾清房后完全沉降至恒平。
2. **句柄**：fd 49→49 恒平（A 组活动窗 44→44 全程恒平——S6 快照连接复用零句柄爬升，对照 S5 yi 46→70）。
3. **房间回收**：feed rooms 29→30 稳定、**deep=2 精确归位 bothost 巨房常驻水位**、测试房清零（A/C 收尾 DELETE 全量+testDispose=32 幂等清理，网关日志口径）。
4. **日志零 uncaught**：全程 2248 行 uncaught=0、room-error=0。

## 五、生产零感知（:4400/:4399）

- 压测前：:4400 healthz ok（rooms 34）/​:4399 http 200；压测后：:4400 healthz ok（rooms 30）/​:4399 http 200 + **生产网关 pid 集合前后不变**（`diff` 零输出 PROD-PID-SET-UNCHANGED）——影子树 :4433 全程零扰动生产（压测后影子网关干净关闭，4433 探测 down）。
- 影子树 data 目录独立（server/data 拷贝后清空）、pid 文件改道 EV/gateway.pid。
- 测试房清理按网关日志口径：test-room-create 全量幂等 DELETE（A/C 收尾+churn 重建即删），链结束后 feed 测试房=0。

## 六、结论

- 三组 PASS+无泄漏四件套 PASS：深海食物链第 14 款以 **accepted** 收官（game-quality.json multiplayer:deep-foodchain 更新 accepted+单链 8 单计数）。
- 单链 8/8 预算版（GAMES-163/164/165/166/167/168/169/170，FIX1/FIX2 零退回跳过未占单号）——**平台第 14 条完整单链 · W2 波第六款收官 · E6 14/21 里程碑**。
- 工件：kernel/workers/GAMES-170/（a-rooms/b-spot[+run1]/c-mixed/rss-phase2 JSON+log+lib170.mjs+chain.sh+网关日志）。
