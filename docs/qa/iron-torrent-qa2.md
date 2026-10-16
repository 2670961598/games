# 钢铁洪流 QA2 全链红线专项二轮报告（GAMES-151）

- 单据：[QA·E6-W2-T4] 钢铁洪流 QA2 全链红线专项（7/10+）（预算版）
- 分支：feature/GAMES-151（merge main 无前进，基线 = FEEL f0d0536；FIX1=GAMES-148 / BOT=GAMES-149 / FEEL=GAMES-150 全量上线后复验）
- 日期：2026-10-16 ｜ 角色：QA（只读纪律：零产品代码改动；测试件 `scripts/iron-torrent-qa2-net.mjs` 本单新增，三臂 --latency/--mercy/--sp1）
- 环境：影子网关 `:4416/:4418/:4419`（PORT/GATEWAY_PID/GATEWAY_LOG 显式改道，:4399/:4400 零感知——:4400 仅冻结命令按需建房）；剧本房一律 `/api/test/*` 隔离房；mercy 臂走 WS quick 真路径（协议 §2）。`:4417` 发现被共享工作树他源静态服务器占用（127.0.0.1 特定绑定，我的网关 0.0.0.0 绑定并存——WS 升级被静态服务器拒收）→ 弃用改道 `:4419`，环境面非产品面。
- 结论：**全链红线净绿——冻结命令 52/52、web 臂 16/16（F1 修复形状再证）、deterministic 三等锚 514316855 在场、latency200 偏置定量落盘（Δmean=+1.33，7 局零反超）、放水链在线三面全绿（L1/L2/生态位让位）、观战/满编/长局交叉引用全绿**。QA1 观察项 O-1..O-4 闭环抽验全口径一致。net 臂 3 红 = 2 处 QA1 测试面期望漂移（BOT 单行为面调整后单 seed 计数代理失稳，BOT 单自检 22/22 复跑全绿裁定）+1 处 QA1 测试件 WS 口硬编码（本单复刻复证 3/3 绿）——零产品缺陷退回。

## 0. 冻结验收命令（自跑）

```
cd /Volumes/BigDisk/Studio/projects/GAMES/repo && node scripts/api-check.js iron-torrent && test -f docs/qa/iron-torrent-qa2.md
```

结果：`api-check iron-torrent` **52/52 绿**（exit=0）+ 本报告落盘 → 退出码 0。明细 `/tmp/qa2-151/../qa2-api-check.log`（本机 `/tmp/qa2-api-check.log` 在档，报告 `/Volumes/BigDisk/Studio/kernel/workers/GAMES-41/api-check-iron-torrent-20261016024724.json`）。

## 1. QA1 O-1..O-4 闭环抽验 + FIX1 处置面复核

| 项 | QA1 形状 | 本单抽验现况 | 裁定 |
|---|---|---|---|
| O-1 quick 并入在打房 | 探针 frame=554@join，接手中途 Bot 坦克 | **现况复现且形状一致**：web 臂首跑 quick 并入在打局（fire 12×0.7s 重试全落 CD/阵亡窗，reject×0=uiTap 门静默设计非 F1 形状）→ 二跑落新建房 16/16 全绿——与 FIX1 报告「首跑 11/16→二跑 16/16」同构 | 口径闭环（决策 15 已文档化：让位语义设计内，v1 不改），非缺陷 |
| O-2 断线窗开阔地弹着无补发 | §5.6 设计态 | 设计态口径未变（本单零改动面）；掩体弹着耐久归账在 net 臂长局 L3 复证绿 | 闭环 |
| O-3 hp 对账观测缺档 | 增量快照拆批观测缝隙 | 记账面守恒口径未变；net 臂 S4-4 重跑绿（hp 对账分段守恒断言通过） | 闭环 |
| O-4 测试件面（3+1 处已修） | QA1/FIX1 修 4 处 | web 臂二跑 16/16=修复件持续有效；**新披露第 5 处**：net 臂 SP1 WS 口硬编码 `ws://127.0.0.1:4415`（QA_GW 只覆盖 HTTP 面）——本单 --sp1 臂按环境改道复刻同断言组 3/3 绿（见 §4），测试件零产品面 | 闭环+新披露 |

**FIX1 处置面复核（web 臂 16/16 现况）**：`scripts/iron-torrent-qa1-web.mjs` 二跑 **16/16 绿**（A2 fire 钮真实输入路径→我席权威 fire 回执在页 ✓、A4 fire tap→权威事件 <1500ms ✓、识图三面全绿：墨水 28.1%>3%、双色簇 amber/cyan 在场、预览线在场）——**F1 修复（client.js 锚定 frame 落窗+keys.cmd 透传）后浏览器 fire/swap 真实生效持续在场**，FIX1 单自证（16/16）后二次独立复证。

## 2. 全链红线复验

- **api-check 52 面（校准三口径）**：52/52 绿。A8 latency200=「双臂完赛+延迟臂不反超（kB≤k0）+战果在场（k0+kB≥1）+carriedInputs>0」（校准三 PM 落笔 2026-10-16）——本跑 arm0=5 armB=3。
- **deterministic 三等**：同 seed 同策略两房终态 stateHash 相等（**514316855**）+ 在线终态==回放器重放（**514316855**）——**三等成立，锚与 BOT 单重锚值一致**（GAMES-149 A8 新锚 514316855）。
- **latency200 延迟臂偏置定量（QA1/FIX1 遗留归本单）**：`--latency` 臂 gunner 策略（api-check POLICIES.gunner 逐字节复刻）×6 seed×双臂（delayMs=0/200，ts=8/seed=20261015+{0..5}/maxTicks=9600/botLevels=3×balanced，与 A8 同参）+冻结命令 1 局 = **7 局样本**：

| 局 | arm0(k0) | armB(kB) | kB≤k0 |
|---|---|---|---|
| 冻结命令 seed=…015 | 5 | 3 | ✓ |
| …015（定量臂） | 4 | 3 | ✓ |
| …016 | 2 | 0 | ✓ |
| …017 | 2 | 0 | ✓ |
| …018 | 1 | 2 | ✗（低尾域反超） |
| …019 | 4 | 1 | ✓ |
| …020 | 1 | 0 | ✓ |

  **定量结论：kB 均值偏置在场——k0 均值 2.71 vs kB 均值 1.29，Δmean=+1.43（定量臂 6 局 Δmean=+1.33）；逐对不反超 6/7（唯一反超=seed …018 低击毁尾域 k0=1/kB=2）**。语义：①200ms 延迟臂注入下 API 席击毁数**均值系统性低约 1.4 局当量**（偏置量级与 GAMES-148/150 历史样本同向）；②「延迟臂不反超」作为**逐局谓词在低击毁尾域不稳健**（1/7 反超），稳健面=均值偏置（本跑冻结命令 A8 的单局谓词 5≥3 仍成立）；③延迟不消灭战果（7/7 局 k0+kB≥1）。armB 终局形态 2/6 走 timeout（k0 多为 eliminated/capture）——延迟臂收尾节奏拖慢的形态面。**建议：校准四候选=均值面（Δmean≥0）替换单局谓词作 A8 主断言，单局不反超降级披露**（PM 裁决归 FIX/校准单，本单只落定量）。

- **重连三档（FEEL 后手感层状态延续）**：net 臂 R1-R3 全绿（5s 全测：断线 5s 席位保留→复席重同步 full=1+续玩 tick 推进；10s 窗内 9.6s<10s 复席有效；30s 逾窗托管 balanced+resume 409+战局不断）。FEEL 层零改动重连面——状态延续断言全过。

## 3. 放水链在线验证（`--mercy` 臂，GAMES-142 street 范式移植）

testapi 房结构性不可达（单局 pulse 恒 0）→ WS quick 真路径：W 同 conn 连败爬档（rooms.js finish 按 `META.pulseTeam`（适配器 iron-torrent.js:144）记台账→doFrame botEnv.foeLose 注入→sim brain 放水链）。全 balanced bot 自建房（quick 无 level 入参=框架现状，street 同式；**饱和器逐局占满既有 bothost iron 房 bot 席**——bots:4 满员房仍可被 quick takeover 并入（O-1 语义）且并入即 480s 满长局），maxTicks=1600（80s 帽）×5 局，W=seat3（队 B、站桩零输入，mate=seat1、对席=seats 0/2）：

| 局 | 连败前值 | 相位 | 对席 fires(s0+s2) | W 队被命中 | 对席命中效率 | mate(s1) fires | mate 命中率 | 终局 |
|---|---|---|---|---|---|---|---|---|
| g1 | 0 | 基线 | 23 | 17 | **0.739** | 10 | 0.70 | A eliminated |
| g2 | 1 | 基线 | 26 | 12 | 0.462 | 19 | 0.79 | A timeout |
| g3 | 2 | **L1+让位** | 41 | 7 | **0.171** | 20 | **0.25** | A timeout |
| g4 | 3 | L1+让位 | 37 | 20 | 0.541 | 11 | **0.27** | A eliminated |
| g5 | 4 | **L2**+让位 | 39 | 19 | 0.487 | 12 | **0.33** | A timeout |

- **MY-1/2 pulse 台账在线生效**：W 同 conn 连败 5/5（≥min=2、≥hard=4 全爬到）✓
- **MY-5 L1 让力**（连败≥2）：对席 bot 对 W 队命中效率 **0.739→0.171**（g3，-77%；让位三局均值 0.400 vs 基线两局 0.60）——noise1 散布附加+提前量降轮+errP 失误注入在线可观测 ✓
- **MY-6 L2 重败**（连败≥4）：g5 效率 0.487 仍低于基线（降档 comp→bal+noise2 双重作用；timeout 局形态=不送头）✓（披露级）
- **MY-3/4 生态位让位**（同队 bot seat1）：fires 保持（10/19→20/11/12）但**命中率坍缩 0.70/0.79→0.25/0.27/0.33**——收步让位（bot 退真人身后 60000）射几何劣化的在线足迹 ✓。**方法论披露**：fire 率坍缩代理在本几何失效（对席逼近站桩 W 时让位门 `myFd<mFd` 破，让位 bot 恢复开炮）——改命中率面取证；让位决策本尊（Y1-Y3 收步+让火力位）决策级 A/B 已由 BOT 单 bot2-check 证（本单复跑 22/22）。
- 附：连败三局 W 队对席 kills=0/0/0 vs 基线 1/4（对席输出全面收敛）——与 L1 效率面同源。

（逐局明细 `/tmp/qa2-151/mercy.log`——BOT 单决策级 A/B 之外的在线链路复证。**测试件注记**：该跑日志中 MY-3/4 按旧「seat2 固定面」判（exit=1，1 红）——seat2 实为对席 bot（W=seat3 时 mate=seat1），上表为**同原始数据 W 相对化重算**；测试件已改席相对+命中率面（`scripts/iron-torrent-qa2-net.mjs`），fire 率坍缩旧面弃用。）

## 4. 长局 spot 8min 交叉引用+满编+观战（F12 特写横幅 FEEL 后数据面）

- L1 长局 spot：maxTicks=9600=480s 硬顶房 spot×20 tick 单调+stateHash 演化 ✓（net 臂复跑绿，末 spot tick>5min 观测窗覆盖，8min 帽内）。
- L2 命池对账 kills↔lives 闭合 ✓；L3 掩体对账 crumble↔tileHp 一致+终局裁定闭环 ✓（确定性锚在场）。
- N7 满编 2v2：4 席在场（1 API+3 bot，human/bot 结构合法）✓。
- SP1 观战数据面：net 臂 SP1 红=QA1 测试件 WS 口硬编码 :4415（本机无监听）——**本单 --sp1 臂复刻同断言组 3/3 绿**（4 真人满员→第 5 连接 join→spectator 位+收同快照流 full=1+frame 推进+ack=-1 观战席锚+projs 同流，frame 390→396）。F12 特写横幅=FEEL 单交付面，本单数据面复证通过（fe-check post 19/19 含 HUD 面零扰动）。

## 5. FEEL 后三支柱抽验（fb 台账/音效位零扰动）

`scripts/iron-torrent-feel-check.mjs --phase base` + `--phase post`（影子网关 :4416）：**base 1/1 + post 19/19 全绿**——FE-2 fb 动效首绘时延台账（≤80ms 红线）、FE-3 音效位台账全槽位触达+默认 on=false、FE-4 识图三帧 HUD 零位移、FE-5 perf 同带、FE-6 双色簇在场。**FEEL 合入后零漂移**。

## 6. net 臂 3 红裁定（零产品缺陷，不退回）

| 红 | 形状 | 裁定 |
|---|---|---|
| B2 balanced HE 战术使用>casual（cas=24 bal=12 反向） | QA1 断言=单 seed 计数代理（QA1 时 cas=8/bal=21）；GAMES-149 brain 行为面调整（决策节流/占点圈/换班窗）后同 seed 计数分布移位——**deterministic 房内形状稳定非随机**，代理阈值失稳 | 测试面漂移：BOT 单自检 `iron-torrent-bot2-check.mjs` 本单复跑 **22/22 绿**（含 N1 梯度 D1-D4 四面）+B1 命中率梯度本跑仍绿——行为谱分层成立，计数代理断言归 QA1 旧测试面（建议后续单据按 bot2-check 口径重锚，非缺陷） |
| B3 casual capPeak==0 且 competitive>0（comp=0） | 同上（QA1 时 comp=110；GAMES-149 站桩带冻占点圈/换班窗调整后开局占点形态移位） | 同上（bot2-check N1/N5 让位面绿） |
| SP1 观战数据面（quick-ws-error raw=[]） | QA1 测试件 SP1 块 WS URL 硬编码 `ws://127.0.0.1:4415`（QA_GW 只覆盖 HTTP 面；QA1 时 :4415 恰有网关故绿） | 测试件缺陷：本单 --sp1 复刻 3/3 绿（§4）——观战产品面健康 |

## 7. 回归抽查 2 作（零产品改动，同门禁复验）

| 作 | 结果 |
|---|---|
| street-soccer | api-check **39/39 绿**（`/tmp/qa2-151/reg-street.log`） |
| pool-physics | api-check **19/19 绿**（`/tmp/qa2-151/reg-pool.log`） |

## 8. 观察项（编号接 QA1 O-4）

- **O-5（低危·测试面）**：QA1 net 臂 SP1 块 WS 口硬编码（O-4 第 5 处同族）——本单已用 --sp1 复刻臂绕过并复证；建议后续统一改读 QA_GW 派生 WS 口。
- **O-6（低危·观测面）**：latency200 定量臂 4/6 局 armB 走 timeout 终局（k0 多为 eliminated）——延迟臂收尾节奏拖慢的形态面，与 Δmean 偏置同源，非缺陷。
- **O-7（环境面披露）**：:4417 端口被共享工作树他源进程（127.0.0.1 特定绑定的静态服务器）占用，0.0.0.0 绑定网关与之并存——WS 升级被静态服务器拒收；本单改道 :4419。共享工作树端口分配建议纳入 lane 纪律。

## 9. 证据索引

- 冻结命令：`/tmp/qa2-api-check.log`（52/52，exit=0）
- net 臂：`/tmp/qa2-151/net.log`（38/41，3 红裁定见 §6）
- web 臂：`/tmp/qa2-151/web.log`（11/16=O-1 场景形状）+ `/tmp/qa2-151/web2.log`（**16/16**）
- feel：`/tmp/qa2-151/feel-{base,post}.log`（1/1+19/19）
- 定量/放水/观战：`/tmp/qa2-151/{latency,mercy,sp1}.log`（本单测试件 `scripts/iron-torrent-qa2-net.mjs`）
- BOT 自检复跑：`/tmp/qa2-151/bot2.log`（22/22）
- 回归：`/tmp/qa2-151/reg-{street,pool}.log`
- 影子网关日志：`/tmp/qa2-151/gw{4416,4418,4419}.{out,log}`
