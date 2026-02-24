/**
 * Wireless State Manager
 * In-memory data model for sites, antennas, and coverage configurations.
 * Emits change events so the widget/map can react.
 */

let _nextSiteId = 1;
let _nextAntennaId = 1;

export class WirelessState {
    constructor() {
        /** @type {Map<string, Site>} */
        this.sites = new Map();
        this._listeners = [];
    }

    /* ── Event system ── */

    onChange(fn) { this._listeners.push(fn); return () => { this._listeners = this._listeners.filter(f => f !== fn); }; }
    _emit(action, data) { for (const fn of this._listeners) fn(action, data); }

    /* ── Site CRUD ── */

    addSite({ name, lat, lng, height = 30 } = {}) {
        const id = `site-${_nextSiteId++}`;
        const site = { id, name: name || `Site ${_nextSiteId - 1}`, lat, lng, height, antennas: [] };
        this.sites.set(id, site);
        this._emit('site-added', site);
        return site;
    }

    updateSite(id, updates) {
        const site = this.sites.get(id);
        if (!site) return null;
        Object.assign(site, updates);
        this._emit('site-updated', site);
        return site;
    }

    removeSite(id) {
        const site = this.sites.get(id);
        if (!site) return;
        this.sites.delete(id);
        this._emit('site-removed', { id });
    }

    getSite(id) { return this.sites.get(id) || null; }
    getAllSites() { return [...this.sites.values()]; }

    /* ── Antenna CRUD ── */

    addAntenna(siteId, {
        type = 'sector',
        azimuth = 0,
        beamwidth = 65,
        radius = 1,
        radiusUnit = 'km',
        height = null,
        tech = 'LTE',
        color = null,
        label = '',
    } = {}) {
        const site = this.sites.get(siteId);
        if (!site) return null;
        const id = `ant-${_nextAntennaId++}`;
        const ant = { id, type, azimuth, beamwidth, radius, radiusUnit, height, tech, color, label };
        site.antennas.push(ant);
        this._emit('antenna-added', { siteId, antenna: ant });
        return ant;
    }

    updateAntenna(siteId, antennaId, updates) {
        const site = this.sites.get(siteId);
        if (!site) return null;
        const ant = site.antennas.find(a => a.id === antennaId);
        if (!ant) return null;
        Object.assign(ant, updates);
        this._emit('antenna-updated', { siteId, antenna: ant });
        return ant;
    }

    removeAntenna(siteId, antennaId) {
        const site = this.sites.get(siteId);
        if (!site) return;
        site.antennas = site.antennas.filter(a => a.id !== antennaId);
        this._emit('antenna-removed', { siteId, antennaId });
    }

    /* ── Bulk import ── */

    /**
     * Import sites+antennas from a feature collection.
     * @param {GeoJSON.FeatureCollection} fc
     * @param {object} fieldMap  Maps logical fields to property keys:
     *   { name, lat, lng, height, type, azimuth, beamwidth, radius, tech }
     */
    importFromGeoJSON(fc, fieldMap = {}) {
        const features = fc?.features || [];
        const imported = [];
        for (const f of features) {
            const props = f.properties || {};
            const geom = f.geometry;
            let lat, lng;
            if (geom?.type === 'Point') {
                [lng, lat] = geom.coordinates;
            } else {
                lat = parseFloat(props[fieldMap.lat]) || null;
                lng = parseFloat(props[fieldMap.lng]) || null;
            }
            if (lat == null || lng == null) continue;

            const name = props[fieldMap.name] || `Imported Site`;
            const height = parseFloat(props[fieldMap.height]) || 30;

            // Check if a site at same coordinates already exists (within ~1m)
            let site = this._findNearby(lat, lng, 0.001);
            if (!site) {
                site = this.addSite({ name, lat, lng, height });
            }

            // Add antenna
            const type = (props[fieldMap.type] || '').toLowerCase().includes('omni') ? 'omni' : 'sector';
            const azimuth = parseFloat(props[fieldMap.azimuth]) || 0;
            const beamwidth = parseFloat(props[fieldMap.beamwidth]) || (type === 'omni' ? 360 : 65);
            const radius = parseFloat(props[fieldMap.radius]) || 1;
            const tech = props[fieldMap.tech] || 'LTE';

            this.addAntenna(site.id, { type, azimuth, beamwidth, radius, tech });
            imported.push(site.id);
        }
        return imported;
    }

    /**
     * Import from raw tabular data (array of objects).
     */
    importFromTable(rows, fieldMap = {}) {
        const imported = [];
        for (const row of rows) {
            const lat = parseFloat(row[fieldMap.lat]);
            const lng = parseFloat(row[fieldMap.lng]);
            if (isNaN(lat) || isNaN(lng)) continue;

            const name = row[fieldMap.name] || 'Imported Site';
            const height = parseFloat(row[fieldMap.height]) || 30;

            let site = this._findNearby(lat, lng, 0.001);
            if (!site) {
                site = this.addSite({ name, lat, lng, height });
            }

            const type = (row[fieldMap.type] || '').toLowerCase().includes('omni') ? 'omni' : 'sector';
            const azimuth = parseFloat(row[fieldMap.azimuth]) || 0;
            const beamwidth = parseFloat(row[fieldMap.beamwidth]) || (type === 'omni' ? 360 : 65);
            const radius = parseFloat(row[fieldMap.radius]) || 1;
            const tech = row[fieldMap.tech] || 'LTE';

            this.addAntenna(site.id, { type, azimuth, beamwidth, radius, tech });
            imported.push(site.id);
        }
        return imported;
    }

    _findNearby(lat, lng, toleranceKm) {
        for (const s of this.sites.values()) {
            const d = Math.sqrt((s.lat - lat) ** 2 + (s.lng - lng) ** 2);
            if (d < toleranceKm / 111) return s;  // ~111 km per degree
        }
        return null;
    }

    /* ── Serialise / Deserialise ── */

    toJSON() {
        return { sites: this.getAllSites() };
    }

    fromJSON(data) {
        this.sites.clear();
        for (const s of (data?.sites || [])) {
            this.sites.set(s.id, s);
            const siteNum = parseInt(s.id.replace('site-', ''));
            if (siteNum >= _nextSiteId) _nextSiteId = siteNum + 1;
            for (const a of (s.antennas || [])) {
                const antNum = parseInt(a.id.replace('ant-', ''));
                if (antNum >= _nextAntennaId) _nextAntennaId = antNum + 1;
            }
        }
        this._emit('reload', {});
    }

    clear() {
        this.sites.clear();
        this._emit('cleared', {});
    }

    /* ── Statistics ── */

    get siteCount() { return this.sites.size; }
    get antennaCount() { return this.getAllSites().reduce((n, s) => n + s.antennas.length, 0); }
    get techBreakdown() {
        const counts = {};
        for (const s of this.sites.values()) {
            for (const a of s.antennas) {
                counts[a.tech] = (counts[a.tech] || 0) + 1;
            }
        }
        return counts;
    }
}
