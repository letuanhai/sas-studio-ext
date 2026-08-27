export type KeyboardEventListener = (ev: KeyboardEvent) => any;
export type BrowseKeyTool = {
    name: string,
    label: string,
    keys: string,
    legend?: string,
    history?: boolean,
};
declare global {
    interface Window {
        // tools-meta.js: the browse prompt's keybinding table + the two helpers
        // that resolve/format a binding against the options page's overrides.
        SSF_BROWSE_KEYS: BrowseKeyTool[],
        ssfBrowseKeys: (tool: BrowseKeyTool, browseKeys: Record<string, string> | undefined) => string,
        ssfBrowseKeyLabel: (keys: string) => string,
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
        // ss-fixes.js's entry points; browse_ss only calls copyText (the
        // clipboard path that also works on an insecure origin).
        __ssf?: { copyText: (text: string) => void } & Record<string, any>,
        appDMS: any,
        _browseSsFilesListener: KeyboardEventListener;
        _browseSsLibraryListener: KeyboardEventListener;
        _browseSsTabsListener: KeyboardEventListener;
    }
}