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
  title.textContent = "FairShare";
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
  root.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { root.hidden = true; }, options.duration || (options.actionLabel ? 7000 : 3400));
}

export function askConfirm({ title = "FairShare", message, confirmLabel = "Confirm", danger = false }) {
  return openDialog({ title, message, mode: "confirm", confirmLabel, danger });
}

export function askPrompt({ title = "FairShare", message, defaultValue = "", placeholder = "" }) {
  return openDialog({ title, message, mode: "prompt", defaultValue, placeholder, confirmLabel: "OK" });
}

function openDialog({ title, message, mode, defaultValue = "", placeholder = "", confirmLabel, danger = false }) {
  const backdrop = ensureDialog();
  const titleEl = $("dialog-title");
  const messageEl = $("dialog-message");
  const input = $("dialog-input");
  const ok = $("dialog-ok");
  const cancel = $("dialog-cancel");
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
    const finish = (value) => {
      backdrop.classList.remove("active");
      backdrop.hidden = true;
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      resolve(value);
    };
    const onOk = () => finish(mode === "prompt" ? input.value : true);
    const onCancel = () => finish(mode === "prompt" ? null : false);
    const onKey = (event) => { if (event.key === "Escape") onCancel(); };
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
    if (mode === "prompt") input.focus();
    else ok.focus();
  });
}
