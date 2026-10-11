'use strict';
// Run with: tw project exec scripts/project-edit-examples/move.js --project source.sb3 --out changed.sb3
module.exports = async project => {
  const read = await project.read({target: 'Sprite1'});
  const nodes = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.opcode === 'motion_movesteps') nodes.push(value);
    for (const child of Object.values(value)) visit(child);
  };
  visit(read.targets[0].scripts);
  if (nodes.length !== 1) throw new Error('Example expects exactly one motion_movesteps in Sprite1');
  await project.target('Sprite1').blocks.update(nodes[0].id, {inputs: {STEPS: 47}});
};
