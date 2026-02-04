"use strict";

import {
	getColorForDistanceAndToken,
	getMovedDistanceFromToken,
	getRangesFromSpeedProvider,
	initApi,
	registerModule,
	registerSystem,
} from "./api.js";
import {checkDependencies} from "./compatibility.js";
import {moveEntities, onMouseMove} from "./foundry_imports.js";
import {disableSnap, registerKeybindings} from "./keybindings.js";
import {libWrapper} from "./libwrapper_shim.js";
import {performMigrations} from "./migration.js";
import {removeLastHistoryEntryIfAt, resetMovementHistory} from "./movement_tracking.js";
import {extendRuler} from "./ruler.js";
import {registerSettings, RightClickAction, settingsKey} from "./settings.js";
import {recalculate} from "./socket.js";
import {SpeedProvider} from "./speed_provider.js";
import {getEntityCenter, setSnapParameterOnOptions} from "./util.js";

// Get reference to the Ruler class for v13
const Ruler = foundry.canvas.interaction.Ruler;

CONFIG.debug.dragRuler = false;
export let debugGraphics = undefined;

Hooks.once("init", () => {
	registerSettings();
	registerKeybindings();
	initApi();
	// Don't hook drag handlers - let Foundry handle waypoints natively
	// hookDragHandlers(Token);
	// hookDragHandlers(MeasuredTemplate);
	libWrapper.register(
		"drag-ruler-modern",
		"TokenLayer.prototype.undoHistory",
		tokenLayerUndoHistory,
		"WRAPPER",
	);

	extendRuler();

	window.dragRuler = {
		getRangesFromSpeedProvider,
		getColorForDistanceAndToken,
		getMovedDistanceFromToken,
		registerModule,
		registerSystem,
		recalculate,
		resetMovementHistory,
	};
});

Hooks.once("ready", () => {
	performMigrations();
	checkDependencies();
	Hooks.callAll("dragRuler.ready", SpeedProvider);
	if (CONFIG.debug.dragRuler) debugGraphics = canvas.controls.addChild(new PIXI.Container());
});

// Canvas ready hook is now handled in ruler.js via the extendRuler function

Hooks.on("getCombatTrackerEntryContext", function (html, menu) {
	const entry = {
		name: "drag-ruler.resetMovementHistory",
		icon: '<i class="fas fa-undo-alt"></i>',
		callback: li => resetMovementHistory(ui.combat.viewed, li.data("combatant-id")),
	};
	menu.splice(1, 0, entry);
});

function forwardIfUnahndled(newFn) {
	return function (oldFn, ...args) {
		const eventHandled = newFn(...args);
		if (!eventHandled) oldFn(...args);
	};
}

function hookDragHandlers(entityType) {
	const entityName = entityType.name;
	libWrapper.register(
		"drag-ruler-modern",
		`${entityName}.prototype._onDragLeftStart`,
		onEntityLeftDragStart,
		"WRAPPER",
	);
	if (entityType === Token)
		libWrapper.register(
			"drag-ruler-modern",
			`${entityName}.prototype._onDragLeftMove`,
			onEntityLeftDragMoveSnap,
			"WRAPPER",
		);
	else
		libWrapper.register(
			"drag-ruler-modern",
			`${entityName}.prototype._onDragLeftMove`,
			onEntityLeftDragMove,
			"WRAPPER",
		);
	libWrapper.register(
		"drag-ruler-modern",
		`${entityName}.prototype._onDragLeftDrop`,
		forwardIfUnahndled(onEntityDragLeftDrop),
		"MIXED",
	);
	libWrapper.register(
		"drag-ruler-modern",
		`${entityName}.prototype._onDragLeftCancel`,
		forwardIfUnahndled(onEntityDragLeftCancel),
		"MIXED",
	);
}

async function tokenLayerUndoHistory(wrapped) {
	const historyEntry = this.history[this.history.length - 1];
	const returnValue = await wrapped();
	if (historyEntry.type === "update") {
		for (const entry of historyEntry.data) {
			const token = canvas.tokens.get(entry._id);
			removeLastHistoryEntryIfAt(token, entry.x, entry.y);
		}
	}
	return returnValue;
}

function onEntityLeftDragStart(wrapped, event) {
	wrapped(event);
	const isToken = this instanceof Token;
	// In v13, tokens have their own TokenRuler instance
	const ruler = isToken ? this.ruler : canvas.controls.ruler;
	if (!ruler) {
		console.warn("drag-ruler: Ruler not available after drag start");
		return;
	}
	
	ruler.draggedEntity = this;
	const entityCenter = getEntityCenter(this);
	ruler.rulerOffset = {
		x: entityCenter.x - event.interactionData.origin.x,
		y: entityCenter.y - event.interactionData.origin.y,
	};
	if (game.settings.get(settingsKey, "autoStartMeasurement")) {
		let options = {};
		setSnapParameterOnOptions(ruler, options);
		ruler.dragRulerStart(options, false);
	}
}

function onEntityLeftDragMoveSnap(wrapped, event) {
	applyGridlessSnapping.call(this, event);
	onEntityLeftDragMove.call(this, wrapped, event);
}

function onEntityLeftDragMove(wrapped, event) {
	wrapped(event);
	const isToken = this instanceof Token;
	const ruler = isToken ? this.ruler : canvas.controls.ruler;
	if (ruler?.isDragRuler) onMouseMove.call(ruler, event);
}

function onEntityDragLeftDrop(event) {
	const isToken = this instanceof Token;
	const ruler = isToken ? this.ruler : canvas.controls.ruler;
	if (!ruler?.isDragRuler) {
		if (ruler) ruler.draggedEntity = undefined;
		return false;
	}
	// When we're dragging a measured template no token will ever be selected,
	// resulting in only the dragged template to be moved as would be expected
	const selectedTokens = canvas.tokens.controlled;
	// This can happen if the user presses ESC during drag (maybe there are other ways too)
	if (selectedTokens.length === 0) selectedTokens.push(ruler.draggedEntity);
	moveEntities.call(ruler, ruler.draggedEntity, selectedTokens);
	return true;
}

function onEntityDragLeftCancel(event) {
	// This function is invoked by right clicking
	const isToken = this instanceof Token;
	const ruler = isToken ? this.ruler : canvas.controls.ruler;
	if (!ruler?.draggedEntity) return false;

	const rightClickAction = game.settings.get(settingsKey, "rightClickAction");
	let options = {};
	setSnapParameterOnOptions(ruler, options);

	// If ruler not yet started, start it
	if (!ruler.waypoints || ruler.waypoints.length === 0) {
		if (rightClickAction !== RightClickAction.CREATE_WAYPOINT) return false;
		ruler.dragRulerStart(options);
		event.preventDefault();
	} else {
		switch (rightClickAction) {
			case RightClickAction.CREATE_WAYPOINT:
				event.preventDefault();
				ruler.dragRulerAddWaypoint(ruler.destination, options);
				break;
			case RightClickAction.DELETE_WAYPOINT:
				ruler.dragRulerDeleteWaypoint(event, options);
				break;
			case RightClickAction.ABORT_DRAG:
				ruler.dragRulerAbortDrag();
				break;
		}
	}
	return true;
}

function applyGridlessSnapping(event) {
	const isToken = this instanceof Token;
	const ruler = isToken ? this.ruler : canvas.controls.ruler;
	if (!game.settings.get(settingsKey, "useGridlessRaster")) return;
	if (!ruler?.isDragRuler) return;
	if (disableSnap) return;
	if (canvas.grid.type !== CONST.GRID_TYPES.GRIDLESS) return;

	const rasterWidth = 35 / canvas.stage.scale.x;
	const tokenX = event.interactionData.destination.x;
	const tokenY = event.interactionData.destination.y;
	const destination = {x: tokenX + ruler.rulerOffset.x, y: tokenY + ruler.rulerOffset.y};
	const ranges = getRangesFromSpeedProvider(ruler.draggedEntity);

	const terrainRulerAvailable = game.modules.get("terrain-ruler")?.active;
	if (terrainRulerAvailable) {
		const segments = ruler.constructor
			.dragRulerGetRaysFromWaypoints(ruler.waypoints, destination)
			.map(ray => {
				return {ray};
			});
		const pinpointDistances = new Map();
		for (const range of ranges) {
			pinpointDistances.set(range.range, null);
		}
		terrainRuler.measureDistances(segments, {pinpointDistances});
		const targetDistance = Array.from(pinpointDistances.entries())
			.filter(([_key, val]) => val)
			.reduce((value, current) => (value[0] > current[0] ? value : current), [0, null]);
		const rasterLocation = targetDistance[1];
		if (rasterLocation) {
			const deltaX = destination.x - rasterLocation.x;
			const deltaY = destination.y - rasterLocation.y;
			const rasterDistance = Math.hypot(deltaX, deltaY);
			if (rasterDistance < rasterWidth) {
				event.interactionData.destination.x = rasterLocation.x - ruler.rulerOffset.x;
				event.interactionData.destination.y = rasterLocation.y - ruler.rulerOffset.y;
			}
		}
	} else {
		let waypointDistance = 0;
		let origin = event.interactionData.origin;
		if (ruler.waypoints.length > 1) {
			const segments = ruler.constructor
				.dragRulerGetRaysFromWaypoints(ruler.waypoints, destination)
				.map(ray => {
					return {ray};
				});
			origin = segments.pop().ray.A;
			waypointDistance = canvas.grid.measureDistances(segments).reduce((a, b) => a + b);
			origin = {x: origin.x - ruler.rulerOffset.x, y: origin.y - ruler.rulerOffset.y};
		}

		const deltaX = tokenX - origin.x;
		const deltaY = tokenY - origin.y;
		const distance = Math.hypot(deltaX, deltaY);
		// targetRange will be the largest range that's still smaller than distance
		let targetDistance = ranges
			.map(range => range.range)
			.map(range => range - waypointDistance)
			.map(range => (range * canvas.dimensions.size) / canvas.dimensions.distance)
			.filter(range => range < distance)
			.reduce((a, b) => Math.max(a, b), 0);
		if (targetDistance) {
			if (distance < targetDistance + rasterWidth) {
				event.interactionData.destination.x = origin.x + (deltaX * targetDistance) / distance;
				event.interactionData.destination.y = origin.y + (deltaY * targetDistance) / distance;
			}
		}
	}
}
