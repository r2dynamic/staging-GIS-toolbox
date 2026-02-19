/**
 * Spatial Analyzer Widget
 * Lets users analyze features in one layer that fall within a drawn area
 * or within features of an existing polygon layer.
 *
 * Features:
 *  - Attribute filtering on target layer (AND/OR, equals, contains, etc.)
 *  - Attribute filtering on polygon area layer
 *  - Spatial relationship options (intersects, wholly within, centroid within, etc.)
 */
import { WidgetBase } from './widget-base.js';
import logger from '../core/logger.js';

/* -- Filter operator definitions -- */
const FILTER_OPS = [
    { value: 'equals',           label: 'Equals' },
    { value: 'not_equals',       label: 'Does not equal' },
    { value: 'contains',         label: 'Contains' },
    { value: 'not_contains',     label: 'Does not contain' },
    { value: 'starts_with',      label: 'Starts with' },
    { value: 'ends_with',        label: 'Ends with' },
    { value: 'is_empty',         label: 'Is empty' },
    { value: 'is_not_empty',     label: 'Is not empty' },
    { value: 'greater_than',     label: 'Greater than' },
    { value: 'less_than',        label: 'Less than' },
    { value: 'greater_or_equal', label: 'Greater or equal' },
    { value: 'less_or_equal',    label: 'Less or equal' },
];

const SPATIAL_RELATIONS = [
    { value: 'intersects',      label: 'Partially or fully inside',   tip: 'Any feature that touches or overlaps the area' },
    { value: 'within',          label: 'Completely inside',           tip: 'Only features entirely contained within the area' },
    { value: 'centroid_within', label: 'Center point inside',         tip: 'Feature whose center falls inside the area' },
    { value: 'contains',        label: 'Contains the area',           tip: 'Feature that fully surrounds the search area' },
];

export class SpatialAnalyzerWidget extends WidgetBase {
    constructor() {
        super('spatial-analyzer', 'Find Features in Area', '\uD83D\uDD0E', { width: '420px' });

        // state
        this._analysisArea = null;
        this._areaSource = null;       // 'draw' | 'layer'
        this._areaLayerId = null;      // when areaSource === 'layer'
        this._targetLayerId = null;
        this._results = null;
        this._previewLayer = null;

        // filters  -- arrays of { field, op, value, conjunct }
        this._targetFilters = [];      // filters on the target (search) layer
        this._areaFilters = [];        // filters on the polygon area layer

        // spatial relationship
        this._spatialRelation = 'intersects';

        // injected deps
        this.getLayers = null;
        this.getLayerById = null;
        this.mapManager = null;
        this.addLayer = null;
        this.createSpatialDataset = null;
        this.refreshUI = null;
        this.showToast = null;
    }

    /* ======== Lifecycle ======== */

    onOpen() {
        this._reset();
        this._refreshBody();
        this._bindEvents();
    }

    onClose() {
        this._clearPreview();
        this._reset();
    }

    /* ================================================================
       RENDER -- main body
       ================================================================ */

    renderBody() {
        if (this._results) return this._renderResults();

        const layers = (this.getLayers?.() || []).filter(l => l.type === 'spatial');
        const polyLayers = layers.filter(l => this._hasPolygons(l));

        const layerOpts = layers.map(l =>
            `<option value="${l.id}" ${l.id === this._targetLayerId ? 'selected' : ''}>${l.name} (${l.geojson?.features?.length || 0})</option>`
        ).join('');

        const polyOpts = polyLayers.map(l =>
            `<option value="${l.id}" ${l.id === this._areaLayerId ? 'selected' : ''}>${l.name}</option>`
        ).join('');

        const areaStatus = this._analysisArea
            ? `<div style="padding:6px 10px;border-radius:var(--radius-sm);background:rgba(48,209,88,0.12);color:var(--success);font-size:12px;margin-top:6px;">
                \u2713 Area defined (${this._areaSource === 'draw' ? 'drawn on map' : 'from layer'})
               </div>`
            : '';

        /* -- target layer fields for filter builder -- */
        const targetFields = this._getLayerFields(this._targetLayerId);
        const targetFilterHtml = this._targetLayerId
            ? this._renderFilterSection('target', this._targetFilters, targetFields, 'Only include features where\u2026')
            : '';

        /* -- area-layer fields for filter builder (only when using polygon layer) -- */
        const areaFilterHtml = this._areaLayerId
            ? this._renderFilterSection('area', this._areaFilters, this._getLayerFields(this._areaLayerId), 'Only use polygons where\u2026')
            : '';

        /* -- spatial relationship -- */
        const spatialOpts = SPATIAL_RELATIONS.map(r =>
            `<option value="${r.value}" ${r.value === this._spatialRelation ? 'selected' : ''}>${r.label}</option>`
        ).join('');
        const selectedTip = SPATIAL_RELATIONS.find(r => r.value === this._spatialRelation)?.tip || '';

        return `
            <!-- STEP 1 -- target layer -->
            <div class="widget-step">
                <div class="widget-step-num ${this._targetLayerId ? 'done' : ''}">1</div>
                <div class="widget-step-content">
                    <h4>Which layer do you want to search?</h4>
                    <p>Pick the layer whose features you want to find.</p>
                    <div class="widget-field" style="margin-bottom:0;">
                        <select id="wa-target-layer">
                            <option value="">-- Choose a layer --</option>
                            ${layerOpts}
                        </select>
                    </div>
                    ${targetFilterHtml}
                </div>
            </div>

            <!-- STEP 2 -- search area -->
            <div class="widget-step">
                <div class="widget-step-num ${this._analysisArea ? 'done' : ''}">2</div>
                <div class="widget-step-content">
                    <h4>Define the search area</h4>
                    <p>Draw a shape on the map, or use an existing polygon layer.</p>
                    <div style="display:flex;gap:6px;flex-wrap:wrap;">
                        <button class="btn btn-sm btn-secondary" id="wa-draw-rect">▭ Draw Rectangle</button>
                        <button class="btn btn-sm btn-secondary" id="wa-draw-poly">⬠ Draw Polygon</button>
                        <button class="btn btn-sm btn-secondary" id="wa-draw-circle">◎ Draw Circle</button>
                    </div>
                    ${polyLayers.length > 0 ? `
                    <div style="margin-top:8px;">
                        <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">Or use an existing polygon layer:</div>
                        <select id="wa-area-layer" style="width:100%;padding:6px 8px;border-radius:var(--radius-sm);border:1px solid var(--border-dark);background:var(--bg);color:var(--text);font-size:13px;">
                            <option value="">-- Choose a polygon layer --</option>
                            ${polyOpts}
                        </select>
                    </div>` : ''}
                    ${areaFilterHtml}
                    ${areaStatus}
                </div>
            </div>

            <!-- STEP 3 -- spatial relationship -->
            <div class="widget-step">
                <div class="widget-step-num">3</div>
                <div class="widget-step-content">
                    <h4>How should features match the area?</h4>
                    <div class="widget-field" style="margin-bottom:0;">
                        <select id="wa-spatial-rel">
                            ${spatialOpts}
                        </select>
                        <div class="widget-hint">${selectedTip}</div>
                    </div>
                </div>
            </div>

            <div class="widget-divider"></div>

            <div style="display:flex;justify-content:flex-end;">
                <button class="btn btn-primary btn-sm" id="wa-run" ${!this._targetLayerId || !this._analysisArea ? 'disabled' : ''}>
                    \uD83D\uDD0D Find Features
                </button>
            </div>
        `;
    }

    /* -- Filter section builder (reused for target + area) -- */
    _renderFilterSection(prefix, filters, fields, placeholder) {
        if (!fields.length) return '';

        const fieldOpts = fields.map(f => `<option value="${f}">${f}</option>`).join('');
        const opOpts = FILTER_OPS.map(o => `<option value="${o.value}">${o.label}</option>`).join('');

        let rows = '';
        const layerId = prefix === 'target' ? this._targetLayerId : this._areaLayerId;

        filters.forEach((f, i) => {
            const needsValue = !['is_empty', 'is_not_empty'].includes(f.op);
            const selFieldOpts = fields.map(fld => `<option value="${fld}" ${fld === f.field ? 'selected' : ''}>${fld}</option>`).join('');
            const selOpOpts = FILTER_OPS.map(o => `<option value="${o.value}" ${o.value === f.op ? 'selected' : ''}>${o.label}</option>`).join('');

            // Build value dropdown from unique field values
            let valueHtml = '';
            if (needsValue) {
                const uniqueVals = this._getFieldValues(layerId, f.field);
                if (uniqueVals.length > 0 && uniqueVals.length <= 500) {
                    const valOpts = uniqueVals.map(v => `<option value="${this._escHtml(v)}" ${v === f.value ? 'selected' : ''}>${this._escHtml(v)}</option>`).join('');
                    valueHtml = `<select class="wa-filter-value" style="flex:1;min-width:70px;padding:4px;border-radius:4px;border:1px solid var(--border-dark);background:var(--bg);color:var(--text);font-size:12px;"><option value="">-- select --</option>${valOpts}</select>`;
                } else {
                    valueHtml = `<input class="wa-filter-value" type="text" value="${this._escHtml(f.value || '')}" placeholder="value" style="flex:1;min-width:70px;padding:4px 6px;border-radius:4px;border:1px solid var(--border-dark);background:var(--bg);color:var(--text);font-size:12px;">`;
                }
            }

            rows += `
                <div class="wa-filter-row" data-prefix="${prefix}" data-idx="${i}" style="display:flex;gap:4px;align-items:center;margin-bottom:4px;flex-wrap:wrap;">
                    ${i > 0 ? `<select class="wa-filter-conjunct" style="width:60px;padding:4px;border-radius:4px;border:1px solid var(--border-dark);background:var(--bg);color:var(--text);font-size:11px;">
                        <option value="and" ${f.conjunct === 'and' ? 'selected' : ''}>AND</option>
                        <option value="or" ${f.conjunct === 'or' ? 'selected' : ''}>OR</option>
                    </select>` : '<span style="width:60px;font-size:11px;color:var(--text-muted);">Where</span>'}
                    <select class="wa-filter-field" style="flex:1;min-width:80px;padding:4px;border-radius:4px;border:1px solid var(--border-dark);background:var(--bg);color:var(--text);font-size:12px;">${selFieldOpts}</select>
                    <select class="wa-filter-op" style="flex:1;min-width:100px;padding:4px;border-radius:4px;border:1px solid var(--border-dark);background:var(--bg);color:var(--text);font-size:12px;">${selOpOpts}</select>
                    ${valueHtml}
                    <button class="wa-filter-remove btn btn-ghost btn-sm" style="padding:2px 6px;font-size:14px;line-height:1;" title="Remove filter">\u00d7</button>
                </div>`;
        });

        return `
            <div class="wa-filter-block" data-prefix="${prefix}" style="margin-top:8px;padding:8px;border:1px solid var(--border);border-radius:var(--radius-sm);background:rgba(255,255,255,0.02);">
                <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">${placeholder}</div>
                <div class="wa-filter-rows">${rows}</div>
                <button class="btn btn-ghost btn-sm wa-filter-add" data-prefix="${prefix}" style="font-size:11px;margin-top:4px;">+ Add filter rule</button>
            </div>`;
    }

    /* -- Results view (Dashboard) -- */
    _renderResults() {
        const r = this._results;
        const pct = r.total > 0 ? Math.round((r.matched / r.total) * 100) : 0;
        const relLabel = SPATIAL_RELATIONS.find(s => s.value === this._spatialRelation)?.label || this._spatialRelation;

        /* --- Hero card: match rate --- */
        const circumference = 2 * Math.PI * 28;
        const dashOffset = circumference - (circumference * pct / 100);
        const heroCard = `
            <div class="dash-card dash-card-hero" style="display:flex;align-items:center;gap:16px;padding:16px;background:linear-gradient(135deg,rgba(219,172,63,0.08),rgba(219,172,63,0.02));border:1px solid rgba(219,172,63,0.18);border-radius:8px;">
                <div class="dash-hero-ring" style="position:relative;flex-shrink:0;width:64px;height:64px;">
                    <svg viewBox="0 0 64 64" width="64" height="64" style="display:block;">
                        <circle cx="32" cy="32" r="28" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="4"/>
                        <circle cx="32" cy="32" r="28" fill="none" stroke="var(--primary,#dbac3f)" stroke-width="4"
                            stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}"
                            stroke-linecap="round" transform="rotate(-90 32 32)"
                            style="transition:stroke-dashoffset .6s ease"/>
                    </svg>
                    <span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:var(--primary,#dbac3f);">${pct}%</span>
                </div>
                <div style="display:flex;flex-direction:column;gap:2px;">
                    <span style="font-size:24px;font-weight:700;color:var(--text,#f5f5f7);line-height:1.1;">${r.matched.toLocaleString()}</span>
                    <span style="font-size:12px;color:var(--text-muted,#98989d);">of ${r.total.toLocaleString()} features matched</span>
                    <span style="font-size:10px;color:var(--primary,#dbac3f);font-weight:500;margin-top:2px;">${relLabel}</span>
                </div>
            </div>`;

        /* --- Geometry breakdown card --- */
        const geoParts = [];
        if (r.stats.points > 0) geoParts.push({ icon: '📍', label: 'Points', val: r.stats.points });
        if (r.stats.lines > 0) geoParts.push({ icon: '〰️', label: 'Lines', val: r.stats.lines });
        if (r.stats.polygons > 0) geoParts.push({ icon: '⬡', label: 'Polygons', val: r.stats.polygons });

        let geoCard = '';
        if (geoParts.length > 0) {
            const items = geoParts.map(g => `
                <div style="display:flex;align-items:center;gap:6px;background:rgba(255,255,255,0.04);border-radius:6px;padding:8px 12px;flex:1;min-width:80px;">
                    <span style="font-size:16px;">${g.icon}</span>
                    <span style="font-size:18px;font-weight:700;color:var(--text,#f5f5f7);">${g.val.toLocaleString()}</span>
                    <span style="font-size:11px;color:var(--text-muted,#98989d);">${g.label}</span>
                </div>`).join('');
            geoCard = `
            <div class="dash-card" style="background:var(--bg-surface,#2c2c2e);border:1px solid var(--border,rgba(255,255,255,0.08));border-radius:8px;padding:12px 14px;">
                <div style="font-size:11px;font-weight:600;color:var(--text-muted,#98989d);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:8px;">Geometry Types</div>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">${items}</div>
            </div>`;
        }

        /* --- Measurement card --- */
        let measureCard = '';
        const measures = [];
        if (r.stats.totalLength != null) measures.push({ label: 'Total Length', value: r.stats.totalLength, icon: '📏' });
        if (r.stats.totalArea != null) measures.push({ label: 'Total Area', value: r.stats.totalArea, icon: '📐' });
        if (r.stats.preFilterCount != null && r.stats.preFilterCount !== r.total) {
            measures.push({ label: 'Pre-filter Count', value: `${r.stats.preFilterCount.toLocaleString()} → ${r.total.toLocaleString()}`, icon: '🔽' });
        }
        if (measures.length > 0) {
            const items = measures.map((m, i) => `
                <div style="display:flex;align-items:center;gap:10px;padding:6px 0;${i > 0 ? 'border-top:1px solid var(--border,rgba(255,255,255,0.08));' : ''}">
                    <span style="font-size:16px;flex-shrink:0;">${m.icon}</span>
                    <div style="display:flex;flex-direction:column;">
                        <span style="font-size:14px;font-weight:600;color:var(--text,#f5f5f7);">${m.value}</span>
                        <span style="font-size:11px;color:var(--text-muted,#98989d);">${m.label}</span>
                    </div>
                </div>`).join('');
            measureCard = `
            <div class="dash-card" style="background:var(--bg-surface,#2c2c2e);border:1px solid var(--border,rgba(255,255,255,0.08));border-radius:8px;padding:12px 14px;">
                <div style="font-size:11px;font-weight:600;color:var(--text-muted,#98989d);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:8px;">Measurements</div>
                ${items}
            </div>`;
        }

        /* --- Numeric field stats cards (2-col grid) --- */
        let numericCards = '';
        if (r.fieldStats?.numeric?.length) {
            const cards = r.fieldStats.numeric.slice(0, 6).map(ns => {
                const range = ns.max - ns.min;
                const sparkBars = ns.histogram.map((h, i) => {
                    const barH = ns.histMax > 0 ? Math.max(2, Math.round((h / ns.histMax) * 28)) : 2;
                    return `<div style="flex:1;min-width:0;height:${barH}px;background:var(--primary,#dbac3f);border-radius:2px 2px 0 0;opacity:0.7;"></div>`;
                }).join('');
                return `
                <div class="dash-card dash-card-numeric" style="background:var(--bg-surface,#2c2c2e);border:1px solid var(--border,rgba(255,255,255,0.08));border-radius:8px;padding:12px 14px;">
                    <div style="font-size:11px;font-weight:600;color:var(--text-muted,#98989d);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:8px;">${this._escHtml(ns.field)}</div>
                    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px 10px;">
                        <div style="display:flex;flex-direction:column;align-items:center;text-align:center;padding:4px 0;">
                            <span style="font-size:13px;font-weight:700;color:var(--text,#f5f5f7);">${this._fmtNum(ns.min)}</span>
                            <span style="font-size:10px;color:var(--text-muted,#98989d);text-transform:uppercase;">Min</span>
                        </div>
                        <div style="display:flex;flex-direction:column;align-items:center;text-align:center;padding:4px 0;">
                            <span style="font-size:13px;font-weight:700;color:var(--text,#f5f5f7);">${this._fmtNum(ns.max)}</span>
                            <span style="font-size:10px;color:var(--text-muted,#98989d);text-transform:uppercase;">Max</span>
                        </div>
                        <div style="display:flex;flex-direction:column;align-items:center;text-align:center;padding:4px 0;">
                            <span style="font-size:13px;font-weight:700;color:var(--text,#f5f5f7);">${this._fmtNum(ns.mean)}</span>
                            <span style="font-size:10px;color:var(--text-muted,#98989d);text-transform:uppercase;">Mean</span>
                        </div>
                        <div style="display:flex;flex-direction:column;align-items:center;text-align:center;padding:4px 0;">
                            <span style="font-size:13px;font-weight:700;color:var(--text,#f5f5f7);">${this._fmtNum(ns.median)}</span>
                            <span style="font-size:10px;color:var(--text-muted,#98989d);text-transform:uppercase;">Median</span>
                        </div>
                        <div style="display:flex;flex-direction:column;align-items:center;text-align:center;padding:4px 0;">
                            <span style="font-size:13px;font-weight:700;color:var(--text,#f5f5f7);">${this._fmtNum(ns.stdDev)}</span>
                            <span style="font-size:10px;color:var(--text-muted,#98989d);text-transform:uppercase;">Std Dev</span>
                        </div>
                        <div style="display:flex;flex-direction:column;align-items:center;text-align:center;padding:4px 0;">
                            <span style="font-size:13px;font-weight:700;color:var(--text,#f5f5f7);">${ns.count.toLocaleString()}</span>
                            <span style="font-size:10px;color:var(--text-muted,#98989d);text-transform:uppercase;">Count</span>
                        </div>
                    </div>
                    ${range > 0 ? `<div style="display:flex;align-items:flex-end;gap:2px;height:32px;margin-top:10px;padding-top:4px;border-top:1px solid var(--border,rgba(255,255,255,0.08));" title="Distribution">${sparkBars}</div>` : ''}
                </div>`;
            }).join('');
            numericCards = `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;">${cards}</div>`;
        }

        /* --- Categorical field cards (top values) --- */
        let catCards = '';
        if (r.fieldStats?.categorical?.length) {
            const cards = r.fieldStats.categorical.slice(0, 4).map(cs => {
                const rows = cs.topValues.map(tv => {
                    const barW = cs.totalNonEmpty > 0 ? Math.max(3, Math.round((tv.count / cs.totalNonEmpty) * 100)) : 0;
                    return `
                    <div style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px;">
                        <span style="width:90px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text,#f5f5f7);font-size:11px;" title="${this._escHtml(tv.value)}">${this._escHtml(tv.value)}</span>
                        <div style="flex:1;height:6px;background:rgba(255,255,255,0.04);border-radius:3px;overflow:hidden;">
                            <div style="height:100%;width:${barW}%;background:var(--primary,#dbac3f);border-radius:3px;min-width:3px;"></div>
                        </div>
                        <span style="font-size:11px;color:var(--text-muted,#98989d);min-width:24px;text-align:right;">${tv.count}</span>
                    </div>`;
                }).join('');
                return `
                <div class="dash-card dash-card-cat" style="background:var(--bg-surface,#2c2c2e);border:1px solid var(--border,rgba(255,255,255,0.08));border-radius:8px;padding:12px 14px;">
                    <div style="font-size:11px;font-weight:600;color:var(--text-muted,#98989d);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
                        ${this._escHtml(cs.field)}
                        <span style="font-size:10px;background:rgba(255,255,255,0.06);color:var(--text-muted,#98989d);padding:1px 6px;border-radius:10px;font-weight:500;text-transform:none;letter-spacing:0;">${cs.uniqueCount} unique</span>
                    </div>
                    ${rows}
                    ${cs.nullCount > 0 ? `<div style="font-size:10px;color:var(--text-light,#636366);margin-top:4px;font-style:italic;">${cs.nullCount} empty/null</div>` : ''}
                </div>`;
            }).join('');
            catCards = `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;">${cards}</div>`;
        }

        return `
            <div style="display:flex;flex-direction:column;gap:10px;">
                ${heroCard}
                ${geoCard}
                ${measureCard}
                ${numericCards}
                ${catCards}
            </div>
            <div style="height:1px;background:var(--border,rgba(255,255,255,0.08));margin:14px 0;"></div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button class="btn btn-primary btn-sm" id="wa-add-results" ${r.matched === 0 ? 'disabled' : ''}>➕ Add Results as Layer</button>
                <button class="btn btn-secondary btn-sm" id="wa-add-area">➕ Add Area as Layer</button>
                <button class="btn btn-ghost btn-sm" id="wa-back">← Start Over</button>
            </div>
        `;
    }

    /* -- Format a number for display (handles large, small, integers) -- */
    _fmtNum(n) {
        if (n == null || isNaN(n)) return '—';
        if (Number.isInteger(n) && Math.abs(n) < 1e9) return n.toLocaleString();
        if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
        if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
        if (Math.abs(n) < 0.01 && n !== 0) return n.toExponential(2);
        return parseFloat(n.toFixed(3)).toLocaleString();
    }

    /* ================================================================
       EVENT BINDING
       ================================================================ */

    _bindEvents() {
        if (!this._el) return;
        const body = this.body;
        body.onclick = (e) => this._handleClick(e);
        body.onchange = (e) => this._handleChange(e);
        body.oninput = (e) => this._handleInput(e);
    }

    _handleClick(e) {
        const btn = e.target.closest('button');
        if (!btn) return;

        const id = btn.id;
        if (id === 'wa-draw-rect') this._drawRectangle();
        else if (id === 'wa-draw-poly') this._drawPolygon();
        else if (id === 'wa-draw-circle') this._drawCircle();
        else if (id === 'wa-run') this._runAnalysis();
        else if (id === 'wa-add-results') this._addResultsAsLayer();
        else if (id === 'wa-add-area') this._addAreaAsLayer();
        else if (id === 'wa-back') this._startOver();
        else if (btn.classList.contains('wa-filter-add')) {
            const prefix = btn.dataset.prefix;
            this._addFilterRule(prefix);
        } else if (btn.classList.contains('wa-filter-remove')) {
            const row = btn.closest('.wa-filter-row');
            if (row) this._removeFilterRule(row.dataset.prefix, parseInt(row.dataset.idx));
        }
    }

    _handleChange(e) {
        const el = e.target;
        if (el.id === 'wa-target-layer') {
            this._targetLayerId = el.value || null;
            this._targetFilters = [];
            this._refreshBody();
            this._bindEvents();
        } else if (el.id === 'wa-area-layer') {
            if (el.value) {
                this._areaLayerId = el.value;
                this._areaFilters = [];
                this._useLayerAsArea(el.value);
            } else {
                this._areaLayerId = null;
                this._areaFilters = [];
            }
        } else if (el.id === 'wa-spatial-rel') {
            this._spatialRelation = el.value;
            const hint = el.closest('.widget-field')?.querySelector('.widget-hint');
            if (hint) hint.textContent = SPATIAL_RELATIONS.find(r => r.value === el.value)?.tip || '';
        } else if (el.classList.contains('wa-filter-field') || el.classList.contains('wa-filter-op') || el.classList.contains('wa-filter-conjunct')) {
            this._syncFiltersFromDOM();
            if (el.classList.contains('wa-filter-op') || el.classList.contains('wa-filter-field')) {
                // Re-render to update value dropdown when field or op changes
                this._refreshBody();
                this._bindEvents();
            }
        } else if (el.classList.contains('wa-filter-value')) {
            this._syncFiltersFromDOM();
        }
    }

    _handleInput(e) {
        if (e.target.classList.contains('wa-filter-value')) {
            this._syncFiltersFromDOM();
        }
    }

    /* ================================================================
       FILTER MANAGEMENT
       ================================================================ */

    _addFilterRule(prefix) {
        const filters = prefix === 'target' ? this._targetFilters : this._areaFilters;
        const fields = this._getLayerFields(prefix === 'target' ? this._targetLayerId : this._areaLayerId);
        filters.push({ field: fields[0] || '', op: 'equals', value: '', conjunct: 'and' });
        this._refreshBody();
        this._bindEvents();
    }

    _removeFilterRule(prefix, idx) {
        const filters = prefix === 'target' ? this._targetFilters : this._areaFilters;
        filters.splice(idx, 1);
        this._refreshBody();
        this._bindEvents();
    }

    _syncFiltersFromDOM() {
        this._syncFilterBlock('target', this._targetFilters);
        this._syncFilterBlock('area', this._areaFilters);
    }

    _syncFilterBlock(prefix, filters) {
        const rows = this._el?.querySelectorAll(`.wa-filter-row[data-prefix="${prefix}"]`);
        if (!rows) return;
        rows.forEach((row, i) => {
            if (!filters[i]) return;
            const field = row.querySelector('.wa-filter-field');
            const op = row.querySelector('.wa-filter-op');
            const value = row.querySelector('.wa-filter-value');
            const conj = row.querySelector('.wa-filter-conjunct');
            if (field) filters[i].field = field.value;
            if (op) filters[i].op = op.value;
            if (value) filters[i].value = value.value;
            if (conj) filters[i].conjunct = conj.value;
        });
    }

    _applyAttributeFilters(features, filters) {
        if (!filters.length) return features;

        return features.filter(f => {
            const props = f.properties || {};
            let result = this._evalCondition(props, filters[0]);

            for (let i = 1; i < filters.length; i++) {
                const cond = this._evalCondition(props, filters[i]);
                if (filters[i].conjunct === 'or') {
                    result = result || cond;
                } else {
                    result = result && cond;
                }
            }
            return result;
        });
    }

    _evalCondition(props, filter) {
        const raw = props[filter.field];
        const val = raw == null ? '' : String(raw);
        const cmp = (filter.value || '').trim();
        const valLower = val.toLowerCase();
        const cmpLower = cmp.toLowerCase();

        switch (filter.op) {
            case 'equals':           return valLower === cmpLower;
            case 'not_equals':       return valLower !== cmpLower;
            case 'contains':         return valLower.includes(cmpLower);
            case 'not_contains':     return !valLower.includes(cmpLower);
            case 'starts_with':      return valLower.startsWith(cmpLower);
            case 'ends_with':        return valLower.endsWith(cmpLower);
            case 'is_empty':         return val === '' || raw == null;
            case 'is_not_empty':     return val !== '' && raw != null;
            case 'greater_than': {
                const a = parseFloat(val), b = parseFloat(cmp);
                return !isNaN(a) && !isNaN(b) && a > b;
            }
            case 'less_than': {
                const a = parseFloat(val), b = parseFloat(cmp);
                return !isNaN(a) && !isNaN(b) && a < b;
            }
            case 'greater_or_equal': {
                const a = parseFloat(val), b = parseFloat(cmp);
                return !isNaN(a) && !isNaN(b) && a >= b;
            }
            case 'less_or_equal': {
                const a = parseFloat(val), b = parseFloat(cmp);
                return !isNaN(a) && !isNaN(b) && a <= b;
            }
            default: return true;
        }
    }

    /* ================================================================
       SPATIAL RELATIONSHIP CHECK
       ================================================================ */

    _checkSpatialRelation(feature, area) {
        const type = feature.geometry?.type;
        if (!type) return false;

        switch (this._spatialRelation) {
            case 'intersects':
                if (type === 'Point') return turf.booleanPointInPolygon(feature, area);
                if (type === 'MultiPoint') return feature.geometry.coordinates.some(c => turf.booleanPointInPolygon(turf.point(c), area));
                return turf.booleanIntersects(feature, area);

            case 'within':
                if (type === 'Point') return turf.booleanPointInPolygon(feature, area);
                if (type === 'MultiPoint') return feature.geometry.coordinates.every(c => turf.booleanPointInPolygon(turf.point(c), area));
                return turf.booleanWithin(feature, area);

            case 'centroid_within':
                try {
                    const c = turf.centroid(feature);
                    return turf.booleanPointInPolygon(c, area);
                } catch { return false; }

            case 'contains':
                try { return turf.booleanContains(feature, area); } catch { return false; }

            default:
                return turf.booleanIntersects(feature, area);
        }
    }

    /* ================================================================
       ACTIONS
       ================================================================ */

    async _drawRectangle() {
        if (!this.mapManager) return;
        this.showToast?.('Draw a rectangle on the map', 'info');
        const bbox = await this.mapManager.startRectangleDraw('Click and drag to draw your search area');
        if (!bbox) return;

        const [west, south, east, north] = bbox;
        this._analysisArea = turf.bboxPolygon([west, south, east, north]);
        this._areaSource = 'draw';
        this._areaLayerId = null;
        this._areaFilters = [];
        this._showAreaPreview();
        this._refreshBody();
        this._bindEvents();
    }

    async _drawPolygon() {
        if (!this.mapManager) return;
        this.showToast?.('Click to place points, double-click to finish', 'info');

        const map = this.mapManager.map;
        if (!map) return;

        // Disable double-click zoom so dblclick can finish the polygon
        const hadDblClickZoom = map.doubleClickZoom.enabled();
        map.doubleClickZoom.disable();

        return new Promise((resolve) => {
            const points = [];
            let polyline = null;
            let previewPoly = null;
            let clickTimer = null;
            const container = map.getContainer();
            container.style.cursor = 'crosshair';

            const banner = this.mapManager._showInteractionBanner?.(
                'Click to add points. Double-click to finish the area.',
                () => { cleanup(); resolve(); }
            );

            const drawPreview = () => {
                if (polyline) { map.removeLayer(polyline); polyline = null; }
                if (previewPoly) { map.removeLayer(previewPoly); previewPoly = null; }
                if (points.length >= 2) {
                    polyline = L.polyline(points, { color: '#d4a24e', weight: 2, dashArray: '6,4' }).addTo(map);
                }
                if (points.length >= 3) {
                    previewPoly = L.polygon(points, { color: '#d4a24e', weight: 1, fillOpacity: 0.08, dashArray: '4,4' }).addTo(map);
                }
            };

            // Use a short timer to distinguish click from dblclick
            const onClick = (e) => {
                if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; } // dblclick will handle
                clickTimer = setTimeout(() => {
                    clickTimer = null;
                    points.push([e.latlng.lat, e.latlng.lng]);
                    drawPreview();
                }, 200);
            };

            const onDblClick = (e) => {
                if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
                L.DomEvent.stopPropagation(e);
                L.DomEvent.preventDefault(e);
                // Add the double-click point
                points.push([e.latlng.lat, e.latlng.lng]);
                finish();
            };

            const onKeydown = (e) => { if (e.key === 'Escape') { cleanup(); resolve(); } };

            const finish = () => {
                if (points.length < 3) {
                    this.showToast?.('Need at least 3 points to make an area', 'warning');
                    cleanup(); resolve(); return;
                }
                const coords = points.map(p => [p[1], p[0]]);
                coords.push(coords[0]); // close the ring
                this._analysisArea = turf.polygon([coords]);
                this._areaSource = 'draw';
                this._areaLayerId = null;
                this._areaFilters = [];
                cleanup();
                this._showAreaPreview();
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
                if (polyline) { map.removeLayer(polyline); polyline = null; }
                if (previewPoly) { map.removeLayer(previewPoly); previewPoly = null; }
                if (banner) banner.remove?.();
                if (hadDblClickZoom) map.doubleClickZoom.enable();
            };

            map.on('click', onClick);
            map.on('dblclick', onDblClick);
            document.addEventListener('keydown', onKeydown);
        });
    }

    async _drawCircle() {
        if (!this.mapManager) return;
        this.showToast?.('Click center, then click to set radius', 'info');

        const map = this.mapManager.map;
        if (!map) return;

        return new Promise((resolve) => {
            let center = null;
            let circle = null;
            const container = map.getContainer();
            container.style.cursor = 'crosshair';

            const banner = this.mapManager._showInteractionBanner?.(
                'Click to place the center, then click again to set the radius. Esc to cancel.',
                () => { cleanup(); resolve(); }
            );

            const onClick = (e) => {
                if (!center) {
                    // First click = center
                    center = e.latlng;
                    if (banner) {
                        const txt = banner.querySelector?.('span') || banner;
                        if (txt.textContent !== undefined) txt.textContent = 'Move mouse to set radius, click to confirm.';
                    }
                } else {
                    // Second click = set radius and finish
                    const radiusM = center.distanceTo(e.latlng);
                    finish(center, radiusM);
                }
            };

            const onMouseMove = (e) => {
                if (!center) return;
                const radiusM = center.distanceTo(e.latlng);
                if (circle) {
                    circle.setRadius(radiusM);
                } else {
                    circle = L.circle(center, {
                        radius: radiusM,
                        color: '#d4a24e', weight: 2, fillOpacity: 0.12, dashArray: '6,4'
                    }).addTo(map);
                }
            };

            const onKeydown = (e) => { if (e.key === 'Escape') { cleanup(); resolve(); } };

            const finish = (c, radiusM) => {
                if (radiusM < 1) {
                    this.showToast?.('Radius too small', 'warning');
                    cleanup(); resolve(); return;
                }
                // Convert circle to a 64-sided polygon via turf
                try {
                    this._analysisArea = turf.circle([c.lng, c.lat], radiusM / 1000, { units: 'kilometers', steps: 64 });
                } catch {
                    this._analysisArea = turf.buffer(turf.point([c.lng, c.lat]), radiusM / 1000, { units: 'kilometers', steps: 64 });
                }
                this._areaSource = 'draw';
                this._areaLayerId = null;
                this._areaFilters = [];
                cleanup();
                this._showAreaPreview();
                this._refreshBody();
                this._bindEvents();
                resolve();
            };

            const cleanup = () => {
                container.style.cursor = '';
                map.off('click', onClick);
                map.off('mousemove', onMouseMove);
                document.removeEventListener('keydown', onKeydown);
                if (circle) { try { map.removeLayer(circle); } catch {} circle = null; }
                if (banner) banner.remove?.();
            };

            map.on('click', onClick);
            map.on('mousemove', onMouseMove);
            document.addEventListener('keydown', onKeydown);
        });
    }

    _useLayerAsArea(layerId) {
        const layers = this.getLayers?.() || [];
        const layer = layers.find(l => l.id === layerId);
        if (!layer?.geojson?.features?.length) return;

        // Show spinner while computing
        this._showSpinner('Building area from polygon layer…');

        // Use setTimeout so the spinner renders before blocking work
        setTimeout(() => {
            try {
                let polys = layer.geojson.features.filter(f =>
                    f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')
                );

                // Apply area-layer attribute filters
                polys = this._applyAttributeFilters(polys, this._areaFilters);

                if (polys.length === 0) {
                    this.showToast?.('No matching polygon features in that layer', 'warning');
                    this._hideSpinner();
                    return;
                }

                if (polys.length === 1) {
                    this._analysisArea = polys[0];
                } else {
                    try {
                        let merged = polys[0];
                        for (let i = 1; i < polys.length; i++) {
                            const result = turf.union(turf.featureCollection([merged, polys[i]]));
                            if (result) merged = result;
                        }
                        this._analysisArea = merged;
                    } catch {
                        this._analysisArea = turf.convex(turf.featureCollection(polys));
                    }
                }

                this._areaSource = 'layer';
                this._hideSpinner();
                this._showAreaPreview();
                this._refreshBody();
                this._bindEvents();
            } catch (err) {
                this._hideSpinner();
                this.showToast?.('Error building area: ' + err.message, 'error');
            }
        }, 30);
    }

    _showSpinner(message = 'Processing…') {
        const body = this.body;
        if (!body) return;
        // Insert an overlay spinner at the top of the widget body
        let overlay = body.querySelector('.wa-spinner-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'wa-spinner-overlay';
            overlay.style.cssText = 'position:absolute;inset:0;z-index:10;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:rgba(0,0,0,0.65);border-radius:8px;';
            body.style.position = 'relative';
            body.appendChild(overlay);
        }
        overlay.innerHTML = `
            <div style="width:32px;height:32px;border:3px solid rgba(255,255,255,0.15);border-top-color:var(--primary,#dbac3f);border-radius:50%;animation:wa-spin .8s linear infinite;"></div>
            <span style="font-size:12px;color:var(--text-muted,#98989d);">${this._escHtml(message)}</span>
            <style>@keyframes wa-spin{to{transform:rotate(360deg)}}</style>
        `;
    }

    _hideSpinner() {
        const body = this.body;
        if (!body) return;
        const overlay = body.querySelector('.wa-spinner-overlay');
        if (overlay) overlay.remove();
    }

    _runAnalysis() {
        if (!this._targetLayerId || !this._analysisArea) return;

        // Re-sync filters from DOM before running
        this._syncFiltersFromDOM();

        // If using a layer area and there are area filters, re-build the area first
        if (this._areaLayerId && this._areaFilters.length > 0) {
            this._useLayerAsArea(this._areaLayerId);
            if (!this._analysisArea) return;
        }

        const layers = this.getLayers?.() || [];
        const targetLayer = layers.find(l => l.id === this._targetLayerId);
        if (!targetLayer?.geojson?.features?.length) {
            this.showToast?.('Target layer has no features', 'warning');
            return;
        }

        this._showSpinner('Analyzing features…');

        setTimeout(() => {
        try {
        const preFilterCount = targetLayer.geojson.features.length;
        let features = [...targetLayer.geojson.features];

        // Apply target attribute filters
        features = this._applyAttributeFilters(features, this._targetFilters);
        const afterFilterCount = features.length;

        const area = this._analysisArea;
        const matched = [];
        const stats = { points: 0, lines: 0, polygons: 0, totalLength: null, totalArea: null, preFilterCount };

        let totalLengthKm = 0;
        let totalAreaSqKm = 0;
        let hasLines = false;
        let hasPolygons = false;

        for (const f of features) {
            if (!f.geometry) continue;
            try {
                const inside = this._checkSpatialRelation(f, area);

                if (inside) {
                    matched.push(f);
                    const type = f.geometry.type;
                    if (type === 'Point' || type === 'MultiPoint') stats.points++;
                    else if (type === 'LineString' || type === 'MultiLineString') {
                        stats.lines++;
                        hasLines = true;
                        try { totalLengthKm += turf.length(f, { units: 'kilometers' }); } catch {}
                    } else if (type === 'Polygon' || type === 'MultiPolygon') {
                        stats.polygons++;
                        hasPolygons = true;
                        try { totalAreaSqKm += turf.area(f) / 1e6; } catch {}
                    }
                }
            } catch {
                try {
                    const c = turf.centroid(f);
                    if (turf.booleanPointInPolygon(c, area)) matched.push(f);
                } catch {}
            }
        }

        if (hasLines) {
            const totalLengthFt = totalLengthKm * 3280.84;
            if (totalLengthFt < 5280) {
                stats.totalLength = `${Math.round(totalLengthFt).toLocaleString()} ft`;
            } else {
                const totalLengthMi = totalLengthFt / 5280;
                stats.totalLength = `${totalLengthMi.toFixed(2)} mi`;
            }
        }
        if (hasPolygons) {
            const totalAreaSqFt = totalAreaSqKm * 1.076e7;
            const totalAreaAcres = totalAreaSqFt / 43560;
            if (totalAreaAcres < 1) {
                stats.totalArea = `${Math.round(totalAreaSqFt).toLocaleString()} ft\u00b2`;
            } else if (totalAreaAcres < 640) {
                stats.totalArea = `${totalAreaAcres.toFixed(2)} acres`;
            } else {
                const totalAreaSqMi = totalAreaAcres / 640;
                stats.totalArea = `${totalAreaSqMi.toFixed(3)} mi\u00b2`;
            }
        }

        this._results = {
            matched: matched.length,
            total: afterFilterCount,
            features: matched,
            stats,
            fieldStats: this._computeFieldStats(matched),
            targetLayerName: targetLayer.name
        };

        this._hideSpinner();
        this._highlightResults(matched);
        this._refreshBody();
        this._bindEvents();

        logger.info('SpatialAnalyzer', `Found ${matched.length}/${afterFilterCount} features in area (spatial: ${this._spatialRelation})`);
        } catch (err) {
            this._hideSpinner();
            this.showToast?.('Analysis error: ' + err.message, 'error');
        }
        }, 30);
    }

    /* ================================================================
       FIELD STATISTICS  (numeric + categorical)
       ================================================================ */
    _computeFieldStats(features) {
        if (!features?.length) return { numeric: [], categorical: [] };

        // Gather all property keys from sample (first 200)
        const keySet = new Set();
        features.slice(0, 200).forEach(f => {
            Object.keys(f.properties || {}).forEach(k => keySet.add(k));
        });
        const keys = [...keySet];

        // Classify fields: numeric vs categorical
        const numericFields = [];
        const categoricalFields = [];
        const NUMERIC_BIN_COUNT = 10;

        for (const key of keys) {
            const values = [];
            let numericCount = 0;
            let totalCount = 0;

            for (const f of features) {
                const raw = f.properties?.[key];
                if (raw == null || raw === '') continue;
                totalCount++;
                const num = Number(raw);
                if (!isNaN(num) && isFinite(num)) {
                    numericCount++;
                    values.push(num);
                }
            }

            // Consider field numeric if ≥70% of non-null values parse as numbers and at least 3 values
            if (numericCount >= 3 && numericCount / totalCount >= 0.7) {
                values.sort((a, b) => a - b);
                const count = values.length;
                const sum = values.reduce((s, v) => s + v, 0);
                const mean = sum / count;
                const median = count % 2 === 0
                    ? (values[count / 2 - 1] + values[count / 2]) / 2
                    : values[Math.floor(count / 2)];
                const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / count;
                const stdDev = Math.sqrt(variance);
                const min = values[0];
                const max = values[count - 1];

                // Build histogram
                const histogram = new Array(NUMERIC_BIN_COUNT).fill(0);
                const range = max - min;
                if (range > 0) {
                    for (const v of values) {
                        let bin = Math.floor(((v - min) / range) * NUMERIC_BIN_COUNT);
                        if (bin >= NUMERIC_BIN_COUNT) bin = NUMERIC_BIN_COUNT - 1;
                        histogram[bin]++;
                    }
                } else {
                    histogram[0] = count; // all same value
                }
                const histMax = Math.max(...histogram);

                numericFields.push({ field: key, min, max, mean, median, stdDev, count, sum, histogram, histMax });
            } else if (totalCount >= 1) {
                // Categorical analysis
                const freqMap = {};
                let nullCount = 0;
                for (const f of features) {
                    const raw = f.properties?.[key];
                    if (raw == null || raw === '') { nullCount++; continue; }
                    const str = String(raw);
                    freqMap[str] = (freqMap[str] || 0) + 1;
                }
                const entries = Object.entries(freqMap).sort((a, b) => b[1] - a[1]);
                const uniqueCount = entries.length;
                const totalNonEmpty = entries.reduce((s, e) => s + e[1], 0);
                if (uniqueCount <= 1 && uniqueCount === totalNonEmpty) continue; // skip single-value / id-like fields

                // Skip fields that look like IDs (every value unique and >20 values)
                if (uniqueCount > 20 && uniqueCount === totalNonEmpty) continue;

                const topValues = entries.slice(0, 6).map(([value, count]) => ({ value, count }));

                categoricalFields.push({ field: key, uniqueCount, topValues, nullCount, totalNonEmpty });
            }
        }

        // Sort: numeric by count desc, categorical by unique count (most interesting first)
        numericFields.sort((a, b) => b.count - a.count);
        categoricalFields.sort((a, b) => {
            // Prefer fields with moderate uniqueness (2-50 values) over very-high or 1-value
            const scoreA = a.uniqueCount >= 2 && a.uniqueCount <= 50 ? 1000 - a.uniqueCount : -a.uniqueCount;
            const scoreB = b.uniqueCount >= 2 && b.uniqueCount <= 50 ? 1000 - b.uniqueCount : -b.uniqueCount;
            return scoreB - scoreA;
        });

        return { numeric: numericFields, categorical: categoricalFields };
    }

    _addResultsAsLayer() {
        if (!this._results?.features?.length) return;
        const fc = { type: 'FeatureCollection', features: this._results.features };
        const dataset = this.createSpatialDataset?.(
            `${this._results.targetLayerName}_analysis_results`, fc, { format: 'derived' }
        );
        if (!dataset) return;
        this.addLayer?.(dataset);
        const layers = this.getLayers?.() || [];
        this.mapManager?.addLayer(dataset, layers.indexOf(dataset), { fit: true });
        this.refreshUI?.();
        this.showToast?.(`Added ${this._results.matched} features as new layer`, 'success');
    }

    _addAreaAsLayer() {
        if (!this._analysisArea) return;
        const fc = {
            type: 'FeatureCollection',
            features: [{ ...this._analysisArea, properties: { name: 'Analysis Area', source: this._areaSource } }]
        };
        const dataset = this.createSpatialDataset?.('Analysis_Area', fc, { format: 'derived' });
        if (!dataset) return;
        this.addLayer?.(dataset);
        const layers = this.getLayers?.() || [];
        this.mapManager?.addLayer(dataset, layers.indexOf(dataset), { fit: true });
        this.refreshUI?.();
        this.showToast?.('Analysis area added as layer', 'success');
    }

    _startOver() {
        this._clearPreview();
        this._results = null;
        this._analysisArea = null;
        this._areaSource = null;
        this._areaLayerId = null;
        this._targetLayerId = null;
        this._targetFilters = [];
        this._areaFilters = [];
        this._spatialRelation = 'intersects';
        this._refreshBody();
        this._bindEvents();
    }

    /* ================================================================
       MAP PREVIEW
       ================================================================ */

    _showAreaPreview() {
        this._clearPreview();
        if (!this._analysisArea || !this.mapManager?.map) return;
        try {
            const geoLayer = L.geoJSON(this._analysisArea, {
                style: { color: '#d4a24e', weight: 2, fillOpacity: 0.12, dashArray: '6,4' }
            });
            this._previewLayer = geoLayer;
            geoLayer.addTo(this.mapManager.map);
        } catch {}
    }

    _highlightResults(features) {
        this._clearPreview();
        if (!features.length || !this.mapManager?.map) return;
        try {
            const group = L.featureGroup();
            if (this._analysisArea) {
                L.geoJSON(this._analysisArea, {
                    style: { color: '#d4a24e', weight: 2, fillOpacity: 0.08, dashArray: '6,4' }
                }).addTo(group);
            }
            L.geoJSON({ type: 'FeatureCollection', features }, {
                style: { color: '#30d158', weight: 3, fillOpacity: 0.25 },
                pointToLayer: (f, latlng) => L.circleMarker(latlng, {
                    radius: 6, color: '#30d158', weight: 2, fillColor: '#30d158', fillOpacity: 0.5
                })
            }).addTo(group);
            this._previewLayer = group;
            group.addTo(this.mapManager.map);
        } catch {}
    }

    _clearPreview() {
        if (this._previewLayer && this.mapManager?.map) {
            try { this.mapManager.map.removeLayer(this._previewLayer); } catch {}
        }
        this._previewLayer = null;
    }

    /* ================================================================
       HELPERS
       ================================================================ */

    _getLayerFields(layerId) {
        if (!layerId) return [];
        const layers = this.getLayers?.() || [];
        const layer = layers.find(l => l.id === layerId);
        if (!layer?.geojson?.features?.length) return [];
        const keys = new Set();
        layer.geojson.features.slice(0, 100).forEach(f => {
            Object.keys(f.properties || {}).forEach(k => keys.add(k));
        });
        return [...keys].sort();
    }

    /** Get sorted unique values for a field in a layer (up to 500) */
    _getFieldValues(layerId, fieldName) {
        if (!layerId || !fieldName) return [];
        const layers = this.getLayers?.() || [];
        const layer = layers.find(l => l.id === layerId);
        if (!layer?.geojson?.features?.length) return [];
        const vals = new Set();
        for (const f of layer.geojson.features) {
            const v = f.properties?.[fieldName];
            if (v != null && v !== '') vals.add(String(v));
            if (vals.size > 500) break; // cap for performance
        }
        return [...vals].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    }

    _updateRunButton() {
        const btn = this._el?.querySelector('#wa-run');
        if (btn) btn.disabled = !this._targetLayerId || !this._analysisArea;
    }

    _reset() {
        this._analysisArea = null;
        this._areaSource = null;
        this._areaLayerId = null;
        this._targetLayerId = null;
        this._results = null;
        this._targetFilters = [];
        this._areaFilters = [];
        this._spatialRelation = 'intersects';
        this._clearPreview();
    }

    _hasPolygons(layer) {
        return layer.geojson?.features?.some(f =>
            f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')
        );
    }

    _escHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }
}

export default SpatialAnalyzerWidget;