'use strict';
const describe = () => ({
  schemaVersion: 1,
  implemented: [
    {id: 'project-editing', commands: ['new', 'open', 'save', 'undo', 'redo'], conditions: ['Node 24', '本地项目文件'], acceptance: 'local-functional-tests'},
    {id: 'script-recipes', commands: ['script validate', 'script apply', 'blocks schema'], conditions: ['已打开项目', '可查询 schema 的已加载积木', '过程使用现有 proc 命令'], acceptance: 'local-functional-tests'},
    {id: 'offline-library', commands: ['library status', 'library search', 'library load'], conditions: ['随附本地素材'], acceptance: 'resource-hashes'},
    {id: 'isolated-runtime', commands: ['run', 'runtime'], conditions: ['断点、积木单步与 trace 需要解释模式'], acceptance: 'local-functional-tests'},
    {id: 'recorded-input', commands: ['device', 'input'], conditions: ['显式预录数据', '不采集真实设备'], acceptance: 'local-functional-tests'},
    {id: 'offscreen-rendering', commands: ['render', 'paint', 'font'], conditions: ['原生依赖', '冻结或显式导入字体'], acceptance: 'local-functional-tests; GUI differential pending'},
    {id: 'sound-assets', commands: ['sound', 'asset'], conditions: ['指定声音资源', '不代表整项目音轨'], acceptance: 'local-functional-tests; browser audio differential pending'},
    {id: 'recording', commands: ['record start'], conditions: ['projectaudio=false', '视频编码须精确授权 ffmpeg/ffprobe'], acceptance: 'local-functional-tests'},
    {id: 'packaging', commands: ['package', 'pack build'], conditions: ['HTML/ZIP 本地生成', '平台播放验收独立进行'], acceptance: 'generated-artifact-only'}
  ],
  unsupported: [
    {id: 'whole-project-audio', command: 'record start --projectaudio true', code: 'NOT_SUPPORTED', alternative: '使用 projectaudio=false 和显式预录 WAV 音轨。'},
    {id: 'arbitrary-executable-extensions', alternative: '使用已批准的 pen/music 或预录 videoSensing/Gamepad。'},
    {id: 'live-device-capture', alternative: '使用预录输入回放。'},
    {id: 'recorded-provider-packaging', alternative: 'videoSensing/Gamepad 数据提供器项目暂不转包。'}
  ],
  acceptance: {fullGUIParity: false, commandAvailabilityIsAcceptance: false, detailsCommand: 'check',
    pending: ['imageDifferential', 'audioDifferential', 'platforms', 'performance', 'permissions', 'devices']}
});
module.exports = {describe};
