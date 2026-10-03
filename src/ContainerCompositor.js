const twgl = require('twgl.js');
const Drawable = require('./Drawable');
const EffectTransform = require('./EffectTransform');
const ShaderManager = require('./ShaderManager');
const Rectangle = require('./Rectangle');

const IDENTITY = [1, 0, 0, 1, 0, 0];
const EMPTY_PATH = [];
const COLOR_EFFECTS = ShaderManager.EFFECT_INFO.color.mask | ShaderManager.EFFECT_INFO.brightness.mask |
    ShaderManager.EFFECT_INFO.ghost.mask;
// Scratch's regular stage fits comfortably; oversized/deep effects reduce resolution, never drop effects.
const MAX_PIXELS = 4 * 1024 * 1024;
const matrix4 = m => new Float32Array([m[0], m[1], 0, 0, m[2], m[3], 0, 0, 0, 0, 1, 0, m[4], m[5], 0, 1]);
const point = (m, x, y) => [(m[0] * x) + (m[4] * y) + m[12], (m[1] * x) + (m[5] * y) + m[13]];
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
            this.setState(state.id, state.effects, state.clip, state.matrix, false);
        }
        for (const id of this.states.keys()) {
            if (!ids.has(id)) this.states.delete(id);
        }
        this._updateActive();
    }

    setState (id, effects, clip, matrix, update = true) {
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
        const state = {id,
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
        this.active = Array.from(this.states.values()).some(state => state.enabledEffects || state.clip);
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

    isPointClipped (id, position) {
        for (const path of this.paths(id)) {
            const state = this.states.get(path);
            if (!state || !state.clip) continue;
            const m = state.inverse;
            const x = (m[0] * position[0]) + (m[4] * position[1]) + m[12];
            const y = (m[1] * position[0]) + (m[5] * position[1]) + m[13];
            const c = state.clip;
            if (x < c.left || x > c.right || y < c.bottom || y > c.top) return true;
        }
        return false;
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
        const root = Object.assign({children: []}, buffers());
        const nodes = new Map();
        for (const id of ids) {
            let parent = root;
            for (const path of this.paths(id)) {
                const state = this.states.get(path);
                if (!state || (!(state.enabledEffects & (logical ? COLOR_EFFECTS : ~0)) && !state.clip)) continue;
                let node = nodes.get(path);
                if (!node) {
                    node = Object.assign({state, children: []}, buffers());
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
        if (!this.paths(id).some(path => this.states.get(path) && this.states.get(path).clip)) return bounds;
        let polygon = corners(bounds);
        for (const path of this.paths(id)) {
            const state = this.states.get(path);
            if (!state || !state.clip) continue;
            polygon = polygon.map(p => point(state.inverse, p[0], p[1]));
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
            polygon = polygon.map(p => point(state.world, p[0], p[1]));
        }
        const result = new Rectangle();
        if (polygon.length) {
            result.initFromPointsAABB(polygon);
        } else result.initFromBounds(0, 0, 0, 0);
        return result;
    }

    _prepare (node, opts) {
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
        for (const child of node.children) points.push(...this._prepare(child, opts));
        if (!node.state || !points.length) return points;
        const bounds = new Rectangle();
        bounds.initFromPointsAABB(points.map(p => point(node.state.inverse, p[0], p[1])));
        if (node.state.clip) {
            // An explicit clip is also a stable effect frame in container-local Scratch units.
            Object.assign(bounds, node.state.clip);
        }
        node.bounds = bounds;
        return corners(bounds).map(p => point(node.state.world, p[0], p[1]));
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
        const tree = this.tree(ids, false, Boolean(opts.containerSensing));
        this._prepare(tree, opts);
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
            u_skin: surface.attachments[0],
            u_skinSize: [bounds.width, bounds.height],
            u_clipPlane: [0, 0, 1],
            u_projectionMatrix: projection,
            u_modelMatrix: model
        }, opts.extraUniforms));
        twgl.drawBufferInfo(gl, this.buffer, gl.TRIANGLES);
        r._regionId = null;
    }
}

module.exports = ContainerCompositor;
