export const POINT_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_position;    // Screen/Canvas coordinates (pixels or normalized)
in float a_intensity;  // Telemetry intensity (0.0 to 1.0)
in float a_radius;     // Gaussian influence radius

uniform vec2 u_resolution; // Viewport resolution (width, height)
uniform float u_zoom;       // Current map zoom level multiplier

out float v_intensity;

void main() {
    vec2 zeroToOne = a_position / u_resolution;
    vec2 zeroToTwo = zeroToOne * 2.0;
    vec2 clipSpace = zeroToTwo - 1.0;

    gl_Position = vec4(clipSpace.x, -clipSpace.y, 0.0, 1.0);
    gl_PointSize = clamp(a_radius * (1.0 + u_zoom * 0.15), 8.0, 128.0);

    v_intensity = a_intensity;
}
`;

export const POINT_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in float v_intensity;
uniform float u_blur;

out vec4 fragColor;

void main() {
    vec2 coord = gl_PointCoord - vec2(0.5);
    float distSq = dot(coord, coord);

    if (distSq > 0.25) {
        discard;
    }

    float gaussianFactor = exp(-distSq * 16.0 * max(0.5, u_blur));
    float density = v_intensity * gaussianFactor;

    // Output density to the red channel
    fragColor = vec4(density, 0.0, 0.0, 1.0);
}
`;

export const BICUBIC_HEATMAP_VERTEX_SHADER = `#version 300 es
precision highp float;

in vec2 a_position;

out vec2 v_texcoord;

void main() {
    // a_position is -1 to 1 clip space
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texcoord = a_position * 0.5 + 0.5;
}
`;

export const BICUBIC_HEATMAP_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_texcoord;

uniform sampler2D u_texture;
uniform vec2 u_resolution; // The size of the texture
uniform float u_opacity;

out vec4 fragColor;

// Dynamic multi-stop heat gradient color ramp lookup (Turbo approx)
vec4 getHeatColor(float density) {
    vec4 c0 = vec4(0.05, 0.15, 0.45, 0.0);
    vec4 c1 = vec4(0.0, 0.8, 1.0, 0.4);
    vec4 c2 = vec4(0.1, 0.9, 0.4, 0.65);
    vec4 c3 = vec4(1.0, 0.85, 0.1, 0.85);
    vec4 c4 = vec4(1.0, 0.4, 0.0, 0.95);
    vec4 c5 = vec4(0.95, 0.05, 0.15, 1.0);

    if (density <= 0.0) return vec4(0.0);
    if (density < 0.2) return mix(c0, c1, density / 0.2);
    if (density < 0.4) return mix(c1, c2, (density - 0.2) / 0.2);
    if (density < 0.7) return mix(c2, c3, (density - 0.4) / 0.3);
    if (density < 0.9) return mix(c3, c4, (density - 0.7) / 0.2);
    return mix(c4, c5, clamp((density - 0.9) / 0.1, 0.0, 1.0));
}

float catmullRom(float x) {
    float ax = abs(x);
    if (ax <= 1.0) {
        return 1.5 * ax * ax * ax - 2.5 * ax * ax + 1.0;
    } else if (ax < 2.0) {
        return -0.5 * ax * ax * ax + 2.5 * ax * ax - 4.0 * ax + 2.0;
    }
    return 0.0;
}

void main() {
    vec2 coord = v_texcoord * u_resolution - 0.5;
    vec2 f = fract(coord);
    vec2 d0 = floor(coord) - 1.0;

    float wx[4];
    wx[0] = catmullRom(f.x + 1.0);
    wx[1] = catmullRom(f.x);
    wx[2] = catmullRom(f.x - 1.0);
    wx[3] = catmullRom(f.x - 2.0);

    float wy[4];
    wy[0] = catmullRom(f.y + 1.0);
    wy[1] = catmullRom(f.y);
    wy[2] = catmullRom(f.y - 1.0);
    wy[3] = catmullRom(f.y - 2.0);

    float density = 0.0;
    for(int j = 0; j < 4; j++) {
        for(int i = 0; i < 4; i++) {
            vec2 sampleCoord = (d0 + vec2(float(i), float(j)) + 0.5) / u_resolution;
            float val = texture(u_texture, sampleCoord).r;
            density += val * wx[i] * wy[j];
        }
    }

    vec4 color = getHeatColor(density);
    color.a *= u_opacity;
    fragColor = color;
}
`;
