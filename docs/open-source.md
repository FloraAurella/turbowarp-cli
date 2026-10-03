# 开源与分发说明

本项目首次公开为 **0.1.0 实验版源码**，CLI 整体采用 **GPL-3.0-only**。直接使用的 GUI 音频代码与 Blocks 带有 GPLv3 条款；VM 和多个其他组件使用 MPL 2.0，不能把所有 TurboWarp 组件说成同一许可。第三方组件清单见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

## 是否需要另行申请许可

满足现有开源许可证的条件时，可以修改、公开、再分发并收费，无需另向 TurboWarp 申请开源授权。收费不会取消向接收者提供 GPL 权利和相应源码的义务。代码许可不授予商标或官方背书权；使用第三方标识宣传产品时要另行核对。

## 本次源码公开提供的内容

- CLI 代码、README、分步教程、测试及脚本。
- 根目录 GPLv3 原文、版权与 2026-10-03 修改说明。
- 20 个直接依赖的许可证副本、来源与精确锁定版本。
- GUI 的原始 MIT 版权/BSD 条件，以及复制代码的 GPL 许可和提交哈希。
- 扩展原始署名、许可文本、精确提交的完整源码包和文件哈希。
- Scratch 素材出处、原始哈希、CC BY-SA 2.0 文本及上游要求的署名。
- 开发用 Desktop 源码快照、锁文件和恢复说明。

`node_modules`、本机游戏产物、旧 Git 历史和生成的练习目录不属于本次公开树。历史日志中的本机路径在发布副本中作了替换，原工作区证据保留。

## 后续版本必须保持的义务

GPLv3 第 4、5 条要求保留许可证、版权和无担保声明，说明修改及日期，并将组合的软件作品按 GPLv3 分发。第三方文件和独立素材的原许可仍保留。不要给接收者加上“禁止商业使用”“禁止再分发”等与 GPL 不相容的限制。

若分发安装包、带依赖的 ZIP 或可执行文件，应按 GPLv3 第 6 条提供与该构建对应的源码、修改和构建/安装脚本。最易维护的网络分发方式是把构建和对应源码一起放在同一 Release，并在下载旁明确说明源码位置。链接必须对应精确版本且持续可用；仅链接当前上游首页或给出 `package-lock.json` 不足以完成这项工作。

MPL、BSD、MIT、Apache、字体许可和素材许可仍要按各自条件履行。未来将原生依赖打进安装包时，需要审查完整传递依赖和其嵌入的原生库，本次直接依赖清单不能替代该审查。

CLI 生成的普通 SB3/PNG/WAV 不因使用工具自动成为 GPL；如果输出中包含打包运行时、扩展或第三方素材，要遵守这些内容各自的许可。Scratch 素材改编还需遵守适用的署名和相同方式共享条款。

## 核对过的上游资料

- [TurboWarp Desktop 许可](https://github.com/TurboWarp/desktop/blob/master/LICENSE) 与 [README](https://github.com/TurboWarp/desktop/blob/master/README.md)。
- [冻结 GUI 的许可说明](https://github.com/TurboWarp/scratch-gui/blob/b37cb1df4a9e3a3011de04f5d04063a63bdf0c0c/README.md)。
- [冻结 VM 的 MPL 许可](https://github.com/TurboWarp/scratch-vm/blob/43f13efd1883eeef8f82616faf69380ff75ab068/LICENSE)。
- [冻结扩展库的分组件许可说明](https://github.com/TurboWarp/extensions/blob/90192c38ce9128c5eb828ad0957e0a968de9babd/README.md)。
- [Scratch 官方网站源码中的条款](https://github.com/scratchfoundation/scratch-www/blob/develop/src/views/terms/terms.jsx)，摘录见 [素材条款](../LICENSES/SCRATCH-ASSET-TERMS.md)。

核对日期：2026-10-03。以上是针对本项目当前文件的分发整理；源码开源不表示所有 GUI 功能、平台或可执行包已验收。
