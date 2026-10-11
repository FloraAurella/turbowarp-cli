'use strict';
module.exports = async project => {
  const target = project.target('Sprite1');
  await target.procedures.update('advance', {newName: 'advance-fast', warp: true});
  const read = await target.read();
  const moves = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.opcode === 'motion_movesteps') moves.push(value);
    for (const child of Object.values(value)) visit(child);
  };
  visit(read.targets[0].scripts);
  if (moves.length !== 1) throw new Error('Example expects one movement block in the procedure');
  await target.blocks.update(moves[0].id, {inputs: {STEPS: 30}});
};
