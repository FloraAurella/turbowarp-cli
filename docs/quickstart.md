# 分步教程：从安装到第一个可播放作品

这份教程适合第一次使用 tw-cli 的用户。先完成安装与基础练习，再按需要学习素材、绘图、声音和调试。命令会生成真实的项目和输出文件。

当前是实验版，要求 Node.js 24，已在 macOS arm64 上验证。平台和功能边界见 [当前能力与限制](current-limitations.md)。本文终端示例使用 Bash/Zsh；`bash` 代码块在系统终端执行，`text` 代码块在 CLI 会话内逐行输入，`json` 代码块保存为文件。

## 1. 安装并检查环境

在含有 `package.json` 和 `tw` 的项目根目录执行：

```bash
node --version
python3 --version
npm ci --registry=https://registry.npmjs.org
./tw doctor --json
./tw --help
```

Node 版本应为 `v24.…`。依赖含原生模块，需要本机 C/C++ 编译工具链；macOS 可用 `xcode-select --install` 安装。首次安装需要网络。

`doctor` 输出中，`ok: true` 表示启动所需环境可用。出现 `ok: false` 时，先根据 `hints` 修正环境，再继续。若 CLI 找不到已经安装的 Node 24：

```bash
export TW_NODE='/你的/Node24/bin/node'
./tw doctor --json
```

请把占位路径换成本机路径。`TW_NODE` 控制 CLI 启动；安装依赖仍需要让终端中的 `node` 和 `npm` 使用 Node 24。

## 2. 创建、运行并导出第一个作品

从项目根目录新建练习目录：

```bash
mkdir my-first-project
cd my-first-project
```

接下来的练习都在这个目录中操作。`../tw` 指向上一层的 CLI 入口，所有相对输出路径都位于当前练习目录。若目录已经存在，换一个新名字，避免覆盖以前的作品。

**创建项目：**

```bash
../tw new demo.sb3
```

生成 `demo.sb3`，包含默认角色 `Sprite1`，初始坐标为 `(0, 0)`。

**添加行为并保存：**

```bash
../tw script demo 25 --project demo.sb3 --out demo.sb3
```

`script demo 25` 添加“点击绿旗 → 移动 25 步”。`--project` 读取项目，`--out` 保存修改。这里保存到原路径；运行一次即可，重复执行会追加另一段脚本。

**运行并查看结果：**

```bash
../tw run --project demo.sb3 --frames 2 --seed 1234 --out result.png
```

命令触发绿旗并推进两帧，输出一条 JSON，同时生成 `result.png`。在 JSON 的 `targets` 中找到 `name: "Sprite1"`，其 `x` 应为 **25**。`--seed` 固定随机种子，方便复现使用随机数的项目。

**确认项目仍保存初始状态：**

```bash
../tw info --project demo.sb3
```

`Sprite1.x` 应为 **0**。这是预期行为：运行发生在独立副本里，不会把运行坐标写回 SB3。

**导出可播放作品：**

```bash
../tw package demo.html --project demo.sb3
../tw package demo.zip --project demo.sb3
```

| 产物 | 如何使用 |
| --- | --- |
| `demo.sb3` | 在 CLI 中继续编辑，或用支持 SB3 的编辑器打开 |
| `result.png` | 用图片查看器检查运行后的舞台 |
| `demo.html` | 用浏览器打开，点击绿旗播放 |
| `demo.zip` | 解压后打开其中的 HTML 入口 |

CLI 不会自动打开图片或浏览器。再次导出到已存在的路径会报错；可以改文件名，或确认可覆盖后使用 `--force`。

## 3. 在会话中编辑角色

仍在 `my-first-project` 目录，启动会话：

```bash
../tw session
```

现在输入的是会话指令，不加 `../tw`。逐行输入：

```text
open demo.sb3
sprite rename 小猫
sprite set x -100
sprite set y 20
info
render initial.png
save 小猫.sb3
run --frames 2 --seed 1234 --out moved.png
package 小猫.html
quit
```

这组操作先把角色初始位置改为 `(-100, 20)`，再保存和运行。预期结果：

- `info` 显示小猫位于 `(-100, 20)`。
- `initial.png` 是当前编辑舞台，未启动绿旗脚本。
- `moved.png` 是运行后的舞台，JSON 中小猫位于 **`(-75, 20)`**。
- `小猫.sb3` 保存的是初始位置 `(-100, 20)`；`小猫.html` 包含该项目和移动脚本。
- 因为已经保存，`quit` 正常退出。

含空格的名称用引号，例如 `sprite rename '我的角色'`。有多个角色时，先用 `sprite list` 查看，再用 `sprite select 名称或ID` 切换编辑目标。

要继续编辑，重新执行 `../tw session`，输入 `open 小猫.sb3`。然后可以练习撤销：

```text
sprite set x 100
undo
info
redo
info
history
save
quit
```

`undo` 后 `x` 为 `-100`，`redo` 后为 `100`；最后 `save` 写回当前项目路径。历史只在当前进程内保留，最多 99 个共享快照，并有 200 MiB 的预算。

## 4. 理解保存、运行和导出的区别

| 操作 | 是否改变编辑状态 | 是否写入项目文件 |
| --- | --- | --- |
| `sprite set`、`script apply` 等编辑命令 | 是 | 会话中需 `save`；一次性命令需 `--out` |
| `save` | 保存现有编辑状态 | 是 |
| `render` | 否 | 写图片，不写 SB3 |
| `run` | 在运行副本中执行 | 不写 SB3；`--out` 写图片 |
| `package` / `pack build` | 否 | 写可播放产物，不替代项目保存 |

每次单独执行 `../tw` 都是新进程，不会继承前一条命令的目标选择或未保存修改。例如，终端中修改角色初始位置应写成：

```bash
../tw sprite set x -100 --project demo.sb3 --out edited.sb3
../tw render edited-preview.png --project edited.sb3
```

一次性编辑省略 `--out` 时，修改不会保存，进程退出码为 **2**。会话在有未保存修改时也会阻止正常 `quit`；明确丢弃才使用 `quit --force`。

`--out` 的含义取决于命令：编辑时是 SB3，`run` 时是 PNG。资源和配置导出一般使用位置路径或 `--output`，可用 `../tw help 命令族` 查看。

## 5. 编写自己的积木脚本

下面创建一个全新项目，避免把新脚本叠加到 `demo.sb3` 上。在 `my-first-project` 目录将以下 JSON 保存为 `script.json`：

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

这是一段“绿旗 → 移动 100 步 → 说话”的积木链。`opcode` 是积木名称，`inputs` 是输入值；`scripts` 中可以放多段积木链。

在系统终端执行：

```bash
../tw new recipe.sb3
../tw script validate script.json --project recipe.sb3
../tw script apply script.json --project recipe.sb3 --out recipe.sb3
../tw run --project recipe.sb3 --frames 2 --seed 1234 --out recipe.png
```

`validate` 成功时返回 `valid: true`，只检查格式和积木连接，不修改项目。`apply` 追加积木并通过 `--out` 保存；运行结果的 `Sprite1.x` 应为 **100**。

注意：`apply` 是追加操作，重复调用会重复添加脚本。查看支持的输入格式或循环/条件示例：

```bash
../tw help script --json
../tw blocks schema motion_movesteps
../tw blocks schema control_repeat
```

项目根目录的 `scripts/recipes/basic.json` 和 `scripts/recipes/input.json` 提供现成配方。变量需要先创建，资源名称需要与当前目标匹配；嵌套条件、资源引用和节点映射见 [Agent 与脚本指南](agent-usage.md)。

## 6. 用 JSONL 批量执行

仍在 `my-first-project` 目录，在系统终端执行整个代码块：

```bash
../tw session --jsonl --fail-fast <<'EOF'
{"id":1,"command":"new","args":[]}
{"id":2,"command":"script","args":["demo","25"]}
{"id":3,"command":"save","args":["automation.sb3"]}
{"id":4,"command":"run","args":["--frames","2","--seed","1234","--out","automation.png"]}
{"id":5,"command":"quit","args":[]}
EOF
```

每行是一条请求，`args` 中的数字也写成字符串。成功响应带有相同的 `id`、`ok: true` 和 `result`；错误响应带有 `ok: false`、`error` 和结构化的 `errorInfo`。

完成后生成 `automation.sb3` 和 `automation.png`，运行结果的角色 `x` 为 **25**。`--fail-fast` 会在首个错误后停止处理；不加这个选项时默认继续。无论哪种模式，都应检查每条响应的 `ok`，不能只看进程退出码。

以下是可选的进阶练习。`text` 代码块均在会话中运行；需要先打开项目，完成编辑后保存。声音文件、节点 ID、积木 ID、背包路径和 ffmpeg 路径需要替换成自己实际使用的值。

## 7. 不联网使用素材库

在 `my-first-project` 目录运行 `../tw session`，先输入 `open 小猫.sb3`，再输入以下命令：

```text
library status
library search sprite Cat --limit 5
library load sprite 'Cat 2'
library search backdrop Blue --limit 5
save 素材项目.sb3
```

图库返回素材名称与0-based索引，任选一个 `library load sprite 名称或索引`。costume/sound/backdrop 同理。1304个素材本地齐备；缺文件会报错，不暗中下载。

需要文件背包时：

```text
backpack use /绝对路径/我的背包
backpack save sprite 小猫
backpack list
```

背包加载用 `backpack load 列表返回的UUID`；这是显式文件库，不读取旧浏览器用户数据。

## 8. 绘图：简单数值命令

在会话中：

```text
asset blank costume 画布 --mode vector --width 100 --height 80
paint rectangle 画布 --spec '{"x":5,"y":5,"width":30,"height":20,"fill":"#00ff00"}'
paint ellipse 画布 --spec '{"cx":60,"cy":35,"rx":15,"ry":10,"fill":"#0000ff"}'
paint nodes 画布
asset export costume 画布 drawing.svg
render drawing.png
save 绘图项目.sb3
```

`paint nodes` 返回节点ID。精确选区、样式和剪贴使用这些ID：

```text
paint style 画布 --nodes 节点ID --fill '#ff0000' --alpha 0.6
paint copy 画布 --nodes 节点ID --output clip.json
paint paste 画布 --from clip.json --dx 10 --dy 5
```

copy 文件是当时快照，不是指向源造型的动态引用。节点/资源导出用 `--output` 或位置路径；`--out` 保留给SB3。更多路径点、位图和渐变见 [绘图与资产教程](paint-asset-usage.md)。Paper精度及复杂几何仍未全部对等。

## 9. 声音选区

这是可选练习，需要先准备自己的 WAV 文件，再把示例中的绝对路径替换为实际路径。`sound add` 后请用 `asset list sound` 确认名称；下面假定名称为 `tone`。

```text
sound add /绝对路径/tone.wav
asset list sound
asset effect sound tone reverse --range 0.1,0.5
asset copy sound tone --range 0.1,0.5 --output clip.wav
asset paste sound tone --from clip.wav
sound render tone processed.wav --volume 50
save 声音项目.sb3
```

时间单位为秒。选区、粘贴位置、原生音效和不同采样率规则见 [声音编辑](paint-asset-usage.md)。`sound render` 渲染指定资源，不是整个项目音轨录制。

## 10. 真正持续调试

```text
open demo.sb3
runtime start --paused --no-compile --seed 1234 --trace 100
runtime step --frames 2
runtime status
runtime trace get --limit 20
runtime stop
```

`runtime start` 创建长期运行副本；暂停/单步不会修改编辑项目。`runtime step` 是 primitive单步，`--frames` 是帧推进。

有变量和积木ID时：

```text
runtime start --paused --no-compile
runtime watch add 得分
runtime breakpoint add 积木ID
runtime resume
runtime pause
runtime breakpoint hits
runtime watch samples --limit 10
runtime answer '你的回答'
runtime stop
```

编译模式不支持积木trace/断点/单步，仍可暂停和帧推进。每个运行副本有明确帧数、生命周期和日志容量限制。

## 11. 预录输入：没有真实设备弹窗

```text
input key space down
device loudness 64 --frame 0
device mouse 10 20 down --frame 1
device input-list --output inputs.jsonl
run --frames 3
```

这些只入会话队列，**不会向编辑 VM 注入，不会改标准项目或启动编辑脚本**；在运行副本对应帧生效。需要项目包含相应感知/事件积木才能观察行为。队列不存入SB3，用JSONL文件保留：

```text
open demo.sb3
device replay inputs.jsonl
run --frames 3
```

摄像头/麦克风用预录图片/WAV替代；live设备仍拒绝。设备命令和纯数据手柄映射详见 [设备输入](device-usage.md)、[Gamepad](record-gamepad-usage.md)。

## 12. 输出离屏帧和视频

```text
open demo.sb3
record start 新帧目录 --duration 0.2 --fps 10 --projectaudio false
```

输出 PNG、帧像素/hash与 `manifest.json`。目录必须不存在，默认不覆盖。项目音轨 `projectaudio=true` **尚未支持**，不会悄悄输出静音成功。

本机编码视频需要每条命令精确授权已安装的程序：

```text
record start 新视频目录 --duration 1 --format mp4 --projectaudio false --allow 'encoder:/opt/homebrew/bin/ffmpeg,probe:/opt/homebrew/bin/ffprobe'
```

WebM改为 `--format webm`；声音使用显式 `--audio-track 文件.wav` 或预录麦克风轨。不会采集真实麦克风。编码限额和全项目声音缺口见 [录制教程](record-gamepad-usage.md)。

## 13. 打包高级设置与权限

```text
open demo.sb3
pack set app.windowTitle '我的游戏'
pack set framerate 60
pack build game.html
pack build game.zip --target zip-one-asset
pack export pack-options.json
```

简单 `package 文件.html` 与 `pack build` 共用安全路径。高级敏感选项需要**设置和构建时分别授权**：

```text
permission list
pack targets
ext list
ext doc pen
addon list
addon commands paint-snap
```

目录和配置可查看，不代表所有扩展/插件可执行。任意扩展执行仍拒绝；videoSensing/Gamepad预录项目转包也未完成，明确失败而不是产出缺积木包。

## 14. 字体、监视器和设置

```text
font builtins
font add-builtin Pixel MyPixel
font measure MyPixel Hello --size 24
font render MyPixel Hello --size 24 --width 200 --height 60 --output font.png
var add 得分 5
monitor add 得分
monitors mode 得分 slider
monitors range 得分 0 100
settings set turbo on
settings store
save 配置项目.sb3
```

字体资产跟随标准SB3保存；系统字体只保存metadata，不依赖宿主字体库。监视器状态可保存和编辑，但PNG尚未包含GUI监视器面板。

## 15. 查看真实验收状态

会话中先 `save`、`quit`，然后从 `my-first-project` 执行 `cd ..` 回到项目根目录：

```bash
./tw check
npm run resources:check
npm run tutorial:smoke
npm run release:check
```

`resources:check` 应通过；`release:check` 目前退出2，原因是完整功能、逐动作验收、GUI图像/声音差分、真实设备、三平台和性能门尚未全部通过。更多参数使用 `./tw help 指令族` 和 [实际命令参考](command-reference.md)。
