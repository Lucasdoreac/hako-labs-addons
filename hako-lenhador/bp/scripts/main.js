import { world, system, ItemStack } from "@minecraft/server";

// Sneak-breaking, by what is in the hand:
//   anything    -> whole natural tree; felling is just how this world works,
//                  empty hand, sword, pickaxe or a stack of dirt all count
//   Marreta     -> whole tree AND whole built structure, fast, long reach
//   Brita       -> whole tree AND whole built structure too, but it carries no
//                  digger component (bare-hand speed) and a shorter reach
const TRUNK_LOGS = new Set([
	"minecraft:oak_log", "minecraft:spruce_log", "minecraft:birch_log",
	"minecraft:jungle_log", "minecraft:acacia_log", "minecraft:dark_oak_log",
	"minecraft:mangrove_log", "minecraft:cherry_log", "minecraft:pale_oak_log",
	"minecraft:poplar_log",
]);

// Bedrock's "wood" tag only covers oak/spruce/birch/jungle/acacia/dark_oak.
// cherry, pale_oak, mangrove, bamboo, poplar, crimson and warped planks are
// NOT tagged, which is why demolition silently did nothing on those builds.
// is_axe_item_destructible is a verified strict superset of "wood".
const DEMOLITION_TAG = "minecraft:is_axe_item_destructible";

// That tag also covers things a sledgehammer has no business eating.
const DEMOLITION_DENY = new Set([
	// containers - never drop somebody's storage into the world
	"minecraft:chest", "minecraft:trapped_chest", "minecraft:barrel",
	"minecraft:lectern", "minecraft:jukebox",
	// bees
	"minecraft:bee_nest", "minecraft:beehive",
	// plants and vines - stop the flood escaping into the jungle
	"minecraft:vine", "minecraft:glow_lichen", "minecraft:cocoa",
	"minecraft:bamboo", "minecraft:bamboo_sapling", "minecraft:big_dripleaf",
	"minecraft:chorus_flower", "minecraft:chorus_plant", "minecraft:mangrove_roots",
	// farms
	"minecraft:pumpkin", "minecraft:carved_pumpkin", "minecraft:lit_pumpkin",
	"minecraft:melon_block",
	// natural growth
	"minecraft:brown_mushroom_block", "minecraft:red_mushroom_block",
	"minecraft:mushroom_stem", "minecraft:creaking_heart",
]);

// Sized for the tallest vanilla growth: a 2x2 mega jungle/spruce is ~31 logs
// per column across 4 columns, so ~124 logs before branches. The old 24-log
// branch cap left the top half of every giant tree standing in mid-air.
const TRUNK_SEARCH_LIMIT = 64;
const MAX_BRANCH_LOGS = 256;
const MAX_BRANCH_REACH = 8;
const BRITA_ID = "hako:brita";
const BRITA_GRANTED = "hako:brita_given";
const BRITA_REACH = 96;
const DEFAULT_REACH = 96;

// How far each Marreta tier can chew through a structure in one swing.
const MARRETA_REACH = {
	"hako:marreta_madeira": 48,
	"hako:marreta_pedra": 96,
	"hako:marreta_cobre": 128,
	"hako:marreta_ferro": 160,
	"hako:marreta_ouro": 96,
	"hako:marreta_diamante": 256,
	"hako:marreta_netherite": 384,
};

// Temporary: lets us read from the server log exactly which block a failed
// sneak-break landed on, instead of guessing what the builds are made of.
const DIAGNOSTICS = false;

function log(message) {
	if (DIAGNOSTICS) console.warn(`[HAKO_LENHADOR] ${message}`);
}

function isTrunkLog(block) {
	return Boolean(block) && TRUNK_LOGS.has(block.typeId);
}

function isLeaf(block) {
	return Boolean(block) && block.typeId.endsWith("_leaves");
}

// Anything a Marreta or Brita is allowed to eat.
function isDemolishable(block) {
	if (!block) return false;
	const id = block.typeId;
	if (DEMOLITION_DENY.has(id)) return false;
	if (id.endsWith("_shelf")) return false; // 1.26 storage shelves hold items
	try {
		if (block.hasTag(DEMOLITION_TAG)) return true;
	} catch {
		// fall through - the id check below still stands
	}
	return TRUNK_LOGS.has(id);
}

function toolKind(itemStack) {
	const id = itemStack?.typeId;
	if (!id) return "any";
	if (id.startsWith("hako:marreta_")) return "marreta";
	if (id === BRITA_ID) return "brita";
	return "any";
}

function reachFor(itemStack) {
	return MARRETA_REACH[itemStack?.typeId] ?? DEFAULT_REACH;
}

// --- natural tree only (empty hand and vanilla axes) -------------------------

function findNaturalTrunk(dimension, baseLocation) {
	const trunk = [];
	for (let height = 0; height < TRUNK_SEARCH_LIMIT; height++) {
		const location = { x: baseLocation.x, y: baseLocation.y + height, z: baseLocation.z };
		const block = dimension.getBlock(location);
		if (!isTrunkLog(block)) break;
		trunk.push(location);
	}
	if (trunk.length < 3) return [];
	const top = trunk[trunk.length - 1];
	for (let dx = -2; dx <= 2; dx++) {
		for (let dy = -1; dy <= 3; dy++) {
			for (let dz = -2; dz <= 2; dz++) {
				if (isLeaf(dimension.getBlock({ x: top.x + dx, y: top.y + dy, z: top.z + dz }))) return trunk;
			}
		}
	}
	return [];
}

function touchesLeaf(dimension, location) {
	for (let dx = -1; dx <= 1; dx++) {
		for (let dy = -1; dy <= 1; dy++) {
			for (let dz = -1; dz <= 1; dz++) {
				if (dx === 0 && dy === 0 && dz === 0) continue;
				if (isLeaf(dimension.getBlock({ x: location.x + dx, y: location.y + dy, z: location.z + dz }))) return true;
			}
		}
	}
	return false;
}

// Every branch log must itself touch a leaf. Stricter than the demolition
// flood on purpose: a player's log wall never qualifies, which is what keeps
// the empty hand and the vanilla axe safe around builds.
function collectBranchLogs(dimension, trunk) {
	const visited = new Set(trunk.map((l) => `${l.x},${l.y},${l.z}`));
	const branches = [];
	const queue = [...trunk];
	// The trunk is one straight column, so its bounds are exact.
	const base = trunk[0];
	const minY = base.y - MAX_BRANCH_REACH;
	const maxY = trunk[trunk.length - 1].y + MAX_BRANCH_REACH;
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
					if (Math.abs(base.x - next.x) > MAX_BRANCH_REACH) continue;
					if (Math.abs(base.z - next.z) > MAX_BRANCH_REACH) continue;
					if (next.y < minY || next.y > maxY) continue;
					if (!isTrunkLog(dimension.getBlock(next))) continue;
					// A mega tree's other three trunk columns only touch leaves
					// near the crown; without this their bare lower halves were
					// left standing. Straight down from an accepted log is the
					// one direction a canopy can be followed to the ground.
					const descending = dx === 0 && dz === 0 && dy === -1;
					if (!descending && !touchesLeaf(dimension, next)) continue;
					branches.push(next);
					queue.push(next);
				}
			}
		}
	}
	return branches;
}

function fellTree(dimension, origin) {
	const trunk = findNaturalTrunk(dimension, origin);
	if (trunk.length === 0) return [];
	return trunk.concat(collectBranchLogs(dimension, trunk));
}

// --- built structures (Marreta / Brita) --------------------------------------

function collectMass(dimension, origin, cap) {
	const visited = new Set([`${origin.x},${origin.y},${origin.z}`]);
	const found = [origin];
	const queue = [origin];
	while (queue.length > 0 && found.length < cap) {
		const current = queue.shift();
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				for (let dz = -1; dz <= 1; dz++) {
					if (dx === 0 && dy === 0 && dz === 0) continue;
					const next = { x: current.x + dx, y: current.y + dy, z: current.z + dz };
					const key = `${next.x},${next.y},${next.z}`;
					if (visited.has(key)) continue;
					visited.add(key);
					if (!isDemolishable(dimension.getBlock(next))) continue;
					found.push(next);
					queue.push(next);
					if (found.length >= cap) return found;
				}
			}
		}
	}
	return found;
}

// --- shared ------------------------------------------------------------------

function unbreakingSkipsDamage(tool) {
	const level = tool.getComponent("enchantable")?.getEnchantment("unbreaking")?.level ?? 0;
	return level > 0 && Math.random() < 1 / (level + 1);
}

function damageTool(player, amount) {
	const inventory = player.getComponent("inventory")?.container;
	const tool = inventory?.getItem(player.selectedSlotIndex);
	const durability = tool?.getComponent("minecraft:durability");
	if (!inventory || !tool || !durability) return;
	if (unbreakingSkipsDamage(tool)) return;
	const next = durability.damage + amount;
	if (next >= durability.maxDurability) {
		player.playSound("random.break", { volume: 1 });
		inventory.setItem(player.selectedSlotIndex, undefined);
		return;
	}
	durability.damage = next;
	inventory.setItem(player.selectedSlotIndex, tool);
}

world.beforeEvents.playerBreakBlock.subscribe((event) => {
	const player = event.player;
	if (!player?.isSneaking) return;
	const kind = toolKind(event.itemStack);

	const dimension = event.block.dimension;
	const origin = event.block.location;
	const blockId = event.block.typeId;
	let targets = [];
	let mode = "";

	if (kind === "any") {
		// Whatever is in the hand - or nothing at all - fells a natural tree.
		// Still trees only: a built log wall never passes findNaturalTrunk.
		if (!isTrunkLog(event.block)) return;
		targets = fellTree(dimension, origin);
		if (targets.length === 0) return;
		mode = "tree";
	} else {
		// Marreta and Brita both: a natural tree falls as a tree, anything
		// else connected and wooden gets demolished. Felling is universal in
		// this world - holding the Brita must never take that away.
		if (!isDemolishable(event.block)) {
			log(`${kind} refused block=${blockId} reason=not-demolishable`);
			return;
		}
		if (isTrunkLog(event.block)) {
			targets = fellTree(dimension, origin);
			if (targets.length > 0) mode = "tree";
		}
		if (targets.length === 0) {
			// The Brita carries no digger component, so it already mines at
			// bare-hand speed; its smaller reach is what separates it from a
			// crafted Marreta.
			const reach = kind === "brita" ? BRITA_REACH : reachFor(event.itemStack);
			targets = collectMass(dimension, origin, reach);
			if (targets.length < 2) {
				log(`${kind} found only ${targets.length} block=${blockId}`);
				return;
			}
			mode = "demo";
		}
	}

	log(`${mode} kind=${kind} block=${blockId} blocks=${targets.length}`);

	event.cancel = true;
	system.run(() => {
		for (const location of targets) {
			dimension.runCommand(`setblock ${location.x} ${location.y} ${location.z} air destroy`);
		}
		// Felling costs a point per log, as vanilla-ish as it gets. Demolition
		// would shatter the lower tiers instantly at that rate, so it is
		// quartered - the reach cap is what limits the cheap Marretas.
		damageTool(player, mode === "tree" ? targets.length : Math.ceil(targets.length / 4));
	});
});

// Every player starts with one Brita; the flag keeps it to a single grant so
// it is not handed out again every time they respawn.
world.afterEvents.playerSpawn.subscribe((event) => {
	if (!event.initialSpawn) return;
	const player = event.player;
	if (!player?.isValid) return;
	if (player.getDynamicProperty(BRITA_GRANTED)) return;
	system.run(() => {
		try {
			player.getComponent("inventory")?.container?.addItem(new ItemStack(BRITA_ID, 1));
			player.setDynamicProperty(BRITA_GRANTED, true);
		} catch {
			// inventory full or item unavailable - try again on the next join
		}
	});
});
