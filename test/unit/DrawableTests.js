const test = require('tap').test;

// Mock `window` and `document.createElement` for twgl.js.
global.window = {};
global.document = {
    createElement: () => ({getContext: () => {}})
};

const Drawable = require('../../src/Drawable');
const MockSkin = require('../fixtures/MockSkin');
const Rectangle = require('../../src/Rectangle');

/**
 * Returns a Rectangle-like object, with dimensions rounded to the given number
 * of digits.
 * @param {Rectangle} rect The source rectangle.
 * @param {int} decimals The number of decimal points to snap to.
 * @returns {object} An object with left/right/top/bottom attributes.
 */
const snapToNearest = function (rect, decimals = 3) {
    return {
        left: rect.left.toFixed(decimals),
        right: rect.right.toFixed(decimals),
        bottom: rect.bottom.toFixed(decimals),
        top: rect.top.toFixed(decimals)
    };
};

const mockRenderer = drawable => ({
    skinWasAltered: () => {
        drawable._skinWasAltered();
    }
});

test('translate by position', t => {
    const expected = new Rectangle();
    const drawable = new Drawable(null, {});
    drawable.skin = new MockSkin(0, mockRenderer(drawable));
    drawable.skin.size = [200, 50];

    expected.initFromBounds(0, 200, -50, 0);
    t.same(snapToNearest(drawable.getAABB()), expected);

    drawable.updateProperties({position: [1, 2]});
    expected.initFromBounds(1, 201, -48, 2);
    t.same(snapToNearest(drawable.getAABB()), expected);

    t.end();
});

test('translate by costume center', t => {
    const expected = new Rectangle();
    const drawable = new Drawable(null, {});
    drawable.skin = new MockSkin(0, mockRenderer(drawable));
    drawable.skin.size = [200, 50];

    drawable.skin.rotationCenter = [1, 0];
    expected.initFromBounds(-1, 199, -50, 0);
    t.same(snapToNearest(drawable.getAABB()), expected);

    drawable.skin.rotationCenter = [0, -2];
    expected.initFromBounds(0, 200, -52, -2);
    t.same(snapToNearest(drawable.getAABB()), expected);

    t.end();
});

test('translate and rotate', t => {
    const expected = new Rectangle();
    const drawable = new Drawable(null, {});
    drawable.skin = new MockSkin(0, mockRenderer(drawable));
    drawable.skin.size = [200, 50];

    drawable.updateProperties({position: [1, 2], direction: 0});
    expected.initFromBounds(1, 51, 2, 202);
    t.same(snapToNearest(drawable.getAABB()), expected);

    drawable.updateProperties({direction: 180});
    expected.initFromBounds(-49, 1, -198, 2);
    t.same(snapToNearest(drawable.getAABB()), expected);

    drawable.skin.rotationCenter = [100, 25];
    drawable.updateProperties({direction: 270, position: [0, 0]});
    expected.initFromBounds(-100, 100, -25, 25);
    t.same(snapToNearest(drawable.getAABB()), expected);

    drawable.updateProperties({direction: 90});
    t.same(snapToNearest(drawable.getAABB()), expected);

    t.end();
});

test('rotate by non-right-angles', t => {
    const expected = new Rectangle();
    const drawable = new Drawable(null, {});
    drawable.skin = new MockSkin(0, mockRenderer(drawable));
    drawable.skin.size = [10, 10];
    drawable.skin.rotationCenter = [5, 5];

    expected.initFromBounds(-5, 5, -5, 5);
    t.same(snapToNearest(drawable.getAABB()), expected);

    drawable.updateProperties({direction: 45});
    expected.initFromBounds(-7.071, 7.071, -7.071, 7.071);
    t.same(snapToNearest(drawable.getAABB()), expected);

    t.end();
});

test('scale', t => {
    const expected = new Rectangle();
    const drawable = new Drawable(null, {});
    drawable.skin = new MockSkin(0, mockRenderer(drawable));
    drawable.skin.size = [200, 50];

    drawable.updateProperties({scale: [100, 50]});
    expected.initFromBounds(0, 200, -25, 0);
    t.same(snapToNearest(drawable.getAABB()), expected);

    drawable.skin.rotationCenter = [0, 25];
    expected.initFromBounds(0, 200, -12.5, 12.5);
    t.same(snapToNearest(drawable.getAABB()), expected);

    drawable.skin.rotationCenter = [150, 50];
    drawable.updateProperties({scale: [50, 50]});
    expected.initFromBounds(-75, 25, 0, 25);
    t.same(snapToNearest(drawable.getAABB()), expected);

    t.end();
});

test('rotate and scale', t => {
    const expected = new Rectangle();
    const drawable = new Drawable(null, {});
    drawable.skin = new MockSkin(0, mockRenderer(drawable));
    drawable.skin.size = [100, 1000];

    drawable.skin.rotationCenter = [50, 50];
    expected.initFromBounds(-50, 50, -950, 50);
    t.same(snapToNearest(drawable.getAABB()), expected);

    drawable.updateProperties({scale: [40, 60]});
    drawable.skin.rotationCenter = [50, 50];
    expected.initFromBounds(-20, 20, -570, 30);
    t.same(snapToNearest(drawable.getAABB()), expected);

    t.end();
});


test('costume-local clipping follows transforms and precedes effects in CPU sensing', t => {
    const drawable = new Drawable(0, {});
    const skin = new MockSkin(0, mockRenderer(drawable));
    drawable.skin = skin;
    skin.size = [180, 12];
    skin.rotationCenter = [90, 6];
    skin.updateSilhouette = () => {};
    skin.useNearest = () => true;
    skin.isTouchingNearest = point => point[0] >= 0 && point[0] <= 1 && point[1] >= 0 && point[1] <= 1;
    skin.isTouchingLinear = skin.isTouchingNearest;
    skin._silhouette.colorAtNearest = (point, out) => out.fill(255);
    drawable.updateClipPlane([1, 0, 0]);
    for (const direction of [90, 0, -90, 180]) {
        for (const mirror of [1, -1]) {
            drawable.updateProperties({position: [20, 30], direction, scale: [150 * mirror, 150]});
            drawable.updateCPURenderAttributes();
            const angle = (90 - direction) * Math.PI / 180;
            const point = x => [20 + (x * mirror * 1.5 * Math.cos(angle)),
                30 + (x * mirror * 1.5 * Math.sin(angle))];
            t.ok(drawable.isTouching(point(-40)), 'revealed half remains touchable');
            t.notOk(drawable.isTouching(point(40)), 'clipped half does not collide');
            t.same(Array.from(Drawable.sampleColor4b(point(40), drawable, new Uint8ClampedArray(4))),
                [0, 0, 0, 0], 'clipped pixels do not contribute to color sensing');
        }
    }
    drawable.updateProperties({direction: 90, scale: [100, 100], position: [0, 0]});
    drawable.updateEffect('mosaic', 50);
    drawable.updateCPURenderAttributes();
    t.notOk(drawable.isTouching([40, 0]), 'mosaic cannot wrap a clipped point back into the costume');
    skin.useNearest = () => false;
    drawable.updateCPURenderAttributes();
    t.notOk(drawable.isTouching([40, 0]), 'linear picking also respects clipping');
    drawable.updateClipPlane(null);
    t.ok(drawable.isTouching([40, 0]), 'clearing the clip restores sensing');
    drawable.updateClipPlane([0, 1, 0]);
    drawable.updateCPURenderAttributes();
    t.ok(drawable.isTouching([0, -3]), 'vertical clip uses positive y up');
    t.notOk(drawable.isTouching([0, 3]));
    t.throws(() => drawable.updateClipPlane([NaN, 0, 0]));
    t.end();
});
