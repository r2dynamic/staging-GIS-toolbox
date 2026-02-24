/**
 * Wireless Geometry —  Sector wedge & omni circle polygon generation
 * Uses Turf.js (global `turf`) for bearing/destination calculations.
 */

const DEG = Math.PI / 180;

/* ── Colour palette for technology types ── */
export const TECH_COLORS = {
    '5G-NR':   '#e74c3c',
    'LTE':     '#3498db',
    'CBRS':    '#2ecc71',
    'mmWave':  '#9b59b6',
    'Wi-Fi':   '#f39c12',
    'UHF':     '#1abc9c',
    'VHF':     '#e67e22',
    'Custom':  '#95a5a6',
};

/**
 * Create a sector wedge polygon (pie-slice shape).
 *
 * @param {[number,number]} center   [lng, lat]
 * @param {number}          azimuth  Boresight bearing in degrees (0=North, CW)
 * @param {number}          beamwidth  Horizontal beam width in degrees
 * @param {number}          radius   Radius in kilometres
 * @param {number}          [steps=64] Arc resolution
 * @returns {GeoJSON.Feature<Polygon>}
 */
export function createSectorWedge(center, azimuth, beamwidth, radius, steps = 64) {
    if (!center || radius <= 0 || beamwidth <= 0) return null;
    const pt = turf.point(center);
    const halfBW = beamwidth / 2;
    const startBearing = azimuth - halfBW;
    const endBearing   = azimuth + halfBW;
    const stepAngle    = beamwidth / steps;

    const coords = [center]; // start at center
    for (let i = 0; i <= steps; i++) {
        const bearing = startBearing + stepAngle * i;
        const dest = turf.destination(pt, radius, bearing, { units: 'kilometers' });
        coords.push(dest.geometry.coordinates);
    }
    coords.push(center); // close back to center

    return turf.polygon([coords]);
}

/**
 * Create an omni-directional circle polygon.
 *
 * @param {[number,number]} center  [lng, lat]
 * @param {number}          radius  Radius in kilometres
 * @param {number}          [steps=64]
 * @returns {GeoJSON.Feature<Polygon>}
 */
export function createOmniCircle(center, radius, steps = 64) {
    if (!center || radius <= 0) return null;
    const pt = turf.point(center);
    const coords = [];
    for (let i = 0; i <= steps; i++) {
        const bearing = (360 / steps) * i;
        const dest = turf.destination(pt, radius, bearing, { units: 'kilometers' });
        coords.push(dest.geometry.coordinates);
    }
    coords.push(coords[0]); // close ring
    return turf.polygon([coords]);
}

/**
 * Build a complete GeoJSON FeatureCollection from an array of sites.
 * Each antenna becomes a polygon feature with rich properties.
 *
 * @param {Array} sites   Array of site objects from wireless-state
 * @returns {{ fc: GeoJSON.FeatureCollection, sitePoints: GeoJSON.FeatureCollection }}
 */
export function buildCoverageFC(sites) {
    const coverageFeatures = [];
    const sitePointFeatures = [];

    for (const site of sites) {
        // Site marker point
        sitePointFeatures.push(turf.point([site.lng, site.lat], {
            _siteId: site.id,
            _siteName: site.name,
            _siteHeight: site.height,
            _featureType: 'site-point',
        }));

        for (const ant of (site.antennas || [])) {
            const radiusKm = convertToKm(ant.radius, ant.radiusUnit || 'km');
            let poly;
            if (ant.type === 'omni') {
                poly = createOmniCircle([site.lng, site.lat], radiusKm);
            } else {
                poly = createSectorWedge(
                    [site.lng, site.lat],
                    ant.azimuth,
                    ant.beamwidth || 65,
                    radiusKm,
                );
            }
            if (!poly) continue;

            poly.properties = {
                _siteId:     site.id,
                _siteName:   site.name,
                _antennaId:  ant.id,
                _type:       ant.type,
                _tech:       ant.tech || 'Custom',
                _azimuth:    ant.azimuth || 0,
                _beamwidth:  ant.beamwidth || 360,
                _radius:     ant.radius,
                _radiusUnit: ant.radiusUnit || 'km',
                _height:     ant.height ?? site.height ?? 30,
                _color:      ant.color || TECH_COLORS[ant.tech] || TECH_COLORS.Custom,
                _featureType: 'coverage',
            };

            coverageFeatures.push(poly);
        }
    }

    return {
        fc: { type: 'FeatureCollection', features: coverageFeatures },
        sitePoints: { type: 'FeatureCollection', features: sitePointFeatures },
    };
}

/* ── Unit helpers ── */

export const RADIUS_UNITS = [
    { value: 'km', label: 'Kilometers', abbr: 'km' },
    { value: 'mi', label: 'Miles',      abbr: 'mi' },
    { value: 'ft', label: 'Feet',       abbr: 'ft' },
    { value: 'm',  label: 'Meters',     abbr: 'm'  },
];

export function convertToKm(value, unit) {
    switch (unit) {
        case 'mi': return value * 1.60934;
        case 'ft': return value * 0.0003048;
        case 'm':  return value / 1000;
        default:   return value; // km
    }
}

export function convertFromKm(km, unit) {
    switch (unit) {
        case 'mi': return km / 1.60934;
        case 'ft': return km / 0.0003048;
        case 'm':  return km * 1000;
        default:   return km;
    }
}
