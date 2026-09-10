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
  - [x] ~~PROC LUA submit;...endsubmit; blocks: completion, diagnostics, hover, semantic
        tokens and signature help~~ (the same worker over a rawChannel side channel, fed the
        sas file with every non-lua line blanked so an LSP position IS an ace position; one
        completer, doHover/provideSignatureHelp wraps on the SAS provider, a setAnnotations
        wrapper so both servers share the gutter, and the tokens decoded and added as the
        same ace text markers ace-linters uses)
  - [ ] the rest of what ace-linters gives a .lua file is still missing inside a block:
        document highlights, code actions and formatting. Each is one more wrap, and none
        has been asked for yet

- allow configuring snippet for all languages, not just sas, using the snippet editor in options page, adding language selection