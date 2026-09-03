- ~~saslog mode~~ done: `src/ace/mode-saslog.js`, `.log` files via ext/modelist
- ~~sas folding both ways~~ done: `foldStyle: "markbeginend"` in `DEFAULT_ACE_CONFIG`
- ~~vim multi-cursor keybinding~~ nothing to do: ace's vim keymap already binds
  Ctrl+Alt+K / Ctrl+Alt+J (add cursor above/below) and Ctrl+Alt+Shift+K/J (skip current)
- other extensions take over the hotkeys, especially Esc got stolen by SurfingKeys
- ~~add vim mode mappings to navigate folds: zj zk [z ]z~~ done: `installVimFoldMotions()` in
  `src/editor-swap.js`, row pickers covered by `test/units.js`
- ~~show vim marks in editor gutter or scroll bar, show `:marks` similar to `:registers`~~ done:
  gutter decorations + a `:marks` ex-command in `src/editor-swap.js`, covered by `test/units.js`
  (deletion is ace's own `:delmarks a` / `:delmarks a-z`)
- bug: when completing sas marcos: if i type a word starting with %, it will suggest sas macro functions and if select a word of type Function it will complete the macro function name with % at beginning, so there is now double % at start of word