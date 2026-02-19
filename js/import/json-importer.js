/**
 * Generic JSON importer — detects GeoJSON vs plain table
 * Auto-detects lat/lon columns and creates spatial datasets when possible
 */
import { createSpatialDataset, createTableDataset } from '../core/data-model.js';
import { AppError, ErrorCategory } from '../core/error-handler.js';
import { importGeoJSON } from './geojson-importer.js';

export async function importJSON(file, task) {
    task.updateProgress(20, 'Parsing JSON...');
    const text = await file.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        throw new AppError('Invalid JSON', ErrorCategory.PARSE_FAILED, { file: file.name });
    }

    task.updateProgress(50, 'Detecting format...');

    // Check if it's GeoJSON
    if (data.type === 'FeatureCollection' || data.type === 'Feature' ||
        (data.type && data.coordinates)) {
        return importGeoJSON(file, task);
    }

    // Check for ArcGIS REST-style response
    if (data.features && Array.isArray(data.features) && data.features[0]?.attributes) {
        const features = data.features.map(f => ({
            type: 'Feature',
            geometry: convertEsriGeometry(f.geometry),
            properties: f.attributes || {}
        }));
        const fc = { type: 'FeatureCollection', features };
        return createSpatialDataset(
            file.name.replace(/\.json$/i, ''),
            fc,
            { file: file.name, format: 'json-esri' }
        );
    }

    // Array of objects → check for coordinates, else table
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
        task.updateProgress(70, 'Detecting coordinates...');
        const fields = Object.keys(data[0]);
        const coordInfo = detectCoordinateColumns(fields, data);
        if (coordInfo) {
            task.updateProgress(80, 'Creating spatial dataset...');
            return rowsToSpatial(data, coordInfo, file);
        }
        task.updateProgress(80, 'Creating table dataset...');
        return createTableDataset(
            file.name.replace(/\.json$/i, ''),
            data,
            null,
            { file: file.name, format: 'json-table' }
        );
    }

    // Object with a data/records/results array
    for (const key of ['data', 'records', 'results', 'rows', 'items']) {
        if (Array.isArray(data[key]) && data[key].length > 0 && typeof data[key][0] === 'object') {
            const rows = data[key];
            const fields = Object.keys(rows[0]);
            const coordInfo = detectCoordinateColumns(fields, rows);
            if (coordInfo) {
                return rowsToSpatial(rows, coordInfo, file);
            }
            return createTableDataset(
                file.name.replace(/\.json$/i, ''),
                rows,
                null,
                { file: file.name, format: 'json-table' }
            );
        }
    }

    throw new AppError(
        'Could not detect a table or GeoJSON structure in this JSON file',
        ErrorCategory.PARSE_FAILED,
        { file: file.name }
    );
}

/**
 * Detect lat/lon columns from field names and data
 */
function detectCoordinateColumns(fields, rows) {
    const lower = fields.map(f => f.toLowerCase());
    const latPatterns = ['lat', 'latitude', 'y', 'lat_dd', 'latitude_dd'];
    const lonPatterns = ['lon', 'lng', 'long', 'longitude', 'x', 'lon_dd', 'longitude_dd'];

    let latField = null, lonField = null;
    for (const p of latPatterns) {
        const idx = lower.findIndex(f => f === p || f === p.replace('_', ''));
        if (idx >= 0) { latField = fields[idx]; break; }
    }
    for (const p of lonPatterns) {
        const idx = lower.findIndex(f => f === p || f === p.replace('_', ''));
        if (idx >= 0) { lonField = fields[idx]; break; }
    }

    if (latField && lonField) {
        const sample = rows.slice(0, 20);
        const validCount = sample.filter(r => {
            const lat = parseFloat(r[latField]);
            const lon = parseFloat(r[lonField]);
            return !isNaN(lat) && !isNaN(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
        }).length;
        if (validCount >= sample.length * 0.5) {
            return { latField, lonField };
        }
    }
    return null;
}

/**
 * Convert rows with coordinate columns into a spatial dataset
 */
function rowsToSpatial(rows, coordInfo, file) {
    const features = rows.map(row => {
        const lat = parseFloat(row[coordInfo.latField]);
        const lon = parseFloat(row[coordInfo.lonField]);
        const geom = (!isNaN(lat) && !isNaN(lon))
            ? { type: 'Point', coordinates: [lon, lat] }
            : null;
        return { type: 'Feature', geometry: geom, properties: { ...row } };
    });
    const fc = { type: 'FeatureCollection', features };
    const ds = createSpatialDataset(
        file.name.replace(/\.json$/i, ''),
        fc,
        { file: file.name, format: 'json-spatial', coordDetected: coordInfo }
    );
    ds._coordInfo = coordInfo;
    return ds;
}

function convertEsriGeometry(geom) {
    if (!geom) return null;
    if (geom.x != null && geom.y != null) {
        return { type: 'Point', coordinates: [geom.x, geom.y] };
    }
    if (geom.rings) {
        return {
            type: geom.rings.length === 1 ? 'Polygon' : 'MultiPolygon',
            coordinates: geom.rings.length === 1 ? geom.rings : geom.rings.map(r => [r])
        };
    }
    if (geom.paths) {
        return {
            type: geom.paths.length === 1 ? 'LineString' : 'MultiLineString',
            coordinates: geom.paths.length === 1 ? geom.paths[0] : geom.paths
        };
    }
    if (geom.points) {
        return { type: 'MultiPoint', coordinates: geom.points };
    }
    return null;
}
