# 迷你MOBA QA二号（GAMES-132）· 联机红线专项（延迟/重连/满员·预算版）

> 2026-10-14 ｜ 分支 feature/GAMES-132 ｜ 基线 main@48b3873（GAMES-131 已合）
> 前序：QA1=docs/qa/mini-moba-qa1.md（GAMES-128）｜FIX1=GAMES-129｜BOT=GAMES-130｜FEEL=GAMES-131
> 环境：私有网关 :4416（私有口零感知 :4399/:4400）；剧本 `scripts/mini-moba-qa2-net.mjs`（D1/D2/D3/D4）+ `scripts/mini-moba-qa2-spec.mjs`（D3b 客户端观战冒烟）

## §1 D1 200ms 延迟对照（3+3 局）——S2 ext.ack 预测和解（技术看点）

方法：TCP 代理垫（chunk 级单向 100ms=RTT 200ms）×3 局 vs 直连 ×3 局；quick 真人 WS 入房（每局 bot 让位得席）；每 200ms 变向移动输入（预测误差可见）；12s 窗口。ack 滞后锚=ms 级（seq 发送墙钟→含该 ack 快照到达墙钟；tick=100ms 下 200ms RTT 仅 2 tick 分辨率，tick 级锚不可用——过程实录见草稿 Article）。

| 臂 | lagMean | lagMax | full 快照比 | 帧乱序 | ack 回跳/越界 | reject |
|---|---|---|---|---|---|---|
| delay（3 局） | 309ms（305-317） | 412ms | 25/670（3.7%） | 0 | 0/0 | 0 |
| direct（3 局） | 107ms（105-111） | 301ms | 6/673（0.9%） | 0 | 0/0 | 0 |

结论（对照 QA1 基线）：**7/7 绿**
- 延迟可观测且受控：delay 臂 ack 回显滞后 309ms vs direct 107ms（差≈RTT 200ms，区分度 3×；<600ms 帽）——预测窗（未确认输入积压=重放成本）有界。
- 协议正确性双臂零违例：ack 单调不越界、快照帧单调、零 reject/error（单 TCP 连接保序）。
- 二式快照不因延迟退化：full 比 delay 3.7% vs direct 0.9%（首局 21 张=入房全量重锚，后两局 2 张；<5% 帽）——FIX1 entView 成果在延迟下不回退成全量串。
- 服务端权威节奏不受延迟拖累：双臂 tick 前进 667/670（≈墙钟，100ms 档）。
- 与 QA1 基线（R3 ack 回显 ack≤sent、O1 带宽峰值 35.4→16.7KB/s）对齐：延迟面新增证据，无回退。

## §2 D2 断线重连三档 + GAMES-84 abandon 锚

| 档 | 结果 | 证据 |
|---|---|---|
| 5s 全测（test 房 API） | ✅ 6/6 | $disconnect→+5.2s 复席 gap=5207ms（10s 窗内凭 token）；全量重同步=welcome 重发 2+断点后 full 快照 1；会话恢复 gold=480；局续进 tick 83→312 phase=live |
| 10s 逾窗（各 1） | ✅ 3/3 | +10.6s 复席被拒 `resume-rejected（token/席位不符或已托管）`（窗口=10s+1拍，GAMES-63 口径）；托管接管局仍活 tick 426→476 |
| 30s 逾窗（真 WS） | ✅ 7/7 | 真人输入 ack 回显 13/14；观战位 role=spectator；断线 30s 托管续打 tick 438→746（旁观账本 308 张）；观战席语义 ack=-1/无 me 违例 0/308；逾窗回归 bot 让位复席 seat=5 得回+快照续流+gold=1215 全量恢复+tick 高于掉线时 |
| abandon 锚（GAMES-84 复验） | ✅ 4/4 | 独真人房在场 16s→掉线→+6s 房仍 live（锚=最后在场，判别性）→+15s 内 abandon 终局离场 |

## §3 D3 满员与旁观（协议 8/8 + 客户端冒烟 7/7）

- 6 真人 WS 满员（seats=5,4,3,2,1,0 互异）→ 第 7 人 spectate 入席观战（role=spectator+快照流）→ 第 8 人 play 撞满员兜底旁观（无可让 bot→role=spectator/seat 省略）。
- 真人进房 Bot 让位循环：D1 6 局 quick 入房均得席（bot 让位）+ D2 30s 档逾窗回归让位复席——两路径（入房让位/逾窗让位）均有证。
- **客户端观战体验冒烟（Playwright，QA1 未覆盖面）**：6 真人满员房上浏览器第 7 人入房→seat=-1 兜底旁观落地、ext.ack=-1、快照流渲染 ents>0、零页面错误；截图 /tmp/moba132-spec-shot.png 识图核验=地形/塔/圣所/HUD 比分计时在屏、无渲染异常、无报错弹层。
- 观察 O3（低）：观战模式仍渲染攻击/回城/买装操作钮与摇杆——导演 UI 未做属 DEV 已披露面，按钮对旁观席无效（服务端拒识），建议 FIX2 随导演镜头一并处理。

## §4 D4 长局 spot（交叉引用）+ feed 新鲜度两点

- 长局 5 分钟面按任务书交叉引用不重跑：QA1 S2 2400 tick（=4 分钟）账本复盘全绿（节拍 1.000/重建一致 extra=0/leave 归因含草丛）+ R3 30s 托管续打；FIX1 bot2-check A7-A9 端到端；BOT 确定性双跑；FEEL feel-check 15/15。本单 D1 各局 12s×6+D2c 30s+D2d 全程快照流连续无断裂，无新增异常面。
- feed 新鲜度 2 点（GET /api/matches）：点 1 满员房 humans=6/joinable=false/elapsed=35978ms → 点 2 Δelapsed=1613ms vs 墙钟 Δ1612ms（逐 ms 对齐）+spectators=2 实时反映；旁观察场 spectators 回 0 即时。✅ 3/3

## §5 红线与冻结门禁

- 本单四剧本自测：net 12 断言 + spec 7 断言全绿（首跑 2 红均为剧本口径缺陷已修：①D2a liveness 采样晚于超时裁定终局→改「tick 高于断点或 phase=ended」；②第 8 人 welcome 口径=role:'spectator'+seat 省略，非 seat:-1）。
- **冻结验收命令 `node scripts/api-check.js mini-moba` 首跑 21/1 红**：A3「能输：剧本败方终态达成（timeout）」——当日 seed 20261014 下 winner=A（期望 B）scores 2:6/5:1，剧本败方队反超致超时裁定翻转。复跑结果见 §5.1。api-check 用日期 seed（seed=20261014），GAMES-130/131 当日（20261013 前）跑 22/22——高度疑似**日期 seed 相关的 A3 剧本脆弱性**（casual 档 bot 战力翻转），非本单改动引入（本单单测剧本纯增量，零游戏/网关代码改动）。
- §5.1 复跑：**同红逐字节复现**（A3 winner=A scores 2:6/5:1 tick=7200 timeout 90734ms，报告 api-check-mini-moba-20261014043414.json）——日期 seed 确定性翻红，非抖动。A3 为单 seed 严格逐局断言（api-check.js:1282 lose 分支），seed 日期派生（20261013 当日绿/20261014 当日红）；本单分支零游戏/网关代码改动（diff 纯剧本+文档），红在 main@48b3873 同样可复现。冻结命令涉面不可自修，上报 PM 裁量（O4）。
- §5.2 **attempt 1 修复（GATE-FAIL 退回重做后）**：
  - **attempt 0 定性纠错**：seed 非「日期派生」——game.json `net.api.script.seed` 是 GAMES-127 建单时写死的字面量 `20261014`（git -L 追溯仅此一改），「明日自愈」预期不成立；红与跑测日期无关。
  - **根因（剧本组合与断言意图相悖）**：lose 剧本 `botLevels=[null, competitive×5]` 给挂机方配了 2 名 competitive 队友（席位 2/4 属 A 队）——「能输」实测成了「能被队友躺赢」：A 侧 2 bot 推塔占优（超时裁定第一序=己方水晶 HP%，推塔方胜），对位 3×competitive 只杀人不推塔（kills 6:1 仍输裁定）。私口 :4416 探针 5 组组合矩阵：凡挂机方有队友（2×comp/2×casual 配对位 3×comp 或 3×casual）→ 恒 A 胜（3/3 组合）；独席（无队友）→ 恒 B 胜（对位 3×comp 与 3×casual 各 1 组，各 3 跑逐字节一致：塔 2:0、零 core-down、B 靠超时裁定存塔分胜）。
  - **修复**（任务书纪律「可修单文件级」授权内）：`lose.botLevels` 改独席 `[null, competitive, null, competitive, null, competitive]`——与 net-tank（挂机方队友降档）/snake-king（独席对全场）的 lose 剧本房式一致，断言强度不降（同 seed、同单局严格胜负断言、expectWinner=B 不变）；assertions 文案与设计书 §6 镜像同步（含 idle 剧本叙事按 QA2 实测重写）。净改动 3 文件（game.json 2 行+设计书 3 处+本报告），零 sim/brain/网关/客户端代码。
  - **验证**：冻结命令两跑 **22/22 全绿 exit=0**（api-check-mini-moba-20261014051944/20261014052447.json）；bot2-check 9/9（零漂移——net.api.script 仅 api-check 消费，grep 证）。

## §6 观察项清单

| 编号 | 级别 | 项 | 处置 |
|---|---|---|---|
| O3 | 低 | 观战模式渲染玩家操作钮（导演 UI 未做，DEV 已披露） | 转 FIX2（导演镜头一并） |
| O4 | 中 | api-check A3 剧本组合缺陷（attempt 0 误定性为「日期 seed 脆弱性」，实为挂机方带 competitive 队友致「能输」反向被躺赢，见 §5.2） | **attempt 1 已修复**（lose 剧本改独席，冻结命令 22/22 双跑绿） |
| O5 | 中 | bot 推塔节奏：competitive 12 分钟对空场仅 2 塔、零 core-down，全部剧本局以超时裁定收局（设计 §6 预期 core-down tick 2400-5400 已放缓；且凡双方都有 bot 时 A 队（偶数席）结构性占优——5 组合探针 3 组队友在场全 A 胜） | 转 FIX2 候选（bot 击杀窗推塔权重/阵营均衡；涉 brain 调参与 bot2-check 逐字节基线重锚，非单文件级） |

## §7 环境事故披露

- 本单开工清场误用 `pkill -f gateway/index.js` 致生产 :4400 网关被一并终止（中断约 26s），已按原样 nohup 重启恢复（healthz ok、boot 自动补种大厅房）。:4399 全程零接触。教训已发草稿 Article 留档。
