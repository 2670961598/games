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

## §6 观察项清单

| 编号 | 级别 | 项 | 处置 |
|---|---|---|---|
| O3 | 低 | 观战模式渲染玩家操作钮（导演 UI 未做，DEV 已披露） | 转 FIX2（导演镜头一并） |
| O4 | 中 | api-check A3 日期 seed 脆弱性（20261014 翻红，见 §5） | 上报 PM 裁量（冻结命令涉面不可自修）；候选修法=A3 剧本固定 seed 或败方终态判据改绝对分差 |

## §7 环境事故披露

- 本单开工清场误用 `pkill -f gateway/index.js` 致生产 :4400 网关被一并终止（中断约 26s），已按原样 nohup 重启恢复（healthz ok、boot 自动补种大厅房）。:4399 全程零接触。教训已发草稿 Article 留档。
