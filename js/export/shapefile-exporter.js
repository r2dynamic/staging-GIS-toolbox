/**
 * Shapefile exporter — generates .shp, .shx, .dbf, .prj in a ZIP
 * Supports Point, PolyLine (LineString/MultiLineString), Polygon (MultiPolygon)
 * Uses JSZip (already loaded via CDN)
 */

const SHP_NULL = 0;
const SHP_POINT = 1;
const SHP_POLYLINE = 3;
const SHP_POLYGON = 5;

const WGS84_PRJ = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

/**
 * Export a spatial dataset as a zipped Shapefile
 */
export async function exportShapefile(dataset, options = {}, task) {
    const features = dataset.geojson?.features || [];
    if (features.length === 0) throw new Error('No features to export');

    task?.updateProgress(20, 'Analyzing geometry types...');

    // Determine dominant geometry type
    const geomType = resolveShapeType(features);

    // Filter to matching features & flatten multi where needed
    const records = [];
    for (const f of features) {
        const g = f.geometry;
        if (!g) continue;
        const shpType = mapGeomType(g.type);
        if (shpType !== geomType && !isCompatible(g.type, geomType)) continue;
        records.push(f);
    }

    if (records.length === 0) throw new Error('No valid geometries to export');

    task?.updateProgress(30, 'Building attribute table...');

    // Build DBF field definitions from properties
    const fieldDefs = buildFieldDefs(records);

    task?.updateProgress(50, 'Writing .shp / .shx...');

    const { shpBuf, shxBuf, bbox } = writeShpShx(records, geomType);

    task?.updateProgress(70, 'Writing .dbf...');

    const dbfBuf = writeDbf(records, fieldDefs);

    task?.updateProgress(85, 'Zipping...');

    const name = (options.filename || dataset.name || 'export').replace(/\.[^.]+$/, '');

    if (typeof JSZip === 'undefined') throw new Error('JSZip library not loaded');
    const zip = new JSZip();
    zip.file(`${name}.shp`, shpBuf);
    zip.file(`${name}.shx`, shxBuf);
    zip.file(`${name}.dbf`, dbfBuf);
    zip.file(`${name}.prj`, WGS84_PRJ);

    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });

    task?.updateProgress(100, 'Done');
    return { blob, mimeType: 'application/zip' };
}

// ========== Geometry type resolution ==========

function resolveShapeType(features) {
    const counts = { [SHP_POINT]: 0, [SHP_POLYLINE]: 0, [SHP_POLYGON]: 0 };
    for (const f of features) {
        const t = mapGeomType(f.geometry?.type);
        if (t) counts[t]++;
    }
    // Use the most common type
    let best = SHP_POINT, max = 0;
    for (const [t, c] of Object.entries(counts)) {
        if (c > max) { max = c; best = Number(t); }
    }
    return best;
}

function mapGeomType(type) {
    if (!type) return null;
    if (type === 'Point' || type === 'MultiPoint') return SHP_POINT;
    if (type === 'LineString' || type === 'MultiLineString') return SHP_POLYLINE;
    if (type === 'Polygon' || type === 'MultiPolygon') return SHP_POLYGON;
    return null;
}

function isCompatible(geojsonType, shpType) {
    return mapGeomType(geojsonType) === shpType;
}

// ========== SHP + SHX writing ==========

function writeShpShx(records, shpType) {
    // Pass 1: compute record sizes
    const recordInfos = records.map(f => getRecordInfo(f.geometry, shpType));

    // File lengths
    const shpHeaderLen = 100;
    const shxHeaderLen = 100;
    let shpContentLen = shpHeaderLen;
    for (const ri of recordInfos) shpContentLen += 8 + ri.contentLen; // 8 = rec header

    const shxContentLen = shxHeaderLen + records.length * 8;

    const shpBuf = new ArrayBuffer(shpContentLen);
    const shxBuf = new ArrayBuffer(shxContentLen);
    const shpView = new DataView(shpBuf);
    const shxView = new DataView(shxBuf);

    // Compute bounding box
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const f of records) {
        const bb = geomBbox(f.geometry);
        if (bb[0] < xmin) xmin = bb[0];
        if (bb[1] < ymin) ymin = bb[1];
        if (bb[2] > xmax) xmax = bb[2];
        if (bb[3] > ymax) ymax = bb[3];
    }

    // Write SHP header
    writeShpHeader(shpView, shpContentLen / 2, shpType, xmin, ymin, xmax, ymax);
    // Write SHX header
    writeShpHeader(shxView, shxContentLen / 2, shpType, xmin, ymin, xmax, ymax);

    // Write records
    let shpOffset = shpHeaderLen;
    let shxOffset = shxHeaderLen;

    for (let i = 0; i < records.length; i++) {
        const ri = recordInfos[i];
        const contentWords = ri.contentLen / 2;

        // SHP record header (big-endian)
        shpView.setInt32(shpOffset, i + 1, false);          // record number
        shpView.setInt32(shpOffset + 4, contentWords, false); // content length in 16-bit words
        shpOffset += 8;

        // SHX record
        shxView.setInt32(shxOffset, (shpOffset - 8) / 2, false);  // offset in 16-bit words
        shxView.setInt32(shxOffset + 4, contentWords, false);
        shxOffset += 8;

        // Write geometry content
        writeGeometry(shpView, shpOffset, records[i].geometry, shpType);
        shpOffset += ri.contentLen;
    }

    return { shpBuf, shxBuf, bbox: [xmin, ymin, xmax, ymax] };
}

function writeShpHeader(view, fileLenWords, shpType, xmin, ymin, xmax, ymax) {
    view.setInt32(0, 9994, false);       // file code (big-endian)
    // bytes 4-23: unused
    view.setInt32(24, fileLenWords, false); // file length in 16-bit words
    view.setInt32(28, 1000, true);       // version (little-endian)
    view.setInt32(32, shpType, true);    // shape type
    // Bounding box (little-endian doubles)
    view.setFloat64(36, xmin, true);
    view.setFloat64(44, ymin, true);
    view.setFloat64(52, xmax, true);
    view.setFloat64(60, ymax, true);
    // Zmin, Zmax, Mmin, Mmax = 0
}

function getRecordInfo(geom, shpType) {
    if (shpType === SHP_POINT) {
        return { contentLen: 20 }; // 4 (type) + 8 (x) + 8 (y)
    }
    const parts = toParts(geom, shpType);
    const totalPts = parts.reduce((s, p) => s + p.length, 0);
    // type(4) + bbox(32) + numParts(4) + numPoints(4) + partIndices(parts*4) + points(totalPts*16)
    return { contentLen: 4 + 32 + 4 + 4 + parts.length * 4 + totalPts * 16 };
}

function writeGeometry(view, offset, geom, shpType) {
    if (shpType === SHP_POINT) {
        const coord = getPointCoord(geom);
        view.setInt32(offset, SHP_POINT, true);
        view.setFloat64(offset + 4, coord[0], true);  // x (lon)
        view.setFloat64(offset + 12, coord[1], true);  // y (lat)
        return;
    }

    const parts = toParts(geom, shpType);
    const totalPts = parts.reduce((s, p) => s + p.length, 0);

    // Bounding box
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const part of parts) {
        for (const c of part) {
            if (c[0] < xmin) xmin = c[0];
            if (c[1] < ymin) ymin = c[1];
            if (c[0] > xmax) xmax = c[0];
            if (c[1] > ymax) ymax = c[1];
        }
    }

    let o = offset;
    view.setInt32(o, shpType, true); o += 4;
    view.setFloat64(o, xmin, true); o += 8;
    view.setFloat64(o, ymin, true); o += 8;
    view.setFloat64(o, xmax, true); o += 8;
    view.setFloat64(o, ymax, true); o += 8;
    view.setInt32(o, parts.length, true); o += 4;
    view.setInt32(o, totalPts, true); o += 4;

    // Part indices
    let idx = 0;
    for (const part of parts) {
        view.setInt32(o, idx, true); o += 4;
        idx += part.length;
    }

    // Points
    for (const part of parts) {
        for (const c of part) {
            view.setFloat64(o, c[0], true); o += 8; // x (lon)
            view.setFloat64(o, c[1], true); o += 8; // y (lat)
        }
    }
}

function getPointCoord(geom) {
    if (geom.type === 'Point') return geom.coordinates;
    if (geom.type === 'MultiPoint') return geom.coordinates[0] || [0, 0];
    return [0, 0];
}

function toParts(geom, shpType) {
    const t = geom.type;
    if (shpType === SHP_POLYLINE) {
        if (t === 'LineString') return [geom.coordinates];
        if (t === 'MultiLineString') return geom.coordinates;
    }
    if (shpType === SHP_POLYGON) {
        if (t === 'Polygon') return geom.coordinates; // rings
        if (t === 'MultiPolygon') {
            // Flatten all rings from all polygons
            const parts = [];
            for (const poly of geom.coordinates) {
                for (const ring of poly) parts.push(ring);
            }
            return parts;
        }
    }
    return [[]];
}

function geomBbox(geom) {
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    const visit = (coords) => {
        if (typeof coords[0] === 'number') {
            if (coords[0] < xmin) xmin = coords[0];
            if (coords[1] < ymin) ymin = coords[1];
            if (coords[0] > xmax) xmax = coords[0];
            if (coords[1] > ymax) ymax = coords[1];
            return;
        }
        for (const c of coords) visit(c);
    };
    if (geom?.coordinates) visit(geom.coordinates);
    return [xmin, ymin, xmax, ymax];
}

// ========== DBF writing ==========

function buildFieldDefs(records) {
    const fieldMap = new Map();

    for (const f of records) {
        const props = f.properties || {};
        for (const [key, val] of Object.entries(props)) {
            if (!fieldMap.has(key)) {
                fieldMap.set(key, { name: key, values: [] });
            }
            if (val != null) fieldMap.get(key).values.push(val);
        }
    }

    const defs = [];
    for (const [name, data] of fieldMap) {
        // Determine type and size
        const sample = data.values;
        const allNum = sample.length > 0 && sample.every(v => typeof v === 'number' || (typeof v === 'string' && !isNaN(Number(v)) && v.trim() !== ''));
        const hasDecimal = allNum && sample.some(v => String(v).includes('.'));

        if (allNum && !hasDecimal) {
            // Integer — N type
            const maxLen = Math.max(10, ...sample.map(v => String(Math.round(Number(v))).length));
            defs.push({ name: truncFieldName(name), type: 'N', size: Math.min(maxLen + 1, 18), decimal: 0, srcName: name });
        } else if (allNum) {
            // Float — N type with decimals
            defs.push({ name: truncFieldName(name), type: 'N', size: 18, decimal: 6, srcName: name });
        } else {
            // Character
            let maxLen = 1;
            for (const v of sample) {
                const len = String(v).length;
                if (len > maxLen) maxLen = len;
            }
            defs.push({ name: truncFieldName(name), type: 'C', size: Math.min(Math.max(maxLen, 1), 254), decimal: 0, srcName: name });
        }
    }

    return defs;
}

function truncFieldName(name) {
    // DBF field names max 11 chars, ASCII only
    return name.replace(/[^\x20-\x7E]/g, '_').substring(0, 11);
}

function writeDbf(records, fieldDefs) {
    const numRecords = records.length;
    const numFields = fieldDefs.length;
    const headerLen = 32 + numFields * 32 + 1; // +1 for terminator
    const recordLen = 1 + fieldDefs.reduce((s, f) => s + f.size, 0); // +1 for deletion flag
    const fileLen = headerLen + numRecords * recordLen + 1; // +1 for EOF

    const buf = new ArrayBuffer(fileLen);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);

    // Header
    view.setUint8(0, 3);                    // version
    const now = new Date();
    view.setUint8(1, now.getFullYear() - 1900);
    view.setUint8(2, now.getMonth() + 1);
    view.setUint8(3, now.getDate());
    view.setInt32(4, numRecords, true);
    view.setInt16(8, headerLen, true);
    view.setInt16(10, recordLen, true);

    // Field descriptors
    let off = 32;
    for (const f of fieldDefs) {
        writeAscii(bytes, off, f.name, 11);
        view.setUint8(off + 11, f.type.charCodeAt(0));
        view.setUint8(off + 16, f.size);
        view.setUint8(off + 17, f.decimal);
        off += 32;
    }
    view.setUint8(off, 0x0D); // header terminator
    off++;

    // Records
    for (const rec of records) {
        view.setUint8(off, 0x20); // not deleted
        off++;
        const props = rec.properties || {};
        for (const f of fieldDefs) {
            const raw = props[f.srcName];
            let str;
            if (raw == null) {
                str = '';
            } else if (f.type === 'N') {
                const num = Number(raw);
                str = isNaN(num) ? '' : (f.decimal > 0 ? num.toFixed(f.decimal) : String(Math.round(num)));
            } else {
                str = String(raw);
            }
            // Right-pad C fields, left-pad N fields
            if (f.type === 'C') {
                str = str.substring(0, f.size).padEnd(f.size, ' ');
            } else {
                str = str.substring(0, f.size).padStart(f.size, ' ');
            }
            writeAscii(bytes, off, str, f.size);
            off += f.size;
        }
    }

    // EOF
    view.setUint8(off, 0x1A);

    return buf;
}

function writeAscii(bytes, offset, str, maxLen) {
    for (let i = 0; i < maxLen && i < str.length; i++) {
        bytes[offset + i] = str.charCodeAt(i) & 0xFF;
    }
}
