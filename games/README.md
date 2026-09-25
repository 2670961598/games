# games/ — 自包含游戏目录

约定（见仓库根 AGENTS.md）：每个游戏一个目录 `games/<type>/<slug>/`，完全自包含：

```
games/
  puzzle/
    match3-demo/
      index.html      # 入口，所有 JS/CSS 内联或相对路径引用，无构建步骤
      game.json       # 元数据：name/title/description/controls 等（平台字段口径见 docs/game-design-spec.md §32 仲裁附录）
```

- 伺服：server 按原路径静态伺服（`/games/puzzle/match3-demo/` → 目录内 index.html）。
- 入库即玩：不依赖外部 CDN；跨游戏共享的资源后续统一放 `games/_shared/`。
- 玩家上传的游戏经审核管线进入本目录（审核单另开）。
- **引擎基座（GAMES-22）**：Phaser 3.90.0 本地副本 `games/_shared/phaser.min.js` +
  适配层 `games/_shared/engine.js`（seed PRNG §5.6 / §5.3 上报 / §5.2 三键 / 375×667 Scale.FIT /
  PlayScene 基类）。注意 `_shared` 不被 server 外露（`/games/_*` 404），共享资源由
  `build-*.mjs` 构建期内联进各 index.html（§5.1 单文件自包含不变）。已迁类型：
  tap-burst、lane-runner（逻辑层 `engines/<type>.js` 纯 JS 可 vm 驱动 + 表现层
  `engines/<type>.scene.js`），见 `build-g22.mjs`；性能采样 `node scripts/perf-smoke.js`。
