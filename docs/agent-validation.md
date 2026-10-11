# Agent 易用性改造验证记录

本记录对应2026-10-03的 CLI 易用性改造。[上一轮交付审计](completion-audit.md)保留275项测试的历史证据。本轮完整 GUI 对等与发布门槛继续按原有验收状态处理。

## 最终结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `npm test` | **297/297通过，0失败、取消或跳过**；63.64秒 | [完整日志](verification/agent-full-tests.log)、[stderr](verification/agent-full-tests.stderr.log) |
| 源码稳定性 | 最终测试前后96个源码、脚本、测试和配置文件哈希一致 | [测试前哈希](verification/agent-sources-before.json)、[汇总](verification/agent-implementation.json) |
| `npm run tutorial:smoke` | 原37条实际指令 + 三个 Agent 流程65条请求，共102条；通过 | [教程日志](verification/agent-tutorial.log)、[教程产物清单](../examples/verified-Rn9fo5/verification.json) |
| `npm run resources:check` | 1610个资源文件、301个扩展、1304个素材哈希检查通过 | [资源日志](verification/agent-resources.log) |
| `npm run baseline:check` | 冻结开发基线检查通过 | [基线日志](verification/agent-baseline.log) |
| `./tw doctor --json` | 入口Node26.5.0，选择Node24.18.0，macOS arm64，4项原生依赖可加载 | [环境诊断](verification/agent-doctor.json) |
| 命令目录/文档生成 | 52个命令族、394个入口；机器帮助与实际参数规则共用目录 | [命令参考](command-reference.md)、`test/agent-interface.test.js` |
| `npm run release:check` | 按预期退出2，`releaseReady=false`；缺失文件0，无效命令schema0 | [发布检查](verification/agent-release.log) |
| `git diff --check` | 通过 | [汇总记录](verification/agent-implementation.json) |

## 实际示例

- [基础创作](../examples/verified-Rn9fo5/agent-basic/verification.json)：17条请求，新建/本地素材/校验/追加/保存重开/运行；运行x=-20，编辑x=-120，磁盘项目不变。
- [输入回放](../examples/verified-Rn9fo5/agent-input/verification.json)：21条请求，空格键JSONL回放；运行y=40，编辑y=0，磁盘项目不变。
- [调试与修正](../examples/verified-Rn9fo5/agent-debug/verification.json)：27条请求；预期出现一次INVALID_ARGUMENT后修正，apply节点映射设置真实断点、命中、单步到x=-20、检查trace，编辑x=-120。

每个示例均解码实际480×360 PNG，记录文件与像素哈希，保留项目、图片、完整请求/响应和stderr。使用固定seed=1234、本地Cat 2素材、新建输出目录，无网络或真实设备要求。此处图片检查不代替GUI图像差分验收。

## 回归覆盖

新增22项测试：9项接口/启动/JSONL测试、10项脚本构图/事务测试、3个真实创作示例；原275项测试继续通过。覆盖Node26入口选Node24、无效/空/错误版本TW_NODE、带空格路径、没有PATH Node的显式启动、轻量帮助、命令和布尔选项全集一致性、稳定错误与默认继续/可选fail-fast（包括stdin尚未关闭时退出）。

脚本验证覆盖分支与循环、Boolean条件和嵌套reporter、菜单及资源名称/稳定ID、sensing属性依赖、名称歧义、保存重开后ID保留、一次undo撤销全部追加、校验时保留原VM/持续运行副本/选择/dirty/历史/输入队列、输入超限/原型键/符号链接/非法连接拒绝，以及保存冲突恢复原项目和活跃会话。现有真实30秒worker超时与后续请求恢复测试也通过。

第一次完整运行因清理旧Gamepad定义时漏删关联闲置常量而启动失败；修正后第二次297项运行中296通过，发现`--empty true`被误标为开关；恢复原参数语义并增加布尔选项全集一致性断言后，最终297项全部通过。前两次失败日志单独保留在[启动错误记录](verification/agent-full-tests.initial.log)和[兼容性错误记录](verification/agent-full-tests.compatibility-failure.log)，没有改动原有Gamepad用法来让测试通过。

## 交付范围

本轮保持纯CLI、原JSONL成功结构和字符串数组args。新增errorInfo是追加字段。未补齐的帮助语义或默认值显式标记未知；声明式创作中的自定义过程继续用现有proc/blocks procedure-*；apply为追加而非幂等更新。未增加MCP、自然语言解析、可执行扩展批准或GUI验收豁免。macOS arm64本机验证通过；完整GUI差分、设备、平台与性能门仍按原有状态处理。

使用方法见[Agent使用指南](agent-usage.md)。完整自评见[代码与命令审查](verification/agent-review.md)。
