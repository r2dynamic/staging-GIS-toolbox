/**
 * GeoJSON exporter
 */
export async function exportGeoJSON(dataset, options = {}, task) {
    const source = dataset.geojson || {
        type: 'FeatureCollection',
        features: (dataset.rows || []).map(r => ({
            type: 'Feature', geometry: null, properties: r
        }))
    };

    // Clean internal properties (blob URLs) but keep data URLs for portability
    const geojson = {
        ...source,
        features: source.features.map(f => ({
            ...f,
            properties: Object.fromEntries(
                Object.entries(f.properties || {}).filter(([k]) => {
                    if (k === '_thumbnailDataUrl') return true; // portable base64 — keep
                    return !k.startsWith('_'); // strip blob URLs and other internals
                }).map(([k, v]) => [k === '_thumbnailDataUrl' ? 'photo' : k, v])
            )
        }))
    };

    const text = JSON.stringify(geojson, null, options.minify ? 0 : 2);
    task?.updateProgress(90, 'Done');
    return { text, mimeType: 'application/geo+json' };
}
