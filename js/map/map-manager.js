/**
 * Map manager — Mapbox GL JS integration
 * Custom basemaps, layer rendering, popups, 2D/3D toggle, satellite overlay
 */
import logger from '../core/logger.js';
import bus from '../core/event-bus.js';

const MAPBOX_TOKEN = 'pk.eyJ1Ijoicm9tZGl6bGUiLCJhIjoiY21empnc2k0MDdnZjNob205cGVsNjM3YyJ9.Pc8Q9tGnCiPiAMWblBM9AQ';

/* ─── Basemap style URLs ─── */
const BASEMAPS = {
    streets:   { name: 'Streets',       style: 'mapbox://styles/mapbox/streets-v12' },
    light:     { name: 'Light / Gray',  style: 'mapbox://styles/mapbox/light-v11' },
    dark:      { name: 'Dark',          style: 'mapbox://styles/mapbox/dark-v11' },
    outdoors:  { name: 'Outdoors',      style: 'mapbox://styles/mapbox/outdoors-v12' },
    satellite: { name: 'Satellite',     style: 'mapbox://styles/mapbox/satellite-v9' },
    hybrid:    { name: 'Hybrid',        style: 'mapbox://styles/mapbox/satellite-streets-v12' },
    standard:  { name: 'Standard',      style: 'mapbox://styles/mapbox/standard' },
    none:      { name: 'No Basemap',    style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#121212' } }] } }
};

const LAYER_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#be185d', '#65a30d'];

/* ─── Point symbol SVG factories ─── */
function _svgCircle(color, fillColor, size, opacity) {
    const s = size * 2;
    return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><circle cx="${size}" cy="${size}" r="${size - 1}" fill="${fillColor}" fill-opacity="${opacity}" stroke="${color}" stroke-width="2"/></svg>`;
}
function _svgSquare(color, fillColor, size, opacity) {
    const s = size * 2;
    return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><rect x="1" y="1" width="${s - 2}" height="${s - 2}" fill="${fillColor}" fill-opacity="${opacity}" stroke="${color}" stroke-width="2" rx="2"/></svg>`;
}
function _svgTriangle(color, fillColor, size, opacity) {
    const s = size * 2;
    return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><polygon points="${size},1 ${s - 1},${s - 1} 1,${s - 1}" fill="${fillColor}" fill-opacity="${opacity}" stroke="${color}" stroke-width="2"/></svg>`;
}
function _svgDiamond(color, fillColor, size, opacity) {
    const s = size * 2;
    return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><polygon points="${size},1 ${s - 1},${size} ${size},${s - 1} 1,${size}" fill="${fillColor}" fill-opacity="${opacity}" stroke="${color}" stroke-width="2"/></svg>`;
}
function _svgStar(color, fillColor, size, opacity) {
    const cx = size, cy = size, r = size - 1, ri = r * 0.4, s = size * 2;
    let pts = '';
    for (let i = 0; i < 5; i++) {
        const aOuter = (Math.PI / 2) + (2 * Math.PI * i / 5);
        const aInner = aOuter + Math.PI / 5;
        pts += `${cx + r * Math.cos(aOuter)},${cy - r * Math.sin(aOuter)} `;
        pts += `${cx + ri * Math.cos(aInner)},${cy - ri * Math.sin(aInner)} `;
    }
    return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><polygon points="${pts.trim()}" fill="${fillColor}" fill-opacity="${opacity}" stroke="${color}" stroke-width="1.5"/></svg>`;
}
function _svgPin(color, fillColor, size, opacity) {
    const s = size * 2, h = s + 8;
    return `<svg width="${s}" height="${h}" viewBox="0 0 ${s} ${h}"><path d="M${size} ${s + 6} C${size} ${s + 6} ${s - 1} ${size + 2} ${s - 1} ${size} A${size - 1} ${size - 1} 0 1 0 1 ${size} C1 ${size + 2} ${size} ${s + 6} ${size} ${s + 6}Z" fill="${fillColor}" fill-opacity="${opacity}" stroke="${color}" stroke-width="1.5"/><circle cx="${size}" cy="${size}" r="${size * 0.35}" fill="${color}" opacity="0.6"/></svg>`;
}

const SVG_FACTORIES = { circle: _svgCircle, square: _svgSquare, triangle: _svgTriangle, diamond: _svgDiamond, star: _svgStar, pin: _svgPin };

/**
 * Create an HTMLElement marker for a point feature with the given style.
 */
function _createPointMarkerEl(sty) {
    const sym = sty.pointSymbol || 'circle';
    const size = sty.pointSize || 6;
    const fo = Math.min(1, (sty.fillOpacity ?? 0.3) + 0.3);
    const factory = SVG_FACTORIES[sym] || SVG_FACTORIES.circle;
    const svg = factory(sty.strokeColor, sty.fillColor, size, fo);
    const el = document.createElement('div');
    el.className = 'point-symbol';
    el.innerHTML = svg;
    el.style.cursor = 'pointer';
    return el;
}

class MapManager {
    constructor() {
        this.map = null;
        this.dataLayers = new Map();       // layerId -> { sourceId, layerIds[], markers[], visible }
        this._layerNames = new Map();      // layerId -> display name
        this._layerStyles = new Map();     // layerId -> style object
        this._layerData = new Map();       // layerId -> { geojson, colorIndex }
        this.currentBasemap = 'streets';

        // Import fence state
        this._importFence = null;

        // Feature selection state
        this._selections = new Map();
        this._selectionMode = false;
        this._selectionMarkers = new Map();
        this._selectionBanner = null;
        this._rectSelectCleanup = null;

        // Popup cycling state
        this._popupHits = null;
        this._popupIndex = 0;
        this._popupLatLng = null;
        this._popup = null;

        // 3D state
        this._is3D = false;

        // Interaction cleanup
        this._interactionCleanup = null;

        // Coordinate search
        this._searchMarker = null;
        this._searchLatLng = null;

        // Highlight marker (for popup-triggered highlight)
        this._highlightMarker = null;
    }

    /* =========================================================
       BACKWARD-COMPAT SHIMS
       ========================================================= */

    /**
     * Patch the Mapbox map instance so callers that still use Leaflet-ish
     * methods (map.invalidateSize, map.closePopup, map.setView …) keep working.
     */
    _applyMapShims() {
        if (!this.map) return;
        const mgr = this;
        const map = this.map;

        /* map.invalidateSize() → map.resize() */
        map.invalidateSize = () => map.resize();

        /* map.closePopup() */
        map.closePopup = () => {
            if (mgr._popup) { mgr._popup.remove(); mgr._popup = null; }
        };

        /* map.setView([lat,lng], zoom) */
        map.setView = (latlng, zoom) => {
            const center = Array.isArray(latlng) ? [latlng[1], latlng[0]] : [latlng.lng, latlng.lat];
            map.jumpTo({ center, zoom });
        };

        /* map.doubleClickZoom compat */
        const origDCZ = map.doubleClickZoom;
        map.doubleClickZoom = {
            enabled: () => origDCZ.isActive?.() ?? true,
            disable: () => origDCZ.disable(),
            enable:  () => origDCZ.enable()
        };

        /* map.dragging compat */
        map.dragging = {
            disable: () => map.dragPan.disable(),
            enable:  () => map.dragPan.enable()
        };

        /* map.fitBounds — normalise Leaflet-style LatLngBounds objects */
        const origFit = map.fitBounds.bind(map);
        map.fitBounds = (b, opts = {}) => {
            let mb;
            if (b && typeof b.getSouthWest === 'function') {
                const sw = b.getSouthWest(), ne = b.getNorthEast();
                mb = [[sw.lng, sw.lat], [ne.lng, ne.lat]];
            } else {
                mb = b;
            }
            const pad = typeof opts.padding === 'number' ? opts.padding : 30;
            origFit(mb, { padding: pad, maxZoom: opts.maxZoom || 16 });
        };
    }

    /* =========================================================
       INIT
       ========================================================= */

    init(containerId) {
        if (typeof mapboxgl === 'undefined') {
            logger.error('Map', 'Mapbox GL JS not loaded');
            return;
        }

        mapboxgl.accessToken = MAPBOX_TOKEN;

        this.map = new mapboxgl.Map({
            container: containerId,
            style: BASEMAPS.hybrid.style,
            center: [-111.09, 39.32],
            zoom: 7,
            attributionControl: true,
            maxPitch: 0,
            dragRotate: false
        });

        this.map.addControl(new mapboxgl.NavigationControl({ showCompass: true, visualizePitch: false }), 'top-right');
        this._applyMapShims();

        this.map.on('error', (e) => {
            logger.warn('Map', 'Map error', { error: e.error?.message || e.message });
        });

        // Click on empty area — clear highlight / popup
        this.map.on('click', (e) => {
            if (e._handled) return;
            if (!this._selectionMode) this.clearHighlight();
        });

        this.map.on('contextmenu', (e) => {
            if (e._handled) return;
            bus.emit('map:contextmenu', {
                latlng: { lat: e.lngLat.lat, lng: e.lngLat.lng },
                originalEvent: e.originalEvent,
                layerId: null, featureIndex: null, feature: null
            });
        });

        this.map.on('load', () => {
            logger.info('Map', 'Map initialised (Mapbox GL JS)');
            bus.emit('map:ready', this.map);
            this._initCoordSearch();
        });

        return this.map;
    }

    /* =========================================================
       3D TOGGLE
       ========================================================= */

    get is3D() { return this._is3D; }

    toggle3D(enable) {
        const target = enable !== undefined ? !!enable : !this._is3D;
        if (target === this._is3D) return;
        this._is3D = target;

        if (target) {
            this.map.setMaxPitch(85);
            this.map.dragRotate.enable();

            if (!this.map.getSource('mapbox-dem')) {
                this.map.addSource('mapbox-dem', {
                    type: 'raster-dem',
                    url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
                    tileSize: 512, maxzoom: 14
                });
            }
            this.map.setTerrain({ source: 'mapbox-dem', exaggeration: 1.5 });
            this._add3DBuildings();
            this.map.easeTo({ pitch: 60, bearing: -30, duration: 1000 });
            logger.info('Map', '3D mode enabled');
        } else {
            this.map.setTerrain(null);
            this._remove3DBuildings();
            this.map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
            setTimeout(() => {
                if (!this._is3D) { this.map.setMaxPitch(0); this.map.dragRotate.disable(); }
            }, 850);
            logger.info('Map', '3D mode disabled');
        }
        bus.emit('map:3dToggled', this._is3D);
    }

    _add3DBuildings() {
        if (this.map.getLayer('3d-buildings')) return;
        const layers = this.map.getStyle().layers || [];
        let labelId;
        for (const l of layers) {
            if (l.type === 'symbol' && l.layout?.['text-field']) { labelId = l.id; break; }
        }
        try {
            this.map.addLayer({
                id: '3d-buildings', source: 'composite', 'source-layer': 'building',
                filter: ['==', 'extrude', 'true'], type: 'fill-extrusion', minzoom: 14,
                paint: {
                    'fill-extrusion-color': '#aaa',
                    'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 14.05, ['get', 'height']],
                    'fill-extrusion-base':   ['interpolate', ['linear'], ['zoom'], 14, 0, 14.05, ['get', 'min_height']],
                    'fill-extrusion-opacity': 0.6
                }
            }, labelId);
        } catch (e) {
            logger.warn('Map', 'Could not add 3D buildings', { error: e.message });
        }
    }

    _remove3DBuildings() {
        if (this.map.getLayer('3d-buildings')) this.map.removeLayer('3d-buildings');
    }

    /* =========================================================
       BASEMAPS
       ========================================================= */

    setBasemap(key) {
        const bm = BASEMAPS[key];
        if (!bm) { logger.warn('Map', 'Unknown basemap', { key }); return; }
        const was3D = this._is3D;
        this.map.setStyle(bm.style);
        this.currentBasemap = key;

        this.map.once('style.load', () => {
            this._reAddAllLayers();
            if (was3D) { this._is3D = false; this.toggle3D(true); }
            bus.emit('map:basemap', key);
        });
    }

    getBasemaps() { return BASEMAPS; }

    _reAddAllLayers() {
        for (const [layerId, { geojson, colorIndex }] of this._layerData) {
            const info = this.dataLayers.get(layerId);
            const wasVisible = info ? info.visible !== false : true;
            this._doAddLayer(layerId, geojson, colorIndex, false);
            if (!wasVisible) this.toggleLayer(layerId, false);
        }
    }

    /* =========================================================
       LAYER STYLE ACCESSORS
       ========================================================= */

    getLayerStyle(layerId) { return this._layerStyles.get(layerId) || null; }
    setLayerStyle(layerId, style) { this._layerStyles.set(layerId, style); }

    /* =========================================================
       ADD LAYER
       ========================================================= */

    addLayer(dataset, colorIndex = 0, { fit = false } = {}) {
        if (!this.map || !dataset.geojson) return;

        this.removeLayer(dataset.id);

        const defaultColor = LAYER_COLORS[colorIndex % LAYER_COLORS.length];
        const stored = this._layerStyles.get(dataset.id);
        const sty = {
            strokeColor:   stored?.strokeColor   || defaultColor,
            fillColor:     stored?.fillColor     || defaultColor,
            strokeWidth:   stored?.strokeWidth   ?? 2,
            strokeOpacity: stored?.strokeOpacity ?? 0.8,
            fillOpacity:   stored?.fillOpacity   ?? 0.3,
            pointSize:     stored?.pointSize     ?? 6,
            pointSymbol:   stored?.pointSymbol   || 'circle'
        };
        if (!stored) this._layerStyles.set(dataset.id, { ...sty });

        this._layerData.set(dataset.id, { geojson: dataset.geojson, colorIndex });
        this._layerNames.set(dataset.id, dataset.name);

        this._doAddLayer(dataset.id, dataset.geojson, colorIndex, fit);
    }

    /**
     * Internal: add sources + layers + markers.
     */
    _doAddLayer(layerId, geojson, colorIndex, fit) {
        const features = (geojson.features || []).filter(f => f.geometry);
        if (!features.length) {
            logger.info('Map', 'No geometries to display', { layer: this._layerNames.get(layerId) });
            return;
        }

        const sty = this._layerStyles.get(layerId) || {};
        const sourceId    = `src-${layerId}`;
        const fillId      = `fill-${layerId}`;
        const lineId      = `line-${layerId}`;
        const outlineId   = `outline-${layerId}`;
        const layerIds    = [];
        const markers     = [];

        const points = [], lines = [], polys = [];
        for (let i = 0; i < features.length; i++) {
            const f = features[i];
            const origIdx = geojson.features.indexOf(f);
            const enriched = { ...f, properties: { ...f.properties, _featureIndex: origIdx, _datasetId: layerId } };
            const gt = f.geometry.type;
            if (gt === 'Point' || gt === 'MultiPoint')             points.push(enriched);
            else if (gt === 'LineString' || gt === 'MultiLineString') lines.push(enriched);
            else if (gt === 'Polygon' || gt === 'MultiPolygon')       polys.push(enriched);
        }

        // ── Non-point source & layers ──
        const nonPoints = [...polys, ...lines];
        if (nonPoints.length) {
            if (this.map.getSource(sourceId)) {
                this.map.getSource(sourceId).setData({ type: 'FeatureCollection', features: nonPoints });
            } else {
                this.map.addSource(sourceId, { type: 'geojson', data: { type: 'FeatureCollection', features: nonPoints } });
            }

            if (polys.length) {
                if (!this.map.getLayer(fillId)) {
                    this.map.addLayer({ id: fillId, type: 'fill', source: sourceId,
                        filter: ['in', '$type', 'Polygon'],
                        paint: { 'fill-color': sty.fillColor || '#2563eb', 'fill-opacity': sty.fillOpacity ?? 0.3 }
                    });
                    layerIds.push(fillId);
                    this._addFeatureClickHandler(fillId, layerId);
                    this._addFeatureContextMenuHandler(fillId, layerId);
                }
                if (!this.map.getLayer(outlineId)) {
                    this.map.addLayer({ id: outlineId, type: 'line', source: sourceId,
                        filter: ['in', '$type', 'Polygon'],
                        paint: { 'line-color': sty.strokeColor || '#2563eb', 'line-width': sty.strokeWidth ?? 2, 'line-opacity': sty.strokeOpacity ?? 0.8 }
                    });
                    layerIds.push(outlineId);
                }
            }

            if (lines.length && !this.map.getLayer(lineId)) {
                this.map.addLayer({ id: lineId, type: 'line', source: sourceId,
                    filter: ['in', '$type', 'LineString'],
                    paint: { 'line-color': sty.strokeColor || '#2563eb', 'line-width': sty.strokeWidth ?? 2, 'line-opacity': sty.strokeOpacity ?? 0.8 }
                });
                layerIds.push(lineId);
                this._addFeatureClickHandler(lineId, layerId);
                this._addFeatureContextMenuHandler(lineId, layerId);
            }
        }

        // ── Point features (HTML markers) ──
        for (const pf of points) {
            const coords = pf.geometry.type === 'MultiPoint' ? pf.geometry.coordinates : [pf.geometry.coordinates];
            for (const coord of coords) {
                const el = _createPointMarkerEl(sty);
                const marker = new mapboxgl.Marker({ element: el, anchor: sty.pointSymbol === 'pin' ? 'bottom' : 'center' })
                    .setLngLat(coord)
                    .addTo(this.map);
                marker._featureIndex = pf.properties._featureIndex;
                marker._datasetId   = layerId;
                marker._feature     = pf;

                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const ll = { lat: coord[1], lng: coord[0] };
                    if (this._selectionMode) {
                        this._handleSelectionClick(layerId, pf.properties._featureIndex, e.shiftKey, sty.strokeColor);
                    } else {
                        const nearby = this._findFeaturesNearClick(ll, layerId, pf.properties._featureIndex);
                        this._popupHits  = nearby;
                        this._popupIndex = 0;
                        this._popupLatLng = ll;
                        this._renderCyclePopup();
                    }
                });
                el.addEventListener('contextmenu', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    bus.emit('map:contextmenu', {
                        latlng: { lat: coord[1], lng: coord[0] },
                        originalEvent: e, layerId,
                        featureIndex: pf.properties._featureIndex,
                        feature: pf
                    });
                });
                markers.push(marker);
            }
        }

        this.dataLayers.set(layerId, { sourceId, layerIds, markers, visible: true });

        if (fit && features.length) {
            try {
                const bbox = turf.bbox({ type: 'FeatureCollection', features });
                if (bbox.every(v => isFinite(v)))
                    this.map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 30, maxZoom: 16 });
            } catch (e) { logger.warn('Map', 'Could not fit bounds', { error: e.message }); }
        }

        if (features.length > 10000)
            logger.warn('Map', 'Large dataset — rendering may be slow', { count: features.length });

        logger.info('Map', 'Layer added', { name: this._layerNames.get(layerId), features: features.length });
        bus.emit('map:layerAdded', { id: layerId, name: this._layerNames.get(layerId) });
    }

    /* ─── Feature click / context-menu handlers ─── */

    _addFeatureClickHandler(mapLayerId, datasetId) {
        this.map.on('click', mapLayerId, (e) => {
            e._handled = true;
            if (!e.features?.length) return;
            const f = e.features[0];
            const idx = f.properties._featureIndex;
            const ll = { lat: e.lngLat.lat, lng: e.lngLat.lng };
            const sty = this._layerStyles.get(datasetId) || {};

            if (this._selectionMode) {
                this._handleSelectionClick(datasetId, idx, e.originalEvent?.shiftKey, sty.strokeColor);
            } else {
                const nearby = this._findFeaturesNearClick(ll, datasetId, idx);
                if (nearby.length > 1) this._showMultiPopup(nearby, ll);
                else { this._popupHits = nearby; this._popupIndex = 0; this._popupLatLng = ll; this._renderCyclePopup(); }
            }
        });
        this.map.on('mouseenter', mapLayerId, () => { if (!this._selectionMode) this.map.getCanvas().style.cursor = 'pointer'; });
        this.map.on('mouseleave', mapLayerId, () => { if (!this._selectionMode) this.map.getCanvas().style.cursor = ''; });
    }

    _addFeatureContextMenuHandler(mapLayerId, datasetId) {
        this.map.on('contextmenu', mapLayerId, (e) => {
            e._handled = true;
            if (!e.features?.length) return;
            const f = e.features[0];
            const origFeature = this._getOriginalFeature(datasetId, f.properties._featureIndex);
            bus.emit('map:contextmenu', {
                latlng: { lat: e.lngLat.lat, lng: e.lngLat.lng },
                originalEvent: e.originalEvent,
                layerId: datasetId,
                featureIndex: f.properties._featureIndex,
                feature: origFeature || f
            });
        });
    }

    _getOriginalFeature(layerId, idx) {
        return this._layerData.get(layerId)?.geojson?.features?.[idx] || null;
    }

    /* =========================================================
       REMOVE / TOGGLE / RESTYLE
       ========================================================= */

    removeLayer(id) {
        const info = this.dataLayers.get(id);
        if (info) {
            for (const lid of (info.layerIds || [])) { if (this.map.getLayer(lid)) this.map.removeLayer(lid); }
            if (info.sourceId && this.map.getSource(info.sourceId)) this.map.removeSource(info.sourceId);
            for (const m of (info.markers || [])) m.remove();
            this.dataLayers.delete(id);
        }
        this._layerNames.delete(id);
        this._layerData.delete(id);
        this.clearSelection(id);
    }

    toggleLayer(id, visible) {
        const info = this.dataLayers.get(id);
        if (!info) return;
        info.visible = visible;
        const vis = visible ? 'visible' : 'none';
        for (const lid of (info.layerIds || [])) { if (this.map.getLayer(lid)) this.map.setLayoutProperty(lid, 'visibility', vis); }
        for (const m of (info.markers || [])) m.getElement().style.display = visible ? '' : 'none';
    }

    restyleLayer(layerId, dataset, style) {
        this._layerStyles.set(layerId, { ...style });
        if (dataset.geojson) this._layerData.set(layerId, { geojson: dataset.geojson, colorIndex: 0 });
        this.removeLayer(layerId);
        this.addLayer(dataset, 0, { fit: false });
    }

    static get pointSymbols() { return Object.keys(SVG_FACTORIES); }

    syncLayerOrder(orderedIds) {
        for (const id of orderedIds) {
            const info = this.dataLayers.get(id);
            if (!info) continue;
            for (const lid of (info.layerIds || [])) { if (this.map.getLayer(lid)) this.map.moveLayer(lid); }
        }
    }

    /* =========================================================
       POPUPS
       ========================================================= */

    _buildPopupHtml(feature) {
        const props = feature.properties || {};
        let imgHtml = '';
        const imgSrc = props._thumbnailUrl || props._thumbnailDataUrl;
        if (imgSrc) {
            imgHtml = `<div style="margin-bottom:6px;text-align:center;"><img src="${imgSrc}" style="max-width:280px;max-height:200px;border-radius:4px;" /></div>`;
        }
        const rows = Object.entries(props)
            .filter(([k, v]) => v != null && !k.startsWith('_'))
            .map(([k, v]) => {
                if (v && typeof v === 'object' && v._att && v.dataUrl)
                    return `<tr><th>${k}</th><td style="padding:4px 0;"><img src="${v.dataUrl}" style="max-width:240px;max-height:180px;border-radius:4px;display:block;margin-bottom:2px;" /><span style="font-size:10px;color:#888;">${v.name || 'photo'}</span></td></tr>`;
                let val = v;
                if (typeof v === 'object') val = JSON.stringify(v);
                if (typeof val === 'string' && val.length > 100) val = val.slice(0, 100) + '…';
                return `<tr><th>${k}</th><td>${val}</td></tr>`;
            }).join('');
        return imgHtml + (rows ? `<table>${rows}</table>` : '<em>No attributes</em>');
    }

    showPopup(feature, _unused, latlng) {
        const html = this._buildPopupHtml(feature);
        const coords = latlng ? [latlng.lng, latlng.lat]
            : feature.geometry?.coordinates
                ? (feature.geometry.type === 'Point' ? feature.geometry.coordinates : turf.centroid(feature).geometry.coordinates)
                : null;
        if (!coords) return;
        if (this._popup) this._popup.remove();
        this._popup = new mapboxgl.Popup({ maxWidth: '350px', closeOnClick: true })
            .setLngLat(coords).setHTML(html).addTo(this.map);
        this._popup.on('close', () => { this.clearHighlight(); this._popup = null; });
    }

    _findFeaturesNearClick(latlng, clickedLayerId, clickedFeatureIndex) {
        const pt = turf.point([latlng.lng, latlng.lat]);
        const results = [];

        for (const [layerId, info] of this.dataLayers) {
            if (!info.visible) continue;
            const data = this._layerData.get(layerId);
            if (!data?.geojson?.features) continue;
            const sty   = this._layerStyles.get(layerId) || {};
            const color = sty.strokeColor || '#2563eb';

            // Marker proximity for points
            for (const marker of (info.markers || [])) {
                const mp = marker.getLngLat();
                const dist = turf.distance(pt, turf.point([mp.lng, mp.lat]), { units: 'meters' });
                const zf = Math.max(1, 20 - this.map.getZoom());
                if (dist < zf * 50) {
                    const orig = this._getOriginalFeature(layerId, marker._featureIndex);
                    if (orig) results.push({ feature: orig, featureIndex: marker._featureIndex, layerId, layerName: this._layerNames.get(layerId) || layerId, layerColor: color });
                }
            }

            // Non-point hit testing via turf
            for (const f of data.geojson.features) {
                if (!f.geometry) continue;
                const gt = f.geometry.type;
                if (gt === 'Point' || gt === 'MultiPoint') continue;
                let hit = false;
                if (gt === 'Polygon' || gt === 'MultiPolygon') {
                    try { hit = turf.booleanPointInPolygon(pt, f); } catch { hit = false; }
                } else if (gt === 'LineString' || gt === 'MultiLineString') {
                    try {
                        const nearest = turf.nearestPointOnLine(f, pt, { units: 'kilometers' });
                        if (nearest) { const dm = turf.distance(pt, nearest, { units: 'meters' }); const zf = Math.max(1, 20 - this.map.getZoom()); hit = dm < zf * 20; }
                    } catch { hit = false; }
                }
                if (hit) {
                    const fi = data.geojson.features.indexOf(f);
                    results.push({ feature: f, featureIndex: fi, layerId, layerName: this._layerNames.get(layerId) || layerId, layerColor: color });
                }
            }
        }

        // Ensure the originally-clicked feature is first
        if (clickedLayerId !== undefined && clickedFeatureIndex !== undefined) {
            const ci = results.findIndex(r => r.layerId === clickedLayerId && r.featureIndex === clickedFeatureIndex);
            if (ci > 0) { const [c] = results.splice(ci, 1); results.unshift(c); }
            else if (ci === -1) {
                const orig = this._getOriginalFeature(clickedLayerId, clickedFeatureIndex);
                if (orig) {
                    const sty = this._layerStyles.get(clickedLayerId) || {};
                    results.unshift({ feature: orig, featureIndex: clickedFeatureIndex, layerId: clickedLayerId, layerName: this._layerNames.get(clickedLayerId) || clickedLayerId, layerColor: sty.strokeColor || '#2563eb' });
                }
            }
        }
        const seen = new Set();
        return results.filter(r => { const k = `${r.layerId}:${r.featureIndex}`; if (seen.has(k)) return false; seen.add(k); return true; });
    }

    _showMultiPopup(hits, latlng) {
        if (!hits.length) return;
        this._popupHits = hits; this._popupIndex = 0; this._popupLatLng = latlng;
        this._renderCyclePopup();
    }

    _renderCyclePopup() {
        const hits = this._popupHits;
        const idx  = this._popupIndex;
        if (!hits?.[idx]) return;
        const hit = hits[idx];
        const body = this._buildPopupHtml(hit.feature);
        const label = `<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;border-bottom:1px solid var(--border);padding-bottom:3px;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${hit.layerColor};margin-right:4px;"></span><strong>${hit.layerName}</strong></div>`;
        let nav = '';
        if (hits.length > 1)
            nav = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;font-size:11px;"><button onclick="window._mapPopupNav(-1)" style="background:none;border:1px solid var(--border);color:var(--text);border-radius:3px;padding:1px 8px;cursor:pointer;font-size:13px;">&larr;</button><span>${idx + 1} of ${hits.length}</span><button onclick="window._mapPopupNav(1)" style="background:none;border:1px solid var(--border);color:var(--text);border-radius:3px;padding:1px 8px;cursor:pointer;font-size:13px;">&rarr;</button></div>`;
        const editBtn = `<div style="margin-top:6px;border-top:1px solid var(--border);padding-top:4px;text-align:right;"><button onclick="window._mapPopupEdit()" style="background:var(--primary);color:#fff;border:none;border-radius:4px;padding:3px 12px;cursor:pointer;font-size:12px;">✏️ Edit</button></div>`;

        if (this._popup) this._popup.remove();
        this._popup = new mapboxgl.Popup({ maxWidth: '350px', closeOnClick: false })
            .setLngLat([this._popupLatLng.lng, this._popupLatLng.lat])
            .setHTML(label + nav + body + editBtn)
            .addTo(this.map);
        this._popup.on('close', () => { this.clearHighlight(); this._popupHits = null; this._popup = null; });
    }

    /* =========================================================
       HIGHLIGHT
       ========================================================= */

    highlightFeature() { /* kept for API compat — highlighting handled via selection layers */ }

    clearHighlight() {
        for (const id of ['_highlight-fill', '_highlight-line', '_highlight-circle']) {
            if (this.map?.getLayer(id)) this.map.removeLayer(id);
        }
        if (this.map?.getSource('_highlight-src')) this.map.removeSource('_highlight-src');
        if (this._highlightMarker) { this._highlightMarker.remove(); this._highlightMarker = null; }
    }

    /* =========================================================
       FIT / BOUNDS
       ========================================================= */

    fitToAll() {
        const all = [];
        for (const [, d] of this._layerData) {
            if (d.geojson?.features) all.push(...d.geojson.features.filter(f => f.geometry));
        }
        if (!all.length) return;
        try {
            const bb = turf.bbox({ type: 'FeatureCollection', features: all });
            if (bb.every(v => isFinite(v))) this.map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 30, maxZoom: 16 });
        } catch {}
    }

    getBounds() { return this.map?.getBounds(); }
    getMap()    { return this.map; }

    /** Zoom to the bounds of a specific layer by ID */
    zoomToLayer(layerId, options = {}) {
        const data = this._layerData.get(layerId);
        if (!data?.geojson?.features?.length) return;
        const feats = data.geojson.features.filter(f => f.geometry);
        if (!feats.length) return;
        try {
            const bb = turf.bbox({ type: 'FeatureCollection', features: feats });
            if (bb.every(v => isFinite(v))) {
                this.map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: options.padding || 30, maxZoom: 16 });
            }
        } catch {}
    }

    /* =========================================================
       INTERACTIONS
       ========================================================= */

    startPointPick(prompt = 'Click the map to place a point') {
        return new Promise(resolve => {
            this._cancelInteraction();
            const canvas = this.map.getCanvas();
            canvas.style.cursor = 'crosshair';
            const banner = this._showInteractionBanner(prompt, () => { cleanup(); resolve(null); });

            const onClick = (e) => { cleanup(); resolve([e.lngLat.lng, e.lngLat.lat]); };
            const onKey   = (e) => { if (e.key === 'Escape') { cleanup(); resolve(null); } };

            const cleanup = () => { canvas.style.cursor = ''; this.map.off('click', onClick); document.removeEventListener('keydown', onKey); banner?.remove(); this._interactionCleanup = null; };
            this._interactionCleanup = cleanup;
            this.map.on('click', onClick);
            document.addEventListener('keydown', onKey);
        });
    }

    startTwoPointPick(prompt1 = 'Click the first point', prompt2 = 'Click the second point') {
        return new Promise(resolve => {
            this._cancelInteraction();
            const canvas = this.map.getCanvas();
            canvas.style.cursor = 'crosshair';
            const tempM = [];
            let first = null;
            const banner = this._showInteractionBanner(prompt1, () => { cleanup(); resolve(null); });

            const onKey = (e) => { if (e.key === 'Escape') { cleanup(); resolve(null); } };
            const onClick = (e) => {
                const c = [e.lngLat.lng, e.lngLat.lat];
                tempM.push(new mapboxgl.Marker({ color: '#d4a24e' }).setLngLat(c).addTo(this.map));
                if (!first) { first = c; banner.querySelector('.interaction-text').textContent = prompt2; }
                else { cleanup(); resolve([first, c]); }
            };
            const cleanup = () => { canvas.style.cursor = ''; this.map.off('click', onClick); document.removeEventListener('keydown', onKey); tempM.forEach(m => m.remove()); banner?.remove(); this._interactionCleanup = null; };
            this._interactionCleanup = cleanup;
            this.map.on('click', onClick);
            document.addEventListener('keydown', onKey);
        });
    }

    startRectangleDraw(prompt = 'Click and drag to draw a rectangle') {
        return new Promise(resolve => {
            this._cancelInteraction();
            const canvas = this.map.getCanvas();
            canvas.style.cursor = 'crosshair';
            const banner = this._showInteractionBanner(prompt, () => { cleanup(); resolve(null); });

            let start = null;
            const rSrc = '_rect-draw-src', rFill = '_rect-draw-fill', rLine = '_rect-draw-line';

            const onDown = (e) => { start = e.lngLat; this.map.dragPan.disable(); };
            const onMove = (e) => {
                if (!start) return;
                const bb = this._lngLatsToBbox(start, e.lngLat);
                const poly = turf.bboxPolygon(bb);
                if (this.map.getSource(rSrc)) this.map.getSource(rSrc).setData(poly);
                else {
                    this.map.addSource(rSrc, { type: 'geojson', data: poly });
                    this.map.addLayer({ id: rFill, type: 'fill', source: rSrc, paint: { 'fill-color': '#d4a24e', 'fill-opacity': 0.15 } });
                    this.map.addLayer({ id: rLine, type: 'line', source: rSrc, paint: { 'line-color': '#d4a24e', 'line-width': 2, 'line-dasharray': [6, 4] } });
                }
            };
            const onUp = (e) => {
                if (!start) return;
                this.map.dragPan.enable();
                const bb = this._lngLatsToBbox(start, e.lngLat);
                cleanup();
                resolve([bb[0], bb[1], bb[2], bb[3]]);
            };
            const onKey = (e) => { if (e.key === 'Escape') { this.map.dragPan.enable(); cleanup(); resolve(null); } };

            const cleanup = () => {
                canvas.style.cursor = '';
                this.map.off('mousedown', onDown); this.map.off('mousemove', onMove); this.map.off('mouseup', onUp);
                document.removeEventListener('keydown', onKey);
                if (this.map.getLayer(rFill)) this.map.removeLayer(rFill);
                if (this.map.getLayer(rLine)) this.map.removeLayer(rLine);
                if (this.map.getSource(rSrc)) this.map.removeSource(rSrc);
                banner?.remove(); this._interactionCleanup = null;
            };
            this._interactionCleanup = cleanup;
            this.map.on('mousedown', onDown); this.map.on('mousemove', onMove); this.map.on('mouseup', onUp);
            document.addEventListener('keydown', onKey);
        });
    }

    _lngLatsToBbox(a, b) {
        return [Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)];
    }

    /* =========================================================
       IMPORT FENCE
       ========================================================= */

    startImportFenceDraw() {
        this.clearImportFence();
        const isMobile = window.innerWidth < 768 || 'ontouchstart' in window;

        return new Promise(resolve => {
            this._cancelInteraction();
            const canvas = this.map.getCanvas();
            canvas.style.cursor = 'crosshair';
            const banner = this._showInteractionBanner(
                isMobile ? 'Tap and drag to draw your import fence.' : 'Click and drag to draw your import fence.',
                () => { cleanup(true); resolve(null); }
            );

            let start = null;
            const fSrc = '_fence-src', fFill = '_fence-fill', fLine = '_fence-line';
            const beginDraw  = ll => { start = ll; this.map.dragPan.disable(); };
            const updateDraw = ll => {
                if (!start) return;
                const bb = this._lngLatsToBbox(start, ll);
                const poly = turf.bboxPolygon(bb);
                if (this.map.getSource(fSrc)) this.map.getSource(fSrc).setData(poly);
                else {
                    this.map.addSource(fSrc, { type: 'geojson', data: poly });
                    this.map.addLayer({ id: fFill, type: 'fill', source: fSrc, paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.08 } });
                    this.map.addLayer({ id: fLine, type: 'line', source: fSrc, paint: { 'line-color': '#f59e0b', 'line-width': 2.5, 'line-dasharray': [8, 5] } });
                }
            };
            const endDraw = ll => {
                if (!start) return;
                this.map.dragPan.enable();
                const bb = this._lngLatsToBbox(start, ll);
                this._importFence = { bbox: bb, fSrc, fFill, fLine };
                cleanup(false);
                resolve([bb[0], bb[1], bb[2], bb[3]]);
            };

            const onDown = e => beginDraw(e.lngLat);
            const onMove = e => updateDraw(e.lngLat);
            const onUp   = e => endDraw(e.lngLat);

            const container = this.map.getContainer();
            const touchLL = t => { const r = container.getBoundingClientRect(); return this.map.unproject(new mapboxgl.Point(t.clientX - r.left, t.clientY - r.top)); };
            const onTS = e => { if (e.touches.length === 1) { e.preventDefault(); beginDraw(touchLL(e.touches[0])); } };
            const onTM = e => { if (start && e.touches.length === 1) { e.preventDefault(); updateDraw(touchLL(e.touches[0])); } };
            const onTE = e => { if (start) { e.preventDefault(); endDraw(touchLL(e.changedTouches[0])); } };

            const onKey = e => { if (e.key === 'Escape') { this.map.dragPan.enable(); cleanup(true); resolve(null); } };

            const cleanup = (removeRect = true) => {
                canvas.style.cursor = '';
                this.map.off('mousedown', onDown); this.map.off('mousemove', onMove); this.map.off('mouseup', onUp);
                container.removeEventListener('touchstart', onTS);
                container.removeEventListener('touchmove', onTM);
                container.removeEventListener('touchend', onTE);
                document.removeEventListener('keydown', onKey);
                if (removeRect) {
                    if (this.map.getLayer(fFill)) this.map.removeLayer(fFill);
                    if (this.map.getLayer(fLine)) this.map.removeLayer(fLine);
                    if (this.map.getSource(fSrc)) this.map.removeSource(fSrc);
                }
                banner?.remove(); this._interactionCleanup = null;
            };
            this._interactionCleanup = cleanup;
            this.map.on('mousedown', onDown); this.map.on('mousemove', onMove); this.map.on('mouseup', onUp);
            container.addEventListener('touchstart', onTS, { passive: false });
            container.addEventListener('touchmove', onTM, { passive: false });
            container.addEventListener('touchend', onTE, { passive: false });
            document.addEventListener('keydown', onKey);
        });
    }

    clearImportFence() {
        if (!this._importFence) return;
        const f = this._importFence;
        if (this.map.getLayer(f.fFill)) this.map.removeLayer(f.fFill);
        if (this.map.getLayer(f.fLine)) this.map.removeLayer(f.fLine);
        if (this.map.getSource(f.fSrc)) this.map.removeSource(f.fSrc);
        this._importFence = null;
        bus.emit('importFence:cleared');
    }

    getImportFenceBbox()          { return this._importFence?.bbox || null; }
    getImportFenceEsriEnvelope()  { if (!this._importFence) return null; const b = this._importFence.bbox; return { xmin: b[0], ymin: b[1], xmax: b[2], ymax: b[3], spatialReference: { wkid: 4326 } }; }
    get hasImportFence()          { return !!this._importFence; }

    /* =========================================================
       TEMP FEATURES
       ========================================================= */

    showTempFeature(geojson, duration = 10000) {
        const uid  = `_temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const sId  = `${uid}-src`, fId  = `${uid}-fill`, lId  = `${uid}-line`;
        this.map.addSource(sId, { type: 'geojson', data: geojson });
        this.map.addLayer({ id: fId, type: 'fill', source: sId, paint: { 'fill-color': '#d4a24e', 'fill-opacity': 0.25 }, filter: ['in', '$type', 'Polygon'] });
        this.map.addLayer({ id: lId, type: 'line', source: sId, paint: { 'line-color': '#d4a24e', 'line-width': 3 } });

        const tm = [];
        const addPt = c => tm.push(new mapboxgl.Marker({ color: '#d4a24e' }).setLngLat(c).addTo(this.map));
        if (geojson.features) geojson.features.filter(f => f.geometry?.type === 'Point').forEach(f => addPt(f.geometry.coordinates));
        else if (geojson.geometry?.type === 'Point') addPt(geojson.geometry.coordinates);

        const rm = () => { try { if (this.map.getLayer(fId)) this.map.removeLayer(fId); if (this.map.getLayer(lId)) this.map.removeLayer(lId); if (this.map.getSource(sId)) this.map.removeSource(sId); tm.forEach(m => m.remove()); } catch {} };
        if (duration > 0) setTimeout(rm, duration);
        return { remove: rm };
    }

    _cancelInteraction() { if (this._interactionCleanup) { this._interactionCleanup(); this._interactionCleanup = null; } }

    _showInteractionBanner(text, onCancel) {
        const b = document.createElement('div');
        b.className = 'map-interaction-banner';
        b.innerHTML = `<span class="interaction-text">${text}</span><button class="interaction-cancel">✕ Cancel</button><span style="font-size:11px;opacity:0.6;margin-left:8px;">(Esc to cancel)</span>`;
        b.querySelector('.interaction-cancel').onclick = onCancel;
        this.map.getContainer().appendChild(b);
        return b;
    }

    /* =========================================================
       SELECTION SYSTEM
       ========================================================= */

    static get SELECTION_STYLE()       { return { color: '#00e5ff', weight: 3, opacity: 1, fillColor: '#00e5ff', fillOpacity: 0.35, dashArray: null }; }
    static get SELECTION_POINT_STYLE() { return { radius: 8, fillColor: '#00e5ff', color: '#ffffff', weight: 3, fillOpacity: 1 }; }

    enterSelectionMode() {
        this._selectionMode = true;
        this.map.getCanvas().style.cursor = 'pointer';
        this._selectionBanner = this._showInteractionBanner('Selection mode — click features or draw a box to multiselect (Shift+click then drag).', () => this.exitSelectionMode());
        this._setupRectangleSelect();
        bus.emit('selection:modeChanged', true);
        logger.info('Map', 'Selection mode enabled');
    }

    exitSelectionMode() {
        this._selectionMode = false;
        this.map.getCanvas().style.cursor = '';
        this._selectionBanner?.remove(); this._selectionBanner = null;
        this._rectSelectCleanup?.(); this._rectSelectCleanup = null;
        bus.emit('selection:modeChanged', false);
        logger.info('Map', 'Selection mode disabled');
    }

    isSelectionMode() { return this._selectionMode; }

    _handleSelectionClick(layerId, featureIndex, shiftKey, layerColor) {
        if (!this._selections.has(layerId)) this._selections.set(layerId, new Set());
        const sel = this._selections.get(layerId);
        if (shiftKey) { if (sel.has(featureIndex)) sel.delete(featureIndex); else sel.add(featureIndex); }
        else {
            for (const lid of this._selections.keys()) { this._selections.set(lid, new Set()); this._renderSelectionHighlights(lid); }
            this._selections.set(layerId, new Set([featureIndex]));
        }
        this._renderSelectionHighlights(layerId);
        bus.emit('selection:changed', { layerId, count: this.getSelectionCount(layerId), totalCount: this.getTotalSelectionCount() });
    }

    _setupRectangleSelect() {
        let start = null, dragging = false;
        const rSrc = '_sel-rect-src', rLay = '_sel-rect-lay';

        const onDown = e => { if (!e.originalEvent.shiftKey && !e.originalEvent.ctrlKey) return; start = e.lngLat; dragging = true; this.map.dragPan.disable(); };
        const onMove = e => {
            if (!dragging) return;
            const bb = this._lngLatsToBbox(start, e.lngLat);
            const poly = turf.bboxPolygon(bb);
            if (this.map.getSource(rSrc)) this.map.getSource(rSrc).setData(poly);
            else { this.map.addSource(rSrc, { type: 'geojson', data: poly }); this.map.addLayer({ id: rLay, type: 'fill', source: rSrc, paint: { 'fill-color': '#00e5ff', 'fill-opacity': 0.1 } }); }
        };
        const onUp = e => {
            if (!dragging) return;
            this.map.dragPan.enable(); dragging = false;
            const bb = this._lngLatsToBbox(start, e.lngLat); start = null;
            setTimeout(() => { if (this.map.getLayer(rLay)) this.map.removeLayer(rLay); if (this.map.getSource(rSrc)) this.map.removeSource(rSrc); }, 400);
            this._selectFeaturesInBounds(bb, e.originalEvent?.shiftKey);
        };

        this.map.on('mousedown', onDown); this.map.on('mousemove', onMove); this.map.on('mouseup', onUp);
        this._rectSelectCleanup = () => {
            this.map.off('mousedown', onDown); this.map.off('mousemove', onMove); this.map.off('mouseup', onUp);
            if (this.map.getLayer(rLay)) this.map.removeLayer(rLay);
            if (this.map.getSource(rSrc)) this.map.removeSource(rSrc);
            this.map.dragPan.enable();
        };
    }

    _selectFeaturesInBounds(bbox, addToExisting) {
        if (!addToExisting) for (const lid of this._selections.keys()) this._selections.set(lid, new Set());
        const bboxPoly = turf.bboxPolygon(bbox);

        for (const [layerId, data] of this._layerData) {
            const info = this.dataLayers.get(layerId);
            if (!info?.visible || !data.geojson?.features) continue;
            if (!this._selections.has(layerId)) this._selections.set(layerId, new Set());
            const sel = this._selections.get(layerId);

            for (let i = 0; i < data.geojson.features.length; i++) {
                const f = data.geojson.features[i];
                if (!f.geometry) continue;
                try { if (turf.booleanIntersects(f, bboxPoly)) sel.add(i); }
                catch { try { const fb = turf.bbox(f); if (fb[0] <= bbox[2] && fb[2] >= bbox[0] && fb[1] <= bbox[3] && fb[3] >= bbox[1]) sel.add(i); } catch {} }
            }
            this._renderSelectionHighlights(layerId);
        }
        const total = this.getTotalSelectionCount();
        bus.emit('selection:changed', { totalCount: total });
        if (total) logger.info('Map', `Box selected ${total} feature(s)`);
    }

    _renderSelectionHighlights(layerId) {
        const hSrc = `_sel-hl-${layerId}`, hFill = `_sel-hl-fill-${layerId}`, hLine = `_sel-hl-line-${layerId}`;
        if (this.map.getLayer(hFill)) this.map.removeLayer(hFill);
        if (this.map.getLayer(hLine)) this.map.removeLayer(hLine);
        if (this.map.getSource(hSrc)) this.map.removeSource(hSrc);
        if (this._selectionMarkers.get(layerId)) { this._selectionMarkers.get(layerId).forEach(m => m.remove()); this._selectionMarkers.delete(layerId); }

        const sel = this._selections.get(layerId);
        if (!sel?.size) return;
        const data = this._layerData.get(layerId);
        if (!data?.geojson?.features) return;

        const nonPts = [], pts = [];
        for (const i of sel) {
            const f = data.geojson.features[i];
            if (!f?.geometry) continue;
            (f.geometry.type === 'Point' || f.geometry.type === 'MultiPoint') ? pts.push(f) : nonPts.push(f);
        }

        if (nonPts.length) {
            this.map.addSource(hSrc, { type: 'geojson', data: { type: 'FeatureCollection', features: nonPts } });
            this.map.addLayer({ id: hFill, type: 'fill', source: hSrc, paint: { 'fill-color': '#00e5ff', 'fill-opacity': 0.35 }, filter: ['in', '$type', 'Polygon'] });
            this.map.addLayer({ id: hLine, type: 'line', source: hSrc, paint: { 'line-color': '#00e5ff', 'line-width': 3 } });
        }

        if (pts.length) {
            const markers = [];
            for (const f of pts) {
                const coords = f.geometry.type === 'MultiPoint' ? f.geometry.coordinates : [f.geometry.coordinates];
                for (const c of coords) {
                    const el = document.createElement('div');
                    el.style.cssText = 'width:16px;height:16px;border-radius:50%;background:#00e5ff;border:3px solid #fff;pointer-events:none;';
                    markers.push(new mapboxgl.Marker({ element: el, anchor: 'center' }).setLngLat(c).addTo(this.map));
                }
            }
            this._selectionMarkers.set(layerId, markers);
        }
    }

    getSelectedIndices(layerId) { return [...(this._selections.get(layerId) || [])]; }
    getSelectedFeatures(layerId, geojson) {
        const idx = this.getSelectedIndices(layerId);
        if (!idx.length) return null;
        return { type: 'FeatureCollection', features: geojson.features.filter((_, i) => idx.includes(i)) };
    }
    getSelectionCount(layerId)  { return this._selections.get(layerId)?.size || 0; }
    getTotalSelectionCount()    { let t = 0; for (const s of this._selections.values()) t += s.size; return t; }

    clearSelection(layerId = null) {
        if (layerId) { this._selections.delete(layerId); this._renderSelectionHighlights(layerId); }
        else { const ids = [...this._selections.keys()]; this._selections.clear(); ids.forEach(id => this._renderSelectionHighlights(id)); }
        bus.emit('selection:changed', { layerId, totalCount: this.getTotalSelectionCount() });
    }

    selectFeatures(layerId, indices) {
        this._selections.set(layerId, new Set(indices));
        this._renderSelectionHighlights(layerId);
        bus.emit('selection:changed', { layerId, count: indices.length, totalCount: this.getTotalSelectionCount() });
    }

    selectAll(layerId, geojson)     { this.selectFeatures(layerId, geojson.features.map((_, i) => i)); }
    invertSelection(layerId, geojson) {
        const cur = this._selections.get(layerId) || new Set();
        this.selectFeatures(layerId, geojson.features.map((_, i) => i).filter(i => !cur.has(i)));
    }

    /* =========================================================
       DESTROY
       ========================================================= */

    destroy() {
        this._cancelInteraction();
        this.clearSelection();
        if (this._selectionMode) this.exitSelectionMode();
        if (this.map) { this.map.remove(); this.map = null; }
        this.dataLayers.clear(); this._layerData.clear();
    }

    /* =========================================================
       COORDINATE SEARCH
       ========================================================= */

    _initCoordSearch() {
        class SearchControl {
            onAdd(map) {
                this._map = map;
                this._container = document.createElement('div');
                this._container.className = 'mapboxgl-ctrl coord-search-control';
                const btn = document.createElement('a');
                btn.href = '#'; btn.title = 'Search Coordinates'; btn.className = 'coord-search-toggle';
                btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;

                const panel = document.createElement('div');
                panel.className = 'coord-search-panel'; panel.style.display = 'none';
                const input = document.createElement('input');
                input.className = 'coord-search-input'; input.type = 'text'; input.placeholder = 'Enter coordinates…'; input.autocomplete = 'off';
                const goBtn = document.createElement('button');
                goBtn.className = 'coord-search-go'; goBtn.innerHTML = '→'; goBtn.title = 'Search';
                const clearBtn = document.createElement('button');
                clearBtn.className = 'coord-search-clear'; clearBtn.innerHTML = '✕'; clearBtn.title = 'Clear & close'; clearBtn.style.display = 'none';

                panel.appendChild(input); panel.appendChild(goBtn); panel.appendChild(clearBtn);
                this._container.appendChild(btn); this._container.appendChild(panel);
                this._panel = panel; this._input = input; this._clearBtn = clearBtn; this._btn = btn; this._goBtn = goBtn;

                btn.onclick = e => { e.preventDefault(); const open = panel.style.display !== 'none'; panel.style.display = open ? 'none' : 'flex'; if (!open) setTimeout(() => input.focus(), 50); };
                return this._container;
            }
            onRemove() { this._container.parentNode?.removeChild(this._container); }
        }

        const ctrl = new SearchControl();
        this.map.addControl(ctrl, 'top-left');

        setTimeout(() => {
            const { _input: input, _clearBtn: clearBtn, _goBtn: goBtn, _panel: panel } = ctrl;
            const doSearch = () => {
                const val = input.value.trim();
                if (!val) return;
                const r = this._parseCoordinates(val);
                if (r) { this._placeSearchMarker(r.lat, r.lng, val, r.format); clearBtn.style.display = ''; input.blur(); }
                else { input.style.outline = '2px solid #e74c3c'; setTimeout(() => input.style.outline = '', 1200); }
            };
            goBtn.onclick = doSearch;
            input.onkeydown = e => { if (e.key === 'Enter') doSearch(); if (e.key === 'Escape') panel.style.display = 'none'; };
            clearBtn.onclick = () => { this._clearSearchMarker(); input.value = ''; clearBtn.style.display = 'none'; panel.style.display = 'none'; };
        }, 0);
    }

    _parseCoordinates(input) {
        const s = input.trim();

        /* Decimal Degrees */
        const dd = s.match(/^([+-]?\d+\.?\d*)[,\s]+([+-]?\d+\.?\d*)$/);
        if (dd) {
            const a = parseFloat(dd[1]), b = parseFloat(dd[2]);
            if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lng: b, format: 'DD' };
            if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return { lat: b, lng: a, format: 'DD' };
        }

        /* DMS with symbols */
        const dmsRx = /(\d+)[°]\s*(\d+)[′']\s*(\d+\.?\d*)[″"]\s*([NSEW])/gi;
        const dms = [...s.matchAll(dmsRx)];
        if (dms.length >= 2) {
            const p = m => { let d = parseInt(m[1]) + parseInt(m[2]) / 60 + parseFloat(m[3]) / 3600; if ('SW'.includes(m[4].toUpperCase())) d = -d; return d; };
            const v1 = p(dms[0]), v2 = p(dms[1]), d1 = dms[0][4].toUpperCase();
            const lat = 'NS'.includes(d1) ? v1 : v2, lng = 'EW'.includes(d1) ? v1 : v2;
            if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng, format: 'DMS' };
        }

        /* DMS plain */
        const dp = s.match(/(-?\d+)\s+(\d+)\s+(\d+\.?\d*)\s*([NSEW])[,\s]+(-?\d+)\s+(\d+)\s+(\d+\.?\d*)\s*([NSEW])/i);
        if (dp) {
            let lat = parseInt(dp[1]) + parseInt(dp[2]) / 60 + parseFloat(dp[3]) / 3600; if (dp[4].toUpperCase() === 'S') lat = -lat;
            let lng = parseInt(dp[5]) + parseInt(dp[6]) / 60 + parseFloat(dp[7]) / 3600; if (dp[8].toUpperCase() === 'W') lng = -lng;
            if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng, format: 'DMS' };
        }

        /* DDM */
        const ddmRx = /(\d+)[°]\s*(\d+\.?\d*)[′']\s*([NSEW])/gi;
        const ddm = [...s.matchAll(ddmRx)];
        if (ddm.length >= 2) {
            const p = m => { let d = parseInt(m[1]) + parseFloat(m[2]) / 60; if ('SW'.includes(m[3].toUpperCase())) d = -d; return d; };
            const v1 = p(ddm[0]), v2 = p(ddm[1]), d1 = ddm[0][3].toUpperCase();
            const lat = 'NS'.includes(d1) ? v1 : v2, lng = 'EW'.includes(d1) ? v1 : v2;
            if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng, format: 'DDM' };
        }

        /* Google Maps URL */
        const gm = s.match(/@([+-]?\d+\.?\d*),([+-]?\d+\.?\d*)/);
        if (gm) { const lat = parseFloat(gm[1]), lng = parseFloat(gm[2]); if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng, format: 'URL' }; }

        return null;
    }

    _placeSearchMarker(lat, lng, inputText, format) {
        this._clearSearchMarker();
        this._searchLatLng = { lat, lng, inputText, format };
        const el = document.createElement('div');
        el.className = 'coord-search-marker';
        el.innerHTML = `<div class="coord-pin"><svg viewBox="0 0 24 36" width="28" height="42"><path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 24 12 24s12-15 12-24C24 5.4 18.6 0 12 0z" fill="#e74c3c" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="11" r="4.5" fill="#fff"/></svg></div>`;
        this._searchMarker = new mapboxgl.Marker({ element: el, anchor: 'bottom' }).setLngLat([lng, lat]).addTo(this.map);
        const popup = new mapboxgl.Popup({ maxWidth: '280px', className: 'coord-search-popup' }).setHTML(this._buildSearchPopup(lat, lng, format));
        this._searchMarker.setPopup(popup).togglePopup();
        this.map.flyTo({ center: [lng, lat], zoom: Math.max(this.map.getZoom(), 14) });
    }

    _buildSearchPopup(lat, lng, format) {
        return `<div class="coord-popup-content"><div style="font-weight:600;margin-bottom:4px;">📍 ${format} Coordinate</div><div style="font-size:12px;color:#666;margin-bottom:8px;font-family:monospace;">${lat.toFixed(6)}, ${lng.toFixed(6)}</div><div style="display:flex;flex-direction:column;gap:4px;"><button class="coord-popup-btn coord-add-new" onclick="window.app._coordSearchAddNew()">＋ Add as New Layer</button><button class="coord-popup-btn coord-add-existing" onclick="window.app._coordSearchAddToExisting()">↳ Add to Existing Layer</button><button class="coord-popup-btn coord-dismiss" onclick="window.app._coordSearchClear()">✕ Dismiss</button></div></div>`;
    }

    _clearSearchMarker() { if (this._searchMarker) { this._searchMarker.remove(); this._searchMarker = null; } this._searchLatLng = null; }
    getSearchLatLng() { return this._searchLatLng; }
}

export const mapManager = new MapManager();
export default mapManager;
