export type KeyboardEventListener = (ev: KeyboardEvent) => any;
declare global {
    interface Window {
        _browseSs_DEBUG: Boolean|null,
        _browseSsDebugLog: Function,
        _browseSsLastPrompt: { popup: any, cmdLine: any },
        // Relayed chrome.storage cache (history/bookmarks) - see browse_ss's own
        // comment; values are whatever was stored, arrays in practice.
        _browseSsStore: {
            get: (key: string) => any,
            set: (key: string, value: any) => void,
            ready: (key: string) => Promise<void>,
        },
        // editor-swap.js's singleton; browse_ss only reads .browsePaths off it.
        __ssExt: any,
        appDMS: any,
        _browseSsFilesListener: KeyboardEventListener;
        _browseSsLibraryListener: KeyboardEventListener;
        _browseSsTabsListener: KeyboardEventListener;
    }
}