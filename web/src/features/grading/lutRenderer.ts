/**
 * 共享一个 WebGL2 上下文做 3D LUT 预览，结果拷到各自的 2D canvas。
 * 浏览器对 WebGL 上下文有数量上限（约 16），网格里每张缩略图各开一个会被回收——所以只开一个。
 * 采样与服务端一致：三线性（GPU 硬件插值）+ 强度 mix。
 */
import type { Lut } from './cube.ts';

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = vec2((p.x+1.)*.5, 1.-(p.y+1.)*.5); gl_Position = vec4(p,0.,1.); }`;
const FS = `#version 300 es
precision highp float; precision highp sampler3D;
uniform sampler2D img; uniform sampler3D lut; uniform float strength; uniform float size;
in vec2 uv; out vec4 o;
void main(){
  vec4 c = texture(img, uv);
  vec3 q = (c.rgb * (size - 1.) + .5) / size;
  o = vec4(mix(c.rgb, texture(lut, q).rgb, strength), 1.);
}`;

class Renderer {
  private gl: WebGL2RenderingContext;
  private canvas: HTMLCanvasElement;
  private prog: WebGLProgram;
  private imgTex: WebGLTexture;
  private luts = new Map<Lut, WebGLTexture>();

  constructor() {
    this.canvas = document.createElement('canvas');
    const gl = this.canvas.getContext('webgl2', { preserveDrawingBuffer: true, premultipliedAlpha: false });
    if (!gl) throw new Error('浏览器不支持 WebGL2');
    this.gl = gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    this.prog = prog;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.imgTex = gl.createTexture()!;
    gl.uniform1i(gl.getUniformLocation(prog, 'img'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'lut'), 1);
  }

  private lutTex(lut: Lut): WebGLTexture {
    let t = this.luts.get(lut);
    if (t) return t;
    const gl = this.gl;
    t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, t);
    // 16F 可线性过滤（32F 需扩展）
    const half = new Uint16Array(lut.table.length);
    for (let i = 0; i < half.length; i++) half[i] = toHalf(lut.table[i]!);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, lut.size, lut.size, lut.size, 0, gl.RGB, gl.HALF_FLOAT, half);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    this.luts.set(lut, t);
    return t;
  }

  draw(img: HTMLImageElement, lut: Lut | null, strength: number, out: HTMLCanvasElement): void {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return;
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    if (!ctx) return;
    if (!lut || strength <= 0) {
      ctx.drawImage(img, 0, 0);
      return;
    }
    const gl = this.gl;
    this.canvas.width = w;
    this.canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex(lut));
    gl.uniform1f(gl.getUniformLocation(this.prog, 'strength'), strength);
    gl.uniform1f(gl.getUniformLocation(this.prog, 'size'), lut.size);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    ctx.drawImage(this.canvas, 0, 0);
  }
}

function toHalf(v: number): number {
  const f = new Float32Array([v]);
  const x = new Uint32Array(f.buffer)[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 112;
  const man = (x >>> 13) & 0x3ff;
  if (exp <= 0) return sign;
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | man;
}

let shared: Renderer | null | undefined;
/** 不支持 WebGL2 时返回 null：预览退回原图，导出仍由服务端套滤镜 */
export function lutRenderer(): Renderer | null {
  if (shared === undefined) {
    try {
      shared = new Renderer();
    } catch {
      shared = null;
    }
  }
  return shared;
}
