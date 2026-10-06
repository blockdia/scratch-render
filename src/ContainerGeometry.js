// Container geometry contract shared with the VM/renderer. Coordinates are local Scratch units.
const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const multiply = (a, b) => a.map((_, i) => {
    const row = Math.floor(i / 3) * 3;
    const col = i % 3;
    return (a[row] * b[col]) + (a[row + 1] * b[col + 3]) + (a[row + 2] * b[col + 6]);
});
const inverse = m => {
    const [a, b, c, d, e, f, g, h, i] = m;
    const result = [(e * i) - (f * h), (c * h) - (b * i), (b * f) - (c * e),
        (f * g) - (d * i), (a * i) - (c * g), (c * d) - (a * f),
        (d * h) - (e * g), (b * g) - (a * h), (a * e) - (b * d)];
    const det = (a * result[0]) + (b * result[3]) + (c * result[6]);
    return result.map(n => n / det);
};
const homogeneous = (m, p) => [(m[0] * p[0]) + (m[1] * p[1]) + (m[2] * p[2]),
    (m[3] * p[0]) + (m[4] * p[1]) + (m[5] * p[2]), (m[6] * p[0]) + (m[7] * p[1]) + (m[8] * p[2])];
const point = (m, p) => {
    const q = homogeneous(m, [p[0], p[1], 1]);
    return q[2] > 1e-10 ? [q[0] / q[2], q[1] / q[2]] : [NaN, NaN];
};
const affine = m => [m[0], m[2], m[4], m[1], m[3], m[5], 0, 0, 1];
const matrix4 = m => [m[0], m[3], 0, m[6], m[1], m[4], 0, m[7], 0, 0, 1, 0, m[2], m[5], 0, m[8]];
const projective = offsets => {
    if (!offsets) return identity;
    const rows = [];
    [[0, 1], [1, 1], [1, 0], [0, 0]].forEach(([x, y], i) => {
        const u = x + (offsets[i][0] / 100);
        const v = y + (offsets[i][1] / 100);
        rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
        rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    });
    for (let col = 0; col < 8; col++) {
        let pivot = col;
        for (let row = col + 1; row < 8; row++) {
            if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) pivot = row;
        }
        [rows[col], rows[pivot]] = [rows[pivot], rows[col]];
        const divisor = rows[col][col];
        if (Math.abs(divisor) < 1e-10) return identity;
        for (let i = col; i <= 8; i++) rows[col][i] /= divisor;
        for (let row = 0; row < 8; row++) {
            if (row === col) continue;
            const factor = rows[row][col];
            for (let i = col; i <= 8; i++) rows[row][i] -= rows[col][i] * factor;
        }
    }
    return rows.map(row => row[8]).concat(1);
};
const axis = (source, requested, start, end, center) => {
    const ratio = Math.min(1, (source - Math.min(0.00001, source / 2)) / Math.max(start + end, 1e-10));
    start *= ratio;
    end *= ratio;
    // A positive center keeps the inverse defined, including an all-border source.
    const destination = Math.max(requested, start + end + 0.00001);
    const left = center - (source / 2);
    const outputLeft = (left * destination) / source;
    return {source: [left, left + start, (left + source) - end, left + source],
        output: [outputLeft, outputLeft + start, (outputLeft + destination) - end, outputLeft + destination]};
};
const segment = (value, source, output) => {
    let i = value < source[1] ? 0 : value > source[2] ? 2 : 1;
    if (source[i + 1] - source[i] < 1e-10) i = 1;
    const scale = (output[i + 1] - output[i]) / Math.max(1e-10, source[i + 1] - source[i]);
    return [scale, output[i] - (source[i] * scale)];
};
const prepare = geometry => {
    if (!geometry || !geometry.frame) return null;
    const {frame, nineSlice, perspective} = geometry;
    const borders = geometry.borders || {};
    const x = axis(frame.width, nineSlice ? nineSlice.width : frame.width,
        nineSlice ? borders.left || 0 : 0, nineSlice ? borders.right || 0 : 0, frame.x);
    const y = axis(frame.height, nineSlice ? nineSlice.height : frame.height,
        nineSlice ? borders.bottom || 0 : 0, nineSlice ? borders.top || 0 : 0, frame.y);
    const f = [x.output[3] - x.output[0], 0, x.output[0],
        0, y.output[3] - y.output[0], y.output[0], 0, 0, 1];
    const h = multiply(multiply(f, projective(perspective)), inverse(f));
    return {x, y, h, inverse: inverse(h), active: Boolean(nineSlice || perspective), nineSlice};
};
const localMatrix = (g, p) => {
    if (!g) return identity;
    const x = segment(p[0], g.x.source, g.x.output);
    const y = segment(p[1], g.y.source, g.y.output);
    return multiply(g.h, [x[0], 0, x[1], 0, y[0], y[1], 0, 0, 1]);
};
const forward = (g, p) => (g ? point(localMatrix(g, p), p) : p.slice());
const backward = (g, p) => {
    if (!g) return p.slice();
    const q = point(g.inverse, p);
    const x = segment(q[0], g.x.output, g.x.source);
    const y = segment(q[1], g.y.output, g.y.source);
    return [(x[0] * q[0]) + x[1], (y[0] * q[1]) + y[1]];
};
module.exports = {identity,
    multiply,
    inverse,
    homogeneous,
    point,
    affine,
    matrix4,
    prepare,
    localMatrix,
    forward,
    backward};
