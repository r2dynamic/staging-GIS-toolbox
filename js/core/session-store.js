/**
 * Session Store — Auto-save & restore via IndexedDB
 * Persists layers across browser crashes, tab closes, and refreshes
 */

const DB_NAME = 'gis-toolbox-sessions';
const DB_VERSION = 1;
const STORE_LAYERS = 'layers';
const STORE_META = 'meta';
const DEBOUNCE_MS = 2000; // auto-save 2s after last change

let db = null;
let _saveTimer = null;
let _saving = false;
let _onSaveStatus = null; // optional callback for UI indicator

// ——————— IndexedDB Setup ———————

function openDB() {
    return new Promise((resolve, reject) => {
        if (db) { resolve(db); return; }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const idb = e.target.result;
            if (!idb.objectStoreNames.contains(STORE_LAYERS)) {
                idb.createObjectStore(STORE_LAYERS, { keyPath: 'id' });
            }
            if (!idb.objectStoreNames.contains(STORE_META)) {
                idb.createObjectStore(STORE_META, { keyPath: 'key' });
            }
        };
        req.onsuccess = (e) => { db = e.target.result; resolve(db); };
        req.onerror = (e) => reject(e.target.error);
    });
}

// ——————— Save ———————

/**
 * Save all layers to IndexedDB
 * @param {Array} layers - array of layer objects from state
 */
async function saveSession(layers) {
    if (_saving) return;
    _saving = true;
    _onSaveStatus?.('saving');
    try {
        const idb = await openDB();
        const tx = idb.transaction([STORE_LAYERS, STORE_META], 'readwrite');
        const layerStore = tx.objectStore(STORE_LAYERS);
        const metaStore = tx.objectStore(STORE_META);

        // Clear old layers and write fresh
        layerStore.clear();
        for (const layer of layers) {
            const serializable = _serializeLayer(layer);
            layerStore.put(serializable);
        }

        // Save metadata
        metaStore.put({
            key: 'session',
            timestamp: Date.now(),
            layerCount: layers.length,
            activeLayerId: layers.find(l => l.active)?.id || layers[0]?.id || null
        });

        await _txComplete(tx);
        _onSaveStatus?.('saved');
        console.debug('[SessionStore] Saved', layers.length, 'layers');
    } catch (err) {
        console.error('[SessionStore] Save failed:', err);
        _onSaveStatus?.('error');
    } finally {
        _saving = false;
    }
}

function _serializeLayer(layer) {
    // Store only the data we need to reconstruct – drop transient/computed state
    const out = {
        id: layer.id,
        name: layer.name,
        type: layer.type,
        source: layer.source,
        visible: layer.visible,
        created: layer.created
    };
    if (layer.type === 'spatial' && layer.geojson) {
        out.geojson = layer.geojson;
    }
    if (layer.type === 'table' && layer.rows) {
        out.rows = layer.rows;
    }
    // Preserve filters if present
    if (layer.filters) out.filters = layer.filters;
    return out;
}

// ——————— Restore ———————

/**
 * Load saved session from IndexedDB
 * @returns {{ layers: Array, meta: Object }|null}
 */
async function loadSession() {
    try {
        const idb = await openDB();
        const tx = idb.transaction([STORE_LAYERS, STORE_META], 'readonly');
        const layerStore = tx.objectStore(STORE_LAYERS);
        const metaStore = tx.objectStore(STORE_META);

        const [layers, meta] = await Promise.all([
            _getAllFromStore(layerStore),
            _getFromStore(metaStore, 'session')
        ]);

        if (!layers || layers.length === 0) return null;

        return { layers, meta: meta || { timestamp: 0 } };
    } catch (err) {
        console.error('[SessionStore] Load failed:', err);
        return null;
    }
}

/**
 * Check if a saved session exists (fast check without loading all data)
 * @returns {{ timestamp: number, layerCount: number }|null}
 */
async function hasSession() {
    try {
        const idb = await openDB();
        const tx = idb.transaction(STORE_META, 'readonly');
        const meta = await _getFromStore(tx.objectStore(STORE_META), 'session');
        if (meta && meta.layerCount > 0) {
            return { timestamp: meta.timestamp, layerCount: meta.layerCount };
        }
        return null;
    } catch {
        return null;
    }
}

// ——————— Clear ———————

async function clearSession() {
    try {
        const idb = await openDB();
        const tx = idb.transaction([STORE_LAYERS, STORE_META], 'readwrite');
        tx.objectStore(STORE_LAYERS).clear();
        tx.objectStore(STORE_META).clear();
        await _txComplete(tx);
        console.debug('[SessionStore] Session cleared');
    } catch (err) {
        console.error('[SessionStore] Clear failed:', err);
    }
}

// ——————— Debounced Auto-Save ———————

function scheduleSave(layers) {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => saveSession(layers), DEBOUNCE_MS);
}

// ——————— Status callback ———————

function onSaveStatus(fn) {
    _onSaveStatus = fn;
}

// ——————— IndexedDB helpers ———————

function _txComplete(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e.target.error);
        tx.onabort = (e) => reject(e.target.error || new Error('Transaction aborted'));
    });
}

function _getAllFromStore(store) {
    return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

function _getFromStore(store, key) {
    return new Promise((resolve, reject) => {
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = (e) => reject(e.target.error);
    });
}

export default {
    saveSession,
    loadSession,
    hasSession,
    clearSession,
    scheduleSave,
    onSaveStatus
};
