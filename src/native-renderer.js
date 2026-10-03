require('./native-environment');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const gles = require('node-gles-webgl2');
const {createCanvas, Image, ImageData, convertSVGTextToPath} = require('@napi-rs/canvas');
const {readBuiltinFonts, parseFontCSS, validateFamily, acquireNativeFont, releaseNativeFont} = require('./font-commands');
const Skin = require('scratch-render/src/Skin');
const ShaderManager = require('scratch-render/src/ShaderManager');
const {parseDOM} = require('htmlparser2');
const serialize = require('dom-serializer');
const {Resvg} = require('@resvg/resvg-js');

const checkDimensions = (width, height) => {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 16000000) {
    throw new Error('Image dimensions must be positive integers within the 16-million-pixel limit');
  }
};

// Validate decoded XML attributes and CSS, not the original spelling of a URL. The
// native SVG decoder must never get external resources or nested executable SVGs.
const parseSVG = source => {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 16 * 1024 * 1024) throw new Error('SVG is too large');
  const denied = () => {throw new Error('External/executable SVG resources are denied');};
  if (/<!DOCTYPE|<!ENTITY|<\?(?!xml\s)/i.test(source)) denied();
  const nodes = parseDOM(source, {xmlMode: true, decodeEntities: true, recognizeCDATA: true});
  const roots = nodes.filter(node => node.name);
  if (roots.length !== 1 || roots[0].name !== 'svg') throw new Error('SVG root is missing');
  const checkReference = value => {
    if (/^#[^\s]*$/.test(value)) return;
    const raster = value.match(/^data:image\/(png|jpeg|gif|bmp|webp);base64,([a-z0-9+/=\s]+)$/i);
    if (raster) {
      const bytes = Buffer.from(raster[2], 'base64');
      const format = raster[1].toLowerCase();
      // A declared raster MIME type alone is not enough: the native decoder can
      // sniff nested SVG bytes regardless of the data URI's stated type.
      const valid = format === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) :
        format === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
        format === 'gif' ? /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6)) :
        format === 'bmp' ? bytes.toString('ascii', 0, 2) === 'BM' :
        bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (valid) return;
    }
    denied();
  };
  const checkCSS = value => {
    const css = value.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi,
      (_, hex, character) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : character);
    if (/@|expression\s*\(|javascript\s*:/i.test(css)) denied();
    const withoutURLs = css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi, (_, double, single, bare) => {
      checkReference((double ?? single ?? bare).trim());
      return '';
    });
    if (/url\s*\(/i.test(withoutURLs)) denied();
  };
  const pending = [...nodes];
  let count = 0;
  while (pending.length) {
    const node = pending.pop();
    if (++count > 100000) throw new Error('SVG has too many nodes');
    if (node.name && /^(?:script|foreignobject|animate.*|set|a|audio|video|iframe|object|embed)$/i.test(node.name.split(':').pop())) denied();
    for (const [name, value] of Object.entries(node.attribs || {})) {
      if (/^on/i.test(name) || name.toLowerCase() === 'xml:base') denied();
      if (/(?:^|:)(?:href|src)$/i.test(name)) checkReference(value.trim());
      checkCSS(value);
    }
    if (node.name?.split(':').pop().toLowerCase() === 'style') {
      const text = [...(node.children || [])];
      const parts = [];
      while (text.length) {const child = text.pop(); if (child.data) parts.unshift(child.data); text.push(...(child.children || []));}
      checkCSS(parts.join(''));
    }
    pending.push(...(node.children || []));
  }
  return roots[0];
};

const rasterizeSVG = (source, width, height, renderer) => {
  let bytes = Buffer.isBuffer(source) ? source : Buffer.from(source);
  const hasText = /<(?:text|tspan)\b/i.test(bytes.toString('utf8'));
  if (hasText && renderer) bytes = renderer._outlineFontSVG(bytes);
  if (!hasText && !/<image\b/i.test(bytes.toString('utf8'))) {
    const image = new Image(width, height); image.src = bytes;
    const canvas = createCanvas(width, height); canvas.getContext('2d').drawImage(image, 0, 0, width, height);
    return canvas.getContext('2d').getImageData(0, 0, width, height);
  }
  const root = parseSVG(bytes.toString('utf8'));
  root.attribs.width = String(width); root.attribs.height = String(height);
  if (!root.attribs.viewBox) {
    const natural = new Image(); natural.src = bytes;
    root.attribs.viewBox = `0 0 ${natural.width} ${natural.height}`;
  }
  const rasterizer = new Resvg(Buffer.from(serialize(root, {xmlMode: true})), {font: {loadSystemFonts: false}, logLevel: 'off'});
  if (rasterizer.imagesToResolve().length) throw new Error('Unresolved SVG images are denied');
  const image = rasterizer.render(); checkDimensions(image.width, image.height);
  const pixels = new Uint8ClampedArray(image.pixels);
  for (let index = 0; index < pixels.length; index += 4) {
    const alpha = pixels[index + 3];
    for (let channel = 0; channel < 3; channel++) pixels[index + channel] = alpha ? Math.round(pixels[index + channel] * 255 / alpha) : 0;
  }
  return new ImageData(pixels, image.width, image.height);
};

const uploadPixels = (skin, data, updateSilhouette = true) => {
  checkDimensions(data.width, data.height);
  const gl = skin._renderer.gl;
  if (data.width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || data.height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) {
    throw new Error('Image exceeds the native maximum texture dimension');
  }
  const premultiplied = new Uint8Array(data.data.length);
  for (let i = 0; i < data.data.length; i += 4) {
    const alpha = data.data[i + 3] / 255;
    premultiplied[i] = Math.round(data.data[i] * alpha);
    premultiplied[i + 1] = Math.round(data.data[i + 1] * alpha);
    premultiplied[i + 2] = Math.round(data.data[i + 2] * alpha);
    premultiplied[i + 3] = data.data[i + 3];
  }
  if (!skin._texture) skin._texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, skin._texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, data.width, data.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, premultiplied);
  if (updateSilhouette) skin._silhouette.update(data);
};

const sourceRoot = path.dirname(require.resolve('scratch-render/src/RenderWebGL'));
const modules = new Map();
const twglFile = require.resolve('twgl.js');
const nativeTwglModule = new Module(twglFile, module);
nativeTwglModule.filename = twglFile;
nativeTwglModule.paths = Module._nodeModulePaths(path.dirname(twglFile));
let twglSource = fs.readFileSync(twglFile, 'utf8');
for (const kind of ['Buffer', 'Renderbuffer', 'Shader', 'Texture', 'Sampler']) {
  const pattern = new RegExp(`function is${kind}\\(gl, t\\) \\{[\\s\\S]*?return t instanceof rep${kind}\\.constructor;\\n\\}`);
  if (!pattern.test(twglSource)) throw new Error(`Frozen TWGL ${kind} boundary changed`);
  twglSource = twglSource.replace(pattern, `function is${kind}(gl, t) {return gl._nativeKinds.${kind}.has(t);}`);
}
nativeTwglModule._compile(twglSource, twglFile);
const nativeTwgl = nativeTwglModule.exports;

class PixelSkin extends Skin {
  constructor(id, renderer) {
    super(id, renderer);
    this._silhouette = new (compile('Silhouette.js'))();
    this._size = [0, 0];
    this.resolution = 1;
    this.vector = false;
    this._scaledMIPs = new Map();
    this._largestMIPScale = 0;
  }

  get size() {return this._size;}
  getTexture(scale) {
    if (!this.vector) return this._texture;
    const requested = (scale ? Math.max(Math.abs(scale[0]), Math.abs(scale[1])) : 100) / 100;
    const level = Math.max(-8, Math.min(this._maxMIPLevel, Math.ceil(Math.log2(requested))));
    if (!this._scaledMIPs.has(level)) {
      const mipScale = 2 ** level;
      const width = Math.floor(this._size[0] * mipScale), height = Math.floor(this._size[1] * mipScale);
      if (!width || !height) return null;
      // Give the decoder the raster dimensions too: a 1x SVG image scaled by
      // drawImage would just magnify already-rasterized edges.
      const data = rasterizeSVG(this._svg, width, height, this._renderer);
      this._texture = null;
      uploadPixels(this, data, mipScale > this._largestMIPScale);
      this._largestMIPScale = Math.max(mipScale, this._largestMIPScale);
      this._scaledMIPs.set(level, this._texture);
    }
    return this._scaledMIPs.get(level);
  }
  updateSilhouette(scale) {if (this.vector) this.getTexture(scale); super.updateSilhouette();}
  useNearest(scale, drawable) {
    if (!this.vector) return true; // Frozen BitmapSkin inherits Skin's unconditional nearest filtering.
    if (drawable.enabledEffects & (ShaderManager.EFFECT_INFO.fisheye.mask | ShaderManager.EFFECT_INFO.whirl.mask |
      ShaderManager.EFFECT_INFO.pixelate.mask | ShaderManager.EFFECT_INFO.mosaic.mask)) return false;
    return drawable._direction % 90 === 0 && Math.abs(scale[0]) > 99 && Math.abs(scale[0]) < 101 &&
      Math.abs(scale[1]) > 99 && Math.abs(scale[1]) < 101;
  }
  resetMIPs() {
    for (const texture of this._scaledMIPs.values()) this._renderer.gl.deleteTexture(texture);
    this._scaledMIPs.clear();
    this._largestMIPScale = 0;
    this._texture = null;
  }
  setPixels(image, resolution = 1, center) {
    checkDimensions(image.width, image.height);
    if (!Number.isFinite(resolution) || resolution <= 0) throw new Error('Bitmap resolution must be positive');
    const canvas = createCanvas(image.width, image.height);
    if (image instanceof ImageData) canvas.getContext('2d').putImageData(image, 0, 0);
    else canvas.getContext('2d').drawImage(image, 0, 0);
    uploadPixels(this, canvas.getContext('2d').getImageData(0, 0, image.width, image.height));
    this.resolution = resolution;
    this._size = [image.width / resolution, image.height / resolution];
    const rotation = center || this.calculateRotationCenter();
    this._rotationCenter[0] = rotation[0];
    this._rotationCenter[1] = rotation[1];
    this.emitWasAltered();
  }
  setBitmap(image, resolution, center) {
    if (this.vector) this.resetMIPs();
    this.vector = false;
    this._svg = null;
    this.setPixels(image, resolution || 2, center);
  }
  setSVG(svg, center) {
    const root = parseSVG(svg);
    let viewBox;
    if (root.attribs.viewBox !== undefined) {
      viewBox = root.attribs.viewBox.trim().split(/[\s,]+/).map(Number);
      if (viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[3] <= 0) {
        throw new Error('SVG has invalid viewBox dimensions');
      }
      // Frozen SVGSkin uses viewBox units, not CSS width/height, for costume size.
      root.attribs.width = String(viewBox[2]); root.attribs.height = String(viewBox[3]);
    }
    const bytes = Buffer.from(serialize(root, {xmlMode: true}));
    const image = new Image(); image.src = bytes;
    checkDimensions(image.width, image.height);
    if (!viewBox) viewBox = [0, 0, image.width, image.height];
    if (this.vector) this.resetMIPs();
    else if (this._texture) {this._renderer.gl.deleteTexture(this._texture); this._texture = null;}
    this.vector = true;
    this._svg = bytes;
    this._size = viewBox.slice(2);
    this.resolution = 1;
    const rotation = center || this.calculateRotationCenter();
    this._rotationCenter[0] = rotation[0] - viewBox[0];
    this._rotationCenter[1] = rotation[1] - viewBox[1];
    const maxDimension = Math.ceil(Math.max(...this._size));
    const maxScale = Math.min(this._renderer.maxTextureDimension / maxDimension,
      this._renderer.gl.getParameter(this._renderer.gl.MAX_TEXTURE_SIZE) / maxDimension,
      Math.sqrt(16000000 / (this._size[0] * this._size[1])));
    this._maxMIPLevel = Math.max(0, Math.floor(Math.log2(maxScale)));
    this.getTexture([100, 100]);
    this.emitWasAltered();
  }
  setEmptyImageData() {this.setBitmap(new ImageData(1, 1), 1, [0, 0]);}
  dispose() {
    if (this.vector) this.resetMIPs();
    else if (this._texture) this._renderer.gl.deleteTexture(this._texture);
    this._texture = null;
    this._svg = null;
    super.dispose();
  }
}

const compile = name => {
  if (modules.has(name)) return modules.get(name).exports;
  const filename = path.join(sourceRoot, name);
  let source = fs.readFileSync(filename, 'utf8');
  if (name === 'RenderWebGL.js') {
    const start = source.indexOf('const loadStyles = () => {');
    const end = source.indexOf('\n\n\nclass RenderWebGL', start);
    if (start < 0 || end < 0) throw new Error('Frozen renderer stylesheet boundary changed');
    source = source.slice(0, start) + 'const loadStyles = () => {};\n' + source.slice(end);
    source = source.replace("this.overlayContainer = document.createElement('div');", 'this.overlayContainer = {};');
    source = source.replaceAll('window.devicePixelRatio', '1');
    source = source.replace('RenderWebGL._getContext(canvas)', 'canvas.context');
  }
  if (name === 'PenSkin.js') {
    // Upstream relies on context destruction to reclaim these objects, but the
    // CLI also destroys/resizes individual pen skins in long-lived renderers.
    source = source.replace('        this._renderer.removeListener(RenderConstants.Events.NativeSizeChanged, this.onNativeSizeChanged);',
      '        this._renderer._doExitDrawRegion();\n' +
      '        this._renderer.gl.deleteFramebuffer(this._framebuffer.framebuffer);\n' +
      '        this._renderer.gl.deleteBuffer(this.a_position_glbuffer);\n' +
      '        this._renderer.gl.deleteBuffer(this.attribute_glbuffer);\n' +
      '        this._renderer.removeListener(RenderConstants.Events.NativeSizeChanged, this.onNativeSizeChanged);');
    source = source.replace('        this._size = canvasSize;', '        this._renderer._doExitDrawRegion();\n        this._size = canvasSize;');
    source = source.replace('        if (this._framebuffer) {',
      '        if (this._framebuffer) {\n            gl.deleteFramebuffer(this._framebuffer.framebuffer);');
    source = source.replace('            this._drawPenTexture(oldTexture);',
      '            this._drawPenTexture(oldTexture);\n            this._renderer._doExitDrawRegion();\n            gl.deleteTexture(oldTexture);');
  }
  if (name === 'Silhouette.js') source = source.replace("document.createElement('canvas')", 'createCanvas(1, 1)');
  if (name === 'TextBubbleSkin.js') {
    source = source.replace("document.createElement('canvas')", 'createCanvas(1, 1)');
    source = source.replace('this._texture = twgl.createTexture(gl, textureOptions);', 'this._texture = gl.createTexture();');
    source = source.replace('this._setTexture(textureData);', 'uploadPixels(this, textureData);');
  }
  const compiled = new Module(filename, module);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(sourceRoot);
  const originalRequire = compiled.require.bind(compiled);
  compiled.require = request => {
    if (request === 'twgl.js') return nativeTwgl;
    if (request.startsWith('raw-loader!') || request.startsWith('!raw-loader!')) {
      return fs.readFileSync(path.resolve(path.dirname(filename), request.slice(request.lastIndexOf('!') + 1)), 'utf8');
    }
    if (request === './SVGSkin' || request === './BitmapSkin') return PixelSkin;
    if (request === './Skin') return compile('Skin.js');
    if (request === './Silhouette') return compile('Silhouette.js');
    if (request === './ShaderManager') return compile('ShaderManager.js');
    if (request === './PenSkin') return compile('PenSkin.js');
    if (request === './TextBubbleSkin') return compile('TextBubbleSkin.js');
    if (request === './util/text-wrapper') return compile('util/text-wrapper.js');
    if (request.startsWith('!ify-loader!')) return originalRequire(request.slice('!ify-loader!'.length));
    return originalRequire(request);
  };
  compiled.requireNativeValues = {ImageData, createCanvas, uploadPixels};
  modules.set(name, compiled);
  try {
    compiled._compile('const {ImageData, createCanvas, uploadPixels} = module.requireNativeValues;\n' + source, filename);
  } catch (error) {
    modules.delete(name);
    throw error;
  }
  return compiled.exports;
};

const RenderWebGL = compile('RenderWebGL.js');
const handleOwners = new WeakMap();

class NativeRenderer extends RenderWebGL {
  constructor(width = 480, height = 360) {
    checkDimensions(width, height);
    const native = gles.createWebGLRenderingContext({width, height, majorVersion: 3, minorVersion: 0, webGLCompatibility: true});
    const context = {_nativeKinds: {}};
    const kinds = ['Buffer', 'Renderbuffer', 'Shader', 'Texture', 'Sampler', 'Program', 'Framebuffer', 'VertexArray', 'Query', 'TransformFeedback'];
    const handles = Object.fromEntries(kinds.map(kind => [kind, new Map()]));
    for (const kind of kinds) context._nativeKinds[kind] = new Set();
    const handleArguments = {
      bindTexture: {1: 'Texture'}, bindBuffer: {1: 'Buffer'}, bindFramebuffer: {1: 'Framebuffer'}, bindRenderbuffer: {1: 'Renderbuffer'},
      bindSampler: {1: 'Sampler'}, bindVertexArray: {0: 'VertexArray'},
      framebufferTexture2D: {3: 'Texture'}, framebufferRenderbuffer: {3: 'Renderbuffer'},
      useProgram: {0: 'Program'}, linkProgram: {0: 'Program'}, validateProgram: {0: 'Program'},
      attachShader: {0: 'Program', 1: 'Shader'}, detachShader: {0: 'Program', 1: 'Shader'},
      shaderSource: {0: 'Shader'}, compileShader: {0: 'Shader'}, getShaderParameter: {0: 'Shader'}, getShaderInfoLog: {0: 'Shader'},
      getProgramParameter: {0: 'Program'}, getProgramInfoLog: {0: 'Program'}, getAttachedShaders: {0: 'Program'},
      getUniformLocation: {0: 'Program'}, getAttribLocation: {0: 'Program'}, getActiveUniform: {0: 'Program'}, getActiveAttrib: {0: 'Program'}
    };
    for (const kind of kinds) {handleArguments[`delete${kind}`] = {0: kind}; handleArguments[`is${kind}`] = {0: kind};}
    let destroyed = false;
    const names = new Set();
    for (let object = native; object && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
      for (const name of Object.getOwnPropertyNames(object)) names.add(name);
    }
    const bindings = new Map();
    for (const [kind, parameters] of Object.entries({
      Texture: ['TEXTURE_BINDING_2D', 'TEXTURE_BINDING_CUBE_MAP', 'TEXTURE_BINDING_3D', 'TEXTURE_BINDING_2D_ARRAY'],
      Buffer: ['ARRAY_BUFFER_BINDING', 'ELEMENT_ARRAY_BUFFER_BINDING', 'COPY_READ_BUFFER_BINDING', 'COPY_WRITE_BUFFER_BINDING',
        'PIXEL_PACK_BUFFER_BINDING', 'PIXEL_UNPACK_BUFFER_BINDING', 'UNIFORM_BUFFER_BINDING'],
      Renderbuffer: ['RENDERBUFFER_BINDING'], Program: ['CURRENT_PROGRAM'], Framebuffer: ['FRAMEBUFFER_BINDING', 'READ_FRAMEBUFFER_BINDING'],
      VertexArray: ['VERTEX_ARRAY_BINDING'], Sampler: ['SAMPLER_BINDING'], TransformFeedback: ['TRANSFORM_FEEDBACK_BINDING']
    })) for (const parameter of parameters) if (native[parameter] !== undefined) bindings.set(native[parameter], kind);
    for (const name of names) {
      if (name === 'constructor' || name.startsWith('_')) continue;
      const value = native[name];
      if (typeof value !== 'function') {context[name] = value; continue;}
      context[name] = (...args) => {
        if (name === 'destroy' && destroyed) return;
        if (destroyed) throw new Error('Native renderer context is disposed');
        if (name.startsWith('delete') && args[0] && handleOwners.get(args[0]) === context &&
          !context._nativeKinds[args[0].kind].has(args[0])) return;
        const unwrapped = args.map((arg, index) => {
          const expected = handleArguments[name]?.[index];
          if (arg !== null && arg !== undefined && expected &&
            (handleOwners.get(arg) !== context || arg.kind !== expected)) {
            throw new Error(`Invalid native ${expected} handle for this context`);
          }
          if (arg && typeof arg === 'object' && 'nativeHandle' in arg) {
            if (handleOwners.get(arg) !== context) throw new Error('Native handle belongs to another context or is invalid');
            if (!context._nativeKinds[arg.kind].has(arg)) throw new Error('Native handle is deleted');
            return arg.nativeHandle;
          }
          return arg;
        });
        // TWGL 4 uses WebGL's unsized DEPTH_STENCIL enum. GLES3 requires a sized
        // storage format; without this translation the query FBO has no stencil.
        if (name === 'renderbufferStorage' && unwrapped[1] === native.DEPTH_STENCIL) unwrapped[1] = native.DEPTH24_STENCIL8;
        const result = value.apply(native, unwrapped);
        const kind = name.startsWith('create') ? name.slice(6) : '';
        if (kinds.includes(kind)) {
          if (!result) return null;
          const handle = Object.freeze({nativeHandle: result, kind});
          handleOwners.set(handle, context);
          handles[kind].set(result, handle);
          context._nativeKinds[kind].add(handle);
          return handle;
        }
        const deletedKind = name.startsWith('delete') ? name.slice(6) : '';
        if (kinds.includes(deletedKind) && args[0]) {
          context._nativeKinds[deletedKind].delete(args[0]);
          handles[deletedKind].delete(unwrapped[0]);
        }
        if (name === 'getParameter' && bindings.has(args[0])) return handles[bindings.get(args[0])].get(result) || null;
        if (name === 'getAttachedShaders') return result.map(id => handles.Shader.get(id));
        if (name === 'destroy') {
          destroyed = true;
          for (const kind of kinds) {handles[kind].clear(); context._nativeKinds[kind].clear();}
        }
        return result;
      };
    }
    const surface = {width, height, clientWidth: width, clientHeight: height, context};
    context.canvas = surface;
    try {super(surface, -width / 2, width / 2, -height / 2, height / 2);} catch (error) {
      context.destroy();
      throw error;
    }
    this._fontRecords = new Map();
    this._fontRegistrations = [];
    try {this.setCustomFonts({});} catch (error) {this.dispose(); throw error;}
    surface.toDataURL = () => `data:image/png;base64,${this._readPNG().toString('base64')}`;
  }

  resize(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > 4096 || height > 4096 || width * height > 16000000) throw new Error('Output dimensions must be integers 1..4096, max 16 million pixels');
    if (this.canvas.width === width && this.canvas.height === height) return;
    this._doExitDrawRegion();
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    this.gl.drawingBufferStorage(this.gl.RGBA8, width, height);
    this.canvas.width = width; this.canvas.height = height;
    this.canvas.clientWidth = width; this.canvas.clientHeight = height;
    this.gl.drawingBufferWidth = width; this.gl.drawingBufferHeight = height;
    this._updateRenderQuality();
    this.dirty = true;
  }
  _updateOverlays() {}
  addOverlay() {throw new Error('DOM overlays are not supported by the pure command-line renderer');}
  removeOverlay() {}
  setCustomFonts(fonts) {
    const custom = parseFontCSS(fonts);
    const candidates = new Map(readBuiltinFonts().map(font => [font.family.toLowerCase(), {family: font.family, fallback: 'sans-serif', data: font.data}]));
    for (const font of custom) candidates.set(font.family.toLowerCase(), font);
    const records = new Map(), registrations = [];
    try {
      for (const [key, font] of candidates) {
        // The native font registry deduplicates binary faces globally, so aliases
        // are content-addressed and reference-counted, not removed by a peer reset.
        const registration = acquireNativeFont(font.data);
        registrations.push(registration); records.set(key, {...font, alias: registration.alias});
      }
    } catch (error) {registrations.forEach(releaseNativeFont); throw error;}
    const old = this._fontRegistrations;
    this._fontRecords = records; this._fontRegistrations = registrations;
    this.customFonts = {...fonts};
    if (old?.length) old.forEach(releaseNativeFont);
    for (const skin of this._allSkins) if (skin?.vector) {skin.resetMIPs(); skin.emitWasAltered();}
    this.dirty = true;
  }
  _fontAlias(family) {
    for (const font of this._fontRecords.values()) if (font.alias === family) return family;
    const names = String(family || 'Sans Serif').split(',').map(name => name.trim().replace(/^['"]|['"]$/g, '').toLowerCase());
    for (const name of names) {
      const matched = this._fontRecords.get(name); if (matched) return matched.alias;
      const generic = {serif: 'serif', 'sans-serif': 'sans serif', monospace: 'pixel', cursive: 'handwriting', fantasy: 'curly'}[name];
      if (generic) return this._fontRecords.get(generic).alias;
    }
    return this._fontRecords.get('sans serif').alias;
  }
  _outlineFontSVG(source) {
    const root = parseSVG(Buffer.isBuffer(source) ? source.toString('utf8') : source);
    root.attribs['font-family'] = this._fontAlias(root.attribs['font-family']);
    const pending = [root];
    while (pending.length) {
      const node = pending.pop();
      if (node.attribs) {
        if (node.attribs['font-family']) node.attribs['font-family'] = this._fontAlias(node.attribs['font-family']);
        if (node.attribs.style) {
          if (/(?:^|;)\s*font\s*:/i.test(node.attribs.style)) throw new Error('SVG font shorthand is outside the safe native font CSS subset');
          node.attribs.style = node.attribs.style.replace(/(^|;)\s*font-family\s*:\s*([^;]+)/gi,
            (_, separator, family) => `${separator}font-family:${this._fontAlias(family)}`);
        }
        if (node.name?.toLowerCase() === 'style') {
          for (const child of node.children || []) if (child.data) child.data = child.data.replace(/font-family\s*:\s*([^;}]+)/gi,
            (_, family) => `font-family:${this._fontAlias(family)}`);
        }
      }
      pending.push(...(node.children || []));
    }
    const outlined = Buffer.from(convertSVGTextToPath(Buffer.from(serialize(root, {xmlMode: true}))).toString('utf8').replace(/^<\?xml[^?]*\?>\s*/, ''));
    // Feed only outlines to Resvg: no host font discovery or URL/file lookup.
    if (/<(?:text|tspan)\b/i.test(outlined.toString('utf8'))) throw new Error('Native SVG font outlining failed');
    return outlined;
  }
  measureFontText(family, text, size = 24) {
    validateFamily(family);
    if (typeof text !== 'string' || Buffer.byteLength(text) > 100000 || !Number.isFinite(size) || size < 1 || size > 512) throw new Error('Text/font size exceeds native preview limits');
    const context = createCanvas(1, 1).getContext('2d');
    context.font = `${size}px "${this._fontAlias(family)}"`;
    const metrics = context.measureText(text);
    return {family, text, size, width: metrics.width, bounds: {
      left: metrics.actualBoundingBoxLeft, right: metrics.actualBoundingBoxRight,
      ascent: metrics.actualBoundingBoxAscent, descent: metrics.actualBoundingBoxDescent
    }, hostFonts: false};
  }
  fontPreview(family, text, {size = 24, width = 320, height = 80} = {}) {
    this.measureFontText(family, text, size); checkDimensions(width, height);
    if (width > 4096 || height > 4096) throw new Error('Font preview dimensions exceed 4096');
    const canvas = createCanvas(width, height), context = canvas.getContext('2d');
    context.fillStyle = 'white'; context.fillRect(0, 0, width, height);
    context.fillStyle = 'black'; context.font = `${size}px "${this._fontAlias(family)}"`; context.fillText(text, 8, Math.min(height - 8, size + 8));
    return canvas.toBuffer('image/png');
  }
  png() {
    this.dirty = true;
    this.draw();
    return this._readPNG();
  }
  _readPNG() {
    const {width, height} = this.canvas;
    const pixels = new Uint8Array(width * height * 4);
    this.gl.readPixels(0, 0, width, height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixels);
    const flipped = new Uint8ClampedArray(pixels.length);
    for (let row = 0; row < height; row++) {
      for (let x = 0; x < width; x++) {
        const input = (row * width + x) * 4, output = ((height - row - 1) * width + x) * 4;
        const alpha = pixels[input + 3];
        // readPixels is premultiplied; PNG/ImageData uses straight-alpha RGB.
        for (let channel = 0; channel < 3; channel++) flipped[output + channel] = alpha ? Math.round(pixels[input + channel] * 255 / alpha) : 0;
        flipped[output + 3] = alpha;
      }
    }
    const canvas = createCanvas(width, height);
    canvas.getContext('2d').putImageData(new ImageData(flipped, width, height), 0, 0);
    return canvas.toBuffer('image/png');
  }
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    try {
      this._doExitDrawRegion();
      for (const drawable of this._allDrawables) if (drawable) drawable.dispose();
      for (const skin of this._allSkins) if (skin) skin.dispose();
    } finally {
      this._allDrawables.length = 0;
      this._allSkins.length = 0;
      this._drawList.length = 0;
      this._snapshotCallbacks.length = 0;
      this.removeAllListeners();
      if (this._fontRegistrations?.length) this._fontRegistrations.forEach(releaseNativeFont);
      this._fontRegistrations = []; this._fontRecords?.clear();
      this.gl.destroy();
    }
  }
}

module.exports = {NativeRenderer, PixelSkin, rasterizeSVG};
