function $(id) {
  return document.getElementById(id);
}

function ensureToast() {
  let node = $("toast");
  if (node) return node;
  node = document.createElement("div");
  node.id = "toast";
  node.className = "toast";
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  node.hidden = true;
  document.body.appendChild(node);
  return node;
}

function ensureDialog() {
  let node = $("app-dialog");
  if (node) return node;
  node = document.createElement("div");
  node.id = "app-dialog";
  node.className = "modal-backdrop";
  node.setAttribute("role", "dialog");
  node.setAttribute("aria-modal", "true");
  node.hidden = true;
  const content = document.createElement("div");
  content.className = "modal-content";
  content.style.maxWidth = "440px";
  const title = document.createElement("h3");
  title.id = "dialog-title";
  title.textContent = "What's My Share?";
  const message = document.createElement("p");
  message.id = "dialog-message";
  const input = document.createElement("input");
  input.id = "dialog-input";
  input.type = "text";
  input.hidden = true;
  const actions = document.createElement("div");
  actions.style.cssText = "display:flex; gap:8px; justify-content:flex-end; margin-top:14px;";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.id = "dialog-cancel";
  cancel.className = "btn btn-secondary";
  cancel.textContent = "Cancel";
  const ok = document.createElement("button");
  ok.type = "button";
  ok.id = "dialog-ok";
  ok.className = "btn btn-primary";
  ok.textContent = "OK";
  actions.append(cancel, ok);
  content.append(title, message, input, actions);
  node.append(content);
  document.body.appendChild(node);
  return node;
}

let toastTimer = 0;

export function toast(message, options = {}) {
  const root = ensureToast();
  root.replaceChildren();
  root.setAttribute("aria-atomic", "true");
  const text = document.createElement("span");
  text.textContent = message;
  root.appendChild(text);
  if (options.actionLabel && options.onAction) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = options.actionLabel;
    button.addEventListener("click", () => {
      root.hidden = true;
      options.onAction();
    });
    root.appendChild(button);
  }
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "Dismiss notification");
  close.textContent = "\u00d7";
  close.addEventListener("click", () => {
    root.hidden = true;
    clearTimeout(toastTimer);
  });
  root.appendChild(close);
  root.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { root.hidden = true; }, options.duration || (options.actionLabel ? 7000 : 3400));
}

export function askConfirm({ title = "What's My Share?", message, confirmLabel = "Confirm", danger = false }) {
  return openDialog({ title, message, mode: "confirm", confirmLabel, danger });
}

export function askPrompt({ title = "What's My Share?", message, defaultValue = "", placeholder = "" }) {
  return openDialog({ title, message, mode: "prompt", defaultValue, placeholder, confirmLabel: "OK" });
}

function openDialog({ title, message, mode, defaultValue = "", placeholder = "", confirmLabel, danger = false }) {
  const backdrop = ensureDialog();
  const content = backdrop.querySelector(".modal-content");
  const titleEl = $("dialog-title");
  const messageEl = $("dialog-message");
  const input = $("dialog-input");
  const ok = $("dialog-ok");
  const cancel = $("dialog-cancel");
  const previousFocus = document.activeElement;
  if (content) content.setAttribute("tabindex", "-1");
  backdrop.setAttribute("aria-labelledby", "dialog-title");
  backdrop.setAttribute("aria-describedby", "dialog-message");
  return new Promise((resolve) => {
    titleEl.textContent = title;
    messageEl.textContent = message || "";
    messageEl.hidden = !message;
    input.hidden = mode !== "prompt";
    input.value = defaultValue;
    input.placeholder = placeholder;
    ok.textContent = confirmLabel || "OK";
    ok.classList.toggle("btn-danger", danger);
    cancel.hidden = false;
    backdrop.hidden = false;
    backdrop.classList.add("active");
    const focusable = () => Array.from(content ? content.querySelectorAll(
      'button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), select:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), a[href], [tabindex]:not([tabindex="-1"])'
    ) : []).filter(element => !element.hidden);
    const finish = (value) => {
      backdrop.classList.remove("active");
      backdrop.hidden = true;
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      backdrop.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
      resolve(value);
      if (previousFocus && typeof previousFocus.focus === "function") previousFocus.focus();
    };
    const onOk = () => finish(mode === "prompt" ? input.value : true);
    const onCancel = () => finish(mode === "prompt" ? null : false);
    const onBackdrop = (event) => {
      if (event.target === backdrop) onCancel();
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        content?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    backdrop.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    if (mode === "prompt") input.focus();
    else ok.focus();
  });
}

export function enhanceOverlay(overlay, close) {
  if (!overlay || overlay.dataset.overlayReady === "true") return;
  overlay.dataset.overlayReady = "true";
  const surface = overlay.querySelector(".balances-sheet, .modal-content") || overlay;
  const dialogNode = surface.hasAttribute("role") ? surface : overlay;
  dialogNode.setAttribute("role", "dialog");
  dialogNode.setAttribute("aria-modal", "true");
  if (surface !== overlay) surface.setAttribute("tabindex", "-1");
  let open = false;
  let previousFocus = null;
  const isOpen = () => overlay.classList.contains("balances-overlay")
    ? !overlay.hidden
    : overlay.classList.contains("active");
  const requestClose = () => {
    if (typeof close === "function") close();
    else {
      overlay.hidden = true;
      overlay.classList.remove("active");
    }
  };
  const focusable = () => Array.from(surface.querySelectorAll(
    'button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), select:not([disabled]):not([hidden]), textarea:not([disabled]):not([hidden]), a[href], [tabindex]:not([tabindex="-1"])'
  )).filter(element => !element.hidden && element.offsetParent !== null);
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      requestClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = focusable();
    if (!items.length) {
      event.preventDefault();
      surface.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const onBackdrop = (event) => {
    if (event.target === overlay) requestClose();
  };
  const activate = () => {
    open = true;
    previousFocus = document.activeElement;
    overlay.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
    const items = focusable();
    (items[0] || surface).focus();
  };
  const deactivate = () => {
    open = false;
    overlay.removeEventListener("click", onBackdrop);
    document.removeEventListener("keydown", onKey);
    if (previousFocus && document.contains(previousFocus) && previousFocus.offsetParent !== null) {
      previousFocus.focus();
    }
    previousFocus = null;
  };
  const update = () => {
    const next = isOpen();
    if (next && !open) activate();
    else if (!next && open) deactivate();
  };
  new MutationObserver(update).observe(overlay, {
    attributes: true,
    attributeFilter: ["class", "hidden"]
  });
  update();
}

export function enhanceTabList(container) {
  if (!container || container.dataset.tabsReady === "true") return;
  const tabs = Array.from(container.querySelectorAll(".tab-btn"));
  if (!tabs.length) return;
  container.dataset.tabsReady = "true";
  container.setAttribute("role", "tablist");
  const refresh = () => tabs.forEach((tab) => {
    const selected = tab.classList.contains("active");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  refresh();
  if (!tabs.some((tab) => tab.classList.contains("active"))) tabs[0].tabIndex = 0;
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => setTimeout(refresh, 0));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      let next = index;
      if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      tabs[next].focus();
      tabs[next].click();
    });
  });
  new MutationObserver(refresh).observe(container, {
    subtree: true,
    attributes: true,
    attributeFilter: ["class"]
  });
}

export function enhanceRadioGroup(container) {
  if (!container || container.dataset.radiosReady === "true") return;
  const items = Array.from(container.querySelectorAll('[role="radio"]'));
  if (!items.length) return;
  container.dataset.radiosReady = "true";
  const refresh = () => {
    const checked = items.find((item) => item.getAttribute("aria-checked") === "true") || items[0];
    items.forEach((item) => { item.tabIndex = item === checked ? 0 : -1; });
  };
  refresh();
  items.forEach((item, index) => {
    item.addEventListener("click", () => setTimeout(refresh, 0));
    item.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      let next = index;
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % items.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = items.length - 1;
      items[next].focus();
      items[next].click();
    });
  });
  new MutationObserver(refresh).observe(container, {
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-checked"]
  });
}
