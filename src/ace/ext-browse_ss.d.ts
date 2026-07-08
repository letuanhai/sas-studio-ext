export type KeyboardEventListener = (ev: KeyboardEvent) => any;
declare global {
    interface Window {
        _browseSs_DEBUG: Boolean?,
        _browseSsDebugLog: Function,
        _browseSsLastPrompt: { popup: any, cmdLine: any },
        appDMS: any,
        _browseSsFilesListener: KeyboardEventListener;
        _browseSsLibraryListener: KeyboardEventListener;
        _browseSsTabsListener: KeyboardEventListener;
    }
}