import { AnyTool } from "../core";
import * as lib from "../lib";
import { Feature, FilterHandler, KeyModifier, LayerType, Point, Position, SourceEvent } from "../types";
import { getModifierKey } from "../lib";

export interface MoveToolConfig {
  modify: boolean | "dblclick" | "alt" | "meta" | "ctrl";
  filter: FilterHandler;
}

export class MoveTool extends AnyTool {
  declare config: MoveToolConfig;
  private _state: { dragging: boolean; modifiers: ("alt" | "meta" | "ctrl")[]; features?: Feature[] } = {
    dragging: false,
    modifiers: [],
  };
  private _stored: { cursor?: () => void } = {};
  private _event: SourceEvent | null = null;
  private _paused: boolean = false;

  constructor(config?: MoveToolConfig) {
    super({
      modify: config?.modify ?? true,
      filter: config?.filter ?? (() => true),
    });
    this._canvasclick = this._canvasclick.bind(this);
    this._canvasleave = this._canvasleave.bind(this);
    this._featurehover = this._featurehover.bind(this);
    this._shapedrag = this._shapedrag.bind(this);
    this._shapedblclick = this._shapedblclick.bind(this);
    this._pointhover = this._pointhover.bind(this);
    this._pointdrag = this._pointdrag.bind(this);
    this._keypress = this._keypress.bind(this);
  }

  get icon() {
    return `<g fill="none" transform="translate(-4 -4)">${iconShape}</g>`;
  }

  public refresh() {
    this.core.render("features", this._state.features ?? this.core.features);
    this.core.isolate();
    this._render();
  }

  public enable() {
    this._paused = false;
    if (!this.disabled) return;
    super.enable();
    this._stored.cursor = this.core.setCursor("default");
    this.core.addListener("mouseout", this._canvasleave);
    this.core.addListener("mouseenter", "points", this._pointhover);
    this.core.addListener("mousemove", this._featurehover);
    this.core.addListener("click", this._canvasclick);
    this.core.addListener("mousedown", "points", this._pointdrag);
    this.core.addListener("mousedown", "lines", this._shapedrag);
    this.core.addListener("mousedown", "planes", this._shapedrag);
    this.core.addListener("dblclick", "lines", this._shapedblclick);
    this.core.addListener("dblclick", "planes", this._shapedblclick);
    document.addEventListener("keydown", this._keypress);
    document.addEventListener("keyup", this._keypress);
  }

  public disable() {
    if (this._state.dragging) {
      this._paused = true;
      return;
    }
    this._paused = false;
    if (this.disabled) return;
    super.disable();
    this._stored.cursor?.();
    document.removeEventListener("keydown", this._keypress);
    document.removeEventListener("keyup", this._keypress);
    this.core.removeListener("mousedown", "points", this._pointdrag);
    this.core.removeListener("mouseenter", "points", this._pointhover);
    this.core.removeListener("mousedown", "planes", this._shapedrag);
    this.core.removeListener("mousedown", "lines", this._shapedrag);
    this.core.removeListener("dblclick", "planes", this._shapedblclick);
    this.core.removeListener("dblclick", "lines", this._shapedblclick);
    this.core.removeListener("click", this._canvasclick);
    this.core.removeListener("mousemove", this._featurehover);
    this.core.removeListener("mouseout", this._canvasleave);
  }

  public start() {
    super.start();
    this.core.isolate();
    if (this._state.features) this.core.render("features", this._state.features);
    this._render();
  }

  public finish() {
    if (this._state.features) this.core.features = this._state.features;
    this._state = {
      dragging: false,
      modifiers: [],
    };
    super.finish();
  }

  protected cursor = (key: string, fallback: string) => {
    return `url(${lib.createCursor(
      `<g fill="none" stroke="#FFF">${iconShape}</g>`,
      `<g fill="#000" stroke="#000">${iconShape}</g>`,
      key,
      "#000",
      "-2.5 0",
    )}) 10 8, ${fallback}`;
  };

  protected _canvasleave() {
    this.core.state.features.set("hover", []);
  }

  protected _featurehover(e: SourceEvent) {
    if (this._state.dragging) return;
    this._event = e;
    const points = e.points.filter(this.config.filter);
    const lines = e.lines.filter(this.config.filter);
    const planes = e.planes.filter(this.config.filter);
    let shapes = [...points, ...lines, ...planes].map((f) => f.nesting);

    if (this.core.state.features.get("active").every((n) => typeof n === "number")) {
      this.core.setCursor(shapes.length ? this.cursor("default", "pointer") : "default");
      this.core.state.features.set("hover", shapes.length ? [lib.array.plain(shapes[0])] : []);
      return;
    }

    shapes = shapes.filter((n) =>
      this.core.state.features.get("active").map(lib.array.plain).includes(lib.array.plain(n)),
    );

    if (shapes.length) {
      this.core.setCursor(this.cursor(points.length ? "point" : lines.length ? "line" : "polygon", "pointer"));
      this.core.state.features.set("hover", shapes.length ? [shapes[0]] : []);
    } else {
      this.core.setCursor("default");
      this.core.state.features.set("hover", []);
    }
  }

  protected _canvasclick(e: SourceEvent) {
    e.preventDefault();
    const indices = [...e.points, ...e.lines, ...e.planes].map((f) => f.nesting[0]);
    if (
      typeof this.config.modify === "string" &&
      ["meta", "alt", "ctrl"].includes(this.config.modify) &&
      e.originalEvent[getModifierKey(this.config.modify as KeyModifier)]
    )
      return;

    if (this.core.state.features.get("active").some((n) => typeof n === "number")) {
      if (indices.length) return;
    } else {
      if (lib.array.intersect(this.core.state.features.get("active").map(lib.array.plain), indices)) return;
    }

    this.core.state.features.set("active", []);
    this.core.isolate();
    this._render();
    this._featurehover(e);
  }

  protected _shapedrag(e: SourceEvent) {
    if (
      e.points.filter(this.config.filter).length &&
      !this.core.state.features.get("active").some((n) => typeof n === "number")
    )
      return;
    if (e.layer === "planes" && e.lines.filter(this.config.filter).length) return;
    const geometry = e[e.layer as LayerType][0];
    if (!geometry) return;
    e.preventDefault();

    const current = {
      active: this.core.state.features.get("active"),
      hover: this.core.state.features.get("hover"),
    };

    const state = handleSetActive(
      e.originalEvent.shiftKey,
      this.core.state.features.get("active"),
      geometry.nesting,
      this.config.modify === true,
    );
    if (!state) return;
    this.core.state.features.set("active", state.active);
    this._render();
    this._state.dragging = true;

    const _onmousemove = (ev: SourceEvent) => {
      if (!this._state.features) {
        if (
          Math.abs(ev.originalEvent.pageX - e.originalEvent.pageX) <= 3 &&
          Math.abs(ev.originalEvent.pageY - e.originalEvent.pageY) <= 3
        )
          return;
      }

      this._state.features = this.core.features.map((item) => {
        const focused = this.core.state.features.get("active").filter((n) => lib.array.plain(n) === item.nesting[0]);
        if (!focused.length) return item;
        return lib.traverseCoordinates(item, (positions, indices) =>
          focused.some((n) => typeof n === "number" || lib.array.equal(n, indices.slice(0, n.length)))
            ? lib.shape.move(positions, e.position, ev.position)
            : positions,
        );
      });

      this.core.render("features", this._state.features);
      this.core.render(
        "points",
        lib.createPoints(this._state.features, this.core.state.features.get("active")).filter(this.config.filter),
      );
    };

    const _onmouseup = () => {
      this.core.removeListener("mousemove", _onmousemove);
      this._state.dragging = false;

      if (this._state.features) {
        this.core.state.features.set("hover", current.hover);
        if (this._state.features) this.core.features = this._state.features;
        this._state.features = undefined;
      } else {
        const released = state.release?.();
        if (released) {
          this.core.state.features.set("hover", released);
          this.core.state.features.set("active", released);
        }
        this.refresh();
      }
      this._featurehover(e);
      if (this._paused) this.disable();
    };

    this.core.addListener("mousemove", _onmousemove);
    document.addEventListener("mouseup", _onmouseup, { once: true });
  }

  protected _shapedblclick(e: SourceEvent) {
    e.preventDefault();
    if (this.config.modify !== "dblclick") return;

    if (
      e.points.filter(this.config.filter).length &&
      !this.core.state.features.get("active").some((n) => typeof n === "number")
    )
      return;
    if (e.layer === "planes" && e.lines.filter(this.config.filter).length) return;
    const geometry = e[e.layer as LayerType][0];
    if (!geometry) return;
    this.core.state.features.set("active", [[geometry.nesting[0]]]);
    this.refresh();
  }

  protected _keypress(e: Pick<KeyboardEvent, "metaKey" | "altKey" | "ctrlKey" | "shiftKey">) {
    if (typeof this.config.modify !== "string" || !["meta", "alt", "ctrl"].includes(this.config.modify)) return;

    if (!e[getModifierKey(this.config.modify as KeyModifier)]) {
      if (!this._state.dragging) {
        this.core.state.features.set("active", this.core.state.features.get("active").map(lib.array.plain));
        this.core.state.points.set("active", []);
        this.core.state.points.set("hover", []);
        this.refresh();
        this._event && this._featurehover(this._event);
      }
      return;
    }

    this.core.state.features.set("active", this.core.state.features.get("active").map(lib.array.array));
    this.refresh();
    this._event && this._featurehover(this._event);
  }

  protected _pointhover(e: SourceEvent) {
    if (this.core.state.features.get("active").some((n) => typeof n === "number")) return;
    let point = e.points.filter(this.config.filter)[0];
    if (!point) return;
    !this._state.dragging && this.core.state.points.set("hover", [point.nesting]);

    const _onmousemove = (ev: SourceEvent) => {
      if (this._state.dragging) return;
      if (lib.array.equal(ev.points[0].nesting ?? [], point.nesting)) return;
      point = ev.points.filter(this.config.filter)[0];
      this.core.state.points.set("hover", [point.nesting]);
    };

    const _onmouseleave = () => {
      !this._state.dragging && this.core.state.points.set("hover", []);
      this.core.removeListener("mouseleave", "points", _onmouseleave);
      this.core.removeListener("mousemove", "points", _onmousemove);
    };

    this.core.addListener("mouseleave", "points", _onmouseleave);
    this.core.addListener("mousemove", "points", _onmousemove);
  }

  protected _pointdrag(e: SourceEvent) {
    if (this.core.state.features.get("active").some((n) => typeof n === "number")) return;
    const point = e.points.filter(this.config.filter)[0];
    let feature = this.core.getFeatures([point?.nesting[0]])[0];
    if (!point || !feature) return;
    e.preventDefault();

    let sibling: Point | undefined;
    this._state.dragging = true;

    const pidx = point.nesting.length - 1;
    let positions = lib.toPositions(lib.getCoordinates(feature, point.nesting.slice(0, pidx)), feature.type);

    const _updater = (feature: Feature, next?: Position) =>
      lib.traverseCoordinates(feature, (coordinates, indices) =>
        lib.array.equal(point.nesting.slice(0, indices.length), indices)
          ? lib.toCoordinates(
              [
                ...positions.slice(0, point.nesting[pidx]),
                ...(next ? [next] : []),
                ...positions.slice(point.nesting[pidx] + 1),
              ],
              feature?.type,
            )
          : coordinates,
      );

    if (point.nesting[pidx] >= positions.length) {
      point.nesting[pidx] = (point.nesting[pidx] % positions.length) + 1;

      positions = [
        ...positions.slice(0, point.nesting[pidx]),
        point.coordinates,
        ...positions.slice(point.nesting[pidx]),
      ];

      feature = lib.traverseCoordinates(feature, (coordinates, indices) =>
        lib.array.equal(point.nesting.slice(0, indices.length), indices)
          ? lib.toCoordinates(positions, feature?.type)
          : coordinates,
      );

      this._state.features = [
        ...this.core.features.slice(0, point.nesting[0]),
        feature,
        ...this.core.features.slice(point.nesting[0] + 1),
      ];
    }

    const _onpointhover = (ev: SourceEvent) => {
      sibling = ev.points.find(
        (n) =>
          !this.core.state.points.get(n.nesting).includes("disabled") && !lib.array.equal(n.nesting, point.nesting),
      );
    };

    const _onpointleave = () => {
      sibling = undefined;
    };

    const _onmousemove = (ev: SourceEvent) => {
      feature = _updater(
        feature,
        lib.point.normalize(sibling?.coordinates || lib.point.move(point.coordinates, e.position, ev.position)),
      );
      this._state.features = [
        ...this.core.features.slice(0, point.nesting[0]),
        feature,
        ...this.core.features.slice(point.nesting[0] + 1),
      ];
      this.core.render("features", this._state.features);
      this.core.render("points", lib.createPoints([feature], this.core.state.features.get("active")));
    };

    const _onmouseup = (ev: MouseEvent) => {
      this.core.removeListener("mousemove", _onmousemove);
      this.core.removeListener("mousemove", "points", _onpointhover);
      this.core.removeListener("mouseleave", "points", _onpointleave);
      this._state.dragging = false;
      this.core.state.points.set("active", []);

      if (this._state.features) {
        if (sibling && this.config.filter(sibling)) {
          this.core.state.points.set("hover", [sibling?.nesting[pidx] === before ? sibling.nesting : point.nesting]);
        }

        this._state.features = undefined;
        this.core.features = [
          ...this.core.features.slice(0, point.nesting[0]),
          sibling && lib.array.equal(sibling.nesting.slice(0, pidx), point.nesting.slice(0, pidx))
            ? _updater(feature)
            : feature,
          ...this.core.features.slice(point.nesting[0] + 1),
        ];
      }
      this._render();
      this._keypress(ev);
      this._featurehover(e);
      if (this._paused) this.disable();
    };

    const reducible = positions.length > 2 + Number(lib.isPolygonLike(feature));
    const before =
      reducible && point.nesting[pidx] === 0
        ? lib.isPolygonLike(feature)
          ? positions.length - 1
          : -1
        : point.nesting[pidx] - 1;
    const after =
      reducible && point.nesting[pidx] === positions.length - 1
        ? lib.isPolygonLike(feature)
          ? 0
          : -1
        : point.nesting[pidx] + 1;

    const points = lib.createPoints([feature], this.core.state.features.get("active"));
    const [disabled, enabled] = points.reduce(
      (acc, p) => {
        if (
          (before >= 0 && lib.array.equal(p.nesting, [...point.nesting.slice(0, pidx), before])) ||
          (after >= 0 && lib.array.equal(p.nesting, [...point.nesting.slice(0, pidx), after]))
        )
          acc[1].push(p.nesting);
        else acc[0].push(p.nesting);

        return acc;
      },
      [[], []] as number[][][],
    );
    this.core.state.points.add("disabled", disabled);
    this.core.state.points.remove("disabled", enabled);
    this.core.render("points", points);

    window.requestAnimationFrame(() => {
      this.core.state.points.set("hover", [point.nesting]);
      this.core.state.points.set("active", [point.nesting]);
    });

    this.core.addListener("mousemove", _onmousemove);
    document.addEventListener("mouseup", _onmouseup, { once: true });
    this.core.addListener("mousemove", "points", _onpointhover);
    this.core.addListener("mouseleave", "points", _onpointleave);
  }

  private _render() {
    const points = lib.createPoints(this._state.features ?? this.core.features, this.core.state.features.get("active"));

    if (this.core.state.features.get("active").some((n) => typeof n === "number")) {
      this.core.state.points.add(
        "disabled",
        points.map((p) => p.nesting),
      );
      return this.core.render("points", points);
    }

    const midpoints = createMiddlePoints(
      this._state.features ?? this.core.features,
      this.core.state.features.get("active"),
    ).filter(this.config.filter);

    this.core.state.points.add(
      "disabled",
      [...midpoints, ...points].map((p) => p.nesting),
    );
    this.core.state.points.remove(
      "disabled",
      points.filter(this.config.filter).map((p) => p.nesting),
    );
    this.core.render("points", [...points, ...midpoints]);
  }
}

const iconShape = `<path d="M10 8L13.6229 24.8856L17.3004 18.4261L24.6282 17.1796L10 8Z" stroke-linejoin="round"/>`;

const createMiddlePoints = (features: Feature[], focused: (number | number[])[]): Point[] => {
  return focused.reduce((acc, nesting) => {
    const feature = features[lib.array.plain(nesting)];
    if (!feature) return acc;

    lib.traverseCoordinates(feature, (positions, indices) => {
      if (Array.isArray(nesting) && !lib.array.equal(indices.slice(0, nesting.length), nesting)) return;
      const startIndex = lib.toPositions(positions, feature.type).length;
      positions.slice(1).forEach((position, index) => {
        acc.push({
          type: "Point",
          coordinates: lib.point.normalize(lib.point.middle(position, positions[index])),
          nesting: [...indices, startIndex + index],
          props: feature.props,
        });
      });
    });

    return acc;
  }, [] as Point[]);
};

export const handleSetActive = (
  shiftKey: boolean,
  active: (number | number[])[],
  nesting: number[],
  allowIsolate = true,
): {
  active: (number | number[])[];
  release?: () => (number | number[])[];
} | void => {
  if (!shiftKey) {
    if (active.every((n) => typeof n === "number")) {
      /**
       * Case: current feature selected
       * Action: Release to select shape
       */
      if (allowIsolate && active.length === 1 && active[0] === nesting[0])
        return {
          active: active,
          release: () => [nesting],
        };

      /**
       * Case: current multi-selection includes feature
       * Action: Release to feature single selection
       */
      if (active.includes(nesting[0])) {
        return {
          active: active,
          release: () => [nesting[0]],
        };
      }

      /**
       * Case: current feature is not selected
       * Action: Select current feature
       */
      return { active: [nesting[0]] };
    }

    /**
     * Case: Shape selection
     * Actions:
     *  - [1] Ignore if not current feature shape
     *  - [2] Select another shape
     *  - [3] Release to select shape from multi-selection
     *  - [4] Release to feature selection
     * */
    const _shapes = active.map(lib.array.array);
    if (!_shapes.some((n) => n[0] === nesting[0])) return; /* [1] */
    if (!_shapes.some((n) => lib.array.equal(n, nesting))) {
      return { active: [nesting] };
    } /* [2] */
    if (_shapes.length > 1) return { active: active, release: () => [nesting] }; /* [3] */
    return { active: active, release: () => [nesting[0]] };
  }

  if (active.every((n) => typeof n === "number")) {
    /**
     * Case current feature is selected
     * Actions:
     *  - Unselect if multiple selection
     */
    if (active.includes(nesting[0])) {
      if (active.length === 1) return { active: active };
      return {
        active: active,
        release: () => active.filter((s) => s !== nesting[0]),
      };
    }

    /**
     * Case: current feature is not selected
     * Action: Multi-select with current feature
     */
    return { active: [...active, nesting[0]] };
  }

  /**
   * Case: Shape selection
   * Actions:
   *  - [1] Ignore if not current feature shape
   *  - [2] Add shape to multiple shape selection
   *  - [3] Release to remove shape from multiple selection
   *  - [4] Keep shape selection
   * */
  const _shapes = active.map(lib.array.array);
  if (!_shapes.some((n) => n[0] === nesting[0])) return; /* [1] */
  if (!_shapes.some((n) => lib.array.equal(n, nesting)))
    return {
      active: [...active.filter((n) => typeof n === "number" || !lib.array.equal(n, nesting, true)), nesting],
    }; /* [2] */
  if (_shapes.length > 1)
    return {
      active: active,
      release: () => active.filter((n) => !Array.isArray(n) || !lib.array.equal(n, nesting)),
    }; /* [3] */
  return { active: active }; /* [4] */
};
