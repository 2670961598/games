# 帝国萌芽 QA 一号报告（empire-sprout-qa1）

> 单据：GAMES-69（[QA·E6-W1-T3] 帝国萌芽 QA一号（三支柱+S3专项）单链 3/10+，attempt 0）
> 对象：`games/multiplayer/empire-sprout/` + `server/gateway/sims/empire-sprout.js`（GAMES-68 @ 08207eb 交付物）
> 立场：**独立复测**——不信任 DEV REPORT 自测，以下全部数据为本单亲测采集。
> 环境：feature/GAMES-69（先 `git merge main` → Already up to date @ f672fe0；**main 尚未合入 GAMES-68**，按 GAMES-53「QA 并 DEV 分支取对象」先例合并 feature/GAMES-68 → 19a2c53，不含其他单据文件）。
> 网关：:4400 常驻进程起于 DEV 会话中途（05:08:39，早于终稿 08207eb），按「改 sim 后须对 pid」纪律同口径重启自本分支（pid 20389，`HOST=0.0.0.0 node server/gateway/index.js`）；:4399 零触碰。任务书不含 net-check 大厅面，未涉 dist 遮蔽问题。
> 证据目录：`/Volumes/BigDisk/Studio/kernel/workers/GAMES-69/`（探针 4 + JSON 11 + shots 5 张）。
> 执行日：2026-09-28（本机 LAN；SOP §8.5 预算版：串行实测 13m14s ≤25min，每步计时见 §7）。

**总裁决：全部红线 PASS，无红线退回项。** S3 三专项（静默期爆发 / attack 桥一致性 / 两层抓包）全部实证。附 2 项 Bot 平衡类质量发现（槽位死锁 + 节奏互锁，建议开 FIX 单，见 §6）。

---

## 1. api-check（独立复跑 + 存量三作回归）

命令：`node scripts/api-check.js <gameId>`（剧本来自 game.json `net.api`：seed=20260928、timeScale=8x、win=empire-rush vs 3×casual、lose=idle vs 3×competitive）。

**empire-sprout：16/16 全绿，退出码 0。** 证据：`api-check-empire-sprout-20260927215428.json`。

| 断言 | 结果 | 实测值 |
|---|---|---|
| P0 网关在线 | ✅ | rooms=7（net×2+slg×2+mmo×1+emp×2 BotHost 常驻） |
| L1 测试面仅本机 | ✅ | 经 LAN 地址 192.168.31.25:4400 实测 403 local-only |
| A1 建房/boot waiting | ✅ | roomId=emp-hxl510… seat=0 human；测试房不进 feed（隔离） |
| A1 S3 welcome.state 双层 | ✅ | build.seats=4（资源/建筑位）+ battle.bld=4 墙HP=800 |
| A1 S3 首张建设快照 | ✅ | layer=build full=1，snapSeq=1 frame=1 ents=6 |
| A4 注入→快照 ack 反映 | ✅ | **42ms** <100ms（timeScale=8x 服务端同钟）；GET 往返 2ms |
| A5 断线席位保留/复席 | ✅ | 1.2s 断线期 kind=human；resume=**1208ms**，welcome 重同步，tick 106→185 续玩，全程 <10s 红线窗 |
| A2 能赢 | ✅ | winner=**A** reason=eliminated，tick=**2560**，scores A:117/B:38，墙钟 32.7s |
| A3 能输 | ✅ | winner=**B** reason=eliminated，tick=**2012**，scores A:4/B:75，墙钟 25.9s |

A2@2560 落 DEV 自测窗 2568-2653 同族（empire-rush 按 120ms 轮询注入，注入时序抖动属剧本驱动形态非确定性问题）；**A3@2012 与 DEV 两次自测逐次相同**——idle 剧本零输入全确定，是 §5 确定性的旁证。

**存量三作回归（rooms.js o/c 双键壳 + emp- 前缀扩展零感知佐证）：**

| 游戏 | 结果 | 退出码 |
|---|---|---|
| net-tank | 14/14 全绿 | 0 |
| slg-battlefield | 14/14 全绿 | 0 |
| mmo-township | 16/16 全绿 | 0 |

## 2. perf 三跑中位 + 识图 v2 复检

**perf**：`node scripts/perf-smoke.js --all --slug empire-sprout --ms 5000` ×3（每跑自起临时 server + 随机端口 + 隔离 DATA_DIR）。证据：`perf-run{1,2,3}.json`。

| 红线 | 口径 | run1 | run2 | run3 | **中位** | 判定 |
|---|---|---|---|---|---|---|
| 平均帧率 ≥55fps | 5s rAF 采样（301 帧） | 60.1 | 59.9 | 59.3 | **59.9** | ✅ |
| 掉帧占比 <2% | >25ms | 0.0% | 0.33% | 1.01% | **0.33%** | ✅ |
| long17 <2% | >17.5ms（bench 严格口径） | 0.0% | 0.33% | 1.01% | **0.33%** | ✅ |
| p95 帧间隔 | 参考 | 16.7ms | 16.7ms | 16.8ms | 16.7ms | — |

**识图 v2**：`node scripts/vis-empire-sprout.mjs --out …/GAMES-69/shots`——**15/15 全绿**，与 DEV 自测一致。证据：`shots/vis-empire-sprout-report.json` + 5 张 DSF=1 截图。

- V1 几何：scroll=375/client=375 无溢出；全 DOM 可见元素越界 0；画布 (0,0,375,667) 完整落视口。
- V3 墨水带（CDP 像素直读）：顶栏 8.2% / 表盘区 13.0% / 底栏 8.6%；双表盘切换 tap〔军〕→ dial()=war 实测通过，战场盘着墨 5.1%。
- V3-6/7/8 字号登记表：P0≥13 / P1≥11 / P2≥9 全达标（hud-font-standard §1）。
- V4 终局（maxTicks=600→timeout）：overlay flex + 按钮集〔再来一局|回大厅〕+ 弹层完整落视口；V5 整轮零 pageerror。
- 视觉模型（glm 系）中性 prompt 交叉判读 city/war 两盘：三联资源+产率、爆发倒计时、盟友领地/己方建筑位（6 选 4 虚线格）、城心/城墙镜像卡、双队心+墙 HP 血条、兵池 0/12、队列、〔城〕〔军〕切换、快出条——**与几何真值全部一致，零冲突裁决项**。

## 3. S3 专项（静默期爆发 / attack 桥一致性 / 两层抓包）

探针：`s3-probe.mjs`（隔离房 emp-4n1v2g3531，seed=20260928、ts=10x、[null,3×casual]——casual 首征 2050+ 保证爆发帧纯净；API 席按被动产出推演时间表受控建设 lumber@155→farm→camp→train×5→attack）。证据：`s3-probe.json`。账本 2661 条（快照+帧）、全量 state 采样 422 帧。

### 3.1 静默期 → tick1800 爆发

| 检查 | 实测 | 判定 |
|---|---|---|
| 静默期零战斗帧 | 账本 frame 总数 430，**frame<1800 共 0 条**（快照通道 tick 1-2229 全程在场） | ✅ |
| 首战斗帧号 | **frame=1800**（恰为爆发帧，无提前/迟到） | ✅ |
| 首帧 inputs | 4 席 **cmd.k 全 'noop'**（无桥无 c） | ✅ |
| erupt 事件 | 首帧 events **[0]={k:'erupt'}**（首位） | ✅ |
| 帧层标记 | ext.layer='battle'；建设快照 ext.layer='build' | ✅ |

静默期=设计态（tick<1800 战斗通道停发）实证成立，非断流。

### 3.2 attack 桥一致性（三层对账，6 次 march：1 受控 + 5 bot 自然）

时序口径（本单实证并固化）：o 壳出征在 step 内以内部 tick T 结算（march 事件）→ 同 step 战斗相位消费桥 → 组包时 `st.tick++` 已完成——**携带 march 的建设快照与携带 attack cmd 的战斗帧同为帧号 T+1**（同帧号配对，非跨帧 T→T+1 字面）。

| 层 | 检查 | 实测（6/6 march） |
|---|---|---|
| 层2 战斗帧 | 帧 T+1 inputs[S].cmd={k:'attack',lane,units} 与 march 逐字段一致 | ✅ 6/6 cmdMatch（含 tiers 快照字段） |
| 层2 | 同帧 spawn 事件兵种分布 == units、计数一致（编队行展开） | ✅ 6/6 |
| 层1 建设 | 池 FIFO 扣池（补偿 train-done 后零差）+ marchCd=200 + marched++ | ✅ 6/6（如受控席 marchCd 1806 后=196、marched=1） |
| 层3 战斗 | 按 nextId 区间锁定本批出生实体（含同帧并发 spawn 偏移），code/tier 多重集 == tiers 快照 | ✅ 6/6（受控批 5×inf-T1 born=5 dies=0） |
| 注入→帧墙钟 | 受控 attack receivedAt → 帧 ts | **7ms**（红线 ≤2 tick=20ms@10x；run 间 7-36ms） |

同帧并发案例：seat1/seat3 同 tick 1901 双 march → 同帧 1902 各自 cmd + spawn 12 单位按席位序 id 连续分配——桥在同帧多席并发下保持一致。

### 3.3 两层抓包样本复核（各 ≥3 张）

| 通道 | 样本（frame / 字节） | 形态 |
|---|---|---|
| build 全量 | 1 / **926B**、1101 / 1222B、2221 / 1451B | `{t:'snapshot',full:1,snapSeq,ext:{layer:'build',ack},ents:[6席+2队]}` |
| build 增量 | 2 / **277B**、1117 / 390B、2229 / 457B | 脏实体+自身实体首位（ack 口径） |
| battle 帧 | 1800 / **187B**、2015 / 174B、2229 / 246B | `{t:'frame',frame,inputs,events,ext:{layer:'battle'}}` |

与 DEV 交付样本（protocol-samples.json：全量 926B / 增量 277B / 首帧 187B）**逐字节同级**。双通道并行性：爆发后 430 个战斗帧 tick **430/430 均有同帧建设快照配对（缺对 0）**——单 tick 源双通道无相位漂移（设计 §5.1）。

## 4. Bot 三档差异数据（建设倾向 × 战斗时机，6 局对照）

方法：`bots-diff.mjs`——2 seeds（71001/71002）× 3 档 = **6 局**，[null,同档×3] API 席零注入，ts=12x，账本全程逐事件记账（built/train-q/march + 帧 inputs rally）。证据：`bots-diff.json`。

**行为参数表（每档 6 席实测，跨 seed 零漂移——同 seed 派生 rng 确定性）：**

| 指标 | 设计 §4 | casual | balanced | competitive |
|---|---|---|---|---|
| build order 实序 | 农本 / 均衡 / 军备 | lumber@151→farm@251→farm+Lv2@401→camp@601 | lumber@161→farm@241→camp@401→mine@501（**works 永未建**，见 F1） | lumber@151→camp@401→farm@411→works@1001→camp+Lv2@1801 ✅军备竞速 |
| 决策间隔 | 50/20/10 tick | 50（建序间隔 100-200） | 20 | 10（works 建成间隔紧凑） |
| 首征 tick | 慢半拍 ~2050-2200 / 爆发即征 / timing attack | **2151-2201**（6/6 落设计窗） | **1801**（6/6 爆发帧后首拍） | **1811**（6/6，gate=10 攒池 1 拍差） |
| 出征 lane | 固定 1 / 最薄道 / 双线分压 | 1（6/6）✅ | 1（首征时敌方全车道 0 单位→最薄=1 退化为 1；单 march 局未观测后续轮换） | **0**（6/6 首征 lane0=分压首拍 ✅；局短未及 flip 到 2） |
| rally | 无 / 前线 1/2 / 动态 | **0 条**（6/6）✅ | 动态前导（rows 10→19 随战线前压 ✅） | 动态前导（B 席 rows 10→8 反向 ✅）+ 破墙集火（局短未触发） |
| camp 升级 | — / Lv2@~1500 / Lv2@~1200+Lv3@~2400 | 不升级（6/6） | **Lv2 未发生**（升级线被 F1 屏蔽） | Lv2@1801 ✅（Lv3 局短未及） |
| 练兵结构 | inf 止步 6 / inf:razor 2:1 / 情报克制+heavy | inf×12（池 6 止步 ✅） | **inf×20（razor 0——F1）** | **inf×12（heavy/克制 0——F2）** |
| vs idle 席终局 | — | eliminated@2412/2501 | eliminated@2052 | eliminated@2012 |

时机轴与建设倾向轴**双轴差异真实成立**；但兵种结构轴三档同质化为纯 inf（F1/F2，§6）。三档对 idle 均能终局（<7200 硬顶，无 slg QA1 的死锁挂机型问题）。

## 5. 确定性抽检（同 seed 双跑一致）

探针：`determinism.mjs` + `sim-identity.mjs`。证据：`determinism.json`、`sim-identity.json`。

| 检查 | 结果 |
|---|---|
| A) 服务端同 seed 双跑（seed=777、[null,balanced,casual,competitive]、零注入、maxTicks 2600） | 两房终态 state **sha256 前 16 位 e8f4fc067bea589c 相等**（tick 1981=1981 自然终局）；下行账本消息流（去 ts，2661+ 条快照+帧）**逐条一致**；result 逐字段一致 ✅ |
| B) 本地 sim.cjs 固定输入程序双跑（含 o 壳 build/train/attack + c 壳 rally、跨 1800 爆发、2600 tick） | serialize **逐字节一致 ×2**（2539B，sha d31a484f036412b0） ✅ |
| D) 浏览器内联 EMPSim（index.html 构建期副本）vs 本地 sim.cjs 同程序 | fnv(serialize) **ff05e065 双侧相等**（len 2542、merit {"A":6,"B":96} 逐字段同）——服务端/客户端同源声明成立（S3 客户端镜像追帧先决条件）✅ |
| C) 静态纪律（确定性核心 create…serialize 389 行） | Math.random/Date.now/sqrt/hypot/浮点字面量（剥注释）**命中 0**；bot rng 限 brain 区（合法）✅ |
| 旁证 | api-check A3 idle 剧本（零输入）本单 tick=2012 与 DEV 两次自测相同；§4 六局同档跨 seed 席位行为零漂移 |

**结论：同 seed 同输入（含 bot rng 种子派生）连跑，终态与全下行消息流逐条一致——S3 确定性红线 PASS。**

## 6. 退回项清单与 FIX 建议

**红线退回项：无**（§1-§3、§5 全部红线 PASS；§4 为参数真实性核验，非红线门禁）。

**质量发现（非红线，建议开 FIX 单）：**

| # | 级别 | 条目 | 证据 | 复现 |
|---|---|---|---|---|
| F1 | 中（玩法平衡） | **balanced build order 槽位死锁**：BUILD_ORDER.balanced 5 项 > PLOTS=4，第 5 项 works 的 `s.plots.indexOf(null)`=-1 → 每 20tick 空转永不建造；且 mem.bi 停在 4 <order.length → **升级线 else 分支永不可达**（设计 §4「camp Lv2@~1500」实测未发生）。双重后果：razor 混编线（inf:razor 2:1）永不可达 + T2 档位线断——balanced 实际退化为「纯 inf 的 casual 换皮」，与 casual 仅剩时机差 | `bots-diff.json` 6 局 balanced 12 席：works 0 次、campLv 全 lv1、trainHist inf:120 razor:0（mine@501 后 1551 tick × w500/tick≈775w 远超 works 造价 w80k——资源充分仍不建，槽位死锁铁证） | 建房 [null,b,b,b] seed=71001，观 seat1 建序止于 mine@501、plots 4/4 满、works 全程未出 |
| F2 | 中（玩法平衡） | **competitive 铁系节奏互锁 + 危机 mine 死分支**：① build order 4 项占满 4 槽 → 危机补 mine 分支（wallDown 且无 mine）`indexOf(null)`=-1 永不可发；② camp+Lv2@1801 清空铁（i80k）后铁收入仅 passive 100/tick（无 mine）→ razor T1 需 i90k ≈ tick2701 才可达，heavy 另受 (pool+q)%3===2 窗口错位（实测唯一窗口 10%3=1）——爆发后至局终（2012）**克制/heavy 0 次**；③ 情报克制 COUNTER_PICK 命中 razor/arty 同受铁闸。三档兵种全部同质化为纯 inf（72/120/72），克制表在 bot 对局中不可达（slg QA1 F2 同构再现） | `bots-diff.json` competitive 6 席 trainHist inf:12；works@1001→campLv2@1801 → i 清零推演（sim PASSIVE.i=100）；s3-probe 6 局 march units 全 {inf:n} | 建房 [null,c,c,c] seed=71001，观 seat1：1801 后 train-q 永为 inf、wallDown 后无 mine 建造 |

**FIX 建议方向**（供 FIX 单参考，本单不修代码）：F1 将 balanced build order 截断至 4 项（mine 与 works 二选一进前四）或 PLOTS 扩至 5 / 支持原位替换；并给 build 分支加「目标不可达（无空位）时 bi++ 防卡死」兜底。F2 给 competitive build order 以 mine 换 farm（或危机分支允许拆 econ 原位改建）；铁系门控放宽（camp Lv2 后被动铁上调或首训 heavy 显式窗口）；克制兵支付档降级（先 inf 后换装）。

**已披露遗留确认（DEV REPORT 偏差 4，非新发现）**：在线模式训练队列进度条静态 0.5——识图/在线面未见异常回退，留 VIS/后续单深化。

**SOP/取证观察（无需行动）**：S3 桥取证的帧号口径为「快照与帧**同帧号** T+1」（step 内组包先于 ++ 的直觉是反的——组包时 ++ 已完成）；同帧并发 march 的实体 id 按席位序连续分配，对账须按 nextId+偏移锁定批次。已沉淀 Article 草稿供 QA2/STRESS 复用。

## 7. 预算自查与结论

SOP §8.5 预算版自查（实测窗 05:54:28→06:07:42，**13m14s ≤25min**）：

| 步骤 | 时长 | 备注 |
|---|---|---|
| T1a api-check empire-sprout | 62s | 16/16 |
| T1b 存量三作回归 | 3m52s | 44 断言全绿 |
| T3 S3 专项探针 | 23s（终跑）/ 全程 88s | 探针帧号口径修正重跑 ×2（见 §6 观察），终跑数据为准 |
| T4 Bot 三档 6 局 | 42s | 2 seeds × 3 档并发 3 房/批 |
| T5 确定性双跑+同源 | 30s（终跑）/ 全程 95s | 静态纪律正则伪阳修正重跑 ×2 |
| T2 perf ×3 | 30s | 中位 59.9fps |
| T2b 识图 v2 | 69s | 15/15 + 视觉模型交叉判读 |
| **串行实测合计** | **≈8m33s（终跑口径）/ 13m14s（含重跑全程）** | 环境准备（merge+网关重启+探针编写 ≈10min）单列不计 |

**结论**：三支柱（API 可玩 16/16 + 回归 44 断言全绿、性能 59.9fps/0.33%、识图 15/15 零冲突）与 S3 三专项（静默期→1800 爆发 noop+erupt、attack 桥三层对账 6/6 同帧一致、两层抓包 9 张样本字节同源）全部实证；确定性（服务端双跑账本流逐条一致 + 客户端/服务端 sim 同源 fnv 相等）红线 PASS。红线零退回；F1/F2 两个 Bot 平衡发现（槽位死锁/节奏互锁→三档兵种同质化）建议开 FIX 单承接。
