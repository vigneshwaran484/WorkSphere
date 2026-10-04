import { WebGLHeatmapRenderer } from "@/lib/webgl/webglHeatmapRenderer";

describe("WebGLBicubicShader & Context Loss Recovery", () => {
  let mockGl: WebGL2RenderingContext;
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    canvas = document.createElement("canvas");
    mockGl = {
      getExtension: jest.fn((ext) => {
        if (ext === "EXT_color_buffer_float") return true;
        if (ext === "OES_texture_float") return true;
        return null;
      }),
      enable: jest.fn(),
      blendFunc: jest.fn(),
      createShader: jest.fn(() => ({})),
      shaderSource: jest.fn(),
      compileShader: jest.fn(),
      getShaderParameter: jest.fn(() => true),
      createProgram: jest.fn(() => ({})),
      attachShader: jest.fn(),
      linkProgram: jest.fn(),
      getProgramParameter: jest.fn(() => true),
      useProgram: jest.fn(),
      getAttribLocation: jest.fn(() => 1),
      getUniformLocation: jest.fn(() => ({})),
      createBuffer: jest.fn(() => ({})),
      bindBuffer: jest.fn(),
      bufferData: jest.fn(),
      bufferSubData: jest.fn(),
      bindFramebuffer: jest.fn(),
      createFramebuffer: jest.fn(() => ({})),
      createTexture: jest.fn(() => ({})),
      bindTexture: jest.fn(),
      texImage2D: jest.fn(),
      texParameteri: jest.fn(),
      framebufferTexture2D: jest.fn(),
      viewport: jest.fn(),
      clearColor: jest.fn(),
      clear: jest.fn(),
      uniform1f: jest.fn(),
      uniform1i: jest.fn(),
      uniform2f: jest.fn(),
      activeTexture: jest.fn(),
      enableVertexAttribArray: jest.fn(),
      disableVertexAttribArray: jest.fn(),
      vertexAttribPointer: jest.fn(),
      drawArrays: jest.fn(),
      deleteProgram: jest.fn(),
      deleteBuffer: jest.fn(),
      deleteFramebuffer: jest.fn(),
      deleteTexture: jest.fn(),
      deleteShader: jest.fn(),
      VERTEX_SHADER: 35633,
      FRAGMENT_SHADER: 35632,
      COMPILE_STATUS: 35713,
      LINK_STATUS: 35714,
      ARRAY_BUFFER: 34962,
      DYNAMIC_DRAW: 35048,
      STATIC_DRAW: 35044,
      BLEND: 3042,
      SRC_ALPHA: 770,
      ONE: 1,
      ONE_MINUS_SRC_ALPHA: 771,
      FLOAT: 5126,
      HALF_FLOAT: 5131,
      COLOR_BUFFER_BIT: 16384,
      POINTS: 0,
      TRIANGLES: 4,
      TEXTURE_2D: 3553,
      TEXTURE0: 33984,
      FRAMEBUFFER: 36160,
      COLOR_ATTACHMENT0: 36064,
      RGBA: 6408,
      RED: 6403,
      R16F: 33325,
      R32F: 34836,
      TEXTURE_MIN_FILTER: 10241,
      TEXTURE_MAG_FILTER: 10240,
      TEXTURE_WRAP_S: 10242,
      TEXTURE_WRAP_T: 10243,
      NEAREST: 9728,
      CLAMP_TO_EDGE: 33071,
    } as unknown as WebGL2RenderingContext;

    // We can simulate WebGL2 Context by setting its constructor name
    // But since it's hard to mock `instanceof`, the implementation uses typeof check
    // Actually the mock implementation of `gl instanceof WebGL2RenderingContext` fails in Jest
    // if WebGL2RenderingContext isn't available. We can mock global.WebGL2RenderingContext.
    global.WebGL2RenderingContext = class WebGL2RenderingContext {} as any;
    Object.setPrototypeOf(mockGl, WebGL2RenderingContext.prototype);

    jest.spyOn(canvas, "getContext").mockImplementation((contextId) => {
      if (contextId === "webgl2" || contextId === "webgl") {
        return mockGl as any;
      }
      return null;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("compiles bicubic shaders when extension is present", () => {
    const renderer = new WebGLHeatmapRenderer(canvas, {
      opacity: 0.9,
      blur: 1.2,
    });

    // 2 shaders for point, 2 shaders for bicubic
    expect(mockGl.createShader).toHaveBeenCalledTimes(4);
    expect(mockGl.createProgram).toHaveBeenCalledTimes(2); // main program + bicubic program
    renderer.destroy();
  });

  it("recovers context properly", () => {
    const renderer = new WebGLHeatmapRenderer(canvas);

    // Simulate context loss and recovery callback
    // (Attach contextManager event logic)
    // The renderer has a context loss cleanup function, it re-initializes on recovery.
    // For this test, we can manually trigger initGL if possible or test the callback.
    // Since initGL is private, we can trigger the simulated event.

    const event = new Event("webglcontextrestored");
    canvas.dispatchEvent(event);

    // It should have re-initialized shaders
    expect(mockGl.createShader).toHaveBeenCalledTimes(8); // 4 from init, 4 from restore
    expect(mockGl.createProgram).toHaveBeenCalledTimes(4);

    renderer.destroy();
  });

  it("renders with bicubic pipeline", () => {
    const renderer = new WebGLHeatmapRenderer(canvas);
    renderer.updatePoints([{ x: 10, y: 10, intensity: 0.5 }]);

    renderer.render(800, 600, 1);

    expect(mockGl.bindFramebuffer).toHaveBeenCalled();
    expect(mockGl.drawArrays).toHaveBeenCalledWith(mockGl.POINTS, 0, 1);
    expect(mockGl.drawArrays).toHaveBeenCalledWith(mockGl.TRIANGLES, 0, 6);

    renderer.destroy();
  });
});
