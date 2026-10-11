# 原生项目读写与 JavaScript 编辑脚本

这组接口用于 Scratch / TurboWarp 的 SB3 项目。Agent 可以读取带 ID 的结构化代码、定位积木、提交修改、保存新项目，再打开运行验证。CLI 不内置模型服务；模型根据读取结果决定修改。

请使用 `./tw` 或 `node scripts/node24.js`，运行环境需要 Node 24。`./tw doctor --json` 可以检查 Node 选择及原生依赖。下面的命令都从仓库根目录执行。

项目文件打开上限为 300 MiB（314,572,800 字节），解压后的总量上限为 600 MiB。`project.json`、`sprite.json` 和 `tw-cli-state.json` 的单文件解压大小上限为 64 MiB（67,108,864 字节）。原生项目读写、SDK、编辑脚本和运行时使用相同的项目输入上限。

宽或高为零的 SVG 造型按透明空素材加载，不绘制、不参与碰撞或拾取；保存时保留原始素材字节。

## 读取、定位、校验、提交

```bash
./tw project read --project source.sb3
./tw project read --project source.sb3 --target Sprite1
./tw project read --project source.sb3 --target Sprite1 --format text
./tw project find motion_movesteps --project source.sb3 --target Sprite1
./tw project validate edit.json --project source.sb3
./tw project apply edit.json --project source.sb3 --out changed.sb3
```

默认读取提供项目概览：目标、资源、素材索引、过程及脚本根。指定 `--target` 或 `--script <rootId>` 后包含完整脚本 `body`。返回的 `revision` 用于防止过期编辑。字段和资源引用包含 ID 与名称，输入保留实际表达式及被遮住的 shadow。无法提供友好展示的节点保留原始描述及诊断。

文本视图包含目标、脚本根和积木 ID，便于阅读；第一版不把文本解析回积木。修改请使用 JSON 或 JavaScript。素材读取返回索引，二进制仍通过原有素材导入、导出接口操作。

JSON 文档示例，`id` 和 `baseRevision` 应取自刚刚读取的实际结果：

```json
{
  "version": 1,
  "baseRevision": "读取结果中的 revision",
  "operations": [
    {
      "op": "block.update",
      "target": "Sprite1",
      "id": "移动积木的稳定 ID",
      "inputs": {"STEPS": 47}
    }
  ]
}
```

`block.update` 支持输入、字段和位置。`script.add`、`script.replace`、`script.delete` 分别追加、替换、删除；替换使用 `{op:'script.replace', target, root, body}`，`body` 可直接取自读取结果。已有节点的 ID 保留，新节点由 CLI 分配。过程使用 `procedure.define`、`procedure.update`、`procedure.delete`。`command` 操作用 `{op:'command', command:'var', args:['set','score','10']}` 调用允许的现有项目命令，参数必须为字符串。

新脚本可以使用简洁的节点对象，值输入接受普通字面量或嵌套表达式，子堆栈接受语句数组：

```js
await project.target('Sprite1').scripts.add([
  {opcode: 'event_whenflagclicked'},
  {opcode: 'control_repeat', inputs: {
    TIMES: 3,
    SUBSTACK: [{opcode: 'motion_movesteps', inputs: {STEPS: 10}}]
  }}
]);
```

用 `./tw blocks schema control_repeat --project source.sb3 --target Sprite1` 查询真实 opcode 的输入、字段、形状和资源菜单。读取后的完整输入描述包含 `{name,block,shadow}`；直接复用这些描述可保留隐藏 shadow。公共对象及编辑操作的完整类型在包内 `index.d.ts`。

`baseRevision` 可省略；提供时必须匹配。建议 Agent 始终提供，发现 `PROJECT_CONFLICT` 后重新读取并判断原意是否仍成立。保存回源文件还会检查源文件是否被外部修改，`--force` 不能跳过该检查。新输出已存在时返回 `OUTPUT_EXISTS`，确认覆盖意图后才使用 `--force`。

普通 SB3 即使没有 CLI 元数据，同一文件在独立读取进程中也会得到一致的目标、素材与输入节点 ID。保存时 `tw-cli-state.json` 记录这些身份，包括 SB3 紧凑格式未保留的字面量／表达式输入 ID；修改后的项目重开后仍可使用返回的定位信息。

独立紧凑变量／列表 reporter 保留原始 `blocks` 字典键作为积木 ID，即使多个节点内容或坐标相同也分别保留。没有保存坐标的独立 reporter 默认位于 `(0,0)`，作为无事件帽的独立代码展示，不因绿旗自动执行；已有坐标和附着评论保持关联。

一次性 `apply` 和 `exec` 必须明确 `--out`。一批编辑只有一次事务快照和撤销记录；中途失败、最终校验或保存失败会恢复项目及会话状态。没有实际变化时不增加历史或重写已有输出。被引用的资源及过程不能直接删除，错误会提供引用信息。运行、打开别的项目、嵌套保存、网络下载和外部导出不允许作为批量操作。

编辑 JSON 可通过文件或标准输入传入：

```bash
./tw project validate - --project source.sb3 < edit.json
./tw project apply - --project source.sb3 --out changed.sb3 < edit.json
```

`session --jsonl` 已使用 stdin 收取请求，因此会拒绝编辑文件名 `-`。JSONL 会话请传文件路径，或在程序中使用 SDK 普通对象。JSONL 保留 `{id,ok,result}` / `{id,ok:false,error,errorInfo}` 格式；机器错误有稳定 `code` 以及定位诊断。stdout 是 JSON 或明确选择的文本，日志发往 stderr。

新 `project read/find/validate/apply/exec` 的一次性调用失败时也在 stdout 返回 `{ok:false,error,errorInfo}`，退出码为 1，并向 stderr 提供简短说明；程序应读取 `errorInfo.code` 判断失败。

## JavaScript SDK

从包入口导入 `openProject` 和 `createProject`。已安装包使用 `require('tw-cli')`；仓库根目录中的脚本使用 `require('.')`。SDK 需要 Node 24，接受普通 JavaScript 对象，无需创建临时 JSON 文件。

```js
const {openProject} = require('tw-cli');

async function edit() {
  const project = await openProject('source.sb3');
  try {
    const read = await project.read({target: 'Sprite1'});
    // 从 read 或 find 的结果选出真实 ID，不要使用示例占位符。
    const blockId = '已读取的移动积木 ID';
    await project.validate({version: 1, baseRevision: read.revision, operations: [
      {op: 'block.update', target: 'Sprite1', id: blockId, inputs: {STEPS: 47}}
    ]});
    await project.batch(async edit => {
      await edit.target('Sprite1').blocks.update(blockId, {inputs: {STEPS: 47}});
      await edit.target('Sprite1').variables.set('score', 10);
    });
    await project.save('changed.sb3');
  } finally {
    await project.dispose();
  }
}
edit().catch(error => {console.error(error); process.exitCode = 1;});
```

`project.batch()` 接受异步回调、编辑文档或操作数组。所有修改方法都应 `await`；回调里的修改加入一个事务。`project.validate(document)` 在候选项目校验；`project.validate()` 校验当前项目。保存必须给出路径。

目标对象的主要方法：

| 对象 | 方法 |
| --- | --- |
| `target.scripts` | `add(body)`、`replace(root,body)`、`delete(root)`、`read(root)` |
| `target.blocks` | `update(id,{inputs,fields,position})` |
| `target.procedures` | `define({name,params,type,warp})`、`update(name,{newName,params,type,warp})`、`delete(name)` |
| `target.variables` | `add(name,value)`、`set(nameOrId,value)`、`rename(nameOrId,newName)`、`delete(nameOrId)` |
| `target.lists` | `add(name,values)`、`set(nameOrId,values)`、`append(nameOrId,value)`、`clear(nameOrId)`、`rename`、`delete` |
| `target.assets.costumes/sounds` | `add(filename)`、`import(filename)`、`rename(selector,newName)`、`reorder(selector,index)`、`delete(selector)` |

过程更新会同步调用的签名及参数；`newName` 是新过程名，第一个参数是现有过程的名称或标识。优先使用稳定 ID 消除同名目标、变量或素材的歧义。

## 原生执行编辑脚本

```bash
./tw project exec scripts/project-edit-examples/move.js --project source.sb3 --out changed.sb3
```

CommonJS 脚本导出异步函数，ES 模块 `.mjs` 使用默认导出：

```js
module.exports = async project => {
  const read = await project.read({target: 'Sprite1'});
  // 根据读取结果执行修改。
};
```

CLI 在独立 Node 24 子进程执行脚本，统一校验并最终保存。脚本函数抛错时不提交项目输出。**脚本拥有普通本地 Node 程序的权限**，可访问文件系统、启动进程等；进程隔离不构成 JavaScript 安全沙箱。只执行可信脚本，项目事务不负责撤销脚本自行产生的外部副作用。

扩展仍遵循现有许可范围。支持读取、展示和编辑已批准扩展不代表可以执行任意第三方扩展代码。旧 `script validate/apply` 与版本 1 配方继续可用，旧 `script apply` 保持追加语义。

## 三个可重复运行的完整示例

每次运行自动新建临时目录。也可传入不存在的输出目录；程序会拒绝已有目录，保留历史输出。示例创建真实源 SB3，执行原生编辑，保存后重开，并使用固定种子运行断言。

```bash
node scripts/node24.js scripts/project-edit-examples.js move
node scripts/node24.js scripts/project-edit-examples.js batch
node scripts/node24.js scripts/project-edit-examples.js procedure
```

1. `move`：读取原移动积木 ID 和 revision，通过 JSON 校验及提交将步数改为 47，重开后验证 x 为 47。
2. `batch`：用 JavaScript 脚本批量修改两个目标，重开后验证 Sprite1 的 x 为 31、Other 的 x 为 57。
3. `procedure`：用 JavaScript 更新过程名称及 warp，修改过程体移动数值，确认调用签名同步，重开运行验证 x 为 30。

每个输出目录包含 `source.sb3`、`changed.sb3`、读取结果、运行结果、命令 transcript 和 `verification.json`（包括 SHA-256）。独立编辑函数在 `scripts/project-edit-examples/`，可作为 `project exec` 的模板。验证覆盖原生 VM 运行；官方编辑器导入、完整 GUI 对等与完整游戏体验仍需独立验收。
