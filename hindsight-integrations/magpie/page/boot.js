// Only scripts from this plugin's asset directory are allowed by Magpie's CSP.
// The host publishes process metadata there; commands use the options bridge.
(async () => {
  const element = (id) => document.getElementById(id);
  const status = element("status");
  const actions = ["start", "stop", "restart", "open"];
  const daemonActions = {
    daemonStart: "daemon-start",
    daemonStop: "daemon-stop",
    daemonRestart: "daemon-restart",
  };
  const injectionActions = {
    injectionEnable: "injection-enable",
    injectionDisable: "injection-disable",
  };
  let options;
  let port;
  let pending = null;
  let loading = false;
  let llmTouched = false;
  let fastPollTimer = null;
  const scheduleFastPoll = () => {
    if (fastPollTimer) return;
    fastPollTimer = setTimeout(() => {
      fastPollTimer = null;
      refresh();
    }, 350);
  };
  const clearFastPoll = () => {
    if (!fastPollTimer) return;
    clearTimeout(fastPollTimer);
    fastPollTimer = null;
  };
  const setText = (id, text) => {
    const target = element(id);
    if (target) target.textContent = text;
  };
  const setDisabled = (id, value) => {
    const target = element(id);
    if (target) target.disabled = value;
  };
  const escapeHtml = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]
    );
  const disable = () => {
    [
      ...actions,
      ...Object.keys(daemonActions),
      ...Object.keys(injectionActions),
      "syncLlm",
    ].forEach((action) => {
      setDisabled(action, true);
    });
    const hostList = element("hostList");
    if (hostList && typeof hostList.querySelectorAll === "function") {
      hostList.querySelectorAll("button").forEach((btn) => {
        btn.disabled = true;
      });
    }
  };
  function renderHosts(state, fresh, busy) {
    const container = element("hostList");
    if (!container) return;
    const hosts = Array.isArray(state?.injection?.hosts) ? state.injection.hosts : null;
    if (!hosts) {
      container.innerHTML = '<p class="note">等待插件宿主上报各宿主状态。</p>';
      return;
    }
    const showAll = Boolean(element("showAllHosts")?.checked);
    const visible = showAll ? hosts : hosts.filter((h) => h.detected || h.installed);
    if (!visible.length) {
      container.innerHTML =
        '<p class="note">未检测到本地宿主环境。可勾选“显示未检测到的宿主”查看全部支持列表。</p>';
      return;
    }
    const globalEnabled = state.injection?.enabled !== false;
    const lockButtons = !fresh || busy;
    container.innerHTML = visible
      .map((host) => {
        const installBadge = host.installed
          ? '<span class="badge" data-state="on">已安装</span>'
          : '<span class="badge" data-state="off">未安装</span>';
        const detectBadge =
          !host.detected && !host.installed
            ? '<span class="badge" data-state="off">未检测到环境</span>'
            : "";
        let injectBadge = "";
        if (host.installed) {
          if (!globalEnabled) {
            injectBadge = '<span class="badge" data-state="off">总开关已暂停</span>';
          } else if (host.harnessDisabled) {
            injectBadge = '<span class="badge" data-state="off">注入已暂停</span>';
          } else {
            injectBadge = '<span class="badge" data-state="on">注入已开启</span>';
          }
        }
        const hostName = escapeHtml(host.name);
        const hostLabel = escapeHtml(host.label || host.name);
        const toggleButtons = host.installed
          ? `<button type="button" data-host-action="host-enable" data-host="${hostName}" ${
              lockButtons || !host.harnessDisabled ? "disabled" : ""
            }>开启</button>` +
            `<button type="button" data-host-action="host-disable" data-host="${hostName}" ${
              lockButtons || host.harnessDisabled ? "disabled" : ""
            }>暂停</button>` +
            `<button type="button" data-host-action="host-install" data-host="${hostName}" ${
              lockButtons ? "disabled" : ""
            }>更新</button>` +
            `<button type="button" data-host-action="host-uninstall" data-host="${hostName}" ${
              lockButtons ? "disabled" : ""
            }>卸载</button>`
          : `<button type="button" data-host-action="host-install" data-host="${hostName}" ${
              lockButtons ? "disabled" : ""
            }>安装</button>`;
        return `<div class="host-item">
          <div class="host-meta">
            <div class="host-title">
              <strong>${hostLabel}</strong>
              <code>${hostName}</code>
            </div>
            <div class="host-title">${installBadge}${injectBadge}${detectBadge}</div>
          </div>
          <div class="host-actions">${toggleButtons}</div>
        </div>`;
      })
      .join("");
  }
  function renderLlm(state, fresh, busy) {
    const llm = state?.llm;
    const select = element("llmModel");
    const button = element("syncLlm");
    if (!select || !button) return;
    if (!llm) {
      const llmStatusEl = element("llmStatus");
      if (llmStatusEl) {
        llmStatusEl.textContent = "未上报";
        llmStatusEl.dataset.status = "stale";
      }
      element("llmHost").textContent = "—";
      element("llmConfigured").textContent = "—";
      element("llmMode").textContent = "—";
      select.disabled = true;
      button.disabled = true;
      element("llmNote").textContent = "等待插件宿主上报 LLM 状态。";
      return;
    }
    const labels = {
      synced: "已接入",
      pending: "同步中",
      updated: "已更新",
      manual: "手动配置",
      unavailable: "不可用",
      error: "错误",
    };
    const llmStatusEl = element("llmStatus");
    if (llmStatusEl) {
      llmStatusEl.textContent = fresh ? labels[llm.status] || llm.status : "状态未更新";
      llmStatusEl.dataset.status = fresh ? llm.status : "stale";
    }
    element("llmHost").textContent = llm.hostModel || "—";
    element("llmConfigured").textContent = llm.configuredModel || "—";
    element("llmMode").textContent = llm.mode === "fixed" ? "固定模型" : "跟随 Magpie";

    const models = Array.isArray(llm.models) ? llm.models : [];
    const optionsHtml = [
      '<option value="">跟随 Magpie 当前模型</option>',
      ...models.map(
        (model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`
      ),
    ];
    if (llm.configuredModel && !models.includes(llm.configuredModel))
      optionsHtml.push(
        `<option value="${escapeHtml(llm.configuredModel)}">${escapeHtml(llm.configuredModel)}（当前）</option>`
      );
    const html = optionsHtml.join("");
    if (select.dataset.options !== html) {
      select.innerHTML = html;
      select.dataset.options = html;
    }
    if (!llmTouched) select.value = llm.mode === "fixed" ? llm.configuredModel || "" : "";

    const hasChoice = optionsHtml.length > 1;
    select.disabled = !fresh || busy || !hasChoice;
    button.disabled = !fresh || busy || llm.status === "unavailable" || !llm.hostModel;
    element("llmNote").textContent = [
      llm.message,
      llm.restartRequired ? "记忆服务正在运行，点击“同步并应用”会重启它以使用新配置。" : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  function render() {
    const state = window.hindsightProcessState;
    disable();
    if (!state || state.port !== port || Date.now() - state.checkedAt > 15000) {
      setText("running", "状态未更新");
      setText("daemonStatus", "状态未更新");
      setText("injectionStatus", "状态未更新");
      status.textContent = "等待插件宿主更新状态。可点击“刷新状态”重新读取。";
      renderLlm(state, false, true);
      renderHosts(state, false, true);
      return;
    }
    setText("running", state.running ? "运行中" : "已停止");
    const runningEl = element("running");
    if (runningEl) runningEl.dataset.running = String(state.running);
    setText("daemonStatus", state.daemonHealthy ? "在线" : "已停止");
    const daemonStatusEl = element("daemonStatus");
    if (daemonStatusEl) daemonStatusEl.dataset.running = String(state.daemonHealthy);
    setText("profile", state.profile);
    setText("port", String(state.port));
    setText("address", state.url);
    setText("daemon", state.daemonHealthy ? "在线" : "未就绪");
    setText("checked", new Date(state.checkedAt).toLocaleTimeString());
    const injection = state.injection;
    const injectionEnabled = injection ? injection.enabled !== false : true;
    const injectionStatusEl = element("injectionStatus");
    if (injectionStatusEl) {
      injectionStatusEl.textContent = injection
        ? injectionEnabled
          ? "已开启"
          : "已暂停"
        : "未上报";
      if (injection) injectionStatusEl.dataset.enabled = String(injectionEnabled);
    }
    setText("injectionConfigPath", injection?.configPath || "—");
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
    renderLlm(state, true, Boolean(busy));
    renderHosts(state, true, Boolean(busy));
    if (busy) {
      status.textContent = "正在执行，请稍候…";
      scheduleFastPoll();
      return;
    }
    clearFastPoll();
    setDisabled("start", state.running);
    setDisabled("stop", !state.running);
    setDisabled("restart", !state.running);
    setDisabled("open", false);
    setDisabled("daemonStart", state.daemonHealthy);
    setDisabled("daemonStop", !state.daemonHealthy);
    setDisabled("daemonRestart", !state.daemonHealthy);
    setDisabled("injectionEnable", !injection || injectionEnabled);
    setDisabled("injectionDisable", !injection || !injectionEnabled);
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
      const runningEl = document.getElementById("running");
      if (runningEl) runningEl.textContent = "宿主不可用";
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
    port = Number(options.port ?? 18888);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("端口配置无效");
    const submitAction = (buttonId, action) => {
      const button = element(buttonId);
      if (!button) return;
      button.addEventListener("click", async () => {
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
    };
    for (const action of actions) {
      submitAction(action, action);
    }
    for (const [buttonId, action] of Object.entries(daemonActions)) {
      submitAction(buttonId, action);
    }
    for (const [buttonId, action] of Object.entries(injectionActions)) {
      submitAction(buttonId, action);
    }
    const showAllHostsEl = element("showAllHosts");
    if (showAllHostsEl) {
      showAllHostsEl.addEventListener("change", render);
    }
    const hostListEl = element("hostList");
    if (hostListEl) {
      hostListEl.addEventListener("click", async (event) => {
        const target = event?.target?.closest?.("button[data-host-action]");
        if (!target || target.disabled) return;
        const action = target.dataset.hostAction;
        const host = target.dataset.host;
        if (!action || !host) return;
        disable();
        pending = Date.now() + "-" + Math.random().toString(36).slice(2, 12).padEnd(10, "0");
        status.textContent = "正在提交宿主操作…";
        try {
          options = await window.magpie.options.get();
          await window.magpie.options.set({
            ...options,
            port,
            processRequest: { id: pending, action, host },
          });
          refresh();
        } catch (error) {
          pending = null;
          render();
          status.textContent = error.message;
        }
      });
    }
    const llmModelEl = element("llmModel");
    if (llmModelEl) {
      llmModelEl.addEventListener("change", () => {
        llmTouched = true;
      });
    }
    const syncLlmEl = element("syncLlm");
    if (syncLlmEl) {
      syncLlmEl.addEventListener("click", async () => {
        disable();
        pending = Date.now() + "-" + Math.random().toString(36).slice(2, 12).padEnd(10, "0");
        status.textContent = "正在同步 LLM 配置…";
        try {
          options = await window.magpie.options.get();
          await window.magpie.options.set({
            ...options,
            port,
            processRequest: {
              id: pending,
              action: "sync-llm",
              model: element("llmModel").value || null,
            },
          });
          refresh();
        } catch (error) {
          pending = null;
          render();
          status.textContent = error.message;
        }
      });
    }
    const refreshEl = element("refresh");
    if (refreshEl) refreshEl.addEventListener("click", refresh);
    refresh();
    setInterval(refresh, 3000);
  } catch (error) {
    disable();
    status.textContent = error.message;
  }
})();
