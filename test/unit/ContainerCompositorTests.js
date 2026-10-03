const test = require('tap').test;
const RenderWebGL = require('../../src/RenderWebGL');
const Drawable = require('../../src/Drawable');
const MockSkin = require('../fixtures/MockSkin');
const ShaderManager = require('../../src/ShaderManager');

const fixture = () => {
    const r = Object.create(RenderWebGL.prototype);
    Object.assign(r, {_drawList: [],
        _allDrawables: [],
        _drawableContainerPaths: new Map(),
        _backgroundColor4f: [1, 1, 1, 1],
        _backgroundColor3b: [255, 255, 255],
        _xLeft: -240,
        _xRight: 240,
        _yBottom: -180,
        _yTop: 180});
    const add = (paths, rgb, x = 0) => {
        const id = r._allDrawables.length;
        const d = new Drawable(id, r);
        d.skin = new MockSkin(id, {skinWasAltered: () => d._skinWasAltered()});
        d.skin.size = [20, 20];
        d.skin.rotationCenter = [10, 10];
        d.skin.updateSilhouette = () => {};
        d.skin.getTexture = () => ({});
        d.skin.useNearest = () => true;
        d.skin.isTouchingNearest = p => p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1;
        d.skin._silhouette.colorAtNearest = (p, dst) => {
            dst.set([...rgb, 255]);
            return dst;
        };
        d.updatePosition([x, 0]);
        d.updateCPURenderAttributes();
        r._allDrawables.push(d);
        r._drawList.push(id);
        r._drawableContainerPaths.set(id, paths);
        return d;
    };
    r.setDrawableContainerAppearances([]);
    return {r, add, compositor: r._containerCompositor};
};

test('CPU scene applies group ghost once and excludes only supplied leaves', t => {
    const {r, add, compositor} = fixture();
    const a = add(['A'], [255, 0, 0]);
    const b = add(['A'], [255, 0, 0]);
    const outside = add([], [0, 0, 255], 100);
    r.updateDrawableContainerAppearance('A', {ghost: 50}, null);
    const sample = ids => Array.from(compositor.sample(compositor.tree(ids), [0, 0], new Uint8ClampedArray(4)));
    t.same(sample([a._id, b._id]), [255, 128, 128, 255], 'overlap is faded only after composition');
    t.same(sample([b._id]), sample([a._id, b._id]), 'excluding self retains the sibling and its parent');
    t.same(sample([outside._id]), [255, 255, 255, 255]);
    r.updateDrawableContainerAppearance('A', {ghost: 100, whirl: 100, mosaic: 40}, null);
    t.ok(r.isTouchingDrawables(a._id, [b._id]), 'same-container collision ignores group ghost and warps');
    outside.updatePosition([0, 0]);
    t.ok(r.isTouchingDrawables(outside._id, [b._id]), 'cross-container collision uses identical rules');
    t.ok(compositor.isGhosted(a._id), 'click picking can separately reject full group ghost');
    t.same(sample([b._id]), [255, 255, 255, 255], 'other sprites see the faded logical scene');
    const mask = new Uint8ClampedArray(4);
    compositor.sampleDrawable(a._id, [0, 0], mask, ~ShaderManager.EFFECT_INFO.ghost.mask);
    t.same(Array.from(mask), [255, 0, 0, 255], 'the querying member mask ignores all inherited ghost');
    t.end();
});

test('nested color effects follow tree order without changing member uniforms', t => {
    const {r, add, compositor} = fixture();
    const a = add(['A', 'N'], [255, 0, 0]);
    r.setDrawableContainerAppearances([
        {id: 'A', effects: {ghost: 50}},
        {id: 'N', effects: {brightness: -100}}
    ]);
    const color = compositor.sample(compositor.tree([a._id]), [0, 0], new Uint8ClampedArray(4));
    t.same(Array.from(color), [128, 128, 128, 255], 'black inner result is faded by the outer container');
    t.equal(a.getUniforms().u_ghost, 1);
    t.equal(a.getUniforms().u_brightness, 0);
    r.updateDrawableContainerAppearance('N', null, null);
    t.same(Array.from(compositor.sample(compositor.tree([a._id]), [0, 0], color)), [255, 128, 128, 255]);
    r.setDrawableContainerAppearances([]);
    t.notOk(compositor.active, 'clearing the project restores the direct rendering path');
    t.equal(compositor.states.size, 0);
    t.end();
});

test('ancestor clips remain precise under rotation, for both same and cross container collisions', t => {
    const {r, add, compositor} = fixture();
    const a = add(['A'], [255, 0, 0]);
    const b = add(['A'], [0, 255, 0], 5);
    const outside = add([], [0, 0, 255], 5);
    // The local left half becomes the lower half after a 90 degree CCW turn.
    r.setDrawableContainerAppearances([{id: 'A',
        matrix: [0, 1, -1, 0, 0, 0],
        effects: {ghost: 100, fisheye: 200},
        clip: {left: -10, right: 0, bottom: -10, top: 10}}]);
    t.ok(a.isTouching([0, -5]));
    t.notOk(a.isTouching([0, 5]));
    b.updatePosition([0, 15]);
    outside.updatePosition([0, 15]);
    t.notOk(r.isTouchingDrawables(a._id, [b._id]), 'same-container clipped overlap cannot collide');
    t.notOk(r.isTouchingDrawables(a._id, [outside._id]), 'cross-container clipped overlap cannot collide');
    const bounds = compositor.clipBounds(a._id, a.getAABB());
    t.equal(bounds.top, 0);
    t.same(Array.from(Drawable.sampleColor4b([0, 5], a, new Uint8ClampedArray(4))), [0, 0, 0, 0]);
    r.updateDrawableContainerAppearance('A', null, null);
    t.ok(a.isTouching([0, 5]), 'removing clip immediately restores sensing');
    t.end();
});


test('partial visual draws retain full effect frames while excluding sibling pixels', t => {
    const {r, add, compositor} = fixture();
    const a = add(['A', 'N'], [255, 0, 0], -10);
    const b = add(['A', 'N'], [0, 0, 255], 10);
    add(['A'], [0, 255, 0], 50);
    add([], [0, 0, 0], 100);
    r.setDrawableContainerAppearances([
        {id: 'A', effects: {whirl: 50}},
        {id: 'N', effects: {mosaic: 10}}
    ]);
    const tree = compositor.prepare([a._id]);
    t.same(tree.containers.get('N').bounds, compositor.prepare(r._drawList).containers.get('N').bounds);
    t.equal(tree.containers.get('N').bounds.left, -20);
    t.equal(tree.containers.get('N').bounds.right, 20);
    t.equal(tree.containers.get('A').bounds.right, 60, 'outer frame includes its other visible members');
    t.same(tree.containers.get('N').children.map(node => node.id), [a._id], 'only the selected leaf is drawn');
    const bounds = compositor.expandBounds(tree, a.getAABB());
    t.equal(bounds.left, -20);
    t.equal(bounds.right, 60, 'output bounds include displaced pixels from both warps');
    b.updatePosition([30, 0]);
    t.equal(compositor.prepare([a._id]).containers.get('N').bounds.right, 40, 'frames follow current positions');
    b.updateVisible(false);
    t.ok(Math.abs(compositor.prepare([a._id]).containers.get('N').bounds.right) < 1e-8,
        'hidden siblings do not enlarge frames');
    a.updateVisible(false);
    t.ok(Math.abs(compositor.prepare([a._id], {ignoreVisibility: true}).containers.get('N').bounds.right) < 1e-8,
        'stamping includes the hidden selected leaf but not other hidden siblings');
    t.end();
});

test('partial visual frames preserve transformed clips without expanding logical queries', t => {
    const {r, add, compositor} = fixture();
    const a = add(['A'], [255, 0, 0]);
    add(['A'], [0, 0, 255], 100);
    const clip = {left: -20, right: 40, bottom: -10, top: 10};
    r.setDrawableContainerAppearances([{id: 'A', matrix: [0, 1, -1, 0, 50, 0], effects: {mosaic: 10}, clip}]);
    const tree = compositor.prepare([a._id]);
    t.same({...tree.containers.get('A').bounds}, clip, 'explicit local clip remains the effect frame');
    const bounds = compositor.expandBounds(tree, a.getAABB());
    t.equal(bounds.right, 60, 'warped output includes the transformed frame');
    t.equal(bounds.top, 40);
    r.updateDrawableContainerAppearance('A', {mosaic: 10}, null);
    const logical = compositor.prepare([a._id], {containerSensing: true});
    t.equal(logical.containers.size, 0, 'logical masks still ignore visual warps');
    r.updateDrawableContainerAppearance('A', {ghost: 50}, null);
    t.same(compositor.expandBounds(compositor.prepare([a._id]), a.getAABB()), a.getAABB(),
        'color-only effects retain the tight member bounds');
    t.end();
});
