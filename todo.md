- lua lsp with sas module docs
  - [x] .lua files opened as text: routed through ace-linters, so completion, diagnostics,
        hover, signature help, document highlights, code actions, semantic tokens
  - [x] formatting: Ctrl-Shift-F / command palette (ace-linters' own format() is off by one
        and formats nothing, so the range is built here)
  - [x] ~~sas module docs: meta definitions for the sas.* API, which the server can't know about~~
        (src/lua/sas.lua for the package API, SAS LSP at runtime for the DATA step functions)
  - [x] ~~require() of another open .lua tab~~ (real filePath URIs on the documents +
        workspace roots the worker derives from them; needed two more cfg(wasm) guards in
        tools/emmylua-wasm.patch, since the stock build scans the filesystem for a root)
  - [x] ~~switching an editor's mode from ace's settings pane moves it between the two
        servers~~ (session changeMode -> _syncLspToMode: unregister, re-register with the
        other provider; ace-linters' own changeMode only re-resolves inside its manager)
  - [ ] PROC LUA submit;...endsubmit; blocks: completion, diagnostics and hover. Built and
        working once (commit b588131 on lua-lsp: own JSON-RPC client over a second emmylua
        worker, the sas file with non-lua lines blanked, setAnnotations/doHover shared with
        the sas provider), then removed to finish the .lua path and the sas module first

- allow configuring snippet for all languages, not just sas, using the snippet editor in options page, adding language selection