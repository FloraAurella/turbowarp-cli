'use strict';

const $ = (id) => document.getElementById(id);
const input = $('file-input');
const titleInput = $('project-title');
const dropzone = $('dropzone');
const compileButton = $('compile');
const status = $('build-status');
const player = $('player');
const download = $('download');
const exampleButton = $('load-example');
const MAX_FILE_BYTES = 32 * 1024 * 1024;
let selectedFile = null;
let resultUrl = null;
let previewUrl = null;
let previewOrigin = null;
let previewTimeout = null;
let previewExpiresAt = 0;
let activeController = null;
let generation = 0;
let busy = false;
let dragDepth = 0;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function setStatus(message, kind = '') {
  status.textContent = message;
  status.className = `build-status${kind ? ` is-${kind}` : ''}`;
}

function setBusy(value, label = '正在编译…') {
  busy = value;
  compileButton.disabled = value || !selectedFile;
  $('compile-label').textContent = value ? label : '编译为 HTML';
  titleInput.disabled = value;
  exampleButton.disabled = value;
  $('progress-track').hidden = !value;
  compileButton.setAttribute('aria-busy', String(value));
}

function clearResult() {
  if (previewTimeout) clearTimeout(previewTimeout);
  previewTimeout = null;
  previewUrl = null;
  previewOrigin = null;
  previewExpiresAt = 0;
  player.hidden = true;
  player.removeAttribute('src');
  $('empty-stage').hidden = false;
  $('stage-shell').classList.remove('has-player');
  download.removeAttribute('href');
  download.removeAttribute('download');
  download.setAttribute('aria-disabled', 'true');
  download.tabIndex = -1;
  $('reload-preview').disabled = true;
  $('preview-state').textContent = '等待编译';
  $('preview-hint').textContent = '生成后，点击播放器绿旗开始。';
  $('download-heading').textContent = '可带走的 HTML';
  $('download-description').textContent = '单文件 · 离线运行';
  $('report').hidden = true;
  $('report-content').textContent = '';
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
}

function cancelRequest() {
  generation += 1;
  if (activeController) activeController.abort();
  activeController = null;
  setBusy(false);
}

function chooseFile(file) {
  cancelRequest();
  clearResult();
  if (!file || !/\.sb3$/i.test(file.name)) {
    selectedFile = null;
    renderFile();
    setStatus('请选择以 .sb3 结尾的 Scratch 3 工程文件。', 'error');
    return;
  }
  if (file.size === 0) {
    selectedFile = null;
    renderFile();
    setStatus('这个文件是空的。请重新从 Scratch 导出 SB3 工程。', 'error');
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    selectedFile = null;
    renderFile();
    setStatus('工程超过 32 MB 上限。请减少过大的图片或声音后重新导出。', 'error');
    return;
  }
  selectedFile = file;
  titleInput.value = file.name.replace(/\.sb3$/i, '');
  renderFile();
  setStatus('工程已准备好。点击编译，生成可试玩的 HTML。');
}

function renderFile() {
  $('selected-file').hidden = !selectedFile;
  dropzone.classList.toggle('has-file', Boolean(selectedFile));
  $('drop-title').textContent = selectedFile ? '也可以拖入另一个工程' : '把你的工程拖到这里';
  $('choose-file').textContent = selectedFile ? '更换 SB3 文件' : '选择 SB3 文件';
  $('file-name').textContent = selectedFile?.name || '';
  $('file-size').textContent = selectedFile ? formatBytes(selectedFile.size) : '';
  compileButton.disabled = busy || !selectedFile;
}

async function responseError(response) {
  const body = await response.text();
  let message;
  try {
    const data = JSON.parse(body);
    message = typeof data.error === 'string' ? data.error : data.message || data.error?.message;
    if (Array.isArray(data.details) && data.details.length) message = `${message || '编译失败'}\n${data.details.join('\n')}`;
  } catch (_) {
    if (body && !body.trimStart().startsWith('<')) message = body.slice(0, 1800);
  }
  return message || `编译服务返回错误（${response.status}）。请检查文件后重试。`;
}

function responseFilename(response, fallback) {
  const disposition = response.headers.get('Content-Disposition') || '';
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (encoded) {
    try { return decodeURIComponent(encoded[1]); } catch (_) { /* Use ordinary filename below. */ }
  }
  const ordinary = disposition.match(/filename="([^"]+)"|filename=([^;]+)/i);
  return ordinary ? (ordinary[1] || ordinary[2]).trim() : fallback;
}

function parseReport(response) {
  const encoded = response.headers.get('X-Protection-Report');
  if (!encoded) return null;
  try {
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (_) { return null; }
}

function responsePreviewUrl(response) {
  const header = response.headers.get('X-Preview-URL');
  if (!header) throw new Error('编译服务未提供隔离预览地址，请检查服务版本后重新编译。');
  let url;
  try { url = new URL(header); } catch (_) { throw new Error('编译服务返回了无效的预览地址。'); }
  const localHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'http:' || !localHost || url.username || url.password || url.port !== window.location.port || url.origin === window.location.origin || !url.pathname.startsWith('/preview/')) {
    throw new Error('预览地址未使用独立的本机来源，请检查服务配置。');
  }
  return url;
}

function loadPreview() {
  if (!previewUrl) return;
  if (Date.now() >= previewExpiresAt) {
    $('preview-state').textContent = '预览地址已过期';
    $('preview-hint').textContent = '重新编译即可生成新的预览地址。';
    setStatus('预览地址已过期，请重新编译。已下载的 HTML 仍可以离线打开。');
    return;
  }
  if (previewTimeout) clearTimeout(previewTimeout);
  $('preview-state').textContent = '播放器准备中';
  $('preview-hint').textContent = '正在载入作品。声音需要先与播放器互动。';
  player.src = previewUrl;
  previewTimeout = setTimeout(() => {
    previewTimeout = null;
    $('preview-state').textContent = '预览尚未就绪';
    $('preview-hint').textContent = '可重新加载；预览最长保留 30 分钟，失效后请重新编译。';
    setStatus('HTML 已生成。预览尚未就绪，可下载后打开，或重新加载预览。');
  }, 30000);
}

async function compile() {
  if (!selectedFile || busy) return;
  clearResult();
  const current = ++generation;
  const controller = new AbortController();
  activeController = controller;
  const file = selectedFile;
  const title = titleInput.value.trim() || file.name.replace(/\.sb3$/i, '') || 'Scratch 作品';
  setBusy(true);
  setStatus('正在本机检查积木并编译。较大的工程可能需要更久。');
  $('preview-state').textContent = '正在编译';
  try {
    const response = await fetch(`/api/compile?title=${encodeURIComponent(title)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(await responseError(response));
    const blob = await response.blob();
    if (current !== generation) return;
    if (!blob.size) throw new Error('编译服务没有返回 HTML 文件，请重新编译。');
    const contentType = response.headers.get('Content-Type') || '';
    if (!contentType.toLowerCase().includes('text/html')) throw new Error('编译服务返回的不是 HTML 文件，请检查服务状态。');
    const isolatedPreview = responsePreviewUrl(response);
    const filename = responseFilename(response, `${title}.html`).replace(/[\\/]/g, '-');
    resultUrl = URL.createObjectURL(new Blob([blob], { type: 'text/html;charset=utf-8' }));
    previewUrl = isolatedPreview.href;
    previewOrigin = isolatedPreview.origin;
    previewExpiresAt = Date.now() + 30 * 60 * 1000;
    loadPreview();
    player.hidden = false;
    $('empty-stage').hidden = true;
    $('stage-shell').classList.add('has-player');
    download.href = resultUrl;
    download.download = filename;
    download.setAttribute('aria-disabled', 'false');
    download.tabIndex = 0;
    $('reload-preview').disabled = false;
    $('download-heading').textContent = filename;
    $('download-description').textContent = `${formatBytes(blob.size)} · 单文件，下载后可离线打开`;
    setStatus('编译完成。播放器正在准备，HTML 已可以下载。', 'success');
    const report = parseReport(response);
    if (report) {
      $('report-content').textContent = JSON.stringify(report, null, 2);
      $('report').hidden = false;
    }
  } catch (error) {
    if (current !== generation || error.name === 'AbortError') return;
    $('preview-state').textContent = '尚未生成';
    setStatus(error instanceof TypeError ? '无法连接本机编译服务，请确认服务正在运行后重试。' : error.message || '编译失败，请检查工程后重试。', 'error');
  } finally {
    if (current === generation) {
      activeController = null;
      setBusy(false);
    }
  }
}

$('choose-file').addEventListener('click', () => input.click());
input.addEventListener('change', () => {
  if (input.files.length) chooseFile(input.files[0]);
  input.value = '';
});
$('remove-file').addEventListener('click', () => {
  cancelRequest();
  selectedFile = null;
  titleInput.value = '';
  clearResult();
  renderFile();
  setStatus('选择一个工程，即可开始。');
  $('choose-file').focus();
});
titleInput.addEventListener('input', () => {
  if (resultUrl) {
    clearResult();
    setStatus('作品名称已更改，请重新编译。');
  }
});
titleInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') compile();
});
compileButton.addEventListener('click', compile);
$('reload-preview').addEventListener('click', () => {
  if (previewUrl) loadPreview();
});

window.addEventListener('message', (event) => {
  if (!previewUrl || event.origin !== previewOrigin || event.source !== player.contentWindow) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type !== 'scratch-player-ready' && data.type !== 'scratch-player-error') return;
  if (previewTimeout) clearTimeout(previewTimeout);
  previewTimeout = null;
  if (data.type === 'scratch-player-ready') {
    $('preview-state').textContent = '已就绪 · 可以试玩';
    $('preview-hint').textContent = '点击绿旗开始试玩。声音需要先与播放器互动。';
    setStatus('编译完成。先试玩检查，再下载发布文件。', 'success');
  } else {
    $('preview-state').textContent = '预览加载失败';
    $('preview-hint').textContent = '可重新加载；预览最长保留 30 分钟，失效后请重新编译。';
    const message = typeof data.message === 'string' ? data.message.slice(0, 1200) : '播放器加载失败。';
    setStatus(`${message} 可以重新加载预览，或下载 HTML 后打开。`, 'error');
  }
});

for (const eventName of ['dragenter', 'dragover', 'dragleave', 'drop']) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
}
dropzone.addEventListener('dragenter', () => {
  dragDepth += 1;
  dropzone.classList.add('is-dragging');
});
dropzone.addEventListener('dragover', (event) => { event.dataTransfer.dropEffect = 'copy'; });
dropzone.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropzone.classList.remove('is-dragging');
});
dropzone.addEventListener('drop', (event) => {
  dragDepth = 0;
  dropzone.classList.remove('is-dragging');
  const files = event.dataTransfer.files;
  if (files.length !== 1) {
    setStatus('每次选择一个 SB3 工程即可。', 'error');
    return;
  }
  chooseFile(files[0]);
});

exampleButton.addEventListener('click', async () => {
  cancelRequest();
  const current = ++generation;
  const controller = new AbortController();
  activeController = controller;
  setBusy(true, '准备示例…');
  setStatus('正在载入示例工程…');
  try {
    const response = await fetch('/api/example', { signal: controller.signal });
    if (!response.ok) throw new Error(await responseError(response));
    const blob = await response.blob();
    if (current !== generation) return;
    const filename = responseFilename(response, '积木留存示例.sb3');
    chooseFile(new File([blob], filename, { type: 'application/zip' }));
    setStatus('示例已准备好。点击编译，体验上传到下载的完整流程。');
  } catch (error) {
    if (current !== generation || error.name === 'AbortError') return;
    setStatus(error instanceof TypeError ? '无法连接本机编译服务，请确认服务正在运行后重试。' : error.message || '示例工程暂时无法载入，请选择自己的 SB3 文件。', 'error');
  } finally {
    if (current === generation) {
      activeController = null;
      setBusy(false);
    }
  }
});

// Prevent files dropped outside the upload area from navigating away from the workbench.
document.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
document.addEventListener('drop', (event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
window.addEventListener('beforeunload', () => {
  activeController?.abort();
  if (previewTimeout) clearTimeout(previewTimeout);
  if (resultUrl) URL.revokeObjectURL(resultUrl);
});
