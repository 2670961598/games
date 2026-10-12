# 极速卡丁 QA二号（延迟/重连/满员·预算版）—— GAMES-114

> 单据：GAMES-114（L2 常规 · attempt 0）｜基线：main@084073c（GAMES-113 FEEL 已合）｜分支：feature/GAMES-114
> 证据：`kernel/workers/GAMES-114/`（gate 日志、qa2-harness、recon-5s-fixup、abandon-fixup、q3q4-fixup、yield-exit-probe 日志与 JSON）+ `evidence/g114-qa2/`（探针脚本，仓内不跟踪）
> 预算：起跑计时 ≤30 分钟（实际取证窗 ~25 分钟，超 25 分钟转收尾执行）

## 0. 结论速览

- **五项全绿，退回 0**。FIX1（GAMES-111）三项修复在本轮全部运行时复验通过：§5.3 和解预算表**首次可测且全行落带**（QA1 时 F1/F2 死码不可测）、200ms 态 hashWarn=false（QA1 闩锁态消除）、F9 quick 局 resume 经 URL 回写可达。
- 延迟三点扫描（100/200/300ms）：和解曲线平坦——事件率 1.13/1.11/1.35 次/s、中位 1.35/1.55/1.36px、硬回滚率 ≤0.051/s；300ms（超红线口径外）无失控、hashBad=0。
- A8 双臂圈速中位差实测 **3.78%**（≤25% 判据余量 21.22pp；arm0 48900ms / armB 47050ms，双臂完赛+carried>0）。
- 重连三档全绿 + GAMES-84 abandon 锚复验通过（真断线：+4s 未即弃 → +25s abandon 离场）。
- 满员 6 车/旁观/让位循环全绿：真人进全 bot 房 bot 让位（×2），出场逾 10s 窗托管转 bot 回补（h0/b6）——循环闭环。
- 长局 350s+1 tick 超时定格正常（ended/timeout/winner=B）；feed 两点抽样新鲜（房churn+elapsed 推进）。
- 观察项 5 条（见 §6），无 FIX2 级事项。

## 1. 冻结 gate 与环境

| 项 | 结果 |
|---|---|
| 冻结 gate `node scripts/api-check.js speed-kart` | **exit=0，32 通过 0 失败**（A1-A8/A+ 全绿；A+ stateHash=332083881 双房相等+输入日志 7180 条逐字节相等+在线==回放；A8 见 §2） |
| 网关 :4400 新鲜度 | pid 71903 起于 10-12 06:08:49（晚于服务端末次变更 52bfd7b@06:08:45 四秒）；行为面旁证=A+「在线==回放器」跨进程比对通过（网关内存 sim 与本树 shared.cjs 同式） |
| 私口 | 静态 :4394-:4398 分脚本私口（:4399/:4400 零感知，静态页新起进程加载当前树） |

## 2. 交付项 1：200ms 延迟对照（圈速差余量 + 三点扫描）

- **A8（api 臂，gate 内含）**：双臂完赛（finish 且 laps=3/3）；圈速中位差 **3.78%**（arm0 中位 48900ms / armB 47050ms；QA1 测 5.30%，同向 armB 反快——O-2 延续，timeScale=2+虚拟会话口径注记不变）；carried arm0=1648 / armB=1598 双 >0。
- **浏览器臂三点扫描**（TCP 代理双向各垫 RTT/2，驾驶 40s/点，netProbe 常驻探针）：

| RTT | ping 徽标 | 事件率 | 中位 | p95 | 硬回滚率(>6px) | hashBad/hashWarn | pageerror |
|---|---|---|---|---|---|---|---|
| 100ms | 103ms ✓ | 1.13/s (n=44) | 1.35px | 4.11px | 0.000/s | 0/false | 0 |
| 200ms | 205ms ✓ | 1.11/s (n=44) | 1.55px | 4.89px | 0.051/s | 0/false | 0 |
| 300ms | 304ms ✓ | 1.35/s (n=55) | 1.36px | 4.67px | 0.000/s | 0/false | 0 |

- **§5.3 预算表（200ms 常态行）全行落带**：事件率 ≤1.2 ✓（1.11）/ 中位 ≤4px ✓（1.55）/ p95 ≤24px ✓（4.89）/ 硬回滚率 ≤0.2/s ✓（0.051）/ hash 分歧=0 ✓（hashBad=0 且 hashWarn=false——QA1 的闩锁假降级横幅已消除）。**FIX1 后首次可实测**（QA1 F1 和解 Δ≡0 死码、F2 hash 错拍两结构性死码已修）。
- 画像结论：三点曲线平坦，300ms（红线 200ms 之外的加压点）和解指标无发散——预测-确认回路对 RTT 不敏感，与 §5.6「操作→车态链路与 RTT 解耦」设计意图一致。
- 如实注记：40s 驾驶窗未完成整圈（单圈 52-75s）→ 浏览器臂 lapLocal/lapSrv 空，圈速差主证=api 臂 A8（同 seed 同策略可对照；quick 房异 seed 不可对照的 QA1 口径延续）。

## 3. 交付项 2：断线重连三档（预测续跑语义）+ abandon 锚

**重连三档**（5s 全测走 F9 回写路径——reload 不拼参；10s/30s 走 ?room= 显式路径）：

| 档 | URL ?room= 回写 | 复席保号 | tick 单调 | hash 对齐 | recon 健康 | pageerror |
|---|---|---|---|---|---|---|
| 5s | ✓（welcome 后 replaceState） | ✓ seat 5→5 | ✓ 897→1106 | ✓ hashBad=0/hashWarn=false | ✓ recon10s=51（<60） | 0 |
| 10s | —（显式） | ✓ seat 5→5 | ✓ 216→541 | ✓ | — | 0 |
| 30s | —（显式） | ✓ seat 5→5（逾窗让位复归） | ✓ 444→1176 | ✓ | — | 0 |

- 预测续跑语义：重连后全量重锚+pending 重放+新输入消费正常（hashWarn 未闩、圈账一致、输入回路续发）。
- **GAMES-84 abandon 锚复验 ✓**：在场 20s（>15s）独真人 quick 房**真断线**（ctx.close WS close 帧）→ **+4s 房仍在 feed（humans=1）**——lastHumanAt 在场刷新，未复现「首个扫描拍即 abandon 短路 10s 窗」；**+25s 房离场**（ABANDON_MS=15s 无连接 → abandon 终局）。
- 工具口径发现：Playwright `setOffline` 是黑洞不是 FIN——服务端全程不见断线（feed humans 恒 1，abandon 永不触发）。首轮 Q2b 伪红由此而来；重连三档的 setOffline 臂测的是「网络分区恢复」而非「断线重连」，托管/abandon 语义必须用真 close 驱动（已换法，见 evidence）。

## 4. 交付项 3：满员与旁观 + 真人进房 Bot 让位循环

- **满员**：quick 房 6 车（1 真人+5 bot 补满）✓（feed humans=1/bots=5）。
- **旁观**（?room=&mode=spectate 显式）：seat=-1 / mode=spectate ✓；feed spectators=1 ✓；8s 稳定、零 pageerror ✓。注记：`state().tick`（=S.simTick 预测钟）对旁观席不推进——旁观无预测器，口径不适用；快照流健康由 feed spectators 计数+连接存活+零错侧证（见 §6 O-2）。
- **让位循环 ×2 闭环**：全 bot 房（h0/b6 joinable）→ 真人 play 加入 → **bot 让位**（seat=5 入座，feed h1/b5）✓✓ → 真人离场 → +8s 仍 h1/b5（**10s 重连窗内席位保留，语义正确**）→ **+14s h0/b6**（逾 10s+1拍 窗托管转 bot，席回补）✓。
- 意外佐证：主 harness 旁观探针误以 play 模式加入满员房——bot 让位立即生效（第 7 加入者顶掉 bot 席成车手而非旁观），与协议 §2「play 优先空位→bot 让位→满员才旁观」一致。

## 5. 交付项 4：长局 spot + feed 新鲜度

- **长局**：testapi 房 ts=1、maxTicks=7000、12 圈不完结臂（5 casual bot 持续竞速）→ 350s 后**超时定格正常**：phase=ended / tick=7001 / reason=timeout / winner=B（按 (laps,s) 定格裁定）。运行期网关无异常（同窗完成全部其余取证）。
- **feed 新鲜度两点抽样**（间隔 ~7 分钟）：#1 n=15、speed 房 2 间（h0/b6，e21-24s）→ #2 n=16、speed 房 3 间（h1/b5 e30s + h0/b6 e15s + h0/b6 e1s）——条目 churn + elapsed 推进 + 新房补入，BotHost 常驻房轮换健康。
- 交叉引用未重跑：QA1 O-1（全程零 pageerror/驾驶连续/flight 自校准）、FIX1 200ms 臂（hashBad=0/hashWarn=false）、BOT 单（三档梯度 61.40/52.35/47.48s 零重叠）。

## 6. 观察项（不动码，无退回）

- **O-1 seq 每连接重置**：重连后输入序号从 0 重启（pre 84→post 56），跨连接不比大小。非红线：hash 对齐（hashBad=0）+ 新输入被服务器消费（否则预测必分歧）已证消费语义有效；协议 §5.1 ack 锚点为连接内口径。本轮新观察（QA1 未测此项）。
- **O-2 旁观席观测面**：`state().tick` 为预测钟，旁观不推进（口径不适用）；快照流健康度本轮仅侧证（spectators 计数+连接存活+零 pageerror）。如需直证可下轮加 S.frame 探针。
- **O-3 重连后短窗和解密度抬升**：复席后 10s 窗 recon10s=51（基线 ~1.1/s ≈ 11/10s）——全量重锚+pending 重放的 settle 段，窗内自愈、无失控（<60 判据内）。
- **O-4 setOffline 工具口径**（§3 已述）：网络分区≠断线；后续 QA 的托管/abandon/逾窗用例须真 close 驱动。
- **O-5 A8 armB 反快**（QA1 O-2 延续）：3.78% vs 5.30%，同向；timeScale=2+虚拟会话节拍口径注记不变，≤1.5%/≤2% 精确公平性浏览器双臂同 seed 对照仍不可达（quick 异 seed）。

## 7. 工具与口径备忘

- 三点扫描代理：net.createServer 逐 chunk setTimeout 双向各垫 RTT/2（QA1/GAMES-93/104 同法，免 sudo netem）；私口 4451/4452/4453。
- 探针脚本：`evidence/g114-qa2/`（qa2-harness.mjs 主臂 + recon-5s-fixup / abandon-fixup / q3q4-fixup / yield-exit-probe 四个补跑——伪红归因后换法重取）；日志与判定全量在 `kernel/workers/GAMES-114/`。
- 主 harness 两处伪红记录（tick 913→304=goto 抹回写 ?room= 进新房，恰为 F9 未修行为对照；旁观 tick 口径）——保留在日志中作归因链，判定以补跑为准。
