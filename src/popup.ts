const status = document.getElementById("popup-status")!;
const error = document.getElementById("popup-error")!;
const button = document.getElementById("open-panel") as HTMLButtonElement;
chrome.runtime
  .sendMessage({ type: "GET_STATE" })
  .then((response) => {
    if (!response?.ok) throw new Error(response?.error || "无法读取同步状态。");
    const { settings, sync } = response.data;
    status.textContent = !settings.endpoint
      ? "先连接 WebDAV，开启跨设备接力。"
      : sync.error
        ? "同步需要处理，打开面板查看详情。"
        : sync.dirty
          ? "本机快照等待同步。"
          : sync.lastSuccess
            ? "本机工作区已同步，随时接力。"
            : "等待首次同步。";
  })
  .catch((reason) => {
    status.textContent =
      reason instanceof Error ? reason.message : "暂时无法读取状态。";
  });
button.addEventListener("click", () => {
  // sidePanel.open must remain within the user's click gesture.
  chrome.windows
    .getCurrent()
    .then((window) => {
      if (window.id === undefined) throw new Error("无法识别当前窗口。");
      return chrome.sidePanel.open({ windowId: window.id });
    })
    .then(() => window.close())
    .catch((reason) => {
      error.textContent =
        reason instanceof Error ? reason.message : "无法打开侧边栏。";
      error.hidden = false;
    });
});

export {};
