const Geometry = require('./ContainerGeometry');

const interpolate = (a, b, t) => ({
    p: a.p.map((n, i) => n + ((b.p[i] - n) * t)),
    r: a.r.map((n, i) => n + ((b.r[i] - n) * t)),
    uv: a.uv.map((n, i) => n + ((b.uv[i] - n) * t))
});
const split = (polygon, axis, limit, inverse) => {
    const sides = [[], []];
    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        const p = Geometry.homogeneous(inverse, a.p);
        const q = Geometry.homogeneous(inverse, b.p);
        const da = p[axis] - (limit * p[2]);
        const db = q[axis] - (limit * q[2]);
        sides[da >= 0 ? 1 : 0].push(a);
        if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
            const v = interpolate(a, b, da / (da - db));
            sides[0].push(v);
            sides[1].push(v);
        }
    }
    return sides.filter(side => side.length >= 3);
};
// Keep homogeneous coordinates and split exactly at nine-slice boundaries. Each resulting
// polygon has one homography, so both texture and final-stage coordinates interpolate exactly.
const polygons = (points, steps, renderFirst = false) => {
    let result = [points.map((p, i) => ({p: p.slice(), r: p.slice(), uv: [[0, 1], [1, 1], [1, 0], [0, 0]][i]}))];
    steps.forEach((step, index) => {
        const g = step.warp;
        if (g && g.nineSlice) {
            for (const [axis, values] of [[0, g.x.source], [1, g.y.source]]) {
                for (const limit of [values[1], values[2]]) {
                    result = result.flatMap(poly => split(poly, axis, limit, step.inverse));
                }
            }
        }
        result = result.map(poly => {
            const mid = poly.reduce((sum, v) => sum.map((n, i) => n + v.p[i]), [0, 0, 0]);
            const local = Geometry.homogeneous(step.inverse, mid);
            const m = Geometry.multiply(Geometry.multiply(step.world,
                Geometry.localMatrix(g, [local[0] / local[2], local[1] / local[2]])), step.inverse);
            return poly.map(v => {
                const p = Geometry.homogeneous(m, v.p);
                return {p, r: renderFirst && index === 0 ? p.slice() : v.r, uv: v.uv};
            });
        });
        // Clip against the finite front half-plane rather than dropping an entire crossing cell.
        result = result.map(poly => {
            const clipped = [];
            for (let i = 0; i < poly.length; i++) {
                const a = poly[i];
                const b = poly[(i + 1) % poly.length];
                const insideA = a.p[2] >= 1e-8;
                const insideB = b.p[2] >= 1e-8;
                if (insideA) clipped.push(a);
                if (insideA !== insideB) clipped.push(interpolate(a, b, (1e-8 - a.p[2]) / (b.p[2] - a.p[2])));
            }
            return clipped;
        }).filter(poly => poly.length >= 3 && poly.every(v => v.p.every(Number.isFinite)));
    });
    return result;
};
const arrays = pieces => {
    const positions = [];
    const stage = [];
    const uv = [];
    for (const poly of pieces) {
        for (let i = 1; i + 1 < poly.length; i++) {
            for (const v of [poly[0], poly[i], poly[i + 1]]) {
                positions.push(...v.r);
                stage.push(...v.p);
                uv.push(...v.uv);
            }
        }
    }
    return {a_position: {numComponents: 2, data: new Array(uv.length).fill(0)},
        a_warpPosition: {numComponents: 3, data: positions},
        a_stagePosition: {numComponents: 3, data: stage},
        a_texCoord: {numComponents: 2, data: uv}};
};
module.exports = {polygons, arrays};
