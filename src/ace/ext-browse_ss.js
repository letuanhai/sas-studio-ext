// @ts-check
/**
 * @typedef {import('./ext-browse_ss')}
 */


// @ts-ignore
ace.define("ace/ext/browse_ss", [], function (require, exports, module) {
    "use strict";

    // @ts-ignore
    const config = require("ace/config");
    // @ts-ignore
    const dom = require("../lib/dom");
    // @ts-ignore
    const FilteredList = require("../autocomplete").FilteredList;
    // @ts-ignore
    const AcePopup = require('../autocomplete/popup').AcePopup;
    // @ts-ignore
    const $singleLineEditor = require('../autocomplete/popup').$singleLineEditor;
    // @ts-ignore
    const UndoManager = require("../undomanager").UndoManager;

    // Track existing prompt
    // Since the prompt command-line itself is an Editor instance, prompt can be opened from it
    // This variable is to track the open prompt created by this module to close it and open the new prompt
    // BUG: since the openPrompt is tracked at module level and this module is separate from ace/ext/prompt,
    // the default ace prompt can be opened on the FS prompt
    /** * @type {{ close: () => void; } | null} */
    let openPrompt;

    const DEFAULT_PATH = '';
    const PLACEHOLDER_TEXT = 'Enter a path to browse';
    const MAX_HISTORY = 50;

    /**
     * @typedef  PromptOptions
     * @property {String=} startPath                  Starting path, default to DEFAULT_PATH
     * @property {String=} placeholder                Placeholder text, default to PLACEHOLDER_TEXT
     * @property {Number=} maxHistory                 Maximum number of history entries, default to MAX_HISTORY
     * @property {String=} historyKey                 Key to store history items in localStorage, disable history if blank or null
     * @property {(item: DataItem, ...options: any[]) => void} openItem  Function to open the selected item
     * @property {(itemPath: String) => Promise<Partial<DataItem>>} queryItemPath Function to query item path for DataItem
     * @property {Function} scrollTreeToItem          Function to scroll the tree to the selected item
     */
    /**
     * Browse and open SAS Studio hierarchical items (files, libraries) using the prompt
     *
     * @param {PromptOptions} options  Cusomizable options for this prompt.
     * */
    function browse_ss(options) {
        // If there is already existing browse_ss instance
        if (openPrompt) {
            window._browseSsDebugLog('browse_ss: already open');
            // Close existing prompt to make sure only 1 instance at 1 time
            openPrompt.close();
        }

        // Initialize prompt
        var cmdLine = $singleLineEditor();
        cmdLine.session.setUndoManager(new UndoManager());
        cmdLine.setOption("fontSize", 14);
        // Set initial prompt value
        cmdLine.setValue(options.startPath ?? DEFAULT_PATH, 1);
        cmdLine.setOption("placeholder", options.placeholder ?? PLACEHOLDER_TEXT);

        // Create overlay to dim the page
        /**@type {HTMLElement}*/
        const el = dom.buildDom(["div", { class: "ace_browse_ss_container input-box-with-description" }]);
        const overlay = Utils.overlayPage(el, done);
        el.appendChild(cmdLine.container);
        overlay.setIgnoreFocusOut(false); // Close prompt when lose focus

        // Create description box to show loading status
        /**@type {HTMLElement}*/
        const promptTextContainer = dom.buildDom(["div", { class: "ace_prompt_text_container" }]);
        dom.buildDom("Loading...", promptTextContainer);
        el.appendChild(promptTextContainer);
        promptTextContainer.hidden = false;

        // Placeholder-style keybinding legend (see README "Browsing" for the
        // full table): shown only while the prompt is empty (and not while
        // promptTextContainer is showing "Loading..."/an error), same moment
        // the saved history/bookmarks view (see updateCompletions) appears.
        const hint = dom.buildDom(["div", { class: "ace_browse_ss_hint" },
            "Enter open · Ctrl+Enter as text · Shift+Enter reveal · Tab fill · " +
            "Shift+Space parent · " + (options.historyKey ? "Ctrl+B bookmark · " : "") +
            "Alt+C / Alt+Ctrl+C copy name / path · Esc back · Shift+Esc close"]);
        hint.hidden = true;
        el.appendChild(hint);

        // Initialize data model
        let dataLoading = true;
        let curCollectionPromise = getDataItem(options.startPath ?? DEFAULT_PATH);

        // Initialize completions popup
        const popup = new AcePopup();
        popup.renderer.setStyle("ace_autocomplete_inline");
        popup.container.style.display = "block";
        popup.container.style.maxWidth = "800px";
        popup.container.style.width = "100%";
        popup.container.style.marginTop = "3px";
        popup.renderer.setScrollMargin(2, 2, 0, 0);
        popup.autoSelect = false;
        popup.renderer.$maxLines = 15;
        popup.setRow(-1);
        popup.setOption("fontSize", 15);

        // @ts-ignore
        popup.on("click", function (e) {
            if (dataLoading) return;
            const data = popup.getData(popup.getRow());
            if (!data["error"]) {
                cmdLine.setValue(data.value || data["name"] || data, 1);
                accept();
                e.stop();
            }
        });
        el.appendChild(popup.container);

        // Long item values truncate on the right (ace's per-span ellipsis);
        // a native title tooltip on each rendered row reveals the full value on
        // hover. Set on every visible row after each render — ace recycles row
        // DOM nodes, so a focused-row-only title would go stale on recycled
        // nodes and show the wrong tooltip.
        popup.renderer.on("afterRender", function () {
            const tl = popup.renderer.$textLayer;
            tl.element.childNodes.forEach((/** @type {HTMLElement} */ node, /** @type {number} */ i) => {
                const data = popup.getData(tl.config.firstRow + i);
                node.title = (data && !data.error && data.value) || "";
            });
        });

        // --- Focused-item caption auto-scroll -------------------------------
        // Long item values truncate on the right (ace's autocomplete CSS gives
        // each caption span overflow:hidden + text-overflow:ellipsis). When a
        // row gains focus we wrap ALL its caption spans (everything before the
        // .ace_completion-spacer) into one clipped box whose inner box we
        // translate left to reveal the tail; on focus moving to a different row
        // the previous row snaps back to the start (no animation). After the ace
        // renderer rebuilds row DOM (every setData/resize), we re-wrap the
        // focused row: a row change animates to the end, a same-row rebuild
        // (typing) jumps to the end without animating so refiltering doesn't
        // replay the scroll each keystroke.
        const SCROLL_SPEED_PX_PER_S = 100; // ~5s for 600px of overflow
        /** @type {number} */ let ssRow = -1;
        /** @type {HTMLElement|null} */ let ssPrevInner = null;
        /** @param {number} row @returns {HTMLElement|null} */
        function rowNode(row) {
            const tl = popup.renderer.$textLayer;
            if (row < tl.config.firstRow || row > tl.config.lastRow) return null;
            return /** @type {HTMLElement?} */ (tl.element.childNodes[row - tl.config.firstRow]);
        }
        /** @param {HTMLElement} node @returns {HTMLElement|null} */
        function wrapCaption(node) {
            const spacer = node.querySelector(".ace_completion-spacer");
            if (!spacer) return null;
            const prev = spacer.previousElementSibling;
            if (prev && /** @type {Element} */ (prev).classList.contains("ace_browse_ss_caption-wrap"))
                return /** @type {HTMLElement} */ (prev.firstChild);
            const wrap = document.createElement("span");
            wrap.className = "ace_browse_ss_caption-wrap";
            const inner = document.createElement("span");
            inner.className = "ace_browse_ss_caption-inner";
            let n = node.firstChild;
            while (n && n !== spacer) { const nx = n.nextSibling; inner.appendChild(n); n = nx; }
            wrap.appendChild(inner);
            node.insertBefore(wrap, spacer);
            return inner;
        }
        /** @param {HTMLElement} inner */ function resetInner(inner) {
            inner.style.transition = "none";
            inner.style.transform = "translateX(0)";
            void inner.offsetWidth; // commit the no-transition reset before re-adding a transition
        }
        /** @param {HTMLElement} inner @param {number} dist */ function animateInner(inner, dist) {
            if (dist <= 0) return;
            const dur = Math.max(300, Math.min(6000, dist / SCROLL_SPEED_PX_PER_S * 1000));
            inner.style.transition = `transform ${dur}ms linear`;
            inner.style.transform = `translateX(${-dist}px)`;
        }
        function applyCaptionScroll() {
            const row = popup.getRow();
            const prevRow = ssRow;
            ssRow = row;
            if (row !== prevRow && ssPrevInner) resetInner(ssPrevInner);
            const node = row >= 0 ? rowNode(row) : null;
            if (!node) { ssPrevInner = null; return; }
            // Same row and its wrap survived this render: the DOM wasn't rebuilt,
            // so leave the in-flight animation (or resting position) alone.
            if (row === prevRow && node.querySelector(".ace_browse_ss_caption-inner")) return;
            const inner = wrapCaption(node);
            if (!inner) { ssPrevInner = null; return; }
            resetInner(inner);
            const dist = Math.max(0, inner.scrollWidth - (inner.parentElement?.clientWidth ?? 0));
            ssPrevInner = inner;
            if (row !== prevRow) {
                // focus moved to a new row: animate to the end, and leave it there
                requestAnimationFrame(() => animateInner(inner, dist));
            } else {
                // same row rebuilt (keystroke/refilter): jump to the end, no animation
                inner.style.transform = `translateX(${-dist}px)`;
            }
        }
        popup.renderer.on("afterRender", applyCaptionScroll);

        // Call updateCompletions() regardless of success/failure so a failed initial
        // load still shows the error entry in the popup (see updateCompletions()).
        curCollectionPromise.then(() => updateCompletions(), () => updateCompletions());

        // Initialize key bindings
        const keys = {
            // NB: don't bind `accept` directly - ace passes the editor as the first
            // arg, which would make accept()'s `asText` always truthy (open as text).
            "Enter": function () { accept(); },
            // Open file as text
            "Ctrl-Enter": function () { accept(true) },
            // Scroll tree to selected item
            "Shift-Enter": function () {
                const curData = popup.getData(popup.getRow());
                if (!curData || curData.error || curData.uri == null) return;
                const cleanedPath = Utils.normalizeItemPath(curData.uri);
                done();
                options.scrollTreeToItem(cleanedPath);
            },
            // Clear prompt
            "Ctrl-L": function () { cmdLine.setValue(''); },
            // Clear filter -> Close prompt
            "Esc": function () {
                const cmdLineValue = cmdLine.getValue().trimStart();
                if (cmdLineValue === '' || cmdLineValue.endsWith('/')) { done(); }
                else cmdLine.setValue(cmdLineValue.slice(0, cmdLineValue.lastIndexOf('/') + 1), 1);
            },
            // Close prompt
            "Shift-Esc": done,
            // Go to parent
            "Shift-Space": function () {
                // Go to parent directory
                const cmdLineValue = cmdLine.getValue();
                // Replace multiple consecutive slashes
                const cleaned = cmdLineValue.replace(/\/+/g, '/');
                const secondToLastSlashIndex = cleaned.lastIndexOf('/', cleaned.lastIndexOf('/') - 1);

                const parentPath = cleaned.slice(0, secondToLastSlashIndex) + '/';
                curCollectionPromise = getDataItem(parentPath);
                cmdLine.setValue(parentPath, 1);
                updateCompletions();
            },
            "Up": function () { popup.goTo("up"); },
            "Down": function () { popup.goTo("down"); },
            // Go to top of list
            "Ctrl-Up|Ctrl-Home": function () { popup.goTo("start"); },
            // Go to end of list
            "Ctrl-Down|Ctrl-End": function () { popup.goTo("end"); },
            // Put selected item name in prompt
            "Tab": function () {
                const curData = popup.getData(popup.getRow());
                if (!curData || curData.error || curData.uri == null) return;
                cmdLine.setValue(curData.uri, 1);
                updateCompletions();
            },
            "PageUp": function () { popup.gotoPageUp(); },
            "PageDown": function () { popup.gotoPageDown(); },
            // Toggle bookmark on selected item (Ctrl on mac too - Alt+B is flaky there)
            "Ctrl-B": function () {
                toggleBookmark(popup.getData(popup.getRow()));
            },
            // Copy item name
            "Alt-C": function () {
                /** @type {DataItem} */
                const curData = popup.getData(popup.getRow());
                if (!curData || curData.error || curData.uri == null) return;
                const itemName = curData.prefix ? curData.value.replace(curData.prefix, '') : curData.value;
                window.navigator.clipboard.writeText(itemName);
            },
            // Copy item full path
            "Alt-Ctrl-C": function () {
                /** @type {DataItem} */
                const curData = popup.getData(popup.getRow());
                if (!curData || curData.error || curData.uri == null) return;
                window.navigator.clipboard.writeText(curData.uri);
            },
        };
        cmdLine.commands.bindKeys(keys);
        // Add event listener
        cmdLine.on("input", function () { updateCompletions(); });

        // Finalizing prompt creation
        cmdLine.resize(true);
        cmdLine.focus();
        // Store existing prompt
        openPrompt = {
            close: done,
        };
        // Debug/test handle (same spirit as the other _browseSs* globals)
        window._browseSsLastPrompt = { popup, cmdLine };


        /**
         * Get history list @returns {Partial<DataItem>[]} */
        function getHistory() {
            if (!options.historyKey) return [];
            return JSON.parse(localStorage.getItem(options.historyKey) ?? '[]');
        }

        /**
         * Add new item to history @param {DataItem} item data item to add to history */
        function addToHistory(item) {
            if (!options.historyKey) return;
            const history = getHistory();
            const filteredHistory = history.filter(
                data => data.value !== item.uri && data.value !== item.value
            );
            filteredHistory.unshift({
                value: Utils.normalizeItemPath(item.uri || item.value),
                meta: item.meta,
                prefix: item.prefix,
            });
            localStorage.setItem(options.historyKey, JSON.stringify(filteredHistory.slice(0, options.maxHistory ?? MAX_HISTORY)));
        }

        const bookmarkKey = options.historyKey ? options.historyKey + 'Bookmarks' : null;

        /**
         * Get bookmark list @returns {Partial<DataItem>[]} */
        function getBookmarks() {
            if (!bookmarkKey) return [];
            return JSON.parse(localStorage.getItem(bookmarkKey) ?? '[]');
        }

        /**
         * Add/remove selected item to/from bookmarks @param {DataItem=} item */
        function toggleBookmark(item) {
            if (!bookmarkKey || !item || item.error || item.uri == null) return;
            const uri = Utils.normalizeItemPath(item.uri);
            const bookmarks = getBookmarks();
            const remaining = bookmarks.filter(b => b.value !== uri);
            if (remaining.length === bookmarks.length)
                remaining.unshift({ value: uri, meta: item.meta, prefix: item.prefix });
            localStorage.setItem(bookmarkKey, JSON.stringify(remaining));
            // Capture the row synchronously (before setData resets selection to 0)
            // so toggling a bookmark doesn't jump the list back to the top.
            updateCompletions(popup.getRow());
        }

        /**
         * @param {Partial<DataItem>[]} itemList
         * @param {String?} filterText
         * @returns {Partial<DataItem>[]}
         */
        function getFilteredCompletions(itemList, filterText) {
            const resultItems = JSON.parse(JSON.stringify(itemList));
            const filtered = new FilteredList(resultItems);
            return filtered.filterCompletions(resultItems, filterText);
        }

        /**
         * Bookmark + history entries matching filterText, completion-ready
         * (stored entries hold the bare path in `value`; rendered entries get
         * `uri` + a prefixed display value, same shape as directory children).
         * Size/modified-time metadata is stripped - only '>' (collection, for
         * navigation) survives into `meta`, everything else renders blank.
         * @param {String} filterText
         * @returns {Partial<DataItem>[]}
         */
        function savedCompletions(filterText) {
            if (!options.historyKey) return [];
            const bookmarks = getBookmarks().map(b => Object.assign(b, { message: '⭐ Bookmark' }));
            const history = getHistory().filter(h => !bookmarks.some(b => b.value === h.value))
                .map(h => Object.assign(h, { message: 'Recent' }));
            const entries = getFilteredCompletions([...bookmarks, ...history], filterText);
            entries.forEach(item => {
                item.uri = item.value;
                item.value = (item.prefix ?? '') + item.uri;
                item.meta = item.meta?.endsWith('>') ? '>' : '';
            });
            return entries;
        }

        /** @param {Number=} keepRow row to reselect after popup.setData resets it to 0 */
        function updateCompletions(keepRow) {
            const cmdLineValue = cmdLine.getValue().trimStart();
            // Placeholder hint + saved (history/bookmarks) view only make sense
            // while the prompt is empty, and only once loading/error text isn't
            // already occupying the description area.
            hint.hidden = cmdLineValue !== '' || !promptTextContainer.hidden;

            curCollectionPromise.then(curCollection => {
                const curDirPath = Utils.getCurCollPath(cmdLineValue);

                if (cmdLineValue === '' && options.historyKey) {
                    // Nothing typed: show saved bookmarks/recents only (empty if none).
                    popup.setData(savedCompletions(''), '');
                }
                // Get completions using curDirItem if loaded
                // Also get completions in case history is not saved (with SsTabs)
                else if (curDirPath === Utils.normalizeItemPath(curCollection.uri ?? '') || !options.historyKey) {
                    // Get the input value to update completions
                    // Only use the last component of the path for completions
                    const filterText = cmdLineValue.split('/').at(-1);
                    const filteredCompletions = getFilteredCompletions(curCollection.children ?? [], filterText);
                    const completions = filteredCompletions.length > 0 ? filteredCompletions : [
                        {
                            uri: curCollection.uri,
                            value: '🔄️ Reload data...',
                            meta: '>',
                            keepPrompt: true,
                        },
                    ];
                    // Inline ⭐ marker on listed items that are bookmarked.
                    if (options.historyKey) {
                        const marked = new Set(getBookmarks().map(b => b.value));
                        completions.forEach(child => {
                            if (child.uri && marked.has(Utils.normalizeItemPath(child.uri))) child.message = '⭐';
                        });
                    }
                    popup.setData(completions, filterText);
                }
                // Else: what's typed doesn't point into the loaded folder, so
                // there's nothing to list from the server yet. Offer to load it,
                // and below that show the saved bookmarks/history FILTERED by
                // what's typed - this is how you filter/pick a saved item by
                // typing a fragment of its path.
                else {
                    popup.setData([{
                        uri: curDirPath,
                        value: '⬇️ Load content...',
                        meta: '>',
                        keepPrompt: true,
                    }, ...savedCompletions(cmdLineValue)], cmdLineValue);
                }
                if (keepRow != null) popup.setRow(keepRow);
                popup.resize(true);
            }).catch(() => {
                // Query failed: replace stale popup data with a single non-selectable
                // error entry. Reuses the `error` flag the click handler already checks.
                popup.setData([{ value: '❌ Error loading data', error: true, keepPrompt: true, meta: '' }], '');
                if (keepRow != null) popup.setRow(keepRow);
                popup.resize(true);
            })
        }

        /** @param {boolean=} asText */
        function accept(asText) {
            if (dataLoading) return;
            /** @type DataItem */
            const curData = popup.getData(popup.getRow());
            if (!curData || curData.error || curData.uri == null) return;
            const cleanedPath = Utils.normalizeItemPath(curData.uri);
            window._browseSsDebugLog('browse_ss: accepted', curData);
            addToHistory(curData);
            if (curData.meta?.endsWith('>')) {
                const directoryPath = cleanedPath + '/';
                curCollectionPromise = getDataItem(directoryPath);
                if (!curData.keepPrompt) cmdLine.setValue(directoryPath, 1);
                updateCompletions();
            } else {
                try {
                    options.openItem(curData, asText);
                } finally {
                    done();
                }
            }
        }

        /**
         * Get DataItem from provided path
         * @param {String} itemPath Absolute item path
         * @returns {Promise<Partial<DataItem>>}
         */
        function getDataItem(itemPath) {
            dataLoading = true;
            promptTextContainer.hidden = false;
            // Wrap in a native promise: SsFiles/SsLibrary queries go through dojo's
            // JsonRest store, whose legacy dojo/_base/Deferred has .then() but no .catch()
            const dataItemPromise = Promise.resolve(options.queryItemPath(itemPath));
            dataItemPromise.then(() => { dataLoading = false; promptTextContainer.hidden = true; })
                .catch(e => {
                    dataLoading = false;
                    promptTextContainer.textContent = `❌ Error loading data: ${e && e.message ? e.message : String(e)}`;
                    promptTextContainer.hidden = false;
                    console.error(e);
                });
            return dataItemPromise;
        }

        // Cleanup
        function done() {
            overlay.close();
            openPrompt = null;
        }
    }

    dom.importCssString(`.ace_browse_ss_container {
        max-width: 800px;
        width: 100%;
        margin: 100px auto;
        padding: 3px;
        background: white;
        border-radius: 2px;
        box-shadow: 0px 2px 3px 0px #555;
        }
        .ace_browse_ss_hint {
        padding: 4px 6px 2px;
        font-size: 11px;
        color: #888;
        line-height: 1.5;
        }
        /* Ace sets pointer-events:none on all .ace_layer (a Safari wheel-scroll
        workaround we don't need in a Chromium extension), so row nodes never
        become the hover hit target and their title tooltips never show.
        Re-enable pointer events on this popup's rows only. */
        .ace_browse_ss_container .ace_autocomplete .ace_text-layer > .ace_line {
        pointer-events: auto;
        }
        /* Caption auto-scroll: the focused row's caption spans are grouped into
        one clipped wrapper (so the clip lives on one box, not per span), and the
        individual caption spans stop self-clipping/ellipsis so the inner box can
        slide. Selector scope under .ace_browse_ss_container + .ace_autocomplete
        (4 classes) outranks ace's .ace_autocomplete .ace_line .ace_ (3). */
        .ace_browse_ss_container .ace_autocomplete .ace_line .ace_browse_ss_caption-wrap .ace_ {
        overflow: visible;
        text-overflow: clip;
        flex: 0 0 auto;
        }
        .ace_browse_ss_container .ace_autocomplete .ace_line .ace_browse_ss_caption-wrap {
        flex: 0 1 auto;
        min-width: 0;
        overflow: hidden;
        display: inline-flex;
        }
        .ace_browse_ss_container .ace_autocomplete .ace_line .ace_browse_ss_caption-inner {
        display: inline-flex;
        white-space: nowrap;
        will-change: transform;
        }`,
        "browse_ss.css",
        false
    );
    exports.browse_ss = browse_ss;

    browse_ss.browse_files = function () {
        browse_ss({
            startPath: SsFiles.getStartPath(),
            historyKey: SsFiles.historyKey,
            placeholder: SsFiles.placeholder,
            maxHistory: SsFiles.maxHistory,
            openItem: SsFiles.openFile,
            queryItemPath: SsFiles.getFileDataItem,
            scrollTreeToItem: Utils.focusItemOnTree,
        });
    }

    browse_ss.browse_library = function () {
        browse_ss({
            startPath: SsLibrary.getStartPath(),
            historyKey: SsLibrary.historyKey,
            placeholder: SsLibrary.placeholder,
            maxHistory: SsLibrary.maxHistory,
            openItem: SsLibrary.openTable,
            queryItemPath: SsLibrary.getLibraryDataItem,
            scrollTreeToItem: Utils.focusItemOnTree,
        });
    }

    browse_ss.browse_tabs = function () {
        browse_ss({
            startPath: SsTabs.defaultPath,
            placeholder: SsTabs.placeholder,
            openItem: SsTabs.openTab,
            queryItemPath: SsTabs.getTabDataItem,
            scrollTreeToItem: Utils.focusItemOnTree,
        });
    }

    // Primary entry points are the chrome.commands shortcuts (Alt-P/Alt-O/Alt-T,
    // wired up in sw.js -> editor-swap.js's ssExt.browse()). These ace bindKeys
    // are only an in-editor fallback for when the chrome shortcut has been
    // unbound/reassigned by the user - when Chrome owns the key, the page never
    // sees the keydown, so there is no double-fire between the two.
    // @ts-ignore
    config.loadModule("ace/commands/default_commands", function (module) {
        module.commands.push({
            name: "browseSsFiles",
            description: "Browse SAS Studio files",
            bindKey: { win: "Alt-p", mac: "Option-p" },
            readOnly: true,
            exec: function () {
                // @ts-ignore
                config.loadModule("ace/ext/browse_ss", function (module) {
                    module.browse_ss.browse_files();
                })
            }
        });
        module.commands.push({
            name: "browseSsLibrary",
            description: "Browse SAS Studio library items",
            bindKey: { win: "Alt-o", mac: "Option-o" },
            readOnly: true,
            exec: function () {
                // @ts-ignore
                config.loadModule("ace/ext/browse_ss", function (module) {
                    module.browse_ss.browse_library();
                })
            }
        });
        module.commands.push({
            name: "browseSsTabs",
            description: "Select SAS Studio tabs",
            bindKey: { win: "Alt-t", mac: "Option-t" },
            readOnly: true,
            exec: function () {
                // @ts-ignore
                config.loadModule("ace/ext/browse_ss", function (module) {
                    module.browse_ss.browse_tabs();
                })
            }
        });
    });

    class Utils {
        /**
         * @param {HTMLElement} contentElement
         * @param {Function} callback
         */
        static overlayPage(contentElement, callback) {
            /**
             * @type {HTMLElement?}
             */
            let closer = document.createElement('div');
            var ignoreFocusOut = false;
            /**
             * @param {KeyboardEvent} e
             */
            function documentEscListener(e) {
                if (e.key === "Escape" || e.key === "Esc") {
                    close();
                }
            }
            function close() {
                if (!closer)
                    return;
                document.removeEventListener('keydown', documentEscListener);
                closer.parentNode?.removeChild(closer);
                closer = null;
                callback && callback();
            }
            /**
             * @param {boolean} ignore
             */
            function setIgnoreFocusOut(ignore) {
                ignoreFocusOut = ignore;
                if (ignore && closer) {
                    closer.style.pointerEvents = "none";
                    contentElement.style.pointerEvents = "auto";
                }
            }
            closer.style.cssText = 'margin: 0; padding: 0; ' +
                'position: fixed; top:0; bottom:0; left:0; right:0;' +
                'z-index: 9990; ' +
                'background-color: rgba(0, 0, 0, 0.3);';
            closer.addEventListener('click', function (e) {
                if (!ignoreFocusOut) {
                    close();
                }
            });
            document.addEventListener('keydown', documentEscListener);
            contentElement.addEventListener('click', function (e) {
                e.stopPropagation();
            });
            closer.appendChild(contentElement);
            document.body.appendChild(closer);
            return {
                close: close,
                setIgnoreFocusOut: setIgnoreFocusOut
            };
        }

        // @ts-ignore
        static openItemInSs(targetItem) {
            const action = ['DATA', 'VIEW'].includes(targetItem.type) ? 'TableOpen' :
                targetItem.fileType === 'TXT' ? 'FileOpenWithTextViewer' :
                    targetItem.fileType === 'EXT' ? 'FileOpenWithExternalProgram' :
                        'FileOpen';
            // @ts-ignore
            window.appDMS.handleWebOneEvent(action, targetItem);
        }

        /**
         * Focus the project tree to the provided item path,
         *  if the path start with 'libraries' then use the library tree,
         *  otherwise use the project (files) tree
         * @param {String} itemPath Absolute item path
         */
        static focusItemOnTree(itemPath) {
            window._browseSsDebugLog('browse_ss: focusing tree on item ', itemPath);
            /** * @param {string} targetTreeId */
            function selectTreePane(targetTreeId) {
                const paneId = `${targetTreeId}Pane`;
                // @ts-ignore
                const accContainer = window.dijit.byId('accContainer');
                const targetPane = accContainer.getChildren().filter((/** @type {{ id: string; }} */ p) => p.id === paneId)?.[0];
                if (targetPane) accContainer.selectChild(targetPane);
            }
            // @ts-ignore
            function scrollTreeToSelectedNode(tree) {
                selectTreePane(tree.id.split('.')[0]);
                const targetNode = tree.get('selectedNode')?.labelNode;
                if (targetNode?.scrollIntoViewIfNeeded) {
                    targetNode.scrollIntoViewIfNeeded();
                } else {
                    targetNode.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                }
            }
            /**
             * @param {string} targetPath
             * @param {string=} targetTreeId
             */
            function scrollTreeToPath(targetPath, targetTreeId) {
                if (!targetPath) return;
                const treeId = targetTreeId ?? (targetPath.startsWith('libraries') ? 'library' : 'projects');
                // @ts-ignore
                const tree = window.dijit.byId(`${treeId}.tree`);

                if (treeId === 'library') targetPath = targetPath.replace(/[.~]/g, '/');

                // dojo provide tree.set('path',...) for this purpose but it does not work
                // => because DMSProject modified the method ._expandNode(), making it return undefined instead of a Promise
                // DMSProject backup the original method as ._expandNodeStash() but sometimes it messes up, likely during refreshes
                // Create a version of the original method for our own usage
                // @ts-ignore
                const expandNodeOrig = window.dijit.Tree.prototype._expandNode.bind(tree);

                /**
                 * @param {{ getChildren: () => any; }} node
                 * @param {string} path
                 */
                function expandRecursively(node, path) {
                    return expandNodeOrig(node).then(() => {
                        for (const child of node.getChildren()) {
                            const childUri = (treeId === 'library') ?
                                (child.item.uri ?? 'libraries').replace(/[.~]/g, '/') :
                                child.item.uri;
                            const isTarget = childUri === path;
                            const isAncestor = path.startsWith(childUri + '/');
                            if (!(isTarget || isAncestor)) continue;
                            // Select current child node
                            tree.set('selectedNode', child);
                            if (isAncestor) return expandRecursively(child, path);
                        }
                    });
                }
                return expandRecursively(tree.rootNode, targetPath).then(() => {
                    scrollTreeToSelectedNode(tree);
                });
            }
            scrollTreeToPath(itemPath);
        }

        /**
         * Normalize the provided item path: each components is separated by
         *  a single slash, no blank at begining, no slash at the end,
         *  blank is converted to root path '/'
         * @param {String} itemPath Absolute item path
         * @returns {String}
         */
        static normalizeItemPath(itemPath) {
            const trimmed = (itemPath ?? '').trimStart();
            const replacedConsecutiveSlashes = trimmed.replace(/\/+/g, '/');
            if (trimmed === '' || replacedConsecutiveSlashes === '/') return '/';
            const replacedEndingSlash = replacedConsecutiveSlashes.replace(/\/+$/, '');
            return replacedEndingSlash;
        }

        /**
         * Get path to current collection without slash at the end:
         *  if path ends with a slash then return the current collection,
         *  otherwise return the parent path
         * @param {String} itemPath Absolute item path
         * @returns {String}
         */
        static getCurCollPath(itemPath) {
            const trimmed = itemPath.trimStart();
            const replacedConsecutiveSlashes = trimmed.replace(/\/+/g, '/');
            if (trimmed === '' || replacedConsecutiveSlashes === '/') return '/';
            return replacedConsecutiveSlashes.includes('/') ?
                replacedConsecutiveSlashes.slice(0, replacedConsecutiveSlashes.lastIndexOf('/')) :
                replacedConsecutiveSlashes;
        }

    }

    class SsFiles {
        static defaultPath = '/applis/12201-esmb0-sasbasic/data/DEN/';
        static placeholder = 'Enter a path to browse';
        static maxHistory = 100;
        static historyKey = 'BrowseSsFilesHistory';
        static fileIconMap = new Map([
            ['sas', '📘 '],
            ['sas7bdat', '📅 '],
            ['log', '📜 '],
            ['lst', '📃 '],
            ['txt', '📝 '],
            ['xls', '📊 '],
            ['xlsx', '📊 '],
            ['csv', '📊 '],
            ['sh', '💲 '],
        ]);

        /** @returns {String} */
        static getStartPath() {
            // Get current project tree root path, 0th child is 'Folder Shortcuts'
            const currentRootPath = window.appDMS.projects.tree.rootNode.getChildren()[1].item.uri;
            // If current open tab is a file then use the file path
            //  This allow to get information about the file
            const currentTab = window.appDMS.tabs.getFocusedTab();
            return (currentTab?.type === 'FILE' && currentTab?.uri) ?
                currentTab.uri : (currentRootPath ?? SsFiles.defaultPath) + '/';
        }

        /**
         * Get DataItem from provided file path
         * @param {String} filePath Absolute file path
         * @returns {Promise<Partial<DataItem>>}
         */
        static getFileDataItem(filePath) {
            window._browseSsDebugLog('browse_ss: filePath is ', filePath);
            const cleanedPath = Utils.normalizeItemPath(filePath);
            const convertedPath = cleanedPath.replace(/\/+/g, '~ps~');
            /**
             * @type {Promise<SsFileItem>}
             */
            // @ts-ignore
            const fsItem = window.appDMS.projects.projectTreeStore.query(convertedPath);
            return fsItem.then(item => {
                window._browseSsDebugLog('browse_ss: get file item', item);
                /** @type Partial<DataItem> */
                const dataItem = {
                    uri: item.uri,
                };
                dataItem.children = item.children?.map(childItem => {
                    const prefix = childItem.isDirectory ? '📁 ' :
                        (SsFiles.fileIconMap.get(childItem.name.split('.').at(-1)?.toLocaleLowerCase() ?? '') ?? '');
                    return {
                        value: prefix + childItem.name,
                        prefix: prefix,
                        uri: childItem.uri,
                        keepPrompt: false,
                        meta: childItem.isDirectory ? '>' :
                            `${SsFiles.bytesToSize(childItem.size)}┊${SsFiles.modifiedDateString(childItem)}`,
                    };
                });
                dataItem.children?.unshift(
                    {
                        uri: item.uriParent,
                        value: '⬆️.. ' + SsFiles.childrenItemsCount(item.children ?? []),
                        meta: '>',
                        keepPrompt: false,
                    },
                );

                return dataItem
            })
        }

        /**
         * Open the file in SAS Studio
         * @param {DataItem} fileDataItem DataItem pointing to the file
         * @param {boolean=} asText Whether to open the file as text 
         */
        static openFile(fileDataItem, asText) {
            window._browseSsDebugLog('browse_ss: opening file ', fileDataItem);
            const targetItem = {
                uri: fileDataItem.uri,
                name: Utils.normalizeItemPath(fileDataItem.uri).split('/').at(-1),
                type: 'FILE',
            }
            // @ts-ignore
            if (asText) { targetItem.fileType = 'TXT' }
            Utils.openItemInSs(targetItem);
        }

        /**
         * @param {SsFileItem[]} childrenItems
         * @returns {String}
         */
        static childrenItemsCount(childrenItems) {
            if (childrenItems.length == 0) return '';
            let [fileCount, directoryCount] = [0, 0];
            childrenItems.forEach(item => {
                if (item.isDirectory) directoryCount++;
                else fileCount++;
            });
            const allCountTexts = [
                directoryCount > 0 ? directoryCount + (directoryCount > 1 ? ' directories' : ' directory') : '',
                fileCount > 0 ? fileCount + (fileCount > 1 ? ' files' : ' file') : '',
            ].filter(i => Boolean(i));
            let result = allCountTexts.length > 1 ? `${childrenItems.length} children: ` : '';
            result += allCountTexts.join(', ');
            return result;
        }


        /**
         * @param {Partial<SsFileItem>} fileItem 
         * @returns {String}
         */
        static modifiedDateString(fileItem) {
            if (fileItem.originalModifiedDateString) return fileItem.originalModifiedDateString;
            const ts = fileItem.modifiedDate ?? 0;
            if (ts > 0) {
                const localTs = ts + new Date().getTimezoneOffset() * 60000;
                const modifiedDate = new Date(localTs);
                return modifiedDate.toLocaleString('en-CA', { hour12: false, timeZoneName: 'short' });
            }
            return '';
        }

        /**
         * @param {String} sizeInBytesStr
         * @returns {String}
         */
        static bytesToSize(sizeInBytesStr) {
            const units = ["B", "KB", "MB", "GB", "TB"];
            const sizeInBytes = parseInt(sizeInBytesStr.split(' ')[0]);
            if (sizeInBytes == 0) {
                return "0 " + "B";
            }
            const i = Math.floor(Math.log(sizeInBytes) / Math.log(1024));
            if (i == 0) {
                return sizeInBytes + " " + units[i];
            }
            return (
                parseFloat((sizeInBytes / Math.pow(1024, i)).toFixed(1)) +
                " " + units[i]
            );
        }
    }

    class SsLibrary {
        static defaultPath = 'libraries/';
        static placeholder = 'Enter a path to browse';
        static maxHistory = 100;
        static historyKey = 'BrowseSsLibraryHistory';

        /** @returns {String} */
        static getStartPath() {
            // If current open tab is a table or a view then use the current path
            //  This allow to get information about the table/view columns
            const currentTab = window.appDMS.tabs.getFocusedTab();
            return (['DATA', 'VIEW'].includes(currentTab?.type) && (currentTab?.id ?? currentTab?.uri)) ?
                (currentTab.id ?? currentTab.uri).replaceAll('~', '/') + '/'
                : SsLibrary.defaultPath;
        }

        /**
         * Get DataItem from provided file path
         * @param {String} libraryItemPath Absolute item path
         * @returns {Promise<Partial<DataItem>>}
         */
        static getLibraryDataItem(libraryItemPath) {
            window._browseSsDebugLog('browse_ss: libraryItemPath is ', libraryItemPath);
            const cleanedPath = Utils.normalizeItemPath(libraryItemPath);
            const convertedPath = cleanedPath.replace(/\/+/g, '~');
            window._browseSsDebugLog('browse_ss: query library item', convertedPath);
            /** * @type {Promise<SsLibraryItem>} */
            const sSItem = window.appDMS.libraries.treeModel.query(convertedPath);
            return sSItem.then(item => {
                window._browseSsDebugLog('browse_ss: got item', item);
                // item.id is only library name when querying library item directly
                // item.id is null when querying table item directly
                // Easier to use cleanedPath than handle all issue with item.id
                /** @type Partial<DataItem> */
                const dataItem = { uri: cleanedPath };
                dataItem.children = item.children?.map(childItem => {
                    const prefix = childItem.isLibrary ?
                        (childItem.engine === "V9" ? '📚️ ' : childItem.engine === 'ORACLE' ? '📕️ ' : '❔ ') :
                        childItem.table ? (childItem.type === 'VIEW' ? '🔍 ' : '📅 ') :
                            childItem.library === 'columns' ? (childItem.type === 'Numeric' ? '💯 ' : '©️️ ') :
                                '';
                    return {
                        value: prefix + childItem.name,
                        prefix: prefix,
                        uri: childItem.id.replaceAll('~', '/'),
                        keepPrompt: false,
                        meta: (childItem.isLibrary || childItem.table) ? '>' :
                            `${item.dataType === 'VIEW' ? 'V' : ''}${childItem.type} ${childItem.format}`,
                    };
                });
                const parentUri = cleanedPath.indexOf('/') >= 0 ?
                    cleanedPath.slice(0, cleanedPath.lastIndexOf('/')) : 'libraries';
                dataItem.children?.unshift(
                    {
                        uri: parentUri,
                        value: '⬆️.. ' + SsLibrary.childrenItemsCount(item.children ?? []),
                        meta: '>',
                        keepPrompt: false,
                    },
                );
                window._browseSsDebugLog('browse_ss: return data item', dataItem);
                return dataItem
            })
        }

        /**
         * Open the library table in SAS Studio
         * @param {DataItem} tableDataItem DataItem pointing to the table/view
         */
        static openTable(tableDataItem) {
            window._browseSsDebugLog('browse_ss: opening table ', tableDataItem);
            const [root, library, table] = Utils.normalizeItemPath(tableDataItem.uri).split('/');
            const targetItem = {
                type: tableDataItem.meta?.startsWith('V') ? 'VIEW' : 'DATA',
                uri: `${root}~${library}/${table}`,
                library: library,
                name: table
            }
            Utils.openItemInSs(targetItem);
        }

        /**
         * @param {SsLibraryItem[]} childrenItems
         * @returns {String}
         */
        static childrenItemsCount(childrenItems) {
            if (childrenItems.length == 0) return '';
            let [libraryCount, tableCount, columnCount] = [0, 0, 0];
            childrenItems.forEach(item => {
                if (item.isLibrary) libraryCount++;
                else if (item.table) tableCount++;
                else if (item.library === 'columns') columnCount++;
            });
            const allCountTexts = [
                libraryCount > 0 ? libraryCount + (libraryCount > 1 ? ' libraries' : ' library') : '',
                tableCount > 0 ? tableCount + (tableCount > 1 ? ' tables' : ' table') : '',
                columnCount > 0 ? columnCount + (columnCount > 1 ? ' columns' : ' column') : '',
            ].filter(i => Boolean(i));
            let result = allCountTexts.length > 1 ? `${childrenItems.length} children: ` : '';
            result += allCountTexts.join(', ');
            return result;
        }
    }

    class SsTabs {
        static defaultPath = '';
        static placeholder = 'Search tab title';
        static tabTypeIconMap = new Map([
            ["newprogram", '📘 '],
            ["data", '🔍 '],
            ["view", '📅 '],
            ["task", '📋 '],
            ["querytool", '📖 '],
            ["importtool", '📥 '],
        ]);

        /**
         * Get DataItem from provided tabs
         * @param {String} tabItemPath Absolute item path
         * @returns {Promise<Partial<DataItem>>}
         */
        static getTabDataItem(tabItemPath) {
            return new Promise((resolve, reject) => {
                /** @type {(SsTabItem & SsFileItem & SsLibraryItem)[]} */
                const sSTabItems = window.appDMS.tabs.getAllTabObjects();

                /** @type Partial<DataItem> */
                const dataItem = { uri: '' };
                dataItem.children = sSTabItems.map(tabItem => {
                    if (!tabItem.tabTitle && !tabItem.title) reject(new Error(`Invalid tab title in tab: ${tabItem}`));
                    const prefix = tabItem.type?.toLowerCase() === 'file' ?
                        (SsFiles.fileIconMap.get(tabItem.fileType?.toLocaleLowerCase() ?? '') ?? '📝 ') :
                        (SsTabs.tabTypeIconMap.get(tabItem.type?.toLowerCase() ?? '') ?? '');
                    return {
                        value: prefix + (tabItem.tabTitle ?? tabItem.title),
                        prefix: prefix,
                        uri: tabItem.tabTitle ?? tabItem.title ?? '',
                        keepPrompt: false,
                        meta: `${tabItem.fileType ?? ''} ${tabItem.type}`,
                    };
                });
                resolve(dataItem)
            })
        }

        /**
         * Open the library table in SAS Studio
         * @param {DataItem} tabDataItem DataItem pointing to the selected tab
         */
        static openTab(tabDataItem) {
            window._browseSsDebugLog('browse_ss: opening tab ', tabDataItem);
            const tabs = window.appDMS.tabs;
            /** @type {(SsTabItem & SsFileItem & SsLibraryItem)[]} */
            const allTabs = tabs.getAllTabObjects();
            const [tabFileType, tabType] = tabDataItem.meta?.split(' ') ?? [];
            const n = allTabs.findIndex(
                t => (t.tabTitle ?? t.title) === tabDataItem.uri &&
                    t.type === tabType && (t.fileType ?? '') === tabFileType
            );
            tabs.selectTab(allTabs[n]);
            tabs.getFocusedTab().editor?.editor?.focus?.();
        }

    }

});
(function () {
    // @ts-ignore
    ace.require(["ace/ext/browse_ss"], function (m) {
        if (typeof module == "object" && typeof exports == "object" && module) {
            module.exports = m;
        }
    });
})();

function _reloadBrowseSs() {
    const moduleId = 'ace/ext/browse_ss';
    // @ts-ignore
    const srcPath = ace.config.moduleUrl(moduleId);
    Array.from(document.body.getElementsByTagName('script')).filter(el => el.src && el.src === srcPath).forEach(el => el.remove());
    document.getElementById('browse_ss.css')?.remove();
    // @ts-ignore
    delete ace.define.modules[moduleId];
    const el = document.createElement('script');
    el.src = srcPath;
    el.onload = function () {
        window._browseSsDebugLog(`${moduleId}: reloaded`);
        el.parentNode?.removeChild(el);
    }
    document.body.appendChild(el);
}
window._browseSs_DEBUG = false;
window._browseSsDebugLog = function () {
    if (window._browseSs_DEBUG) {
        // @ts-ignore
        console.debug.apply(this, arguments);
    }
}

/**
 * @typedef {Object} DataItem
 * @property {String} uri Absolute item path
 * @property {String} value Display name for the item (uri in case of history item)
 * @property {String?} meta Secondary description, '>' for collection
 * @property {Boolean?} keepPrompt Whether to keep current prompt value when select this item
 * @property {Boolean?} error Marks a non-selectable error entry (ignored by all select/accept handlers)
 * @property {String?} message Message on item
 * @property {String?} prefix Prefix to item name, mainly for history item icon
 * @property {Partial<DataItem>[]?} children Children items
 */

/**
 * @typedef {Object} SsFileItem File Item retrieved from SAS Studio
 * @property {String} uri Absolute file path
 * @property {String} uriParent Absolute parent path
 * @property {String} name File name
 * @property {String} id Item id
 * @property {Boolean} isDirectory Whether the item is a directory or a file
 * @property {Number} modifiedDate Modified date timestamp
 * @property {String} size Item size
 * @property {String?} fileType Type of file (as it is opened)
 * @property {String} originalModifiedDateString Original modified date in string
 * @property {SsFileItem[]?} children Children items
 */

/**
 * @typedef {Object} SsLibraryItem Library Item retrieved from SAS Studio
 * @property {String} name Item name
 * @property {String} id Item id
 * @property {String} engine Library engine name
 * @property {String?} library Library name this item belong to, all columns belong to the 'columns' library
 * @property {Boolean} table Whether the item is a table
 * @property {Boolean} isDBMS Whether the item is a DBMS item
 * @property {Boolean} isLibrary Whether the item is a library
 * @property {String?} type Column data type
 * @property {String?} dataType Only seems to be set to 'VIEW' when item is a view
 * @property {String?} format Column data format
 * @property {SsLibraryItem[]?} children Children items
 */

/**
 * @typedef {Object} SsTabItem Tab Item retrieved from SAS Studio
 * @property {String?} title
 * @property {String?} tabTitle
 */