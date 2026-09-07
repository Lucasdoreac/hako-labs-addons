import { world, system } from "@minecraft/server";

// Only these are treated as a natural trunk. Anything else (planks, fences,
// a lone placed log with no leaves) is left alone and breaks normally.
const FELLABLE_LOGS = new Set([
	"minecraft:oak_log", "minecraft:spruce_log", "minecraft:birch_log",
	"minecraft:jungle_log", "minecraft:acacia_log", "minecraft:dark_oak_log",
	"minecraft:mangrove_log", "minecraft:cherry_log", "minecraft:pale_oak_log",
]);
const TRUNK_SEARCH_LIMIT = 32;

function isFellableLog(block) {
	return Boolean(block) && FELLABLE_LOGS.has(block.typeId);
}

function isLeafBlock(block) {
	return Boolean(block) && block.typeId.endsWith("_leaves");
}

// Walks straight up from the broken log. Stops at the first non-log block,
// then confirms a real tree by requiring leaves somewhere near the top -
// this is what keeps built structures (walls, beams, a single decorative
// log) from ever matching.
function findNaturalTrunk(dimension, baseLocation) {
	const trunk = [];
	for (let height = 0; height < TRUNK_SEARCH_LIMIT; height++) {
		const location = { x: baseLocation.x, y: baseLocation.y + height, z: baseLocation.z };
		const block = dimension.getBlock(location);
		if (!isFellableLog(block)) break;
		trunk.push(location);
	}
	if (trunk.length < 3) return [];
	const topLog = trunk[trunk.length - 1];
	for (let dx = -2; dx <= 2; dx++) {
		for (let dy = -1; dy <= 3; dy++) {
			for (let dz = -2; dz <= 2; dz++) {
				if (isLeafBlock(dimension.getBlock({ x: topLog.x + dx, y: topLog.y + dy, z: topLog.z + dz }))) {
					return trunk;
				}
			}
		}
	}
	return [];
}

// Vanilla Unbreaking: each level adds a 1/(level+1) chance to skip the
// durability hit entirely.
function unbreakingSkipsDamage(tool) {
	const level = tool.getComponent("enchantable")?.getEnchantment("unbreaking")?.level ?? 0;
	return level > 0 && Math.random() < 1 / (level + 1);
}

function damageToolForFelling(player, logsFelled) {
	const inventory = player.getComponent("inventory")?.container;
	const tool = inventory?.getItem(player.selectedSlotIndex);
	const durability = tool?.getComponent("minecraft:durability");
	if (!inventory || !tool || !durability) return;
	if (unbreakingSkipsDamage(tool)) return;
	const nextDamage = durability.damage + logsFelled;
	if (nextDamage >= durability.maxDurability) {
		player.playSound("random.break", { volume: 1 });
		inventory.setItem(player.selectedSlotIndex, undefined);
		return;
	}
	durability.damage = nextDamage;
	inventory.setItem(player.selectedSlotIndex, tool);
}

world.beforeEvents.playerBreakBlock.subscribe((event) => {
	if (!event.player.isSneaking || !isFellableLog(event.block)) return;
	const dimension = event.block.dimension;
	const trunk = findNaturalTrunk(dimension, event.block.location);
	if (trunk.length === 0) return;
	event.cancel = true;
	system.run(() => {
		for (const location of trunk) {
			dimension.runCommand(`setblock ${location.x} ${location.y} ${location.z} air destroy`);
		}
		damageToolForFelling(event.player, trunk.length);
	});
});
