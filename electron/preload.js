const { clipboard, contextBridge, desktopCapturer, ipcRenderer, screen } = require("electron");

contextBridge.exposeInMainWorld("bridge", {
  setWebrtcState: (state) => ipcRenderer.send("webrtc-state", state),
  getSessionInfo: () => ipcRenderer.invoke("get-session-info"),
  regenerateSession: () => ipcRenderer.invoke("regenerate-session"),
  quitApp: () => ipcRenderer.send("app-quit"),
  copyText: (text) => {
    if (typeof text !== "string") return;
    clipboard.writeText(text);
  },
  getDesktopSourceId: async () => {
    if (desktopCapturer && typeof desktopCapturer.getSources === "function") {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 },
      });
      if (!sources || sources.length === 0) throw new Error("no-screen-source");
      try {
        const primaryId = screen.getPrimaryDisplay().id?.toString();
        const match = sources.find((s) => s.display_id && s.display_id.toString() === primaryId);
        if (match) return match.id;
      } catch {}
      return sources[0].id;
    }
    return ipcRenderer.invoke("get-desktop-source-id");
  },
  generateLinkCode: () => ipcRenderer.invoke("generate-link-code"),
  checkLinkCode: (code) => ipcRenderer.invoke("check-link-code", code),
  getStoredAccount: () => ipcRenderer.invoke("get-stored-account"),
  setStoredAccount: (account) => ipcRenderer.invoke("set-stored-account", account),
  clearStoredAccount: () => ipcRenderer.invoke("clear-stored-account"),
  logout: (email) => ipcRenderer.invoke("logout", email),
  refreshPlan: (email) => ipcRenderer.invoke("refresh-plan", email),
  getUserStatus: () => ipcRenderer.invoke("get-user-status"),
  activateTrial: () => ipcRenderer.invoke("activate-trial"),
  getScreenSize: () => ipcRenderer.invoke("get-screen-size"),
  onSessionStatus: (handler) => {
    const listener = (_evt, payload) => handler(payload);
    ipcRenderer.on("session-status", listener);
    return () => ipcRenderer.removeListener("session-status", listener);
  },
  onWindowShown: (handler) => {
    const listener = () => handler();
    ipcRenderer.on("window-shown", listener);
    return () => ipcRenderer.removeListener("window-shown", listener);
  },
  injectInput: (payload) => ipcRenderer.send("inject-input", payload),
  runCommand: (command) => ipcRenderer.send("run-command", command),
  openDevTools: () => ipcRenderer.send("open-dev-tools"),
});
