const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const gles = require('node-gles-webgl2');
const ShaderManager = require('scratch-render/src/ShaderManager');
const Drawable = require('scratch-render/src/Drawable');
const twgl = require('twgl.js');
const {Image, createCanvas} = require('@napi-rs/canvas');

const shaderDir = path.join(path.dirname(require.resolve('scratch-render/src/ShaderManager')), 'shaders');
const sources = ['sprite.vert', 'sprite.frag'].map(file => fs.readFileSync(path.join(shaderDir, file), 'utf8'));

const makeContext = () => gles.createWebGLRenderingContext({
  width: 32, height: 32, majorVersion: 3, minorVersion: 0, webGLCompatibility: true
});

const makeProgram = (gl, mode, bits) => {
  const defines = [`#define DRAW_MODE_${mode}`];
  ShaderManager.EFFECTS.forEach((effect, index) => {
    if (bits & (1 << index)) defines.push(`#define ENABLE_${effect}`);
  });
  const prefix = `${defines.join('\n')}\n`;
  const shaders = [];
  const program = gl.createProgram();
  try {
    for (let index = 0; index < 2; index++) {
      const shader = gl.createShader(index === 0 ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
      shaders.push(shader);
      gl.shaderSource(shader, prefix + sources[index]);
      gl.compileShader(shader);
      assert.ok(gl.getShaderParameter(shader, gl.COMPILE_STATUS),
        `${mode}/${bits}: ${gl.getShaderInfoLog(shader)}`);
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    assert.ok(gl.getProgramParameter(program, gl.LINK_STATUS),
      `${mode}/${bits}: ${gl.getProgramInfoLog(program)}`);
    return program;
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    shaders.forEach(shader => gl.deleteShader(shader));
  }
};

test('native GLES3 compiles every frozen Scratch shader mode/effect combination', {timeout: 120000}, () => {
  assert.equal(typeof document, 'undefined');
  assert.equal(typeof window, 'undefined');
  const gl = makeContext();
  try {
    assert.match(gl.getParameter(gl.VERSION), /OpenGL ES 3/);
    assert.equal(typeof gl.createVertexArray, 'function');
    assert.equal(typeof gl.texImage3D, 'function');
    for (const mode of Object.values(ShaderManager.DRAW_MODE)) {
      const effectiveMasks = new Set();
      for (let bits = 0; bits < (1 << ShaderManager.EFFECTS.length); bits++) {
        const effective = mode === 'silhouette' ?
          bits & ~(ShaderManager.EFFECT_INFO.color.mask | ShaderManager.EFFECT_INFO.brightness.mask) : bits;
        effectiveMasks.add(effective);
      }
      for (const bits of effectiveMasks) gl.deleteProgram(makeProgram(gl, mode, bits));
    }
    assert.equal(gl.getError(), gl.NO_ERROR);
  } finally {
    gl.destroy();
  }
});

test('native SVG pixels render through frozen Scratch Drawable transforms and sprite shader', () => {
  const gl = makeContext();
  let program;
  let buffer;
  let texture;
  try {
    const image = new Image();
    image.src = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
    const canvas = createCanvas(8, 8);
    canvas.getContext('2d').drawImage(image, 0, 0);
    const rgba = canvas.getContext('2d').getImageData(0, 0, 8, 8).data;
    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 8, 8, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    const drawable = new Drawable(0, {dirty: false});
    drawable.skin = {size: [8, 8], rotationCenter: [4, 4, 0]};
    drawable.updatePosition([5, -3]);
    program = makeProgram(gl, 'default', 0);
    gl.useProgram(program);
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -0.5, -0.5, 1, 0, 0.5, -0.5, 0, 0, -0.5, 0.5, 1, 1,
      -0.5, 0.5, 1, 1, 0.5, -0.5, 0, 0, 0.5, 0.5, 0, 1
    ]), gl.STATIC_DRAW);
    for (const [name, offset] of [['a_position', 0], ['a_texCoord', 8]]) {
      const location = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 16, offset);
    }
    gl.uniformMatrix4fv(gl.getUniformLocation(program, 'u_projectionMatrix'), false,
      twgl.m4.ortho(-16, 16, -16, 16, -1, 1));
    gl.uniformMatrix4fv(gl.getUniformLocation(program, 'u_modelMatrix'), false,
      drawable.getUniforms().u_modelMatrix);
    gl.uniform1i(gl.getUniformLocation(program, 'u_skin'), 0);
    gl.viewport(0, 0, 32, 32);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    const pixels = new Uint8Array(32 * 32 * 4);
    gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let redPixels = 0;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const expectedRed = x >= 17 && x < 25 && y >= 9 && y < 17;
        const offset = (y * 32 + x) * 4;
        assert.deepEqual(Array.from(pixels.subarray(offset, offset + 4)),
          expectedRed ? [255, 0, 0, 255] : [255, 255, 255, 255], `pixel ${x},${y}`);
        if (expectedRed) redPixels++;
      }
    }
    assert.equal(redPixels, 64);
    assert.equal(gl.getError(), gl.NO_ERROR);
    assert.equal(typeof document, 'undefined');
    assert.equal(typeof window, 'undefined');
  } finally {
    if (texture) gl.deleteTexture(texture);
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    gl.destroy();
  }
});

test('frozen Scratch background shader draws expected pixels offscreen', () => {
  const gl = makeContext();
  let program;
  let buffer;
  try {
    program = makeProgram(gl, 'background', 0);
    gl.useProgram(program);
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
      -0.5, 0.5, 0.5, -0.5, 0.5, 0.5
    ]), gl.STATIC_DRAW);
    const attribute = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(attribute);
    gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
    gl.uniform4f(gl.getUniformLocation(program, 'u_backgroundColor'), 1, 0, 0, 1);
    gl.viewport(0, 0, 32, 32);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    const pixels = new Uint8Array(32 * 32 * 4);
    gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (let offset = 0; offset < pixels.length; offset += 4) {
      assert.deepEqual(Array.from(pixels.subarray(offset, offset + 4)), [255, 0, 0, 255]);
    }
    assert.equal(gl.getError(), gl.NO_ERROR);
    assert.equal(typeof document, 'undefined');
    assert.equal(typeof window, 'undefined');
  } finally {
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    gl.destroy();
  }
});
