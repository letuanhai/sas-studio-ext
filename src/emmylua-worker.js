// Worker half of the Lua language server: runs lib/emmylua-lsp/emmylua_ls.wasm
// (emmylua-analyzer-rust built for wasm32-wasip1, see tools/build_lib.sh) and
// speaks plain LSP JSON-RPC over postMessage - message in, message out, same
// shape as any other worker language server.
//
// The wasm module has no threads and no stdio: our tools/emmylua-wasm.patch
// exports a five-call C ABI instead (ela_start/alloc/push/pump/take, see the
// patch's crates/emmylua_ls/src/wasm.rs). `ela_push` hands the server one
// JSON-RPC message, `ela_pump(steps)` drives its current-thread tokio runtime
// for a bounded number of cooperative yields, and `ela_take` pops one outgoing
// message. Nothing blocks, so the worker's event loop stays responsive.
//
// The wasm URL comes from self.__ssExtEmmyLuaWasm, set by the blob wrapper that
// importScripts()es this file (see startEmmyLuaWorker in editor-swap.js), as
// does self.__ssExtEmmyLuaDefs, the URL of the SAS API definitions this opens
// as an extra document.
"use strict";

// wasi_snapshot_preview1, only as far as this module actually needs it. Rust's
// std pulls in the whole table, but with the Lua stdlib metadata compiled into
// the binary (include_dir!) and no workspace folders, nothing here ever touches
// a real file - everything but the clock, randomness and stderr is a stub.
const ENOSYS = 52;
const EBADF = 8;

function wasiShim(getMemory, onStderr) {
  const view = () => new DataView(getMemory().buffer);
  const bytes = () => new Uint8Array(getMemory().buffer);
  const stub = () => ENOSYS;

  // fd_write's iovec walk, shared by stdout and stderr.
  function collect(iovsPtr, iovsLen) {
    const dv = view();
    const buf = bytes();
    let out = "";
    let written = 0;
    for (let i = 0; i < iovsLen; i++) {
      const ptr = dv.getUint32(iovsPtr + i * 8, true);
      const len = dv.getUint32(iovsPtr + i * 8 + 4, true);
      out += new TextDecoder().decode(buf.slice(ptr, ptr + len));
      written += len;
    }
    return { out, written };
  }

  return {
    random_get: (ptr, len) => {
      crypto.getRandomValues(bytes().subarray(ptr, ptr + len));
      return 0;
    },
    clock_time_get: (id, precision, out) => {
      // Timers matter: the server debounces its own work on tokio::time.
      view().setBigUint64(out, BigInt(Math.round(Date.now() * 1e6)), true);
      return 0;
    },
    environ_sizes_get: (countPtr, sizePtr) => {
      const dv = view();
      dv.setUint32(countPtr, 0, true);
      dv.setUint32(sizePtr, 0, true);
      return 0;
    },
    environ_get: () => 0,
    fd_write: (fd, iovs, iovsLen, nwritten) => {
      const { out, written } = collect(iovs, iovsLen);
      view().setUint32(nwritten, written, true);
      if (fd === 2 || fd === 1) onStderr(out);
      return 0;
    },
    fd_read: () => EBADF,
    fd_close: () => 0,
    fd_seek: () => EBADF,
    fd_readdir: () => EBADF,
    fd_filestat_get: () => EBADF,
    fd_fdstat_get: (fd, out) => {
      // 24-byte fdstat; filetype 2 = character device, rights left at 0.
      const dv = view();
      new Uint8Array(getMemory().buffer, out, 24).fill(0);
      dv.setUint8(out, 2);
      return 0;
    },
    // Returning EBADF for fd 3 is how libc's preopen scan learns there are none.
    fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF,
    path_open: stub,
    path_filestat_get: stub,
    path_create_directory: stub,
    path_readlink: stub,
    path_rename: stub,
    path_unlink_file: stub,
    poll_oneoff: stub,
    sched_yield: () => 0,
    proc_exit: (code) => {
      throw new Error("emmylua_ls exited with code " + code);
    },
  };
}

// The server's own config (an .emmyrc.json object), handed back from the
// workspace/configuration request it makes at startup - there is no file for it
// to read here. Left at its default it assumes Lua 5.4, but PROC LUA is tkLua
// 5.2 (`print(_VERSION)` in a submit block), so 5.3+ syntax the SAS runtime
// would reject - integer division, goto - passes unremarked and 5.4-only stdlib
// is offered. Verified: with this, `7 // 2` is reported as "integer division is
// not supported".
// ponytail: hardcoded. The Lua version is a property of SAS, not of the user.
// workspaceRoots starts empty and is filled from the documents that open - see
// addRoot below.
const EMMYRC = { runtime: { version: "Lua5.2" }, workspace: { workspaceRoots: [] } };

let ex = null; // the wasm instance's exports

// The server writes its own `[timestamp LEVEL module] message` log to stderr,
// one fd_write per fragment, and dumps its whole resolved config at INFO on
// every start. Reassemble lines and keep only warnings and errors, so this
// stays in line with the rest of the extension's logging.
let stderrBuf = "";
function logStderr(chunk) {
  stderrBuf += chunk;
  const lines = stderrBuf.split("\n");
  stderrBuf = lines.pop();
  lines.forEach((line) => {
    if (/\b(WARN|ERROR)\b/.test(line)) console.warn("[SS Ext][lua-lsp]", line.trim());
  });
}

function send(obj) {
  const b = new TextEncoder().encode(JSON.stringify(obj));
  const ptr = ex.ela_alloc(b.length);
  new Uint8Array(ex.memory.buffer).set(b, ptr);
  ex.ela_push(ptr, b.length);
}

function drain() {
  for (;;) {
    const ptr = ex.ela_take();
    if (!ptr) return;
    const len = new DataView(ex.memory.buffer).getUint32(ptr, true);
    const json = new TextDecoder().decode(
      new Uint8Array(ex.memory.buffer).slice(ptr + 4, ptr + 4 + len),
    );
    const msg = JSON.parse(json);
    // Server-to-client requests: the client half of this pair has no
    // capabilities to register, so answer them here and keep them off the main
    // thread. A request left unanswered stalls the server's own init. The one
    // that carries settings is workspace/configuration (section "emmylua"),
    // which the server asks once at startup - that is the only hook for its
    // config, so EMMYRC goes back for every requested item.
    if (msg.method && msg.id !== undefined) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result:
          msg.method === "workspace/configuration"
            ? ((msg.params && msg.params.items) || [{}]).map(() => EMMYRC)
            : null,
      });
      continue;
    }
    self.postMessage(msg);
  }
}

function pump(steps) {
  ex.ela_pump(steps);
  drain();
}

// A client may hand us a change for a document it hasn't opened yet, which LSP
// doesn't allow and the server can't make sense of: ace-linters does exactly
// that when an editor's text lands after it registered the session but before
// its connection is up. It flushes the text as a didChange, and then sends its
// own didOpen carrying the snapshot it took at registration - which is empty.
// The server ends up with an empty file (verified: it publishes 0 diagnostics),
// so nothing shows until the next real edit re-sends the text.
//
// So: hold a change for an unopened document, and fold its text into that
// document's didOpen when it comes - the held change is by definition the newer
// content, and this server syncs FULL text, so the two are interchangeable.
// Replaying the change after the open instead does NOT work: it carries the
// version the client had at the time, and the server ignores a change that
// isn't newer than the open it just processed.
const openDocs = new Set();
const heldChanges = new Map(); // uri -> the last change that arrived too early

function uriOf(msg) {
  const td = msg && msg.params && msg.params.textDocument;
  return (td && td.uri) || undefined;
}

// The full-text form of a change, or undefined for an incremental one (which
// this server never asks for - it declares TextDocumentSyncKind.FULL).
function fullText(change) {
  const first = change && change.params && (change.params.contentChanges || [])[0];
  return first && first.range === undefined ? first.text : undefined;
}

// The `sas` table PROC LUA puts in scope is not discoverable from any Lua the
// user writes, so the server is handed src/lua/sas.lua as one more open
// document: emmylua indexes every open document into the same workspace, so its
// globals are in scope in the user's file too (verified against the server).
// Opening it right after the initialize request keeps the client out of it -
// both consumers get the definitions with no code of their own.
let sasDefs = null; // { uri, text }

function openSasDefs() {
  if (!sasDefs) return;
  send({
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: { uri: sasDefs.uri, languageId: "lua", version: 1, text: sasDefs.text },
    },
  });
}

// Workspace roots, which is what makes require() resolve: the server derives a
// module name for every file it knows by stripping a root off its path
// (add_module_by_path), so with a root covering an open document, a require of
// it from another one resolves - no filesystem needed, which is just as well
// since there isn't one (tools/emmylua-wasm.patch cuts the workspace scan and
// the file watcher out of the wasm build for exactly that reason).
//
// The folder can't be known at startup, so it is taken from the documents
// themselves as they open and pushed with workspace/didChangeConfiguration;
// the server re-reads its configuration and re-indexes. Verified: a late push
// turns "Cannot resolve module `helper`" into the real signature on hover.
const roots = new Set();

// The server reads its configuration in exactly one way: by REQUESTING it
// (workspace/configuration), and only if the client said it can answer -
// `on_did_change_configuration` throws the notification's own `settings` away
// and re-requests instead. ace-linters never declares that capability (it sends
// `workspace: { didChangeConfiguration, executeCommand, applyEdit, ... }` and
// nothing else), so without this the server never asks, EMMYRC is never
// applied, and both the Lua version and the workspace roots are silently
// ignored - which is exactly how it behaved before this was found.
function withConfigCapability(msg) {
  const params = (msg && msg.params) || {};
  const capabilities = params.capabilities || {};
  return {
    ...msg,
    params: {
      ...params,
      capabilities: {
        ...capabilities,
        workspace: { ...(capabilities.workspace || {}), configuration: true },
      },
    },
  };
}

// The parent folder of a "file:///a/b/c.lua" document, or null for one of ours
// (the defs live at an /ssext/ path that no user file can be under).
function rootOf(uri) {
  if (typeof uri !== "string" || !uri.startsWith("file:///")) return null;
  const p = decodeURIComponent(uri.slice("file://".length));
  if (p.startsWith("/ssext/")) return null;
  const cut = p.lastIndexOf("/");
  return cut > 0 ? p.slice(0, cut) : null;
}

function addRoot(uri) {
  const root = rootOf(uri);
  // A root already covered by one we have adds nothing but a re-index.
  if (!root || roots.has(root)) return;
  roots.add(root);
  EMMYRC.workspace.workspaceRoots = [...roots];
  send({
    jsonrpc: "2.0",
    method: "workspace/didChangeConfiguration",
    params: { settings: EMMYRC },
  });
}

function forward(msg) {
  const uri = uriOf(msg);
  const method = msg && msg.method;
  if (method === "initialize") {
    send(withConfigCapability(msg));
    openSasDefs();
    return;
  }
  if (method === "textDocument/didChange" && uri && !openDocs.has(uri)) {
    heldChanges.set(uri, msg);
    return;
  }
  if (method === "textDocument/didOpen" && uri) {
    openDocs.add(uri);
    const held = heldChanges.get(uri);
    heldChanges.delete(uri);
    const text = held && fullText(held);
    if (text !== undefined && text !== msg.params.textDocument.text) {
      msg = {
        ...msg,
        params: { textDocument: { ...msg.params.textDocument, text } },
      };
    }
    send(msg);
    addRoot(uri);
    return;
  }
  if (method === "textDocument/didClose" && uri) {
    openDocs.delete(uri);
    heldChanges.delete(uri);
  }
  send(msg);
}

const queue = [];
self.onmessage = (e) => {
  if (!ex) {
    queue.push(e.data);
    return;
  }
  forward(e.data);
  pump(512);
};

(async () => {
  const url = self.__ssExtEmmyLuaWasm;
  const defsUrl = self.__ssExtEmmyLuaDefs;
  // Loaded before the queued messages are forwarded, so the initialize that
  // opens it can never outrun the fetch.
  if (defsUrl) {
    sasDefs = await fetch(defsUrl)
      .then((r) => r.text())
      .then((text) => ({ uri: "file:///ssext/defs/sas.lua", text }))
      .catch((e) => {
        console.warn("[SS Ext] SAS Lua definitions unavailable:", (e && e.message) || e);
        return null;
      });
  }
  const wasm = await WebAssembly.compileStreaming(fetch(url)).catch(async () =>
    // compileStreaming needs an application/wasm content type; fall back to the
    // buffered form rather than depending on how the resource is served.
    WebAssembly.compile(await (await fetch(url)).arrayBuffer()),
  );
  const instance = await WebAssembly.instantiate(wasm, {
    wasi_snapshot_preview1: wasiShim(() => ex.memory, logStderr),
  });
  ex = instance.exports;
  // A wasip1 cdylib has no crt1, so there is usually no _initialize to call
  // (LLVM calls the ctors from the exports themselves) - honour it if present.
  if (typeof ex._initialize === "function") ex._initialize();
  ex.ela_start();
  queue.splice(0).forEach(forward);
  pump(2048);
  // Idle heartbeat so the server's debounced tasks (diagnostics, reindex) still
  // get polled when no message is coming in; each tick is a handful of
  // microseconds when there is nothing to do.
  setInterval(() => pump(64), 100);
})().catch((e) => {
  console.error("[SS Ext] Lua LSP worker failed to start:", e);
  self.postMessage({ __ssextLuaLspFailed: String((e && e.message) || e) });
});
