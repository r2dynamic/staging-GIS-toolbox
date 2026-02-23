/**
 * Bulk Update Widget
 * Select multiple features via rectangle, polygon, circle, or click-to-select,
 * then update attribute fields in bulk for all selected features.
 *
 * Rewritten for Mapbox GL JS (no Leaflet dependencies).
 */
import { WidgetBase } from './widget-base.js';
import logger from '../core/logger.js';

export class BulkUpdateWidget extends WidgetBase {
    constructor() {
        super('bulk-update', 'Bulk Update', '✏️', { width: '420px' });

        // state
        this._targetLayerId = null;
        this._selectedIndices = new Set();
        this._clickMode = false;
        this._fieldUpdates = {};
        this._step = 1;

        // Mapbox highlight ids
        this._hlSrcId   = '_bu-hl-src';
        this._hlFillId  = '_bu-hl-fill';
        this._hlLineId  = '_bu-hl-line';
        this._hlMarkers = [];

        // click-mode state
        this._clickBanner = null;
        this._clickKeyHandler = null;
        this._clickMapHandlers = [];

        // injected deps (set from app.js)
        this.getLayers = null;
        this.getLayerById = null;
        this.mapManager = null;
        this.refreshUI = null;
        this.showToast = null;
    }

    /* ======== Lifecycle ======== */

    onOpen()  { this._reset(); this._refreshBody(); this._bindEvents(); }
    onClose() { this._exitClickMode(); this._clearHighlights(); this._reset(); }

    _reset() {
        this._targetLayerId = null;
        this._selectedIndices = new Set();
        this._fieldUpdates = {};
        this._step = 1;
        this._clickMode = false;
        this._clearHighlights();
        this._exitClickMode();
    }

    /* ================================================================
       RENDER  (unchanged UI templates)
       ================================================================ */

    renderBody() {
        const layers = (this.getLayers?.() || []).filter(l => l.type === 'spatial');
        const layerOpts = layers.map(l =>
            `<option value="${l.id}" ${l.id === this._targetLayerId ? 'selected' : ''}>${l.name} (${l.geojson?.features?.length || 0})</option>`
        ).join('');

        if (this._step === 1) return this._renderStep1(layerOpts);
        if (this._step === 2) return this._renderStep2();
        if (this._step === 3) return this._renderStep3();
        return '';
    }

    _renderStep1(layerOpts) {
        return `
        <div style="padding:2px 0;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;">
                <span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--primary);color:#000;font-size:11px;font-weight:700;">1</span>
                <span style="font-size:13px;font-weight:600;color:var(--text);">Choose Layer</span>
            </div>
            <div style="margin-bottom:10px;">
                <label style="font-size:11px;color:var(--text-muted);display:block;margin-bottom:3px;">Target layer to update</label>
                <select id="bu-layer" style="width:100%;padding:7px 8px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg-surface);color:var(--text);font-size:13px;">
                    <option value="">— select layer —</option>
                    ${layerOpts}
                </select>
            </div>
            <button id="bu-next-1" class="btn btn-sm btn-primary" style="width:100%;" ${!this._targetLayerId ? 'disabled' : ''}>Next →</button>
        </div>`;
    }

    _renderStep2() {
        const layer = this._getTargetLayer();
        const total = layer?.geojson?.features?.length || 0;
        const count = this._selectedIndices.size;
        return `
        <div style="padding:2px 0;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;">
                <span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--primary);color:#000;font-size:11px;font-weight:700;">2</span>
                <span style="font-size:13px;font-weight:600;color:var(--text);">Select Features</span>
                <span style="margin-left:auto;font-size:11px;color:var(--text-muted);">${layer?.name || ''}</span>
            </div>
            <div style="background:var(--bg-surface);border-radius:var(--radius-sm);padding:10px;margin-bottom:10px;">
                <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">Draw a shape or click features on the map. Selections are additive.</div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
                    <button id="bu-draw-rect" class="btn btn-sm btn-secondary" title="Draw rectangle to select">▭ Rectangle</button>
                    <button id="bu-draw-poly" class="btn btn-sm btn-secondary" title="Draw polygon to select">⬠ Polygon</button>
                    <button id="bu-draw-circle" class="btn btn-sm btn-secondary" title="Draw circle to select">◯ Circle</button>
                    <button id="bu-click-select" class="btn btn-sm ${this._clickMode ? 'btn-primary' : 'btn-secondary'}" title="Click features to select/deselect">👆 Click Select</button>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;">
                    <button id="bu-select-all" class="btn btn-sm btn-secondary" title="Select all features">Select All</button>
                    <button id="bu-invert" class="btn btn-sm btn-secondary" title="Invert selection" ${count === 0 ? 'disabled' : ''}>Invert</button>
                    <button id="bu-clear" class="btn btn-sm btn-secondary" title="Clear selection" ${count === 0 ? 'disabled' : ''}>Clear</button>
                </div>
            </div>
            <div style="padding:8px 10px;border-radius:var(--radius-sm);background:${count > 0 ? 'rgba(48,209,88,0.12)' : 'rgba(255,255,255,0.04)'};color:${count > 0 ? 'var(--success)' : 'var(--text-muted)'};font-size:12px;margin-bottom:10px;">
                ${count > 0 ? `✓ ${count} of ${total} feature${count !== 1 ? 's' : ''} selected` : `No features selected (${total} total)`}
            </div>
            <div style="display:flex;gap:6px;">
                <button id="bu-back-2" class="btn btn-sm btn-secondary" style="flex:1;">← Back</button>
                <button id="bu-next-2" class="btn btn-sm btn-primary" style="flex:2;" ${count === 0 ? 'disabled' : ''}>Edit Fields →</button>
            </div>
        </div>`;
    }

    _renderStep3() {
        const layer = this._getTargetLayer();
        const count = this._selectedIndices.size;
        if (!layer || count === 0) return '';
        const fields = this._getFieldNames(layer);
        const fieldRows = fields.map(f => {
            const val = this._fieldUpdates[f] ?? '';
            const ph = this._getFieldPlaceholder(layer, f);
            return `
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;" data-bu-field="${f}">
                <input type="checkbox" class="bu-field-chk" data-field="${f}" ${val !== '' || this._fieldUpdates.hasOwnProperty(f) ? 'checked' : ''} title="Include this field in update" style="flex-shrink:0;">
                <label style="font-size:11px;color:var(--text-muted);min-width:90px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${f}">${f}</label>
                <input type="text" class="bu-field-val" data-field="${f}" value="${this._escHtml(val)}" placeholder="${ph}"
                    style="flex:1;padding:5px 7px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg-surface);color:var(--text);font-size:12px;">
            </div>`;
        }).join('');
        return `
        <div style="padding:2px 0;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;">
                <span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--primary);color:#000;font-size:11px;font-weight:700;">3</span>
                <span style="font-size:13px;font-weight:600;color:var(--text);">Update Fields</span>
                <span style="margin-left:auto;font-size:11px;color:var(--text-muted);">${count} feature${count !== 1 ? 's' : ''}</span>
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">Check the fields you want to update, then enter the new value. Unchecked fields are left as-is.</div>
            <div style="max-height:320px;overflow-y:auto;padding-right:4px;margin-bottom:10px;">
                ${fields.length > 0 ? fieldRows : '<div style="color:var(--text-muted);font-size:12px;">No attribute fields found on selected features.</div>'}
            </div>
            <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px;">
                <button id="bu-check-all" class="btn btn-sm btn-secondary" style="font-size:10px;">Check All</button>
                <button id="bu-uncheck-all" class="btn btn-sm btn-secondary" style="font-size:10px;">Uncheck All</button>
                <button id="bu-clear-vals" class="btn btn-sm btn-secondary" style="font-size:10px;">Clear Values</button>
            </div>
            <div style="display:flex;gap:6px;">
                <button id="bu-back-3" class="btn btn-sm btn-secondary" style="flex:1;">← Back</button>
                <button id="bu-apply" class="btn btn-sm btn-primary" style="flex:2;">✓ Apply Update</button>
            </div>
        </div>`;
    }

    /* ================================================================
       EVENTS
       ================================================================ */

    _bindEvents() {
        const body = this.body;
        if (!body) return;

        body.onclick = (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            const id = btn.id;
            if (id === 'bu-next-1') this._goToStep2();
            else if (id === 'bu-back-2') { this._exitClickMode(); this._step = 1; this._refreshBody(); this._bindEvents(); }
            else if (id === 'bu-next-2') { this._exitClickMode(); this._step = 3; this._refreshBody(); this._bindEvents(); }
            else if (id === 'bu-back-3') { this._step = 2; this._refreshBody(); this._bindEvents(); }
            else if (id === 'bu-draw-rect')   this._drawRectangle();
            else if (id === 'bu-draw-poly')   this._drawPolygon();
            else if (id === 'bu-draw-circle') this._drawCircle();
            else if (id === 'bu-click-select') this._toggleClickMode();
            else if (id === 'bu-select-all')  this._selectAll();
            else if (id === 'bu-invert')      this._invertSelection();
            else if (id === 'bu-clear')       this._clearSelection();
            else if (id === 'bu-check-all')   this._checkAll(true);
            else if (id === 'bu-uncheck-all') this._checkAll(false);
            else if (id === 'bu-clear-vals')  this._clearFieldValues();
            else if (id === 'bu-apply') this._applyUpdate();
        };

        body.onchange = (e) => {
            if (e.target.id === 'bu-layer') {
                this._targetLayerId = e.target.value || null;
                const nextBtn = body.querySelector('#bu-next-1');
                if (nextBtn) nextBtn.disabled = !this._targetLayerId;
            }
            if (e.target.classList.contains('bu-field-chk')) {
                const field = e.target.dataset.field;
                if (!e.target.checked) delete this._fieldUpdates[field];
                else { const inp = body.querySelector(`.bu-field-val[data-field="${field}"]`); this._fieldUpdates[field] = inp?.value ?? ''; }
            }
        };

        body.oninput = (e) => {
            if (e.target.classList.contains('bu-field-val')) {
                const field = e.target.dataset.field;
                const chk = body.querySelector(`.bu-field-chk[data-field="${field}"]`);
                if (chk) chk.checked = true;
                this._fieldUpdates[field] = e.target.value;
            }
        };
    }

    _goToStep2() {
        if (!this._targetLayerId) return;
        this._selectedIndices = new Set();
        this._clearHighlights();
        this._step = 2;
        this._refreshBody();
        this._bindEvents();
    }

    /* ================================================================
       SELECTION TOOLS  (rewritten for Mapbox GL JS)
       ================================================================ */

    /* --- Rectangle --- */
    async _drawRectangle() {
        if (!this.mapManager) return;
        this.showToast?.('Draw a rectangle to select features', 'info');
        const bbox = await this.mapManager.startRectangleDraw('Click and drag to draw selection rectangle');
        if (!bbox) return;
        // bbox = [west, south, east, north]
        this._selectFeaturesInBbox(bbox);
        this._refreshBody();
        this._bindEvents();
    }

    /* --- Polygon --- */
    async _drawPolygon() {
        if (!this.mapManager) return;
        this.showToast?.('Click to place points, double-click to finish', 'info');

        const map = this.mapManager.map;
        if (!map) return;

        const hadDCZ = map.doubleClickZoom.enabled();
        map.doubleClickZoom.disable();

        return new Promise((resolve) => {
            const points = [];   // [[lng, lat], ...]
            let clickTimer = null;
            const container = map.getContainer();
            container.style.cursor = 'crosshair';

            // Mapbox temp sources for preview
            const prevSrc = '_bu-poly-src';
            const prevLine = '_bu-poly-line';
            const prevFill = '_bu-poly-fill';

            const banner = this.mapManager._showInteractionBanner?.(
                'Click to add points. Double-click to finish selection.',
                () => { cleanup(); resolve(); }
            );

            const drawPreview = () => {
                const lineCoords = points.length >= 2 ? [...points] : null;
                const fillCoords = points.length >= 3 ? [...points, points[0]] : null;

                const geojson = {
                    type: 'FeatureCollection',
                    features: [
                        ...(lineCoords ? [{ type: 'Feature', geometry: { type: 'LineString', coordinates: lineCoords }, properties: {} }] : []),
                        ...(fillCoords ? [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [fillCoords] }, properties: {} }] : [])
                    ]
                };

                if (map.getSource(prevSrc)) {
                    map.getSource(prevSrc).setData(geojson);
                } else {
                    map.addSource(prevSrc, { type: 'geojson', data: geojson });
                    map.addLayer({ id: prevLine, type: 'line', source: prevSrc, paint: { 'line-color': '#d4a24e', 'line-width': 2, 'line-dasharray': [6, 4] } });
                    map.addLayer({ id: prevFill, type: 'fill', source: prevSrc, paint: { 'fill-color': '#d4a24e', 'fill-opacity': 0.08 }, filter: ['==', '$type', 'Polygon'] });
                }
            };

            const onClick = (e) => {
                if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
                clickTimer = setTimeout(() => {
                    clickTimer = null;
                    points.push([e.lngLat.lng, e.lngLat.lat]);
                    drawPreview();
                }, 200);
            };

            const onDblClick = (e) => {
                if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
                e.originalEvent?.stopPropagation();
                e.originalEvent?.preventDefault();
                points.push([e.lngLat.lng, e.lngLat.lat]);
                finish();
            };

            const onKeydown = (e) => { if (e.key === 'Escape') { cleanup(); resolve(); } };

            const finish = () => {
                if (points.length < 3) {
                    this.showToast?.('Need at least 3 points', 'warning');
                    cleanup(); resolve(); return;
                }
                const coords = [...points, points[0]];
                const poly = turf.polygon([coords]);
                this._selectFeaturesInPolygon(poly);
                cleanup();
                this._refreshBody();
                this._bindEvents();
                resolve();
            };

            const cleanup = () => {
                if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
                container.style.cursor = '';
                map.off('click', onClick);
                map.off('dblclick', onDblClick);
                document.removeEventListener('keydown', onKeydown);
                if (map.getLayer(prevLine)) map.removeLayer(prevLine);
                if (map.getLayer(prevFill)) map.removeLayer(prevFill);
                if (map.getSource(prevSrc)) map.removeSource(prevSrc);
                banner?.remove?.();
                if (hadDCZ) map.doubleClickZoom.enable();
            };

            map.on('click', onClick);
            map.on('dblclick', onDblClick);
            document.addEventListener('keydown', onKeydown);
        });
    }

    /* --- Circle --- */
    async _drawCircle() {
        if (!this.mapManager) return;
        this.showToast?.('Click center, then click to set radius', 'info');

        const map = this.mapManager.map;
        if (!map) return;

        return new Promise((resolve) => {
            let center = null;   // { lng, lat }
            const container = map.getContainer();
            container.style.cursor = 'crosshair';

            const circSrc = '_bu-circ-src';
            const circFill = '_bu-circ-fill';
            const circLine = '_bu-circ-line';

            const banner = this.mapManager._showInteractionBanner?.(
                'Click to place the center, then click again to set the radius. Esc to cancel.',
                () => { cleanup(); resolve(); }
            );

            const onClick = (e) => {
                if (!center) {
                    center = e.lngLat;
                    if (banner) {
                        const txt = banner.querySelector?.('.interaction-text') || banner.querySelector?.('span') || banner;
                        if (txt.textContent !== undefined) txt.textContent = 'Move mouse to set radius, click to confirm.';
                    }
                } else {
                    const radiusM = turf.distance(
                        turf.point([center.lng, center.lat]),
                        turf.point([e.lngLat.lng, e.lngLat.lat]),
                        { units: 'meters' }
                    );
                    finish(center, radiusM);
                }
            };

            const onMouseMove = (e) => {
                if (!center) return;
                const radiusM = turf.distance(
                    turf.point([center.lng, center.lat]),
                    turf.point([e.lngLat.lng, e.lngLat.lat]),
                    { units: 'meters' }
                );
                // Draw preview circle using turf
                let circlePoly;
                try { circlePoly = turf.circle([center.lng, center.lat], radiusM / 1000, { units: 'kilometers', steps: 64 }); }
                catch { return; }

                if (map.getSource(circSrc)) {
                    map.getSource(circSrc).setData(circlePoly);
                } else {
                    map.addSource(circSrc, { type: 'geojson', data: circlePoly });
                    map.addLayer({ id: circFill, type: 'fill', source: circSrc, paint: { 'fill-color': '#d4a24e', 'fill-opacity': 0.12 } });
                    map.addLayer({ id: circLine, type: 'line', source: circSrc, paint: { 'line-color': '#d4a24e', 'line-width': 2, 'line-dasharray': [6, 4] } });
                }
            };

            const onKeydown = (e) => { if (e.key === 'Escape') { cleanup(); resolve(); } };

            const finish = (c, radiusM) => {
                if (radiusM < 1) { this.showToast?.('Radius too small', 'warning'); cleanup(); resolve(); return; }
                let circlePoly;
                try { circlePoly = turf.circle([c.lng, c.lat], radiusM / 1000, { units: 'kilometers', steps: 64 }); }
                catch { circlePoly = turf.buffer(turf.point([c.lng, c.lat]), radiusM / 1000, { units: 'kilometers', steps: 64 }); }
                this._selectFeaturesInPolygon(circlePoly);
                cleanup();
                this._refreshBody();
                this._bindEvents();
                resolve();
            };

            const cleanup = () => {
                container.style.cursor = '';
                map.off('click', onClick);
                map.off('mousemove', onMouseMove);
                document.removeEventListener('keydown', onKeydown);
                if (map.getLayer(circFill)) map.removeLayer(circFill);
                if (map.getLayer(circLine)) map.removeLayer(circLine);
                if (map.getSource(circSrc)) map.removeSource(circSrc);
                banner?.remove?.();
            };

            map.on('click', onClick);
            map.on('mousemove', onMouseMove);
            document.addEventListener('keydown', onKeydown);
        });
    }

    /* --- Click-to-select mode --- */

    _toggleClickMode() {
        this._clickMode ? this._exitClickMode() : this._enterClickMode();
        this._refreshBody();
        this._bindEvents();
    }

    _enterClickMode() {
        if (this._clickMode) return;
        const map = this.mapManager?.map;
        if (!map) return;

        this._clickMode = true;
        map.getContainer().style.cursor = 'pointer';

        this._clickBanner = this.mapManager._showInteractionBanner?.(
            'Click features to select/deselect. Press Esc or click "Click Select" again to stop.',
            () => { this._exitClickMode(); this._refreshBody(); this._bindEvents(); }
        );

        // Get the data layer info and its stored GeoJSON
        const info = this.mapManager.dataLayers.get(this._targetLayerId);
        if (!info) { this._exitClickMode(); return; }

        const self = this;

        // Attach click handlers to each Mapbox layer for this dataset
        this._clickMapHandlers = [];
        for (const lid of (info.layerIds || [])) {
            const handler = (e) => {
                if (!e.features?.length) return;
                e.originalEvent?.stopPropagation();
                const idx = e.features[0].properties._featureIndex;
                if (idx === undefined) return;
                if (self._selectedIndices.has(idx)) self._selectedIndices.delete(idx);
                else self._selectedIndices.add(idx);
                self._renderHighlights();
                self._refreshBody();
                self._bindEvents();
                if (self._clickMode && map.getContainer()) map.getContainer().style.cursor = 'pointer';
            };
            map.on('click', lid, handler);
            this._clickMapHandlers.push({ lid, handler });
        }

        // Also handle point marker clicks
        for (const marker of (info.markers || [])) {
            const el = marker.getElement();
            if (!el) continue;
            const handler = (e) => {
                e.stopPropagation();
                const idx = marker._featureIndex;
                if (idx === undefined) return;
                if (self._selectedIndices.has(idx)) self._selectedIndices.delete(idx);
                else self._selectedIndices.add(idx);
                self._renderHighlights();
                self._refreshBody();
                self._bindEvents();
                if (self._clickMode && map.getContainer()) map.getContainer().style.cursor = 'pointer';
            };
            el.addEventListener('click', handler);
            this._clickMapHandlers.push({ el, handler });
        }

        this._clickKeyHandler = (e) => {
            if (e.key === 'Escape') { this._exitClickMode(); this._refreshBody(); this._bindEvents(); }
        };
        document.addEventListener('keydown', this._clickKeyHandler);

        this.showToast?.('Click features to select or deselect them', 'info');
    }

    _exitClickMode() {
        if (!this._clickMode) return;
        this._clickMode = false;

        const map = this.mapManager?.map;
        if (map) map.getContainer().style.cursor = '';

        if (this._clickMapHandlers) {
            for (const h of this._clickMapHandlers) {
                if (h.lid) map?.off('click', h.lid, h.handler);
                if (h.el) h.el.removeEventListener('click', h.handler);
            }
            this._clickMapHandlers = [];
        }

        if (this._clickKeyHandler) { document.removeEventListener('keydown', this._clickKeyHandler); this._clickKeyHandler = null; }
        if (this._clickBanner) { this._clickBanner.remove?.(); this._clickBanner = null; }
    }

    /* ================================================================
       SPATIAL SELECTION HELPERS  (rewritten — no Leaflet)
       ================================================================ */

    /** Select features intersecting a [west, south, east, north] bbox */
    _selectFeaturesInBbox(bbox) {
        const layer = this._getTargetLayer();
        if (!layer?.geojson?.features) return;

        const bboxPoly = turf.bboxPolygon(bbox);
        const features = layer.geojson.features;
        for (let i = 0; i < features.length; i++) {
            const f = features[i];
            if (!f?.geometry) continue;
            try {
                if (turf.booleanIntersects(f, bboxPoly)) this._selectedIndices.add(i);
            } catch {
                try {
                    const fb = turf.bbox(f);
                    if (fb[0] <= bbox[2] && fb[2] >= bbox[0] && fb[1] <= bbox[3] && fb[3] >= bbox[1])
                        this._selectedIndices.add(i);
                } catch {}
            }
        }
        this._renderHighlights();
        logger.info('BulkUpdate', `Selected ${this._selectedIndices.size} feature(s)`);
    }

    /** Select features intersecting a turf polygon */
    _selectFeaturesInPolygon(poly) {
        const layer = this._getTargetLayer();
        if (!layer?.geojson?.features) return;

        for (let i = 0; i < layer.geojson.features.length; i++) {
            const f = layer.geojson.features[i];
            if (!f?.geometry) continue;
            try { if (turf.booleanIntersects(f, poly)) this._selectedIndices.add(i); } catch {}
        }
        this._renderHighlights();
        logger.info('BulkUpdate', `Selected ${this._selectedIndices.size} feature(s)`);
    }

    _selectAll() {
        const layer = this._getTargetLayer();
        if (!layer?.geojson?.features) return;
        for (let i = 0; i < layer.geojson.features.length; i++) this._selectedIndices.add(i);
        this._renderHighlights();
        this._refreshBody(); this._bindEvents();
    }

    _invertSelection() {
        const layer = this._getTargetLayer();
        if (!layer?.geojson?.features) return;
        const inv = new Set();
        for (let i = 0; i < layer.geojson.features.length; i++) {
            if (!this._selectedIndices.has(i)) inv.add(i);
        }
        this._selectedIndices = inv;
        this._renderHighlights();
        this._refreshBody(); this._bindEvents();
    }

    _clearSelection() {
        this._selectedIndices = new Set();
        this._clearHighlights();
        this._refreshBody(); this._bindEvents();
    }

    /* ================================================================
       HIGHLIGHT RENDERING  (Mapbox GL JS)
       ================================================================ */

    _renderHighlights() {
        this._clearHighlights();

        const map = this.mapManager?.map;
        if (!map || this._selectedIndices.size === 0) return;

        const layer = this._getTargetLayer();
        if (!layer?.geojson?.features) return;

        const nonPts = [], pts = [];
        for (const i of this._selectedIndices) {
            const f = layer.geojson.features[i];
            if (!f?.geometry) continue;
            (f.geometry.type === 'Point' || f.geometry.type === 'MultiPoint') ? pts.push(f) : nonPts.push(f);
        }

        if (nonPts.length) {
            map.addSource(this._hlSrcId, { type: 'geojson', data: { type: 'FeatureCollection', features: nonPts } });
            map.addLayer({ id: this._hlFillId, type: 'fill', source: this._hlSrcId, paint: { 'fill-color': '#00e5ff', 'fill-opacity': 0.18 }, filter: ['==', '$type', 'Polygon'] });
            map.addLayer({ id: this._hlLineId, type: 'line', source: this._hlSrcId, paint: { 'line-color': '#00e5ff', 'line-width': 3 } });
        }

        for (const f of pts) {
            const coords = f.geometry.type === 'MultiPoint' ? f.geometry.coordinates : [f.geometry.coordinates];
            for (const c of coords) {
                const el = document.createElement('div');
                el.style.cssText = 'width:16px;height:16px;border-radius:50%;background:#00e5ff;border:3px solid #fff;pointer-events:none;';
                const m = new mapboxgl.Marker({ element: el, anchor: 'center' }).setLngLat(c).addTo(map);
                this._hlMarkers.push(m);
            }
        }
    }

    _clearHighlights() {
        const map = this.mapManager?.map;
        if (map) {
            if (map.getLayer(this._hlFillId)) map.removeLayer(this._hlFillId);
            if (map.getLayer(this._hlLineId)) map.removeLayer(this._hlLineId);
            if (map.getSource(this._hlSrcId)) map.removeSource(this._hlSrcId);
        }
        this._hlMarkers.forEach(m => { try { m.remove(); } catch {} });
        this._hlMarkers = [];
    }

    /* ================================================================
       FIELD HELPERS  (unchanged)
       ================================================================ */

    _getTargetLayer() { return this._targetLayerId ? this.getLayerById?.(this._targetLayerId) || null : null; }

    _getFieldNames(layer) {
        if (!layer?.geojson?.features) return [];
        const s = new Set();
        for (const i of this._selectedIndices) { const f = layer.geojson.features[i]; if (f?.properties) Object.keys(f.properties).forEach(k => s.add(k)); }
        return [...s].sort();
    }

    _getFieldPlaceholder(layer, fieldName) {
        if (!layer?.geojson?.features) return '';
        const vals = new Set();
        for (const i of this._selectedIndices) {
            const v = layer.geojson.features[i]?.properties?.[fieldName];
            if (v != null && v !== '') vals.add(String(v));
            if (vals.size > 3) break;
        }
        if (vals.size === 0) return '(all empty)';
        if (vals.size === 1) return [...vals][0];
        return `(${vals.size}+ mixed values)`;
    }

    _checkAll(checked) {
        const body = this.body;
        if (!body) return;
        body.querySelectorAll('.bu-field-chk').forEach(chk => {
            chk.checked = checked;
            const field = chk.dataset.field;
            if (checked) { const inp = body.querySelector(`.bu-field-val[data-field="${field}"]`); this._fieldUpdates[field] = inp?.value ?? ''; }
            else delete this._fieldUpdates[field];
        });
    }

    _clearFieldValues() {
        const body = this.body;
        if (!body) return;
        body.querySelectorAll('.bu-field-val').forEach(inp => inp.value = '');
        this._fieldUpdates = {};
        body.querySelectorAll('.bu-field-chk').forEach(chk => chk.checked = false);
    }

    /* ================================================================
       APPLY UPDATE  (unchanged)
       ================================================================ */

    _applyUpdate() {
        const layer = this._getTargetLayer();
        if (!layer?.geojson?.features) return;
        const body = this.body;
        const updates = {};
        if (body) {
            body.querySelectorAll('.bu-field-chk:checked').forEach(chk => {
                const field = chk.dataset.field;
                const inp = body.querySelector(`.bu-field-val[data-field="${field}"]`);
                updates[field] = inp?.value ?? '';
            });
        }
        const fieldCount = Object.keys(updates).length;
        if (fieldCount === 0) { this.showToast?.('No fields checked for update', 'warning'); return; }

        let updated = 0;
        for (const idx of this._selectedIndices) {
            const f = layer.geojson.features[idx];
            if (!f) continue;
            if (!f.properties) f.properties = {};
            for (const [key, val] of Object.entries(updates)) {
                if (val === '') f.properties[key] = '';
                else if (!isNaN(val) && val.trim() !== '') f.properties[key] = Number(val);
                else f.properties[key] = val;
            }
            updated++;
        }

        this.showToast?.(`Updated ${fieldCount} field${fieldCount !== 1 ? 's' : ''} on ${updated} feature${updated !== 1 ? 's' : ''}`, 'success');
        logger.info('BulkUpdate', `Applied ${fieldCount} field update(s) to ${updated} feature(s)`);
        this.refreshUI?.();

        this._fieldUpdates = {};
        this._selectedIndices = new Set();
        this._clearHighlights();
        this._step = 2;
        this._refreshBody();
        this._bindEvents();
    }

    _escHtml(str) { return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
}

export default BulkUpdateWidget;
