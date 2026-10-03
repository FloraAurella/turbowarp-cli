# TurboWarp 纯命令行版：本轮交付审计

> 本文的275项测试、50个命令族和37条教程记录保留为上一轮冻结交付证据。2026-10-03 的 Agent 易用性改造新增统一 Node 入口、机器帮助、诊断/能力查询、结构化错误和声明式脚本；使用方式见 [Agent 指南](agent-usage.md)。当前改造[验证记录](agent-validation.md)为297/297测试与102条教程请求通过，不覆盖下方历史结果，也不改变原有 full-parity 发布门槛。

## 结论

**CLI 实验版已在本机完成统一回归和真实教程验证；用户要求的完整 GUI 功能对等仍未完成。** 本文不是 full-parity 完工证明。

- 固定 Node **24.18.0**、macOS arm64。
- 最终冻结全套：**275/275 通过，0失败，0跳过**，约70.17秒；运行前后所有 source/bin/test/package 哈希一致。
- **50 个命令族、389 个 schema 入口**；命令数量不是动作验收数量。
- **1304/1304 素材**、301 个冻结扩展、1610 个随附资源文件全量哈希校验通过。
- **37 条实际教程指令**通过，运行角色x=25、编辑角色x=0、noDOM=true；生成SB3/PNG/SVG/字体预览/HTML/ZIP/输入JSONL/录制帧。
- 原3个跨模块安全/事务问题已独立复验 **3/3**；原15项静态账本问题已修订复核结案，其中R13仅通过降为未确认候选，未批准iframe执行证据。
- 总账本 **1202条记录 / 1170个desktop实际动作**，`coverageComplete=false`；implementation/acceptance正式状态仍pending。
- `release:check` 当前退出 **2**，`releaseReady=false`；不降门槛使它返回0。

生产路径无Electron、无DOM、无隐藏浏览器、无TUI。未启动GUI/browser oracle，未新增git提交/推送；旧GLM额度工作流不是本轮依赖，本轮使用聊天默认模型子代理。

## 一、可复查证据

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 最终全套 | 275通过、0失败/跳过、sourceUnchanged=true | [full-tests.json](verification/full-tests.json)、[TAP](verification/full-tests.tap)、[精确测试名称](verification/exact-test-results.json) |
| 首次冻结回归 | 265/270、5失败；保留历史，不掩盖 | [initial JSON](verification/full-tests.initial.json)、[initial TAP](verification/full-tests.initial.tap) |
| 资源 | complete=true、missing0、invalid0 | [resources.json](verification/resources.json)、`npm run resources:check` |
| 开发期桌面基线 | frozenBaselineVerified=true、complete=true | [baseline.json](verification/baseline.json)、`npm run baseline:check` |
| 实验版交付 | resources+37命令tutorial+release预期退出2通过 | [delivery-check.json](verification/delivery-check.json)、`npm run delivery:check` |
| 三项安全修复复验 | 3/3、仅限定范围 | [security-recheck.json](verification/security-recheck.json) |
| 15项静态账本修复 | 14静态修复、1候选降级；非覆盖全验收 | [census-recheck.json](verification/census-recheck.json)、[复核说明](census/independent-review-notes.md) |
| 独立目录运行 | 无旁边desktop源目录，37命令实验交付检查再次通过；复用现有依赖而非全新安装 | [standalone-delivery.json](verification/standalone-delivery.json) |
| 禁止宿主字体加载 | fresh-process首次families0、pinned14→0 | `test/native-environment.test.js`、[观测](verification/native-font-observations.json) |
| 冻结原生字体/绘图回归 | 63/63、0失败/跳过 | [pinned-font-rendering.tap](verification/pinned-font-rendering.tap) |

最新完整教程产物：`examples/verified-NyZBQ4/`，其中 `verification.json` 和 `transcript.json` 保存真实指令及响应。失败的早期教程目录没有验证文件，不作为成功证据。

## 二、本轮修复与真实失败

首次冻结回归5项失败均已处理，而不是删除测试。

1. **安全读取错误兼容**：3项旧测试只接受ELOOP，新增逐父路径检查提前拒绝后错误文字不同。现在统一错误含ELOOP并设置code，仍拒叶/父符号链接，不恢复不安全读取。
2. **简单打包标题回归**：统一 `package` 到安全 `pack build` 后未保留文件名标题。未显式配置pack设置时恢复basename标题，仍正确HTML转义；用户显式pack设置优先。
3. **录制实际内存超限**：native canvas自动加载系统及用户字体，registry注册/释放产生非V8内存峰值。固定对照dispose高水位约550.94MiB，禁止隐式host字体后约183.84MiB。启动前的进程内bootstrap和worker环境禁用host发现，保留冻结/custom字体。固定两次240帧与两轮MP4/WebM压力最新峰值不超过约204MiB，512MiB上限未放宽，后120帧保留RSS增量、dispose字体数及child清理均验证。

独立安全审查确认并复验的3项：

- 绘图配置、剪贴、媒体等用户路径统一限额读取，叶/父符号链接拒绝；输出统一原子写策略。
- `runtime start --project` 先验证运行控制条件，通用 `--project` 保留原Project/VM直到整个命令成功，失败不清旧选择、历史、输入或设置。
- 所有device/input仅验证与入队；cloud/key/mouse/wheel等只在运行副本生效，不再以readonly状态改标准SB3或启动编辑脚本。

此外，教程验证发现并修复library/backpack/project-import等编辑入口缺少一次性 `--out` 保存路径；真实图库角色保存重开和已有输出拒绝后的原VM恢复已测试。

## 三、阶段状态

| 阶段 | 本轮已有实物 | 尚未关闭的退出门 |
| --- | --- | --- |
| M0 基线和资源 | 本地锁与上游pin、301扩展、81addons清单、1304素材双hash全部核对；资源随CLI附带 | 三平台安装复现、二进制分发法律合规未完成 |
| M1 动作账本 | 十区域、1202记录/1170实际动作、逐条候选argv/实现anchor/精确测试指针；15个旧问题修复 | 未确认候选、动态扩展按钮/OS roles边界及全动作独立验收仍未完成 |
| M2 原生尖峰 | ANGLE GLES3、672有效着色器组合、真实SVG/bitmap/pen/bubble/碰撞/触色；冻结声音图、WAV、SB3和packager | GUI图像/音频oracle、Paper、字体/抗锯齿/浏览器DSP差分待完成 |
| M3 指令引擎 | 会话/JSONL/schema、原子失败回滚、target/asset UUID、99/200MiB历史、独立运行副本 | 不保证所有GUI编辑器细粒度历史或跨会话历史等价 |
| M4 编辑 | 多格式I/O、四类图库/背包、角色/变量/列表/监视器/过程、积木图安全、广泛绘图/声音选区/字体 | 填充坐标命中、stroke/text/image/use擦除、复杂ungroup、Paper曲率/笔刷、部分字体/菜单/恢复槽等缺失 |
| M5 运行 | 批量与持续fork、解释/编译、seed/watch/trace、pause/step/断点/回答/clone、按帧输入 | 指定script/reporter点击执行、全部debugger opcode/日志、GUI调度golden、无限clones等未完成 |
| M6 扩展/权限/设备 | 本地云、精确授权、离线目录、安全4ID、预录传感/映射、冻结BLE/BT parser mock、81addons配置 | 任意扩展独立受限执行、TTS/翻译/Face识别、六硬件/振动及所有addon语义未验收 |
| M7 打包和偏好 | 58叶选项、8局部reset、HTML/ZIP/one-asset及官方WebView Mac下载缓存封装、兼容偏好文件 | 其它11下载目标真实封装/平台播放、数据提供器转包、有效桌面行为/locale全覆盖未完成 |
| M8 终验 | 本机275 tests、37命令教程、资源和安全修复证据、真实MP4/WebM帧/音频验收 | 逐动作正式验收、GUI差分、真实设备、三平台、性能基线仍阻full-parity |

## 四、不能借范围决策掩盖的缺口

D1仅批准内部离屏输出；D3仅本地云等价；D4旧用户库迁移归桌面；D5默认deny/精确grant；D6未来DOM插件不承诺；D7仅实时摄像头/麦克风可以预录替代。这些不豁免以下未实现语义。

- 自定义非DOM扩展安全执行与扩展按钮callback。
- 整项目 `projectaudio` 时间线、SoundBank promise、pitch/pan/loops/音乐和视频同步；当前明确NOT_YET_SUPPORTED，默认false与GUI不同。
- videoSensing/Gamepad记录数据转包，不能输出缺opcode或悄然转实时摄像头产物。
- 真实硬件scan/connect/sensor/output、固件与振动；mock parser通过不是实机通过。
- Paper填充/复杂擦除/组合透明与clip保真、曲率/brush、监视器PNG。
- 系统字体实际外观、多语缺字、复杂shaping、抗锯齿。冻结Sans Serif部分Unicode实际是同缺字方框，不能以一致像素声称语言支持。
- 项目标题/专用删除恢复槽、自动恢复间隔/删除恢复点、指定脚本执行、全部返回过程编辑等账本未映射行为。
- Scratch ID/token远端取项目与散装资产组装、其它扩展服务。
- Windows/Linux运行和所有打包平台播放、性能对照与完整GUI图像/声音差分。

详细逐条 `requiredMissing` 见 [action-acceptance.md](census/action-acceptance.md)。最后静态映射保留726条实际CLI候选、596条实现与精确测试候选、185条未映射；66个独立精确测试的648处引用已按最终TAP名称及冻结文件hash绑定通过。37条候选仍需独立动作语义范围批准。该账本即使对应测试运行通过，也必须另审是否覆盖本动作全部语义，所有正式动作仍pending，不能自动改verified。

## 五、权限和验证边界

- 不执行任意用户JS，不用进程内 `node:vm` 冒充安全沙箱。授权custom JS只可写入产物；产物本身也不是恶意代码沙箱。
- 描述符有界读取、O_NOFOLLOW/O_NONBLOCK、父路径检查、独占临时文件/fsync/hash回读/原子提交；不承诺对抗同用户进程所有目录竞态。
- 预录输入队列不进入标准SB3，需要显式JSONL保存。外部云写和已导出文件不随项目undo回滚。
- 安全修复复验只关闭其原3项，不代表全权限模型已等价，故 `permissions.verified=false`。
- 没有明确GUI/browser oracle授权，未启动任何前端用于对拍。三平台/真实设备也没有执行证据。`acceptance-evidence.json` 六门均保留false及具体原因。

## 六、实际复验指令

在CLI目录，Node24在PATH内：

```bash
npm test
npm run resources:check
npm run tutorial:smoke
npm run delivery:check
npm run release:check
```

开发期保留完整桌面快照时还可运行：

```bash
npm run baseline:check
python3 docs/census/coverage-check.py
python3 docs/census/check-action-acceptance.py
```

`delivery:check` 只要求实验功能可运行、资源齐、教程成功，以及full-parity门仍正确拒绝。`release:check` 的退出2是当前真实未完状态，不能当实验版功能失败，也不能当完整完工成功。
