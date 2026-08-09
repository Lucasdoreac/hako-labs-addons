import { ScriptEventSource, system, world } from "@minecraft/server";

const PREFIX = "[HAKO_AGENT]";

function emit(event, fields = {}) {
  // Never emit XUID, coordinates, inventories, chat, command payloads or tokens.
  console.warn(PREFIX + JSON.stringify({ schema: 1, event, tick: system.currentTick, ...fields }));
}

function playerCount() {
  return world.getPlayers().length;
}

system.run(() => emit("ready", { players: playerCount() }));

world.afterEvents.playerSpawn.subscribe((event) => {
  if (event.initialSpawn) emit("player_join", { player: event.player.name, players: playerCount() });
});

world.afterEvents.playerLeave.subscribe((event) => {
  emit("player_leave", { player: event.playerName, players: playerCount() });
});

system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.id !== "hako:status") return;
  if (event.sourceType !== ScriptEventSource.Server) {
    emit("request_rejected", { operation: "status", reason: "source_not_server" });
    return;
  }
  emit("status", { players: playerCount() });
});

system.runInterval(() => emit("heartbeat", { players: playerCount() }), 6000);
