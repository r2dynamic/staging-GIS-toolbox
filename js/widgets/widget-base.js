/**
 * Widget Base — Draggable floating panel framework
 * All widgets extend this. Handles drag, positioning, open/close lifecycle.
 */
import logger from '../core/logger.js';

let _activeWidgets = new Map(); // id → WidgetBase

export class WidgetBase {
    /**
     * @param {string} id        Unique widget ID
     * @param {string} title     Title shown in the header
     * @param {string} icon      Emoji or text icon
     * @param {object} opts      { width, minWidth, maxWidth }
     */
    constructor(id, title, icon = '⚙️', opts = {}) {
        this.id = id;
        this.title = title;
        this.icon = icon;
        this.opts = { width: '380px', ...opts };

        this._el = null;
        this._dragState = null;
        this._position = null; // { left, top } once moved
    }

    /* ---------- Public API ---------- */

    /** Open the widget (or bring to front if already open) */
    open() {
        if (this._el) {
            this._bringToFront();
            return;
        }
        this._render();
        this._anchorBottomRight();
        this._bindDrag();
        this.onOpen();
        _activeWidgets.set(this.id, this);
        logger.info('Widget', `Opened: ${this.title}`);
    }

    /** Close and remove from DOM */
    close() {
        if (!this._el) return;
        this.onClose();
        this._el.remove();
        this._el = null;
        this._position = null;
        _activeWidgets.delete(this.id);
        logger.info('Widget', `Closed: ${this.title}`);
    }

    /** Toggle open/close */
    toggle() {
        this._el ? this.close() : this.open();
    }

    /** Is the widget currently open? */
    get isOpen() { return !!this._el; }

    /** Direct reference to widget body element */
    get body() { return this._el?.querySelector('.gis-widget-body'); }

    /** Direct reference to footer element */
    get footer() { return this._el?.querySelector('.gis-widget-footer'); }

    /* ---------- Lifecycle hooks (override in subclass) ---------- */

    /** Called after DOM is attached. Build your UI here. */
    onOpen() {}

    /** Called before DOM is removed. Clean up here. */
    onClose() {}

    /** Return HTML string for the body content */
    renderBody() { return ''; }

    /** Return HTML string for footer buttons (empty = no footer) */
    renderFooter() { return ''; }

    /* ---------- Protected helpers ---------- */

    /** Re-render just the body */
    _refreshBody(html) {
        const body = this.body;
        if (body) body.innerHTML = html ?? this.renderBody();
    }

    /** Re-render footer */
    _refreshFooter(html) {
        const foot = this.footer;
        if (foot) foot.innerHTML = html ?? this.renderFooter();
    }

    /* ---------- Internals ---------- */

    _render() {
        const el = document.createElement('div');
        el.className = 'gis-widget';
        el.id = `widget-${this.id}`;
        el.style.width = this.opts.width;

        const isMobile = window.innerWidth < 768;
        const footerHtml = this.renderFooter();
        const dragHandle = isMobile
            ? `<div class="widget-drag-handle"><div class="handle-bar"></div></div>`
            : '';
        el.innerHTML = `
            ${dragHandle}
            <div class="gis-widget-header">
                <span class="widget-icon">${this.icon}</span>
                <span class="widget-title">${this.title}${this.opts.subtitle ? `<span class="widget-subtitle">${this.opts.subtitle}</span>` : ''}</span>
                <button class="widget-close" title="Close">&times;</button>
            </div>
            <div class="gis-widget-body">${this.renderBody()}</div>
            ${footerHtml ? `<div class="gis-widget-footer">${footerHtml}</div>` : ''}
        `;

        el.querySelector('.widget-close').addEventListener('click', () => this.close());

        document.body.appendChild(el);
        this._el = el;
    }

    _anchorBottomRight() {
        if (!this._el) return;
        const isMobile = window.innerWidth < 768;
        if (isMobile) {
            // CSS handles mobile positioning — clear any inline styles
            this._el.style.right = '';
            this._el.style.bottom = '';
            this._el.style.left = '';
            this._el.style.top = '';
            this._el.style.width = '';
            return;
        }
        const margin = 16;
        this._el.style.right = margin + 'px';
        this._el.style.bottom = margin + 'px';
        this._el.style.left = 'auto';
        this._el.style.top = 'auto';
    }

    _bringToFront() {
        if (!this._el) return;
        // Re-append to move to top of stacking
        document.body.appendChild(this._el);
    }

    _bindDrag() {
        const isMobile = window.innerWidth < 768;
        if (isMobile) {
            this._bindMobileSwipe();
        } else {
            const header = this._el.querySelector('.gis-widget-header');
            header.addEventListener('mousedown', (e) => this._onDesktopDragStart(e));
            header.addEventListener('touchstart', (e) => this._onDesktopDragStart(e), { passive: false });
        }
    }

    /* ---- Mobile: swipe down to collapse, swipe up to expand ---- */
    _bindMobileSwipe() {
        const handle = this._el.querySelector('.widget-drag-handle');
        const header = this._el.querySelector('.gis-widget-header');
        // Both the drag handle and header can be used to swipe
        const targets = [handle, header].filter(Boolean);

        targets.forEach(target => {
            target.addEventListener('touchstart', (e) => this._onSwipeStart(e), { passive: false });
        });

        // Also allow tapping the drag-handle to toggle
        if (handle) {
            handle.addEventListener('click', () => {
                this._el.classList.toggle('widget-collapsed');
            });
        }
    }

    _onSwipeStart(e) {
        if (e.target.closest('.widget-close')) return;
        e.preventDefault();

        const startY = e.touches[0].clientY;
        const startTime = Date.now();
        const el = this._el;
        const wasCollapsed = el.classList.contains('widget-collapsed');
        const elHeight = el.offsetHeight;

        // Disable CSS transition during drag for realtime feedback
        el.classList.add('widget-dragging');

        // Track cumulative translateY during the gesture
        let currentDeltaY = 0;

        const onMove = (ev) => {
            ev.preventDefault();
            const cy = ev.touches[0].clientY;
            currentDeltaY = cy - startY;

            if (wasCollapsed) {
                // Currently collapsed — allow swiping UP to expand
                // Base offset = 100% - 52px (collapsed position). Dragging up reduces it
                const baseOffset = elHeight - 52;
                const offset = Math.max(0, baseOffset + currentDeltaY);
                el.style.transform = `translateY(${offset}px)`;
            } else {
                // Currently expanded — allow swiping DOWN to collapse
                const offset = Math.max(0, currentDeltaY);
                el.style.transform = `translateY(${offset}px)`;
            }
        };

        const onEnd = () => {
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
            el.classList.remove('widget-dragging');

            const elapsed = Date.now() - startTime;
            const absY = Math.abs(currentDeltaY);
            // Threshold: quick flick (velocity) OR sufficient distance
            const isFlick = absY > 30 && elapsed < 300;
            const isFarEnough = absY > 60;

            if (isFlick || isFarEnough) {
                if (wasCollapsed && currentDeltaY < 0) {
                    // Swiped UP while collapsed → expand
                    el.classList.remove('widget-collapsed');
                } else if (!wasCollapsed && currentDeltaY > 0) {
                    // Swiped DOWN while expanded → collapse
                    el.classList.add('widget-collapsed');
                }
            }
            // Clear inline transform; let CSS class handle final state
            el.style.transform = '';
        };

        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
    }

    /* ---- Desktop: standard drag-to-reposition ---- */
    _onDesktopDragStart(e) {
        if (e.target.closest('.widget-close')) return;
        e.preventDefault();

        const rect = this._el.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;

        this._dragState = {
            startX: clientX,
            startY: clientY,
            origLeft: rect.left,
            origTop: rect.top
        };

        this._el.classList.add('dragging');

        this._el.style.left = rect.left + 'px';
        this._el.style.top = rect.top + 'px';
        this._el.style.right = 'auto';
        this._el.style.bottom = 'auto';

        const onMove = (ev) => {
            const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
            const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;
            let newLeft = this._dragState.origLeft + (cx - this._dragState.startX);
            let newTop = this._dragState.origTop + (cy - this._dragState.startY);

            const w = this._el.offsetWidth;
            newLeft = Math.max(0, Math.min(window.innerWidth - w, newLeft));
            newTop = Math.max(0, Math.min(window.innerHeight - 40, newTop));

            this._el.style.left = newLeft + 'px';
            this._el.style.top = newTop + 'px';
        };

        const onEnd = () => {
            this._el.classList.remove('dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
            this._position = {
                left: parseInt(this._el.style.left),
                top: parseInt(this._el.style.top)
            };
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
    }
}

/** Get a currently open widget by ID */
export function getWidget(id) {
    return _activeWidgets.get(id) || null;
}

/** Close all open widgets */
export function closeAllWidgets() {
    for (const w of _activeWidgets.values()) w.close();
}

export default WidgetBase;
