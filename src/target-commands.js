const {atomicWrite} = require('./project');
const edits = ['project', 'target', 'out', 'force'];
const specs = require('./command-catalog').moduleSpecs['target-commands.js'];
const number = value => {
  if (value === '' || !Number.isFinite(Number(value))) throw new Error('Expected finite number');
  return Number(value);
};
const folder = value => {
  if (typeof value !== 'string' || !value || value.includes('//') || /[\r\n\0]/.test(value)) throw new Error('Folder name must be non-empty and must not contain // or control characters');
  return value;
};
const filenamePart = name => name.includes('//') ? name.slice(name.indexOf('//') + 2) : name;
const execute = async (session, command, args, options) => {
  const [action, a, b] = args;
  const vm = session.project.vm;
  if (action === 'list') return session.project.info().targets;
  if (action === 'find') return session.project.info().targets.filter(target => target.name.toLowerCase().includes(a.toLowerCase()));
  if (action === 'reorder') {
    const from = session.project.target(a); if (from.isStage) throw new Error('The stage must stay at project index zero');
    const sprites = vm.runtime.targets.filter(target => target.isOriginal && !target.isStage);
    const position = number(b);
    if (!Number.isInteger(position) || position < 0 || position >= sprites.length) throw new Error('Sprite order index is 0-based and must be in range');
    const without = sprites.filter(target => target !== from); without.splice(position, 0, from);
    // reorderTarget edits the sprite-pane order only, not the renderer draw list.
    for (let index = 0; index < without.length; index++) {
      vm.reorderTarget(vm.runtime.targets.indexOf(without[index]), index + 1);
    }
    return {order: without.map(target => ({id: target.id, name: target.getName()}))};
  }
  if (action === 'folder-rename' || action === 'folder-remove-all') {
    const prefix = folder(a) + '//'; if (action === 'folder-rename') folder(b);
    const targets = vm.runtime.targets.filter(target => target.isOriginal && !target.isStage && target.getName().startsWith(prefix));
    for (const target of targets) vm.renameSprite(target.id, action === 'folder-rename' ? b + '//' + filenamePart(target.getName()) : filenamePart(target.getName()));
    return {updated: targets.map(target => target.getName())};
  }
  const target = session.project.target(options.target);
  if (action === 'info') return {...session.project.info().targets.find(item => item.id === target.id),
    draggable: target.draggable, layerOrder: target.getLayerOrder(), effects: {...target.effects}, rotationStyle: target.rotationStyle};
  if (action === 'export') return atomicWrite(a, Buffer.from(await vm.exportSprite(target.id, 'nodebuffer')), options.force);
  if (action === 'layer') {
    if (target.isStage) throw new Error('Stage layer cannot be moved');
    const position = number(a);
    if (!Number.isInteger(position)) throw new Error('Layer must be an integer');
    session.project.renderer.setDrawableOrder(target.drawableID, position,
      require('scratch-vm/src/engine/stage-layering').SPRITE_LAYER, false);
    vm.runtime.setExecutablePosition(target, position);
  } else if (action === 'draggable') {
    if (!['true', 'false', 'on', 'off'].includes(a)) throw new Error('Draggable must be true/false');
    target.setDraggable(a === 'true' || a === 'on');
  } else if (action === 'effect') {
    if (!Object.hasOwn(target.effects, a)) throw new Error('Effect must be color/fisheye/whirl/pixelate/mosaic/brightness/ghost');
    target.setEffect(a, number(b));
  } else if (action === 'clear-effects') target.clearEffects();
  else if (action === 'folder-create' || action === 'folder-add') {
    if (target.isStage) throw new Error('Stage cannot be in a sprite folder');
    vm.renameSprite(target.id, folder(a) + '//' + filenamePart(target.getName()));
  } else if (action === 'folder-remove') {
    if (target.isStage) throw new Error('Stage cannot be in a sprite folder');
    vm.renameSprite(target.id, filenamePart(target.getName()));
  } else throw new Error('Unknown targets action');
  vm.runtime.emitProjectChanged();
  return {id: target.id, name: target.getName(), layerOrder: target.getLayerOrder(), effects: {...target.effects}, draggable: target.draggable};
};
module.exports = {specs, requiresProject: () => true, isReadOnly: (command, args) => ['list', 'info', 'find', 'export'].includes(args[0]), execute};
