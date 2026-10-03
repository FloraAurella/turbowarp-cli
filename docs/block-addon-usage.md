# 积木与插件 CLI 语义

本模块以冻结 M1 `docs/census/code-workspace.md` 与 `docs/addons-inventory.json` 为输入，不修改普查账本。81 个 manifest、148 个设置、13 个 preset 均可读取和显式保存；这不表示 81 个插件的所有运行行为已经实现。

## 集成接口

`src/block-commands.js` 和 `src/addon-commands.js` 都导出以下 CommonJS 契约。

```js
{
  specs: {blocks: {/* actions */}}, // addon 模块为 {addon: {/* actions */}}
  booleanOptions: ['single', 'heal', 'shadows'], // addon: delete-orphans, delete-unused
  requiresProject(command, args),
  isReadOnly(command, args),
  execute(session, command, args, options)
}
```

- `args` 包含 action，例如 `['switch', blockId, 'motion_sety']`。每个 spec 是 `{min,max,options:[...]}`；min/max **不计 action**，options 始终是数组。
- `execute` 不自行开项目事务；主 registry/CommandSession 负责加载 `--project`、选择 `--target`、项目快照、undo/redo、`--out` 原子保存和失败恢复。
- blocks 所有 action 需要项目；`list/inspect/count/find/copy/export/field-menu` 是项目只读。copy 可以更新会话内部剪贴板或输出文件，但不改项目/项目历史。
- addon 的配置 action 不需要项目，不进入项目事务。语义 action 需要项目；`block-count/find/variables/copy-single/copy-all` 项目只读，其余进入主事务。
- blocks 还导出 `dispose(session)` 清理 WeakMap 内部剪贴板，以及 `helpers` 供 addon 使用：`checkedGraph, graphOf, validateGraph, applyGraph, descendants, schema, resource, resourceType, mutationDOM, makeBundle, pasteBundle, coordinate, clone`。helpers 不是另一套文件 JSON 编辑器。
- semantic action 显式运行，不要求保存的 addon `enabled=true`；enabled 只是配置，不自动安装、挂钩或执行 userscript。

### 输出路径约定

- `--out result.sb3` 只用于主项目事务保存。
- 积木 clipboard/export 用 `--output blocks.json` 或独立 positional 文件名；禁止把 `.sb3` 当 clipboard 输出。
- addon 配置用 `--config addons.json`，不读取 IndexedDB、浏览器 localStorage 或隐式 home 文件。缺失配置的读取返回 frozen defaults；写入必须给 `--config`。
- `--force` 允许覆盖 clipboard 输出；配置更新是显式读-校验-原子替换，不需要 --force。用户 clipboard/config 读取统一走 `project.readLocalFile`，不再先 stat/lstat 再另开 readFile；文件和父路径的 symlink/nonregular 检查、读取期间大小限制由共享 helper 执行。clipboard 保留原32 MiB上限，addon config为2 MiB；递归拒绝 `__proto__/constructor/prototype` JSON键。输出继续统一走 `atomicWrite`，不另造文件写入实现。
- 多文件 side effect 并非跨文件原子事务：cut 的 clipboard 成功写出后，如果随后主 `--out` 保存失败，项目回滚，但 clipboard 文件不会删除。配置文件也不由项目 undo 回滚。

## 积木查询、创建与字段

```sh
# 一次性命令
./tw blocks count --project project.sb3
./tw blocks count --shadows --project project.sb3
./tw blocks inspect --project project.sb3 --target Sprite1
./tw blocks inspect BLOCK_ID --mode single --project project.sb3
./tw blocks find movement --project project.sb3
./tw blocks find --opcode motion_movesteps --project project.sb3
./tw blocks find --var-id VARIABLE_ID --project project.sb3
./tw blocks find --field VARIABLE --value score --project project.sb3

# 以下适用于 session；一次性编辑加 --project 输入.sb3 --out 输出.sb3
blocks add event_whenflagclicked
blocks add motion_movesteps --inputs '{"STEPS":25}' --after HAT_ID
blocks add data_setvariableto --fields '{"VARIABLE":"VARIABLE_ID"}' --inputs '{"VALUE":"hello"}'
blocks add looks_switchcostumeto --inputs '{"COSTUME":"造型"}'
blocks add event_broadcast --inputs '{"BROADCAST_INPUT":"BROADCAST_ID"}'
blocks field-menu BLOCK_ID VARIABLE
blocks set-field BLOCK_ID VARIABLE VARIABLE_ID
blocks set-field --block BLOCK_ID --field LIST --var-id LIST_ID
blocks set-field TEXT_BLOCK TEXT ""
blocks set-field COLOUR_BLOCK COLOUR '#ff0000'
```

count 默认排除 shadow，按 original target 的独立 Blocks 容器统计，不重复计算 clones。inspect 返回 roots、完整 VM block descriptors 和 `graphSafe`；find 返回 target、block、root，文本只做不区分大小写 substring，不执行用户 regex/JS。

字段菜单校验包括变量/列表/广播的 ID 与类型，造型、声音、背景、sprite/object/clone/key 资源，以及静态 dropdown 值。VARIABLE/LIST/BROADCAST_OPTION 通过 `changeBlock({element:'field',value:id})` 解析名称。`sensing_of_object_menu.OBJECT` 更新后由 VM 联动父 `PROPERTY`。`control_stop.STOP_OPTION` 同步 `hasnext` mutation，不能移除占用的 next 连接。

资源 menu 输入自动创建正确 shadow；尤其广播输入必须满足 `input.block===input.shadow` 才能使用 Scratch 消息 ID，而不是一个不执行的普通 reporter。颜色 literal 创建 `colour_picker` shadow。

## 图安全、连接与布局

```sh
blocks connect CHILD_ID --after PARENT_ID
blocks connect CHILD_ID --parent PARENT_ID --input CONDITION
blocks disconnect BLOCK_ID
blocks disconnect BLOCK_ID --single --heal --at 100,200
blocks heal BLOCK_ID
blocks delete BLOCK_ID --single
blocks delete BLOCK_ID                 # 默认删除该块及后续堆
blocks move ROOT_ID 120 240
blocks move ROOT_ID --at 120,240
blocks cleanup --at 48,64 --gap 72 --columns 2 --column-width 480
blocks clear
```

- connect 校验 next/previous、statement/value/Boolean/prototype/argument shape；拒绝 cycle、多 parent、缺失连接、占用的非 shadow 输入。断开 reporter 会恢复 obscured shadow，shadow 不可独立拖出。
- single 包括该块的 input 子树，不包括根块后面的 next 链。`--single --heal` 或 `heal` 将原堆前后接回，拿出的块成为顶层。
- move 坐标只用于顶层 script。cleanup 仅布局，确定性语义高度估算，不假称 Blockly SVG 字体、注释尺寸与像素排列完全一致。
- 每次写前验证图及资源。图上限 100000 blocks、嵌套深度 512，mutation 子树深度 32；循环、坏 parent/next/shadow、过程签名失配在 VM 写入前失败。
- 图重建使用 VM `deleteBlock/createBlock/changeBlock`（以及移动 `moveBlock`）维护 scripts、cache 和 PROJECT_CHANGED，不直接改 SB3 `project.json`。项目保存仍走主 VM 序列化。
- schema 只把冻结 scratch-blocks 源声明当静态数据读取，不 require/eval Blockly、DOM 或 addon userscript。未知/未加载 input shape 明确拒绝；动态 executable `blockInfo` mutation 不接受。pen/music 仅用已批准且已加载的 VM block metadata。

## 复制、粘贴、分享、导入导出

```sh
blocks duplicate BLOCK_ID --mode stack --at 100,200
blocks duplicate BLOCK_ID --single
blocks copy BLOCK_ID
blocks paste --at 200,300
blocks copy BLOCK_ID --output clipboard.json
blocks export BLOCK_ID clipboard.json
blocks export --output whole-target.json
blocks import clipboard.json --variables reuse
blocks paste --from clipboard.json --variables rename
blocks share BLOCK_ID OtherSprite --variables error
blocks cut BLOCK_ID --single --output cut.json
```

- 这是会话内/显式 JSON clipboard，不是 OS clipboard；不模拟鼠标拖放/碰撞 bump。
- `tw-cli-blocks/version1` 包含 blocks、过程 dependencies、变量/广播的声明和值、块注释。暂不接受 Blockly XML、裸 Scratch backpack array 或 `backpack:itemId` 路径。
- paste/duplicate/share 对 block、parent、next、inputs.block/shadow、comment ID 全量重新映射。过程定义的 argument IDs 和 call input names 一起映射，避免仅重编号块而破坏过程执行。
- call 复制会携带递归/传递过程定义；目标已有相同过程签名时重用。相同 proccode 但不同参数名/default/warp/return 拒绝；显式复制定义且重名时生成新过程名称并改复制的调用。
- `--variables reuse`（默认）按目标作用域/类型/名称重用，保留目标已有值；同一项目共享 global 按 ID 重用。broadcast 始终 global，名称冲突不区分大小写。
- `rename` 为冲突创建唯一名称；`error` 拒绝目标同名冲突。不会把原 sprite local 变量误共享成另一个 sprite 的同 ID 局部资源。cloud 定义复制明确拒绝，需先显式转换。
- 造型/声音/object 菜单资源在目标缺失时安全失败，而不是静默创建错误引用。
- VM SB3 将 primitive shadows/data reporters 压缩为数组，重载会重新生成某些 primitive block ID；执行值、parent/next/shadow 关系会 roundtrip 验证，不承诺所有 primitive ID 跨 SB3 永远稳定。

## opcode 与自制积木

```sh
blocks switch BLOCK_ID motion_changeyby
blocks switch BLOCK_ID looks_sayforsecs
blocks switch BLOCK_ID control_if
blocks switch BLOCK_ID motion_sety --input-map '{"DX":"Y"}'

blocks procedure-add move --params '[{"name":"distance","type":"number"},{"name":"yes","type":"boolean"}]' --warp true
blocks procedure-call move --values '{"distance":12,"yes":true}' --after HAT_ID
blocks procedure-edit move --name advance --params '[{"name":"yes","type":"boolean"},{"name":"distance","type":"number"}]'
blocks procedure-add answer --type reporter
blocks add procedures_return --inputs '{"VALUE":33}' --after DEFINITION_ID
blocks procedure-call answer --parent MOTION_ID --input STEPS
blocks procedure-delete advance
blocks mutation STOP_BLOCK '{"tagName":"mutation","children":[],"hasnext":"false"}'
```

switch 实现 frozen block-switching 的核心相关转换（motion x/y/set/change、looks/sound/event/operator/control/data、已加载 pen/music），input name 映射、字段映射、增加默认 shadow、删除无用 shadow、拆下真实 input 子树；Boolean/statement 不可乱接。复杂非相关切换允许显式 map，但仍严格校验目标 shape，不能丢失现有未知输入。

过程编辑同步 signature、argument IDs、call inputs、warp/return；已使用参数不能随意删除/改变 shape。参数重排以名称保持调用值。仍有非递归外部调用时拒绝删除定义。`return` 类型 statement/reporter/boolean 支持 VM mutation，call 不兼容现有连接时拒绝。

mutation 的 API event value 为 `{name:'mutation',attribs:{...},children:[...]}`，不是直接把 VM `{tagName,...}` 对象传给 changeBlock。属性做一次 entity escaping，保证 `&amp;` 等字面值不会在 event adapter 中变形。mutation 不执行任意 JS、动态扩展源码或未批准 `blockInfo`。

## 81 插件配置

```sh
./tw addon list
./tw addon inspect block-switching
./tw addon default                       # 所有81 frozen defaults
./tw addon default paint-snap
./tw addon enabled cat-blocks true --config addons.json
./tw addon enabled cat-blocks --config addons.json
./tw addon setting custom-block-shape paddingSize 120 --config addons.json
./tw addon setting paint-snap threshold 15 --config addons.json
./tw addon reset-setting paint-snap threshold --config addons.json
./tw addon presets custom-block-shape
./tw addon presets custom-block-shape default2 --config addons.json
./tw addon reset custom-block-shape --config addons.json
./tw addon reset --config addons.json
./tw addon commands
./tw addon commands editor-devtools
```

配置格式为 `{"format":"tw-cli-addons","version":1,"addons":{"id":{"enabled":true,"settings":{...}}}}`。保存补齐所有81 defaults。未知 addon/setting/preset/结构拒绝。

校验 frozen 类型 Boolean、integer/positive_integer（safe integer及min/max）、select ID、color `#rrggbb`，允许透明的字段另接受 `#rrggbbaa/transparent`；untranslated 是限长原文，不作为 JS 求值。设置的 `if` 只控制原 GUI 可见性，不阻止显式设置保存，也不产生 DOM。

所有输出包含 `userscriptExecuted:false,domEnabled:false`。not-applicable 视觉设置返回 **no semantic effect**；其 enabled 可以保存但不假称 CLI 装出了 cat blocks、theme、zoom、CSS 等。commands 索引为每个 addon 记录具体等价命令或 `configuration-only-actions-not-implemented`，不把配置可用伪装成行为已完成。

## 显式插件语义与四 pending

```sh
addon block-count
addon find movement --kind blocks       # all/blocks/costumes/sounds
addon rename-broadcast BROADCAST_ID renamed
addon initial-sprite --config addons.json
addon initial-sprite --x 20 --y 40
addon move-layer front                  # back/forward/backward [positive count]
addon variables score
addon set-variable VARIABLE_ID hello
addon set-list LIST_ID "line1\nline2"    # 传入真实换行；保留最后空行
addon rename-variable VARIABLE_ID renamed

# block-switching
addon switch BLOCK_ID motion_sety
# editor-devtools
addon replace-variable OLD_ID NEW_ID
addon cleanup-plus --delete-orphans --delete-unused
addon cleanup-plus --make-space ROOT_ID
addon copy-single BLOCK_ID --output copy.json
addon copy-all --output whole.json
addon cut-single BLOCK_ID
addon paste-at copy.json --at 100,200
addon costume-next
addon costume-previous
# swap-local-global
addon swap-scope VARIABLE_ID global
addon swap-scope LIST_ID local
addon swap-scope VARIABLE_ID global --cloud true
# paint-snap（node-id是裸SVG id，不是 #selector）
addon snap-move 0 moving 41 0 --config addons.json
addon snap-scale 0 moving 1.9 1 --config addons.json --spec '{"handle":"right","shift":true}'
```

- `rename-broadcast` 修改 stage resource name/value 和各 original target 的所有 BROADCAST_OPTION 字段；重名执行 merge（大小写不敏感），重置 VM caches，广播执行在重载后验收。
- `initialise-sprite-position` 是对所选现有 sprite 显式应用 x/y；不自动 monkey-patch 之后添加/duplicate，不声称 frozen 随机/真值判断分支都已复现。
- `move-to-top-layer` 对应 sprite layer；`move-to-top-bottom` 是 **costume/sound list 排序**，对应 `asset reorder costume|sound <asset> <destination-index>`，不是 sprite layer。
- DevTools cleanup+ 保留 frozen256 列聚类；删除孤立 reporters/未用 local scalar/list 需要明确 flags，间接 sensing_of 名称引用也保护。空间/高度为语义估算，不承诺 Blockly pixel 及自动注释位置。
- scope 转换保留变量ID/value、blocks引用、monitor显示/坐标/mode，校验其他 sprite/stage 使用、同名shadowing/conflict、Stage local、global scalar cloud。云变量仅按主项目本地 cloud provider 行为，不接外部Scratch云服务。
- paint-snap 真正委托 `vector-editor.execute(session,target,args,{snapSettings,spec})`，不在 addon 重复造几何引擎。默认 `threshold=10,zoom=1`；配置覆盖 frozen snap-from/snap-to。显式 snap action 启用算法，不等价 enabled 保存挂钩；`--spec` 可传 handle/shift/alt/artboard。
- frozen候选是 root peers、排除 selected/helper/locked/guide；move点优先，再边/轴；scale尺寸优先、阈值随zoom缩放、最小scale0.0001。图像坐标以SVG viewBox/显式artboard为准，不猜Paper2x放置和stroke扩张。视觉 guide/popover不复现，GUI阈值按钮double-click bug不等同普通 setting threshold。

## 验证与尚未交付

测试文件 `test/block-tools.test.js`、`test/addon-config.test.js` 通过主 `CommandSession.execute` 运行：真实仓库SB3、复杂过程/Boolean参数/obscured shadows/块注释、clipboard文件/跨target共享、过程参数重排和return执行、SB3复制重载解释器/编译器执行、失败无project/history改变；81 manifests、148 settings、13 presets及跨进程显式配置；pending四项具体语义而非仅config green。共享FS回归另覆盖clipboard/config叶子及父目录symlink、nonregular文件、上限正好可读/加1字节拒绝、嵌套prototype键拒绝及project/selection/dirty/history保持不变。

本模块不实现 81 addon 任意JS加载、不承诺每个 addon所有action全功能对等。blocks2image需要实际Blockly SVG，不被舞台PNG伪代替。find-bar滚动历史、OS clipboard、backpack账户接口、DOM视觉设置不冒充已启用。

主线程现在提供99条undo/redo上限（另有200MiB历史字节限制）；**这不是本模块实现的Blockly细粒度事件undo栈**。undo保存的是项目事务快照，可一次还原命令；配置文件、已导出clipboard与会话clipboard不随项目undo撤销。不要把99条上限解释为保证任意项目可存满99大快照。
