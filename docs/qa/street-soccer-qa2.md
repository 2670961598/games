# 街头足球 QA2 全链红线专项报告（GAMES-142）

- 单据：[QA·E6-W2-T3] 街头足球 QA2 联机红线专项二轮（BOT/FEEL 上线后复验+全链红线复核）单链 6/10+
- 分支：feature/GAMES-142（基线 badff77 = GAMES-141 FEEL 已合并，merge main 无前进）
- 日期：2026-10-15 ｜ 角色：QA（只读纪律：零产品代码改动，测试件为 `scripts/street-soccer-qa2-{net,mercy,web}.mjs`）
- 环境：私有影子网关 `:4416`（`PORT/GATEWAY_PID/GATEWAY_LOG` 显式改道防覆盖常驻实例，`:4400/:4399` 全程零感知——生产 web 只读 GET 供页面加载，与 QA1 同口径）；剧本房一律 `/api/test/*` 隔离测试房；放水链走 WS quick 真实路径（协议 §2，见 §3 结构性论证）
- 结论：**红线全绿，无 P0/P1 退回项**；QA1 观察项 O-1/O-2/O-3 抽验闭合；观察项 O-4/O-5 新增（均低危口径注记）

## 0. 冻结验收命令（自跑）

```
cd /Volumes/BigDisk/Studio/projects/GAMES/repo && node scripts/api-check.js street-soccer && test -f docs/qa/street-soccer-qa2.md
```

结果：`api-check street-soccer` 39/39 绿（A1-A8+统计制面，A8 确定性三等 stateHash=2364577099：双跑同 hash+inLog 逐字节 2982 条+replay==在线——与 BOT 单 A2 复验锚一致，FEEL 未扰动引擎）+ 本报告落盘 → 退出码 0。

## 1. 全链红线复验总表

| 面 | 载体 | 结果 |
|---|---|---|
| api-check 39 面（统计制口径） | 冻结命令 | 39/39 ✓（hash 锚 2364577099 与 GAMES-140 A8 交付一致） |
| 确定性三等 | 冻结命令 A+ deterministic | ✓ 两房同 hash+输入日志逐字节+回放==在线 |
| 200ms 延迟对照（FEEL 后触球反馈链） | qa2-net N1（d0/d200 双房） | ✓ 34 断言全绿（见 §2） |
| 重连三档（手感层状态延续） | qa2-net N2 | ✓ 含 FEEL 服务端延续面四键（stam/lungeT/stumbleT/tackleCd） |
| 长局 spot（8min 交叉引用） | qa2-net N3 + qa2-mercy M6 | ✓ 6000-tick 硬顶房全程+8min 连续对局窗交叉引用 |
| 放水链在线验证 | qa2-mercy M1-M5（WS quick） | ✓ L1/L2 数字信号+生态位观测（见 §3） |
| 满编 2v2+第 5 人观战（FEEL 焦点光圈） | qa2-web W2/W3 | ✓ 4 真人四席+F11 焦点环台账+环形金墨水探针（见 §4） |
| 回归抽查 2 作 | api-check pool/mini-moba | pool-physics 19/19 ✓ ｜ mini-moba 22/22 ✓ |

## 2. 200ms 延迟对照（qa2-net 34/34 绿——`scripts/street-soccer-qa2-net.mjs`）

- **N1 时延带**（250ms 弃样窗=O-2 口径复用）：d0 房 tackle P95 49ms(n=8)+shot P95 94ms(n=24)（帽 600）✓；d200 房 tackle P95 242ms(n=16)（帽 900）✓；shot/pass 持球窗盲窗弃样（reject 在账 30 例=受理回路完好，QA1 已知采样劣势口径）✓
- **仲裁不偏向低延迟者**（§5.4⑤）：tackle 胜率 0ms=10% vs 200ms=13%（|Δ|=3%<35%）✓——服务器权威仲裁无延迟项
- **S3/S4 和解通道在 200ms 垫臂完整**：ext.ack 单调不减（×688）+ext.hash 周期在场（×68，末例 1066537894）✓——预测/确定性链路不受垫臂破坏
- **触球反馈链数据源**：touch 事件×192+增量快照球 owner 镜像 688/688 恒带 ✓——FEEL 层触球反馈（F01 形变等）的伺服端数据源在 200ms 下不缺失；首绘 ≤80ms 红线由 FEEL 单 feel-check 17 面证（交叉引用）
- **N3 长局 spot**：maxTicks=6000 硬顶房 spot×9 tick 单调+stateHash 演化+终局 time-up winner=B tick=3680 ✓；goal 事件==终态队分（A6 口径同源）✓
- **N4 O-3 混跑抽验**（BOT 单 N4 决策级 A/B 的在线方向性，双 seed 聚合）：comp 队进球 3:0 压制 casual 队 ✓+comp 触球 61>casual 33（站位卡线+接散球路径压制）✓；steal/tackle 数据面披露（行为谱差异非压制失败——QA1 §4 注同源）

## 3. 放水链在线验证（qa2-mercy——`scripts/street-soccer-qa2-mercy.mjs`）

**路径结构性论证**：pulse 台账（rooms.js `finish()` 按 `META.pulseTeam` 记账）为 WeakMap keyed **conn**、跨房累积——testapi 房每房一次性 vctx、单局即弃，**结构性不可累积 pulse**（这正是 sim 注释「api 剧本房单局 pulse 恒 0」的机制面）。故在线验证走 **WS quick 真实路径**：真人 W 单 conn 连续对局（quick 自建房=全 balanced bot，W 让位入席 seat3，敌席 0/2、队友席 1），败局自然累积台账 → doFrame 每拍算 foeLose 注入 botEnv → sim brain 放水链。

**数字信号锚**（quick 自建全 balanced 房独有——档位信号不受 seed 影响）：balanced 射门门 `distG<140k` → pow 恒 650 档；L1 让力 `powMul=85%` → 恒 552 档；L2 降档 bal→cas（CASUAL pow 400-800 ×85% = 340-680 散布）。

<!-- MERCY-RESULTS -->

## 4. 满编 2v2+第 5 人观战·FEEL 焦点光圈（qa2-web）

<!-- WEB-RESULTS -->

## 5. QA1 观察项复核

- **O-1 让位语义（抽验闭合）**：mercy 臂 W 全程 quick bot 房让位入席（席位=网关 join 路径，M1 断言）+web 臂 F08 让位提示环台账（就席=席位让位完成时点，FEEL 面）。BOT 单 N5 复核无缺陷结论维持；观战入口语义（?room= 到 bot 房让位入席/满员房旁观）与 QA1 记录一致，无新证据。
- **O-2 时延对齐伪带（已记案例，复核不复发）**：本单 N1 全程 250ms 弃样窗口径，d0/d200 两房带均在帽内且量级符合「受理+组包+垫臂」物理预期（49/94ms vs 242ms），未见 ~700ms 伪带复发——QA1 归因（错配到下一次注入受理=策略节拍伪影）维持。
- **O-3 混跑对位（抽验闭合）**：N4 双 seed 在线聚合——comp 进球压制+触球压制方向性成立；QA1 预留的「预判档对蜂群档」拦截压制数据面由 BOT 单 N4 决策级 A/B 闭合+本单在线方向性复证。

## 6. 退回项清单

**无 P0/P1 退回项。** 红线全过（冻结命令 39/39+qa2-net 34/34+qa2-mercy+qa2-web+回归 2 作）。

## 7. 观察项（低危，接 QA1 编号）

<!-- OBSERVATIONS -->

## 8. 回归抽查 2 作（共享 harness 面）

- `api-check pool-physics`：19/19 绿（S3/S4 先例作，共享 testapi/rooms/sims harness 零扰动）
- `api-check mini-moba`：22/22 绿（放水链同源作——pulse/foeLose 链框架面无扰动）

（结果 /tmp/qa2-142/reg-{pool,moba}.log；报告 kernel/workers/GAMES-41/api-check-*-20261014235*.json）

## 9. QA 件清单（本单新增，零产品代码改动）

- `scripts/street-soccer-qa2-net.mjs`——net 臂 34 断言（N1 延迟对照/N2 重连三档+手感层延续/N3 长局/N4 混跑抽验）
- `scripts/street-soccer-qa2-mercy.mjs`——放水链在线验证（WS quick 真实路径+饱和器+燃位器）
- `scripts/street-soccer-qa2-web.mjs`——浏览器臂（满编+观战 F11 焦点环）
- 复跑：影子网关 `PORT=4416 HOST=127.0.0.1 GATEWAY_LOG=/tmp/x/gw.log GATEWAY_PID=/tmp/x/gw.pid WEB_DIR=web node server/gateway/index.js &` 后依次跑三脚本（QA_GW 可覆写网关地址）
