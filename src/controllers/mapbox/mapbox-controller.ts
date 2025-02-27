import * as mapboxgl from "mapbox-gl";
import * as geojson from "geojson";
import * as lib from "../../lib";
import { Controller } from "../../core";
import {
  Feature,
  LayerState,
  LayerType,
  Line,
  ControllerEventType,
  Plane,
  Point,
  SourceEventHandler,
  SourceEventOptions,
} from "../../types";
import { addMouseLeaveHandler, addSource, eventParser, removeSource, sortPointsByDistance } from "./lib";
import { AddSourcePayload, areaLayer, defaultConfig, generateLayers, Options, splitLayers } from "./config";
import type { ShapesCollection, LayerFeatureProperties, Subscription } from "./types";

const featureTypes = {
  points: "Point",
  lines: "LineString",
  planes: "Polygon",
};

export class MapboxController extends Controller {
  private _map: mapboxgl.Map | undefined;
  private _features: Partial<Record<LayerType, geojson.Feature[]>> = {};
  private _requested: Partial<Record<LayerType, boolean>> = {};
  private _states: Partial<Record<LayerType, Partial<Record<LayerState, string[]>>>> = {};
  private readonly _options: Options | undefined;
  private _removeSources!: () => void;
  private _subscriptions: Subscription[] = [];
  private _hovered: ShapesCollection = {};
  private _ready?: VoidFunction;

  constructor(id: number | string, map: mapboxgl.Map, options: Options);
  constructor(id: number | string, map: mapboxgl.Map);
  constructor(map: mapboxgl.Map, options: Options);
  constructor(map: mapboxgl.Map);
  constructor(...params: unknown[]) {
    const [id, map, options] =
      typeof params[0] === "number" || typeof params[0] === "string"
        ? ([params[0], params[1], params[2]] as [number | string, mapboxgl.Map, Options | undefined])
        : ([undefined, params[0], params[1]] as [undefined, mapboxgl.Map, Options | undefined]);
    super({
      points: `@@map-editor-${id ?? ""}-points`,
      lines: `@@map-editor-${id ?? ""}-lines`,
      planes: `@@map-editor-${id ?? ""}-planes`,
    });

    this.addListener = this.addListener.bind(this);
    this.removeListener = this.removeListener.bind(this);
    this.setCursor = this.setCursor.bind(this);
    this.setState = this.setState.bind(this);
    this.render = this.render.bind(this);

    this._options = options;
    this._fillmove = this._fillmove.bind(this);
    this._fillleave = this._fillleave.bind(this);
    this._linemove = this._linemove.bind(this);
    this._lineleave = this._lineleave.bind(this);
    this._pointmove = this._pointmove.bind(this);
    this._pointleave = this._pointleave.bind(this);
    this._render = this._render.bind(this);

    const init = () => {
      this._map = map;
      this._initSources(this._options);
      this._map.on("mousemove", this.layerNames.planes, this._fillmove);
      this._map.on("mousedown", this.layerNames.planes, this._fillmove);
      this._map.on("mouseleave", this.layerNames.planes, this._fillleave);
      this._map.on("mousemove", this.layerNames.lines, this._linemove);
      this._map.on("mousedown", this.layerNames.lines, this._linemove);
      this._map.on("mouseleave", this.layerNames.lines, this._lineleave);
      this._map.on("mousemove", this.layerNames.points, this._pointmove);
      this._map.on("mousedown", this.layerNames.points, this._pointmove);
      this._map.on("mouseleave", this.layerNames.points, this._pointleave);
      this._render();
      this._ready?.();
    };

    map.isStyleLoaded() ? init() : map.on("load", () => init());
  }

  public ready(callback: VoidFunction) {
    if (this._map) return callback();
    this._ready = callback;
  }

  public addListener(
    ...params:
      | [ControllerEventType, LayerType, SourceEventHandler]
      | [ControllerEventType, SourceEventHandler]
      | [ControllerEventType, SourceEventHandler, SourceEventOptions]
  ) {
    if (typeof params[1] === "function") {
      const [name, callback, options] = params as [
        ControllerEventType,
        SourceEventHandler,
        SourceEventOptions | undefined,
      ];
      this._listenmap(name, callback, options);
    } else {
      const [name, layer, callback] = params as [ControllerEventType, LayerType, SourceEventHandler];
      this._listenlayer(name, layer, callback);
    }
  }

  public removeListener(
    ...params: [ControllerEventType, SourceEventHandler] | [ControllerEventType, LayerType, SourceEventHandler]
  ) {
    if (typeof params[1] === "function") {
      const [name, callback] = params as [ControllerEventType, SourceEventHandler];
      this._unsubscribe({ name, callback });
    } else {
      const [name, layer, callback] = params as [ControllerEventType, LayerType, SourceEventHandler];
      this._unsubscribe({ name, layer, callback });
    }
  }

  public setCursor(value: string) {
    if (!this._map) return;
    const prev = this._map.getCanvas().style.cursor;
    if (prev !== value) this._map.getCanvas().style.cursor = value;

    return () => {
      if (!this._map) return;
      const current = this._map.getCanvas().style.cursor;
      if (current !== prev) this._map.getCanvas().style.cursor = prev;
    };
  }

  public setState(layer: LayerType, nesting: number[][], key: LayerState, value: boolean) {
    if (layer === "points")
      return this._setState(
        layer,
        nesting.map((n) => `${n.map((x) => x + 1).join(".")}.`),
        key,
        value,
      );

    this._setState(
      layer,
      nesting.reduce((acc, n) => {
        const search = `${n.map((x) => x + 1).join(".")}.`;

        return [
          ...acc,
          search,
          ...(this._features[layer] ?? []).reduce((ids, f) => {
            if (f.id?.toString().indexOf(search) !== 0) return ids;
            return [...ids, f.id.toString()];
          }, [] as string[]),
        ];
      }, [] as string[]),
      key,
      value,
    );
  }

  public render(key: "features" | "points", items: Feature[] | Point[]) {
    if (key === "points") return this._toFeatures("points", items as Point[]);
    this._toFeatures(
      "planes",
      (items as Feature[]).reduce((acc, item) => {
        switch (item.type) {
          case "Polygon":
            return [...acc, item];
          case "MultiPolygon":
            return [
              ...acc,
              ...item.coordinates.map(
                (coords, index) =>
                  ({
                    ...item,
                    type: "Polygon",
                    coordinates: coords,
                    nesting: [...item.nesting, index],
                  }) as Plane,
              ),
            ];
          default:
            return acc;
        }
      }, [] as Plane[]),
    );

    this._toFeatures(
      "lines",
      (items as Feature[]).reduce((acc, item) => {
        const res: Line[] = [];
        lib.traverseCoordinates(item, (positions, indices) => {
          res.push({
            type: "LineString",
            coordinates: positions,
            nesting: [...indices],
            props: item.props,
          });
        });
        return [...acc, ...res];
      }, [] as Line[]),
    );
  }

  get renderer() {
    return this._map;
  }

  public remove() {
    this._map?.off("mousemove", this.layerNames.planes, this._fillmove);
    this._map?.off("mousedown", this.layerNames.planes, this._fillmove);
    this._map?.off("mouseleave", this.layerNames.planes, this._fillleave);
    this._map?.off("mousemove", this.layerNames.lines, this._linemove);
    this._map?.off("mousedown", this.layerNames.lines, this._linemove);
    this._map?.off("mouseleave", this.layerNames.lines, this._lineleave);
    this._map?.off("mousemove", this.layerNames.points, this._pointmove);
    this._map?.off("mousedown", this.layerNames.points, this._pointmove);
    this._map?.off("mouseleave", this.layerNames.points, this._pointleave);
    this._removeSources?.();
    this._map = undefined;
  }

  protected lock() {
    if (this._locked) {
      return () => void 0;
    }

    this._locked = true;

    const dragPan = this._map?.dragPan.isEnabled();
    const dragRotate = this._map?.dragRotate.isEnabled();
    const boxZoom = this._map?.boxZoom.isEnabled();
    const doubleClickZoom = this._map?.doubleClickZoom.isEnabled();

    dragPan && this._map?.dragPan.disable();
    dragRotate && this._map?.dragRotate.disable();
    boxZoom && this._map?.boxZoom.disable();
    doubleClickZoom && this._map?.doubleClickZoom.disable();

    return () => {
      dragPan && this._map?.dragPan.enable();
      dragRotate && this._map?.dragRotate.enable();
      boxZoom && this._map?.boxZoom.enable();
      doubleClickZoom && this._map?.doubleClickZoom.enable();
      this._locked = false;
    };
  }

  private _mapHandler() {
    return {
      preventDefault: () => {
        window.requestAnimationFrame(this.lock());
      },
      points: [...(this._hovered.points ?? [])],
      lines: [...(this._hovered.lines ?? [])],
      planes: [...(this._hovered.planes ?? [])],
    };
  }

  private _toFeatures(type: LayerType, items: (Line | Plane | Point)[]) {
    this._features[type] = items.map(
      (item) =>
        ({
          id: `${item.nesting.map((x) => x + 1).join(".")}.`,
          type: "Feature",
          geometry: {
            type: featureTypes[type],
            coordinates: item.coordinates,
          },
          properties: {
            ...item.props,
            nesting: JSON.stringify(item.nesting),
          },
        }) as geojson.Feature,
    );

    const ids = this._features[type]?.map((f) => f.id) ?? [];
    this._hovered[type] = this._hovered[type]?.filter((i) =>
      ids.includes(`${i.nesting.map((x) => x + 1).join(".")}.`),
    ) as any;

    this._requested[type] = true;
  }

  private _initSources(options?: Options) {
    const layerStyles = options?.layerStyles ?? generateLayers(options?.config ?? defaultConfig);
    const layers = splitLayers(layerStyles);

    const sources: AddSourcePayload[] = [
      ...(Object.keys(this.layerNames) as LayerType[]).reduce((acc, type) => {
        const area = options?.area?.[type];
        return [
          ...acc,
          {
            id: this.layerNames[type],
            layers: layers[type],
            areaLayer: area !== false ? areaLayer[type](area) : undefined,
          },
        ];
      }, [] as AddSourcePayload[]),
    ];

    sources.forEach((source) => addSource(this._map, source));
    this._removeSources = () => sources.forEach((source) => removeSource(this._map, source));
  }

  private _subscribe(props: Subscription) {
    const current = this._subscriptions.findIndex(
      (item) => item.name === props.name && item.layer === props.layer && item.callback === props.callback,
    );
    if (current >= 0) {
      this._subscriptions[current].off();
      this._subscriptions[current] = props;
      return;
    }

    this._subscriptions.push(props);
  }

  private _unsubscribe(props: Omit<Subscription, "off">) {
    const index = this._subscriptions.findIndex(
      (item) => item.name === props.name && item.layer === props.layer && item.callback === props.callback,
    );
    if (index >= 0) {
      this._subscriptions[index].off();
      this._subscriptions = [...this._subscriptions.slice(0, index), ...this._subscriptions.slice(index + 1)];
    }
  }

  private _listenmap(name: ControllerEventType, callback: SourceEventHandler, options?: SourceEventOptions) {
    const handler = (e: mapboxgl.MapMouseEvent) => {
      callback({ ...eventParser(e), ...this._mapHandler() });
    };

    if (options?.once) {
      this._map?.once(name, handler);
      return;
    }

    this._map?.on(name, handler);
    this._subscribe({ callback, name, off: () => this._map?.off(name, handler) });
  }

  private _listenlayer(name: ControllerEventType, layer: LayerType, callback: SourceEventHandler) {
    const handler = (e: mapboxgl.MapLayerMouseEvent | mapboxgl.MapLayerTouchEvent) => {
      callback({ ...eventParser(e as mapboxgl.MapLayerMouseEvent), layer, ...this._mapHandler() });
    };

    if (name === "mouseleave" || name === "mouseover") {
      return this._subscribe({
        callback,
        name,
        layer,
        off: addMouseLeaveHandler(this._map, this.layerNames[layer], handler),
      });
    }

    this._map?.on(name, this.layerNames[layer], handler);
    this._subscribe({
      name,
      layer,
      callback,
      off: () => this._map?.off(name, this.layerNames[layer], handler),
    });
  }

  private _render() {
    (["points", "lines", "planes"] as LayerType[]).forEach((type) => {
      if (!this._requested[type]) return;
      const parse = (item: geojson.Feature) => ({
        ...item,
        id: (item.id as string).split(".").join("0"),
      });

      const collection = (this._features[type] ?? []).reduce(
        (acc, item) => {
          if (this._states[type]?.active?.includes(item.id as string))
            return { ...acc, active: [...acc.active, parse(item)] };
          if (this._states[type]?.hover?.includes(item.id as string))
            return { ...acc, hover: [...acc.hover, parse(item)] };
          if (this._states[type]?.disabled?.includes(item.id as string))
            return { ...acc, disabled: [...acc.disabled, parse(item)] };
          return { ...acc, default: [...acc.default, parse(item)] };
        },
        {
          disabled: [],
          default: [],
          hover: [],
          active: [],
        } as Record<LayerState | "default", geojson.Feature[]>,
      );
      (this._map?.getSource(this.layerNames[type]) as mapboxgl.GeoJSONSource)?.setData({
        type: "FeatureCollection",
        features: [...collection.disabled, ...collection.default, ...collection.hover, ...collection.active],
      });

      this._requested[type] = false;
    });

    this._map && window.requestAnimationFrame(this._render);
  }

  private _setState(layer: LayerType, ids: (string | undefined)[], key: LayerState, value: boolean) {
    let _changed = false;

    ids.forEach((id) => {
      if (!id) return;
      if (value !== this._states[layer]?.[key]?.includes(id)) {
        this._states[layer] = {
          ...this._states[layer],
          [key]: value
            ? [...(this._states[layer]?.[key] ?? []), id]
            : (this._states[layer]?.[key] ?? []).filter((x) => x !== id),
        };
        _changed = true;
      }
      this._map?.setFeatureState(
        { id: (id as string).split(".").join("0"), source: this.layerNames[layer] },
        { [key]: value },
      );
    });

    if (!_changed) return;
    this._requested[layer] = true;
  }

  private _fillmove(e: mapboxgl.MapLayerTouchEvent | mapboxgl.MapLayerMouseEvent) {
    this._hovered.planes = (e.features || []).map((f) => {
      const { nesting, ...rest } = f.properties as LayerFeatureProperties;
      return {
        type: "Polygon",
        coordinates: (f.geometry as geojson.Polygon).coordinates,
        nesting: JSON.parse(nesting),
        props: rest,
      };
    });
  }

  private _fillleave() {
    this._hovered.planes = [];
  }

  private _linemove(e: mapboxgl.MapLayerTouchEvent | mapboxgl.MapLayerMouseEvent) {
    this._hovered.lines = (e.features || []).map((f) => {
      const { nesting, ...rest } = f.properties as LayerFeatureProperties;
      return {
        type: "LineString",
        coordinates: (f.geometry as geojson.LineString).coordinates,
        nesting: JSON.parse(nesting),
        props: rest,
      };
    });
  }

  private _lineleave() {
    this._hovered.lines = [];
  }

  private _pointmove(e: mapboxgl.MapLayerTouchEvent | mapboxgl.MapLayerMouseEvent) {
    this._hovered.points = sortPointsByDistance(
      (e.features ?? []) as unknown as geojson.Feature<geojson.Point, LayerFeatureProperties>[],
      e.lngLat.toArray(),
    ).map((f) => {
      const { nesting, ...rest } = f.properties as LayerFeatureProperties;
      return {
        type: "Point",
        coordinates: (f.geometry as geojson.Point).coordinates,
        nesting: JSON.parse(nesting),
        props: rest,
      };
    });
  }

  private _pointleave() {
    this._hovered.points = [];
  }
}
