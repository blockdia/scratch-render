/* eslint-env browser */
/* global ScratchRender */
const {chromium} = require(process.env.RENDER_PLAYWRIGHT_PATH || 'playwright-chromium');
const test = require('tap').test;
const path = require('path');

(async () => {
    const browser = await chromium.launch({executablePath: process.env.RENDER_CHROME_PATH});
    try {
        for (const width of [480, 240]) {
            await test(`container mosaic extraction and stamping at stage width ${width}`, async t => {
                const page = await browser.newPage();
                const errors = [];
                page.on('pageerror', error => errors.push(error.message));
                await page.setContent('<canvas id="stage"></canvas>');
                await page.addScriptTag({path: path.resolve(__dirname, '../../dist/web/scratch-render.js')});
                const result = await page.evaluate(stageWidth => {
                    const canvas = document.getElementById('stage');
                    const r = new ScratchRender(canvas);
                    r.setLayerGroupOrdering(['pen', 'sprite']);
                    r.resize(stageWidth, stageWidth * 0.75);
                    const add = (x, color) => {
                        const bitmap = document.createElement('canvas');
                        bitmap.width = bitmap.height = 100;
                        const ctx = bitmap.getContext('2d');
                        ctx.fillStyle = color;
                        ctx.fillRect(0, 0, 100, 100);
                        const id = r.createDrawable('sprite');
                        r.updateDrawableSkinId(id, r.createBitmapSkin(bitmap, 1, [50, 50]));
                        r.updateDrawablePosition(id, [x, 0]);
                        return id;
                    };
                    const red = add(-50, '#ff0000');
                    const blue = add(50, '#0000ff');
                    r.setDrawableContainerPaths('sprite', [{drawables: [red, blue], containers: ['A']}]);
                    r.setDrawableContainerAppearances([{id: 'A', effects: {mosaic: 10}}]);
                    const pixels = () => {
                        r.dirty = true;
                        r.draw();
                        return [-75, -25, 25, 75].map(x => {
                            const data = new Uint8Array(4);
                            r.gl.readPixels(Math.floor((x + 240) * canvas.width / 480),
                                Math.floor(canvas.height / 2), 1, 1, r.gl.RGBA, r.gl.UNSIGNED_BYTE, data);
                            return Array.from(data);
                        });
                    };
                    const stage = pixels();
                    const image = r.extractDrawableScreenSpace(red).imageData;
                    const extracted = [0.125, 0.375, 0.625, 0.875].map(fraction => {
                        const offset = ((Math.floor(image.height / 2) * image.width) +
                            Math.floor(image.width * fraction)) * 4;
                        return Array.from(image.data.slice(offset, offset + 4));
                    });
                    const pen = r.createPenSkin();
                    r.updateDrawableSkinId(r.createDrawable('pen'), pen);
                    // Stamping a hidden member should still include that member's frame.
                    r.updateDrawableVisible(red, false);
                    r.penStamp(pen, red);
                    r.updateDrawableVisible(blue, false);
                    return {stage, extracted, stamped: pixels(), glError: r.gl.getError()};
                }, width);
                t.same(result.stage, [[255, 0, 0, 255], [0, 0, 255, 255],
                    [255, 0, 0, 255], [0, 0, 255, 255]], 'stage mosaic spans the full container');
                t.same(result.extracted, [[255, 0, 0, 255], [0, 0, 0, 0],
                    [255, 0, 0, 255], [0, 0, 0, 0]], 'extraction retains both red copies without blue siblings');
                t.same(result.stamped, [[255, 0, 0, 255], [255, 255, 255, 255],
                    [255, 0, 0, 255], [255, 255, 255, 255]],
                'stamp retains displaced pixels outside the member bounds');
                t.equal(result.glError, 0);
                t.same(errors, []);
                await page.close();
                t.end();
            });
        }
    } finally {
        await browser.close();
    }
})().catch(error => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
});
