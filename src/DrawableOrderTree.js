/**
 * Build an ordering tree from the current draw list. Containers and component
 * groups are atomic among siblings; ordinary folders do not appear here.
 * Container paths are supplied by the VM, from outermost to innermost.
 */
class DrawableOrderTree {
    constructor (drawList, groups, groupById, paths) {
        this.root = {children: []};
        this.containers = new Map();
        this.leaves = new Map();
        const seen = new Set();
        for (const id of drawList) {
            if (seen.has(id)) continue;
            const group = groups.get(groupById.get(id));
            const drawables = group ? group.drawables.slice() : [id];
            let parent = this.root;
            for (const path of paths.get(id) || []) {
                let node = this.containers.get(path);
                if (!node) {
                    node = {children: [], parent};
                    this.containers.set(path, node);
                    parent.children.push(node);
                }
                parent = node;
            }
            const leaf = {drawables, parent};
            parent.children.push(leaf);
            for (const member of drawables) {
                seen.add(member);
                this.leaves.set(member, leaf);
            }
        }
    }

    flatten (node = this.root) {
        return node.drawables || node.children.reduce((ids, child) => ids.concat(this.flatten(child)), []);
    }

    move (node, order, relative, minimum, start) {
        if (!node) return null;
        const ids = this.flatten();
        const first = this.flatten(node)[0];
        if (order === 0) return start + ids.indexOf(first);
        const siblings = node.parent.children;
        const oldIndex = siblings.indexOf(node);
        const parentStart = start + ids.indexOf(this.flatten(node.parent)[0]);
        siblings.splice(oldIndex, 1);
        let destination = 0;
        let offset = parentStart;
        if (relative) destination = Math.max(0, Math.min(siblings.length, oldIndex + Math.trunc(order)));
        else {
            while (destination < siblings.length && offset < order) {
                offset += this.flatten(siblings[destination++]).length;
            }
        }
        offset = parentStart;
        for (let i = 0; i < destination; i++) offset += this.flatten(siblings[i]).length;
        while (destination < siblings.length && offset < minimum) {
            offset += this.flatten(siblings[destination++]).length;
        }
        siblings.splice(destination, 0, node);
        return start + this.flatten().indexOf(first);
    }
}

module.exports = DrawableOrderTree;
