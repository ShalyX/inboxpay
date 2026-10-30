// Native dialogs own focus trapping, background inertness, and Escape handling.
// The opener can be replaced during an inbox refresh; resolve it again on close.
export function createDialog(dialog, { resolveOpener = () => null, modal = () => true } = {}) {
  let opener = null;
  let previousOverflow = "";
  let scrollPosition = null;
  let modalOpen = false;
  function restore() {
    if (modalOpen) dialog.ownerDocument.body.style.overflow = previousOverflow;
    if (modalOpen && scrollPosition)
      dialog.ownerDocument.defaultView?.scrollTo(...scrollPosition);
    const target = opener?.isConnected ? opener : resolveOpener();
    target?.focus({ preventScroll: true });
  }
  dialog.addEventListener("close", restore);
  // Keep boundary Tab presses in the modal, including when its final action is disabled.
  dialog.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || !dialog.open || !modalOpen) return;
    const controls = [...dialog.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')]
      .filter((node) => !node.disabled && !node.hidden && node.getClientRects().length > 0 && !node.closest("[inert]"));
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && dialog.ownerDocument.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && dialog.ownerDocument.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      close();
  });
  function open(trigger) {
    if (dialog.open) return;
    opener = trigger || dialog.ownerDocument.activeElement;
    previousOverflow = dialog.ownerDocument.body.style.overflow;
    const view = dialog.ownerDocument.defaultView;
    scrollPosition = view ? [view.scrollX, view.scrollY] : null;
    modalOpen = modal();
    if (modalOpen) dialog.showModal();
    else dialog.show();
    // A previously scrolled invoice must not reopen halfway down the sheet.
    dialog.scrollTop = 0;
    if (modalOpen) dialog.ownerDocument.body.style.overflow = "hidden";
    if (scrollPosition) view.scrollTo(...scrollPosition);
  }
  function close() {
    if (dialog.open) dialog.close();
  }
  return {
    open,
    close,
    get isOpen() {
      return dialog.open;
    },
    get isModal() {
      return dialog.open && modalOpen;
    },
  };
}
