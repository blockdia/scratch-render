const test = require('tap').test;
const RenderWebGL = require('../../src/RenderWebGL');

const makeRenderer = () => {
    const renderer = Object.create(RenderWebGL.prototype);
    Object.assign(renderer, {
        _drawList: [],
        _allDrawables: [],
        _nextDrawableId: 0,
        _drawableGroups: new Map(),
        _drawableGroupById: new Map(),
        _nextDrawableGroupId: 0,
        _layerGroups: {}
    });
    renderer.setLayerGroupOrdering(['background', 'sprite', 'overlay']);
    return renderer;
};

test('groups remain atomic when members and ordinary sprites change layers', t => {
    const r = makeRenderer();
    const stage = r.createDrawable('background');
    const a = r.createDrawable('sprite');
    const group = r.createDrawableGroup('sprite', 3);
    const parts = r.getDrawableGroupMembers(group);
    const b = r.createDrawable('sprite');
    const overlay = r.createDrawable('overlay');
    r.setDrawableOrder(a, 1, 'sprite', true);
    t.same(r._drawList, [stage, ...parts, a, b, overlay], 'one step crosses all parts');
    r.setDrawableOrder(parts[1], Infinity, 'sprite');
    t.same(r._drawList, [stage, a, b, ...parts, overlay], 'member moves whole group');
    r.setDrawableGroupOrder(group, -Infinity);
    t.same(r._drawList, [stage, ...parts, a, b, overlay], 'group stays inside sprite layer');
    r.setDrawableOrder(b, 2, 'sprite');
    t.same(r._drawList, [stage, ...parts, b, a, overlay], 'absolute insertion cannot split parts');
    t.equal(r._layerGroups.overlay.drawListOffset, 6);
    r.getDrawableGroupMembers(group).pop();
    t.equal(r.getDrawableGroupMembers(group).length, 3, 'membership is not externally mutable');
    r.destroyDrawable(parts[1], 'overlay');
    t.equal(r.getDrawableGroupMembers(group).length, 3, 'wrong layer cannot delete a part');
    r.destroyDrawable(parts[1], 'sprite');
    t.same(r.getDrawableGroupMembers(group), [parts[0], parts[2]]);
    r.destroyDrawableGroup(group);
    t.same(r._drawList, [stage, b, a, overlay]);
    t.equal(r._layerGroups.overlay.drawListOffset, 3);
    t.equal(r._drawableGroups.size, 0);
    t.equal(r._drawableGroupById.size, 0);
    r.destroyDrawableGroup(group);
    t.throws(() => r.createDrawableGroup('missing', 3));
    t.throws(() => r.createDrawableGroup('sprite', 0));
    t.end();
});

test('multiple groups move by target-sized steps and respect minimum layer', t => {
    const r = makeRenderer();
    const a = r.createDrawableGroup('sprite', 2);
    const b = r.createDrawableGroup('sprite', 3);
    const c = r.createDrawable('sprite');
    const aa = r.getDrawableGroupMembers(a);
    const bb = r.getDrawableGroupMembers(b);
    r.setDrawableGroupOrder(a, 1, true);
    t.same(r._drawList, [...bb, ...aa, c]);
    r.setDrawableGroupOrder(a, -Infinity, false, 1);
    t.same(r._drawList, [...bb, ...aa, c], 'minimum inside a group snaps past that group');
    r.setDrawableGroupOrder(b, Infinity);
    t.same(r._drawList, [...aa, c, ...bb]);
    t.equal(r.setDrawableGroupOrder(999, 1), null);
    t.end();
});
