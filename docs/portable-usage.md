# macOS arm64 便携运行包

`tw-cli-v0.1.2-macos-arm64.zip` 面向 Apple Silicon Mac，包含编译后的 CLI／JavaScript SDK、Node **24.18.0**、已经安装的原生依赖和离线资源。首次运行无需系统 Node、npm 安装或本机编译；Windows、Linux 和 Intel Mac 没有本版平台验收。

## 解压与检查

从 [v0.1.2 Release](https://github.com/FloraAurella/turbowarp-cli/releases/tag/v0.1.2) 下载运行包。保留 Release 的源码、校验文件及随包许可证，解压后进入包目录：

同版对应源码是 `tw-cli-v0.1.2-source.zip`、`tw-cli-v0.1.2-dependencies-source.zip` 和 `tw-cli-resvg-js-v2.6.2-source.zip`。包内 `DEPENDENCY-MANIFEST.json` 记录实际依赖、编译器和对应源码，Node 24.18.0 的完整源码使用其中的精确版本地址，许可证在 `runtime/NODE-LICENSE`。这些源码包用于审阅和重建；日常运行只需运行包。

```bash
cd tw-cli-v0.1.2-macos-arm64
./tw --version
./tw doctor --json
```

版本应显示 `0.1.2`，doctor 应报告 Node 24 和原生依赖可加载。启动器使用 `runtime/node`，不依赖 `PATH` 中的 Node，也不需要配置 `TW_NODE`。`PORTABLE-MANIFEST.json` 是 payload 文件哈希清单，启动器会检查包内文件；直接修改编译文件或依赖会导致校验失败。GPL 允许修改对应源码；需要定制时使用本版对应源码进行开发和重建。只读文件权限及完整性检查不提供安全沙箱或防修改保证。

执行权限随 ZIP 保存。若所用解压工具丢弃权限，可对 `tw` 和 `runtime/node` 恢复用户执行位，再运行。使用前先核对实际下载来源及 Release 提供的校验值。

## 在自己的项目目录运行

将自己的 SB3 和编辑脚本保存在独立工作目录。运行包不包含工作区现有 SB3、游戏或训练产物。

```bash
/完整路径/tw-cli-v0.1.2-macos-arm64/tw new demo.sb3
/完整路径/tw-cli-v0.1.2-macos-arm64/tw script demo 25 --project demo.sb3 --out demo.sb3
/完整路径/tw-cli-v0.1.2-macos-arm64/tw project read --project demo.sb3 --target Sprite1
/完整路径/tw-cli-v0.1.2-macos-arm64/tw run --project demo.sb3 --frames 2 --seed 1234 --out result.png
```

运行结果 `Sprite1.x` 应为 25。`run` 使用副本，保存在 demo.sb3 的初始位置仍为 0。输出已存在时换路径，或在明确覆盖后使用 `--force`。脚本及输出路径相对当前工作目录解析，CLI 可以从任意目录调用。

原生修改流程：

```bash
/完整路径/tw-cli-v0.1.2-macos-arm64/tw project find motion_movesteps --project demo.sb3
/完整路径/tw-cli-v0.1.2-macos-arm64/tw project validate edit.json --project demo.sb3
/完整路径/tw-cli-v0.1.2-macos-arm64/tw project apply edit.json --project demo.sb3 --out changed.sb3
/完整路径/tw-cli-v0.1.2-macos-arm64/tw project exec edit.cjs --project demo.sb3 --out scripted.sb3
```

JSON 编辑文档和 JavaScript 函数格式见 [原生项目读写教程](project-agent-usage.md)。一次性写入必须指定 `--out`；`--force` 不能绕过 revision、外部源文件变化或路径检查。JavaScript 脚本拥有普通本地 Node 权限，进程隔离不构成安全沙箱。

## 使用随包 SDK

包根的 `package.json` 指向编译后 SDK，类型声明保留在 `index.d.ts`。自己的脚本可通过包的绝对路径导入：

```js
const {openProject} = require('/完整路径/tw-cli-v0.1.2-macos-arm64');

async function inspect() {
  const project = await openProject('demo.sb3');
  try {
    const code = await project.read({target: 'Sprite1'});
    console.log(JSON.stringify(code));
  } finally {
    await project.dispose();
  }
}
inspect().catch(error => {console.error(error); process.exitCode = 1;});
```

使用包内 Node 运行自己的脚本：

```bash
/完整路径/tw-cli-v0.1.2-macos-arm64/runtime/node inspect.cjs
```

`project exec` 已负责运行时选择及最终事务提交；直接使用 SDK 时，自己的程序负责 `batch/validate/save/dispose`。不要在便携包目录内安装依赖或改写编译产物。源码的 `npm run example:*` 和开发测试应在对应源码目录执行。

## 限制与许可

普通项目读取、修改、运行和渲染使用随包依赖。需要 ffmpeg 的录制功能仍需用户另行准备并授权外部 ffmpeg；无需为基本 CLI 流程安装 Homebrew。项目输入最大 300 MiB、解压内容总量最大 600 MiB，单项元数据最大 64 MiB。

本包是原生依赖预装的实验版分发。doctor 通过证明依赖能够加载，示例运行证明相应读改写和运行路径成功；完整 GUI 对等、官方编辑器、实际硬件和完整游戏验收仍有独立边界。详见 [当前能力与限制](current-limitations.md)。

CLI 采用 GPL-3.0-only，第三方代码、Node、原生库、字体和素材保留各自许可证。对应源码、构建脚本及分发说明见同一 Release 和 [开源说明](open-source.md)。
