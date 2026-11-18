// A day's last frame, held over the hub on the way back from it: while the hub comes up behind it, the picture goes to
// water, rippling out from its middle; once the hub is there, the ripples die away until the picture is still again, and
// then it fades, the calendar there behind it. On its own small WebGL2 canvas, apart from the hub's renderer, which is
// busy coming up under it.

const VERTEX = `#version 300 es
out vec2 uv;
void main() {
  vec2 corner = vec2(gl_VertexID & 1, gl_VertexID >> 1);
  uv = corner;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

// `stir`: how much the picture ripples, 0 to 1; `fade`: how far it has faded, 0 to 1.
const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D picture;
uniform vec2 size;
uniform float time;
uniform float stir;
uniform float fade;
in vec2 uv;
out vec4 colour;
void main() {
  vec2 aspect = vec2(size.x / size.y, 1.0);
  vec2 q = (uv - 0.5) * aspect;
  float r = length(q);
  vec2 away = r > 0.0 ? q / r : vec2(0.0);
  // Rings running out from the middle, and a slow sway across them, as on the day's tile flown into (calendar.tsx).
  float ring = sin(r * 42.0 - time * 9.0) * 0.026;
  vec2 sway = vec2(sin(q.y * 15.0 + time * 3.1), sin(q.x * 13.0 - time * 2.7)) * 0.016;
  vec2 p = q + (away * ring + sway) * stir;
  vec3 seen = texture(picture, p / aspect + 0.5).rgb;
  float alpha = 1.0 - fade;
  colour = vec4(seen * alpha, alpha);
}`;

export type Portal = { draw: (time: number, stir: number, fade: number) => void; dispose: () => void };

// Null where WebGL2 is not to be had: the picture is then shown plainly, and faded.
export function makePortal(canvas: HTMLCanvasElement, frame: HTMLCanvasElement): Portal | null {
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: false });
  if (!gl) return null;
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const program = gl.createProgram()!;
  const vertex = compile(gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
  const at = (name: string) => gl.getUniformLocation(program, name);
  const where = { size: at("size"), time: at("time"), stir: at("stir"), fade: at("fade") };
  return {
    draw(time, stir, fade) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.uniform2f(where.size, canvas.width, canvas.height);
      gl.uniform1f(where.time, time);
      gl.uniform1f(where.stir, stir);
      gl.uniform1f(where.fade, fade);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    dispose() {
      gl.deleteTexture(texture);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    }
  };
}
