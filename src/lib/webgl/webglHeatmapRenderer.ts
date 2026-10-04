/**
 * WebGL GPU-Accelerated Spatial Clustering Heatmap Renderer (#818)
 *
 * High-performance WebGL rendering engine capable of projecting and clustering
 * up to 100,000 live workspace telemetry points at 60 FPS with hardware acceleration.
 */

import {
  HEATMAP_VERTEX_SHADER,
  HEATMAP_FRAGMENT_SHADER,
} from "@/shaders/heatmapShaders";
import {
  POINT_VERTEX_SHADER,
  POINT_FRAGMENT_SHADER,
  BICUBIC_HEATMAP_VERTEX_SHADER,
  BICUBIC_HEATMAP_FRAGMENT_SHADER,
} from "./shaders/bicubicHeatmap";
import { attachWebGLContextRecovery } from "./contextManager";

export interface HeatmapPoint {
  x: number; // Viewport/canvas pixel X coordinate
  y: number; // Viewport/canvas pixel Y coordinate
  intensity: number; // Intensity (0.0 to 1.0)
  radius?: number; // Spatial influence radius in pixels (default 25)
}

export interface WebGLHeatmapOptions {
  opacity?: number;
  blur?: number;
  maxPoints?: number;
}

export class WebGLHeatmapRenderer {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private bicubicProgram: WebGLProgram | null = null;
  private vbo: WebGLBuffer | null = null;
  private quadVbo: WebGLBuffer | null = null;

  private fbo: WebGLFramebuffer | null = null;
  private floatTexture: WebGLTexture | null = null;
  private useBicubic = false;
  private fboWidth = 0;
  private fboHeight = 0;
  private cleanupContextRecovery?: () => void;

  private pointsCount = 0;
  private maxPoints: number;
  private opacity: number;
  private blur: number;
  private isDestroyed = false;

  // Uniform locations
  private uResolutionLoc: WebGLUniformLocation | null = null;
  private uZoomLoc: WebGLUniformLocation | null = null;
  private uOpacityLoc: WebGLUniformLocation | null = null;
  private uBlurLoc: WebGLUniformLocation | null = null;

  // Bicubic Uniform locations
  private uBicubicResolutionLoc: WebGLUniformLocation | null = null;
  private uBicubicOpacityLoc: WebGLUniformLocation | null = null;
  private uBicubicTextureLoc: WebGLUniformLocation | null = null;

  // Attribute locations
  private aPositionLoc = -1;
  private aIntensityLoc = -1;
  private aRadiusLoc = -1;
  private aBicubicPositionLoc = -1;

  constructor(canvas: HTMLCanvasElement, options: WebGLHeatmapOptions = {}) {
    this.canvas = canvas;
    this.maxPoints = options.maxPoints || 100000;
    this.opacity = options.opacity ?? 0.85;
    this.blur = options.blur ?? 1.0;

    this.initGL();
    this.cleanupContextRecovery = attachWebGLContextRecovery(canvas, () => {
      this.initGL();
    });
  }

  private initGL() {
    try {
      // Defensive cleanup: if initGL() ever runs more than once (e.g. the
      // context-recovery callback fires without a true context loss), free
      // the previous program/buffer first so we never leak GPU resources.
      if (this.gl) {
        if (this.program) this.gl.deleteProgram(this.program);
        if (this.bicubicProgram) this.gl.deleteProgram(this.bicubicProgram);
        if (this.vbo) this.gl.deleteBuffer(this.vbo);
        if (this.quadVbo) this.gl.deleteBuffer(this.quadVbo);
        if (this.fbo) this.gl.deleteFramebuffer(this.fbo);
        if (this.floatTexture) this.gl.deleteTexture(this.floatTexture);
        this.program = null;
        this.bicubicProgram = null;
        this.vbo = null;
        this.quadVbo = null;
        this.fbo = null;
        this.floatTexture = null;
        this.fboWidth = 0;
        this.fboHeight = 0;
      }

      this.gl =
        (this.canvas.getContext("webgl2") as WebGL2RenderingContext | null) ||
        (this.canvas.getContext("webgl") as WebGLRenderingContext | null);

      if (!this.gl) {
        console.warn(
          "[WebGLHeatmap] WebGL context not supported by client environment.",
        );
        return;
      }

      const gl = this.gl;

      // Check float texture support
      const isWebGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
      const extColorBufferFloat = gl.getExtension("EXT_color_buffer_float");

      // Since the bicubic shaders are hardcoded to GLSL ES 3.00, we strictly require WebGL2.
      this.useBicubic = isWebGL2 && !!extColorBufferFloat;

      // Enable additive color blending for GPU spatial density clustering overlay
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

      // Compile Shader Program
      const vertShaderSrc = this.useBicubic ? POINT_VERTEX_SHADER : HEATMAP_VERTEX_SHADER;
      const fragShaderSrc = this.useBicubic ? POINT_FRAGMENT_SHADER : HEATMAP_FRAGMENT_SHADER;

      const vertShader = this.compileShader(gl.VERTEX_SHADER, vertShaderSrc);
      const fragShader = this.compileShader(gl.FRAGMENT_SHADER, fragShaderSrc);

      if (!vertShader || !fragShader) return;

      const program = gl.createProgram();
      if (!program) return;

      gl.attachShader(program, vertShader);
      gl.attachShader(program, fragShader);
      gl.linkProgram(program);

      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error(
          "[WebGLHeatmap] Program link error:",
          gl.getProgramInfoLog(program),
        );
        return;
      }

      this.program = program;

      // Look up attributes & uniforms
      this.aPositionLoc = gl.getAttribLocation(program, "a_position");
      this.aIntensityLoc = gl.getAttribLocation(program, "a_intensity");
      this.aRadiusLoc = gl.getAttribLocation(program, "a_radius");

      this.uResolutionLoc = gl.getUniformLocation(program, "u_resolution");
      this.uZoomLoc = gl.getUniformLocation(program, "u_zoom");
      this.uBlurLoc = gl.getUniformLocation(program, "u_blur");
      if (!this.useBicubic) {
        this.uOpacityLoc = gl.getUniformLocation(program, "u_opacity");
      }

      if (this.useBicubic) {
        const bicubicVert = this.compileShader(gl.VERTEX_SHADER, BICUBIC_HEATMAP_VERTEX_SHADER);
        const bicubicFrag = this.compileShader(gl.FRAGMENT_SHADER, BICUBIC_HEATMAP_FRAGMENT_SHADER);
        if (bicubicVert && bicubicFrag) {
          const bicubicProgram = gl.createProgram();
          if (bicubicProgram) {
            gl.attachShader(bicubicProgram, bicubicVert);
            gl.attachShader(bicubicProgram, bicubicFrag);
            gl.linkProgram(bicubicProgram);
            if (gl.getProgramParameter(bicubicProgram, gl.LINK_STATUS)) {
              this.bicubicProgram = bicubicProgram;
              this.aBicubicPositionLoc = gl.getAttribLocation(bicubicProgram, "a_position");
              this.uBicubicResolutionLoc = gl.getUniformLocation(bicubicProgram, "u_resolution");
              this.uBicubicOpacityLoc = gl.getUniformLocation(bicubicProgram, "u_opacity");
              this.uBicubicTextureLoc = gl.getUniformLocation(bicubicProgram, "u_texture");
            } else {
              this.useBicubic = false;
            }
          }
        } else {
          this.useBicubic = false;
        }
      }

      if (this.useBicubic) {
        this.quadVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          new Float32Array([
            -1.0, -1.0,
             1.0, -1.0,
            -1.0,  1.0,
            -1.0,  1.0,
             1.0, -1.0,
             1.0,  1.0,
          ]),
          gl.STATIC_DRAW
        );

        this.fbo = gl.createFramebuffer();
        this.floatTexture = gl.createTexture();
      }

      // Initialize ArrayBuffer VBO (Float32Array: 4 floats per vertex -> x, y, intensity, radius)
      this.vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        this.maxPoints * 4 * Float32Array.BYTES_PER_ELEMENT,
        gl.DYNAMIC_DRAW,
      );
    } catch (err) {
      console.error("[WebGLHeatmap] Context initialization error:", err);
    }
  }

  private compileShader(type: number, source: string): WebGLShader | null {
    if (!this.gl) return null;
    const shader = this.gl.createShader(type);
    if (!shader) return null;

    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);

    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      console.error(
        "[WebGLHeatmap] Shader compile failed:",
        this.gl.getShaderInfoLog(shader),
      );
      this.gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  /**
   * Upload points data to WebGL GPU VBO buffer
   */
  public updatePoints(points: HeatmapPoint[]) {
    if (!this.gl || !this.vbo || !this.program || this.isDestroyed) return;

    const gl = this.gl;
    this.pointsCount = Math.min(points.length, this.maxPoints);

    const bufferData = new Float32Array(this.pointsCount * 4);
    for (let i = 0; i < this.pointsCount; i++) {
      const p = points[i];
      const offset = i * 4;
      bufferData[offset] = p.x;
      bufferData[offset + 1] = p.y;
      bufferData[offset + 2] = p.intensity;
      bufferData[offset + 3] = p.radius ?? 25.0;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, bufferData);
  }

  /**
   * Render frame to canvas with hardware spatial clustering
   */
  private resizeFBO(width: number, height: number) {
    if (!this.gl || !this.useBicubic || !this.floatTexture || !this.fbo) return;
    if (this.fboWidth === width && this.fboHeight === height) return;

    const gl = this.gl;
    const isWebGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
    const internalFormat = isWebGL2 ? (gl as WebGL2RenderingContext).R16F || (gl as WebGL2RenderingContext).R32F : gl.RGBA;
    const format = isWebGL2 ? (gl as WebGL2RenderingContext).RED : gl.RGBA;
    const type = isWebGL2 ? (gl as WebGL2RenderingContext).HALF_FLOAT || gl.FLOAT : gl.FLOAT;

    gl.bindTexture(gl.TEXTURE_2D, this.floatTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat as number, width, height, 0, format, type, null);

    // Nearest filtering is fine, we do bicubic in the shader manually
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.floatTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.fboWidth = width;
    this.fboHeight = height;
  }

  public render(width: number, height: number, zoom: number = 1.0) {
    if (
      !this.gl ||
      !this.program ||
      !this.vbo ||
      this.pointsCount === 0 ||
      this.isDestroyed
    ) {
      return;
    }

    const gl = this.gl;

    if (this.useBicubic && this.bicubicProgram) {
      this.resizeFBO(width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0.0, 0.0, 0.0, 0.0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      // Disable blend when accumulating density if doing simple additive points
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0.0, 0.0, 0.0, 0.0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    }

    gl.useProgram(this.program);

    // Uniforms
    gl.uniform2f(this.uResolutionLoc, width, height);
    gl.uniform1f(this.uZoomLoc, zoom);
    gl.uniform1f(this.uBlurLoc, this.blur);
    if (!this.useBicubic) {
      gl.uniform1f(this.uOpacityLoc, this.opacity);
    }

    // Bind VBO & attributes
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const stride = 4 * Float32Array.BYTES_PER_ELEMENT;

    if (this.aPositionLoc !== -1) {
      gl.enableVertexAttribArray(this.aPositionLoc);
      gl.vertexAttribPointer(this.aPositionLoc, 2, gl.FLOAT, false, stride, 0);
    }
    if (this.aIntensityLoc !== -1) {
      gl.enableVertexAttribArray(this.aIntensityLoc);
      gl.vertexAttribPointer(
        this.aIntensityLoc,
        1,
        gl.FLOAT,
        false,
        stride,
        2 * Float32Array.BYTES_PER_ELEMENT,
      );
    }
    if (this.aRadiusLoc !== -1) {
      gl.enableVertexAttribArray(this.aRadiusLoc);
      gl.vertexAttribPointer(
        this.aRadiusLoc,
        1,
        gl.FLOAT,
        false,
        stride,
        3 * Float32Array.BYTES_PER_ELEMENT,
      );
    }

    // Draw telemetry points
    gl.drawArrays(gl.POINTS, 0, this.pointsCount);

    if (this.useBicubic && this.bicubicProgram) {
      // Second pass: full screen quad with bicubic filtering
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0.0, 0.0, 0.0, 0.0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

      gl.useProgram(this.bicubicProgram);

      gl.uniform2f(this.uBicubicResolutionLoc, width, height);
      gl.uniform1f(this.uBicubicOpacityLoc, this.opacity);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.floatTexture);
      gl.uniform1i(this.uBicubicTextureLoc, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
      if (this.aBicubicPositionLoc !== -1) {
        gl.enableVertexAttribArray(this.aBicubicPositionLoc);
        gl.vertexAttribPointer(this.aBicubicPositionLoc, 2, gl.FLOAT, false, 0, 0);
      }

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      if (this.aBicubicPositionLoc !== -1) {
        gl.disableVertexAttribArray(this.aBicubicPositionLoc);
      }
    }

    if (this.aPositionLoc !== -1) gl.disableVertexAttribArray(this.aPositionLoc);
    if (this.aIntensityLoc !== -1) gl.disableVertexAttribArray(this.aIntensityLoc);
    if (this.aRadiusLoc !== -1) gl.disableVertexAttribArray(this.aRadiusLoc);
  }

  public setOpacity(opacity: number) {
    this.opacity = opacity;
  }

  public setBlur(blur: number) {
    this.blur = blur;
  }

  public destroy() {
    this.isDestroyed = true;
    if (this.cleanupContextRecovery) {
      this.cleanupContextRecovery();
    }
    if (this.gl) {
      if (this.program) this.gl.deleteProgram(this.program);
      if (this.bicubicProgram) this.gl.deleteProgram(this.bicubicProgram);
      if (this.vbo) this.gl.deleteBuffer(this.vbo);
      if (this.quadVbo) this.gl.deleteBuffer(this.quadVbo);
      if (this.fbo) this.gl.deleteFramebuffer(this.fbo);
      if (this.floatTexture) this.gl.deleteTexture(this.floatTexture);
    }
  }
}
