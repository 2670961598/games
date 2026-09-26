# GAMES-24 引擎基准（bench/）

质量战役 R 阶段的实证基准：Phaser 3 / Phaser 4 / PixiJS 8 / 原生 Canvas2D 四个栈，
用**同一套玩法状态机**跑两个代表玩法，测帧率/掉帧、冷启动、60s 内存增长、代码量与包体。
结论与完整数据见 `docs/engine-choice.md`（本目录只放可复现的基准资产）。

## 目录

```
bench/
  vendor/        引擎构建（npm 拉取的官方 dist，版本冻结见下）
  src/
    rules.js     共享玩法规则层（PRNG/关卡参数/生成/判定/计分/机器人，四栈字节一致）
    metrics.js   页内度量层（tReady / rAF 采样 / 实体峰值）
    glue-native.js   原生 Canvas2D 接线（rAF+固定步长+Pointer）
    glue-phaser.js   Phaser 3/4 共用接线（Scene+纹理池+相机 zoom 方案）
    glue-pixi.js     PixiJS 8 接线（Application+ticker+纹理池）
  build.mjs      组装 bench/out/*.html（页面引用 ../vendor/*.min.js，不内联）
  run.mjs        测量 harness（静态服务 + Playwright 无头 Chrome）
  out/           构建产物（8 页 = 4 栈 × 2 玩法）
  sizes.json     构建期代码量/包体统计
  results.json   最近一次测量结果（历史在 results/）
```

## 公平性协议（禁止拍脑袋的实证口径）

1. **同一玩法状态机**：四个栈内联同一份 `rules.js`——spec §5.6 冻结 PRNG
   （`fnv1a32+mulberry32`）、同 seed 同关卡（固定 L15/30，曲线中段）、同实体流、同判定
   （固定步长 1/120s 累加器）、同计分公式（tap：`hits×10+maxCombo×5−decoyHits×15`；
   runner：`coins×20+hearts×50`）。引擎层只做渲染/输入/循环接线——fps/内存差异因此可
   归因于引擎。结果表里的 `peak/avgEnt/restarts` 是工作负载等价性的地面真值。
2. **两个代表玩法**（参数逐字对齐线上 `games/_shared/engines/`）：
   - `tap`（tap-burst §7，高频点击类）：目标流+陷阱+连击+火花粒子；
   - `runner`（lane-runner §9，滚动+碰撞类）：三车道/安全走廊生成/跳跃物理/金币。
3. **压力档**：`?load=N` 只放大生成密度/速度（tap：spawnPerSec×N；runner：
   speed×N^0.75、obsRate/coinRate 趋近上限），判定逻辑不变。load=1 为线上可玩档，
   load=4/8 为渲染压力档（实体数爬坡）。
4. **视口真机口径**：375×667 逻辑分辨率；DPR1 与 DPR2（背板 750×1334）各测一轮。
   机器人（`rules.js#makeBot`）合成 PointerEvent 打到画布，走**引擎输入管线**，跨引擎
   同决策序列；自动重开保证 10s/60s 窗口内持续满负载。
5. **主口径无头 SwiftShader**（软件 GL ≈ 低端真机 GPU，rAF 锁 60Hz）；`--gpu` 档用
   `channel:chromium` 走本机真 GPU（ANGLE Metal）复核，两口径的渲染器串都写进
   `results.meta`。

## 度量定义

| 指标 | 定义 |
|---|---|
| tReady（冷启动） | 全新 context（空缓存）导航 → 首个呈现帧（`performance.now()`，含 vendor 抓取+解析+引擎 boot+首帧） |
| tReady（回访） | 同 context 二次加载（vendor 走 HTTP 缓存） |
| avg fps | ready+0.5s 暖机后 rAF 时间戳采样 10s 的平均帧率 |
| 掉帧 | 帧间隔 >17.5ms 计数（long17）、>34ms 计数（long34）、逐秒最小帧率（min1s） |
| 内存增长 | 机器人自动玩 60s，宿主每 2s 采 `performance.memory.usedJSHeapSize`（`--enable-precise-memory-info`），增长=末样−首样 |
| 包体 | 自有代码（HTML+内联 JS/CSS）与 vendor 的 raw/gzip 字节数（`sizes.json` + `results.size`） |

## 用法

```bash
node bench/build.mjs            # 重建 out/（改 src 后必跑）
node bench/run.mjs              # 全量（约 25-30 分钟）
node bench/run.mjs --quick      # 快检（单次重复，约 15 分钟，含 8×60s 内存跑）
node bench/run.mjs --gpu        # 追加真 GPU（channel:chromium）复核档
node bench/run.mjs --only=native-tap,pixi8-tap   # 只测指定页
```

依赖：仓库自带 playwright（chromium）；无新增 npm 依赖。bench/ 不进 games/、不影响
线上与 dist。

## vendor 版本（冻结）

| 文件 | 版本 | raw | gzip |
|---|---|---|---|
| phaser3.min.js | 3.90.0 | 1168 KB | 310 KB |
| phaser4.min.js | 4.2.1 | 1344 KB | 346 KB |
| pixi8.min.js | 8.21.0 | 809 KB | 228 KB |

（npm registry 官方 tgz 的 dist 产物原样落盘，未改动。）
