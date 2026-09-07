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

const MAX_BRANCH_LOGS = 24;
const MAX_BRANCH_REACH = 4;

function touchesLeaf(dimension, location) {
	for (let dx = -1; dx <= 1; dx++) {
		for (let dy = -1; dy <= 1; dy++) {
			for (let dz = -1; dz <= 1; dz++) {
				if (dx === 0 && dy === 0 && dz === 0) continue;
				if (isLeafBlock(dimension.getBlock({ x: location.x + dx, y: location.y + dy, z: location.z + dz }))) {
					return true;
				}
			}
		}
	}
	return false;
}

function withinReachOfTrunk(location, trunk) {
	return trunk.some((log) =>
		Math.abs(log.x - location.x) <= MAX_BRANCH_REACH &&
		Math.abs(log.y - location.y) <= MAX_BRANCH_REACH &&
		Math.abs(log.z - location.z) <= MAX_BRANCH_REACH
	);
}

// Natural branches (acacia, jungle, dark oak, ...) sit diagonally off the
// trunk, so the vertical walk above never reaches them. This grows outward
// through connected logs - a bend in a branch often touches only other
// logs, not leaves, so requiring every single step to touch a leaf cuts
// branches off mid-air. Instead this stays safe two other ways: it never
// wanders more than a few blocks from the trunk, and it throws the whole
// result away unless something in it actually touches a leaf - a built
// wall or tower near a tree essentially never does.
function collectBranchLogs(dimension, trunk) {
	const visited = new Set(trunk.map((location) => `${location.x},${location.y},${location.z}`));
	const branches = [];
	const queue = [...trunk];
	let foundLeaf = false;
	while (queue.length > 0 && branches.length < MAX_BRANCH_LOGS) {
		const current = queue.shift();
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				for (let dz = -1; dz <= 1; dz++) {
					if (dx === 0 && dy === 0 && dz === 0) continue;
					const next = { x: current.x + dx, y: current.y + dy, z: current.z + dz };
					const key = `${next.x},${next.y},${next.z}`;
					if (visited.has(key)) continue;
					visited.add(key);
					if (!withinReachOfTrunk(next, trunk)) continue;
					if (!isFellableLog(dimension.getBlock(next))) continue;
					if (touchesLeaf(dimension, next)) foundLeaf = true;
					branches.push(next);
					queue.push(next);
				}
			}
		}
	}
	return foundLeaf ? branches : [];
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
	const logs = trunk.concat(collectBranchLogs(dimension, trunk));
	event.cancel = true;
	system.run(() => {
		// Paroida: the tree screams the instant it starts to fall.
		dimension.playSound("hako.tree_scream", event.block.location, { volume: 1, pitch: 1 });
		for (const location of logs) {
			dimension.runCommand(`setblock ${location.x} ${location.y} ${location.z} air destroy`);
		}
		damageToolForFelling(event.player, logs.length);
	});
});
