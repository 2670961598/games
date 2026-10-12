# 极速卡丁 视觉统一（VIS）——HUD 字号迁移 · 色盲双编码 · 竞速可读性

> 状态：**生效**（2026-10-12，GAMES-115 单链 #8 落地）｜ 前置：hud-font-standard.md（GAMES-57
> 平台基准）、GAMES-113 手感层（motion 线量纲修正/相机前视带）、GAMES-111 FIX1 后的
> QA2 五项全绿基线（3e8e984）。
> 断言挂具：`scripts/speed-kart-vis-check.mjs`（22 项，DSF=1 截图落 kernel/workers/GAMES-115-shots）。

## 0. 范围与口径

- 本作 HUD 全部经 `HF(grp, key, px, w)` 落笔即登记（GAMES-109 DEV 起建，本单复核收口）：
  静态零裸字号（`g.font` 赋值全走 HF，字体字串构造点唯一）+ 运行时 `__GAMES_DEBUG__.hudFonts()`
  自证（P0≥13/600、P1≥11、P2≥9）。
- DOM 文本面仅 index.html boot 覆盖层一处（13px/600，达标 P0 读数位——hud-font-standard §2.3
  「大厅/DOM 同级套用」）。
- px 均指 375×667 逻辑画布坐标；识图截图 DSF=1 时逻辑 px 即截图 px。

## 1. HUD 字号登记表（本作全量，hudFonts() 运行时快照）

| 级 | 键=px(/600+) | 语义 |
|---|---|---|
| P0 | pos 13、lap 13、lapTime 13、ping 13、count 44/700、go 40/700、lapBan 15、settleTitle 20/700、settleRow 14 | 位次/圈数/本圈计时/ping 档/倒数大字/GO/圈速横幅/结算标题/名次行 |
| P1 | posOf 11、best 11、predOn 11、pingCard 11、pen 11/600、charge 11、draftHint 11、driftBtn 12/600、hashWarn 11/600、lost 12/600、err 11、dualT 11/600、dual 11、again 13/600 | 副标/预测态/详情卡/罚字/蓄力条/尾流/漂移钮/告警/结算对照/重开钮 |
| P2 | name 9、foot 9、back 10、boot 11 | 远车名签/页脚 slug·version/回大厅提示/连接中 |

裁量记录：
- **ping 归 P0（13/600）**：本作 ping 是 T7-A 延迟补偿卖点的入口读数（点击展开 RTT/抖动/和解
  修正卡），升 P0 处理（hud-font-standard §1 裁量记录中「若提升为战术信息则升 P0」条款的
  首个落地例）。
- **count 恒 44px+scale 脉冲**（GAMES-113）：动态 px 会把瞬时值写进注册表，逐键比对必红。
- **结算对照行 dual 11px**：数值主体（圈时文本）走 P0 同位行 settlement 行 14px，dual 仅
  条形图的文字标注，11px 达标 P1。

## 2. 色盲双编码校验表（色相+形状双通道）

车辆色系与弯道标记的 CIE 灰度（BT.601 luma）分析结论：本作 6 席位色中存在两对
**同亮度带**（Δluma<16）与一处**档位色同带**，色相通道单独不可依——形状通道为强制第二通道。

| 元素 | 色相通道 | 形状/位置通道（灰度可辨） | 实测 |
|---|---|---|---|
| 车辆席位色（6 色） | `#FFB65C/#5CD9E8/#3DDC84/#FFD166/#FF6B5C/#E8E8F0` | 车身腰部席位形状标：circle/tri/square/dia/cross/star（`drawShape`，反差取 +3 偏移色） | 同带对 ①`#FF6B5C~#3DDC84` Δ12（cross vs square）②`#5CD9E8~#FFB65C` Δ13（tri vs circle）互异 ✓ |
| 弯道色带（路缘石） | 内缘红 `#D94848` / 外缘白 `#E8E4DC`，14/14 虚线 | 内外缘**位置**通道 + Δluma=113（灰度下内外缘可分）；虚线同律防误读为实心墙 | Δ113 ✓（识图主锚=红白虚线，QA1 §识图口径沿用） |
| neon 轨道变体 | 内青 `#5CD9E8` / 外品红 `#E86BC9` | 青品红对蓝黄轴安全（protan/deutan 下互辨），Δluma=26 | Δ26 ✓ |
| ping 档位（T7-A） | 绿 `#3DDC84`(≤80ms)/琥珀 `#FFD166`(≤160ms)/红 `#FF8A65`(>160ms) | **信号条形码 3/2/1 实条**（4px 宽、4/7/10px 高，空条 0.22 alpha）——绿/红档灰度 162/169 **Δ7 同带不可辨**，条数可数即档位 | 三档注入探针 3/2/1 ✓ |
| 我席 | — | 白圈描边（minimap 白圈+世界层 shape 白色），seat 判据色盲无关 | 白圈 px 探针 ✓ |
| 起跑线标记 | —（原金方与车位点同族） | **7×7 黑白格旗标**（`#E8ECF3`/`#2A2438` 2×2 象限，顶层绘制）——通用起跑符号，Δluma≈180 | 光 19px/暗 18px 象限可数 ✓ |
| 名次变动（F05） | 升绿 `#3DDC84`/降橙红 `#FF8A65` | pop 缩放 1+0.4·pop（动效通道）+位次数字本身 | FE-2 台账 ✓ |

复核方法：`speed-kart-vis-check.mjs` V-CB-1/2/3 组（visInfo() 契约暴露色表/形状表/档位表，
三档注入逐档像素探针）；灰度截图复核沿用 hud-font-standard §3 口径（DSF=1 截图逐元素
核对形状差异可辨，素材 kernel/workers/GAMES-115-shots/g115-*.png）。

## 3. 竞速可读性（速度感/小地图/结算对照）

| 项 | 现状（本单复核/精化） | 断言 |
|---|---|---|
| motion 速度线 | GAMES-113 量纲修正后激活（v≥120px/s，v=milli-px/tick÷50）；boost 爆密 +3、倾斜∝滑角；纵向带 y<560 裁剪避让识图锚区 | V-RD-1（motion.on=1 + F10 台账） |
| FOV 代理（相机速度带） | zoom 1.00→0.84 随 vK=v/16500（视野外扩=速度感）；前视 56→100px 同带外扩 | V-RD-2（巡航 zoom∈[0.84,0.97)） |
| 小地图 | Ø96 整圈走线环 + 6 车位彩点 + 我席白圈 + 黑白格起跑旗标（本单：4×4 金方→旗标，顶层防点阵遮挡） | V-RD-3a/3b |
| 结算 T7-A 对照条 | 本单精化：固定 60s 归一→**逐圈行内归一**（当圈较慢者=满条 88px；45s 圈速下原式条长不足 75%、<1s 链路差压成 <1.5px 不可辨）+ 零基线柱 + 条尾亮端标（本地青 `#5CD9E8`/判定灰 `#8B93A7`，端标 `#7FE8D8`/`#E8ECF3`）——色弱下条尾位置即读数 | V-RD-4a/4b |
| ping 徽标 | P0 13/600 + 信号条形码（见 §2）+ 详情卡（RTT 中位/抖动/和解修正 10s 窗/单次均值 px） | V-CB-3a/3b |

## 4. 识图 v2 复检扩容（22 项 ≥15）

挂具 `scripts/speed-kart-vis-check.mjs`（蛇王 GAMES-105 / 本作 FE-4 同范式：?debug=1 离线
竞技场 + pauseViz 冻结帧 + 不透明字形锚点 + 墨水带像素直读 + DPR=1 截图）：

- **三帧**：home=倒数窗中段（P0.count 在册）/ play=巡航（motion+zoom 速度带在位）/ settle=
  `fxScene('settle')` 合成完赛态（仅显示态，不触网不写圈账本）。
- **字形锚点**（不透明字形内部位，世界层经半透明底透出不影响）：lap/best/ping/charge/
  driftBtn/foot 六位 + settle 帧 title/row/dualT/again 四位；ping 锚位在 ping=0 同文状态下
  复核（注入档位后文本变宽会平移，属预期非漂移）。
- 分组：V-HUD-1(3)/V-HUD-2(2)/V-CB(6)/V-RD(6)/V-SHOT(3)/V-PERF(1)/V-REG(1)。
- V-PERF 口径：≥同挂具 FEEL 基线 12fps（本机软件渲染环境绝对红线 ≥55 改前即红，
  FE-5 同注记）；绝对值达标须硬件加速环境复跑。

## 5. 留痕

- 改动面：`games/multiplayer/speed-kart/client.js`（渲染层四处 + debug 钩子）+
  `scripts/speed-kart-vis-check.mjs`（新）+ 本文档。**sim 零改动**（shared.cjs/tracks.cjs/
  trig16.cjs 未触碰，api-check 32/0 复绿旁证）。
- 前置阅读：docs/hud-font-standard.md、docs/qa/speed-kart-qa1.md §识图口径。
