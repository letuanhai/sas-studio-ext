/**
 * SAS Studio UX fixes - extension-injected (formerly a Tampermonkey userscript).
 *
 * Injected into the page's MAIN world by sw.js (on tabs.onUpdated for SASStudio URLs,
 * and on-demand by the popup before running an action). Idempotent - a second
 * injection is a no-op because of the `window.__ssf` guard below.
 *
 * Exposes `window.__ssf = { init(settings), run(name) }`:
 * - `init(settings)` applies enabled patches and binds hotkeys once .dijitTreeNode
 *   appears. Guarded against double-call.
 * - `run(name)` invokes a single named action on demand (used by the popup).
 *
 * `settings = { fixes: {name: bool}, hotkeys: {name: keymap|null} }` - missing
 * entries default to enabled / the metadata default hotkey (from tools-meta.js's
 * SSF_TOOLS, which must be loaded first). `hotkeys[name] === null` means
 * explicitly unbound.
 *
 * /// <reference path="typedefs.js" />
 */
(function () {
  "use strict";

  if (window.__ssf) return;

  // ==========================================================================
  // Helpers (unchanged behavior from the userscript)
  // ==========================================================================

  // https://stackoverflow.com/a/61511955
  function waitForElm(selector) {
    return new Promise((resolve) => {
      if (document.querySelector(selector)) {
        return resolve(document.querySelector(selector));
      }

      const observer = new MutationObserver((mutations) => {
        if (document.querySelector(selector)) {
          observer.disconnect();
          resolve(document.querySelector(selector));
        }
      });

      // If you get "parameter 1 is not of type 'Node'" error, see https://stackoverflow.com/a/77855838/492336
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    });
  }

  /**
   * Bind keymap to execute callback
   *
   * @param {CallableFunction} callback
   * @param {KeyMap} keyMap
   */
  function bindKey(callback, keyMap) {
    window.addEventListener(
      "keydown",
      (event) => {
        // Case-insensitive key compare - fixes a latent bug where e.g. {key:'O'}
        // never matched the event's lowercase 'o'.
        if (
          String(event.key).toLowerCase() !== String(keyMap.key).toLowerCase() ||
          Boolean(keyMap.altKey) !== event.altKey ||
          Boolean(keyMap.ctrlKey) !== event.ctrlKey ||
          Boolean(keyMap.metaKey) !== event.metaKey ||
          Boolean(keyMap.shiftKey) !== event.shiftKey
        )
          return;
        event.preventDefault();
        event.stopPropagation();

        callback();
      },
      true,
    );
  }

  function resetTabLayout(tab) {
    const currentTab = tab.editor;
    currentTab?.bottomTabs?.getChildren().forEach((pane) => currentTab.dropTab("", "", pane, currentTab.bottomTabs));
    currentTab?.rightTabs?.getChildren().forEach((pane) => currentTab.dropTab("", "", pane, currentTab.rightTabs));
    currentTab.editContentPane.getParent().selectChild(currentTab.editContentPane);
    currentTab.editor.focus();
  }

  /**
   * select the nth next tab
   * @param {number=1} n number of tab to jump forward, default to 1
   */
  function selectNextTab(n) {
    const tabs = window.appDMS.tabs;
    const allTabs = tabs.getAllTabObjects();
    const currentTab = tabs.getFocusedTab();
    const currentTabId = currentTab.id ?? currentTab.title;
    const currentTabIndex = allTabs.findIndex((t) => (t.id ?? t.title) === currentTabId);
    const nextTabIndex = ((currentTabIndex + (n ?? 1)) % allTabs.length + allTabs.length) % allTabs.length; // wrap array index around
    tabs.selectTab(allTabs[nextTabIndex]);
    tabs.getFocusedTab().editor?.editor?.focus?.();
  }

  /**
   * select the nth next pane in current tab
   * @param {number=1} n number of pane to jump forward, default to 1
   */
  function selectNextPane(n) {
    const editorTab = window.appDMS.tabs.getFocusedTab().editor;
    const allPanes = [];
    [editorTab.sasSuiteTabContainer, editorTab.rightTabs, editorTab.bottomTabs].forEach((container) => {
      container?.getChildren().forEach((pane) => allPanes.push([pane, container]));
    });
    const currentPaneIndex = allPanes.findIndex((i) => i[0].type === editorTab.selectedTab.type);
    const nextPaneIndex = ((currentPaneIndex + (n ?? 1)) % allPanes.length + allPanes.length) % allPanes.length; // wrap array index around
    allPanes[nextPaneIndex][1].selectChild(allPanes[nextPaneIndex][0]);
  }

  // Reload content of the currently focused file in SAS Studio
  // The Ace text-viewer entry (from editor-swap.js's __ssExt._textViewers) for a
  // tab, or null. Lets tab-scoped actions treat a "View as text" tab like an editor.
  function getTextViewerForTab(tab) {
    const viewers = window.__ssExt && window.__ssExt._textViewers;
    const tabHolder = tab && tab.tab && tab.tab.tabHolder;
    if (!viewers || !tabHolder) return null;
    return viewers.find((e) => e.tabHolder === tabHolder) || null;
  }

  function reloadCurrentFile() {
    const currentTab = window.appDMS.tabs.getFocusedTab();

    // Text viewer tab: re-fetch from the server exactly as its Refresh button does
    // (onTextRefresh with the file item the button was wired with). The mirror
    // clears the dirty state when the fresh content lands.
    const viewer = getTextViewerForTab(currentTab);
    if (viewer) {
      window.appDMS.onTextRefresh(viewer.item);
      return;
    }

    const currentTabEditor = currentTab.editor;
    const tabContainer = currentTab.tab;

    const isFtp = (currentTab.id && 0 == currentTab.id.indexOf("ftpShortcuts")) || "ftprefs" == currentTab.storageType;

    let currentTabType = "workspace";

    if (isFtp) {
      currentTabType = "ftprefs/open";
      if (currentTab.fileShortcutName) currentTabType = "ftpfilerefs/open";
    }

    let encodedFilePath, fileUrl;

    if (
      !currentTab.uriParent ||
      "undefined" == currentTab.uriParent ||
      "" == currentTab.uriParent ||
      "folderShortcutItem" == currentTab.type
    ) {
      encodedFilePath = encodeValue(currentTab.uri, isFtp);
      if (isFtp && currentTab.fileShortcutName) encodedFilePath = encodeValue(currentTab.fileShortcutName, true);
      fileUrl = appDMS.baseURL + "/sasexec/sessions/" + appDMS.sessionId + "/" + currentTabType + "/" + encodedFilePath;
    } else {
      encodedFilePath = encodeValue(currentTab.name, isFtp);
      if (isFtp && currentTab.fileShortcutName) encodedFilePath = encodeValue(currentTab.fileShortcutName, isFtp);
      fileUrl =
        appDMS.baseURL +
        "/sasexec/sessions/" +
        appDMS.sessionId +
        "/" +
        currentTabType +
        "/" +
        encodeValue(currentTab.uriParent, isFtp) +
        "/" +
        encodedFilePath;
    }

    uname = currentTab.name.toLowerCase();
    var fileType = this.getFileType(currentTab);

    if (
      !currentTab.ct &&
      this.optionPreferencesGeneral &&
      this.optionPreferencesGeneral.defaultTextEncoding &&
      "UTF-8" != this.optionPreferencesGeneral.defaultTextEncoding
    ) {
      currentTab.ct = "ct\x3dtext/plain;charset\x3d" + this.optionPreferencesGeneral.defaultTextEncoding;
      currentTab.encoding = this.optionPreferencesGeneral.defaultTextEncoding;
    }

    if (currentTab.ct) {
      fileUrl += "?" + currentTab.ct;
      if ("undefined" !== typeof currentTab.asciiEbcdicConversionRequired && true == currentTab.asciiEbcdicConversionRequired)
        fileUrl += "\x26asciiEbcdicConversionRequired\x3dtrue";
    } else {
      if ("undefined" !== typeof currentTab.asciiEbcdicConversionRequired && true == currentTab.asciiEbcdicConversionRequired)
        fileUrl += "?asciiEbcdicConversionRequired\x3dtrue";
    }

    dojo.xhrGet({
      url: fileUrl,
      sync: false,
      preventCache: true,
      handleAs: "text",
      load: dojo.hitch(currentTabEditor, function (data, ioargs) {
        this.readingProgressCount--;
        if (this.readingProgress && 0 == this.readingProgressCount) this.readingProgress.hide();

        var e = 10;

        window.MSCompatibleInfo && (e = 3);

        if (data.length > 1048576 * e) {
          if (true == appDMS.loaded) {
            e = appDMS.resourceBundle.programTooLargeQuestion.replaceAll("${0}", e);

            this.bigProgramDecisionDialog = appDMS.dialogs.postDecisionDialog(
              e,
              null,
              {
                label: appDMS.resourceBundle.yes,
                callback: dojo.hitch(this, function () {
                  this.bigProgramDecisionDialog.hide();
                  if ("CPK" == fileType) {
                    this.eatChangeEvent = true;
                    this.setPackage(data);
                  } else {
                    this.eatChangeEvent = true;
                    this.editor.setText(data);
                  }
                  // Reloaded content is the clean baseline: drop the dirty marker
                  // and disable Save.
                  this.resetSaveState && this.resetSaveState();
                }),
                primary: false,
              },
              {
                label: appDMS.resourceBundle.noLabel,
                callback: dojo.hitch(this, function () {
                  this.bigProgramDecisionDialog.hide();
                  this.targetComponent.getParent() && tabContainer.getParent().removeChild(this.targetComponent);
                }),
                primary: true,
              },
            );
          } else {
            this.targetComponent.getParent() && tabContainer.getParent().removeChild(this.targetComponent);
          }
        } else {
          if ("CPK" == fileType) {
            this.eatChangeEvent = true;
            this.setPackage(data);
          } else {
            this.eatChangeEvent = true;
            this.editor.setText(data);
          }
          // Reloaded content is the clean baseline: drop the dirty marker and
          // disable Save.
          this.resetSaveState && this.resetSaveState();
        }
      }),
      error: dojo.hitch(currentTabEditor, function (error, ioargs) {
        this.readingProgressCount--;
        this.readingProgress && 0 == this.readingProgressCount && this.readingProgress.hide();
        if (appDMS.loaded)
          try {
            dojoAlert(error.response.xhr.getResponseHeader("Exception"));
          } catch (e) {}
        this.targetComponent.getParent() && tabContainer.getParent().removeChild(this.targetComponent);
      }),
    });
  }

  function closeCurrentTab() {
    const tabs = window.appDMS.tabs;
    tabs.closeTab(tabs.getFocusedTab());
  }

  /**
   * Open the target item in a new tab
   * @param {SASStudioTabItem} targetItem item to open
   */
  function openItem(targetItem) {
    const action =
      targetItem.type === "DATA"
        ? "TableOpen"
        : targetItem.fileType === "TXT"
          ? "FileOpenWithTextViewer"
          : targetItem.fileType === "EXT"
            ? "FileOpenWithExternalProgram"
            : "FileOpen";
    window.appDMS.handleWebOneEvent(action, targetItem);
  }

  function reopenLastClosedTab() {
    openItem(window.__ssfClosedTabs.pop());
  }

  /**
   * Show a notification popup at the top left
   * @param {Object} options - Options
   * @param {string} options.message - Message to display
   * @param {boolean=} options.isError - Whether this is an error notification
   * @param {number=} options.duration - Duration in milliseconds before auto-close (default 5000)
   */
  function showNotification(options) {
    const notification = document.createElement("div");
    notification.style.cssText = `
            position: fixed;
            top: 10px;
            left: 10px;
            background: ${options.isError ? "#792525ff" : "#24551fff"};
            color: white;
            border-radius: 4px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 100000;
            max-width: 50%;
            min-width: 200px;
            font-family: sans-serif;
            font-size: 14px;
            line-height: 1.4;
            overflow: hidden;
        `;

    // Content wrapper
    const contentWrapper = document.createElement("div");
    contentWrapper.style.cssText = `
            padding: 12px 16px;
            display: flex;
            align-items: flex-start;
            gap: 12px;
        `;
    notification.appendChild(contentWrapper);

    // Close button (on the left)
    const closeBtn = document.createElement("button");
    closeBtn.innerHTML = "&times;";
    closeBtn.style.cssText = `
            background: transparent;
            border: none;
            color: white;
            font-size: 24px;
            line-height: 1;
            cursor: pointer;
            padding: 0;
            width: 24px;
            height: 24px;
            flex-shrink: 0;
            order: -1;
            border-radius: 3px;
            transition: background 0.2s ease;
        `;
    closeBtn.onclick = () => {
      notification.remove();
      if (autoCloseTimer) clearTimeout(autoCloseTimer);
      if (progressAnimation) cancelAnimationFrame(progressAnimation);
    };

    // Hover effect for close button
    closeBtn.addEventListener("mouseenter", () => {
      closeBtn.style.background = "rgba(255, 255, 255, 0.2)";
    });
    closeBtn.addEventListener("mouseleave", () => {
      closeBtn.style.background = "transparent";
    });

    contentWrapper.appendChild(closeBtn);

    // Message content
    const messageEl = document.createElement("div");
    messageEl.style.cssText = `
            flex: 1;
            white-space: pre-wrap;
            word-break: break-all;
        `;
    messageEl.textContent = options.message;
    contentWrapper.appendChild(messageEl);

    // Progress bar
    const progressBar = document.createElement("div");
    progressBar.style.cssText = `
            height: 3px;
            background: rgba(255, 255, 255, 0.3);
            width: 100%;
        `;

    const progressFill = document.createElement("div");
    progressFill.style.cssText = `
            height: 100%;
            background: rgba(255, 255, 255, 0.8);
            width: 100%;
            transition: width 0.1s linear;
        `;
    progressBar.appendChild(progressFill);
    notification.appendChild(progressBar);

    // Timer management
    const timerDuration = options.duration || 5000;
    let totalElapsed = 0; // Total time elapsed across pauses
    let lastStartTime = Date.now();
    let autoCloseTimer = null;
    let progressAnimation = null;
    let isPaused = false;

    function updateProgress() {
      if (!isPaused) {
        const currentElapsed = Date.now() - lastStartTime;
        const totalTime = totalElapsed + currentElapsed;
        const progress = Math.max(0, 1 - totalTime / timerDuration);
        progressFill.style.width = progress * 100 + "%";

        if (progress > 0) {
          progressAnimation = requestAnimationFrame(updateProgress);
        }
      }
    }

    function startTimer() {
      const remainingTime = timerDuration - totalElapsed;
      lastStartTime = Date.now();

      autoCloseTimer = setTimeout(() => {
        notification.remove();
        if (progressAnimation) cancelAnimationFrame(progressAnimation);
      }, remainingTime);

      updateProgress();
    }

    function pauseTimer() {
      if (autoCloseTimer) {
        clearTimeout(autoCloseTimer);
        autoCloseTimer = null;
      }
      if (progressAnimation) {
        cancelAnimationFrame(progressAnimation);
        progressAnimation = null;
      }

      // Add elapsed time since last start to total
      totalElapsed += Date.now() - lastStartTime;
      isPaused = true;
    }

    function resumeTimer() {
      isPaused = false;
      startTimer();
    }

    // Pause/resume on hover
    notification.addEventListener("mouseenter", pauseTimer);
    notification.addEventListener("mouseleave", resumeTimer);

    document.body.appendChild(notification);
    startTimer();
  }

  /**
   * Show an input dialog to get user input
   * @param {string} options.title - Dialog title
   * @param {string} options.message - Dialog message/prompt
   * @param {string=} options.placeholder - Input placeholder text
   * @param {string=} options.inputName - Name attribute for browser autocomplete
   * @param {Function} callback - Callback function(value) called with user input
   */
  function showInputDialog(options, callback) {
    const dialog = document.createElement("dialog");
    dialog.style.cssText = `
            border: 2px solid #025b9b;
            border-radius: 4px;
            padding: 0;
            min-width: 500px;
            box-shadow: 0 4px 16px rgba(0,0,0,0.3);
        `;

    // Title bar
    const titleBar = document.createElement("div");
    titleBar.style.cssText = `
            background: #025b9b;
            color: white;
            padding: 10px 15px;
            font-weight: bold;
            font-size: 14px;
        `;
    titleBar.textContent = options.title;
    dialog.appendChild(titleBar);

    // Content
    const content = document.createElement("div");
    content.style.cssText = "padding: 15px;";

    // Message
    const messageEl = document.createElement("div");
    messageEl.style.cssText = `
            margin-bottom: 12px;
            white-space: pre-line;
            line-height: 1.4;
            color: #333;
        `;
    messageEl.textContent = options.message;
    content.appendChild(messageEl);

    // Input field with browser autocomplete
    const inputEl = document.createElement("input");
    inputEl.type = "text";
    inputEl.autocomplete = "on";
    if (options.inputName) {
      inputEl.name = options.inputName;
    }
    inputEl.style.cssText = `
            width: 100%;
            padding: 8px;
            box-sizing: border-box;
            border: 1px solid #ccc;
            border-radius: 3px;
            font-size: 13px;
            margin-bottom: 15px;
        `;
    if (options.placeholder) {
      inputEl.placeholder = options.placeholder;
    }
    content.appendChild(inputEl);

    // Buttons
    const buttonContainer = document.createElement("div");
    buttonContainer.style.cssText = "text-align: right;";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = `
            padding: 6px 16px;
            margin-left: 8px;
            border: 1px solid #ccc;
            border-radius: 3px;
            background: #f5f5f5;
            cursor: pointer;
        `;
    cancelBtn.onclick = () => {
      dialog.close();
      dialog.remove();
    };

    const okBtn = document.createElement("button");
    okBtn.textContent = "OK";
    okBtn.style.cssText = `
            padding: 6px 16px;
            margin-left: 8px;
            border: 1px solid #025b9b;
            border-radius: 3px;
            background: #025b9b;
            color: white;
            cursor: pointer;
        `;
    okBtn.onclick = () => {
      const value = inputEl.value.trim();
      if (value) {
        dialog.close();
        dialog.remove();
        callback(value);
      }
    };

    buttonContainer.appendChild(cancelBtn);
    buttonContainer.appendChild(okBtn);
    content.appendChild(buttonContainer);

    dialog.appendChild(content);

    // Handle Enter and Escape keys
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        okBtn.onclick();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelBtn.onclick();
      }
    });

    // Close on backdrop click
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) {
        cancelBtn.onclick();
      }
    });

    document.body.appendChild(dialog);
    dialog.showModal();
    inputEl.focus();
  }

  // Open an item based on input from the user
  function openUserInputTarget() {
    showInputDialog(
      {
        title: "Open Target Path",
        message: `Enter target path to open.
Add a prefix to the path for different option:
- 'tbl:' followed by a table identifier to open a table from library
- 'txt:' to open a file as text
- 'ext:' to download a file to open in external programs`,
        placeholder: "/path/to/file.sas",
        inputName: "ssf-open-path",
      },
      function (userInput) {
        if (!userInput) return;

        /** @type {SASStudioTabItem} */
        const targetItem = {
          uri: resolveFilePath(userInput),
          name: userInput.split("/").splice(-1)[0],
          type: "FILE",
        };
        if (userInput.startsWith("tbl:")) {
          let tablePath = userInput.slice(4).replace(".", "/").trim();
          if (!/^[A-Z]/.test(tablePath)) tablePath = tablePath.toUpperCase();
          targetItem.type = "DATA";
          targetItem.uri = "libraries~" + tablePath;
          targetItem.library = tablePath.split("/")[0];
          targetItem.name = tablePath.split("/").splice(-1)[0];
        } else if (userInput.startsWith("txt:")) {
          targetItem.fileType = "TXT";
          targetItem.uri = resolveFilePath(userInput.slice(4));
        } else if (userInput.startsWith("ext:")) {
          targetItem.fileType = "EXT";
          targetItem.uri = resolveFilePath(userInput.slice(4));
        }
        openItem(targetItem);
      },
    );
  }

  function createNewFile() {
    window.appDMS.onNewProgram();
  }

  // Poll for the Save As dialog to actually be open. postSaveAsDialog lazily
  // requires the dialog module the first time it's used, and even once loaded
  // the dialog only shows itself after a setTimeout, so it's never ready
  // synchronously right after triggering saveFileAs().
  function waitForSaveAsDialog(timeoutMs) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      (function poll() {
        const saveAsDialog = window.appDMS.dialogs.saveAsDialog;
        if (saveAsDialog && saveAsDialog.dialog.open) return resolve(saveAsDialog);
        if (Date.now() - start > (timeoutMs ?? 3000)) return reject(new Error("Save As dialog did not open"));
        setTimeout(poll, 50);
      })();
    });
  }

  // Trigger SAS Studio's own Save As flow for the currently focused editor, fill in
  // the destination tree + filename from a typed absolute path instead of navigating
  // the tree by hand, then complete the save exactly as clicking the dialog's Save
  // button would - so tab rename/uri update/dirty-clearing etc. all go through SAS
  // Studio's own code, not a reimplementation of it.
  function saveFocusedFileAtPath(targetPath) {
    const editor = window.appDMS.tabs.getFocusedTab()?.editor;
    if (!editor || typeof editor.saveFileAs !== "function") {
      showNotification({ message: "No saveable file is currently focused", isError: true });
      return;
    }
    const resolved = resolveFilePath(targetPath);
    const dirPath = resolved.split("/").slice(0, -1).join("/");
    const fileName = resolved.split("/").slice(-1)[0];

    editor.saveFileAs(false);
    return waitForSaveAsDialog()
      .then((saveAsDialog) =>
        scrollTreeToPath(dirPath, "destination").then(() => {
          saveAsDialog._onDestTreeClick(saveAsDialog.tree);
          saveAsDialog.fileNameTextBox.set("value", fileName);
          saveAsDialog.okButton.onClick();
        }),
      )
      .catch((err) => showNotification({ message: err.message, isError: true }));
  }

  function saveFileAtPath() {
    showInputDialog(
      {
        title: "Save File At Path",
        message: "Enter the absolute path (including file name) to save to.",
        placeholder: "/path/to/file.sas",
        inputName: "ssf-saveas-path",
      },
      function (userInput) {
        if (!userInput) return;
        saveFocusedFileAtPath(userInput);
      },
    );
  }

  function runCurrentProgram() {
    const editor = window.appDMS.tabs.getFocusedTab()?.editor;
    if (!editor || typeof editor.submitHandler !== "function") {
      showNotification({ message: "No runnable SAS program is currently focused", isError: true });
      return;
    }
    // submitHandler runs the selection if there is one, else the whole program
    // (DMSEditor.js:6551), and honors the single-run/minimize guards since it's
    // the prototype-wrapped method. No event arg needed (setPreventDefault no-ops).
    editor.submitHandler();
  }

  function scrollTreeToSelectedNode(targetTree) {
    const tree = targetTree ?? getCurrentTargetTree();
    selectTreePane(tree.id.split(".")[0]);
    const targetNode = tree.get("selectedNode")?.labelNode;
    if (targetNode?.scrollIntoViewIfNeeded) {
      targetNode.scrollIntoViewIfNeeded();
    } else {
      targetNode.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  function scrollDestinationTreeToProjectSelectedNode() {
    const uri = window.dijit.byId(`projects.tree`).get("selectedNode")?.item?.uri;
    if (!uri) {
      showNotification({ message: "No node selected in the file tree", isError: true });
      return;
    }
    scrollTreeToPath(uri, "destination");
  }

  function collapseCurrentTree() {
    getCurrentTargetTree()?.collapseAll();
  }

  /**
   * Scroll the file tree to the provided absolute path on the server
   * @param {String} targetPath target path
   * @param {String?} targetTreeId target tree ('projects' or 'destination')
   * @returns {Promise} a promise that is fulfilled when the tree finished scrolling
   */
  async function scrollTreeToPath(targetPath, targetTreeId) {
    if (!targetPath) return;
    const treeId = targetTreeId ?? (targetPath.startsWith("libraries") ? "library" : "projects");
    const tree = window.dijit.byId(`${treeId}.tree`);

    if (treeId === "library") targetPath = targetPath.replace(/[.~]/g, "/");

    // dojo provide tree.set('path',...) for this purpose but it does not work
    // => because DMSProject modified the method ._expandNode(), making it return undefined instead of a Promise
    // DMSProject backup the original method as ._expandNodeStash() but sometimes it messes up, likely during refreshes
    // Create a version of the original method for our own usage
    const expandNodeOrig = window.dijit.Tree.prototype._expandNode.bind(tree);

    function expandRecursively(node, path) {
      return expandNodeOrig(node).then(() => {
        for (const child of node.getChildren()) {
          const childUri = treeId === "library" ? (child.item.uri ?? "libraries").replace(/[.~]/g, "/") : child.item.uri;
          const isTarget = childUri === path;
          const isAncestor = path.startsWith(childUri + "/");
          if (!(isTarget || isAncestor)) continue;
          // Select current child node
          tree.set("selectedNode", child);
          if (isAncestor) return expandRecursively(child, path);
        }
      });
    }
    return expandRecursively(tree.rootNode, targetPath).then(() => {
      scrollTreeToSelectedNode(tree);
    });
  }

  function selectTreePane(targetTreeId) {
    const paneId = `${targetTreeId}Pane`;
    const accContainer = window.dijit.byId("accContainer");
    const targetPane = accContainer.getChildren().filter((p) => p.id === paneId)?.[0];
    if (targetPane) accContainer.selectChild(targetPane);
  }

  /**
   * Resolve path to absolute path on SAS server
   *
   * @param {String} inPath input path
   * @returns {String}
   */
  function resolveFilePath(inPath) {
    const rootPath = window.dijit
      .byId("projects.tree")
      .rootNode.getChildren()
      .filter((node) => node.item.uri != "_folderShortcutsRoot_")[0].item.uri;
    // Don't trim path because there can be spaces in file/folder name
    // Remove trailing slashes at the end
    let outPath = inPath.match(/(.+?)(?:\/*)$/)[1];
    if (!outPath.startsWith("/")) outPath = "/" + outPath;
    if (!outPath.startsWith(rootPath)) outPath = rootPath + outPath;
    return outPath;
  }

  /**
   * Get most likely target tree, based on which trees are currently visible,
   * fallback to projects.tree
   */
  function getCurrentTargetTree(treeIds, defaultTreeId) {
    const allTreeIds = treeIds ?? ["destination", "library", "projects"];
    const targetTreeId = allTreeIds.filter((t) => window.dijit.byId(`${t}.tree`)?.domNode?.checkVisibility())?.[0] ?? (defaultTreeId ?? "projects");
    return window.dijit.byId(`${targetTreeId}.tree`);
  }

  /** Cleanup objects not properly destroyed in dijit registry */
  function cleanUpDijitRegistry() {
    const registry = window.dijit.registry;
    const hashTable = registry._hash;
    // ToolbarSeparator widgets created as part of DMSQuery but the id has been modified
    //  after creation, so _WigetBase.destroy() did not work properly
    const keysToClean = ["tblToolbarSeparator", "tblToolbarSeparator1", "tblToolbarSeparator2"];
    // hashTable id is the original widget id when created
    for (let id in hashTable) {
      // Check against widget object's current id
      if (!keysToClean.includes(hashTable[id].id)) continue;
      // Widgets without domNode are destroyed using original id
      if (!hashTable[id].domNode) registry.remove(id);
    }
  }

  // ==========================================================================
  // Actions - one-shot commands (popup button + optional hotkey)
  // ==========================================================================
  const ACTIONS = {
    reloadCurrentFile: { fn: () => reloadCurrentFile.call(window.appDMS) },
    createNewFile: { fn: createNewFile },
    openUserInputTarget: { fn: openUserInputTarget },
    saveFileAtPath: { fn: saveFileAtPath },
    runCurrentProgram: { fn: runCurrentProgram },
    scrollTreeToSelectedNode: { fn: () => scrollTreeToSelectedNode() },
    scrollDestinationTreeToProjectSelectedNode: { fn: scrollDestinationTreeToProjectSelectedNode },
    collapseCurrentTree: { fn: collapseCurrentTree },
    closeCurrentTab: { fn: closeCurrentTab },
    reopenClosedTab: {
      fn: reopenLastClosedTab,
      // One-time setup: track closed FILE/DATA/IMPORTTOOL tabs so they can be
      // reopened later, regardless of whether the action has ever been invoked.
      setup: function () {
        if (window.__ssfClosedTabs) return;
        window.__ssfClosedTabs = [];
        const tabs = window.appDMS.tabs;
        tabs._closeTabOrig = tabs.closeTab;
        tabs.closeTab = function (tab) {
          if (["FILE", "DATA", "IMPORTTOOL"].includes(tab.type)) {
            const closedTab = {};
            ["name", "uri", "type", "fileType", "library"].forEach((prop) => {
              closedTab[prop] = tab[prop];
            });
            window.__ssfClosedTabs.push(closedTab);
          }
          return tabs._closeTabOrig.call(this, tab);
        };
      },
    },
    openLogInNewTab: {
      fn: function () {
        const logURL = window.appDMS.tabs.getFocusedTab().editor.logURL;
        logURL ? window.open(logURL, "_blank") : alert("No logURL to open!");
      },
    },
    selectNextTab: { fn: () => selectNextTab() },
    selectPreviousTab: { fn: () => selectNextTab(-1) },
    copyCurrentTabUri: {
      fn: function () {
        const uri = window.appDMS.tabs.getFocusedTab()?.uri;
        if (uri) {
          try {
            navigator.clipboard.writeText(uri).then(() => {
              showNotification({ message: `Copied to clipboard:\n${uri}` });
            });
          } catch {
            showNotification({
              message: `Failed to copy to clipboard. Please copy manually:\n${uri}`,
              isError: true,
              duration: 10000,
            });
          }
        }
      },
    },
    resetLayoutCurrentTab: { fn: () => resetTabLayout(window.appDMS.tabs.getFocusedTab()) },
    resetLayoutAllTabs: {
      fn: function () {
        window.appDMS.tabs.getAllTabObjects().forEach((tab) => resetTabLayout(tab));
      },
    },
    selectNextPane: { fn: () => selectNextPane() },
    selectPreviousPane: { fn: () => selectNextPane(-1) },
    focusCodeEditor: {
      fn: function () {
        const tab = window.appDMS.tabs.getFocusedTab();
        // Text viewer tab: focus its Ace overlay directly.
        const viewer = getTextViewerForTab(tab);
        if (viewer) {
          viewer.adapter.focus();
          return;
        }
        const currentTab = tab?.editor;
        if (!currentTab) return;
        currentTab.editContentPane.getParent().selectChild(currentTab.editContentPane);
        currentTab.editor.focus();
      },
    },
    commandPalette: {
      // Global in-page hotkey/action: works even when the Ace editor replacement
      // isn't active and nothing is focused. editor-swap.js is pre-injected (with
      // libPath/snippets already set) by sw.js's onUpdated handler, so this no-arg
      // call just needs window.__ssExt to exist.
      fn: () => window.__ssExt && window.__ssExt.commandPalette && window.__ssExt.commandPalette(),
    },
    // browse_ss prompts, same no-arg pattern as commandPalette (libPath already
    // seeded on the pre-injected __ssExt). Also reachable via the (unbound) chrome
    // commands in manifest.json and, when an editor is focused, the palette.
    browseFiles: {
      fn: () => window.__ssExt && window.__ssExt.browse && window.__ssExt.browse("files"),
    },
    browseLibrary: {
      fn: () => window.__ssExt && window.__ssExt.browse && window.__ssExt.browse("library"),
    },
    browseTabs: {
      fn: () => window.__ssExt && window.__ssExt.browse && window.__ssExt.browse("tabs"),
    },
    toggleEditor: {
      // Toggle the Ace editor replacement on/off (same as the popup's toggle
      // button). editor-swap.js is pre-injected with libPath seeded by sw.js on
      // page load, and toggle() posts the new state so the toolbar badge updates.
      fn: () => window.__ssExt && window.__ssExt.toggle && window.__ssExt.toggle(window.__ssExt.libPath),
    },
    toggleNativeMouse: {
      // Live "native mouse handling" toggle, no reload. When ON, a window-capture
      // handler stops PROPAGATION (never preventDefault) of the mouse-gesture
      // events, so no SAS Studio/dojo handler can hijack them: context menus stay
      // native, no dojo drag anywhere (trees, tabs, dialogs, splitters), and
      // nothing can preventDefault the mousedown that starts native text
      // selection. A CSS override lifts dojo's user-select:none. Clicks still
      // work - `click` events are synthesized from down+up regardless of
      // propagation - but drag-dependent and mousedown-dependent widgets
      // (including the Ace editor's mouse handling) are degraded until toggled
      // OFF; this is a temporary select-and-copy mode.
      fn: function () {
        if (window.__ssfNativeMouse) {
          const { handler, events } = window.__ssfNativeMouse;
          events.forEach((ev) => window.removeEventListener(ev, handler, true));
          window.__ssfNativeMouse = null;
          document.getElementById("ssf-native-mode-css")?.remove();
          showNotification({ message: "Native mouse handling OFF: SAS Studio drag & context menus restored" });
        } else {
          const handler = (e) => e.stopImmediatePropagation();
          const events = ["contextmenu", "mousedown", "mousemove", "selectstart", "dragstart"];
          events.forEach((ev) => window.addEventListener(ev, handler, true));
          const css = document.createElement("style");
          css.id = "ssf-native-mode-css";
          css.textContent = `body, body * {
            user-select: text !important;
            -webkit-user-select: text !important;
          }`;
          document.head.appendChild(css);
          window.__ssfNativeMouse = { handler, events };
          showNotification({
            message: "Native mouse handling ON: browser context menu and text selection everywhere, all SAS Studio drag disabled",
          });
        }
      },
    },
  };

  // ==========================================================================
  // Patches - passive behavior changes applied once at init, if enabled
  // ==========================================================================
  const PATCHES = {
    confirmDropFile: function () {
      // Ask user for confirmation before move file when drag-n-drop in SAS Studio

      const projects = window.appDMS.projects;
      function modifyPasteItem() {
        const o_pasteItem = projects.projectTreeStore.pasteItem;
        projects.projectTreeStore.pasteItem = function (...args) {
          // Continue if not drag and drop
          if (args[4] !== undefined) return o_pasteItem.call(this, ...args);

          const msg = `Confirm to move the ${args[0].isDirectory ? "folder" : "file"}\n${args[0].uri}\nto\n${args[2].uri}`;
          if (window.confirm(msg)) {
            return o_pasteItem.call(this, ...args);
          }
        };
      }

      const o_createProjectsModel = projects.createProjectsModel;
      projects.createProjectsModel = function () {
        o_createProjectsModel.call(this);
        // Modify again whenever the model is recreated (when refresh tree)
        modifyPasteItem();
      };
      // Modify current instance
      modifyPasteItem();
    },

    noFilterConfirmation: function () {
      // Set threshold to ask for table filter confirmation to max integer
      window.largeTableRows = Number.MAX_SAFE_INTEGER;
    },

    middleClickCloseTab: function () {
      const tabs = window.appDMS.tabs;

      function addCloseTabListener(t) {
        // Some tab shapes have no controlButton (unclosable/system tabs) - skip
        // them instead of letting one bad tab abort the whole patch.
        const btn = t && (t.tab ?? t).controlButton;
        if (!btn || !btn.domNode) return;
        // auxclick, not mouseup: on touch-capable devices dojo/touch.js's dojoClick
        // machinery swallows native middle-button mouseup at document level
        // (stopNativeEvents) and re-emits a synthetic mouseup with button=0.
        // auxclick is outside its suppression list and is the proper event for
        // non-primary-button clicks anyway.
        btn.domNode.addEventListener(
          "auxclick",
          (e) => {
            if (e.button === 1) {
              e.stopImmediatePropagation();
              e.preventDefault();
              tabs.closeTab(t);
            }
          },
          true,
        );
      }

      // Add listener for existing tabs
      tabs.getAllTabObjects()?.forEach((t) => {
        addCloseTabListener(t);
      });

      // Add listener for new tabs
      const _orig_newTab = tabs._newTab;
      tabs._newTab = function (t) {
        const newTab = _orig_newTab.call(this, t);
        addCloseTabListener(newTab);
        return newTab;
      };

      // Add listener when move tab between container
      const _orig_dropTab = tabs._dropTab;
      tabs._dropTab = function (dstLocation, tab, srcContainer) {
        const r = _orig_dropTab.call(this, dstLocation, tab, srcContainer);
        addCloseTabListener(tab);
        return r;
      };
    },

    projectsContextMenuCopyUri: function () {
      const projects = window.appDMS.projects;
      const _orig_populateProjectContextMenu = projects.populateProjectContextMenu;
      projects.populateProjectContextMenu = function () {
        const r = _orig_populateProjectContextMenu.apply(this);
        const copyUriMenuItem = new dijit.MenuItem({
          label: "Copy Path",
          onClick: function () {
            const selectedItemsUri = window.appDMS.projects.tree.get("selectedItems")?.map?.((i) => i.uri);
            if (selectedItemsUri) {
              const pathText = selectedItemsUri.join("\n");
              try {
                window.navigator.clipboard.writeText(pathText).then(() => {
                  showNotification({ message: `Copied to clipboard:\n${pathText}` });
                });
              } catch (error) {
                showNotification({
                  message: `Failed to copy to clipboard. Please copy manually:\n${pathText}`,
                  isError: true,
                  duration: 10000,
                });
              }
            }
          },
        });
        this.projectContextMenu.addChild(copyUriMenuItem, 6);
        return r;
      };
    },

    tabsContextMenuCopyUri: function () {
      const tabs = window.appDMS.tabs;
      const copyUriMenuItem = new dijit.MenuItem({
        label: "Copy Path",
        onClick: function () {
          const currentTargetUri = window.dijit.byNode(this.getParent().currentTarget)?.page?.tabObject?.uri;
          if (currentTargetUri) {
            try {
              window.navigator.clipboard.writeText(currentTargetUri).then(() => {
                showNotification({ message: `Copied to clipboard:\n${currentTargetUri}` });
              });
            } catch {
              showNotification({
                message: `Failed to copy to clipboard. Please copy manually:\n${currentTargetUri}`,
                isError: true,
                duration: 10000,
              });
            }
          }
        },
      });

      tabs.mainTabMenu.addChild(copyUriMenuItem, 0);

      const _orig_createTabsPopup = tabs.createTabsPopup;
      tabs.createTabsPopup = function (tabMenu) {
        const r = _orig_createTabsPopup.apply(this, tabMenu);
        tabMenu.addChild(copyUriMenuItem, 0);
        return r;
      };
    },

    keepAlive: function () {
      window.__keepAliveInterval = window.setInterval(window.sas_framework_updateTimeout, 600000);
    },

    maximizeEditor: function () {
      const o_setMaxView = window.appDMS.setMaxView;
      window.appDMS.setMaxView = function () {
        // Clean up abandonned objects in registry
        cleanUpDijitRegistry();
        o_setMaxView.call(this);
        document.getElementById("headContainer").style.height = 0;
        document.getElementById("studio_status_bar").style.height = 0;
        window.dispatchEvent(new Event("resize"));
      };
      const o_setRegularView = window.appDMS.setRegularView;
      window.appDMS.setRegularView = function () {
        // Clean up abandonned objects in registry
        cleanUpDijitRegistry();
        o_setRegularView.call(this);
        document.getElementById("headContainer").style.height = "40px";
        document.getElementById("studio_status_bar").style.height = "17.35px";
        window.dispatchEvent(new Event("resize"));
      };
    },

    minimizeBusyDialog: function () {
      // The run-progress dialog (DMSEditor.submitHandler ->
      // appDMS.dialogs.postBusyDialog) is a modal dijit Dialog whose shared
      // underlay singleton blocks the whole app until the run finishes. While
      // this patch is enabled (the options-page checkbox is the only config -
      // unchecked leaves SAS Studio untouched), the run dialog is
      // auto-minimized to the bottom-right corner the moment it appears, plus
      // a single-run guard so a second submit can't be started while one is
      // already in flight. Non-run busy dialogs (short-lived: "Reading file",
      // server switch, ...) keep their stock modal behavior.
      const dialogs = window.appDMS.dialogs;

      // In-page notification (top-left) - SAS Studio's own toaster truncates
      // longer messages. One element, re-used: a later message replaces the
      // text. Sticky rather than timed: it describes a state that's true
      // exactly as long as the run lasts, so it's cleared when the busy
      // dialog closes (and click-to-dismiss before that).
      function busyNotice(msg, warn) {
        let el = document.getElementById("ssf-busy-notice");
        if (!el) {
          el = document.createElement("div");
          el.id = "ssf-busy-notice";
          el.title = "Click to dismiss";
          el.style.cssText =
            "position:fixed;top:12px;left:12px;z-index:2000;max-width:420px;" +
            "padding:10px 14px;border-radius:4px;font:13px/1.4 sans-serif;color:#333;" +
            "box-shadow:0 2px 8px rgba(0,0,0,0.3);cursor:pointer;";
          el.addEventListener("click", () => el.remove());
          document.body.appendChild(el);
        }
        el.style.background = warn ? "#ffd54f" : "#e3f2fd";
        el.textContent = msg;
      }
      function clearBusyNotice() {
        const el = document.getElementById("ssf-busy-notice");
        if (el) el.remove();
      }

      // "A foreground run is in progress." Tracked via the run's own dialog
      // (postBusyDialog callers pass a cancel callback only on the submit
      // paths - DMSEditor.js:6569/6663), NOT via dialogs.busyDialog != null:
      // every run-end path tears down with submitDialog.hide(), never
      // hideBusyDialog(), so dialogs.busyDialog stays a stale non-null
      // reference after every completed run. dijit sets .open synchronously
      // in show()/hide(); destroy() sets _destroyed without flipping .open.
      function runActive() {
        const d = window.__ssfRunDialog;
        return !!(d && d.open && !d._destroyed);
      }

      // Lazily installed at minimize time, not patch-init time - a code tab
      // (and so a DMSEditor instance to grab the class off of) is only
      // guaranteed to exist once something has actually been submitted.
      function installSingleRunGuard() {
        if (window.__ssfSingleRunGuardInstalled) return;

        let DMSEditor = null;
        (window.appDMS.tabs.getAllTabObjects() || []).some((t) => {
          if (t.editor) {
            DMSEditor = t.editor.constructor;
            return true;
          }
          return false;
        });
        if (!DMSEditor) {
          console.warn("[SS Ext] minimizeBusyDialog: could not find DMSEditor class to patch");
          return;
        }

        window.__ssfSingleRunGuardInstalled = true;
        ["submitHandler", "interactiveSubmitHandler"].forEach((name) => {
          const orig = DMSEditor.prototype[name];
          if (typeof orig !== "function") return;
          DMSEditor.prototype[name] = function (...args) {
            if (runActive()) {
              busyNotice(
                "A program is already running - wait for it to finish before starting another.",
                true,
              );
              return;
            }
            return orig.apply(this, args);
          };
        });
      }

      // Disable every open tab's Run buttons while the run is in progress. The
      // prototype wrap above doesn't cover pre-existing tabs: their Run button
      // and F3 were wired with dojo.hitch(this, this.submitHandler) at tab
      // construction (DMSEditor.js:4234/5017), which captured the ORIGINAL
      // function - the wrap is never hit. But that original checks
      // `if (this.submitButton.get("disabled") == true) return;`
      // (DMSEditor.js:6502 - SAS Studio's own comment says it exists "to take
      // care of key 'F3'"), so disabling the button blocks both the click and
      // F3 with no re-wiring. Only buttons we actually disabled here get
      // re-enabled at run end - never ones the app disabled for its own
      // reasons (e.g. read-only tabs). backgroundSubmitButton is deliberately
      // left alone: background submits run in separate SAS sessions (their
      // hitch targets submitBackgroundHandler, an independent method the
      // prototype guard doesn't wrap either) and SAS Studio supports several
      // at once - only the foreground run is single-run.
      function disableRunButtons() {
        const disabled = [];
        (window.appDMS.tabs.getAllTabObjects() || []).forEach((t) => {
          const btn = t.editor && t.editor.submitButton;
          if (btn && !btn.get("disabled")) {
            btn.set("disabled", true);
            disabled.push(btn);
          }
        });
        return disabled;
      }

      function minimize(dialog, cancelCb) {
        installSingleRunGuard();

        // Re-enable at run end: success tears the dialog down via destroy()
        // (hideBusyDialog), the error path via submitDialog.hide() - wrap both
        // on the instance, run-once.
        const disabledButtons = disableRunButtons();
        let runTabNode = null; // the running tab's button, marked below
        let reenabled = false;
        function reenable() {
          if (reenabled) return;
          reenabled = true;
          disabledButtons.forEach((btn) => btn.set("disabled", false));
          restoreStatusBar();
          if (runTabNode) runTabNode.classList.remove("ssf-running");
        }
        ["hide", "destroy"].forEach((name) => {
          const orig = dialog[name].bind(dialog);
          dialog[name] = function (...args) {
            reenable();
            return orig(...args);
          };
        });

        // Release modality. DialogLevelManager.hide() pops this dialog off the
        // shared dialog stack and hides (or, if another dialog is still under
        // it, re-adjusts) the shared underlay singleton - exactly what would
        // happen on destroy(). Safe to call early: Dialog.prototype.destroy()
        // calls this same function again when the run actually finishes, and
        // its "dialog isn't the top of the stack anymore" branch is a no-op
        // for an entry that's already been removed (dijit/Dialog.js's
        // _DialogLevelManager.hide, #9944/#10705 out-of-order-removal path).
        dijit.Dialog._DialogLevelManager.hide(dialog);

        // Hide the dialog outright - no floating box. SAS already writes live
        // run status ("SAS Program running (DATASTEP running).") to the bottom
        // status-bar message; we just tint that bar amber and add a Cancel link
        // next to it, so the run is signalled without covering or blocking the
        // app. Neutralize dijit's re-centering so the hidden node doesn't
        // reappear on a viewport resize.
        dialog._position = function () {};
        dialog.domNode.style.display = "none";

        // Amber tint on the status bar + a Cancel link wired to the same
        // callback the dialog's own Cancel button used (postBusyDialog's _cb).
        const bar = document.getElementById("studio_status_bar");
        // !important - dijit's .statusBar rule sets the background !important,
        // so a plain inline style loses to it.
        if (bar) bar.style.setProperty("background", "#ffe9a8", "important");
        if (bar && cancelCb) {
          // Cancel floated to the right side of the bar, leaving SAS's own
          // status text on the left untouched.
          const link = document.createElement("a");
          link.id = "ssf-run-cancel";
          link.href = "#";
          link.textContent = "Cancel";
          link.style.cssText =
            "float:right;margin-right:12px;color:#0b5cab;font-weight:bold;cursor:pointer;text-decoration:underline;";
          link.onclick = function (e) {
            e.preventDefault();
            cancelCb();
          };
          bar.appendChild(link);
        }

        // Mark the running tab with an animated spinner icon + amber label so
        // you can see WHICH open script is executing. The run is initiated from
        // the focused code tab (Run button / F3 both require it active), so
        // that's the running one; cleared in reenable() at run end.
        injectRunStyle();
        const runTab = window.appDMS.tabs.getFocusedTab();
        const node =
          runTab && runTab.tab && runTab.tab.controlButton && runTab.tab.controlButton.domNode;
        if (node) {
          node.classList.add("ssf-running");
          runTabNode = node;
        }
      }

      function restoreStatusBar() {
        const bar = document.getElementById("studio_status_bar");
        if (bar) bar.style.removeProperty("background");
        const link = document.getElementById("ssf-run-cancel");
        if (link) link.remove();
      }

      // Spinner-icon + amber-label animation for the running tab, injected once.
      function injectRunStyle() {
        if (document.getElementById("ssf-run-style")) return;
        const st = document.createElement("style");
        st.id = "ssf-run-style";
        st.textContent =
          "@keyframes ssf-spin{to{transform:rotate(360deg)}}" +
          ".dijitTab.ssf-running .dijitTabButtonIcon{background-image:none!important;position:relative}" +
          ".dijitTab.ssf-running .dijitTabButtonIcon::after{content:'';position:absolute;left:1px;top:1px;" +
          "width:12px;height:12px;box-sizing:border-box;border:2px solid #c8a000;border-top-color:transparent;" +
          "border-radius:50%;animation:ssf-spin .7s linear infinite}" +
          ".dijitTab.ssf-running{background:#ffe9a8!important}";
        document.head.appendChild(st);
      }

      const o_postBusyDialog = dialogs.postBusyDialog;
      dialogs.postBusyDialog = function (...args) {
        const dialog = o_postBusyDialog.apply(this, args);
        try {
          // Any busy notice describes "while this run lasts" - clear it when
          // the dialog goes away (destroy() at run end, hide() on the error
          // path).
          ["hide", "destroy"].forEach((name) => {
            const orig = dialog[name].bind(dialog);
            dialog[name] = function (...a) {
              clearBusyNotice();
              return orig(...a);
            };
          });
          // Only the submit paths pass a cancel callback - that's what marks
          // this dialog as THE foreground-run dialog (runActive()), and only
          // that dialog is auto-minimized; other busy dialogs stay modal.
          if (args[1]) {
            window.__ssfRunDialog = dialog;
            minimize(dialog, args[1]);
          }
        } catch (e) {
          console.error("[SS Ext] minimizeBusyDialog: failed to auto-minimize:", e);
        }
        return dialog;
      };

      // "View file as text" (tree context menu, browse_ss Ctrl+Enter, or just
      // opening a .txt/.log/.lst) can't be allowed while a run is in progress.
      // Its open chain fires SYNCHRONOUS xhrs against the busy session (e.g.
      // getModifiedTime, AppDMS.js:3424, `sync: true` to /workspace/modified/),
      // which the server answers only at run end - freezing the entire JS
      // thread, not just showing a modal (that's also why a notice written
      // just before the sync call only paints after the run: the thread
      // blocks before the browser can render). So the block must sit at the
      // very entry of the chain: handleWebOneEvent, which every path goes
      // through - the tree context menu sends "FileOpenWithTextViewer"
      // (DMSProjects.js:1746), tree double-click sends "FileOpen"
      // (DMSProjects.js:3191), and browse_ss sends both (ext-browse_ss.js
      // openItemInSs). TXT/LOG/LST is exactly the text-view branch's type set
      // (AppDMS.js:3756-3764 vs 3797-3801); SAS-type files take the editor
      // branch (no sync xhr when the tree item carries modifiedDate, reading
      // dialog skipped in practice) and stay allowed - their tab fills in
      // when the run ends.
      function blocksTextViewWhileRunning(action, item) {
        if (!runActive() || !item) return false;
        if (action === "FileOpenWithTextViewer") return true;
        return (
          action === "FileOpen" &&
          ["TXT", "LOG", "LST"].indexOf(window.appDMS.getFileType(item)) !== -1
        );
      }
      const textViewBlockedMsg =
        "A program is running - viewing files as text is blocked until it finishes (SAS Studio's file reader would freeze the app).";
      const o_handleWebOneEvent = window.appDMS.handleWebOneEvent;
      window.appDMS.handleWebOneEvent = function (action, item, ...rest) {
        try {
          if (blocksTextViewWhileRunning(action, item)) {
            busyNotice(textViewBlockedMsg, true);
            return;
          }
        } catch (e) {
          console.error("[SS Ext] minimizeBusyDialog: text-view block check failed:", e);
        }
        return o_handleWebOneEvent.call(this, action, item, ...rest);
      };
      // Defense in depth for open paths that reach perspectiveFileOpen without
      // handleWebOneEvent - its own text branch (AppDMS.js:3921-3936) posts an
      // uncancelable "Reading file" modal that queues behind the busy session.
      const o_perspectiveFileOpen = window.appDMS.perspectiveFileOpen;
      window.appDMS.perspectiveFileOpen = function (item, target) {
        try {
          if (runActive() && item && ["TXT", "LOG", "LST"].indexOf(window.appDMS.getFileType(item)) !== -1) {
            busyNotice(textViewBlockedMsg, true);
            return;
          }
        } catch (e) {
          console.error("[SS Ext] minimizeBusyDialog: text-view block check failed:", e);
        }
        return o_perspectiveFileOpen.call(this, item, target);
      };

      // Session-bound requests (file open/save, dir listings - anything hitting
      // /sasexec/sessions/<id>/workspace/) fired while a program runs are queued
      // SERVER-side: the workspace session is single-threaded and answers them
      // only when the run finishes. With the dialog minimized that looks like a
      // hang (empty new tab), so post a status note when one is fired. All
      // dojo.xhrGet/Post/etc. delegate to dojo.xhr at call time, so one wrap
      // covers every request path.
      // ponytail: only /workspace/ URLs are matched - other session-bound
      // endpoints (if any) just won't get the note.
      let lastQueuedNote = 0;
      const o_xhr = dojo.xhr;
      dojo.xhr = function (method, xhrArgs, hasBody) {
        try {
          if (
            runActive() &&
            xhrArgs &&
            typeof xhrArgs.url === "string" &&
            xhrArgs.url.indexOf("/workspace/") !== -1 &&
            Date.now() - lastQueuedNote > 3000
          ) {
            lastQueuedNote = Date.now();
            busyNotice("A program is running - this request is queued until it finishes.", false);
          }
        } catch (e) {
          /* never break the request over a status note */
        }
        return o_xhr.call(this, method, xhrArgs, hasBody);
      };
    },
  };

  // ==========================================================================
  // Public API
  // ==========================================================================

  function getDefaultHotkey(name) {
    const meta = (window.SSF_TOOLS || []).find((t) => t.name === name);
    return meta ? meta.hotkey : undefined;
  }

  function init(settings) {
    if (window.__ssf._initialized) return;
    window.__ssf._initialized = true;

    settings = settings || {};
    const fixes = settings.fixes || {};
    const hotkeys = settings.hotkeys || {};

    waitForElm(".dijitTreeNode").then(() => {
      Object.keys(PATCHES).forEach((name) => {
        if (fixes[name] === false) return; // default: enabled
        try {
          PATCHES[name]();
        } catch (e) {
          console.error(`[SS Ext] patch "${name}" failed:`, e);
        }
      });

      Object.keys(ACTIONS).forEach((name) => {
        const action = ACTIONS[name];
        if (action.setup) {
          try {
            action.setup();
          } catch (e) {
            console.error(`[SS Ext] action setup "${name}" failed:`, e);
          }
        }

        const keymap = Object.prototype.hasOwnProperty.call(hotkeys, name) ? hotkeys[name] : getDefaultHotkey(name);
        if (keymap && keymap.key) {
          bindKey(() => run(name), keymap);
        }
      });
    });
  }

  function run(name) {
    const action = ACTIONS[name];
    if (!action) {
      console.warn(`[SS Ext] Unknown action: ${name}`);
      return;
    }
    try {
      action.fn();
    } catch (e) {
      console.error(`[SS Ext] action "${name}" failed:`, e);
    }
  }

  window.__ssf = { init, run, saveFocusedFileAtPath };
})();
