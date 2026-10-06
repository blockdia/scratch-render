const color = new Uint8ClampedArray(4);
const position = [0, 0];
const defaults = () => ({u_maskMode: 0,
    u_maskInverse: 0,
    u_maskRowX: [0, 0, 0],
    u_maskRowY: [0, 0, 0],
    u_maskRowW: [0, 0, 1]});

// Sample the unmodified costume. Premultiplied luminance already includes source alpha.
const uniforms = (mask, mapping) => {
    if (!mask) return defaults();
    const m = mapping;
    const w = m.length > 6 ? m.slice(6) : [0, 0, 1];
    const left = mask.x - (mask.width / 2);
    const top = mask.y + (mask.height / 2);
    return {u_maskMode: mask.mode === 'luminance' ? 2 : 1,
        u_maskInverse: mask.inverted ? 1 : 0,
        u_maskRowX: [(m[0] - (left * w[0])) / mask.width,
            (m[2] - (left * w[1])) / mask.width, (m[4] - (left * w[2])) / mask.width],
        u_maskRowY: [((top * w[0]) - m[1]) / mask.height,
            ((top * w[1]) - m[3]) / mask.height, ((top * w[2]) - m[5]) / mask.height],
        u_maskRowW: w};
};
const opacity = (u, skin, uv) => {
    if (!u.u_maskMode || !skin) return 1;
    const row = r => (r[0] * uv[0]) + (r[1] * uv[1]) + r[2];
    const w = row(u.u_maskRowW);
    position[0] = row(u.u_maskRowX) / w;
    position[1] = row(u.u_maskRowY) / w;
    let alpha = 0;
    if (position.every(n => n >= 0 && n <= 1)) {
        skin._silhouette.colorAtNearest(position, color);
        alpha = (u.u_maskMode === 2 ? (color[0] * 0.2126) + (color[1] * 0.7152) + (color[2] * 0.0722) :
            color[3]) / 255;
    }
    alpha = Math.round(alpha * 255) / 255;
    return u.u_maskInverse ? 1 - alpha : alpha;
};
module.exports = {defaults, uniforms, opacity};
