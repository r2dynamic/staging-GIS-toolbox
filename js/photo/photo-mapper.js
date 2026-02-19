/**
 * Photo Mapper — EXIF extraction, mapping, export
 * Uses exifr for EXIF parsing (loaded via CDN)
 */
import logger from '../core/logger.js';
import { createSpatialDataset } from '../core/data-model.js';
import { TaskRunner } from '../core/task-runner.js';
import bus from '../core/event-bus.js';

export class PhotoMapper {
    constructor() {
        this.photos = [];
        this.dataset = null;
    }

    async processPhotos(files, task) {
        const t = task || new TaskRunner('Photo Processing', 'PhotoMapper');

        return t.run ? await t.run(async (runner) => {
            return this._process(files, runner);
        }) : await this._process(files, t);
    }

    async _process(files, task) {
        this.photos = [];
        const total = files.length;
        logger.info('PhotoMapper', 'Processing photos', { count: total });

        for (let i = 0; i < total; i++) {
            task.throwIfCancelled?.();
            task.updateProgress(Math.round((i / total) * 90), `Processing photo ${i + 1}/${total}`);

            const file = files[i];
            const photoInfo = {
                filename: file.name,
                size: file.size,
                type: file.type,
                blob: file,
                thumbnail: null,
                gps: null,
                timestamp: null,
                altitude: null,
                heading: null,
                hasGPS: false,
                error: null
            };

            try {
                // Check for HEIC
                if (file.name.toLowerCase().endsWith('.heic') || file.name.toLowerCase().endsWith('.heif')) {
                    photoInfo.error = 'HEIC format may not be supported in all browsers. Convert to JPG for best results.';
                    logger.warn('PhotoMapper', 'HEIC file detected', { file: file.name });
                }

                // Extract EXIF
                const exifData = await this.extractEXIF(file);

                if (exifData) {
                    if (exifData.latitude != null && exifData.longitude != null) {
                        photoInfo.gps = { lat: exifData.latitude, lon: exifData.longitude };
                        photoInfo.hasGPS = true;
                    }
                    if (exifData.DateTimeOriginal || exifData.CreateDate) {
                        photoInfo.timestamp = exifData.DateTimeOriginal || exifData.CreateDate;
                        if (photoInfo.timestamp instanceof Date) {
                            photoInfo.timestamp = photoInfo.timestamp.toISOString();
                        }
                    }
                    if (exifData.GPSAltitude != null) {
                        photoInfo.altitude = exifData.GPSAltitude;
                    }
                    if (exifData.GPSImgDirection != null) {
                        photoInfo.heading = exifData.GPSImgDirection;
                    }
                }

                // Create thumbnail
                try {
                    photoInfo.thumbnail = await this.createThumbnail(file, 320);
                    photoInfo.thumbnailUrl = URL.createObjectURL(photoInfo.thumbnail);
                    // Create base64 data URL for export portability
                    photoInfo.thumbnailDataUrl = await this.blobToDataUrl(photoInfo.thumbnail);
                } catch (e) {
                    logger.warn('PhotoMapper', 'Thumbnail creation failed', { file: file.name, error: e.message });
                    photoInfo.thumbnailUrl = URL.createObjectURL(file);
                }

                // Create orientation-baked full-size blob for export
                // This ensures KMZ/KML viewers show the correct orientation
                try {
                    photoInfo.orientedBlob = await this.createOrientedFullSize(file, 2048);
                } catch (e) {
                    logger.warn('PhotoMapper', 'Oriented full-size creation failed, using raw file', { file: file.name });
                    photoInfo.orientedBlob = file;
                }

            } catch (e) {
                photoInfo.error = e.message;
                logger.error('PhotoMapper', 'EXIF extraction failed', { file: file.name, error: e.message });
                // Still allow the photo reference
                try {
                    photoInfo.thumbnailUrl = URL.createObjectURL(file);
                } catch (_) { }
            }

            this.photos.push(photoInfo);
        }

        // Build dataset from GPS photos
        this.dataset = this.buildDataset();

        const gpsCount = this.photos.filter(p => p.hasGPS).length;
        const noGpsCount = this.photos.length - gpsCount;
        logger.info('PhotoMapper', 'Processing complete', { total, withGPS: gpsCount, withoutGPS: noGpsCount });

        task.updateProgress(100, 'Done');
        bus.emit('photos:processed', {
            total: this.photos.length,
            withGPS: gpsCount,
            withoutGPS: noGpsCount,
            dataset: this.dataset
        });

        return {
            photos: this.photos,
            dataset: this.dataset,
            withGPS: gpsCount,
            withoutGPS: noGpsCount
        };
    }

    async extractEXIF(file) {
        // Use exifr library if available
        if (typeof exifr !== 'undefined') {
            try {
                // First pass: get GPS coordinates (let exifr compute lat/lon with hemisphere)
                const gps = await exifr.gps(file).catch(() => null);

                // Second pass: get other EXIF tags
                const data = await exifr.parse(file, {
                    tiff: true,
                    exif: true,
                    gps: true,
                    pick: ['GPSAltitude', 'GPSImgDirection',
                        'DateTimeOriginal', 'CreateDate', 'Make', 'Model']
                }).catch(() => ({})) || {};

                // Merge: use exifr.gps() result for reliable signed lat/lon
                if (gps?.latitude != null && gps?.longitude != null) {
                    data.latitude = gps.latitude;
                    data.longitude = gps.longitude;
                }

                logger.info('PhotoMapper', 'EXIF extracted', {
                    file: file.name,
                    lat: data.latitude,
                    lon: data.longitude,
                    hasGPS: data.latitude != null
                });

                return data;
            } catch (e) {
                logger.warn('PhotoMapper', 'exifr parse failed', { file: file.name, error: e.message });
                return null;
            }
        }

        // Fallback: basic EXIF extraction not available
        logger.warn('PhotoMapper', 'exifr not loaded, no EXIF extraction possible');
        return null;
    }

    async createThumbnail(file, maxSize = 320) {
        return this._resizeImage(file, maxSize);
    }

    /**
     * Create a correctly-oriented, resized image blob from a file.
     * Strategy:
     *  1. Try createImageBitmap with explicit imageOrientation: 'from-image'
     *  2. Fallback: read EXIF orientation manually and apply canvas transforms
     */
    async _resizeImage(file, maxSize) {
        // Strategy 1: createImageBitmap with explicit orientation flag
        if (typeof createImageBitmap === 'function') {
            try {
                const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
                const result = this._bitmapToBlob(bitmap, maxSize);
                return result;
            } catch (_) {
                // Option not supported in this browser, try without option
                try {
                    const bitmap = await createImageBitmap(file);
                    const result = this._bitmapToBlob(bitmap, maxSize);
                    return result;
                } catch (__) { /* fall through to <img> fallback */ }
            }
        }

        // Strategy 2: <img> + manual EXIF orientation via canvas transforms
        let orientation = 1;
        if (typeof exifr !== 'undefined') {
            try {
                const o = await exifr.orientation(file);
                if (o) orientation = o;
            } catch (_) { }
        }

        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(file);

            img.onload = () => {
                try {
                    // img.naturalWidth/Height are the RAW image dimensions (not rotated)
                    let srcW = img.naturalWidth;
                    let srcH = img.naturalHeight;

                    // For orientations 5-8, the image is rotated 90°, so swap dimensions
                    const swapped = orientation >= 5 && orientation <= 8;
                    let displayW = swapped ? srcH : srcW;
                    let displayH = swapped ? srcW : srcH;

                    // Scale to maxSize
                    if (displayW > displayH) {
                        if (displayW > maxSize) { displayH = displayH * maxSize / displayW; displayW = maxSize; }
                    } else {
                        if (displayH > maxSize) { displayW = displayW * maxSize / displayH; displayH = maxSize; }
                    }

                    const canvas = document.createElement('canvas');
                    canvas.width = Math.round(displayW);
                    canvas.height = Math.round(displayH);
                    const ctx = canvas.getContext('2d');

                    // The draw dimensions (what we tell drawImage) are in the pre-rotation space
                    const drawW = swapped ? canvas.height : canvas.width;
                    const drawH = swapped ? canvas.width : canvas.height;

                    // Apply EXIF orientation transform
                    switch (orientation) {
                        case 2: ctx.transform(-1, 0, 0, 1, canvas.width, 0); break;
                        case 3: ctx.transform(-1, 0, 0, -1, canvas.width, canvas.height); break;
                        case 4: ctx.transform(1, 0, 0, -1, 0, canvas.height); break;
                        case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
                        case 6: ctx.transform(0, 1, -1, 0, canvas.width, 0); break;
                        case 7: ctx.transform(0, -1, -1, 0, canvas.width, canvas.height); break;
                        case 8: ctx.transform(0, -1, 1, 0, 0, canvas.height); break;
                        default: break;
                    }

                    ctx.drawImage(img, 0, 0, drawW, drawH);

                    canvas.toBlob(blob => {
                        URL.revokeObjectURL(url);
                        if (blob) resolve(blob);
                        else reject(new Error('Thumbnail blob creation failed'));
                    }, 'image/jpeg', 0.85);
                } catch (e) {
                    URL.revokeObjectURL(url);
                    reject(e);
                }
            };

            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Image load failed — format may not be supported'));
            };

            img.src = url;
        });
    }

    _bitmapToBlob(bitmap, maxSize) {
        const canvas = document.createElement('canvas');
        let { width, height } = bitmap;

        if (width > height) {
            if (width > maxSize) { height = height * maxSize / width; width = maxSize; }
        } else {
            if (height > maxSize) { width = width * maxSize / height; height = maxSize; }
        }

        canvas.width = Math.round(width);
        canvas.height = Math.round(height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();

        return new Promise((resolve, reject) => {
            canvas.toBlob(blob => {
                if (blob) resolve(blob);
                else reject(new Error('Thumbnail blob creation failed'));
            }, 'image/jpeg', 0.85);
        });
    }

    /**
     * Create a correctly-oriented full-size JPEG blob (bakes in EXIF rotation).
     * Caps at 2048px on the long side to keep file size reasonable for KMZ.
     */
    async createOrientedFullSize(file, maxSize = 2048) {
        return this._resizeImage(file, maxSize);
    }

    blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Failed to read blob'));
            reader.readAsDataURL(blob);
        });
    }

    buildDataset() {
        const gpsPhotos = this.photos.filter(p => p.hasGPS);
        if (gpsPhotos.length === 0) return null;

        const features = gpsPhotos.map(p => ({
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [p.gps.lon, p.gps.lat]
            },
            properties: {
                filename: p.filename,
                timestamp: p.timestamp || '',
                latitude: p.gps.lat,
                longitude: p.gps.lon,
                altitude: p.altitude || '',
                heading: p.heading || '',
                fileSize: p.size,
                _thumbnailUrl: p.thumbnailUrl || '',
                _thumbnailDataUrl: p.thumbnailDataUrl || ''
            }
        }));

        const geojson = { type: 'FeatureCollection', features };
        // Attach photo blobs to dataset for export
        const ds = createSpatialDataset('Photo_Points', geojson, { format: 'photos' });
        ds._photoExportData = this.getPhotosForExport();
        ds._useFullSize = this._useFullSize || false;
        return ds;
    }

    getPhotos() { return this.photos; }
    getDataset() { return this.dataset; }

    getPhotosForExport() {
        return this.photos.filter(p => p.hasGPS).map(p => ({
            filename: p.filename,
            blob: p.orientedBlob || p.blob,
            thumbnail: p.thumbnail,
            thumbnailDataUrl: p.thumbnailDataUrl || ''
        }));
    }

    cleanup() {
        for (const p of this.photos) {
            if (p.thumbnailUrl) {
                try { URL.revokeObjectURL(p.thumbnailUrl); } catch (_) { }
            }
        }
        this.photos = [];
        this.dataset = null;
    }
}

export const photoMapper = new PhotoMapper();
export default photoMapper;
