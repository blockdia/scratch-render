// Shared CPU/GPU geometry contract. Coordinates are Scratch units, +Y up.
const contains = (clip, x, y) => {
    const hx = (clip.right - clip.left) / 2;
    const hy = (clip.top - clip.bottom) / 2;
    const dx = Math.abs(x - ((clip.left + clip.right) / 2));
    const dy = Math.abs(y - ((clip.bottom + clip.top) / 2));
    let inside = hx > 0 && hy > 0 && dx <= hx && dy <= hy;
    if (inside && (clip.type === 'ellipse' || clip.type === 'circle')) {
        inside = ((dx / hx) ** 2) + ((dy / hy) ** 2) <= 1;
    } else if (inside && clip.type === 'roundedRect') {
        const r = Math.min(clip.radius || 0, hx, hy);
        inside = (Math.max(0, dx - hx + r) ** 2) + (Math.max(0, dy - hy + r) ** 2) <= r * r;
    }
    return clip.inverted ? !inside : inside;
};

// uvToSpace maps output texture coordinates to the clip's chosen coordinate system.
const clipUniforms = (clip, uvToSpace) => {
    if (!clip) {
        return {u_clipShape: [0, 0, 0, 0],
            u_clipInverse: 0,
            u_clipRowX: [0, 0, 0],
            u_clipRowY: [0, 0, 0]};
    }
    const hx = (clip.right - clip.left) / 2;
    const hy = (clip.top - clip.bottom) / 2;
    const divisor = Math.max(hx, hy, 1);
    const m = uvToSpace;
    return {
        u_clipShape: [hx / divisor, hy / divisor, Math.min(clip.radius || 0, hx, hy) / divisor,
            clip.type === 'ellipse' || clip.type === 'circle' ? 2 : clip.type === 'roundedRect' ? 3 : 1],
        u_clipInverse: clip.inverted ? 1 : 0,
        u_clipRowX: [m[0] / divisor, m[2] / divisor, (m[4] - ((clip.left + clip.right) / 2)) / divisor],
        u_clipRowY: [m[1] / divisor, m[3] / divisor, (m[5] - ((clip.bottom + clip.top) / 2)) / divisor]
    };
};

const clipped = (uniforms, uv) => {
    const shape = uniforms.u_clipShape;
    if (!shape[3]) return false;
    const x = uniforms.u_clipRowX;
    const y = uniforms.u_clipRowY;
    return !contains({left: -shape[0],
        right: shape[0],
        bottom: -shape[1],
        top: shape[1],
        radius: shape[2],
        type: shape[3] === 2 ? 'ellipse' : shape[3] === 3 ? 'roundedRect' : 'rect',
        inverted: Boolean(uniforms.u_clipInverse)},
    (x[0] * uv[0]) + (x[1] * uv[1]) + x[2], (y[0] * uv[0]) + (y[1] * uv[1]) + y[2]);
};

// Source and destination edge fractions. Insets larger than the source shrink proportionally.
const sliceAxis = (source, destination, start, end) => {
    const factor = Math.min(1, source / Math.max(start + end, 1));
    start *= factor;
    end *= factor;
    return [start / source, end / source, start / destination, end / destination];
};
const mapAxis = (value, axis) => {
    const [s0, s1, d0, d1] = axis;
    if (value < d0 && d0 > 0) return value * s0 / d0;
    if (value > 1 - d1 && d1 > 0) return 1 - ((1 - value) * s1 / d1);
    return s0 + ((value - d0) * Math.max(0, 1 - s0 - s1) / Math.max(1e-6, 1 - d0 - d1));
};

module.exports = {contains, clipUniforms, clipped, sliceAxis, mapAxis};
