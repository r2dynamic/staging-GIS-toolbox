/**
 * Draw Manager — Create and edit features directly on the map
 * Supports drawing points, lines, and polygons into a target layer.
 * Uses native Mapbox GL JS events (no external draw library required).
 */
import bus from '../core/event-bus.js';
import logger from '../core/logger.js';
import mapManager from './map-manager.js';

const DRAW_COLOR  = '#01bcdd';
const DRAW_WEIGHT = 3;

class DrawManager {
    constructor() {
        this._active = false;
        this._tool = null;          // 'point' | 'line' | 'polygon' | null
        this._targetLayerId = null;
        this._vertices = [];        // [{lat, lng}]
        this._toolbar = null;
        this._escHandler = null;
        this._clickHandler = null;
        this._moveHandler = null;
        this._dblClickHandler = null;
        this._enterHandler = null;
        this._clickTimeout = null;
        this._finishing = false;
        this._lastTapTime = 0;

        // Guard: skip a dblclick that arrives after finish + restart
        this._skipNextDblClick = false;

        // Mapbox preview ids
        this._previewSrcId   = '_draw-preview-src';
        this._previewLineId  = '_draw-preview-line';
        this._previewFillId  = '_draw-preview-fill';
        this._rubberSrcId    = '_draw-rubber-src';
        this._rubberLineId   = '_draw-rubber-line';
        this._vertexMarkers  = [];  // mapboxgl.Marker[]
    }

    get map() { return mapManager.map; }
    get isDrawing() { return this._active && this._tool !== null; }
    get activeTool() { return this._tool; }
    get targetLayerId() { return this._targetLayerId; }

    // ============================
    // Toolbar UI
    // ============================

    showToolbar(layerId, layerName) {
        this.hideToolbar();
        this._targetLayerId = layerId;

        const toolbar = document.createElement('div');
        toolbar.className = 'draw-toolbar';
        toolbar.innerHTML = `
            <div class="draw-toolbar-header">
                <span class="draw-toolbar-title">✏️ Draw: <strong>${layerName}</strong></span>
                <button class="draw-toolbar-close" title="Close draw tools">✕</button>
            </div>
            <div class="draw-toolbar-tools">
                <button class="draw-tool-btn" data-tool="point" title="Draw point">
                    <svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4" fill="currentColor"/></svg>
                    <span>Point</span>
                </button>
                <button class="draw-tool-btn" data-tool="line" title="Draw line">
                    <svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 14L14 2" stroke="currentColor" stroke-width="2" fill="none"/></svg>
                    <span>Line</span>
                </button>
                <button class="draw-tool-btn" data-tool="polygon" title="Draw polygon">
                    <svg width="16" height="16" viewBox="0 0 16 16"><polygon points="8,1 15,12 1,12" stroke="currentColor" stroke-width="1.5" fill="currentColor" fill-opacity="0.3"/></svg>
                    <span>Polygon</span>
                </button>
            </div>
            <div class="draw-toolbar-hint"></div>
            <button class="draw-finish-btn" style="display:none;">✓ Finish</button>
        `;

        toolbar.querySelector('.draw-toolbar-close').onclick = () => this.hideToolbar();
        toolbar.querySelector('.draw-finish-btn').onclick = (e) => { e.stopPropagation(); this._finishDraw(); };
        toolbar.querySelectorAll('.draw-tool-btn').forEach(btn => {
            btn.onclick = (e) => { e.stopPropagation(); this._tool === btn.dataset.tool ? this.cancelDraw() : this.startTool(btn.dataset.tool); };
        });
        toolbar.addEventListener('click', e => e.stopPropagation());
        toolbar.addEventListener('dblclick', e => e.stopPropagation());
        toolbar.addEventListener('mousedown', e => e.stopPropagation());

        this.map.getContainer().appendChild(toolbar);
        this._toolbar = toolbar;
        this._active = true;

        logger.info('Draw', `Draw toolbar opened for layer: ${layerName}`);
        bus.emit('draw:toolbarOpened', { layerId });
    }

    hideToolbar() {
        this.cancelDraw();
        if (this._toolbar) { this._toolbar.remove(); this._toolbar = null; }
        this._active = false;
        this._targetLayerId = null;
        bus.emit('draw:toolbarClosed');
    }

    _setHint(text) {
        if (!this._toolbar) return;
        const h = this._toolbar.querySelector('.draw-toolbar-hint');
        if (h) h.textContent = text;
    }

    _updateToolButtons() {
        if (!this._toolbar) return;
        this._toolbar.querySelectorAll('.draw-tool-btn').forEach(btn =>
            btn.classList.toggle('active', btn.dataset.tool === this._tool));
    }

    // ============================
    // Drawing tools
    // ============================

    startTool(tool) {
        this.cancelDraw();
        this._tool = tool;
        this._vertices = [];
        this._finishing = false;
        this._skipNextDblClick = false;
        this._updateToolButtons();

        if (mapManager._selectionMode) mapManager.exitSelectionMode();
        this.map.getCanvas().style.cursor = 'crosshair';

        this._clickHandler    = (e) => this._onMapClick(e);
        this._moveHandler     = (e) => this._onMapMove(e);
        this._dblClickHandler = (e) => this._onMapDblClick(e);
        this._escHandler      = (e) => { if (e.key === 'Escape') this.cancelDraw(); };

        this.map.on('click', this._clickHandler);
        this.map.on('mousemove', this._moveHandler);
        document.addEventListener('keydown', this._escHandler);

        if (tool === 'line' || tool === 'polygon') {
            this.map.doubleClickZoom.disable();
            this.map.on('dblclick', this._dblClickHandler);
            const mobile = window.innerWidth < 768 || 'ontouchstart' in window;
            this._setHint(tool === 'line'
                ? (mobile ? 'Tap to add vertices. Tap Finish when done.' : 'Click to add vertices. Double-click or Enter to finish.')
                : (mobile ? 'Tap to add vertices. Tap Finish to close polygon.' : 'Click to add vertices. Double-click or Enter to close polygon.'));
        } else if (tool === 'point') {
            this._setHint(window.innerWidth < 768 ? 'Tap on the map to place a point.' : 'Click on the map to place a point.');
        }

        this._enterHandler = (e) => {
            if (e.key === 'Enter') {
                const min = this._tool === 'polygon' ? 3 : 2;
                if (this._vertices.length >= min) this._finishDraw();
            }
        };
        document.addEventListener('keydown', this._enterHandler);

        logger.info('Draw', `Started tool: ${tool}`);
    }

    cancelDraw() {
        this._clearPreview();
        this._vertices = [];
        this._tool = null;
        this._finishing = false;
        this._lastTapTime = 0;
        this._updateToolButtons();
        this._setHint('');
        this._updateFinishBtn();

        if (this._clickTimeout) { clearTimeout(this._clickTimeout); this._clickTimeout = null; }
        if (this.map) { this.map.getCanvas().style.cursor = ''; this.map.doubleClickZoom.enable(); }

        if (this._clickHandler)    { this.map?.off('click', this._clickHandler);    this._clickHandler = null; }
        if (this._moveHandler)     { this.map?.off('mousemove', this._moveHandler); this._moveHandler = null; }
        if (this._dblClickHandler) { this.map?.off('dblclick', this._dblClickHandler); this._dblClickHandler = null; }
        if (this._escHandler)      { document.removeEventListener('keydown', this._escHandler);  this._escHandler = null; }
        if (this._enterHandler)    { document.removeEventListener('keydown', this._enterHandler); this._enterHandler = null; }
    }

    // ============================
    // Map event handlers
    // ============================

    _onMapClick(e) {
        if (e.originalEvent) { e.originalEvent.stopPropagation(); e.originalEvent._drawHandled = true; }
        e._handled = true;
        if (this._finishing) return;

        // Mapbox uses lngLat instead of Leaflet's latlng
        const { lat, lng } = e.lngLat;

        if (this._tool === 'point') {
            this._createFeature('Point', [[lng, lat]]);
            return;
        }

        // Mobile double-tap detection
        const now = Date.now();
        if (now - this._lastTapTime < 400) {
            this._lastTapTime = 0;
            if (this._clickTimeout) { clearTimeout(this._clickTimeout); this._clickTimeout = null; }
            this._addVertex(lat, lng);
            const min = this._tool === 'polygon' ? 3 : 2;
            if (this._vertices.length >= min) this._finishDraw();
            return;
        }
        this._lastTapTime = now;

        if (this._clickTimeout) clearTimeout(this._clickTimeout);
        this._clickTimeout = setTimeout(() => {
            this._clickTimeout = null;
            if (this._finishing) return;
            this._addVertex(lat, lng);
        }, 200);
    }

    _addVertex(lat, lng) {
        this._vertices.push({ lat, lng });
        this._addVertexMarker(lng, lat);
        this._updatePreviewLine();

        const n = this._vertices.length;
        const mobile = window.innerWidth < 768 || 'ontouchstart' in window;
        const fHint = mobile ? 'Tap Finish when done.' : 'Double-click or Enter to finish.';
        const cHint = mobile ? 'Tap Finish to close polygon.' : 'Double-click or Enter to close polygon.';
        if (this._tool === 'line') this._setHint(`${n} vertex${n > 1 ? 'es' : ''} placed. ${fHint}`);
        else this._setHint(`${n} vertex${n > 1 ? 'es' : ''} placed. ${n < 3 ? 'Need at least 3.' : cHint}`);
        this._updateFinishBtn();
    }

    _updateFinishBtn() {
        if (!this._toolbar) return;
        const btn = this._toolbar.querySelector('.draw-finish-btn');
        if (!btn) return;
        const min = this._tool === 'polygon' ? 3 : 2;
        btn.style.display = (this._tool === 'line' || this._tool === 'polygon') && this._vertices.length >= min ? '' : 'none';
    }

    _onMapMove(e) {
        if (this._tool === 'point' || !this._vertices.length) return;
        this._updateRubberBand(e.lngLat);
    }

    _onMapDblClick(e) {
        if (e.originalEvent) { e.originalEvent.preventDefault(); e.originalEvent.stopPropagation(); e.originalEvent._drawHandled = true; }
        e._handled = true;
        if (this._skipNextDblClick) { this._skipNextDblClick = false; return; }
        if (this._finishing) return;
        if (this._clickTimeout) { clearTimeout(this._clickTimeout); this._clickTimeout = null; }
        if (e.lngLat) this._addVertex(e.lngLat.lat, e.lngLat.lng);
        const min = this._tool === 'polygon' ? 3 : 2;
        if (this._vertices.length >= min) this._finishDraw();
    }

    // ============================
    // Preview rendering (Mapbox)
    // ============================

    _addVertexMarker(lng, lat) {
        const el = document.createElement('div');
        el.style.cssText = `width:10px;height:10px;border-radius:50%;background:#fff;border:2px solid ${DRAW_COLOR};pointer-events:none;`;
        const m = new mapboxgl.Marker({ element: el, anchor: 'center' })
            .setLngLat([lng, lat])
            .addTo(this.map);
        this._vertexMarkers.push(m);
    }

    _updatePreviewLine() {
        if (this._vertices.length < 2) {
            this._removePreviewLine();
            return;
        }

        const coords = this._vertices.map(v => [v.lng, v.lat]);
        if (this._tool === 'polygon' && this._vertices.length >= 3) coords.push(coords[0]);

        const geojson = {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: coords }
        };

        if (this.map.getSource(this._previewSrcId)) {
            this.map.getSource(this._previewSrcId).setData(geojson);
        } else {
            this.map.addSource(this._previewSrcId, { type: 'geojson', data: geojson });
            this.map.addLayer({
                id: this._previewLineId, type: 'line', source: this._previewSrcId,
                paint: { 'line-color': DRAW_COLOR, 'line-width': DRAW_WEIGHT, 'line-opacity': 0.9, 'line-dasharray': [6, 4] }
            });
        }
    }

    _removePreviewLine() {
        if (this.map.getLayer(this._previewLineId)) this.map.removeLayer(this._previewLineId);
        if (this.map.getSource(this._previewSrcId)) this.map.removeSource(this._previewSrcId);
    }

    _updateRubberBand(cursorLngLat) {
        const last = this._vertices[this._vertices.length - 1];
        if (!last) return;

        const coords = [[last.lng, last.lat], [cursorLngLat.lng, cursorLngLat.lat]];
        if (this._tool === 'polygon' && this._vertices.length >= 2)
            coords.push([this._vertices[0].lng, this._vertices[0].lat]);

        const geojson = { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } };

        if (this.map.getSource(this._rubberSrcId)) {
            this.map.getSource(this._rubberSrcId).setData(geojson);
        } else {
            this.map.addSource(this._rubberSrcId, { type: 'geojson', data: geojson });
            this.map.addLayer({
                id: this._rubberLineId, type: 'line', source: this._rubberSrcId,
                paint: { 'line-color': DRAW_COLOR, 'line-width': DRAW_WEIGHT, 'line-opacity': 0.5, 'line-dasharray': [4, 6] }
            });
        }
    }

    _clearPreview() {
        this._vertexMarkers.forEach(m => { try { m.remove(); } catch {} });
        this._vertexMarkers = [];
        this._removePreviewLine();
        if (this.map) {
            if (this.map.getLayer(this._rubberLineId)) this.map.removeLayer(this._rubberLineId);
            if (this.map.getSource(this._rubberSrcId)) this.map.removeSource(this._rubberSrcId);
        }
    }

    // ============================
    // Feature creation
    // ============================

    _finishDraw() {
        this._finishing = true;
        if (this._tool === 'line' && this._vertices.length >= 2) {
            this._createFeature('LineString', this._vertices.map(v => [v.lng, v.lat]));
        } else if (this._tool === 'polygon' && this._vertices.length >= 3) {
            const coords = this._vertices.map(v => [v.lng, v.lat]);
            coords.push(coords[0]);
            this._createFeature('Polygon', [coords]);
        }
        this._finishing = false;
    }

    _createFeature(type, coordinates) {
        const feature = {
            type: 'Feature',
            properties: {},
            geometry: { type, coordinates: type === 'Point' ? coordinates[0] : coordinates }
        };

        this._clearPreview();
        this._vertices = [];

        bus.emit('draw:featureCreated', { layerId: this._targetLayerId, feature });
        logger.info('Draw', `Created ${type} feature`);

        if (this._tool === 'point') {
            this._setHint('Point placed! Click again to add another.');
        } else {
            const currentTool = this._tool;
            this.cancelDraw();
            this.startTool(currentTool);
            this._skipNextDblClick = true;
        }
    }
}

const drawManager = new DrawManager();
export default drawManager;
