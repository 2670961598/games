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
