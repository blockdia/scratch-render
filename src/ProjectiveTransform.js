const {m4} = require('twgl.js');

// Four corners, clockwise from top left. Offsets are percentages of the source frame.
const matrix = (frame, offsets) => {
    const [left, right, bottom, top] = frame;
    if (!(right > left && top > bottom)) return m4.identity();
    const source = [[0, 1], [1, 1], [1, 0], [0, 0]];
    const equations = [];
    source.forEach(([x, y], i) => {
        const u = x + (offsets[i][0] / 100);
        const v = y + (offsets[i][1] / 100);
        equations.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
        equations.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    });
    for (let col = 0; col < 8; col++) {
        let pivot = col;
        for (let row = col + 1; row < 8; row++) {
            if (Math.abs(equations[row][col]) > Math.abs(equations[pivot][col])) pivot = row;
        }
        [equations[col], equations[pivot]] = [equations[pivot], equations[col]];
        const divisor = equations[col][col];
        if (Math.abs(divisor) < 1e-10) return m4.identity();
        for (let i = col; i <= 8; i++) equations[col][i] /= divisor;
        for (let row = 0; row < 8; row++) {
            if (row === col) continue;
            const factor = equations[row][col];
            for (let i = col; i <= 8; i++) equations[row][i] -= equations[col][i] * factor;
        }
    }
    const h = equations.map(row => row[8]);
    const projective = [h[0], h[3], 0, h[6], h[1], h[4], 0, h[7], 0, 0, 1, 0, h[2], h[5], 0, 1];
    const frameMatrix = m4.scaling([right - left, top - bottom, 1]);
    frameMatrix[12] = left;
    frameMatrix[13] = bottom;
    return m4.multiply(m4.multiply(frameMatrix, projective), m4.inverse(frameMatrix));
};

module.exports = {matrix};
