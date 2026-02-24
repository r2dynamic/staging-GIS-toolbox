/**
 * Wireless Radio Coverage Visualization Widget
 *
 * Two modes:
 *   - Visualize: Plot coverage from imported data or manual site creation
 *   - Analyze:   Auto-design / gap analysis on a target area
 *
 * Features:
 *   - Sector wedge & omni circle geometry
 *   - Compass control for azimuth input
 *   - Import field mapping from existing layers
 *   - 3D extrusion by antenna height
 *   - Add/edit/remove sites & antennas in-widget
 *   - Export coverage as a GIS layer
 */
import { WidgetBase } from '../widget-base.js';
import { WirelessState } from './wireless-state.js';
import {
    TECH_COLORS, RADIUS_UNITS,
    buildCoverageFC, convertToKm, convertFromKm,
    createSectorWedge, createOmniCircle,
} from './wireless-geometry.js';
import logger from '../../core/logger.js';

/* ── Map layer IDs used by this widget ── */
const COV_SRC   = '_wireless-cov-src';
const COV_FILL  = '_wireless-cov-fill';
const COV_LINE  = '_wireless-cov-line';
const COV_EXT   = '_wireless-cov-ext';    // 3D extrusion layer
const SITE_SRC  = '_wireless-site-src';
const SITE_CIRCLE = '_wireless-site-circle';

export class WirelessWidget extends WidgetBase {
    constructor() {
        super('wireless-coverage', 'Wireless Coverage', '📡', { width: '440px' });
        this.state = new WirelessState();

        // mode: 'visualize' | 'analyze'
        this._mode = 'visualize';
        // sub-view within visualize
        this._vizView = 'sites';     // 'sites' | 'add-site' | 'edit-site' | 'import'
        this._editSiteId = null;
        this._editAntennaId = null;

        // compass drag state
        this._compassDragging = false;
        this._compassAngle = 0;

        // pick-from-map state
        this._pickingLocation = false;
        this._pickResolve = null;

        // analyse state
        this._analyzeResults = null;

        // deps injected from app.js
        this.mapManager = null;
        this.getLayers = null;
        this.getLayerById = null;
        this.addLayer = null;
        this.createSpatialDataset = null;
        this.refreshUI = null;
        this.showToast = null;

        this._stateUnsub = null;
    }

    /* ======== Lifecycle ======== */

    onOpen() {
        this._stateUnsub = this.state.onChange(() => {
            this._renderCoverageOnMap();
            this._refreshBody();
        });
        this._refreshBody();
        this._bindEvents();
    }

    onClose() {
        if (this._stateUnsub) { this._stateUnsub(); this._stateUnsub = null; }
        this._removeCoverageFromMap();
        this._cancelPick();
    }

    /* ================================================================
       RENDER — mode switcher
       ================================================================ */

    renderBody() {
        return `
        <div class="wc-tabs">
            <button class="wc-tab ${this._mode === 'visualize' ? 'active' : ''}" data-mode="visualize">Visualize</button>
            <button class="wc-tab ${this._mode === 'analyze' ? 'active' : ''}" data-mode="analyze">Analyze</button>
        </div>
        <div class="wc-content">
            ${this._mode === 'visualize' ? this._renderVisualize() : this._renderAnalyze()}
        </div>`;
    }

    /* ================================================================
       VISUALIZE MODE
       ================================================================ */

    _renderVisualize() {
        switch (this._vizView) {
            case 'add-site':   return this._renderAddSite();
            case 'edit-site':  return this._renderEditSite();
            case 'import':     return this._renderImport();
            default:           return this._renderSiteList();
        }
    }

    /* ── Site list ── */
    _renderSiteList() {
        const sites = this.state.getAllSites();
        const stats = this.state.techBreakdown;
        const techBadges = Object.entries(stats).map(([t, n]) =>
            `<span class="wc-tech-badge" style="background:${TECH_COLORS[t] || TECH_COLORS.Custom}22;color:${TECH_COLORS[t] || TECH_COLORS.Custom};border:1px solid ${TECH_COLORS[t] || TECH_COLORS.Custom}44;">${t}: ${n}</span>`
        ).join('');

        return `
        <div class="wc-summary">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                <span style="font-size:12px;color:var(--text-muted);">${sites.length} site${sites.length !== 1 ? 's' : ''} · ${this.state.antennaCount} antenna${this.state.antennaCount !== 1 ? 's' : ''}</span>
                <div style="display:flex;gap:4px;">
                    <button class="btn btn-xs btn-secondary" id="wc-import-btn" title="Import from layer">📥 Import</button>
                    <button class="btn btn-xs btn-primary" id="wc-add-site-btn" title="Add site manually">+ Add Site</button>
                </div>
            </div>
            ${techBadges ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">${techBadges}</div>` : ''}
        </div>
        <div class="wc-site-list" style="max-height:320px;overflow-y:auto;">
            ${sites.length === 0 ? `<div class="wc-empty">No sites yet. Click <b>+ Add Site</b> or <b>📥 Import</b> to get started.</div>` : ''}
            ${sites.map(s => this._renderSiteCard(s)).join('')}
        </div>
        ${sites.length > 0 ? `
        <div style="display:flex;gap:4px;margin-top:8px;">
            <button class="btn btn-xs btn-secondary" id="wc-export-layer" style="flex:1;">📤 Export as Layer</button>
            <button class="btn btn-xs btn-secondary" id="wc-export-json" style="flex:1;">💾 Save Config</button>
            <button class="btn btn-xs btn-danger" id="wc-clear-all" style="flex:0 0 auto;">🗑</button>
        </div>` : ''}`;
    }

    _renderSiteCard(site) {
        const antList = (site.antennas || []).map(a => {
            const icon = a.type === 'omni' ? '⊙' : '⌔';
            const clr = a.color || TECH_COLORS[a.tech] || TECH_COLORS.Custom;
            return `<div class="wc-ant-row" data-site="${site.id}" data-ant="${a.id}">
                <span style="color:${clr};font-size:14px;line-height:1;" title="${a.type}">${icon}</span>
                <span style="flex:1;font-size:11px;">${a.tech} ${a.type === 'sector' ? `Az ${a.azimuth}° BW ${a.beamwidth}°` : 'Omni'} · ${a.radius}${a.radiusUnit || 'km'}</span>
                <button class="wc-ant-del" data-site="${site.id}" data-ant="${a.id}" title="Remove antenna">×</button>
            </div>`;
        }).join('');

        return `
        <div class="wc-site-card" data-site="${site.id}">
            <div class="wc-site-header">
                <span class="wc-site-icon">📍</span>
                <span class="wc-site-name" title="${site.lat.toFixed(5)}, ${site.lng.toFixed(5)}">${site.name}</span>
                <span style="font-size:10px;color:var(--text-muted);">${site.height}m</span>
                <button class="wc-site-edit" data-site="${site.id}" title="Edit site">✎</button>
                <button class="wc-site-del" data-site="${site.id}" title="Remove site">×</button>
            </div>
            ${antList || '<div style="font-size:11px;color:var(--text-muted);padding:2px 0 0 22px;">No antennas</div>'}
        </div>`;
    }

    /* ── Add / Edit Site ── */
    _renderAddSite() {
        return this._renderSiteForm(null);
    }

    _renderEditSite() {
        const site = this.state.getSite(this._editSiteId);
        if (!site) { this._vizView = 'sites'; return this._renderSiteList(); }
        return this._renderSiteForm(site);
    }

    _renderSiteForm(site) {
        const isEdit = !!site;
        const s = site || { name: '', lat: '', lng: '', height: 30, antennas: [] };

        // Antenna rows for editing
        const antRows = isEdit ? (s.antennas || []).map((a, i) => this._renderAntennaForm(a, i, s.id)).join('') : '';
        const pickLabel = this._pickingLocation ? '⏳ Click on map…' : '🎯 Pick from Map';

        return `
        <div style="padding:2px 0;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
                <button class="wc-back-btn" id="wc-back">←</button>
                <span style="font-size:13px;font-weight:600;color:var(--text);">${isEdit ? 'Edit Site' : 'Add Site'}</span>
            </div>

            <div class="wc-form-group">
                <label>Site Name</label>
                <input type="text" id="wc-site-name" value="${this._esc(s.name)}" placeholder="e.g. Tower Alpha" />
            </div>
            <div style="display:flex;gap:6px;">
                <div class="wc-form-group" style="flex:1;">
                    <label>Latitude</label>
                    <input type="number" step="any" id="wc-site-lat" value="${s.lat}" placeholder="e.g. 33.4484" />
                </div>
                <div class="wc-form-group" style="flex:1;">
                    <label>Longitude</label>
                    <input type="number" step="any" id="wc-site-lng" value="${s.lng}" placeholder="e.g. -112.0740" />
                </div>
                <button class="btn btn-xs btn-secondary" id="wc-pick-loc" style="align-self:flex-end;margin-bottom:4px;white-space:nowrap;" ${this._pickingLocation ? 'disabled' : ''}>${pickLabel}</button>
            </div>
            <div class="wc-form-group" style="max-width:120px;">
                <label>Height (m)</label>
                <input type="number" id="wc-site-height" value="${s.height}" min="0" step="1" />
            </div>

            ${isEdit ? `
            <div style="margin-top:10px;border-top:1px solid var(--border);padding-top:8px;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                    <span style="font-size:12px;font-weight:600;color:var(--text);">Antennas</span>
                    <button class="btn btn-xs btn-primary" id="wc-add-antenna">+ Antenna</button>
                </div>
                ${antRows || '<div class="wc-empty" style="font-size:11px;">No antennas yet.</div>'}
            </div>` : ''}

            <div style="display:flex;gap:6px;margin-top:10px;">
                <button class="btn btn-sm btn-primary" id="wc-save-site" style="flex:1;">${isEdit ? 'Save Changes' : 'Create Site'}</button>
                <button class="btn btn-sm btn-secondary" id="wc-cancel-site">Cancel</button>
            </div>
        </div>`;
    }

    _renderAntennaForm(ant, idx, siteId) {
        const techOpts = Object.keys(TECH_COLORS).map(t =>
            `<option value="${t}" ${ant.tech === t ? 'selected' : ''}>${t}</option>`
        ).join('');
        const unitOpts = RADIUS_UNITS.map(u =>
            `<option value="${u.value}" ${(ant.radiusUnit || 'km') === u.value ? 'selected' : ''}>${u.abbr}</option>`
        ).join('');
        const isSector = ant.type === 'sector';
        const clr = ant.color || TECH_COLORS[ant.tech] || TECH_COLORS.Custom;

        return `
        <div class="wc-antenna-card" data-ant-idx="${idx}" data-ant-id="${ant.id}" data-site-id="${siteId}">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
                <span style="font-size:11px;font-weight:600;color:${clr};">Antenna #${idx + 1}</span>
                <button class="wc-ant-del-form" data-site="${siteId}" data-ant="${ant.id}" title="Remove">×</button>
            </div>
            <div style="display:flex;gap:4px;margin-bottom:4px;">
                <div class="wc-form-group" style="flex:1;">
                    <label>Type</label>
                    <select class="wc-ant-type" data-ant="${ant.id}">
                        <option value="sector" ${isSector ? 'selected' : ''}>Sector</option>
                        <option value="omni" ${!isSector ? 'selected' : ''}>Omni</option>
                    </select>
                </div>
                <div class="wc-form-group" style="flex:1;">
                    <label>Tech</label>
                    <select class="wc-ant-tech" data-ant="${ant.id}">${techOpts}</select>
                </div>
            </div>
            ${isSector ? `
            <div style="display:flex;gap:4px;margin-bottom:4px;">
                <div class="wc-form-group" style="flex:1;">
                    <label>Azimuth °</label>
                    <div style="display:flex;align-items:center;gap:4px;">
                        <input type="number" class="wc-ant-azimuth" data-ant="${ant.id}" value="${ant.azimuth}" min="0" max="360" step="1" style="flex:1;" />
                        <div class="wc-compass-mini" data-ant="${ant.id}" title="Drag to set azimuth">
                            <div class="wc-compass-needle" style="transform:rotate(${ant.azimuth}deg);"></div>
                        </div>
                    </div>
                </div>
                <div class="wc-form-group" style="flex:1;">
                    <label>Beamwidth °</label>
                    <input type="number" class="wc-ant-beamwidth" data-ant="${ant.id}" value="${ant.beamwidth}" min="1" max="360" step="1" />
                </div>
            </div>` : ''}
            <div style="display:flex;gap:4px;">
                <div class="wc-form-group" style="flex:1;">
                    <label>Radius</label>
                    <input type="number" class="wc-ant-radius" data-ant="${ant.id}" value="${ant.radius}" min="0.01" step="0.1" />
                </div>
                <div class="wc-form-group" style="flex:0 0 70px;">
                    <label>Unit</label>
                    <select class="wc-ant-unit" data-ant="${ant.id}">${unitOpts}</select>
                </div>
                <div class="wc-form-group" style="flex:0 0 50px;">
                    <label>Height</label>
                    <input type="number" class="wc-ant-height" data-ant="${ant.id}" value="${ant.height ?? ''}" min="0" step="1" placeholder="—" />
                </div>
            </div>
        </div>`;
    }

    /* ── Import from layer ── */
    _renderImport() {
        const layers = (this.getLayers?.() || []).filter(l => l.type === 'spatial');
        const layerOpts = layers.map(l =>
            `<option value="${l.id}">${l.name} (${l.geojson?.features?.length || 0})</option>`
        ).join('');

        // Get fields from first selected layer
        let fieldOpts = '<option value="">—</option>';
        if (layers.length) {
            const first = layers[0];
            const sample = first.geojson?.features?.[0]?.properties || {};
            const keys = Object.keys(sample).filter(k => !k.startsWith('_'));
            fieldOpts += keys.map(k => `<option value="${k}">${k}</option>`).join('');
        }

        return `
        <div style="padding:2px 0;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
                <button class="wc-back-btn" id="wc-back">←</button>
                <span style="font-size:13px;font-weight:600;color:var(--text);">Import from Layer</span>
            </div>
            <div class="wc-form-group">
                <label>Source Layer</label>
                <select id="wc-import-layer">${layerOpts || '<option value="">No layers loaded</option>'}</select>
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">Map fields from your data to antenna parameters:</div>
            <div class="wc-field-map">
                ${this._fieldMapRow('Name', 'wc-map-name', fieldOpts)}
                ${this._fieldMapRow('Latitude', 'wc-map-lat', fieldOpts)}
                ${this._fieldMapRow('Longitude', 'wc-map-lng', fieldOpts)}
                ${this._fieldMapRow('Height (m)', 'wc-map-height', fieldOpts)}
                ${this._fieldMapRow('Type (sector/omni)', 'wc-map-type', fieldOpts)}
                ${this._fieldMapRow('Azimuth °', 'wc-map-azimuth', fieldOpts)}
                ${this._fieldMapRow('Beamwidth °', 'wc-map-beamwidth', fieldOpts)}
                ${this._fieldMapRow('Radius', 'wc-map-radius', fieldOpts)}
                ${this._fieldMapRow('Technology', 'wc-map-tech', fieldOpts)}
            </div>
            <button class="btn btn-sm btn-primary" id="wc-do-import" style="width:100%;margin-top:8px;">Import</button>
        </div>`;
    }

    _fieldMapRow(label, id, opts) {
        return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
            <span style="flex:0 0 120px;font-size:11px;color:var(--text-muted);">${label}</span>
            <select id="${id}" style="flex:1;font-size:11px;">${opts}</select>
        </div>`;
    }

    /* ================================================================
       ANALYZE MODE — Coverage gap analysis
       ================================================================ */

    _renderAnalyze() {
        if (this._analyzeResults) return this._renderAnalyzeResults();

        const sites = this.state.getAllSites();
        return `
        <div style="padding:2px 0;">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
                Analyze coverage gaps and generate suggested sites to fill uncovered areas.
            </div>
            ${sites.length === 0 ? `<div class="wc-empty">Add or import sites first to run analysis.</div>` : `
            <div class="wc-form-group">
                <label>Analysis Area</label>
                <select id="wc-analyze-area">
                    <option value="bbox">Current map extent</option>
                    <option value="coverage">Existing coverage union</option>
                </select>
            </div>
            <div class="wc-form-group" style="max-width:200px;">
                <label>Grid Cell Size (km)</label>
                <input type="number" id="wc-grid-size" value="0.5" min="0.05" max="10" step="0.05" />
            </div>
            <div class="wc-form-group" style="max-width:200px;">
                <label>Min Coverage Overlap</label>
                <select id="wc-min-overlap">
                    <option value="1">Single coverage</option>
                    <option value="2">Double coverage</option>
                    <option value="3">Triple coverage</option>
                </select>
            </div>
            <div style="display:flex;gap:6px;margin-top:10px;">
                <button class="btn btn-sm btn-primary" id="wc-run-analysis" style="flex:1;">▶ Run Analysis</button>
            </div>
            `}
        </div>`;
    }

    _renderAnalyzeResults() {
        const r = this._analyzeResults;
        return `
        <div style="padding:2px 0;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
                <button class="wc-back-btn" id="wc-analyze-back">←</button>
                <span style="font-size:13px;font-weight:600;color:var(--text);">Coverage Analysis</span>
            </div>
            <div class="wc-stats-grid">
                <div class="wc-stat">
                    <div class="wc-stat-val">${r.totalCells}</div>
                    <div class="wc-stat-label">Grid Cells</div>
                </div>
                <div class="wc-stat">
                    <div class="wc-stat-val" style="color:var(--success);">${r.coveredCells}</div>
                    <div class="wc-stat-label">Covered</div>
                </div>
                <div class="wc-stat">
                    <div class="wc-stat-val" style="color:var(--danger);">${r.uncoveredCells}</div>
                    <div class="wc-stat-label">Gaps</div>
                </div>
                <div class="wc-stat">
                    <div class="wc-stat-val">${r.coveragePercent}%</div>
                    <div class="wc-stat-label">Coverage</div>
                </div>
            </div>
            ${r.overlapInfo ? `
            <div style="font-size:11px;margin-top:6px;">
                <div style="color:var(--text-muted);margin-bottom:4px;">Overlap distribution:</div>
                ${Object.entries(r.overlapInfo).map(([k, v]) =>
                    `<div style="display:flex;justify-content:space-between;"><span>${k}× coverage</span><span>${v} cells (${Math.round(v / r.totalCells * 100)}%)</span></div>`
                ).join('')}
            </div>` : ''}
            <div style="margin-top:8px;">
                <button class="btn btn-xs btn-secondary" id="wc-analyze-clear" style="width:100%;">← Back to Analysis Setup</button>
            </div>
        </div>`;
    }

    /* ================================================================
       EVENT BINDING
       ================================================================ */

    _bindEvents() {
        const el = this._el;
        if (!el) return;

        el.addEventListener('click', (e) => {
            const btn = e.target.closest('button, [data-mode]');
            if (!btn) return;

            // Tab switching
            if (btn.dataset.mode) {
                this._mode = btn.dataset.mode;
                this._refreshBody();
                this._bindEvents();
                return;
            }

            const id = btn.id;

            // ── Visualize: site list actions ──
            if (id === 'wc-add-site-btn') { this._vizView = 'add-site'; this._editSiteId = null; this._refreshBody(); this._bindEvents(); return; }
            if (id === 'wc-import-btn') { this._vizView = 'import'; this._refreshBody(); this._bindEvents(); return; }
            if (id === 'wc-back') { this._vizView = 'sites'; this._editSiteId = null; this._cancelPick(); this._refreshBody(); this._bindEvents(); return; }
            if (id === 'wc-export-layer') { this._exportAsLayer(); return; }
            if (id === 'wc-export-json') { this._exportJSON(); return; }
            if (id === 'wc-clear-all') { this.state.clear(); return; }

            // ── Edit / delete site ──
            if (btn.classList.contains('wc-site-edit')) {
                this._editSiteId = btn.dataset.site;
                this._vizView = 'edit-site';
                this._refreshBody(); this._bindEvents(); return;
            }
            if (btn.classList.contains('wc-site-del')) {
                this.state.removeSite(btn.dataset.site); return;
            }

            // ── Antenna delete ──
            if (btn.classList.contains('wc-ant-del') || btn.classList.contains('wc-ant-del-form')) {
                this.state.removeAntenna(btn.dataset.site, btn.dataset.ant);
                return;
            }

            // ── Site form actions ──
            if (id === 'wc-save-site') { this._saveSite(); return; }
            if (id === 'wc-cancel-site') { this._vizView = 'sites'; this._editSiteId = null; this._cancelPick(); this._refreshBody(); this._bindEvents(); return; }
            if (id === 'wc-pick-loc') { this._startPickLocation(); return; }
            if (id === 'wc-add-antenna') { this._addNewAntenna(); return; }

            // ── Import ──
            if (id === 'wc-do-import') { this._doImport(); return; }

            // ── Analyze ──
            if (id === 'wc-run-analysis') { this._runAnalysis(); return; }
            if (id === 'wc-analyze-back' || id === 'wc-analyze-clear') { this._analyzeResults = null; this._refreshBody(); this._bindEvents(); return; }
        });

        // Layer change → update field options in import view
        const layerSel = el.querySelector('#wc-import-layer');
        if (layerSel) {
            layerSel.addEventListener('change', () => {
                this._updateFieldOptions(layerSel.value);
            });
        }

        // Compass drag on mini compasses
        this._bindCompassDrags();

        // Antenna field live-update
        this._bindAntennaFields();
    }

    _bindCompassDrags() {
        const el = this._el;
        if (!el) return;
        el.querySelectorAll('.wc-compass-mini').forEach(comp => {
            const antId = comp.dataset.ant;
            comp.addEventListener('mousedown', (e) => this._startCompassDrag(e, comp, antId));
            comp.addEventListener('touchstart', (e) => this._startCompassDrag(e, comp, antId), { passive: false });
        });
    }

    _startCompassDrag(e, compassEl, antId) {
        e.preventDefault();
        const rect = compassEl.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;

        const needle = compassEl.querySelector('.wc-compass-needle');
        const azInput = this._el.querySelector(`.wc-ant-azimuth[data-ant="${antId}"]`);

        const onMove = (ev) => {
            const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
            const clientY = ev.touches ? ev.touches[0].clientY : ev.clientY;
            let angle = Math.atan2(clientX - cx, -(clientY - cy)) * (180 / Math.PI);
            if (angle < 0) angle += 360;
            angle = Math.round(angle);
            needle.style.transform = `rotate(${angle}deg)`;
            if (azInput) azInput.value = angle;
        };

        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onUp);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
    }

    _bindAntennaFields() {
        // Live update antenna props when editing
        if (this._vizView !== 'edit-site' || !this._editSiteId) return;
        const el = this._el;
        if (!el) return;

        el.querySelectorAll('.wc-antenna-card').forEach(card => {
            const antId = card.dataset.antId;
            const siteId = card.dataset.siteId;
            const inputs = card.querySelectorAll('input, select');
            inputs.forEach(inp => {
                inp.addEventListener('change', () => {
                    this._updateAntennaFromCard(card, siteId, antId);
                });
            });
        });
    }

    _updateAntennaFromCard(card, siteId, antId) {
        const get = (sel) => card.querySelector(sel)?.value;
        const updates = {};
        const typeVal = get('.wc-ant-type');
        if (typeVal) updates.type = typeVal;
        const techVal = get('.wc-ant-tech');
        if (techVal) { updates.tech = techVal; updates.color = TECH_COLORS[techVal] || TECH_COLORS.Custom; }
        const azVal = get('.wc-ant-azimuth');
        if (azVal !== undefined && azVal !== null) updates.azimuth = parseFloat(azVal) || 0;
        const bwVal = get('.wc-ant-beamwidth');
        if (bwVal) updates.beamwidth = parseFloat(bwVal) || 65;
        const rVal = get('.wc-ant-radius');
        if (rVal) updates.radius = parseFloat(rVal) || 1;
        const uVal = get('.wc-ant-unit');
        if (uVal) updates.radiusUnit = uVal;
        const hVal = get('.wc-ant-height');
        if (hVal) updates.height = parseFloat(hVal) || null;

        this.state.updateAntenna(siteId, antId, updates);
    }

    /* ================================================================
       ACTIONS
       ================================================================ */

    _saveSite() {
        const name = this._el.querySelector('#wc-site-name')?.value?.trim();
        const lat = parseFloat(this._el.querySelector('#wc-site-lat')?.value);
        const lng = parseFloat(this._el.querySelector('#wc-site-lng')?.value);
        const height = parseFloat(this._el.querySelector('#wc-site-height')?.value) || 30;

        if (isNaN(lat) || isNaN(lng)) {
            this.showToast?.('Please enter valid coordinates', 'error');
            return;
        }

        if (this._editSiteId) {
            this.state.updateSite(this._editSiteId, { name: name || 'Site', lat, lng, height });
            this.showToast?.('Site updated', 'success', { duration: 1500 });
        } else {
            const site = this.state.addSite({ name: name || undefined, lat, lng, height });
            this._editSiteId = site.id;
            this._vizView = 'edit-site';
            this.showToast?.('Site created — add antennas below', 'success', { duration: 2000 });
        }
        this._refreshBody();
        this._bindEvents();
    }

    _addNewAntenna() {
        if (!this._editSiteId) return;
        this.state.addAntenna(this._editSiteId, {
            type: 'sector',
            azimuth: 0,
            beamwidth: 65,
            radius: 1,
            radiusUnit: 'km',
            tech: 'LTE',
        });
        // State change listener will refresh
    }

    /* ── Pick location from map ── */
    _startPickLocation() {
        if (!this.mapManager?.map) return;
        this._pickingLocation = true;
        this._refreshBody();
        this._bindEvents();

        const map = this.mapManager.map;
        const canvas = map.getCanvas();
        canvas.style.cursor = 'crosshair';

        const onClick = (e) => {
            canvas.style.cursor = '';
            map.off('click', onClick);
            this._pickingLocation = false;

            const { lng, lat } = e.lngLat;
            const latInput = this._el?.querySelector('#wc-site-lat');
            const lngInput = this._el?.querySelector('#wc-site-lng');
            if (latInput) latInput.value = lat.toFixed(6);
            if (lngInput) lngInput.value = lng.toFixed(6);
            this._refreshBody();
            this._bindEvents();
        };

        map.once('click', onClick);
        this._pickCleanup = () => { canvas.style.cursor = ''; map.off('click', onClick); };
    }

    _cancelPick() {
        this._pickingLocation = false;
        if (this._pickCleanup) { this._pickCleanup(); this._pickCleanup = null; }
    }

    /* ── Import from layer ── */
    _updateFieldOptions(layerId) {
        const layer = this.getLayers?.()?.find(l => l.id === layerId);
        if (!layer) return;
        const sample = layer.geojson?.features?.[0]?.properties || {};
        const keys = Object.keys(sample).filter(k => !k.startsWith('_'));
        const opts = '<option value="">—</option>' + keys.map(k => `<option value="${k}">${k}</option>`).join('');

        ['wc-map-name', 'wc-map-lat', 'wc-map-lng', 'wc-map-height', 'wc-map-type',
         'wc-map-azimuth', 'wc-map-beamwidth', 'wc-map-radius', 'wc-map-tech'].forEach(id => {
            const sel = this._el.querySelector(`#${id}`);
            if (sel) sel.innerHTML = opts;
        });

        // Auto-map common field names
        this._autoMapFields(keys);
    }

    _autoMapFields(keys) {
        const map = {
            'wc-map-name': ['name', 'site_name', 'sitename', 'site', 'label', 'title'],
            'wc-map-lat': ['lat', 'latitude', 'y', 'lat_dd', 'site_lat'],
            'wc-map-lng': ['lng', 'lon', 'longitude', 'long', 'x', 'lng_dd', 'site_lon', 'site_lng'],
            'wc-map-height': ['height', 'elevation', 'alt', 'altitude', 'tower_height', 'agl', 'hgt'],
            'wc-map-type': ['type', 'antenna_type', 'ant_type', 'sector_type'],
            'wc-map-azimuth': ['azimuth', 'az', 'bearing', 'direction', 'azm'],
            'wc-map-beamwidth': ['beamwidth', 'bw', 'beam_width', 'hpbw', 'horizontal_beamwidth'],
            'wc-map-radius': ['radius', 'range', 'distance', 'coverage_radius', 'reach'],
            'wc-map-tech': ['tech', 'technology', 'band', 'frequency', 'freq', 'network'],
        };
        const lower = keys.map(k => k.toLowerCase());

        for (const [selId, aliases] of Object.entries(map)) {
            const sel = this._el?.querySelector(`#${selId}`);
            if (!sel) continue;
            for (const alias of aliases) {
                const idx = lower.indexOf(alias);
                if (idx >= 0) { sel.value = keys[idx]; break; }
            }
        }
    }

    _doImport() {
        const layerId = this._el.querySelector('#wc-import-layer')?.value;
        if (!layerId) { this.showToast?.('Select a layer', 'error'); return; }

        const layer = this.getLayers?.()?.find(l => l.id === layerId);
        if (!layer?.geojson) { this.showToast?.('Layer has no data', 'error'); return; }

        const fm = {};
        ['name', 'lat', 'lng', 'height', 'type', 'azimuth', 'beamwidth', 'radius', 'tech'].forEach(k => {
            const val = this._el.querySelector(`#wc-map-${k}`)?.value;
            if (val) fm[k] = val;
        });

        const hasCoords = layer.geojson.features.some(f => f.geometry?.type === 'Point');
        let imported;
        if (hasCoords && !fm.lat && !fm.lng) {
            imported = this.state.importFromGeoJSON(layer.geojson, fm);
        } else {
            const rows = layer.geojson.features.map(f => f.properties);
            imported = this.state.importFromTable(rows, fm);
        }

        this.showToast?.(`Imported ${imported.length} sites/antennas`, 'success');
        this._vizView = 'sites';
        this._refreshBody();
        this._bindEvents();
    }

    /* ── Export ── */
    _exportAsLayer() {
        const { fc, sitePoints } = buildCoverageFC(this.state.getAllSites());
        if (fc.features.length === 0) {
            this.showToast?.('No coverage to export', 'error');
            return;
        }

        // Merge coverage polygons + site points into one FC
        const combined = {
            type: 'FeatureCollection',
            features: [...fc.features, ...sitePoints.features],
        };

        if (this.createSpatialDataset && this.addLayer) {
            const ds = this.createSpatialDataset(`Wireless Coverage (${this.state.siteCount} sites)`, combined);
            this.addLayer(ds);
            this.refreshUI?.();
            this.showToast?.('Coverage exported as layer', 'success');
        } else {
            this.showToast?.('Export not available', 'error');
        }
    }

    _exportJSON() {
        const data = this.state.toJSON();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'wireless-config.json';
        a.click();
        URL.revokeObjectURL(url);
        this.showToast?.('Config downloaded', 'success', { duration: 1500 });
    }

    /* ================================================================
       ANALYSIS ENGINE — Grid-based coverage analysis
       ================================================================ */

    _runAnalysis() {
        const sites = this.state.getAllSites();
        if (sites.length === 0) { this.showToast?.('No sites to analyze', 'error'); return; }

        const areaMode = this._el.querySelector('#wc-analyze-area')?.value || 'bbox';
        const cellSize = parseFloat(this._el.querySelector('#wc-grid-size')?.value) || 0.5;
        const minOverlap = parseInt(this._el.querySelector('#wc-min-overlap')?.value) || 1;

        let bbox;
        if (areaMode === 'bbox') {
            const b = this.mapManager?.map?.getBounds();
            if (!b) { this.showToast?.('Map not ready', 'error'); return; }
            bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
        } else {
            // Union of all coverage polygons
            const { fc } = buildCoverageFC(sites);
            if (fc.features.length === 0) { this.showToast?.('No coverage polygons', 'error'); return; }
            try {
                const combined = turf.combine(fc);
                const tbbox = turf.bbox(combined);
                bbox = tbbox;
            } catch {
                const tbbox = turf.bbox(fc);
                bbox = tbbox;
            }
        }

        // Generate point grid
        let grid;
        try {
            grid = turf.pointGrid(bbox, cellSize, { units: 'kilometers' });
        } catch (err) {
            this.showToast?.('Grid generation failed: ' + err.message, 'error');
            return;
        }

        if (grid.features.length > 50000) {
            this.showToast?.('Grid too dense — increase cell size', 'error');
            return;
        }

        // Build coverage polygons
        const { fc: covFC } = buildCoverageFC(sites);
        const covPolys = covFC.features;

        // For each grid point, count how many coverage polygons contain it
        const overlapInfo = {};
        let coveredCells = 0;
        for (const pt of grid.features) {
            let count = 0;
            for (const poly of covPolys) {
                try {
                    if (turf.booleanPointInPolygon(pt, poly)) count++;
                } catch { /* skip invalid */ }
            }
            if (count >= minOverlap) coveredCells++;
            overlapInfo[count] = (overlapInfo[count] || 0) + 1;
        }

        const totalCells = grid.features.length;
        const uncoveredCells = totalCells - coveredCells;
        const coveragePercent = totalCells > 0 ? Math.round(coveredCells / totalCells * 100) : 0;

        this._analyzeResults = {
            totalCells,
            coveredCells,
            uncoveredCells,
            coveragePercent,
            overlapInfo,
        };

        this._refreshBody();
        this._bindEvents();
        logger.info('Wireless', `Analysis complete: ${coveragePercent}% coverage (${coveredCells}/${totalCells} cells)`);
    }

    /* ================================================================
       MAP RENDERING — Coverage polygons + site markers
       ================================================================ */

    _renderCoverageOnMap() {
        const map = this.mapManager?.map;
        if (!map) return;

        const { fc, sitePoints } = buildCoverageFC(this.state.getAllSites());

        // ── Coverage polygons ──
        if (map.getSource(COV_SRC)) {
            map.getSource(COV_SRC).setData(fc);
        } else {
            map.addSource(COV_SRC, { type: 'geojson', data: fc });

            // Fill layer  
            map.addLayer({
                id: COV_FILL,
                type: 'fill',
                source: COV_SRC,
                paint: {
                    'fill-color': ['get', '_color'],
                    'fill-opacity': 0.25,
                },
            });

            // Outline layer
            map.addLayer({
                id: COV_LINE,
                type: 'line',
                source: COV_SRC,
                paint: {
                    'line-color': ['get', '_color'],
                    'line-width': 1.5,
                    'line-opacity': 0.7,
                },
            });
        }

        // ── 3D extrusion (if 3D enabled) ──
        if (this.mapManager?.is3D) {
            if (!map.getLayer(COV_EXT)) {
                map.addLayer({
                    id: COV_EXT,
                    type: 'fill-extrusion',
                    source: COV_SRC,
                    paint: {
                        'fill-extrusion-color': ['get', '_color'],
                        'fill-extrusion-height': ['get', '_height'],
                        'fill-extrusion-base': 0,
                        'fill-extrusion-opacity': 0.4,
                    },
                });
            }
        } else {
            if (map.getLayer(COV_EXT)) {
                map.removeLayer(COV_EXT);
            }
        }

        // ── Site point markers ──
        if (map.getSource(SITE_SRC)) {
            map.getSource(SITE_SRC).setData(sitePoints);
        } else {
            map.addSource(SITE_SRC, { type: 'geojson', data: sitePoints });
            map.addLayer({
                id: SITE_CIRCLE,
                type: 'circle',
                source: SITE_SRC,
                paint: {
                    'circle-radius': 5,
                    'circle-color': '#ff4444',
                    'circle-stroke-color': '#ffffff',
                    'circle-stroke-width': 2,
                },
            });
        }
    }

    _removeCoverageFromMap() {
        const map = this.mapManager?.map;
        if (!map) return;
        for (const lid of [COV_FILL, COV_LINE, COV_EXT, SITE_CIRCLE]) {
            if (map.getLayer(lid)) map.removeLayer(lid);
        }
        for (const sid of [COV_SRC, SITE_SRC]) {
            if (map.getSource(sid)) map.removeSource(sid);
        }
    }

    /* ================================================================
       HELPERS
       ================================================================ */

    _esc(str) {
        return String(str ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }
}
