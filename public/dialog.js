// Native dialogs own focus trapping, background inertness, and Escape handling.
// The opener can be replaced during an inbox refresh; resolve it again on close.
export function createDialog(dialog, { resolveOpener = () => null } = {}) {
  let opener = null;
  let previousOverflow = "";
  let scrollPosition = null;
  function restore() {
    dialog.ownerDocument.body.style.overflow = previousOverflow;
    if (scrollPosition)
      dialog.ownerDocument.defaultView?.scrollTo(...scrollPosition);
    const target = opener?.isConnected ? opener : resolveOpener();
    target?.focus({ preventScroll: true });
  }
  dialog.addEventListener("close", restore);
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
    dialog.showModal();
    // A previously scrolled invoice must not reopen halfway down the sheet.
    dialog.scrollTop = 0;
    dialog.ownerDocument.body.style.overflow = "hidden";
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
  };
}
