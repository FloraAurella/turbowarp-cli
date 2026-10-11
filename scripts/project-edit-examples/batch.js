'use strict';
// All edits join the one outer transaction supplied by project exec.
module.exports = async project => {
  await project.batch(async edit => {
    for (const [name, value] of [['Sprite1', 31], ['Other', 57]]) {
      const read = await edit.read({target: name});
      const nodes = [];
      const visit = item => {
        if (!item || typeof item !== 'object') return;
        if (item.opcode === 'motion_movesteps') nodes.push(item);
        for (const child of Object.values(item)) visit(child);
      };
      visit(read.targets[0].scripts);
      if (nodes.length !== 1) throw new Error(`Example expects exactly one movement block in ${name}`);
      await edit.target(name).blocks.update(nodes[0].id, {inputs: {STEPS: value}});
    }
  });
};
