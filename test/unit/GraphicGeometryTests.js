const test = require('tap').test;
const Drawable = require('../../src/Drawable');
const MockSkin = require('../fixtures/MockSkin');
const RenderWebGL = require('../../src/RenderWebGL');

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
