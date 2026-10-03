# TurboWarp CLI（tw-cli）

在终端中创建、编辑和运行 Scratch 项目，并导出 `.sb3`、舞台图片、HTML 或 ZIP。适合批量处理项目、自动化测试，以及让 Agent 通过结构化指令创作作品。

CLI 使用 TurboWarp 的运行时和打包工具，运行时不启动 Electron 或浏览器。导出的 HTML 可以在浏览器中播放，CLI 不会自动打开它。

**当前版本：0.1.0 实验版。** 已在 macOS arm64 上验证，要求 Node.js 24。完整 GUI 功能对等、Windows/Linux 安装和真实硬件支持仍未完成验收。详细边界见 [当前能力与限制](docs/current-limitations.md)。

## 安装

获取源码并进入项目目录：

```bash
git clone https://github.com/FloraAurella/turbowarp-cli.git
cd turbowarp-cli
```

准备 Node.js **24.x**、Git、Python 3 和本机 C/C++ 编译工具链，然后在项目根目录执行：

```bash
node --version
python3 --version
npm ci --registry=https://registry.npmjs.org
./tw doctor --json
```

`node --version` 应显示 `v24.…`；`doctor` 输出的 `ok: true` 表示 Node 与所需原生依赖能加载。首次安装需要联网，日常使用随附素材库不需要联网。这里只说明源码安装，尚未发布 npm 包。

macOS 可通过 `xcode-select --install` 安装编译工具。其他平台的安装尚未验证；Windows 终端可用 `node bin/tw.js` 代替 `./tw`，但这不代表 Windows 原生依赖已通过验收。

如果已经安装 Node 24，但启动时选择了其他版本，可指定本机可执行文件：

```bash
export TW_NODE='/你的/Node24/bin/node'
./tw doctor --json
```

安装依赖时也应使用 Node 24 的 `node` 和 `npm`。`TW_NODE` 控制 CLI 启动，不会替换执行 `npm ci` 的 Node。诊断输出中的 `hints` 会提示缺少或无法加载的依赖。

## 第一个项目

下面的命令适用于 macOS/Linux 的 Bash 或 Zsh。从项目根目录开始，新建一个输出目录：

```bash
mkdir my-first-project
cd my-first-project

# 1. 创建包含默认角色的项目
../tw new demo.sb3

# 2. 添加“点击绿旗 → 移动 25 步”，并保存到原项目
../tw script demo 25 --project demo.sb3 --out demo.sb3

# 3. 运行两帧，保存舞台图片
../tw run --project demo.sb3 --frames 2 --out result.png

# 4. 导出可用浏览器打开的 HTML
../tw package demo.html --project demo.sb3
```

完成后会得到：

| 文件 | 用途 |
| --- | --- |
| `demo.sb3` | 可继续编辑的 Scratch 项目 |
| `result.png` | 本次运行后的舞台图片 |
| `demo.html` | 可用浏览器打开并点击绿旗播放的作品 |

`run` 的 JSON 结果中，`Sprite1` 的 `x` 应为 **25**。运行使用独立副本，`demo.sb3` 中保存的初始位置仍是 **0**。输出目录必须是新目录；再次执行时请换目录或文件名，以免与已有产物冲突。

完整的新手流程见 [分步教程](docs/quickstart.md)。

## 连续编辑一个项目

一次性命令适合脚本调用；连续操作时使用会话更方便。在上面的 `my-first-project` 目录执行：

```bash
../tw session
```

进入会话后，逐行输入下面的命令，**不再加 `../tw`**：

```text
open demo.sb3
sprite rename 小猫
sprite set x -100
sprite set y 20
render initial.png
save 小猫.sb3
run --frames 2 --seed 1234 --out moved.png
package 小猫.html
quit
```

`initial.png` 显示编辑时的初始位置；`moved.png` 显示运行后的舞台。由于刚才的脚本移动 25 步，运行结果为 `x = -75`、`y = 20`。`save` 保存编辑状态，`run` 不会把运行结果写回项目。

会话中可用 `undo`、`redo` 和 `history` 查看或恢复编辑记录。退出前需要保存；明确放弃修改时用 `quit --force`。历史只在当前进程中保留。

## 先记住这几个参数

| 用法 | 含义 | 示例 |
| --- | --- | --- |
| `--project 文件.sb3` | 为本次命令读取项目 | `../tw info --project demo.sb3` |
| 编辑命令的 `--out 文件.sb3` | 保存修改后的项目 | `../tw sprite set x 10 --project demo.sb3 --out edited.sb3` |
| `run --out 文件.png` | 保存运行后的图片 | `../tw run --project demo.sb3 --frames 2 --out another.png` |
| `render 文件.png` | 导出当前舞台，不启动绿旗脚本 | `../tw render preview.png --project demo.sb3` |
| `package 文件.html` / `文件.zip` | 导出可播放作品 | `../tw package game.zip --project demo.sb3` |
| `--force` | 明确覆盖已有输出，或在退出时丢弃修改 | `../tw run --project demo.sb3 --frames 2 --out result.png --force` |

每次单独执行 CLI 都是新进程，上一条命令的选择和未保存修改不会自动延续。**一次性编辑要带 `--out`；会话内编辑要执行 `save`。** 原项目路径允许正常保存；其他已存在的输出路径默认拒绝覆盖。

资源、配置和高级打包导出通常使用位置参数或 `--output`，以该命令的帮助为准。

## 编写自己的积木脚本

`script demo` 是入门示例。创作自己的行为可以使用 JSON：每个 `scripts` 数组是一段积木链，`opcode` 指定积木，`inputs` 指定输入。

在 `my-first-project` 目录将以下内容保存为 `script.json`：

```json
{
  "version": 1,
  "scripts": [[
    {"opcode": "event_whenflagclicked"},
    {"opcode": "motion_movesteps", "inputs": {"STEPS": 100}},
    {"opcode": "looks_say", "inputs": {"MESSAGE": "你好，TurboWarp CLI！"}}
  ]]
}
```

用一个新项目验证、应用并运行，避免叠加到前面的示例脚本：

```bash
../tw new recipe.sb3
../tw script validate script.json --project recipe.sb3
../tw script apply script.json --project recipe.sb3 --out recipe.sb3
../tw run --project recipe.sb3 --frames 2 --seed 1234 --out recipe.png
```

运行结果的 `Sprite1.x` 应为 **100**。`validate` 只检查；`apply` 追加积木，重复调用会重复追加。条件、循环、变量、输入回放和断点示例见 [Agent 与脚本指南](docs/agent-usage.md)。

## 自动化与 Agent

从项目根目录查询命令格式与能力：

```bash
./tw --help
./tw help script --json
./tw blocks schema motion_movesteps
./tw capabilities --json
```

`./tw session --jsonl` 接收每行一条 `{id, command, args}` 请求，按顺序处理，并返回带 `ok` 字段的 JSON。`args` 是字符串数组；日志进入 stderr。自动化必须检查每条响应的 `ok`，默认会话会在单条失败后继续。使用 `--fail-fast` 可在首次错误后停止。

三个完整示例会调用真实 CLI、保存并重新打开项目，然后检查运行结果：

```bash
npm run example:basic   # 新建 → 本地素材 → 积木脚本 → 保存 → 运行
npm run example:input   # 空格键输入回放
npm run example:debug   # 错误修正、断点与单步
```

每次生成新的输出目录，路径打印到终端；目录中包含项目、图片、`transcript.json` 和 `verification.json`。协议、退出码和完整示例见 [Agent 与脚本指南](docs/agent-usage.md)。

## 教程与命令参考

| 想做什么 | 阅读 |
| --- | --- |
| 从安装开始，完成第一个作品 | [分步教程](docs/quickstart.md) |
| 查命令和选项 | `./tw help 命令族` 或 [命令参考](docs/command-reference.md) |
| 导入项目、管理素材库、背包和恢复点 | [项目与文件](docs/project-io-usage.md) |
| 编辑积木、过程、变量和插件设置 | [积木与插件](docs/block-addon-usage.md) |
| 绘制造型、处理位图/矢量、编辑声音 | [绘图与声音](docs/paint-asset-usage.md) |
| 使用内置或自定义字体 | [字体](docs/font-usage.md) |
| 查看运行状态、变量、trace 和断点 | [运行与调试](docs/runtime-usage.md) |
| 回放预录输入 | [设备数据](docs/device-usage.md) |
| 录制帧/视频、配置手柄映射 | [录制与手柄](docs/record-gamepad-usage.md) |
| 配置 HTML/ZIP 打包和权限 | [打包与扩展](docs/package-extension-usage.md) |
| 使用 JSON 脚本和 JSONL 协议 | [Agent 与脚本指南](docs/agent-usage.md) |

## 验证与常见问题

从项目根目录执行：

```bash
./tw doctor --json
npm run resources:check
npm run tutorial:smoke
```

它们分别检查运行环境、本地资源和示例流程。完整 `npm test` 与 `baseline:check` 中的部分开发测试还需要旁边的冻结 `desktop-master` 快照，独立源码安装请先使用以上检查。

| 现象 | 处理方法 |
| --- | --- |
| 提示需要 Node 24，或原生依赖无法加载 | 检查 `node --version` 与 `doctor`；用 Node 24 安装依赖，再启动 CLI |
| 编辑后没有生成新的 SB3，退出码为 2 | 一次性命令补上 `--out`；会话中执行 `save` |
| 输出文件已存在 | 换路径，或确认可以覆盖后加 `--force` |
| 文件已经运行，重新打开却还是初始坐标 | `run` 使用副本，这是预期行为；改变初始状态要编辑项目并保存 |
| 会话 `quit` 提示未保存 | 先 `save`，或用 `quit --force` 丢弃 |
| `release:check` 退出码为 2 | 完整 GUI 对等发布门尚未通过，与 Node/资源检查的结果分开判断 |

`./tw check` 可查看详细验收状态；目前 `releaseReady` 为 `false`。功能和平台限制见 [当前能力与限制](docs/current-limitations.md)，已有验证记录见 [交付审计](docs/completion-audit.md)。

## 安全状态

冻结依赖的 npm 审计报告了 **23 项问题，其中 8 项为高危等级**。当前作为实验版源码公开，依赖升级与兼容性验证尚待单独处理；详情和报告见 [安全说明](SECURITY.md)。

## 项目结构

```text
bin/        CLI 入口
src/        项目编辑、运行、导出和安全边界实现
resources/  离线素材、素材目录和冻结扩展资源
vendor/     保留来源和许可证的上游代码
scripts/    示例、文档生成和验证工具
test/      开发测试
docs/      教程、命令参考与验收记录
examples/   运行示例后生成的项目和验证产物
```

## 许可证

CLI 代码采用 **GPL-3.0-only**，完整文本见 [LICENSE](LICENSE)。直接使用的 GUI 音频代码在 `vendor/scratch-gui-audio/` 中保留许可证、上游提交和文件哈希；VM、渲染器、打包工具、扩展和素材各自的许可仍适用。

这是独立的社区项目，与 TurboWarp、Scratch 或 MIT 没有官方隶属或背书关系。第三方代码、扩展、字体与素材保留各自许可，详见 [第三方版权说明](THIRD_PARTY_NOTICES.md)。

此次公开的是实验版源码；开发和发布要求见 [贡献指南](CONTRIBUTING.md) 与 [开源许可说明](docs/open-source.md)。带依赖的可执行包发布前，还需要核对完整依赖树及对应源码。
