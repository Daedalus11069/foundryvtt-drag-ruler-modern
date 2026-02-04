import {
	currentSpeedProvider,
	getColorForDistanceAndToken,
	getRangesFromSpeedProvider,
} from "./api.js";
import {highlightMeasurementTerrainRuler, measureDistances} from "./compatibility.js";
import {getGridPositionFromPixelsObj, getPixelsFromGridPositionObj} from "./foundry_fixes.js";
import {cancelScheduledMeasurement, highlightMeasurementNative} from "./foundry_imports.js";
import {disableSnap} from "./keybindings.js";
import {libWrapper} from "./libwrapper_shim.js";
import {getMovementHistory} from "./movement_tracking.js";
import {settingsKey} from "./settings.js";
import {
	applyTokenSizeOffset,
	getSnapPointForEntity,
	getSnapPointForTokenObj,
	getEntityCenter,
	getTokenShape,
	isPathfindingEnabled,
} from "./util.js";
import {getPointer} from "./util.js";

// Get reference to the Ruler class for v13
const Ruler = foundry.canvas.interaction.Ruler;

export function extendRuler() {
	// In Foundry v13+, we use libWrapper to extend the ruler functionality
	// instead of replacing CONFIG.Canvas.rulerClass
	
	// Get references to the ruler prototypes
	const BaseRulerProto = Ruler.prototype;
	const TokenRulerProto = foundry.canvas.placeables.tokens.TokenRuler.prototype;
	
	// Initialize drag ruler state on any ruler instance
	function initDragRulerState(ruler) {
		if (ruler._dragRulerInitialized) return;
		ruler._dragRulerInitialized = true;
		
		// Just store the ranges for color calculation
		ruler.dragRulerRanges = undefined;
	}
	
	// Wrap _getSegmentStyle for both ruler types to apply colors
	libWrapper.register(
		"drag-ruler-modern",
		"foundry.canvas.interaction.Ruler.prototype._getSegmentStyle",
		function (wrapped, waypoint) {
			initDragRulerState(this);
			const style = wrapped.call(this, waypoint) || {width: 6};
			
			// Apply colors if we have a token to measure from
			if (this.draggedEntity || this.token) {
				try {
					const dist = waypoint?.measurement?.distance ?? 0;
					const color = this.dragRulerGetColorForDistance(dist);
					if (color && color !== this.color) {
						style.color = color;
						style.alpha = 1.0;
					}
				} catch (e) {
					console.error("drag-ruler: Error in Ruler _getSegmentStyle", e);
				}
			}
			
			return style;
		},
		"WRAPPER",
	);
	
	libWrapper.register(
		"drag-ruler-modern",
		"foundry.canvas.placeables.tokens.TokenRuler.prototype._getSegmentStyle",
		function (wrapped, waypoint) {
			initDragRulerState(this);
			const style = wrapped.call(this, waypoint) || {width: 6};
			
			// TokenRuler is only used during token drag, always apply colors
			try {
				const dist = waypoint?.measurement?.distance ?? 0;
				const color = this.dragRulerGetColorForDistance(dist);
				if (color && color !== this.color) {
					style.color = color;
					style.alpha = 1.0;
				}
			} catch (e) {
				console.error("drag-ruler: Error in TokenRuler _getSegmentStyle", e);
			}
			
			return style;
		},
		"WRAPPER",
	);
	
	// Wrap _getGridHighlightStyle for token rulers
	libWrapper.register(
		"drag-ruler-modern",
		"foundry.canvas.placeables.tokens.TokenRuler.prototype._getGridHighlightStyle",
		function (wrapped, waypoint, offset) {
			initDragRulerState(this);
			const style = wrapped.call(this, waypoint, offset) || {};
			
			try {
				const dist = waypoint?.measurement?.distance ?? 0;
				const color = this.dragRulerGetColorForDistance(dist);
				if (color && color !== this.color) {
					style.color = color;
					style.alpha = 0.35;
				}
			} catch (e) {
				console.error("drag-ruler: Error in TokenRuler _getGridHighlightStyle", e);
			}
			
			return style;
		},
		"WRAPPER",
	);
	
	// Wrap clear method to reset drag ruler state
	[BaseRulerProto, TokenRulerProto].forEach((proto, index) => {
		const className = index === 0 ? "foundry.canvas.interaction.Ruler" : "foundry.canvas.placeables.tokens.TokenRuler";
		libWrapper.register(
			"drag-ruler-modern",
			`${className}.prototype.clear`,
			function (wrapped) {
				const result = wrapped();
				this.previousWaypoints = [];
				if (this.previousLabels) {
					this.previousLabels.removeChildren().forEach(c => c.destroy());
				}
				this.dragRulerRanges = undefined;
				cancelScheduledMeasurement.call(this);
				return result;
			},
			"WRAPPER",
		);
	});
	
	// Add drag ruler methods to both prototypes
	[BaseRulerProto, TokenRulerProto].forEach(proto => {
		// Get color for distance based on speed ranges
		proto.dragRulerGetColorForDistance = function (distance) {
			const token = this.token;  // In v13, TokenRuler has this.token set by Foundry
			if (!token?.actor) return this.color;
			
			// Don't apply colors if the current user doesn't have at least observer permissions
			if (token.actor.permission < 2) {
				// If this is a pc and alwaysShowSpeedForPCs is enabled we show the color anyway
				if (
					!(
						token.actor.type === "character" &&
						game.settings.get(settingsKey, "alwaysShowSpeedForPCs")
					)
				)
					return this.color;
			}
			
			distance = Math.round(distance * 100) / 100;
			if (!this.dragRulerRanges) {
				this.dragRulerRanges = getRangesFromSpeedProvider(token);
			}
			
			return getColorForDistanceAndToken(distance, token, this.dragRulerRanges) ?? this.color;
		};
		
		proto.dragRulerAddWaypoint = function (point, options = {}) {
			if (!this.waypoints) this.waypoints = [];
			options.snap = options.snap ?? true;
			if (options.snap) {
				const entity = this.draggedEntity ?? this.token;
				point = getSnapPointForEntity(point.x, point.y, entity);
			}
			this.waypoints.push(new PIXI.Point(point.x, point.y));
			if (this.labels?.addChild) {
				this.labels.addChild(new PreciseText("", CONFIG.canvasTextStyle));
			}
			this.waypoints
				.filter(waypoint => waypoint.isPathfinding)
				.forEach(waypoint => (waypoint.isPathfinding = false));
		};
		
		proto.dragRulerAddWaypointHistory = function (waypoints) {		if (!waypoints || waypoints.length === 0) return;
		if (!this.waypoints) this.waypoints = [];			waypoints.forEach(waypoint => (waypoint.isPrevious = true));
			this.waypoints = this.waypoints.concat(waypoints);
			if (this.labels?.addChild) {
				for (const waypoint of waypoints) {
					this.labels.addChild(new PreciseText("", CONFIG.canvasTextStyle));
				}
			}
		};
		
		proto.dragRulerClearWaypoints = function () {
		if (!this.waypoints) this.waypoints = [];
		else this.waypoints.length = 0;
		if (this.labels?.removeChildren) {
			}
		};
		
		proto.dragRulerDeleteWaypoint = function (
			event = {
				preventDefault: () => {
					return;
				},
			},
			options = {},
		) {
			this.dragRulerRemovePathfindingWaypoints();
			options.snap = options.snap ?? true;
			if (this.waypoints.filter(w => !w.isPrevious).length > 1) {
				event.preventDefault();
				const mousePosition = getPointer().getLocalPosition(canvas.tokens);
				const rulerOffset = this.rulerOffset || {x: 0, y: 0};

				if (this._removeWaypoint) {
					this._removeWaypoint(
						{x: mousePosition.x + rulerOffset.x, y: mousePosition.y + rulerOffset.y},
						options,
					);
				}
				game.user.broadcastActivity({ruler: this});
			} else {
				this.dragRulerAbortDrag(event);
			}
		};
		
		proto.dragRulerRemovePathfindingWaypoints = function () {
			this.waypoints
				.filter(waypoint => waypoint.isPathfinding)
				.forEach(_ => {
					if (this.labels?.children?.length) {
						const lastLabel = this.labels.children[this.labels.children.length - 1];
						this.labels.removeChild(lastLabel);
						lastLabel.destroy?.();
					}
				});
			this.waypoints = this.waypoints.filter(waypoint => !waypoint.isPathfinding);
		};
		
		proto.dragRulerAbortDrag = function (
			event = {
				preventDefault: () => {
					return;
				},
			},
		) {
			const token = this.draggedEntity ?? this.token;
			if (!token) return;
			
			if (this._endMeasurement) this._endMeasurement();

			// Deactivate the drag workflow in mouse
			if (token.mouseInteractionManager) {
				token.mouseInteractionManager.cancel?.(event);
				if (token.mouseInteractionManager.states?.HOVER) {
					token.mouseInteractionManager.state = token.mouseInteractionManager.states.HOVER;
				}
			}

			// Cancel the current drag operation
			token._onDragLeftCancel?.(event);
		};
		
		proto.dragRulerRecalculate = async function (tokenIds) {
		if (!this.waypoints || this.waypoints.length === 0) return;
			const token = this.draggedEntity ?? this.token;
			if (tokenIds && !tokenIds.includes(token?.id)) return;
			
			const waypoints = this.waypoints.filter(waypoint => !waypoint.isPrevious);
			this.dragRulerClearWaypoints();
			
			if (game.settings.get(settingsKey, "enableMovementHistory")) {
				this.dragRulerAddWaypointHistory(getMovementHistory(token));
			}
			
			for (const waypoint of waypoints) {
				this.dragRulerAddWaypoint(waypoint, {snap: false});
			}
			
			if (this.measure) this.measure(this.destination);
			game.user.broadcastActivity({ruler: this});
		};
		
		proto.dragRulerStart = function (options, measureImmediately = true) {
			const entity = this.draggedEntity ?? this.token;
			if (!entity) return;
			
			const isToken = entity instanceof Token;
			if (isToken && !currentSpeedProvider.usesRuler(entity)) return;
			
			// Ensure waypoints array exists
			if (!this.waypoints) this.waypoints = [];
			
			const entityCenter = getEntityCenter(entity);
			if (isToken && game.settings.get(settingsKey, "enableMovementHistory")) {
				this.dragRulerAddWaypointHistory(getMovementHistory(entity));
			}
			this.dragRulerAddWaypoint(entityCenter, {snap: false});
			
			const mousePosition = getPointer().getLocalPosition(canvas.tokens);
			const rulerOffset = this.rulerOffset || {x: 0, y: 0};
			const destination = {
				x: mousePosition.x + rulerOffset.x,
				y: mousePosition.y + rulerOffset.y,
			};
			
			if (measureImmediately && this.measure) {
				this.measure(destination, options);
			}
		};
		
		// Static helper method
		proto.constructor.dragRulerGetRaysFromWaypoints = function (waypoints, destination) {
			if (destination) waypoints = waypoints.concat([destination]);
			return waypoints.slice(1).map((wp, i) => {
				const ray = new Ray(waypoints[i], wp);
				ray.isPrevious = Boolean(waypoints[i].isPrevious);
				return ray;
			});
		};
	});
}

