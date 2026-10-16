# 弈界棋阁 压测+单链收官报告（GAMES-162 · STRESS·E6-W2-T5）

| 项 | 值 |
|---|---|
| 单据 | GAMES-162（[STRESS·E6-W2-T5] 弈界棋阁 压测+单链收官（9/9 预算版 · E6 13/21 里程碑））attempt 1 |
| 分支 | feature/GAMES-162（基线 main@9191055 merge Already up to date；VIS=GAMES-161 已在基线内） |
| 影子网关 | :4432（影子树=server 拷贝+games/web 符号链接，`diff -rq --exclude=data` 逐字节一致；PORT 显式+GATEWAY_PID 改道，生产 :4400/:4399 零感知——pid 快照前后对照见 §5） |
| 口径 | 6 间 yi-pavilion 测试房 8min ts2 三模式混开（gomoku/reversi/cascade ×2，botLevels=[null+balanced]）+ keeper quick 房观战锚；B 组长局观测交叉引用不重跑+满编 spot；C 组十三游戏同网关 5min；无泄漏四件套 |
| 红线判定 | **通过（PASS）**——三组+四件套全绿（详见各节） |

## 一、A 组 多房并行（≥6 房 · 8 分钟 · 三模式混开）

- **拓扑**：6 间测试房（`POST /api/test/room {gameId:'yi-pavilion', rule:gomoku/reversi/cascade ×2, botLevels:[null,'balanced'], timeScale:2}`，错峰 5s 防世代同步）+ keeper quick 房（真人席 `host on` 主动托管续打促活+观战锚挂载，终局自动重进）。tickMs=10 名义 100Hz → ts2 有效 200tick/s。
- **churn 画像**：wallS=534s；建房 **63**（初代 6+churn 重建 57）、终局世代 57、recreate429=0、pollFail=0；liveAvg=4.81/livePeak=6（世代间隙瞬时 1 房缺口=dispose→重建窗）。**endReasons 谱=三模式自然终局全在场**：five×13（五子连珠）+count×7（黑白棋数子）+meta×8/boards×2（cascade 计数/棋盘）+afk×57（null API 席 3 全超时步路径）——多规则引擎在同一压测窗内四种终局裁决并行。
- **tick 漂移**：drift = tick − 锚tick − Δt×ts/tickMs（tickMs=10 百钟型分母，n=170）：**p50=−2 / p90=+6 / p10=−324 / min=−708 / max=+252**。中位带内；负尾=churn 峰值段（63 建房+217 bothost 补房并发）tick 调度滞后墙钟（单世代 ~45s 内累计 ≤3.5s，≈7% 上界），非泄漏非丢拍——QA1 ts=1 生产房钟率交叉引用偏差 0.01% 为旁证（重载下才现尾）。
- **keeper/观战锚**：keeper 14 轮（终局自动重进+host 续打），末轮手数 moveNo=48；观战席逐拍同步 49，**观战=ruling 全量 canonical 60 条、均 538B（p50 552/max 573）、frameHz=99.775**（frame 计数器 ≈100Hz 房钟）——S5 零快照下行的极低带宽档实证（对比 MOBA 10Hz 快照流）。
- **CPU/RSS 曲线**：RSS 127→167MB（churn 活动窗 +31%，世代累积 GC 滞后；rss2 沉降后 Δ0.22% 恒平=无泄漏）；CPU avg 7.43%/max 30.6%（峰值=错峰建房段）；fd 46→70（活动窗内爬升，沉降后 87→87 恒平）。
- **feed 全量校验**：feedErrTotal=96=2×48 全部 `unknown-game:street-soccer`——**已知误报口径**：本组进程载入的 SEAT_CAP 表沿前作（GAMES-154 lib）缺 street-soccer 条目，street bothost 常驻房 2 间被计 unknown-game；非网关/游戏缺陷。lib162 已修正（本单新沉淀坑②），C 组复跑零误报复证。

## 二、B 组 长局交叉引用 + 满编 spot

### 2.1 已有观测汇总（不重跑，合计 ≥60 分钟）

| 来源 | 观测窗 | 关键观测（交叉引用） |
|---|---|---|
| QA1（GAMES-156，docs/qa/yi-pavilion-qa1.md） | net 7min + web 2min + long 5.5min ≈ **14.5min** | 双 WS 真人席 305s 窗 spots×62、双棋钟递减、钟率交叉引用偏差 0.01%；F1 反应表键序失配双枝+L1 双钟烧穿复盘 |
| FIX1（GAMES-157） | fix1-verify 15/15 复验窗 ≈ **5min** | F1 双成因（featOf 求交落导出面+balanced ΔV≤0 弃权）修复证伪面 |
| BOT（GAMES-158） | bot2-check 30/30（cascade 满贯现况）≈ **10min** | 开局树奖金制/硬接管丢强度二证/行动性悬崖 3↔5/判别器原则等价 |
| FEEL（GAMES-159） | feel-check 19/19 两轮 ≈ **30min**（墙钟约 30min 含修红） | 离线零网关口径/批内自清/ruleOf 短路三坑；FEEL 后零漂移 |
| QA2（GAMES-160，docs/qa/yi-pavilion-qa2.md） | 长局 8min（480s）臂 LA1-LA5 + 冻结面 ≈ **16min** | 钟尽终局 reason=clock（240s×2 双钟上界数学在线验证）；观战帧逐字节恒等×93；放水链双接管协议复证 |
| VIS（GAMES-161） | 48 探针两轮 ≈ **25min** | 无头帧塌带瞬态墨取证三律；视觉统一+识图扩容 |
| **合计** | **≈100min ≥60min ✓** | 不重跑（预算版纪律） |

### 2.2 满编 spot（1v1 双真人+第 3 人观战 · 手数进度）

B_SPOT_SUMMARY：**17/17 全 PASS**（首轮 15/17 两红系探针形状坑——duel 声明块在 `m.room.duel`（协议 §6 声明块合入 room 块）而探针读 `m.duel` 顶层；探针修双读取口后复跑全绿，首轮工件留痕 b-spot.run1.json）。要点：

- quick 真人 A（seat=1，bot 让位 humans=1/bots=1）+ 真人 B 显式 join（seat=0）→ **满编 humans=2/bots=0、joinable=false（humans=cap 语义）**，30s 稳定窗 10/10 保持。
- **welcome duel 声明块**：`{engine:'yi-board-int-v1', rule:'gomoku', hash:1737450531}`——一套 engine hash 护栏三模式；对局席与观战席同形（零隐藏恒等映射 §5.2）。
- **观战手数进度**（本单任务点）：spectator ruling 顶层面 moveNo 16→17 与对局席逐拍同步、rule/clock{0:199770,1:227120} 在流——零快照事件的观战进度面全证；观战下行 6 条 ruling 全携全量 canonical state（spect.state≡A.state 14 键同形）。
- **op 权威校验 reject 回流**：B 越界格 place(-1) → `bad-cell` reject 仅回 B 席（A.rejects=0）——S5 三消息目录的违规席定向回流（Q-017「静默丢弃变可观测拒绝」对照）。
- A 主动托管续打（host on）接受，§5.5 层② balanced 核接管促活。

## 三、C 组 混编（十三游戏同网关 5 分钟 · 全家福）

- **拓扑**：8 间测试房（yi[主角·gomoku]/slg/net/emp/pool/element/iron/moba）+ bothost 常驻（mmo 镇 spect 锚/tactics/speed/street/snake swarm/yi 三规则房）= feed **13 款游戏在场**（E6 全家福，yi-pavilion 第 13 款注册成员）；第 9 间测试房 8 槽护栏 **429 `too-many-test-rooms`** ✓。
- **画像**（30×10s 采样，复跑轮）：**feedGames=13 每采样恒定**（26-28 房）；gamesSeen 终值 13 款全名册（yi 4 房=测试房+keeper+bothost 双规则房、余 11 款各 2、mmo 镇 1）；测试房 36 建/32 终局 dispose 感知重建、recreate429=0、pollFail=0。
- **drift per game**（tickMs 分母分游戏口径）：mini-moba p50=+1/max=1（n=11）、iron p50=0/max=1（n=6）、slg p50=+1/max=1（n=3）——全带内；yi 测试房 driftN=0 系其 afk 世代 ~46s 快于两采样锚窗（yi 漂移面由 A 组 n=170 承载）。
- **yi keeper 观战锚**：rule=cascade 轮，6 条 ruling、frameHz=100.145、均 555B——与 A 组 gomoku/reversi 轮同带宽档（三模式观战画像合计）。
- **mmo 镇锚**（全家福画像旁证）：快照 1744 张（full avg 772B/incr avg 613B）——yi 零快照 ruling（~540B/手）与 S2 快照流同网关并存无相互干扰。
- **RSS/CPU**：RSS 130→178MB 活动窗、沉降 176MB；CPU avg 7.22%/max 14.4%；**feedErrTotal=0**（street-soccer 条目修正后零误报复证——A 组 96 例误报口径闭环）。
- **bothost 房数帽设计态**：yi 帽=按该游戏全房数 ≤6——A/C 组 6-8 间 yi 测试房在场时三规则常驻房终局后让位不补房（ensure 定时器在房数回落后自动归位，rss2 段验收 **yiRooms=3 精确归位**）=设计口径非缺陷。

## 四、无泄漏四件套（RSS 二段+句柄+房间回收+日志零 uncaught）

四件全 PASS（沉降 12s 前置+5×4s 采样）：

1. **RSS 二段**：176432KB → 176432KB，**Δ=0%**（5 采样逐字节同值，无单调爬升）；对照 A 组活动窗峰值 167MB/C 组 178MB——churn 世代累积在收尾清房后完全沉降。
2. **句柄**：fd 105→105 恒平（A 活动窗 46→70 爬升属开放房间对象的自然账，沉降后回落稳定）。
3. **房间回收**：feed rooms 30→29 稳定、**yi=3 精确归位 bothost 三规则常驻水位**、测试房清零（A/C 收尾 DELETE 全量+testDispose=115 幂等清理，网关日志口径）。
4. **日志零 uncaught**：全程 3630 行 uncaught=0、room-error=0。

首轮 rss2 曾红一项（房间回收 Δ=5>4 断言）：C 收尾 DELETE 后首采样踩在 purge 中段（36→31 单调下行）——沉降窗口径问题非泄漏（同轮 RSS/fd 已恒平），前置沉降 12s+±6 自然换气带（他游戏 bothost 终局 3s 补房）重校后复跑全绿；首轮工件留痕 rss-phase2.run1.json。

## 五、生产零感知（:4400/:4399）

- 压测前 pid 快照：`node 38549 / node 44871`（:4400 网关 + :4399 web）；压测后 **同 pid 双值不变**（`diff` 零输出）+ :4400 healthz ok（rooms 31）/​:4399 http 200——影子树 :4432 全程零扰动生产。
- 影子树 data 目录独立（server/data 拷贝后清空）、pid 文件改道 EV/gateway.pid。
- 测试房清理按网关日志口径：test-room-create 全量幂等 DELETE（A/C 收尾+churn 重建即删），chain 结束后 feed 测试房=0。

## 六、结论

- 三组 PASS+无泄漏四件套 PASS：弈界棋阁第 13 款以 **accepted** 收官（game-quality.json multiplayer:yi-pavilion 收编 games 命名空间）。
- 单链 9/9 预算版（GAMES-153/155/156/157/158/159/160/161/162，FIX2 零退回跳过）——**平台第 13 条完整单链 · W2 波第五款收官 · E6 13/21 里程碑**。
- 工件：kernel/workers/GAMES-162/（a-rooms/b-spot/c-mixed/rss-phase2 JSON+log+lib162.mjs+chain.sh+网关日志）。
