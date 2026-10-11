# Agent 与脚本使用指南

本轮接口保持纯 CLI 和原有 JSONL 协议。推荐按“查询能力 → 查询积木 → 校验 → 创建 → 保存 → 重开 → 运行 → 检查结果”的顺序使用。命令可用与本机功能测试通过不代表完整 GUI 对等；发布验收继续使用 `tw check`。

修改已有项目优先使用 [原生项目读写与 JavaScript SDK](project-agent-usage.md)：`project read/find/validate/apply/exec` 提供保留节点身份的代码读改写闭环和一次批量提交。本文的版本 1 配方继续用于追加新脚本。

## 1. 环境诊断与统一入口

```bash
./tw doctor --json
./tw help --json
./tw help script --json
./tw capabilities --json
```

仓库的 `./tw`、npm 安装生成的 `tw` 和项目 npm 脚本共享 Node 选择逻辑：显式 `TW_NODE` 优先，其次当前 Node 24，再尝试已验证的 `~/.nvm/versions/node/v24.18.0/bin/node`。显式配置为空、不可执行或不是 Node 24 时失败，不回退。路径含空格时使用引号：

```bash
TW_NODE='/绝对路径/Node 24/bin/node' ./tw doctor --json
TW_NODE='/绝对路径/Node 24/bin/node' npm test
```

PATH 为 Node 26 时，轻量入口仍能诊断并选用 Node 24；在加载原生依赖前完成选择。`doctor` 返回 `schemaVersion:1`、`ok`、当前和选中的路径/版本、平台/架构、候选探测结果、canvas/resvg/GLES/web-audio 可加载性及 `hints`。环境可用退出0，否则退出1，不自动安装或修改环境。其他机器需显式提供本机 Node 24，固定回退路径不是安装机制。

## 2. 发现命令和积木

`help --json` 的 `commands` 来自执行命令使用的同一份参数规则。传命令族可限制结果规模，例如 `help run --json`。目录包含位置参数名称、传输类型、数量、选项、已知默认值、项目要求、访问方式、保存方式和可解析示例。

尚未补齐的语义用 `null`、`semanticKnown:false` 或 `defaultKnown:false` 表示；空的 `examples` 不表示该命令没有用法。所有 `args` 的传输类型仍为字符串，数值/路径等语义可见选项的 `semantic`。不要把 `default:null` 当成实际默认值。

```bash
./tw blocks schema
./tw blocks schema motion_movesteps
./tw blocks schema looks_costume --project demo.sb3 --target 小猫
```

不传 opcode 时列出可查询积木。单个 schema 包含形状、输入类型、菜单 opcode、字段、静态选项、示例及 `exampleRequires`。查询携带项目时，字段的 `menu` 还包含当前目标可用的动态资源；`blocks field-menu`、`var list`、`list all`、`broadcast list` 和资产列表继续可用。`sensing_of` 的属性取决于 OBJECT，精确候选可用现有积木的 `blocks field-menu` 查询。

无项目时 `available:null` 表示未验证当前运行时可执行性。`recipeSupported` 表示声明式格式的形状支持，仍需当前项目加载该能力并满足资源要求。过程继续使用 `proc` / `blocks procedure-*`。资源型字段的示例需要按 `exampleRequires` 填入实际名称或 ID；不能把模板当成已校验脚本。

`capabilities --json` 分别返回 `implemented`、`unsupported`、使用条件和验收范围。例如 `record` 可输出离屏帧和使用外部 WAV，但 `whole-project-audio` 仍明确未支持。`check` 保留完整验收语义和发布门槛。

## 3. 一次创建完整行为

将以下内容保存为 `script.json`：

```json
{
  "version": 1,
  "scripts": [
    [
      {"opcode": "event_whenflagclicked"},
      {"opcode": "motion_movesteps", "inputs": {"STEPS": 100}},
      {"opcode": "looks_say", "inputs": {"MESSAGE": "Hello, tw-cli!"}}
    ]
  ]
}
```

```bash
./tw script validate script.json --project demo.sb3 --target 小猫
./tw script apply script.json --project demo.sb3 --target 小猫 --out edited.sb3
./tw run --project edited.sb3 --frames 2 --seed 1234 --trace 100 --out result.png
```

`validate` 与 `apply` 共用解析和构图逻辑。校验检查当前目标、资源和所有连接，返回计数与诊断，不修改编辑项目、选择、dirty、历史、输入队列或文件。即使当前会话有未保存修改或持续运行副本，`validate --project` 也只加载独立项目。

`apply` 向目标追加脚本，成功占一次撤销记录。重复执行会再次追加，不能当成幂等更新。会话中随后 `save`，一次性命令提供 `--out edited.sb3`；已有不同路径默认拒绝覆盖，可显式 `--force`。项目原路径的正常保存沿用已有覆盖规则。节点无效或保存失败时恢复项目、选择、dirty 和撤销/重做栈；不自动创建缺失变量，也不替换现有脚本。

输入支持字符串/有限数值、Boolean 条件、嵌套 reporter 对象及子堆栈数组；`control_if_else` 的两支分别为 SUBSTACK / SUBSTACK2：

```json
{
  "version": 1,
  "scripts": [[
    {"opcode": "event_whenflagclicked"},
    {"opcode": "control_repeat", "inputs": {
      "TIMES": 3,
      "SUBSTACK": [
        {"opcode": "control_if_else", "inputs": {
          "CONDITION": {"opcode": "operator_gt", "inputs": {"OPERAND1": 2, "OPERAND2": 1}},
          "SUBSTACK": [{"opcode": "motion_movesteps", "inputs": {
            "STEPS": {"opcode": "operator_add", "inputs": {"NUM1": 2, "NUM2": 3}}
          }}],
          "SUBSTACK2": [{"opcode": "motion_movesteps", "inputs": {"STEPS": 99}}]
        }}
      ]
    }}
  ]]
}
```

以上运行后前进15步。每个脚本的根为 hat 或普通语句，顺序连接只能接语句；Boolean 槽必须为 Boolean 表达式/字面量，子堆栈只能是语句数组。省略输入会保留空槽，不猜测编辑器默认输入；想要确定行为应显式提供输入。

菜单可用字面量，例如 `{"opcode":"looks_switchcostumeto","inputs":{"COSTUME":"造型"}}`；也可显式提供对应菜单节点。变量、列表和广播字段必须显式提供已有名称或稳定 ID：

```json
{"opcode":"data_changevariableby","fields":{"VARIABLE":"得分"},"inputs":{"VALUE":7}}
```

全局和角色局部资源同名时返回 `RESOURCE_AMBIGUOUS`，改用查询得到的稳定 ID。菜单可用现有 `blocks field-menu` 返回的值或 ID；造型/声音和目标菜单会将 ID 解析为该资源的菜单值，变量、列表、广播使用其资源 ID。自定义过程、任意 JS、未知 opcode、未批准的可执行扩展不进入此创作格式。

输入读取限32 MiB，合并后的积木图限100000块（包含 shadow），构图嵌套限64层；原型键和符号链接输入被拒绝。沿用有界读取及原子保存，`--force` 不绕过权限/路径限制。

## 4. 节点映射与调试

成功结果示例：

```json
{
  "schemaVersion": 1,
  "valid": true,
  "applied": true,
  "targetId": "目标ID",
  "roots": ["绿旗积木ID"],
  "nodeMap": {"$.scripts[0][0]": "绿旗积木ID", "$.scripts[0][1]": "移动积木ID"},
  "nodeCount": 3,
  "blockCount": 5,
  "diagnostics": []
}
```

`nodeCount` 计算 JSON 积木节点，`blockCount` 包含自动生成的 shadow/Boolean 辅助块。`validate` 的 ID 属于临时图，不能用于项目断点；`apply` 的 ID 才被提交并在 SB3 保存重开后保留。嵌套节点也有完整路径，例如 `$.scripts[0][1].inputs.SUBSTACK[0]`。

在同一 JSONL 会话中提取 apply 的 `nodeMap` 后：

```text
runtime start --paused --no-compile --seed 1234 --trace 100
runtime breakpoint add 移动积木ID
runtime step
runtime trace get --limit 20
runtime stop
```

断点、primitive 单步和积木 trace 使用解释模式。`runtime step --frames N` 推进帧，`runtime step` 执行 primitive 单步；运行坐标与编辑坐标分别查询。完整的断点命中、修正错误和结果核对流程见下方 debug 示例。

## 5. 错误与会话退出

请求格式保持 `{id,command,args:string[]}`，成功仍为 `{id,ok:true,result}`。失败保留 `error` 字符串并追加 `errorInfo`：

```json
{"id":4,"ok":false,"error":"EEXIST: 输出文件已存在：result.png","errorInfo":{"code":"OUTPUT_EXISTS","message":"EEXIST: 输出文件已存在：result.png","hint":"选择其他路径，或显式使用 --force。","details":{"path":"result.png"}}}
```

脚本节点错误的 `details.path` 是 JSON 节点路径；文件冲突的 `details.path` 是用户输出路径。不要解析英文/中文错误字符串作为控制逻辑，也不要自动重试可能写入的命令。

| code | 修正方向 |
| --- | --- |
| INVALID_ARGUMENT | 检查参数、JSON 格式、范围和节点路径 |
| UNKNOWN_COMMAND / UNKNOWN_OPTION | 查询该命令族的机器帮助 |
| RESOURCE_NOT_FOUND / RESOURCE_AMBIGUOUS | 查询资源列表；检查项目/目标；使用稳定 ID |
| OUTPUT_EXISTS | 更换输出路径或显式 `--force` |
| UNSAVED_CHANGES | 保存或显式丢弃当前修改 |
| PERMISSION_DENIED | 检查精确授权及安全路径 |
| NOT_SUPPORTED | 查询 capabilities 的条件与替代方式 |
| RUNTIME_TIMEOUT | 降低工作量，检查运行状态并重建副本 |
| NODE_RUNTIME_UNAVAILABLE | 运行 doctor，显式指定有效 Node 24 |
| INTERNAL_ERROR | 保留 stderr，检查未知故障；避免盲目重试写入 |

默认 `session --jsonl` 处理单条失败后继续，自动化必须检查每条 `ok`。可选 `session --jsonl --fail-fast` 在首次失败后停止执行后续请求，退出1；若仍有未保存修改，退出2。正常结束且没有未保存修改退出0；默认会话中单条失败并不改变退出码。dirty 状态的 EOF/退出继续遵循原来的退出2规则。日志进入 stderr，stdout 保持逐行 JSON。

## 6. 三个可直接运行的完整示例

```bash
npm run example:basic
npm run example:input
npm run example:debug
# 可指定尚不存在的目录；父目录须已存在：
npm run example:basic -- /绝对路径/新的输出目录
```

这些是调用实际 JSONL CLI 的短脚本，不需要阅读实现源码或手工连接 ID。使用随附本地 Cat 2、固定 seed=1234、新目录；没有网络或真实设备要求。

- basic：创建、载入素材、校验/追加脚本、保存/重开、运行，断言运行 x=-20、编辑 x=-120，生成 PNG。
- input：创建空格键脚本、导出/回放 JSONL，断言运行 y=40、编辑 y=0，确认磁盘 SB3 不变。
- debug：演示 INVALID_ARGUMENT 后修正，使用 apply 节点映射设置断点、命中/单步、读取 trace，再检查坐标与 PNG。

每次输出目录包含 `verification.json`、`transcript.json`、`stderr.log`、项目和图片；目录位置打印到 stdout。示例实际解码 PNG，断言480×360尺寸，记录文件和像素哈希；这是本地图片完整性检查，不代表 GUI 图像差分验收。脚本位置为 `scripts/agent-example.js`，创作 JSON 为 `scripts/recipes/basic.json` 和 `scripts/recipes/input.json`。`npm run tutorial:smoke` 会同时验证原有教程和这三个流程，防止文档与实际接口脱节。
