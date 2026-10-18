# 派对大乱斗 压测收官报告（GAMES-180 · STRESS · E6-W2-T7 链尾 10/10）

> 影子网关 :4434（server 拷贝隔离+games/web 符号链接，base=main@9c3faec）；常驻 :4400/:4399 全程零感知（pid 集合不变、healthz/200 前后一致）。
> 工件：`kernel/workers/GAMES-180/`（a-bw.mjs/lib180.mjs/a-bw.json/a-bw.log/gateway.stdout 2580 行）。

## 结论速览

| 面 | 判定 | 关键数字 |
|---|---|---|
| A 带宽·设计 §5.5 硬红线 | **PASS** | 增量均值 625B/张（≤850）、全量占比 1.66%（≤8%）、每席峰值 9.9KB/s（≤15KB/s/连接） |
| A 带宽·单据 5KB/s 口径 | **未达（偏紧张口径，O-3 披露）** | 每席下行 p50 5.76 / avg 6.23 / p95 9.00 / max 9.88 KB/s（80 席×240 世代，637s 满房窗） |
| A 缩圈自然下行曲线 | **PASS** | B/张：P0 634 → S1 672 → S2 649 → S3 637 → H3 480 → S4 503（S4 vs S1 **−25%**）；F 相位活局不可达（11 局 live 全部 last-standing 终局 ≤S4，8 局 timeout 均为 churn 短世代房） |
| A 观战 AOI 收窄 | **PASS** | 观战席（AOI 固定 460px）394B/张 ≈3.9KB/s vs 真人席 649B/张（无 ext.me/hash+AOI 收窄双分量） |
| B 并发（≥8 房≥10min） | **PASS** | 4×20 席满房+2 bothost 巨房+13 款别游 bothost≈30 房，持续 **637s**；rooms min 32/p50 34/max 38；满房占比 86% 采样（世代翻转 8s linger 死区所致，见 §2.3） |
| B 网关资源 | **PASS** | CPU p50 13%/max 25.9%；RSS 高水位 243.9MB（teardown 后释放 −119MB→123.9MB=非滞留）；healthz RTT p50 1.41ms/p95 5.67ms（事件环滞后侧证） |
| B quick 建房/销毁循环 | **PASS** | churn 20/20 零失败（9 建 11 进；party 建房对账 9=9）；roomsAfterSettle=31 回落基线 |
| C 泄漏·RSS | **PASS** | fleet 窗四分位 201→237→242→243MB（增量 +35.7→+5.0→+1.0MB 收敛至平）+teardown 后释放 119MB（RSS 高水位非活堆，反证法收口） |
| C 泄漏·房间/定时器 | **PASS** | party 对账 **24 建 = 22 处置 + 2 bothost 常驻**（idle partyFeed 恒 2）；dispose 全 reason=ended；uncaught=0/room-error=0@2580 行 |
| C 泄漏·断连重连句柄 | **FAIL→O-1（产品缺陷，横切）** | **网关 ws.js 急断路径 fd 泄漏**：每条急断连（RST）漏 1 fd——fleet 每世代翻转 +20、churn +20、idle 悬置 266 个 CLOSED 态 fd；A/B 实证：优雅关（close 帧+FIN）Δfd=0 vs 急断（destroy）Δfd=+10/10。生产 :4400 多日仅 3 个（浏览器优雅关为主）——低速率但无上界（移动网络掉线/后台杀进程路径）。**修复方向一行**：`_teardown()` 补 `socket.destroy()`（GAMES-84 横切修复范式承接，不占本链单号） |
| perf 复核 | **PASS** | smoke 13/13：帧成本 avg 0.46ms/p95 0.70ms（红线 ≤6ms；FEEL 基线 0.18/0.30 同带）、>16.7ms 占比 0.00%（<2%）、零 pageerror；无头 rAF 率披露 12.6fps（合成器节拍耦合，games-167 基线同红先例，非页面成本） |
| 冻结验收 | **PASS** | `node scripts/api-check.js party-brawl` 绿（详见 §5） |

## 1. A 组 带宽（20 席满房长跑）

驱动：80 连接 quick 分房（2.5s 内落满 4 间 20 席房，前两间=bothost swarm 巨房被真人顶满）；席位零输入——sim AFK 600tick（30s）→casual 托管自动走位交战（§4.3），事件流量与真人房同构；世代翻转（end→8s linger→closed）后重进。窗 637s，80 席合计 240 世代、488,860 张快照。

- **每席下行**（payload 口径，10Hz 快照）：min 4896 / p25 5419 / **p50 5762** / p75 6771 / p95 9002 / max 9883 / avg 6225 B/s。
- **增量画像**（n=320,000）：min 355 / p50 548 / p95 1013 / max 1200 / **avg 625B**——设计 §5.5 硬线 ≤850B **PASS**；全量占比 1.66%（≤8%）**PASS**；峰值 9.88KB/s（≤15KB/s/连接）**PASS**。
- **相位曲线**（B/张 → 估 KB/s@10Hz）：P0 634(6.34) → S1 672(6.72) → H1 626 → S2 649 → H2 **845**(n=9k，240s+ 幸存密集段战斗/掉箱事件峰) → S3 637 → H3 **480**(4.8) → S4 503(5.03)。**缩圈下行兑现：S4 vs S1 −25%、H3 480 全场最低**。
- **弹体零快照**：320k 张快照零 projs 字段（QA1 S3 已证，本跑 240 世代复证）；shot/nade 全参重演在事件流承载（H2 峰值段增量 p95 1013B 未破 1.2KB 退化阈值，退化重发仅 1.66%）。
- **观战对照**：观战席（AOI 固定 460000mm=460px，O-1 修复值运行态复证）394B/张 ≈3.9KB/s——较真人席 649B/张 −39%（AOI 收窄+无 ext.me/hash 哨兵双分量）。
- **O-3 偏差说明（单据 5KB/s 口径）**：79/80 席 avg>5KB/s。设计 §5.5 预算表按「可见席 4-10」外推常态 5.3-6.4KB/s，但 375×667 小图上 500px AOI 半径覆盖全图大部（两随机点均距 ~300px）→ **中段相位近 20 席全可见**，增量 ~650B/张为密度上界型实测。硬红线（15KB/s/连接、增量 ≤850B、全量 ≤8%）三顶全过；5KB/s 口径仅在 H3/S4（≤5.03KB/s）以下相位达成。带宽第一杠杆=AOI 半径/密度而非快照率（见知识库草稿）。

## 2. B/C 组 并发+泄漏（同一长跑窗）

### 2.1 并发画像
- **房面**：party 4×20 席满房 + party bothost 2 + 13 款别游 bothost ≈30 房持续 637s；rooms min 32 / p50 34 / max 38；feed 21 轮×669 卡 **0 校验错**（15 款 SEAT_CAP/前缀/mode/joinable 全量校验，party-brawl=20 席/'party-'/mini-royale 首入表）。
- **资源**：CPU p50 13%/max 25.9%；healthz RTT p50 1.41ms/p95 5.67ms（n=252，max 47.5ms=首采冷 fetch 离群）；RSS 高水位 243.9MB。
- **满房持续比 86%**（21 采 18 次=4 满房；min 3）：世代翻转死区=ENDED_LINGER 8s+重进竞态，4 房不同步翻转所致（2.3）——非容量缺陷，royale 短世代（11 局 last-standing 2.7-6min）固有。

### 2.2 泄漏三断言
- **①RSS 无单调增长**：四分位 201237→236966→242002→243041KB，增量 +35.7→+5.0→+1.0MB 收敛；**teardown 后 15s 释放 −119MB（243.8→123.9MB）**——活堆不滞留（RSS=页高水位口径，S2 反证法范式）；idle 60s 尾段 123.9→140.0MB=bothost 全家福重建房水位，非爬升。
- **②房销毁归零**：party 对账 24 建=22 处置+2 bothost 常驻（settle 期 partyFeed 恒 2）；dispose 全 reason=ended（8s linger 走满）；idle rooms 31-34 稳定（定时器/补房节律正常）；uncaught=0、room-error=0@2580 行。
- **③断连重连句柄**：驱动侧 82→1 恒清；**网关侧 FAIL=O-1**（见速览表；世代翻转每代 +20 fd 的 1:1 实测+A/B 双臂定性+生产对照三证）。

### 2.3 过程口径
- 世代翻转重进采 **on-closed 路径**：end 后 8s linger 窗内抢跑 quick，旧房 dispose 会把新房 join 刚写的 `ctx.room` linkage 冲掉（dispose 遍历旧 seats 清 ctx）——先于 dispose 重进=自扰。
- churn 20 循环 9 建/11 进：世代翻转回填窗与 churn 交错时 quick 命中 joinable 既有房（协议正解），建房对账 9=9 以网关日志为准。
- room-end 日志行不含 gameId 字段——party 世代对账按 roomId 前缀 `party-` 重算（初版 grep 假 0 的教训）。
- seat-bot 24 例=churn 席断线 10s+1 拍托管（20 例）+fleet 翻转竞态残留（4 例），均在 abandon/终局路径内闭环。

## 3. O 项（观察项，移交后续）

| # | 项 | 定性与证据 | 方向 |
|---|---|---|---|
| O-1 | **网关 ws.js 急断连 fd 泄漏（P1·横切 15 款）** | `_teardown()` 只发 close 事件不 `socket.destroy()`：优雅关（close 帧→`socket.end()`）fd 释放，急断（RST，无 close 帧）fd 悬置 CLOSED 态永不清。实测：每世代翻转 +20（=席位数 1:1）、churn +20、idle 悬置 266；A/B 臂 Δfd 0 vs +10/10；生产 :4400 多日 3 个（浏览器优雅关为主，移动掉线路径无上界） | `_teardown()` 补 `try{this.socket.destroy()}catch{}` 一行修复——建议横切修复单（GAMES-84 范式），修后 15 款回归 |
| O-2 | **AOI 滞回「只扩不缩」锁死 §5.4 半径收窄叙事（P3·文档/设计对账）** | 适配器 `if (rr+15000 > b.aoiR) b.aoiR = rr` 只扩不缩：开局 r=1200px 即锁 500px 地板，此后 240 世代全部相位实测 `ext.aoi.r` 恒 515000——§5.4「圈缩→AOI 缩→决赛圈带宽自然下行」的半径分量死码，实测下行红利全部来自实体消亡（−25%）| 设计侧改注（收窄=实体消亡口径）或实现侧改双向滞回（缩须越 15px 带，mmo 口径本义）——二选一，设计书对账定夺 |
| O-3 | **5KB/s 单据口径 vs §5.5 硬线口径偏差（P3·口径）** | 单据「每席 ≤5KB/s」严于设计硬线（15KB/s/连接）且严于设计常态估值带（5.3-6.4KB/s）；实测 avg 6.23KB/s（密度上界型，§1） | 链尾回填时口径仲裁：5KB/s 是否为「决赛圈/观战档」口径（本跑 H3 480B=4.8KB/s、观战 3.9KB/s 两档均达标） |

## 4. 生产零感知

:4400 healthz ok（rooms 34-35）/​:4399 http 200 全程；生产网关 pid 98857 前后不变；影子网关 :4434（pid 98128）独立数据目录（EV/gw/server/data），压测后 SIGTERM 干净关闭。

## 5. 冻结验收（自跑）

`cd /Volumes/BigDisk/Studio/projects/GAMES/repo && node scripts/api-check.js party-brawl` → **绿**（全 suite 通过，基线不回退；详值见 kernel REPORT §冻结）。

## 6. perf 复核

`node scripts/party-brawl-smoke.mjs` → 13/13：S1 在线局（接管局 alive=16、ack −1→97、rec.n 推进）+S2 HF `__applied` 12 键+S3 弹体零快照+S4 帧成本 avg 0.46ms/p95 0.70ms/掉帧 0.00%——与 FEEL（0.18/0.30）同带，红线（≥55fps 等价帧成本 ≤6ms、掉帧 <2%）不破。
