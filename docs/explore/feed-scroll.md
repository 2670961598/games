# 竖屏无限 feed 滚动容器方案实测对比

> 单据：GAMES-8 ｜ 父 Epic：GAMES-1 ｜ 轨道：L0 探索
> 结论先行：**推荐方案 B（CSS scroll-snap + 保留式 DOM 管理 + LRU iframe 池）**，详见[结论](#七结论)。

## 一、背景与范围

GAMES 平台的首页形态是竖屏无限 feed：每屏恰好一个游戏卡片，卡片内容为同源 iframe（`games/<type>/<slug>/index.html`）。本文对比三种滚动容器方案，核心约束：

1. **iframe 状态必须尽量保住**——用户滑走再滑回，游戏不应从头加载（进度/音效/场景丢失即体验破坏）；
2. 竖屏、移动端为主、桌面浏览器可用（制作人本机开发验证）；
3. feed 无限长，DOM 与内存不能无限增长（或增长必须可控）。

三个极简可跑 demo（零依赖，双击 `file://` 直接打开即可）：

| 方案 | demo | 一句话原理 |
|---|---|---|
| A. transform 手动回收 | [demos/a-transform-recycle.html](demos/a-transform-recycle.html) | 3 个固定容器轮转，pointer 事件手写驱动 transform 翻页，滑出的容器改绑新内容 |
| B. CSS scroll-snap | [demos/b-scroll-snap.html](demos/b-scroll-snap.html) | 原生滚动 + `scroll-snap-type: y mandatory`，IntersectionObserver 懒加载、接近尾部无限追加 |
| C. 虚拟列表 | [demos/c-virtual-list.html](demos/c-virtual-list.html) | 占位总高 + 原生滚动，scroll 事件计算当前屏，只挂载 ±1 面板，滚出即卸载 |

每个 demo 的 iframe 都是假游戏：显示「加载时间戳 + 存活秒数」。**重载 = 时间戳变化、存活归零**，肉眼可辨；HUD 实时显示（重）加载动作计数。

## 二、实测 Ⅰ：iframe 生命周期矩阵（哪种操作导致重载）

方法：同源 iframe 加载后注入随机 `MARK`，执行操作后对比 `MARK` 是否变化。变化 = browsing context 重建 = 重载。

**测试环境**：HeadlessChrome/153.0.8010.50 ｜ macOS（Darwin 25.3.0）｜ 视口 500×713 ｜ HTTP 同源（127.0.0.1）

| # | 操作 | 结果 |
|---|---|---|
| 1 | `removeChild` 后再 `appendChild`（detach/reattach） | **重载** |
| 2 | `display: none` 期间 / 恢复 | **不重载** |
| 3 | 移动到其他父节点（保持连接） | **重载** |
| 4 | `content-visibility: hidden` 期间 / 恢复 | **不重载** |
| 5 | `transform` 移出视口（对照） | **不重载** |
| 6 | 重设相同 `src` | **重载** |
| 7 | scroll-snap 容器滚两屏再滚回 | **不重载** |
| 8 | 卸载期间 `contentWindow` | **已销毁**；重挂必重载 |

结论：**iframe 的生死只取决于「是否仍在文档树中且 src 未被重设」**。CSS 层面的任何隐藏/位移（display / content-visibility / transform）都不触发重载；任何 detach（哪怕瞬间）、DOM 挪位、重设 src 都必然重载。这是三个方案 iframe 兼容性差异的全部根源。

## 三、实测 Ⅱ：三 demo 行为验证

**测试环境**：Playwright 内置 Chromium 153.0.8010.12（真实时序、非虚拟时钟）｜ 视口 400×800 ｜ `file://` 直接打开 demo

| demo | 操作序列 | 实测结果 |
|---|---|---|
| B scroll-snap | 等 1.6s → 程序滚到第 3 屏 → 1s → 滚回第 1 屏 | frame0 加载时间戳不变，存活 1 秒 → 3 秒持续增长：**滚走再回来不重载**；IntersectionObserver 正常（自动追加至 7 个 section、初始懒加载 3 屏） |
| C 虚拟列表 | 滚到 #3 → 滚回 #0 | #0 面板被卸载重建，时间戳更新、存活归零：**滑两屏再回来必重载**；(重)加载计数 7 次与挂载路径逐一吻合 |
| A transform 轮转 | 鼠标模拟上滑 → #1 → #2 → 回滑 #1 | (重)加载计数 2→3→4→5：**每次轮转一格 = 1 次 iframe 重载**（改绑格重载，保留格不重载） |
| 全部 | — | 无 JS 错误（pageerror 收集为空） |

## 四、对比矩阵

（未注明「实测」的均为推理估计，标「估计」）

| 维度 | A transform 轮转 | B scroll-snap | C 虚拟列表 |
|---|---|---|---|
| 跟手性 | 取决于自写 JS：pointermove → transform 在主线程跑，主线程忙（如 iframe 游戏满载）即掉跟手【估计】 | **原生滚动，合成器线程处理**，跟手/惯性/回弹系统级，最优 | 滚动本身原生（同 B），但滚程中触发挂载，可能可见延迟【估计】 |
| 掉帧风险 | 中高：手势逐帧走 JS；3 个 iframe 同时渲染【估计】 | 低：滚动不依赖主线程；远端 section 可用 content-visibility 跳过渲染【估计】 | 中：每次挂载 = 新建 iframe + 强制 layout【估计】 |
| 内存 | 最低：恒 3 容器 | 随浏览增长（每游戏一个常驻 iframe，估计每个轻量游戏 5–30MB【估计】）→ 必须配 LRU 池（见 §5.1） | 低：恒 3 面板 |
| 实现复杂度 | **高**：手势、惯性、阈值、回弹、轮转绑定全手写（demo A 已是最小实现仍约 130 行 JS） | **低**：核心是一行 CSS + IntersectionObserver（demo B 约 60 行 JS） | 中高：占位、锚定、挂载时序、防抖（demo C 约 50 行但边界情况多：快速甩动、滚动条拖拽【估计】） |
| iframe 兼容 | **差**：轮转 = 重设 src，实测必重载；历史屏状态全丢 | **好**：section/iframe 创建后永不移出 DOM，实测零重载 | **差**：卸载即销毁，实测滑 ±2 屏回来必重载 |
| 无限 feed | 天然支持（数据轮转绑定） | 天然支持（尾部追加 section） | 天然支持（占位高度任意） |

## 五、两个必须写清的坑与规避法

### 5.1 iframe 重载（本单点名问题）

**「scroll-snap 下 iframe 被卸载重载」并非 scroll-snap 的行为**——scroll-snap 只是滚动吸附策略，DOM 全程不动，实测滚走滚回零重载。真正的重载来源是**配套的回收策略**：只要回收 = 移除 DOM（方案 C 的卸载）或换绑 src（方案 A 的轮转），就必然重载（实测 §二）。规避法按优先级：

1. **保留式管理（本推荐）**：iframe 一旦加载，永不 detach、永不重设 src。滚出视口的 section 用 `content-visibility: hidden`（实测不重载，且跳过渲染省 CPU【估计】）或 `display: none` 压开销；
2. **懒加载**：IntersectionObserver rootMargin ±150%，进入预载区才创建 iframe（demo B 已实现）；
3. **LRU iframe 池**：保留式管理的代价是内存随浏览增长。设上限 N（建议初值 6，按真实游戏内存画像调整【估计】），超过时销毁「最久未见」的 iframe（LRU 依据 IntersectionObserver 的可见时间戳）。此时重载只发生在用户滑出 N 屏再远回的场景，代价可接受；
4. **（进阶）pause/resume 协议**：平台约定 `postMessage` 协议，滚出视口通知游戏暂停主循环/音频，回视口恢复。省电省帧，与重载问题正交但同属 feed×iframe 协作规范。

### 5.2 手势被 iframe 吞掉（三方案共通坑）

触摸/滚轮事件进入 iframe 后**不冒泡**到父页面。后果按方案：

- B/C（原生滚动）：iframe 内容不可滚动时，浏览器的滚动链（scroll chaining）通常会把滚动继续传给父级 scroller（本实测环境桌面 Chromium 行为如此；触屏行为未实测，【估计】与桌面一致）。因此「游戏页自身不可滚」是 B/C 可用的前提，需写入游戏接入规范；
- 游戏内部有拖拽玩法时，拖拽与 feed 滚动天然冲突，且 A 方案的手势层会挡住游戏的一切输入（demo A 的 gesture 层即此牺牲的演示）。

**规避法：激活层模式**（抖音/微信小游戏 feed 的通行做法【估计】）——feed 态给 iframe 盖透明层接管滑动手势；用户点「进入游戏」才撤层放行全部交互，同时提供显式退出把手（顶部返回条/边缘下滑）回到 feed 态。激活态下父级不再期待滚动手势，冲突消解。

## 六、其余工程注意点（B 方案落地相关）

- 每屏高度用 `100dvh` + `scroll-snap-align: start` + `scroll-snap-stop: always`（一次滑一屏）。`dvh` 随移动端地址栏收缩自适应【估计，需真机回归 iOS Safari】；
- 若未来出现高于视口的卡片（图文详情），`mandatory` 会强制吸顶导致中段不可停，需对该卡片降级 `proximity` 或改内部滚动【估计】；
- `overscroll-behavior-y: contain` 防滚动穿透到页面根。

## 七、结论

**推荐方案 B：CSS scroll-snap（mandatory 竖向）+ 保留式 DOM + LRU iframe 池**，理由：

1. **iframe 兼容是本项目的胜负手**，而 B 是三方案中唯一「零重载」的（实测 §三）：DOM 结构稳定，游戏状态天然保留。A 每翻一屏重载一格、C 滑两屏回来全重载（均实测），对「滑走再滑回」的核心体验是硬伤，除非接受状态丢失或引入比 B 更复杂的 iframe 池化；
2. **跟手性最优**：原生合成器滚动，不受主线程（游戏渲染）繁忙影响【估计】；A 的手写手势恰好在「3 个游戏同时跑」的最坏场景下最易掉帧；
3. **实现复杂度最低**：方案 B 的 demo 比方案 A 少一半代码且没有手势调参这类暗坑；后续维护（边界情况、无障碍、键盘滚动）全由浏览器承担；
4. 内存短板有明确规避法（懒加载 + content-visibility + LRU 池，§5.1），且规避法每一环都经实测验证不触发重载。

**已知代价与边界**：
- 必须遵守 §5.2 的激活层模式与「游戏页不可滚」接入规范，否则手势冲突；
- LRU 上限 N 的取值需要真实游戏的内存画像数据（本单未覆盖）；
- 移动端真机（尤其 iOS Safari 的 dvh/滚动链/snap 手感）未实测，落地前需真机回归。

**何时不选 B**：需要非滚动的花式转场（3D 卡片翻转、共享元素过渡）时回到 A；纯静态内容流（无 iframe、无状态）且列表极长（千级）时 C 的内存优势才成立。

## 附：实测与复现

- 实测 Ⅰ 的 harness 与实测 Ⅱ 的 Playwright 脚本在 worker 临时目录（`/tmp/games8-test/`，未入仓）；复现要点：同源 HTTP 下给 iframe 注入随机 `MARK`，操作后对比；demo 行为验证 = 读 srcdoc 子 frame 的 `#ts`/`#alive`。
- 所有 demo 均自包含（iframe 用 srcdoc 假游戏），`file://` 双击即开，人工观察要点：滚远再回，看「存活 N 秒」是否归零。
