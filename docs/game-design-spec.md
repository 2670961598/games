# GAMES 批量生产设计规范 —— 游戏类型 × 关卡 × 数值档位

> specVersion: 1.1.0 ｜ 单据: GAMES-7（v1.0.0）/ GAMES-13（v1.1.0 附录） ｜ 父 Epic: GAMES-1 ｜ 轨道: L2
> 适用对象：`games/<type>/<slug>/` 下全部游戏（目标 100+，每类型 ≥5 款）。
> 本文档是类型清单、game.json schema、数值档位、难度曲线的唯一事实源；与实现冲突时以本文为准，修订须开新需求单（升 specVersion）。
> **平台线例外（GAMES-13 仲裁）**：scan 扫描 / 上传管线按 §32 仲裁附录的"实况为准 + 最小收口"口径执行；本文 §2.1 全量严口径是生产线投产 DoD，不作为平台扫描门槛。

## 1. 总则

1. **生产模型**：类型（§7–§30，共 24 类）× 数值档位（§3 五档）= 产品款型。每个类型至少投产 5 款 = 五档各 1 款；差异只体现在 game.json 的 `tier` 与 `typeExtra` 数值，同类型 HTML 引擎共享一套实现。
2. **确定性铁律**：关卡布局、掉落序列、敌波生成一律由 `seed = fnv1a32(slug + "#" + level)` 驱动的 PRNG（mulberry32）产生（§5.6）。禁止用 `Math.random()` 生成任何影响胜负判定的内容；QA 复测与玩家进度必须可复现。装饰动画不受此限。
3. **计分可复算**：所有计分公式是事件序列的确定性函数，逐类型在本文给出；实现不得引入本文未列出的随机加减分。
4. **单手竖屏**：一切交互在 375×667 逻辑分辨率下可单拇指完成（§5.4 词表 + §5.5 安全区）。
5. **本规范的数值均为 normal 档基准**，其余档位按 §3.1 乘子换算后取整落值到各类型档位表。

## 2. game.json 全字段总表

### 2.1 公共字段（所有类型必备，键名冻结）

| 字段 | 类型 | 必填 | 约束 | 示例 |
|---|---|---|---|---|
| slug | string | 是 | 全站唯一 `^[a-z0-9-]{3,40}$`，格式 `<type>-<词根>-<2位序号>` | `stacker-calm-01` |
| title | string | 是 | ≤12 个中文字符 | `静心叠塔 01` |
| type | string | 是 | 必须是 §7–§30 类型清单之一（slug 列） | `stacker` |
| tier | string | 是 | `relaxed\|simple\|normal\|hard\|master` 五枚举之一 | `normal` |
| levels | int | 是 | 10–120；各类型缺省值见类型节 | `30` |
| specVersion | string | 是 | 本规范版本，当前 `1.1.0` | `1.1.0` |
| version | string | 是 | 游戏自身 semver | `1.0.0` |
| orientation | string | 是 | 固定 `portrait` | `portrait` |
| entry | string | 是 | 固定 `index.html` | `index.html` |
| controls | object | 是 | `{primary, secondary}`，取值限 §5.4 词表 | `{"primary":"tap"}` |
| avgDurationSec | int | 是 | 45–600，信息流排序参考 | `150` |
| scoring | object | 是 | `{win, lose, s2, s3}`，公式字符串，逐类型节 | 见 §7 |
| assets | object | 否 | `{thumb}` 内联 data: 缩略图 | — |

### 2.2 类型扩展字段（typeExtra）

- 类型特有参数一律放 `typeExtra` 对象内；字段名、默认值以各类型节的 schema 表为准。
- 公共字段不得删除、改名，`typeExtra` 内禁止与公共字段同名（校验器报错）。
- 引擎读取顺序：公共字段 → `typeExtra` → 类型节默认值；任何缺省必须落到类型节标注的默认值。
- 新增公共字段或改键名 = 破坏性变更：specVersion 升主版本，走 YouTrack 提案单。

### 2.3 最小合法示例

```json
{
  "slug": "stacker-calm-01",
  "title": "静心叠塔 01",
  "type": "stacker",
  "tier": "relaxed",
  "levels": 30,
  "specVersion": "1.0.0",
  "version": "1.0.0",
  "orientation": "portrait",
  "entry": "index.html",
  "controls": { "primary": "tap" },
  "avgDurationSec": 150,
  "scoring": { "win": "towerHeight >= target(L)", "lose": "miss >= missMax", "s2": "score >= 1.2*target(L)", "s3": "score >= 1.5*target(L)" },
  "typeExtra": { "blockW0": 220, "swingK": 0.045, "trimMin": 12, "missMax": 5, "targetBase": 18 }
}
```

## 3. 数值档位体系（五档）

五档承担两个职责：① 同类型多款产品的差异轴（每类型 ≥5 款即五档各 1 款）；② 玩家进入游戏后的自选难度。档位只作用于曲线参数的 base 与上下界，不改变公式形态。

### 3.1 全局基准乘子（作用于 normal 基准值）

| 档位 key | 中文名 | 威胁类× | 资源类× | 目标类× | 设计意图 |
|---|---|---|---|---|---|
| relaxed | 轻松 | 0.70 | 1.40 | 0.75 | 解压向，几乎不会失败 |
| simple | 简单 | 0.85 | 1.20 | 0.90 | 休闲玩家主力款 |
| normal | 标准 | 1.00 | 1.00 | 1.00 | 基准款，曲线公式以此为基 |
| hard | 困难 | 1.25 | 0.85 | 1.20 | 核心玩家 |
| master | 大师 | 1.50 | 0.70 | 1.45 | 挑战向，失败是常态 |

- 威胁类 = 敌速/密度/弹速/混淆率等；资源类 = 时限/板宽/生命/容错等；目标类 = 目标分/目标数/波数等。
- 取整规则：速度类保留 2 位小数；计数类四舍五入取整；时间类取整到秒；概率类保留 3 位小数。
- 各类型节的档位表是乘子**具体化后的落值**，允许因取整与 ±10% 偏差；**档位表落值优先于乘子表**。

### 3.2 星级与解锁（全类型统一）

- 通关 = 1★；`score ≥ s2` = 2★；`score ≥ s3` = 3★。s2/s3 默认 = 1.2×/1.5× 当关目标量（类型节可覆盖并写明公式）。
- 关卡顺序解锁：通关 L 才解锁 L+1；星级写入 `progress.stars[L-1]`，只升不降。
- 失败不掉星、不扣已解锁进度（崩溃恢复友好）。

## 4. 难度曲线标准公式

### 4.1 三种标准形态（L ∈ [1, levels]，记 Ln = levels）

| 形态 | 公式 | 适用 |
|---|---|---|
| 线性 | `V(L) = base × (1 + k × (L−1)/(Ln−1))` | 威胁类默认 |
| 幂 | `V(L) = base × (L/Ln)^p` | 需要前期平缓后期陡升 |
| 分段 | 前 ⌈0.2·Ln⌉ 关教学平台 0.6×base；中段线性斜率 k；末 ⌈0.1·Ln⌉ 关收敛于 `cap = base × capMul` | Ln ≥ 40 的长线游戏 |

### 4.2 资源型参数反向

时限、隙高、板宽、容错等"越大约容易"的参数：`V(L) = max(floor, base × (1 − k × (L−1)/(Ln−1)))`。floor 必须在类型节显式给出，禁止无下限衰减。

### 4.3 档位与曲线的复合

先换算 `base_tier = base_normal × mul(tier)`，再代入曲线公式。档位不改变 k / p / floor 的相对形态（类型节特别标注的除外）。

### 4.4 seed 与 PRNG

- `seed = fnv1a32(slug + "#" + level)`；PRNG 用 mulberry32（参考实现 §5.6），每关重置一次。
- 同 slug 同 level 的关卡布局在任何机器上完全一致（QA 冻结复测的前提）。

## 5. 游戏 HTML 技术约束

### 5.1 自包含与性能

- 单文件 `index.html`，UTF-8；JS/CSS 全内联；图形用 canvas 矢量绘制或内联 data:；音频用 WebAudio 程序合成或 data:。
- **禁止任何外部网络请求**（无 CDN / 外链字体 / 外链图片 / 统计脚本）；离线可玩。单文件体积软上限 200KB。
- 渲染：单 canvas + 单 rAF 主循环；逻辑分辨率 375×667，按 devicePixelRatio 缩放；目标 60fps、单帧预算 ≤8ms。

### 5.2 localStorage 进度 key 规范（键名冻结）

| key | 内容 | 写入时机 |
|---|---|---|
| `games:<slug>:progress` | `{unlocked:int≥1, best:int, stars:int[], updated:number}` | 通关/星级提升时 |
| `games:<slug>:settings` | `{sound:boolean}` | 玩家切换时 |
| `games:<slug>:telemetry` | 兜底埋点环形数组（≤50 条） | 宿主钩子缺失时 |

- 游戏禁止写平台级 key（`games:profile:*` 归宿主所有）。
- 写入节流 ≤1 次/秒；`visibilitychange` / `beforeunload` 时 flush；损坏 JSON 静默重置为初始值（崩溃恢复优先，不弹错）。

### 5.3 时长上报钩子约定

游戏启动时探测宿主注入，未注入则 no-op 并落 telemetry 兜底：

```js
const hook = window.__GAMES_HOOK__;
hook?.report?.(event, payload);
```

事件词表（冻结，宿主与游戏共同遵守）：

| event | payload | 触发时机 |
|---|---|---|
| `boot` | `{slug, version, specVersion}` | 引擎初始化完成 |
| `start` | `{level}` | 每关开始 |
| `levelEnd` | `{level, win:boolean, score:number, stars:number, durMs:number}` | 每关结束 |
| `end` | `{reason:"quit"\|"allClear", totalScore:number, durMs:number}` | 退出会话 / 全部通关 |

时长统计由平台侧对 `start`/`levelEnd` 聚合得出，游戏不自算会话时长。

### 5.4 单手交互词表（controls 取值冻结）

词表：`tap`（任意处点按）｜`tap-zone`（分屏区点按）｜`swipe-lr`（左右滑）｜`swipe-any`（任意方向滑）｜`drag`（拖拽跟随）｜`hold`（长按）。

- 每类型节"竖屏单手映射"必须且只能落在该词表内；双指、横屏、键盘方案一律禁止。
- canvas 设 `touch-action:none`；禁用双击缩放与长按系统菜单；统一 pointer events（pointerdown/move/up）。

### 5.5 安全区与可达性

- 操作热区 ≥44×44px；主操作集中在屏幕下 2/3（拇指区）；顶部仅放状态（分/命/时间）。
- 适配 `safe-area-inset`；最小 375×667，更大屏幕等比放大画布居中。

### 5.6 PRNG 参考实现（全引擎统一）

```js
function fnv1a32(s){let h=0x811c9dc5;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,0x01000193)>>>0;}return h>>>0;}
function mulberry32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;}}
const seed = fnv1a32(`${slug}#${level}`);   // "stacker-calm-01#7"
const rng = mulberry32(seed);
```

## 6. 类型清单索引（速查）

| 节 | 类型名 | type slug | 主交互 | 缺省 levels | 判定核心 |
|---|---|---|---|---|---|
| §7 | 狂点爆发 | `tap-burst` | tap | 30 | 时限内点够目标数 |
| §8 | 飞翔跳跃 | `tap-jump` | tap | 40 | 过障计数，碰撞即败 |
| §9 | 车道跑酷 | `lane-runner` | swipe-lr | 40 | 距离/固定终点，撞障耗命 |
| §10 | 叠塔 | `stacker` | tap | 30 | 塔高达标，脱出即耗失误 |
| §11 | 三消 | `match3` | swipe-any | 50 | 步数内达目标分 |
| §12 | 滑动合并 | `slide-merge` | swipe-any | 25 | 合成目标数字块 |
| §13 | 贪吃蛇 | `snake` | swipe-any | 30 | 吃够目标长度，撞墙/身即败 |
| §14 | 弹珠打砖 | `breakout` | drag | 40 | 清空砖阵 |
| §15 | 挡板生存 | `paddle-pong` | drag | 30 | 接球时长/球不落地 |
| §16 | 弹幕射击 | `bullet-shmup` | drag | 30 | 清波次，中弹耗命 |
| §17 | 弹雨躲避 | `bullet-dodge` | drag | 30 | 存活到目标时间 |
| §18 | 接落物 | `drop-catcher` | drag | 40 | 接够目标好物 |
| §19 | 打地鼠 | `mole-whack` | tap | 30 | 限内打够目标数 |
| §20 | 翻牌配对 | `memory-flip` | tap | 24 | 误试上限内配平全部 |
| §21 | 序列记忆 | `simon-sequence` | tap | 20 | 复述长度达标 |
| §22 | 颜色反应 | `color-reaction` | tap-zone | 30 | 轮次限时正确率 |
| §23 | 划切水果 | `fruit-slice` | swipe-any | 40 | 切够目标分，漏/炸弹耗容错 |
| §24 | 水排序 | `water-sort` | tap | 40 | 步数上限内分色归位 |
| §25 | 方块下落 | `block-drop` | swipe-any | 30 | 消行达标，堆顶即败 |
| §26 | 块填充 | `block-fit` | drag | 30 | 放置消格达目标分 |
| §27 | 珠链消除 | `chain-shot` | tap | 30 | 清空珠链 |
| §28 | 迷宫冲刺 | `maze-dash` | swipe-any | 30 | 限时到达出口 |
| §29 | 简化塔防 | `mini-td` | tap | 30 | 守住 N 波，漏怪耗命 |
| §30 | 节奏点击 | `rhythm-tap` | tap-zone | 30 | 谱面达成率 |

## 7. 狂点爆发（tap-burst）

限时内在屏幕上随机冒出的目标圆点上尽快点够目标数。纯反应/手速类，节奏 30–60 秒一关。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| targetBase | int | 20 | 每关目标有效点击数（目标类），线性 k=0.10 |
| timeSec | int | 20 | 每关时限（资源类），反向 k=0.15，floor=10 |
| sizePx | int | 72 | 目标圆点直径 px（资源类），反向 k=0.10，floor=48 |
| spawnPerSec | float | 1.6 | 目标出现速率（威胁类），k=0.20 |
| decoyRate | float | 0.08 | 陷阱（红色叉点）出现占比（威胁类），k=0.10 |

**难度曲线**（Ln = levels）
- `target(L) = ceil(targetBase × (1 + 0.10×(L−1)/(Ln−1)))`
- `time(L) = max(10, round(timeSec × (1 − 0.15×(L−1)/(Ln−1))))`
- `size(L) = max(48, round(sizePx × (1 − 0.10×(L−1)/(Ln−1))))`

**数值档位**（五档落值）

| 档位 | targetBase | timeSec | sizePx | spawnPerSec | decoyRate |
|---|---|---|---|---|---|
| 轻松 relaxed | 15 | 28 | 100 | 1.10 | 0.06 |
| 简单 simple | 17 | 24 | 86 | 1.40 | 0.07 |
| 标准 normal | 20 | 20 | 72 | 1.60 | 0.08 |
| 困难 hard | 25 | 17 | 61 | 2.00 | 0.10 |
| 大师 master | 30 | 14 | 50 | 2.40 | 0.12 |

**关卡生成规则**：目标出现位置由 seed 决定（均匀分布于中央 90% 屏区，两两不重叠）；程序生成，无手工关。

**通关/失败与计分**：时限内有效点击 ≥ target(L) 即通关；时限到未达标即失败。`score = 有效点击×10 + 最大连击×5 − 陷阱点击×15`（下限 0）。s2 = target(L)×12，s3 = target(L)×15。

**竖屏单手映射**：controls `{primary:"tap"}`；全屏任意点按，点即反馈；顶部状态条显示进度 target/计数与倒计时。

## 8. 飞翔跳跃（tap-jump）

单指点按让小鸟上浮，穿过间隙递减的管道序列。碰撞即败、瞬时重开是核心体验。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| gravity | int | 1800 | 重力 px/s²（威胁类），k=0 |
| tapImpulse | int | -520 | 点按冲量 px/s，与 gravity 同乘子换算保持弹道手感 |
| pipeSpeed | int | 160 | 管道左移速度（威胁类），k=0.30 |
| gapPx | int | 175 | 管道间隙高 px（资源类），反向 k=0.25，floor=120 |
| pipeInterval | int | 260 | 管道水平间距 px（资源类），反向 k=0.15，floor=200 |

**难度曲线**
- `gap(L) = max(120, round(gapPx × (1 − 0.25×(L−1)/(Ln−1))))`
- `speed(L) = pipeSpeed × (1 + 0.30×(L−1)/(Ln−1))`
- 当关目标过障数 `target(L) = ceil(5 + 20×(L−1)/(Ln−1))`

**数值档位**

| 档位 | gravity | tapImpulse | pipeSpeed | gapPx | pipeInterval |
|---|---|---|---|---|---|
| 轻松 relaxed | 1260 | -364 | 112 | 245 | 300 |
| 简单 simple | 1530 | -442 | 136 | 210 | 280 |
| 标准 normal | 1800 | -520 | 160 | 175 | 260 |
| 困难 hard | 2250 | -650 | 200 | 149 | 240 |
| 大师 master | 2700 | -780 | 240 | 123 | 220 |

**关卡生成规则**：管道缺口垂直位置由 seed 生成，相邻缺口中心位移 ≤ 180px（保证理论可达）；gap 随关内进度再线性收窄 8%（关内微曲线）。

**通关/失败与计分**：过障数达到 target(L) 即通关；触管/触地即失败（本关重来，lives=1）。`score = 过障数×10`。s2 = target(L)×12，s3 = target(L)×15（即 20%/50% 超额过障）。

**竖屏单手映射**：controls `{primary:"tap"}`；全屏点按跳跃；状态条在顶部，死亡即显重开热区（下 1/3 居中大按钮）。

## 9. 车道跑酷（lane-runner）

三条纵向车道，左右滑换道、上滑跳跃躲避障碍，跑到终点线即胜。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| speed | int | 300 | 前进速度 px/s（威胁类），k=0.35 |
| obsRate | float | 0.30 | 每车道分段出障率（威胁类），k=0.25，cap=0.50 |
| hearts | int | 3 | 可承受碰撞次数（资源类） |
| coinRate | float | 0.10 | 金币出现率 |
| distanceBase | int | 2000 | 关卡长度 px（目标类），k=0.50 |

**难度曲线**
- `speed(L) = speed × (1 + 0.35×(L−1)/(Ln−1))`
- `obsRate(L) = min(0.50, obsRate × (1 + 0.25×(L−1)/(Ln−1)))`
- `distance(L) = round(distanceBase × (1 + 0.50×(L−1)/(Ln−1)))`

**数值档位**

| 档位 | speed | obsRate | hearts | distanceBase |
|---|---|---|---|---|
| 轻松 relaxed | 210 | 0.21 | 5 | 1800 |
| 简单 simple | 255 | 0.26 | 4 | 1900 |
| 标准 normal | 300 | 0.30 | 3 | 2000 |
| 困难 hard | 375 | 0.38 | 2 | 2500 |
| 大师 master | 450 | 0.45 | 1 | 2900 |

**关卡生成规则**：车道按 120px 分段，由 seed 逐段掷点决定障碍/金币；约束：任一横截面至少留 1 条空车道（可达性），连续障碍段 ≤3。

**通关/失败与计分**：抵达终点即通关；hearts 耗尽即失败。`score = 金币×20 + 剩余hearts×50`。金币目标 `coinTarget(L) = ceil(15×(1 + 0.40×(L−1)/(Ln−1)))`，s2 = coinTarget(L)×24，s3 = coinTarget(L)×30。

**竖屏单手映射**：controls `{primary:"swipe-lr", secondary:"swipe-any"}`；左右滑换道，上滑跳（下滚滑铲可选实现）；角色固定屏高 70% 处。

## 10. 叠塔（stacker）

方块左右摆动，点按落块，逐层上叠；未对齐部分被裁掉，块越叠越窄，脱靶耗失误次数。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| blockW0 | int | 220 | 首层块宽 px（资源类） |
| swingBase | int | 160 | 摆动线速度 px/s（威胁类），k=0.80 |
| swingK | float | 0.80 | 摆速关内增幅（线性斜率） |
| trimMin | int | 12 | 每次错位最小裁切 px（防病态细条） |
| missMax | int | 5 | 失误上限（资源类） |
| targetBase | int | 18 | 目标塔高层数（目标类），k=0.10 |

**难度曲线**
- `swing(L) = swingBase × (1 + swingK×(L−1)/(Ln−1))`
- `target(L) = ceil(targetBase × (1 + 0.10×(L−1)/(Ln−1)))`
- 关内微曲线：每 5 层摆速 +6%（层数子进度）。

**数值档位**

| 档位 | blockW0 | swingBase | missMax | targetBase |
|---|---|---|---|---|
| 轻松 relaxed | 300 | 112 | 7 | 14 |
| 简单 simple | 260 | 136 | 6 | 16 |
| 标准 normal | 220 | 160 | 5 | 18 |
| 困难 hard | 187 | 200 | 4 | 23 |
| 大师 master | 154 | 240 | 3 | 26 |

**关卡生成规则**：摆动起始方向由 seed 决定；无手工关；完美重叠（≥90% 宽）不裁切并回涨 4px（奖励宽度，cap=blockW0）。

**通关/失败与计分**：塔高达到 target(L) 即通关；块宽 < trimMin 或 missMax 耗尽即失败。`score = 层数×10 + 完美层×15`。s2 = target(L)×12，s3 = target(L)×15。

**竖屏单手映射**：controls `{primary:"tap"}`；全屏点按即落块；镜头随塔顶上移，落点判定区在屏幕中带。

## 11. 三消（match3）

8×8 方格，滑动交换相邻元素，≥3 同色横竖连即消除，限定步数内冲目标分。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| gridN | int | 8 | 棋盘边格数（固定 8，不随档位变） |
| colors | int | 5 | 颜色/元素种数（威胁类） |
| movesBase | int | 25 | 每关步数（资源类），反向 k=0.10，floor=12 |
| targetScore | int | 2000 | 目标分（目标类），k=0.15 |
| blockerRate | float | 0.05 | 冰块/障碍格占比（威胁类） |
| cascadeCap | int | 5 | 连锁 cascade 上限（防死循环） |

**难度曲线**
- `target(L) = ceil(targetScore × (1 + 0.15×(L−1)/(Ln−1)))`
- `moves(L) = max(12, round(movesBase × (1 − 0.10×(L−1)/(Ln−1))))`
- `blocker(L) = min(0.15, blockerRate × (1 + 0.3×(L−1)/(Ln−1)))`

**数值档位**

| 档位 | colors | movesBase | targetScore | blockerRate |
|---|---|---|---|---|
| 轻松 relaxed | 4 | 35 | 1500 | 0 |
| 简单 simple | 5 | 30 | 1800 | 0 |
| 标准 normal | 5 | 25 | 2000 | 0.05 |
| 困难 hard | 6 | 21 | 2400 | 0.10 |
| 大师 master | 7 | 17 | 2900 | 0.15 |

**关卡生成规则**：初始盘面由 seed 生成，硬约束：①无现成 ≥3 连；②至少存在 1 步可消除换位（否则重掷）；消除后上方下落补位由 seed 序列补给。4 连出条纹（清行/列）、L/T 型 5 连出炸弹（3×3）。

**通关/失败与计分**：步数耗尽前 score ≥ target(L) 即通关；步数耗尽未达标即失败。`score = 消除块数×10 + 条纹触发×50 + 炸弹触发×100`，连锁段内每级 ×1.5（cascade 倍率，cap=cascadeCap 级）。s2 = target(L)×1.2，s3 = target(L)×1.5。

**竖屏单手映射**：controls `{primary:"swipe-any"}`；滑动方向即交换方向（优于点选两点）；棋盘占屏宽 94%，顶部目标分进度条。

## 12. 滑动合并（slide-merge）

2048 式：四方向滑动，同数字块碰撞合并，合成当关目标数字块即胜。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| gridLen | int | 4 | 棋盘边长（资源类：4 或 5） |
| targetCap | int | 1024 | 档位目标块面值（目标类） |
| spawn4Rate | float | 0.10 | 新块出 4 的概率（威胁类） |
| rescue | int | 3 | 死局自动重洗次数（资源类） |

**难度曲线**
- 当关目标 `target(L) = min(targetCap, 64 × 2^floor((L−1)/5))`（每 5 关翻倍，封顶档位 targetCap）。
- 关内威胁不变（经典 2048 内生难度随盘面增长）。

**数值档位**

| 档位 | gridLen | targetCap | spawn4Rate | rescue |
|---|---|---|---|---|
| 轻松 relaxed | 5 | 256 | 0.05 | 5 |
| 简单 simple | 5 | 512 | 0.08 | 4 |
| 标准 normal | 4 | 1024 | 0.10 | 3 |
| 困难 hard | 4 | 2048 | 0.14 | 2 |
| 大师 master | 4 | 4096 | 0.18 | 1 |

**关卡生成规则**：初始两块（2 或 4，按 spawn4Rate 掷 seed）；后续每次有效滑动补 1 块，位置由 seed 置于空格均匀分布。

**通关/失败与计分**：盘面出现 ≥ target(L) 的块即通关；无可合并且 rescue 耗尽即失败。`score = Σ每次合成产生块的面值`。s2 = target(L)×2，s3 = target(L)×3。

**竖屏单手映射**：controls `{primary:"swipe-any"}`；四方向滑动手势判定（位移 ≥24px 定向）；棋盘居中占屏宽 92%。

## 13. 贪吃蛇（snake）

网格贪吃蛇，吃食物长身体，达到目标长度即胜；撞墙（或穿墙，按档位）撞身即败。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| speed | float | 6.0 | 移动格数/秒（威胁类），k=0.40 |
| targetLenBase | int | 15 | 目标身体长度（目标类），k=0.10 |
| obstacleBase | int | 8 | 场内石块数（威胁类），k=0.30 |
| wall | string | "wrap" | `wrap` 穿墙 / `solid` 撞墙即败 |

**难度曲线**
- `speed(L) = speed × (1 + 0.40×(L−1)/(Ln−1))`
- `targetLen(L) = ceil(targetLenBase × (1 + 0.10×(L−1)/(Ln−1)))`
- `obstacle(L) = round(obstacleBase × (1 + 0.30×(L−1)/(Ln−1)))`

**数值档位**

| 档位 | speed | targetLenBase | obstacleBase | wall |
|---|---|---|---|---|
| 轻松 relaxed | 4.2 | 11 | 4 | wrap |
| 简单 simple | 5.1 | 13 | 6 | wrap |
| 标准 normal | 6.0 | 15 | 8 | wrap |
| 困难 hard | 7.5 | 19 | 10 | solid |
| 大师 master | 9.0 | 22 | 12 | solid |

**关卡生成规则**：20×20 网格；食物与石块位置由 seed 生成，硬约束：食物不落在蛇身/石块 2 格邻域内，石块不封死任一象限（连通性检测）。

**通关/失败与计分**：长度达到 targetLen(L) 即通关；撞身/撞墙（solid）即失败。`score = 食物×20 + 通关奖励100`。s2 = 24×targetLen(L)，s3 = 30×targetLen(L)。

**竖屏单手映射**：controls `{primary:"swipe-any"}`；四方向滑动转向（不允许直接反向）；棋盘居中，顶部显示长度/目标。

## 14. 弹珠打砖（breakout）

底部拖板反弹弹珠清砖阵，清空即胜；弹珠落尽即败。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| ballSpeed | int | 260 | 弹珠速度 px/s（威胁类），k=0.40 |
| paddleW | int | 90 | 板宽 px（资源类），反向 k=0.20，floor=60 |
| rowsCap | int | 8 | 砖行数上限（威胁类） |
| brickHP | int | 1 | 砖耐久（威胁类：1 或 2） |
| balls | int | 3 | 弹珠数（资源类） |

**难度曲线**
- `rows(L) = min(rowsCap, 4 + floor(4×(L−1)/(Ln−1)))`
- `speed(L) = ballSpeed × (1 + 0.40×(L−1)/(Ln−1))`
- `paddle(L) = max(60, round(paddleW × (1 − 0.20×(L−1)/(Ln−1))))`

**数值档位**

| 档位 | ballSpeed | paddleW | rowsCap | brickHP | balls |
|---|---|---|---|---|---|
| 轻松 relaxed | 182 | 126 | 6 | 1 | 5 |
| 简单 simple | 221 | 108 | 7 | 1 | 4 |
| 标准 normal | 260 | 90 | 8 | 1 | 3 |
| 困难 hard | 325 | 77 | 9 | 2 | 3 |
| 大师 master | 390 | 63 | 10 | 2 | 2 |

**关卡生成规则**：砖阵布局由 seed 生成（每行按 0.75 占砖率掷点）；砖色由行深映射分值（深行高分）；板触球位置偏移决定反射角（经典打砖块手感）。

**通关/失败与计分**：砖阵清空即通关；balls 耗尽即失败。`score = Σ砖分(=10×HP×行深系数1.0–1.5) + 剩余balls×50`。s2 = 12×bricks(L)，s3 = 15×bricks(L)（bricks(L)=当关砖总数）。

**竖屏单手映射**：controls `{primary:"drag"}`；板跟指水平移动（1:1 映射，指哪打哪）；发射 = 点按一次。

## 15. 挡板生存（paddle-pong）

底部挡板连续接住反弹下落球，坚持到目标时间；漏球耗失误。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| goalSec | int | 45 | 当关存活目标秒数（目标类），k=0.10 |
| ballSpeed | int | 220 | 球速 px/s（威胁类），k=0.35 |
| maxBalls | int | 4 | 场上同时最大球数（威胁类） |
| paddleW | int | 110 | 板宽 px（资源类），反向 k=0.25，floor=70 |
| missMax | int | 3 | 漏球上限（资源类） |

**难度曲线**
- `goal(L) = ceil(goalSec × (1 + 0.10×(L−1)/(Ln−1)))`
- `speed(L) = ballSpeed × (1 + 0.35×(L−1)/(Ln−1))`
- 球生成：从 1 球起，每 12s 或每 5 次接球 +1 球，cap=maxBalls。

**数值档位**

| 档位 | goalSec | ballSpeed | maxBalls | paddleW | missMax |
|---|---|---|---|---|---|
| 轻松 relaxed | 63 | 154 | 3 | 154 | 5 |
| 简单 simple | 54 | 187 | 3 | 132 | 4 |
| 标准 normal | 45 | 220 | 4 | 110 | 3 |
| 困难 hard | 38 | 275 | 5 | 94 | 2 |
| 大师 master | 31 | 330 | 6 | 77 | 2 |

**关卡生成规则**：球发射角由 seed 生成（避开垂直正下 ±15°）；球与板碰撞反射角按触板偏移分布。

**通关/失败与计分**：存活 goal(L) 秒即通关；missMax 耗尽即失败。`score = 接球×10 + 存活秒×2`。s2 = goal(L)×12，s3 = goal(L)×15。

**竖屏单手映射**：controls `{primary:"drag"}`；板水平跟指；顶部倒计时与失误点。

## 16. 弹幕射击（bullet-shmup）

竖版自动射击，拖动机体躲避弹幕并清空敌波。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| wavesCap | int | 10 | 每关波数上限（目标类） |
| enemyHP | int | 2 | 基础敌机耐久（威胁类） |
| bulletSpeed | int | 200 | 敌弹速度 px/s（威胁类），k=0.30 |
| density | int | 3 | 每敌机同屏弹数（威胁类），k=0.30 |
| lives | int | 3 | 机体数（资源类） |
| playerFireMs | int | 150 | 自机射速（固定，不随档位变） |

**难度曲线**
- `waves(L) = min(wavesCap, 5 + floor(5×(L−1)/(Ln−1)))`
- `eSpeed(L) = bulletSpeed × (1 + 0.30×(L−1)/(Ln−1))`
- `eHP(L) = enemyHP + floor(L / max(4, Ln/6))`（每若干关 +1 HP）

**数值档位**

| 档位 | lives | enemyHP | bulletSpeed | density | wavesCap |
|---|---|---|---|---|---|
| 轻松 relaxed | 5 | 1 | 140 | 2 | 8 |
| 简单 simple | 4 | 2 | 170 | 2 | 9 |
| 标准 normal | 3 | 2 | 200 | 3 | 10 |
| 困难 hard | 2 | 3 | 250 | 4 | 12 |
| 大师 master | 1 | 4 | 300 | 5 | 14 |

**关卡生成规则**：每波敌机从 pattern 池（直线俯冲/正弦横移/两侧夹进/悬停散射）由 seed 选用；每波 6 架；弹型扇形/瞄准二选一由 seed 掷点。

**通关/失败与计分**：清空 waves(L) 波即通关；lives 耗尽即失败。`score = 击落敌机×10×HP + 清波×50`。s2 = 12×enemies(L)，s3 = 15×enemies(L)（enemies(L)=waves(L)×6）。

**竖屏单手映射**：controls `{primary:"drag"}`；拖动机体（指上偏移 40px 免手指挡机体），自动连射无需点按。

## 17. 弹雨躲避（bullet-dodge）

无攻击纯躲避：操控小点在弹雨中存活到目标时间。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| goalSec | int | 30 | 存活目标秒数（目标类），k=0.10 |
| spawnRate | float | 1.80 | 弹生成速率 发/s（威胁类），k=0.50 |
| projSpeed | int | 180 | 弹速 px/s（威胁类），k=0.40 |
| playerR | int | 14 | 玩家判定半径 px（资源类），反向 k=0.20，floor=9 |
| slowCharges | int | 2 | 慢动作次数（资源类，按住触发 3s 时缓 0.5×） |

**难度曲线**
- `goal(L) = ceil(goalSec × (1 + 0.10×(L−1)/(Ln−1)))`
- `rate(L) = spawnRate × (1 + 0.50×(L−1)/(Ln−1))`
- `speed(L) = projSpeed × (1 + 0.40×(L−1)/(Ln−1))`

**数值档位**

| 档位 | goalSec | spawnRate | projSpeed | playerR | slowCharges |
|---|---|---|---|---|---|
| 轻松 relaxed | 42 | 1.26 | 126 | 20 | 4 |
| 简单 simple | 36 | 1.53 | 153 | 17 | 3 |
| 标准 normal | 30 | 1.80 | 180 | 14 | 2 |
| 困难 hard | 24 | 2.25 | 225 | 12 | 1 |
| 大师 master | 18 | 2.70 | 270 | 10 | 1 |

**关卡生成规则**：弹的边、角、速、型（直进/追踪弱导 8 帧）由 seed 逐发掷点；同屏弹 cap=40（超限改生成间隔）。

**通关/失败与计分**：存活 goal(L) 即通关；中弹即失败（一命制）。`score = 存活秒×10 + 险过(弹距<playerR×2)×5`。s2 = goal(L)×12，s3 = goal(L)×15。

**竖屏单手映射**：controls `{primary:"drag", secondary:"hold"}`；拖点移动，长按触发慢动作（充能耗尽自动失效）。

## 18. 接落物（drop-catcher）

顶部持续掉落好物与坏物，拖篮子接好物、躲坏物。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| catchTarget | int | 20 | 目标接取数（目标类），k=0.10 |
| fallSpeed | int | 240 | 落速 px/s（威胁类），k=0.35 |
| spawnRate | float | 1.50 | 生成率 个/s（威胁类），k=0.20 |
| badRate | float | 0.20 | 坏物占比（威胁类），k=0.15 |
| basketW | int | 110 | 篮宽 px（资源类），反向 k=0.25，floor=75 |
| lives | int | 3 | 生命（接坏物或漏好物均 −1）（资源类） |

**难度曲线**
- `catchTarget(L) = ceil(catchTarget × (1 + 0.10×(L−1)/(Ln−1)))`
- `fall(L) = fallSpeed × (1 + 0.35×(L−1)/(Ln−1))`
- 漏好物不计失败但断连击（连击是分数轴）。

**数值档位**

| 档位 | catchTarget | fallSpeed | spawnRate | badRate | basketW | lives |
|---|---|---|---|---|---|---|
| 轻松 relaxed | 15 | 168 | 1.10 | 0.14 | 154 | 5 |
| 简单 simple | 18 | 204 | 1.30 | 0.17 | 132 | 4 |
| 标准 normal | 20 | 240 | 1.50 | 0.20 | 110 | 3 |
| 困难 hard | 25 | 300 | 1.90 | 0.25 | 94 | 2 |
| 大师 master | 29 | 360 | 2.30 | 0.29 | 77 | 2 |

**关卡生成规则**：每次生成的物类（好/坏）、水平位置、下落微斜率由 seed 掷点；好物分值档（普通 10 / 稀有 30，占比 0.15）亦由 seed 决定。

**通关/失败与计分**：接满 catchTarget(L) 即通关；lives 耗尽即失败。`score = 好物面值 + 连击×5 − 接坏物×20`（下限 0）。s2 = catchTarget(L)×12，s3 = catchTarget(L)×15。

**竖屏单手映射**：controls `{primary:"drag"}`；篮子水平跟指（限制在屏宽内）；篮身热区放宽 8px 容错。

## 19. 打地鼠（mole-whack）

3×3 地鼠窝，冒头窗内点中得分，炸弹点了扣分耗命。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| hitTarget | int | 20 | 目标命中数（目标类），k=0.10 |
| timeSec | int | 30 | 每关时限（常量，档位不动） |
| popupMs | int | 900 | 地鼠冒头停留 ms（资源类），反向 k=0.30，floor=450 |
| concurrent | int | 2 | 同时冒头数（威胁类），k=0.30 |
| bombRate | float | 0.15 | 炸弹冒头占比（威胁类），k=0.15 |
| lives | int | 3 | 生命（点炸弹 −1）（资源类） |

**难度曲线**
- `hitTarget(L) = ceil(hitTarget × (1 + 0.10×(L−1)/(Ln−1)))`
- `popup(L) = max(450, round(popupMs × (1 − 0.30×(L−1)/(Ln−1))))`
- `concurrent(L) = min(4, round(concurrent × (1 + 0.30×(L−1)/(Ln−1))))`

**数值档位**

| 档位 | hitTarget | popupMs | concurrent | bombRate | lives |
|---|---|---|---|---|---|
| 轻松 relaxed | 15 | 1260 | 1 | 0.10 | 5 |
| 简单 simple | 18 | 1080 | 2 | 0.13 | 4 |
| 标准 normal | 20 | 900 | 2 | 0.15 | 3 |
| 困难 hard | 25 | 770 | 3 | 0.19 | 2 |
| 大师 master | 29 | 630 | 4 | 0.22 | 2 |

**关卡生成规则**：冒头节拍表（哪窝、何时、是鼠是弹）由 seed 生成；约束：同一窝不连续两轮冒头、炸弹不出现在前 5 秒（教学保护）。

**通关/失败与计分**：时限内命中 ≥ hitTarget(L) 即通关；时限到未达标或 lives 耗尽即失败。`score = 命中×10 + 连击×5 − 点炸弹×20`（下限 0）。s2 = hitTarget(L)×12，s3 = hitTarget(L)×15。

**竖屏单手映射**：controls `{primary:"tap"}`；九窝网格占屏中部 80% 宽，单指随机点按；顶部进度与倒计时。

## 20. 翻牌配对（memory-flip）

网格扣牌，两两翻开配对，误试步数上限内配平全部。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| pairsBase | int | 8 | 起始对数（目标类），k=0.30 |
| pairsCap | int | 12 | 对数上限 = pairsBase+4 封顶 |
| gridW | int | 4 | 网格列（行 = 卡数/列，奇数卡禁用） |
| peekMs | int | 1500 | 首次入场预览时长（资源类），反向 k=0.25 |
| moveFactor | float | 2.5 | 步数上限 = pairs×moveFactor（资源类） |

**难度曲线**
- `pairs(L) = min(pairsCap, round(pairsBase × (1 + 0.30×(L−1)/(Ln−1))))`
- `moves(L) = ceil(pairs(L) × moveFactor)`

**数值档位**

| 档位 | pairsBase | pairsCap | 网格 | peekMs | moveFactor |
|---|---|---|---|---|---|
| 轻松 relaxed | 6 | 10 | 4×4 | 2000 | 3.2 |
| 简单 simple | 8 | 12 | 4×4 | 1750 | 2.8 |
| 标准 normal | 8 | 12 | 4×4 | 1500 | 2.5 |
| 困难 hard | 10 | 14 | 5×4 | 1200 | 2.0 |
| 大师 master | 12 | 16 | 6×4 | 950 | 1.6 |

**关卡生成规则**：牌面花色与位置由 seed 洗牌；保证无重复三连同花初始行（降低视觉误记）。

**通关/失败与计分**：步数内配平全部对即通关；步数耗尽即失败。`score = 配对数×30 + 剩余步×5`。s2 = pairs(L)×36，s3 = pairs(L)×45。

**竖屏单手映射**：controls `{primary:"tap"}`；牌格占屏宽 92%，牌面热区即牌格；顶部步数余量。

## 21. 序列记忆（simon-sequence）

色块面板按序列点亮，玩家依序复述；每关序列更长。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| pads | int | 4 | 面板键数 4/6/9（威胁类） |
| flashMs | int | 550 | 单键点亮时长（资源类），反向 k=0.25，floor=250 |
| gapMs | int | 250 | 键间间隔 = flashMs×0.45 |
| startLen | int | 3 | 序列起始长度（固定） |
| targetLenCap | int | 15 | 当关目标序列长度上限（目标类） |
| retries | int | 1 | 关内答错重试次数（资源类） |

**难度曲线**
- `targetLen(L) = min(targetLenCap, 3 + floor(12×(L−1)/(Ln−1)))`
- `flash(L) = max(250, round(flashMs × (1 − 0.25×(L−1)/(Ln−1))))`
- 关内增长：答对整条序列后序列 +1 续玩，直到 targetLen(L)。

**数值档位**

| 档位 | pads | flashMs | targetLenCap | retries |
|---|---|---|---|---|
| 轻松 relaxed | 4 | 770 | 12 | 2 |
| 简单 simple | 4 | 660 | 13 | 1 |
| 标准 normal | 4 | 550 | 15 | 1 |
| 困难 hard | 6 | 460 | 18 | 0 |
| 大师 master | 9 | 380 | 21 | 0 |

**关卡生成规则**：序列每位由 seed 在 pads 键上均匀掷点；约束：不连续三同键。

**通关/失败与计分**：复述长度达到 targetLen(L) 即通关；答错且 retries 耗尽即失败。`score = 复述步数×10 + 通关×50`。s2 = targetLen(L)×12，s3 = targetLen(L)×15。

**竖屏单手映射**：controls `{primary:"tap"}`；pad 均分大区块（4 键 2×2 / 6 键 2×3 / 9 键 3×3），复述期禁多点。

## 22. 颜色反应（color-reaction）

屏幕出示大号颜色词（墨色随机），判断"墨色与词义是否一致"，点屏幕左右两半作答。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| roundsBase | int | 20 | 每关轮数（目标类），k=0.20 |
| perRoundMs | int | 1500 | 每轮作答窗 ms（资源类），反向 k=0.30，floor=600 |
| agreeRate | float | 0.50 | 一致轮占比（固定 0.5，不随档位） |
| maxMiss | int | 3 | 错答/超时上限（资源类） |
| trapSwitch | boolean | true | L>10 起偶发"反规则轮"（题义反转，顶部黄条提示 1s） |

**难度曲线**
- `rounds(L) = ceil(roundsBase × (1 + 0.20×(L−1)/(Ln−1)))`
- `round(L) = max(600, round(perRoundMs × (1 − 0.30×(L−1)/(Ln−1))))`

**数值档位**

| 档位 | roundsBase | perRoundMs | maxMiss | trapSwitch |
|---|---|---|---|---|
| 轻松 relaxed | 15 | 2100 | 5 | false |
| 简单 simple | 18 | 1800 | 4 | false |
| 标准 normal | 20 | 1500 | 3 | true |
| 困难 hard | 24 | 1280 | 2 | true |
| 大师 master | 29 | 1050 | 2 | true |

**关卡生成规则**：每轮词/墨色/是否一致由 seed 掷点；词池与色池固定 8 词 8 色（红橙黄绿青蓝紫黑）。

**通关/失败与计分**：完成 rounds(L) 轮且 maxMiss 未耗尽即通关；miss 耗尽即失败。`score = 正确×10 + 连击×3 − 错答×15`（下限 0）。s2 = rounds(L)×12，s3 = rounds(L)×15。

**竖屏单手映射**：controls `{primary:"tap-zone"}`；屏幕下 1/2 左右两大热区（左=一致 ✔ / 右=不一致 ✘），题面在中央。

## 23. 划切水果（fruit-slice）

水果抛物线飞出，单指划线切割；炸弹切了扣命，漏果耗失误。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| targetBase | int | 25 | 目标切果数（目标类），k=0.10 |
| spawnRate | float | 1.40 | 生成率 个/s（威胁类），k=0.25 |
| flySpeed | int | 520 | 抛射初速 px/s（威胁类），k=0.25 |
| bombRate | float | 0.12 | 炸弹占比（威胁类），k=0.15 |
| missMax | int | 5 | 漏果上限（资源类） |
| lives | int | 3 | 生命（切炸弹 −1）（资源类） |

**难度曲线**
- `target(L) = ceil(targetBase × (1 + 0.10×(L−1)/(Ln−1)))`
- `fly(L) = flySpeed × (1 + 0.25×(L−1)/(Ln−1))`
- `rate(L) = spawnRate × (1 + 0.25×(L−1)/(Ln−1))`

**数值档位**

| 档位 | targetBase | spawnRate | flySpeed | bombRate | missMax | lives |
|---|---|---|---|---|---|---|
| 轻松 relaxed | 19 | 1.00 | 364 | 0.08 | 7 | 5 |
| 简单 simple | 23 | 1.20 | 442 | 0.10 | 6 | 4 |
| 标准 normal | 25 | 1.40 | 520 | 0.12 | 5 | 3 |
| 困难 hard | 31 | 1.75 | 650 | 0.15 | 4 | 2 |
| 大师 master | 36 | 2.10 | 780 | 0.18 | 3 | 2 |

**关卡生成规则**：每次生成的物类（果/炸弹）、水平位置、抛射角（60°–105°）由 seed 掷点；同屏物 cap=6。

**通关/失败与计分**：时限 60s 内切果 ≥ target(L) 即通关（时限常量）；missMax 或 lives 耗尽即失败。`score = 果×10 + 一刀多果n×n×5 − 切炸弹×30`（下限 0）。s2 = target(L)×12，s3 = target(L)×15。

**竖屏单手映射**：controls `{primary:"swipe-any"}`；划线轨迹与果圆求交判定切中；切中反馈沿轨迹显刀光。

## 24. 水排序（water-sort）

试管内分层彩色水，倾倒规则：只能倒在同色顶层或空管，把每色归拢到整管。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| colorsBase | int | 5 | 起始颜色数（目标类），每 ⌊Ln/5⌋ 关 +1 色 |
| colorsCap | int | 10 | 颜色数上限 |
| tubeCap | int | 4 | 每管层数（常量 4，不随档位变） |
| emptyTubes | int | 2 | 额外空管数（资源类） |
| moveFactor | float | 2.2 | 步数上限系数（资源类） |

**难度曲线**
- `colors(L) = min(colorsCap, colorsBase + floor((L−1)/max(1, floor(Ln/5))))`
- `moves(L) = ceil(colors(L) × tubeCap × moveFactor × 0.5)`

**数值档位**

| 档位 | colorsBase | colorsCap | emptyTubes | moveFactor |
|---|---|---|---|---|
| 轻松 relaxed | 3 | 6 | 3 | 2.8 |
| 简单 simple | 4 | 8 | 2 | 2.5 |
| 标准 normal | 5 | 10 | 2 | 2.2 |
| 困难 hard | 6 | 12 | 1 | 1.9 |
| 大师 master | 7 | 14 | 1 | 1.6 |

**关卡生成规则**：由已解终局（每管纯色）出发，用 seed 反向执行 N=⌈moves×0.6⌉ 次合法倒水生成乱局——**生成即保证可解**；反向后若无色块移动（退化）则重掷。

**通关/失败与计分**：全部颜色各自归拢为整管即通关；步数耗尽即失败。`score = 通关基础 colors(L)×100 + 剩余步×10`。星级按步数效率（覆盖 §3.2 默认）：2★ = used ≤ 0.80×moves(L)，3★ = used ≤ 0.65×moves(L)。

**竖屏单手映射**：controls `{primary:"tap"}`；先点源管再点目标管完成倾倒（两次点按，防误拖）；管列自适应排布占屏宽 90%。

## 25. 方块下落（block-drop）

经典下落拼块：滑动手势操作，井内填满整行消除，堆到井顶即败。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| dropMs | int | 800 | 自然下落间隔 ms（威胁类），k=0.50，floor=120 |
| wellW | int | 10 | 井宽格（常量 10；井高 = 20） |
| garbageBase | int | 4 | 关底预置垃圾行数上限（威胁类） |
| nextN | int | 3 | next 预览块数（资源类） |
| linesFactor | float | 1.0 | 目标行数乘子（目标类） |

**难度曲线**
- `drop(L) = max(120, round(dropMs × (1 − 0.50×(L−1)/(Ln−1))))`
- `garbage(L) = round(garbageBase × (L−1)/(Ln−1))`
- `lines(L) = ceil((10 + 15×(L−1)/(Ln−1)) × linesFactor)`

**数值档位**

| 档位 | dropMs | garbageBase | nextN | linesFactor |
|---|---|---|---|---|
| 轻松 relaxed | 1120 | 2 | 3 | 0.75 |
| 简单 simple | 960 | 3 | 3 | 0.90 |
| 标准 normal | 800 | 4 | 3 | 1.00 |
| 困难 hard | 640 | 5 | 2 | 1.20 |
| 大师 master | 480 | 6 | 1 | 1.45 |

**关卡生成规则**：七种四格块序列由 seed 掷点（7-bag 规则：每 7 个一袋洗牌，保证公平分布）；垃圾行的洞位（1–2 个）由 seed 决定。

**通关/失败与计分**：消行数达到 lines(L) 即通关；新块无处生成（堆顶）即失败。`score = 消行×100 + 双消×300 + 三消×500 + 四消×800`（按次计）。s2 = 150×lines(L)，s3 = 220×lines(L)。

**竖屏单手映射**：controls `{primary:"swipe-any", secondary:"tap"}`；左右滑 = 移一格，上滑 = 旋转，下滑 = 软降，快速下滑（fling）= 硬降；点按 = 旋转（备选）。井居中占屏宽 60%。

## 26. 块填充（block-fit）

10×10 无重力棋盘，每轮发 3 个形状块，放满整行/整列即消除；三块都放不下即败。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| targetScore | int | 2000 | 目标分（目标类），k=0.15 |
| pentRate | float | 0.12 | 五格块出现率（威胁类） |
| obstacleStart | int | 0 | 开局障碍格数（威胁类） |
| piecesPerRound | int | 3 | 每轮发块数（常量 3） |
| refresh | int | 0 | 死局免费刷新次数（资源类） |

**难度曲线**
- `target(L) = ceil(targetScore × (1 + 0.15×(L−1)/(Ln−1)))`
- `pent(L) = min(0.25, pentRate × (1 + 0.20×(L−1)/(Ln−1)))`

**数值档位**

| 档位 | targetScore | pentRate | obstacleStart | refresh |
|---|---|---|---|---|
| 轻松 relaxed | 1500 | 0.05 | 0 | 1 |
| 简单 simple | 1800 | 0.08 | 0 | 1 |
| 标准 normal | 2000 | 0.12 | 0 | 0 |
| 困难 hard | 2400 | 0.16 | 2 | 0 |
| 大师 master | 2900 | 0.20 | 4 | 0 |

**关卡生成规则**：形状池固定 21 形（1–5 格全集）；每轮 3 块由 seed 按 pent(L) 掷复杂度再选形；障碍格位置由 seed 置于非角格。

**通关/失败与计分**：score ≥ target(L) 即通关；当前三块均无处可放（refresh 耗尽）即失败。`score = 放置格数×1 + 消行/列每行×10×格数 + 行列同消×30`。s2 = target(L)×1.2，s3 = target(L)×1.5。

**竖屏单手映射**：controls `{primary:"drag"}`；从底部块槽拖入棋盘，接近格点自动吸附；抬起即确认。

## 27. 珠链消除（chain-shot）

轨道上彩珠链向洞口推进，中央发射器射珠入链，同色 ≥3 即消除。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| chainSpeed | int | 30 | 珠链推进速度 px/s（威胁类），k=0.40 |
| colors | int | 4 | 珠色数（威胁类） |
| totalBalls | int | 40 | 当关珠链总珠数（目标类），k=0.30 |
| swap | int | 5 | 当前珠与下一珠交换次数/关（资源类） |
| trackLen | int | 1200 | 轨道长度 px（常量） |

**难度曲线**
- `chain(L) = chainSpeed × (1 + 0.40×(L−1)/(Ln−1))`
- `balls(L) = ceil(totalBalls × (1 + 0.30×(L−1)/(Ln−1)))`
- 减速机制：每次消除链尾回退 60px（经典手感，消除即争取空间）。

**数值档位**

| 档位 | chainSpeed | colors | totalBalls | swap |
|---|---|---|---|---|
| 轻松 relaxed | 21 | 3 | 30 | ∞ |
| 简单 simple | 26 | 4 | 36 | ∞ |
| 标准 normal | 30 | 4 | 40 | 5 |
| 困难 hard | 38 | 5 | 48 | 3 |
| 大师 master | 45 | 6 | 58 | 0 |

**关卡生成规则**：珠色序列由 seed 掷点；轨道形状从池（螺旋 / S 波 / 双环）由 seed 选；发射器下一珠颜色由 seed 在 colors 内掷点。

**通关/失败与计分**：清空珠链即通关；珠链首珠到达洞口即失败。`score = 消珠×10 + 连锁级数×5 + 单次消≥4珠×20`。s2 = balls(L)×12，s3 = balls(L)×15。

**竖屏单手映射**：controls `{primary:"tap"}`；点按屏幕任意方向即向该方向发射（发射器居屏下 1/3）；双击发射器换珠。

## 28. 迷宫冲刺（maze-dash）

程序生成迷宫，限时从起点走到出口，后段带钥匙与视野迷雾。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| sizeN | int | 11 | 迷宫边长格数（奇数）（目标类），k=0.30 |
| timeFactor | float | 1.7 | 时限 = 最短路长 × timeFactor / 玩家速度（资源类） |
| speed | float | 4.0 | 玩家移速 格/s（常量） |
| keysCap | int | 2 | 钥匙数上限（目标类），k 随 L 线性 |
| fogR | int | 0 | 迷雾半径格（0=off）（威胁类） |

**难度曲线**
- `size(L) = min(sizeN + 4, sizeN + floor(4×(L−1)/(Ln−1)))`（档位再叠加，见档位表）
- `keys(L) = min(keysCap, floor(3×(L−1)/(Ln−1)))`
- `time(L) = ceil(bfsPathLen × timeFactor / speed)`

**数值档位**

| 档位 | sizeN | timeFactor | keysCap | fogR |
|---|---|---|---|---|
| 轻松 relaxed | 9 | 2.4 | 1 | 0 |
| 简单 simple | 11 | 2.0 | 2 | 0 |
| 标准 normal | 11 | 1.7 | 2 | 0 |
| 困难 hard | 13 | 1.4 | 3 | 5 |
| 大师 master | 15 | 1.2 | 3 | 4 |

**关卡生成规则**：递归回溯法由 seed 生成完美迷宫（唯一解）；再拆 q=⌊size²×0.05⌋ 面墙制造环路；钥匙放在 BFS 深度前 60% 的死端格。

**通关/失败与计分**：集齐钥匙并到达出口即通关；超时即失败。`score = 剩余秒×20 + 钥匙×50`。s2 = 12×time(L)，s3 = 15×time(L)。

**竖屏单手映射**：controls `{primary:"swipe-any"}`；滑动定向前进至下一个岔口（格吸附，免连滑）；顶部剩余时间条。

## 29. 简化塔防（mini-td）

单路径波次塔防：点空位建塔，塔自动索敌；漏怪耗基地命。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| gold0 | int | 120 | 开局金币（资源类） |
| livesBase | int | 10 | 基地生命（资源类） |
| enemyHP | int | 10 | 基础敌血（威胁类），k=0.35 |
| waveSize | int | 8 | 每波敌数（威胁类），k=0.20 |
| wavesCap | int | 10 | 每关波数（目标类） |
| enemySpeed | int | 40 | 敌速 px/s（威胁类），k=0.20 |
| slots | int | 12 | 可建塔位（常量） |

**难度曲线**
- `waves(L) = min(wavesCap, 5 + floor(5×(L−1)/(Ln−1)))`
- `hp(L, w) = ceil(enemyHP × (1 + 0.35×(L−1)/(Ln−1)) × (1 + 0.08×w))`（w=波序号，关内波间增长）
- 击杀金 `killGold = ceil(hp × 0.6)`；出怪间隔 900ms。

**数值档位**

| 档位 | gold0 | livesBase | enemyHP | waveSize | wavesCap | enemySpeed |
|---|---|---|---|---|---|---|
| 轻松 relaxed | 168 | 14 | 7 | 6 | 8 | 28 |
| 简单 simple | 144 | 12 | 9 | 7 | 9 | 34 |
| 标准 normal | 120 | 10 | 10 | 8 | 10 | 40 |
| 困难 hard | 102 | 8 | 13 | 10 | 12 | 50 |
| 大师 master | 84 | 7 | 15 | 12 | 15 | 60 |

**关卡生成规则**：敌路径从 S 形模板池 3 条由 seed 选；塔位沿路径两侧均匀布设；出怪类型（普通/快速×1.5 速×0.7 血）由 seed 掷点（快速占比 0.25）。

**通关/失败与计分**：撑过 waves(L) 波即通关（漏怪 ≤ livesBase−1）；基地命耗尽即失败。塔三型：箭塔 50 金单体 / 冰塔 70 金减速 40% / 炮塔 120 金溅射，可升 2 级（费用 ×1.5，效果 ×1.6）。`score = 击杀×10 + 剩余基地命×50 + 清波×30`。s2 = 12×enemies(L)，s3 = 15×enemies(L)（enemies(L)=ΣwaveSize(L)）。

**竖屏单手映射**：controls `{primary:"tap"}`；点空位弹建塔卡（底部横排三选一），点已建塔弹升级/出售；战斗自动进行。

## 30. 节奏点击（rhythm-tap）

四轨音符下落，到判定线时点对应轨区；按精度计分，血量耗尽即败。

**game.json typeExtra schema**

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| bpm | int | 100 | 节拍速度（威胁类），k=0.30 |
| density | float | 1.20 | 音符密度 音符/拍（威胁类），k=0.40 |
| notesBase | int | 60 | 当关音符数基数（目标类），k=0.50 |
| perfectMs | int | 50 | Perfect 判定窗 ±ms（资源类） |
| life | int | 6 | 血量（Miss/Great 以下 −1）（资源类） |

**难度曲线**
- `bpm(L) = round(bpm × (1 + 0.30×(L−1)/(Ln−1)))`
- `notes(L) = ceil(notesBase × (1 + 0.50×(L−1)/(Ln−1)))`
- 判定窗：Perfect ±perfectMs；Great ±2×perfectMs；Good ±3×perfectMs；超窗 Miss。

**数值档位**

| 档位 | bpm | density | notesBase | perfectMs | life |
|---|---|---|---|---|---|
| 轻松 relaxed | 70 | 0.84 | 45 | 70 | 10 |
| 简单 simple | 85 | 1.02 | 54 | 60 | 8 |
| 标准 normal | 100 | 1.20 | 60 | 50 | 6 |
| 困难 hard | 125 | 1.50 | 72 | 40 | 5 |
| 大师 master | 150 | 1.74 | 87 | 35 | 4 |

**关卡生成规则**：谱面在节拍网格上由 seed 生成：每拍按 density 期望掷音符数，轨号均匀掷点；约束：同拍双押率 0.15 且仅相邻轨（保证单指可交替点）、同轨同拍不重、相邻音符同轨最小间隔 1 拍。

**通关/失败与计分**：谱面走完且 life > 0 即通关；life 耗尽即失败。`score = Perfect×100 + Great×70 + Good×40 + 连击加成每注+2（cap 100）`。s2 = 80×notes(L)（平均 Great 以上），s3 = 92×notes(L)（平均接近 Perfect）。

**竖屏单手映射**：controls `{primary:"tap-zone"}`；四轨判定区占屏下 55%，四竖条热区等宽 ≥80px；单指交替点即可全通（谱面约束保证）。

## 31. 附录：生产核对清单（每款游戏 DoD）

投产任何一款游戏（games/&lt;type&gt;/&lt;slug&gt;/）合入前逐项勾选：

1. **schema**：game.json 含 §2.1 全部公共字段；typeExtra 字段名与所属类型节 schema 表一致，缺省值等于类型节默认值。
2. **档位一致**：tier 与 typeExtra 数值和该类型节档位表行一致（偏差 ≤±10% 且单调：threat 递增 / resource 递减）。
3. **确定性**：删 `Math.random()` 于判定路径；同 `slug#level` 布局逐字节可复现（QA 用同 seed 断言）。
4. **进度与钩子**：localStorage 仅用 §5.2 三键；§5.3 四事件（boot/start/levelEnd/end）齐发且 payload 字段完整。
5. **自包含**：单文件无任何外部请求；飞行模式可玩；体积 ≤200KB（超限须在 game.json 备注）。
6. **计分**：score 公式与类型节一致；s2/s3 星级门槛按本规范（或类型节显式覆盖式）实现。
7. **交互**：controls 落在 §5.4 词表；热区 ≥44px；主操作位于屏下 2/3；375×667 实测可玩。
8. **崩溃恢复**：progress 写入节流 + beforeunload flush；损坏存档静默重置；失败不掉进度。
9. **自测证据**：冻结验收命令 + 本清单逐项结果写入该游戏单 REPORT。

**投放规模核算**：24 类型 × 5 档 = 120 款 ≥ 100 目标（README）；每类型投放顺序建议 normal → relaxed/simple → hard → master（先定基准手感再调两端）。

## 32. 附录：game.json 平台线仲裁记录（v2 §3.3 / 决策 D7，GAMES-13 落地）

**仲裁结论：实况为准 + 最小收口**。本文 §2.1 仍是**生产线**唯一事实源与投产 DoD（§31 清单第 1 项不变）；
**平台线**（server/lib/scan-games.js 清单扫描 + uploads.js 上传管线）按策划案 v2 §3.3 仲裁表执行，理由：

1. main 上真实生效的一直是 scan 实读口径——§2.1 此前无任何校验器执行，必填缺漏不报错、越界静默收敛；强切 spec 口径 = 存量 demo 5 款与已上架玩家上传须全部返工重新投产。
2. 玩家上传线天然宽松（normalizeMeta 收敛值域：levels 1–9999、name ≤64）——玩家无权也不该被强制生产线的 10–120 关 / ≤12 字标题，在 scan 处收紧会把审核管线推成大面积拒绝。
3. 生产线的严格性不因此放松：schema 合规由生产自检 + QA 复测把关（§31），平台 scan 只拦"结构性坏数据"，不做生产线 DoD 执行者。

**逐键裁定**（平台线；与 §2.1 冲突处以本表为准）：

| 键 | §2.1（生产线） | 平台线裁定（本仲裁） |
|---|---|---|
| 名称 | `title` 必填 | **双读**：title 优先、name 兜底、slug 保底；清单输出键统一为 `name`（/api/games 契约不变） |
| type | json 字段，24 枚举 | **目录名为准**（json 内 type 不读） |
| slug | json 字段，格式正则 | **目录名为准**（生产线格式约束仍见 §2.1） |
| tier | 五枚举必填 | **收口五枚举** relaxed\|simple\|normal\|hard\|master；缺省→normal；存量 `standard`→normal 迁移；其余值：scan 判非法跳过，上传管线收敛 normal |
| levels | int 10–120 | 平台放宽 **1–9999** 取整；非数字/越界=非法；缺省 1 |
| id | 无（type:slug 推导） | **禁用 json id 覆盖**，一律 `<type>:<slug>` 目录推导（与上架管线 approve 删 id 一致） |
| entry | 必填固定 index.html | 可选缺省 index.html；非字符串/绝对路径/含 `..` = 非法；入口文件须存在 |
| description | 无此键 | 平台合法字段（字符串；上传侧截断 ≤256） |
| version / specVersion / orientation / controls / avgDurationSec / scoring / assets / typeExtra | 必填/可选 | **M4 前不校验**，scan 透传进清单（feed 可消费 avgDurationSec / assets.thumb；controls 形状分歧 #42 随 M4 一并裁） |

**非法处理（GAMES-13 scan 校验）**：缺 game.json / JSON 解析失败 / 非 JSON 对象 / 上表字段非法 / 入口文件不存在
→ 跳过该目录并计入扫描报告：`scanGames()` 返回 `{ games, invalid }`（invalid 项含 type/slug/reason），
server 在 invalid 集合变化时打一条聚合告警日志；`node scripts/smoke-api.js` 含冻结断言（非法目录不入 /api/games）。
上传管线入口（normalizeMeta）同步收口 tier，保证"审核通过 ⇒ 必然入清单"不被新校验打破。

**修订记录**：v1.0.0（GAMES-7，2026-09-22）首版冻结：公共 schema、五档体系、曲线三式、24 类型全量数值表。
v1.1.0（GAMES-13，2026-09-23）新增 §32 平台线仲裁附录（v2 §3.3/D7）：实况为准 + tier 收口五枚举（standard→normal 迁移）、levels 平台 1–9999、禁用 json id、title/name 双读、spec 字段透传；§2.1 键名冻结不变。
