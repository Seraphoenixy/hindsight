// Only scripts from this plugin's asset directory are allowed by Magpie's CSP.
// The host publishes process metadata there; commands use the options bridge.
(async () => {
  const element = (id) => document.getElementById(id);
  const status = element("status");
  const actions = ["start", "stop", "restart", "open"];
  let options;
  let port;
  let pending = null;
  let loading = false;
  const disable = () =>
    actions.forEach((action) => {
      element(action).disabled = true;
    });
  function render() {
    const state = window.hindsightProcessState;
    disable();
    if (!state || state.port !== port || Date.now() - state.checkedAt > 15000) {
      element("running").textContent = "状态未更新";
      status.textContent = "等待插件宿主更新状态。可点击“刷新状态”重新读取。";
      return;
    }
    element("running").textContent = state.running ? "运行中" : "已停止";
    element("running").dataset.running = String(state.running);
    element("profile").textContent = state.profile;
    element("port").textContent = String(state.port);
    element("address").textContent = state.url;
    element("daemon").textContent = state.daemonHealthy ? "在线" : "未就绪";
    element("checked").textContent = new Date(state.checkedAt).toLocaleTimeString();
    const operation = state.operation;
    if (
      pending &&
      operation &&
      operation.phase !== "running" &&
      (operation.id === pending || Number(operation.id.slice(0, 13)) > Number(pending.slice(0, 13)))
    )
      pending = null;
    const timedOut =
      pending &&
      Date.now() - Number(pending.slice(0, 13)) > 120000 &&
      operation?.phase !== "running";
    if (timedOut) {
      pending = null;
    }
    const busy = pending || operation?.phase === "running";
    if (busy) {
      status.textContent = "正在执行，请稍候…";
      return;
    }
    element("start").disabled = state.running;
    element("stop").disabled = !state.running;
    element("restart").disabled = !state.running;
    element("open").disabled = false;
    status.textContent = timedOut
      ? "操作未收到结果，请刷新状态后重试。"
      : operation?.message || "状态每 3 秒更新。";
  }
  function refresh() {
    if (loading) return;
    loading = true;
    const script = document.createElement("script");
    script.src = ".runtime/state.js?t=" + Date.now();
    script.onload = () => {
      loading = false;
      script.remove();
      render();
    };
    script.onerror = (event) => {
      // Keep a missing asset's error within this page, rather than Magpie's
      // global error boundary replacing the controls.
      event.stopPropagation();
      loading = false;
      script.remove();
      disable();
      element("running").textContent = "宿主不可用";
      status.textContent = "无法读取进程状态，请重新打开 Hindsight 插件页面。";
    };
    document.head.append(script);
  }
  try {
    await window.magpie.ready;
    const host = location.hostname;
    if (host && !["localhost", "127.0.0.1", "[::1]", "wails.localhost"].includes(host)) {
      throw new Error("请在运行 Hindsight 的本机 Magpie 窗口中管理进程");
    }
    options = await window.magpie.options.get();
    port = Number(options.port ?? 19077);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("端口配置无效");
    for (const action of actions) {
      element(action).addEventListener("click", async () => {
        disable();
        pending = Date.now() + "-" + Math.random().toString(36).slice(2, 12).padEnd(10, "0");
        status.textContent = "正在提交操作…";
        try {
          options = await window.magpie.options.get();
          await window.magpie.options.set({
            ...options,
            port,
            processRequest: { id: pending, action },
          });
          refresh();
        } catch (error) {
          pending = null;
          render();
          status.textContent = error.message;
        }
      });
    }
    element("refresh").addEventListener("click", refresh);
    refresh();
    setInterval(refresh, 3000);
  } catch (error) {
    disable();
    status.textContent = error.message;
  }
})();
