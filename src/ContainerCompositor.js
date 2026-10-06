const twgl = require('twgl.js');
const Drawable = require('./Drawable');
const EffectTransform = require('./EffectTransform');
const ShaderManager = require('./ShaderManager');
const Rectangle = require('./Rectangle');
const Geometry = require('./GraphicGeometry');
const Warp = require('./ContainerGeometry');
const Mesh = require('./ContainerGeometryMesh');

const IDENTITY = [1, 0, 0, 1, 0, 0];
const EMPTY_PATH = [];
const COLOR_EFFECTS = ShaderManager.EFFECT_INFO.color.mask | ShaderManager.EFFECT_INFO.brightness.mask |
    ShaderManager.EFFECT_INFO.ghost.mask;
// Scratch's regular stage fits comfortably; oversized/deep effects reduce resolution, never drop effects.
const MAX_PIXELS = 4 * 1024 * 1024;
const matrix4 = m => new Float32Array([m[0], m[1], 0, 0, m[2], m[3], 0, 0, 0, 0, 1, 0, m[4], m[5], 0, 1]);
const point = (m, x, y) => Array.from(twgl.m4.transformPoint(m, [x, y, 0])).slice(0, 2);
const corners = b => [[b.left, b.bottom], [b.right, b.bottom], [b.right, b.top], [b.left, b.top]];

/** GPU-only temporary surfaces plus a matching logical (non-warped) CPU scene sampler. */
class ContainerCompositor {
    constructor (renderer) {
        this.renderer = renderer;
        this.states = new Map();
        this.active = false;
        this.pool = [];
    }

    setStates (states) {
        const ids = new Set();
        for (const state of states) {
            ids.add(state.id);
            this.setState(state.id, state.effects, state.clip, state.matrix, false, state.geometry);
        }
        for (const id of this.states.keys()) {
            if (!ids.has(id)) this.states.delete(id);
        }
        this._updateActive();
    }

    setState (id, effects, clip, matrix, update = true, geometry) {
        const previous = this.states.get(id);
        const world = matrix ? matrix4(matrix) : previous ? previous.world : matrix4(IDENTITY);
        const uniforms = {};
        let enabledEffects = 0;
        for (const name of ShaderManager.EFFECTS) {
            const info = ShaderManager.EFFECT_INFO[name];
            const value = effects && Number.isFinite(effects[name]) ? effects[name] : 0;
            uniforms[info.uniformName] = info.converter(value);
            if (value) enabledEffects |= info.mask;
        }
        const warp = typeof geometry === 'undefined' && previous ? previous.warp : Warp.prepare(geometry);
        const matrix3 = [world[0], world[4], world[12], world[1], world[5], world[13], 0, 0, 1];
        const state = {id,
            warp: warp && warp.active ? warp : null,
            matrix3,
            inverse3: Warp.inverse(matrix3),
            world,
            inverse: twgl.m4.inverse(world),
            enabledEffects,
            clip: clip ? Object.assign({}, clip) : null,
            uniforms,
            getUniforms: () => uniforms};
        this.states.set(id, state);
        if (update) this._updateActive();
    }

    _updateActive () {
        this.active = Array.from(this.states.values()).some(state => state.enabledEffects || state.clip || state.warp);
        if (!this.active) this._releaseFrom(0);
        this.renderer.dirty = true;
    }

    _releaseFrom (depth) {
        const gl = this.renderer.gl;
        for (const surface of this.pool.splice(depth)) {
            gl.deleteTexture(surface.attachments[0]);
            gl.deleteFramebuffer(surface.framebuffer);
        }
    }

    paths (id) {
        return this.renderer._drawableContainerPaths.get(id) || EMPTY_PATH;
    }

    steps (id) {
        return this.paths(id).slice()
            .reverse()
            .map(path => this.states.get(path))
            .filter(s => s && s.warp)
            .map(s => ({world: s.matrix3, inverse: s.inverse3, warp: s.warp}));
    }

    warpPoint (id, position) {
        return this.steps(id).reduce((p, step) => Warp.point(step.world,
            Warp.forward(step.warp, Warp.point(step.inverse, p))), [position[0], position[1]]);
    }

    unwarpPoint (id, position) {
        let p = [position[0], position[1]];
        for (const path of this.paths(id)) {
            const state = this.states.get(path);
            if (state && state.warp) {
                p = Warp.point(state.matrix3,
                    Warp.backward(state.warp, Warp.point(state.inverse3, p)));
            }
        }
        return p;
    }

    isPointClipped (id, position) {
        let p = [position[0], position[1]];
        for (const path of this.paths(id)) {
            const state = this.states.get(path);
            if (!state) continue;
            let local = Warp.point(state.inverse3, p);
            if (state.warp) {
                local = Warp.backward(state.warp, local);
                p = Warp.point(state.matrix3, local);
            }
            if (!local.every(Number.isFinite)) return true;
            if (state.clip && !Geometry.contains(state.clip,
                ...(state.clip.space === 'stage' ? position : local))) return true;
        }
        return false;
    }

    mesh (points, steps, renderFirst) {
        return Mesh.polygons(points, steps, renderFirst);
    }

    drawMesh (shader, polygons) {
        const gl = this.renderer.gl;
        const arrays = Mesh.arrays(polygons);
        if (!arrays.a_texCoord.data.length) return;
        // One streaming buffer per attribute, reused across all containers and passes.
        if (this.meshBuffer) {
            for (const [name, data] of Object.entries(arrays)) {
                gl.bindBuffer(gl.ARRAY_BUFFER, this.meshBuffer.attribs[name].buffer);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data.data), gl.DYNAMIC_DRAW);
            }
            this.meshBuffer.numElements = arrays.a_texCoord.data.length / 2;
        } else this.meshBuffer = twgl.createBufferInfoFromArrays(gl, arrays);
        twgl.setBuffersAndAttributes(gl, shader, this.meshBuffer);
        twgl.drawBufferInfo(gl, this.meshBuffer, gl.TRIANGLES);
    }

    getFrame (id) {
        const state = this.states.get(id);
        const points = [];
        if (state) {
            for (const drawableId of this.renderer._drawList) {
                const paths = this.paths(drawableId);
                const index = paths.indexOf(id);
                const drawable = this.renderer._allDrawables[drawableId];
                if (index < 0 || !drawable || !drawable.skin || drawable.skin.private) continue;
                const steps = paths.slice(index + 1).reverse()
                    .map(path => this.states.get(path))
                    .filter(s => s && s.warp)
                    .map(s => ({world: s.matrix3, inverse: s.inverse3, warp: s.warp}));
                const pieces = this.mesh(corners(drawable.getAABB()).map(p => [...p, 1]), steps);
                for (const piece of pieces) {
                    points.push(...piece.map(v => Warp.point(state.inverse3, [v.p[0] / v.p[2], v.p[1] / v.p[2]])));
                }
            }
        }
        if (!points.length || !points.every(p => p.every(Number.isFinite))) {
            return {x: 0, y: 0, width: 100, height: 100};
        }
        const bounds = new Rectangle();
        bounds.initFromPointsAABB(points);
        return {x: (bounds.left + bounds.right) / 2,
            y: (bounds.bottom + bounds.top) / 2,
            width: Math.max(0.01, bounds.width),
            height: Math.max(0.01, bounds.height)};
    }

    isGhosted (id) {
        return this.paths(id).some(path => {
            const state = this.states.get(path);
            return state && state.uniforms.u_ghost === 0;
        });
    }

    // A query mask belongs to the member, not to the whole container; ghost never erases that mask.
    sampleDrawable (id, position, dst, effectMask) {
        Drawable.sampleColor4b(position, this.renderer._allDrawables[id], dst, effectMask);
        const paths = this.paths(id);
        for (let i = paths.length - 1; i >= 0; i--) {
            const state = this.states.get(paths[i]);
            if (state) EffectTransform.transformColor(state, dst, effectMask);
        }
        return dst;
    }

    // Only supplied leaves are included. In particular, never expand a component group or reinsert a query's self.
    tree (ids, sampling = true, logical = sampling) {
        const buffers = () => (sampling ? {color: new Uint8ClampedArray(4), output: new Float64Array(4)} : {});
        const nodes = new Map();
        const root = Object.assign({children: [], containers: nodes}, buffers());
        for (const id of ids) {
            let parent = root;
            for (const path of this.paths(id)) {
                const state = this.states.get(path);
                if (!state || (!(state.enabledEffects & (logical ? COLOR_EFFECTS : ~0)) &&
                    !state.clip && !state.warp)) continue;
                let node = nodes.get(path);
                if (!node) {
                    node = Object.assign({state,
                        ancestors: this.paths(id).slice(0, this.paths(id).indexOf(path)),
                        children: []}, buffers());
                    nodes.set(path, node);
                    parent.children.push(node);
                }
                parent = node;
            }
            parent.children.push(Object.assign({id}, buffers()));
        }
        return root;
    }

    sample (node, position, dst) {
        const color = node.color;
        color.fill(0);
        if (dst) {
            const background = this.renderer._backgroundColor4f;
            for (let i = 0; i < 4; i++) color[i] = 255 * background[i];
        }
        if (typeof node.id === 'number') {
            Drawable.sampleColor4b(position, this.renderer._allDrawables[node.id], color);
        } else {
            for (const child of node.children) {
                const src = this.sample(child, position);
                const remaining = 1 - (src[3] / 255);
                for (let i = 0; i < 4; i++) color[i] = src[i] + (color[i] * remaining);
            }
            if (node.state) {
                // Ghost runs in the fragment shader before destination blending. Rounding its alpha
                // to a byte here would make 50% red over white yield 127 on CPU but 128 on GPU.
                EffectTransform.transformColor(node.state, color, ~ShaderManager.EFFECT_INFO.ghost.mask);
                for (let i = 0; i < 4; i++) node.output[i] = color[i] * node.state.uniforms.u_ghost;
                return node.output;
            }
        }
        if (dst) {
            dst.set(color);
            return dst;
        }
        return color;
    }

    // Clip a world-space bounds polygon, including rotated ancestor clips.
    clipBounds (id, bounds) {
        const steps = this.steps(id);
        if (steps.length) {
            const polygons = this.mesh(corners(bounds).map(p => [...p, 1]), steps);
            const result = new Rectangle();
            const points = polygons.flatMap(poly => poly.map(v => [v.p[0] / v.p[2], v.p[1] / v.p[2]]));
            if (points.length) result.initFromPointsAABB(points);
            else result.initFromBounds(0, 0, 0, 0);
            return result;
        }
        if (!this.paths(id).some(path => this.states.get(path) && this.states.get(path).clip)) return bounds;
        let polygon = corners(bounds);
        for (const path of this.paths(id)) {
            const state = this.states.get(path);
            if (!state || !state.clip || state.clip.inverted) continue;
            const stage = state.clip.space === 'stage';
            polygon = stage ? polygon : polygon.map(p => point(state.inverse, p[0], p[1]));
            for (const [axis, limit, sign] of [[0, state.clip.left, 1], [0, state.clip.right, -1],
                [1, state.clip.bottom, 1], [1, state.clip.top, -1]]) {
                const next = [];
                for (let i = 0; i < polygon.length; i++) {
                    const a = polygon[i];
                    const b = polygon[(i + 1) % polygon.length];
                    const insideA = (a[axis] - limit) * sign >= 0;
                    const insideB = (b[axis] - limit) * sign >= 0;
                    if (insideA) next.push(a);
                    if (insideA !== insideB) {
                        const t = (limit - a[axis]) / (b[axis] - a[axis]);
                        next.push([a[0] + ((b[0] - a[0]) * t), a[1] + ((b[1] - a[1]) * t)]);
                    }
                }
                polygon = next;
            }
            polygon = stage ? polygon : polygon.map(p => point(state.world, p[0], p[1]));
        }
        const result = new Rectangle();
        if (polygon.length) {
            result.initFromPointsAABB(polygon);
        } else result.initFromBounds(0, 0, 0, 0);
        return result;
    }

    prepare (ids, opts = {}) {
        const tree = this.tree(ids, false, Boolean(opts.containerSensing));
        let frames;
        if (tree.containers.size && !opts.containerSensing && ids !== this.renderer._drawList) {
            // A partial draw still uses the stage's effect frames. Only requested
            // leaves enter the output; siblings contribute bounds, never pixels.
            const selected = new Set(ids.filter(id => !opts.filter || opts.filter(id)));
            const scene = this.tree(this.renderer._drawList, false, false);
            this._prepare(scene, Object.assign({}, opts, {
                filter: id => this.renderer._allDrawables[id].getVisible() || selected.has(id)
            }));
            frames = scene.containers;
        }
        this._prepare(tree, opts, frames);
        return tree;
    }

    expandBounds (tree, bounds) {
        // Warps can move the selected member anywhere within a container's frame.
        // Extraction and stamping must retain those pixels outside its own bounds.
        for (const node of tree.containers.values()) {
            if (!node.bounds || !(node.state.enabledEffects & ~COLOR_EFFECTS)) continue;
            const frame = new Rectangle();
            const states = [node.state, ...node.ancestors.slice().reverse()
                .map(id => this.states.get(id))];
            const steps = states.filter(s => s && s.warp)
                .map(s => ({world: s.matrix3, inverse: s.inverse3, warp: s.warp}));
            const pieces = this.mesh(corners(node.bounds).map(p => [...point(node.state.world, ...p), 1]), steps);
            const points = pieces.flatMap(poly => poly.map(v => [v.p[0] / v.p[2], v.p[1] / v.p[2]]));
            if (points.length) {
                frame.initFromPointsAABB(points);
                Rectangle.union(bounds, frame, bounds);
            }
        }
        return bounds;
    }

    _prepare (node, opts, frames) {
        if (typeof node.id === 'number') {
            const drawable = this.renderer._allDrawables[node.id];
            if (!drawable || !drawable.skin || (!opts.ignoreVisibility && !drawable.getVisible()) ||
                (opts.skipPrivateSkins && drawable.skin.private) || (opts.filter && !opts.filter(node.id))) return [];
            drawable.updateMatrix();
            const m = drawable.getUniforms().u_modelMatrix;
            node.corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]
                .map(p => point(m, p[0], p[1]));
            return node.corners;
        }
        const points = [];
        for (const child of node.children) points.push(...this._prepare(child, opts, frames));
        if (!node.state || !points.length) return points;
        node.inputBounds = new Rectangle();
        node.inputBounds.initFromPointsAABB(points.map(p => point(node.state.inverse, ...p)));
        const frame = frames && frames.get(node.state.id);
        if (frame && frame.bounds) {
            node.bounds = frame.bounds;
        } else {
            const bounds = new Rectangle();
            bounds.initFromPointsAABB(points.map(p => point(node.state.inverse, p[0], p[1])));
            if (node.state.clip && !node.state.clip.inverted && node.state.clip.space !== 'stage') {
                // An explicit clip is also a stable effect frame in container-local Scratch units.
                Object.assign(bounds, node.state.clip);
            }
            node.bounds = bounds;
        }
        if (node.state.warp) {
            const polygons = this.mesh(corners(node.bounds).map(p => [...point(node.state.world, ...p), 1]),
                [{world: node.state.matrix3, inverse: node.state.inverse3, warp: node.state.warp}]);
            return polygons.flatMap(poly => poly.map(v => [v.p[0] / v.p[2], v.p[1] / v.p[2]]));
        }
        return corners(node.bounds).map(p => point(node.state.world, p[0], p[1]));
    }

    _surface (depth, width, height) {
        const gl = this.renderer.gl;
        if (!this.maxSize) this.maxSize = Math.min(2048, gl.getParameter(gl.MAX_TEXTURE_SIZE));
        width = Math.max(1, Math.ceil(width / 32) * 32);
        height = Math.max(1, Math.ceil(height / 32) * 32);
        const used = this.pool.slice(0, depth).reduce((sum, surface) => sum + (surface.width * surface.height), 0);
        const available = Math.max(1, MAX_PIXELS - used);
        const scale = Math.min(1, this.maxSize / width, this.maxSize / height, Math.sqrt(available / (width * height)));
        width = Math.max(1, Math.floor(width * scale));
        height = Math.max(1, Math.floor(height * scale));
        let surface = this.pool[depth];
        if (surface && surface.width >= width && surface.height >= height &&
            surface.width <= width * 2 && surface.height <= height * 2 &&
            surface.width * surface.height <= available) {
            this.usedDepth = Math.max(this.usedDepth, depth + 1);
            return surface;
        }
        if (!surface || surface.width !== width || surface.height !== height) {
            this._releaseFrom(depth);
            surface = twgl.createFramebufferInfo(gl, [{format: gl.RGBA,
                min: gl.LINEAR,
                mag: gl.LINEAR,
                wrap: gl.CLAMP_TO_EDGE}], width, height);
            this.pool[depth] = surface;
        }
        this.usedDepth = Math.max(this.usedDepth, depth + 1);
        return surface;
    }

    _bind (target) {
        const gl = this.renderer.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.viewport(...target.viewport);
        if (target.stencil) gl.enable(gl.STENCIL_TEST);
        else gl.disable(gl.STENCIL_TEST);
        gl.colorMask(...(target.colorMask || [true, true, true, true]));
    }

    draw (ids, mode, projection, opts) {
        const r = this.renderer;
        const gl = r.gl;
        const tree = opts.containerTree || this.prepare(ids, opts);
        const target = opts.containerTarget || {framebuffer: null, viewport: [0, 0, gl.canvas.width, gl.canvas.height]};
        this.usedDepth = 0;
        r._doExitDrawRegion();
        try {
            this._drawChildren(tree, mode, projection, opts, target, 0);
        } finally {
            r._doExitDrawRegion();
            this._bind(target);
            this._releaseFrom(this.usedDepth);
        }
    }

    _drawChildren (node, mode, projection, opts, target, depth) {
        const r = this.renderer;
        let leaves = [];
        const flush = () => {
            if (leaves.length) r._drawTheseDirect(leaves, mode, projection, opts);
            leaves = [];
        };
        for (const child of node.children) {
            if (typeof child.id === 'number') {
                if (child.corners) leaves.push(child.id);
            } else if (child.bounds && child.bounds.width > 0 && child.bounds.height > 0 &&
                Number.isFinite(child.bounds.width) && Number.isFinite(child.bounds.height)) {
                flush();
                this._drawContainer(child, mode, projection, opts, target, depth);
            }
        }
        flush();
    }

    _drawContainer (node, mode, projection, opts, target, depth) {
        const r = this.renderer;
        const gl = r.gl;
        const {bounds, state} = node;
        if (state.uniforms.u_ghost === 0 &&
            (typeof opts.effectMask !== 'number' || opts.effectMask & ShaderManager.EFFECT_INFO.ghost.mask)) return;
        const rx = (opts.framebufferWidth || r._nativeSize[0]) / r._nativeSize[0];
        const ry = (opts.framebufferHeight || r._nativeSize[1]) / r._nativeSize[1];
        const sx = Math.hypot(state.world[0] * rx, state.world[1] * ry);
        const sy = Math.hypot(state.world[4] * rx, state.world[5] * ry);
        const surface = this._surface(depth, Math.ceil(bounds.width * sx), Math.ceil(bounds.height * sy));
        const innerTarget = {framebuffer: surface.framebuffer, viewport: [0, 0, surface.width, surface.height]};
        this._bind(innerTarget);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const innerProjection = twgl.m4.multiply(
            twgl.m4.ortho(bounds.left, bounds.right, bounds.top, bounds.bottom, -1, 1), state.inverse);
        this._drawChildren(node, ShaderManager.DRAW_MODE.default, innerProjection, opts, innerTarget, depth + 1);
        r._doExitDrawRegion();
        this._bind(target);
        let effects = state.enabledEffects;
        if (opts.containerSensing) effects &= COLOR_EFFECTS;
        if (typeof opts.effectMask === 'number') effects &= opts.effectMask;
        const shader = r._shaderManager.getShader(mode, effects);
        if (!this.buffer) {
            this.buffer = twgl.createBufferInfoFromArrays(gl, {
                a_position: {numComponents: 2,
                    data: [-0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
                        -0.5, 0.5, 0.5, -0.5, 0.5, 0.5]},
                a_texCoord: {numComponents: 2, data: [0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0]}
            });
        }
        const model = twgl.m4.multiply(state.world, twgl.m4.translation(
            [(bounds.left + bounds.right) / 2, (bounds.bottom + bounds.top) / 2, 0]));
        twgl.m4.scale(model, [bounds.width, bounds.height, 1], model);
        gl.useProgram(shader.program);
        twgl.setBuffersAndAttributes(gl, shader, this.buffer);
        twgl.setTextureParameters(gl, surface.attachments[0], {
            minMag: opts.containerSensing ? gl.NEAREST : gl.LINEAR
        });
        twgl.setUniforms(shader, Object.assign({}, state.uniforms, {
            u_warpMesh: 1,
            u_clipStage: state.clip && state.clip.space === 'stage' ? 1 : 0,
            u_maskStage: 0,
            u_skin: surface.attachments[0],
            u_mask: surface.attachments[0],
            u_maskMode: 0,
            u_skinSize: [bounds.width, bounds.height],
            u_clipPlane: [0, 0, 1],
            u_sliceX: [0, 0, 0, 0],
            u_sliceY: [0, 0, 0, 0],
            ...Geometry.clipUniforms(state.clip, state.clip && state.clip.space === 'stage' ?
                [1, 0, 0, 1, 0, 0] :
                [bounds.width, 0, 0, -bounds.height, bounds.left, bounds.top]),
            u_projectionMatrix: projection,
            u_modelMatrix: model
        }, opts.extraUniforms));
        const steps = [{world: state.matrix3, inverse: state.inverse3, warp: state.warp},
            ...node.ancestors.slice().reverse()
                .map(id => this.states.get(id))
                .filter(s => s && s.warp)
                .map(s => ({world: s.matrix3, inverse: s.inverse3, warp: s.warp}))];
        this.drawMesh(shader, this.mesh(corners(bounds).map(p => [...point(state.world, ...p), 1]), steps, true));
        r._regionId = null;
    }
}

module.exports = ContainerCompositor;
