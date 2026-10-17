# 深海食物链 QA2 全链红线专项报告（GAMES-168）

| 项 | 值 |
|---|---|
| 单据 | GAMES-168（[QA·E6-W2-T6] 深海食物链 QA2 全链红线专项（6/10+））attempt 0 |
| 分支/基线 | feature/GAMES-168 @ merge main=9231109（FIX1 跳过；BOT=GAMES-166 c9588f3 / FEEL=GAMES-167 80e0708 已上线——FEEL 提交仅触 client.js+feel-check 件，sim/brain 零改动，结构面即零漂移） |
| 环境 | 私有影子网关 :4424（PORT/GATEWAY_PID/GATEWAY_LOG 显式改道，:4399/:4400 零感知——页面自 :4399 生产 web 只读加载）；剧本房 seed=20261018/19；无头 chromium（playwright） |
| 测试件 | scripts/deep-foodchain-qa2-{net,web,full,mercy2}.mjs（QA 只读纪律：零产品代码改动，四件均为测试件；-full 为 QA1 件端口适配复用） |
| 证据 | kernel/workers/GAMES-168/{net,web,mercy2}-evidence.json；门禁 JSON GAMES-41/api-check-deep-foodchain-20261017040600.json |

## 一、结论总览

- **红线判定：通过（退回清单 0 项）**。QA1 O-1..O-4 闭环（2 收口/2 维持处置）、BOT 处置面复核（AFK 放水靶收窄在线复证）、FEEL 后零漂移抽验、全链红线（api-check 54 面+deterministic 三等+重连三档+托管）、放水链在线复证、长局 8min+满编+观战全绿；回归抽查 2 作。
- 冻结门禁独立复跑：`node scripts/api-check.js deep-foodchain`（影子网关）**54 通过/0 失败 exit 0**。
- 回归抽查 2 作：snake-king **44/44**、yi-pavilion **21/21**。
- 本单 3 处脚本侧假红/口径纠偏复盘（§八：台账重生清零/轮末 deaths 重置/QA1 逾窗空洞绿纠偏——皆测试件口径非产品缺陷）。

## 二、QA1 观察项闭环（O-1..O-4）+BOT 处置面复核

| 项 | QA1 记录 | QA2 处置 | 判定 |
|---|---|---|---|
| **O-1** 长局瞬态活鱼 17（<19） | 5min 30 采样 1 次跌 17，1.5s 恢复 | 8min 细粒度恢复探针+统计身份式定案（§六）：占比=吞噬经济泊松必然、恢复 ≤3s 重生窗、底 17 两 seed 复现 | **收口（非缺陷，口径注记）** |
| **O-2** perf blank 对照带 n/a | 无头 about:blank rAF 饥死（合成器空闲伪影） | **F2 闭环**：1px canvas 重绘循环喂活合成器（GAMES-166 范式）→ blank-fed 带 n=80 avg=0.02ms 可测；game=0.28ms 同量级=渲染负载未越界 | **收口** |
| **O-3** T3 深蓝色通道峰值 34px（四档最薄） | 形通道深度核验留 VIS 单 | 维持原处置（VIS 单未开工，色通道在场可辨不变） | 维持 |
| **O-4** balanced 平均档位 0.57≥comp 0.51 | 设计自洽（comp dash 燃烧质量成本），非缺陷 | 维持原处置（生态位≠难度条口径不变） | 维持 |
| **BOT 处置面** AFK 放水靶收窄（afk.t≥600 不入放水靶） | GAMES-166 决策级已证 | **在线复证**（§四 W2）：代码在 HEAD 在场（`sim.cjs` mercyOf 判据含 `!(st.afk[e.seat].t>=AFK_TICKS)`）+ 在线托管窗台账停增实证 | **在场且生效** |

## 三、全链红线复验

### 3.1 冻结门禁 api-check（54 面）——绿
影子网关独立复跑 **54/0 exit 0**（A1-A8 全链：声明块/秒配/托管/断线重连/带宽退化/质量账本/排行榜不变量/三 seed 统计制剧本）。

### 3.2 deterministic 三等（D1）——绿
同 seed（20261018）三房并行零输入（ts4，MIX20 档 19 bot+API 席 AFK 托管在环），ts4 跑过 2500 tick，逐 tick fnv1a32 全 state 投影指纹（剔席位名随机字段）：**交集 274 tick 三房全等、违例 0**（各房采样 280/291/291——含托管/放水/账本/快照外的全量 ents 确定性）。

### 3.3 重连三档（R1，体型/质量状态延续）——绿

| 档 | 复席 | 状态延续 | 断线期 | 账本 |
|---|---|---|---|---|
| 5s 全测 | resume=ok+welcome ✓ | tier 0→0 与 tierOf(M,前档) 滞回一致、M 24→26、kills 0→0、score=floor(M/4)+kills×40 恒成立、skin 恒同 | 席位鱼恒活 dead=0 | A8 残差 0 |
| 9.3s 窗内边缘 | resume=ok ✓ | tier 0→0、M 26→26、口径恒成立 | dead=0 | 残差 0 |
| 31s 逾窗 | **resume 正确拒绝**（409 resume-rejected——见 R1c） | 席位鱼 tier/M 延续（M 26→28 托管期成长）、score 6→7 | dead=0（bot 接管） | 残差 0 |

**R1c 逾窗语义纠偏（QA2 发现，协议面非缺陷）**：逾窗（>10s+1 拍宽限）`$reconnect` 返回 **409 resume-rejected**（托管转换后 token 已清——"复席语义不容降级为顶号"，rooms.js GAMES-63 口径），逾窗回归走 **bot 让位路径**。QA1 同档「重连夺回 ✓」系取**旧 welcome 的空洞绿**（断言未查 resume 回执，`wl=最后一条 welcome` 含建房欢迎——QA2 显式断言 r.json.ok 后暴露）。补针实证：逾窗后席位鱼恒活且托管觅食（M 22→24 dead=0）；让位回归机制由满编臂实证（§六：24 连接把 bots 全部让位、真人恒得席）。同房 12s 断线后 WS 再 join 的端到端夺回未在本预算内完成（quick 握手瞬态+测试房 WS 隔离两坑），披露为残余面——机制三证（拒绝回执/托管在场/让位满编）已闭合。

### 3.4 托管（H1，AFK 60s 门）——绿
- **托管门=afk.t≥600**（60s 输入签名不变，`st.afk` 簿记在线可读）；冻结前窗航向恒定（本人输入仍生效=0 自转）与托管窗自转 ≥2 次对照——代打生效判据。
- **托管期觅食在场**：casual 代打 eat×24（「回来看战果」语义；deaths 2→6 连败在案不缺鱼）。
- **输入即夺回**：新输入签名→afk 清零→航向 **516ms** 收敛至目标角（<2s 红线窗）。

## 四、放水链在线验证（W1/W2——BOT 决策级已证，在线链路复证）

- **W1 连败入靶在线可达**：真人席追大鱼送死自然达 L1（deaths≥2 ∧ kills==0）；入靶前降问台账 Σmd=0（md 仅放水路径递增——判据洁净度基线）。
- **W1 降问在线触发**：连败席入 360px 压制圈 → 猎手 Q2 整问停用——**md 台账递增**（主件 Δmd=1/4 采样×近距 4；mercy2 复跑 Δmd=1/18 采样×近距 13——md 仅放水路径递增，增量即证链路）。
- **W1 让力失误在线在场**：blunder ±70°+dash 熄灭（p=0.3/0.5）——**bl 台账递增**（主件 Δbl=3；comp/bal 席，casual 自带 per.blunder=0.12 不入判据）。
- **W2 AFK 收窄边界（在线）**：同席冻结输入 → afk.t≥600（实测 630）托管后，deaths 仍累积（连败在案 2→3、kills=0）但**逐席单调台账停增**（Δmd=0 Δbl=0，×近距 19/30 非空转）——与同房非托管期 md 递增对照，唯一门差=afk.t≥600。收窄判据在线生效（挂机席≠永久放水源——GAMES-166 修复的在线复证）。托管席代打觅食 eat×11、输入即夺回 256ms。
- 让位（生态位让食 120/200px）为 Q3 密度场方向屏蔽，在线可观测面弱（食圈归属无独立事件），维持 BOT 决策级证据+免猎/降问在线面，披露不另断言。

## 五、FEEL 后零漂移抽验（F1）——绿
- FEEL 提交（80e0708）**仅触 client.js+feel-check 测试件**（sim/brain 零改动）——结构面零漂移；api-check 54/0 复绿（§3.1）+ D1 指纹确定性（§3.2）为 sim 面旁证。
- 渲染面实测：quick 活局（FEEL 版页面自 :4399 生产 web 加载）帧成本 **avg=0.28ms p95=0.6ms n=140**（QA1 基线 0.21/0.3 同量级；16 项动效+16 槽音效在跑）；掉帧率 **0%**（红线 <2%）；**零 pageerror**。

## 六、长局 spot 8min+满编+观战（L1/Q6f）——绿

- **长局 8min（ts2=9849 tick，跨 7200 双轮界——QA1 5min 单界交叉引用）**：**round.n=3+crown×2**（双轮界）；A8 质量守恒全程残差 0+排行榜全程一致（非增+榜首 argmax，48 采样）；**吞噬生态 devour×156**（QA1 83@6000 tick 同量级偏上——seed 差异）。
- **O-1 收口（活鱼<20 的统计本性定案）**：min=17（与 QA1 同底——两 seed 皆 3 尾重叠重生窗为下界）、<20 采样 25/48、恢复时延实测 [306,1219,314,938,3092,1236]ms（≤3s 重生窗上界，1 例触界）。**身份式**：期望同时死亡数=devour率×重生窗=（156/9849）×30≈0.48 → 瞬时 P(≥1 死亡中)≈1−e^−0.48≈38%，实测 52%（n=48 内噪声带）——活鱼<20 占比是吞噬经济的**泊松必然**非供给塌陷（QA1 的 <20% 阈值线按低吞噬 seed 标定，属口径过紧非产品缺陷）。席位供给恒 20（实体不清退+A8 恒等）。
- **满编**：24 连接 play 全部就席（bots 全让位，humans≤24 实体红线恒守）；**第 25 连接 play→观战位承接**（role=spectator、mySeat=-1 不顶号不崩、快照流 aoi.r=460px+ext.lb 下行）；**显式 spectate join→spectator**（不占实体预算）。

## 七、退回清单与观察项

**退回清单：无（0 项）**——QA 只读，本轮零产品缺陷红线（§八假红为测试件口径）。

观察项编号接 QA1（O-1/O-2 已收口，O-3/O-4 维持处置）；本轮**新增 0 项**。

## 八、假红复盘与口径纠偏（测试件 3 处——工程留档）

1. **放水台账随重生清零**：md/bl 台账挂在 `fish.mem.ch`，bot 被吞重生重建 mem → 计数清零；Σ当前值在猎手死亡窗内可**下跌**（首跑托管窗 Δmd=-1 假红，负值与「停增」语义混淆）。修正口径=**逐席历史最大值（单调估计）**后同链路复跑定案（mercy2 件）。教训：递增型台账的窗口差分必须先排死亡重置路径。
2. **轮末 rollover 重置 deaths**：轮末加冕 kills 清零时 deaths 同步重置（逐轮统计口径）——ts3 下 150s 求死窗跨 3600 tick 轮界后 L1 检测读 deaths=0 假红（mercy2 首项；md 递增佐证链路实已触发）。教训：跨轮长窗断言轮换类统计字段先对 ROUND_TICKS 取模窗。
3. **QA1 重连 31s 档空洞绿**（§3.3 R1c）：断言取「最后一条 welcome」含建房欢迎且未查 resume 回执——逾窗实际 409 拒绝。QA2 显式断言回执后暴露并补三证闭合（拒绝回执/托管在场/让位满编）。教训：welcome 类断言必须与触发动作时序对齐（新建 welcome≠任意 welcome）。

另：snake-king 回归首跑 43/44（full20 中位 deaths 6/0/11>5 边界统计项）——首跑与 QA2 重臂共网关事件环（ts4×3+长局+放水房并发），空闲复跑结果见 §九；quick 握手瞬态无 welcome 重试即恢复（QA1 已知环境项）。

## 九、回归抽查与冻结验收

- 回归抽查 2 作（影子网关）：**snake-king 44/44**（首跑 43/44 共网关并发噪声，空闲复跑全绿——§八尾注；S6 首证）、**yi-pavilion 21/21**。
- 冻结验收命令（本单 DoD）：`node scripts/api-check.js deep-foodchain && test -f docs/qa/deep-foodchain-qa2.md` → **54/0 通过+报告在盘 exit 0**。

## 十、环境与复现

```bash
# 影子网关（:4399/:4400 零感知）
PORT=4424 GATEWAY_PID=/tmp/gw168.pid GATEWAY_LOG=/tmp/gw168.log node server/gateway/index.js &
# 冻结门禁（54 断言独立复跑）
GAMES_GW=http://127.0.0.1:4424 node scripts/api-check.js deep-foodchain
# QA2 四件（net≈9min 含 8min 长局 / web≈1min / full≈1min / mercy2≈6min；net 与 web/full 可并行）
node scripts/deep-foodchain-qa2-net.mjs && node scripts/deep-foodchain-qa2-web.mjs \
  && node scripts/deep-foodchain-qa2-full.mjs && node scripts/deep-foodchain-qa2-mercy2.mjs
```
