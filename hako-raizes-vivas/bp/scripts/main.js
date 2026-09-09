import { world, system } from "@minecraft/server";

const SEGMENT_ID = "hako:raiz_segmento";
const CORE_ID = "hako:raiz_nucleo";
const CORE_PROPERTY = "hako:core_id";
const INITIAL_SEGMENTS = 4;
const REGROWTH_PER_CUT = 2;
const SPAWN_RING_RADIUS = 2;
const REGROWTH_SEARCH_RADIUS = 1.5;
const GLITCH_SOUND = "hako.raiz_glitch";
const NEARBY_PLAYER_RADIUS = 16;

// Only these damage causes actually end a segment. Anything else (sword,
// arrow, punch, fall, whatever) just prunes it - the regrowth rule below
// turns that into two new segments instead.
const FIRE_CAUSES = new Set(["fire", "fireTick", "lava", "campfire", "soulCampfire"]);

function ringLocation(center, index, count, radius) {
	const angle = (index / count) * Math.PI * 2;
	return {
		x: center.x + Math.cos(angle) * radius,
		y: center.y,
		z: center.z + Math.sin(angle) * radius,
	};
}

function nearbyPlayers(dimension, location, radius) {
	return dimension.getPlayers({ location, maxDistance: radius });
}

function playGlitch(dimension, location) {
	for (const player of nearbyPlayers(dimension, location, NEARBY_PLAYER_RADIUS)) {
		player.playSound(GLITCH_SOUND, { volume: 1, pitch: 0.9 + Math.random() * 0.3 });
		dimension.runCommand(`camerashake add "${player.name}" 0.4 0.6 positional`);
		dimension.runCommand(`title "${player.name}" actionbar §k§4RAIZ§r`);
	}
}

function playCoreDefeated(dimension, location) {
	for (const player of nearbyPlayers(dimension, location, NEARBY_PLAYER_RADIUS)) {
		player.playSound(GLITCH_SOUND, { volume: 1, pitch: 0.6 });
		dimension.runCommand(`camerashake add "${player.name}" 0.6 0.8 positional`);
		dimension.runCommand(`title "${player.name}" actionbar §k§2NUCLEO DESTRUIDO§r`);
	}
}

// A freshly summoned nucleo grows its first ring of segments, each tagged
// with the nucleo's own entity id so later regrowth checks know which core
// they belong to.
world.afterEvents.entitySpawn.subscribe((event) => {
	const entity = event.entity;
	if (!entity?.isValid() || entity.typeId !== CORE_ID) return;
	const coreId = entity.id;
	const dimension = entity.dimension;
	const center = entity.location;
	system.run(() => {
		for (let i = 0; i < INITIAL_SEGMENTS; i++) {
			const location = ringLocation(center, i, INITIAL_SEGMENTS, SPAWN_RING_RADIUS);
			const segment = dimension.spawnEntity(SEGMENT_ID, location);
			segment.setProperty(CORE_PROPERTY, coreId);
		}
	});
});

world.afterEvents.entityDie.subscribe((event) => {
	const dead = event.deadEntity;
	if (!dead) return;

	if (dead.typeId === CORE_ID) {
		const dimension = dead.dimension;
		const location = dead.location;
		system.run(() => playCoreDefeated(dimension, location));
		return;
	}

	if (dead.typeId !== SEGMENT_ID) return;
	const cause = event.damageSource?.cause;
	if (cause && FIRE_CAUSES.has(cause)) return; // real kill, no regrowth

	const coreId = dead.getProperty(CORE_PROPERTY);
	const dimension = dead.dimension;
	const location = dead.location;
	if (!coreId) return;

	system.run(() => {
		const coreAlive = dimension
			.getEntities({ type: CORE_ID, location, maxDistance: 64 })
			.some((core) => core.id === coreId);
		if (!coreAlive) return;

		for (let i = 0; i < REGROWTH_PER_CUT; i++) {
			const spot = ringLocation(location, i, REGROWTH_PER_CUT, REGROWTH_SEARCH_RADIUS);
			const segment = dimension.spawnEntity(SEGMENT_ID, spot);
			segment.setProperty(CORE_PROPERTY, coreId);
		}
		playGlitch(dimension, location);
	});
});
