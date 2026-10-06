const test = require('tap').test;
const Drawable = require('../../src/Drawable');
const MockSkin = require('../fixtures/MockSkin');
const RenderWebGL = require('../../src/RenderWebGL');
const twgl = require('twgl.js');
const Warp = require('../../src/ContainerGeometry');
const Mesh = require('../../src/ContainerGeometryMesh');

const fixture = () => {
    const renderer = Object.create(RenderWebGL.prototype);
    Object.assign(renderer, {_allDrawables: [], _drawableContainerPaths: new Map(), dirty: false});
    const d = new Drawable(0, renderer);
    renderer._allDrawables.push(d);
    d.skin = new MockSkin(0, {skinWasAltered: () => d._skinWasAltered()});
    d.skin.size = [100, 60];
    d.skin.rotationCenter = [50, 30];
    d.skin.updateSilhouette = () => {};
    d.skin.useNearest = () => true;
    d.skin.isTouchingNearest = p => p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1;
    d.skin._silhouette.colorAtNearest = (p, dst) => {
        dst.fill(255); return dst;
    };
    return {d, renderer};
};

test('container reference frames exclude container rotation, stretch and ancestor geometry', t => {
    const {d, renderer} = fixture();
    renderer._drawList = [0];
    renderer._drawableContainerPaths.set(0, ['outer', 'inner']);
    d.updatePosition([12, -8]);
    d.updateVisible(false); // Hidden members are still part of the fixed reference frame.
    for (const angle of [0, Math.PI / 4, Math.PI / 3]) {
        for (const xScale of [1, -1.5]) {
            const c = Math.cos(angle);
            const s = Math.sin(angle);
            const matrix = [c * xScale, s * xScale, -s * 0.7, c * 0.7, 30, -20];
            d.updateParentTransform(matrix);
            renderer.setDrawableContainerAppearances(['outer', 'inner'].map(id => ({id,
                matrix,
                geometry: {frame: {x: 0, y: 0, width: 100, height: 60},
                    perspective: [[20, 0], [-20, 0], [0, 0], [0, 0]]}})));
            const frame = renderer.getContainerGeometryFrame('inner');
            for (const [key, expected] of Object.entries({x: 12, y: -8, width: 100, height: 60})) {
                t.ok(Math.abs(frame[key] - expected) < 0.0001, `${key} stays in container-local coordinates`);
            }
        }
    }
    t.end();
});

test('container reference frames include member perspective and descendant nine-slice geometry', t => {
    const {d, renderer} = fixture();
    renderer._drawList = [0];
    renderer._drawableContainerPaths.set(0, ['outer', 'inner']);
    const c = Math.SQRT1_2;
    const outer = [c, c, -c, c, 50, -20];
    const inner = [c, c, -c, c, 50 + (20 * c), -20 + (40 * c)];
    d.updateParentTransform(inner);
    d.updatePerspective({frame: null, corners: [[20, 0], [-20, 0], [0, 0], [0, 0]]});
    renderer.setDrawableContainerAppearances([
        {id: 'outer', matrix: outer},
        {id: 'inner',
            matrix: inner,
            geometry: {frame: {x: 0, y: 0, width: 100, height: 60},
                borders: {left: 10, right: 10, top: 10, bottom: 10},
                nineSlice: {width: 200, height: 100}}}
    ]);
    const frame = renderer.getContainerGeometryFrame('outer');
    for (const [key, expected] of Object.entries({x: 30, y: 10, width: 200, height: 100})) {
        t.ok(Math.abs(frame[key] - expected) < 0.0001, `${key} includes only descendant geometry`);
    }
    t.end();
});

test('nine-slice preserves border thickness through resizing, rotation and mirroring', t => {
    const {d} = fixture();
    d.updateNineSlice({width: 200, height: 80, left: 10, right: 20, top: 8, bottom: 12});
    d.skin.isTouchingNearest = p => p[0] >= 0 && p[0] < 0.1 && p[1] >= 0 && p[1] <= 1;
    for (const direction of [90, 0, -90, 180]) {
        for (const mirror of [-1, 1]) {
            d.updateProperties({position: [30, 20], direction, scale: [100 * mirror, 100]});
            d.updateCPURenderAttributes();
            const angle = (90 - direction) * Math.PI / 180;
            const world = x => [30 + (x * mirror * Math.cos(angle)), 20 + (x * mirror * Math.sin(angle))];
            t.ok(d.isTouching(world(-95)), 'left border still occupies 10 local units');
            t.notOk(d.isTouching(world(-85)), 'border did not stretch with the full image');
            t.notOk(d.isTouching(world(-105)), 'outside resized geometry');
        }
    }
    d.updateNineSlice({width: 1, height: 1, left: 10, right: 20, top: 8, bottom: 12});
    t.same(d.getGeometrySize(), [30, 20], 'minimum size preserves edges');
    d.updateNineSlice(null);
    t.same(d.getGeometrySize(), [100, 60]);
    t.end();
});

test('shape clipping is independent of internal half-plane, effects and stage transforms', t => {
    const {d} = fixture();
    d.updateClipShape({type: 'ellipse', left: -30, right: 30, bottom: -20, top: 20});
    d.updateCPURenderAttributes();
    t.ok(d.isTouching([0, 0]));
    t.notOk(d.isTouching([28, 18]), 'ellipse corner removed');
    d.updateClipPlane([1, 0, 0]);
    d.updateCPURenderAttributes();
    t.notOk(d.isTouching([10, 0]), 'component progress half-plane still applies');
    t.ok(d.isTouching([-10, 0]));
    d.updateClipPlane(null);
    d.updateClipShape({type: 'roundedRect', left: -30, right: 30, bottom: -20, top: 20, radius: 10});
    d.updateCPURenderAttributes();
    t.ok(d.isTouching([25, 10]));
    t.notOk(d.isTouching([29, 19]));
    d.updateClipShape({type: 'circle', space: 'stage', left: 10, right: 50, bottom: 0, top: 40});
    for (const direction of [0, 90, 180]) {
        d.updateProperties({position: [30, 20], direction, scale: [-200, 200]});
        d.updateCPURenderAttributes();
        t.ok(d.isTouching([30, 20]), 'stage circle stays at its own center');
        t.notOk(d.isTouching([48, 38]), 'stage circle is not reflected or rotated with the sprite');
    }
    d.updateClipShape({type: 'circle', space: 'stage', left: 10, right: 50, bottom: 0, top: 40, inverted: true});
    d.updateCPURenderAttributes();
    t.notOk(d.isTouching([30, 20]));
    t.ok(d.isTouching([48, 38]), 'inverse retains geometry outside the hole');
    t.same(Array.from(Drawable.sampleColor4b([30, 20], d, new Uint8ClampedArray(4))), [0, 0, 0, 0]);
    d.updateClipShape({left: 0, right: 0, bottom: 0, top: 0});
    d.updateCPURenderAttributes();
    t.notOk(d.isTouching([30, 20]), 'empty region hides everything');
    d.updateClipShape(null);
    d.updateProperties({scale: [0, 100]});
    d.updateCPURenderAttributes();
    t.notOk(d.isTouching([30, 20]), 'collapsed stretch has no hit area');
    t.end();
});

test('container shapes share point semantics, with conservative inverse bounds', t => {
    const {d, renderer} = fixture();
    renderer._drawableContainerPaths.set(0, ['outer', 'inner']);
    renderer.setDrawableContainerAppearances([
        {id: 'outer',
            clip: {type: 'ellipse', left: -40, right: 40, bottom: -30, top: 30},
            matrix: [0, 1, -1, 0, 20, 0]},
        {id: 'inner',
            clip: {type: 'circle',
                space: 'stage',
                left: 10,
                right: 30,
                bottom: -10,
                top: 10,
                inverted: true}}
    ]);
    d.updateCPURenderAttributes();
    t.notOk(d.isTouching([20, 0]), 'inner inverse removes center');
    t.ok(d.isTouching([20, 20]), 'outer ellipse and inner inverse both apply');
    t.notOk(d.isTouching([45, 29]), 'outside transformed ellipse');
    const bounds = renderer._containerCompositor.clipBounds(0, d.getAABB());
    t.ok(bounds.width > 20 && bounds.height > 20, 'inverse does not crop to the removed region');
    t.end();
});

test('projective corners, inverse picking and stage clipping use homogeneous coordinates', t => {
    const {d, renderer} = fixture();
    d.updatePerspective({frame: null, corners: [[20, 0], [-20, 0], [0, 0], [0, 0]]});
    d.updateCPURenderAttributes();
    const project = (x, y) => Array.from(twgl.m4.transformPoint(d._uniforms.u_modelMatrix,
        [0.5 - ((x + 50) / 100), ((30 - y) / 60) - 0.5, 0]));
    const topLeft = project(-50, 30);
    t.ok(Math.abs(topLeft[0] + 30) < 0.001 && Math.abs(topLeft[1] - 30) < 0.001);
    const center = project(0, 0);
    t.ok(Math.abs(center[1] - 7.5) < 0.001, 'center uses perspective-correct interpolation');
    t.ok(d.isTouching([0, 0]));
    t.notOk(d.isTouching([45, 25]), 'original rectangular corner no longer hits');
    const local = renderer.getDrawableLocalPosition(0, ...center);
    t.ok(local.every(n => Math.abs(n) < 0.001), 'component pointer can undo the projective transform');
    const bounds = d.getAABB();
    t.ok(Math.abs(bounds.left + 50) < 0.001 && Math.abs(bounds.right - 50) < 0.001);
    d.updateClipShape({space: 'stage', left: -5, right: 5, bottom: -5, top: 5});
    d.updateCPURenderAttributes();
    t.ok(d.isTouching([0, 0]));
    t.notOk(d.isTouching([0, -10]), 'stage clip divides by homogeneous w');
    d.updatePerspective(null);
    d.updateClipShape(null);
    d.updateCPURenderAttributes();
    t.ok(d.isTouching([45, 25]), 'clear restores the original affine matrix');
    t.equal(d._uniforms.u_modelMatrix[15], 1);
    t.end();
});

test('costume alpha and luminance masks affect collision and premultiplied CPU colors independently of shapes', t => {
    const {d, renderer} = fixture();
    renderer._allSkins = [];
    const mask = new MockSkin(1, {skinWasAltered: () => {}});
    renderer._allSkins[1] = mask;
    mask.updateSilhouette = () => {};
    mask._silhouette.colorAtNearest = (p, dst) => {
        dst.set(p[0] < 0.5 ? [0, 0, 0, 128] : [255, 255, 255, 255]);
        return dst;
    };
    const state = {skinId: 1, mode: 'alpha', space: 'local', x: 0, y: 0, width: 80, height: 60, inverted: false};
    d.updateCostumeMask(state);
    d.updateCPURenderAttributes();
    const color = new Uint8ClampedArray(4);
    t.same(Array.from(Drawable.sampleColor4b([-20, 0], d, color)), [128, 128, 128, 128]);
    t.notOk(d.isTouching([45, 0]), 'outside mask image is transparent');
    d.updateCostumeMask({...state, mode: 'luminance'});
    d.updateCPURenderAttributes();
    t.notOk(d.isTouching([-20, 0]), 'black removes pixels in luminance mode');
    t.ok(d.isTouching([20, 0]));
    d.updateCostumeMask({...state, mode: 'luminance', inverted: true});
    d.updateCPURenderAttributes();
    t.notOk(d.isTouching([20, 0]), 'inverse white is exactly transparent, with no floating-point residue');
    t.ok(d.isTouching([45, 0]), 'inverse includes the region outside the mask image');
    d.updateClipShape({left: -30, right: 30, bottom: -30, top: 30});
    d.updateCPURenderAttributes();
    t.notOk(d.isTouching([45, 0]), 'shape and mask intersect');
    d.updateCostumeMask(null);
    d.updateCPURenderAttributes();
    t.notOk(d.isTouching([45, 0]), 'clearing the mask preserves shape clipping');
    t.end();
});

test('container meshes split on slice boundaries and preserve nested inverse and stage coordinates', t => {
    const g = Warp.prepare({frame: {x: 10, y: -5, width: 100, height: 60},
        borders: {left: 10, right: 20, top: 8, bottom: 12},
        nineSlice: {width: 200, height: 80},
        perspective: [[20, 0], [-20, 0], [0, 0], [0, 0]]});
    const world = [0, -2, 30, -1.5, 0, 20, 0, 0, 1];
    const step = {warp: g, world, inverse: Warp.inverse(world)};
    const points = [[-40, -35], [60, -35], [60, 25], [-40, 25]];
    const pieces = Mesh.polygons(points.map(p => [...Warp.point(world, p), 1]), [step], true);
    t.equal(pieces.length, 9, 'nine exact regions without approximate tessellation');
    for (const p of [[-35, -30], [0, 0], [50, 20]]) {
        const restored = Warp.backward(g, Warp.forward(g, p));
        t.ok(p.every((n, i) => Math.abs(n - restored[i]) < 1e-6), 'inverse including unequal borders and center');
    }
    for (const piece of pieces) {
        for (const v of piece) {
            const source = [-40 + (v.uv[0] * 100), 25 - (v.uv[1] * 60)];
            const expected = Warp.point(world, Warp.forward(g, source));
            t.ok(expected.every((n, i) => Math.abs(n - (v.p[i] / v.p[2])) < 1e-6),
                'homogeneous vertex matches coordinate contract');
        }
    }
    const allBorders = Warp.prepare({frame: {x: 0, y: 0, width: 100, height: 60},
        borders: {left: 100, right: 100, top: 60, bottom: 60},
        nineSlice: {width: 300, height: 200}});
    for (const p of [[0, 0], [1, 1], [-20, 15]]) {
        const restored = Warp.backward(allBorders, Warp.forward(allBorders, p));
        t.ok(restored.every((n, i) => Number.isFinite(n) && Math.abs(n - p[i]) < 1e-4),
            'oversized borders retain an invertible center');
    }
    t.end();
});

test('collapsed container axes do not poison local movement or picking', t => {
    const {d, renderer} = fixture();
    d.updateParentTransform([0, 0, 0, 1, 0, 0]);
    t.same(renderer.getFencedPositionOfDrawable(0, [15, 20]), [15, 20]);
    d.updateCPURenderAttributes();
    t.notOk(d.isTouching([0, 0]));
    d.updateParentTransform([-1, 0, 0, 1, 0, 0]);
    d.updateCPURenderAttributes();
    t.ok(d.isTouching([0, 0]), 'restoring a mirrored axis restores picking');
    t.end();
});
