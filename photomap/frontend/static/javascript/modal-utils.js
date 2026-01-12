// modal-utils.js
// Reusable modal utilities for confirm dialogs

/**
 * Show a generic confirmation modal
 * @param {string} message - The message to display
 * @param {string} okButtonText - Text for the OK button (default: "OK")
 * @param {string} cancelButtonText - Text for the Cancel button (default: "Cancel")
 * @returns {Promise<boolean>} - Resolves to true if OK is clicked, false if Cancel is clicked
 */
export function showConfirmModal(message, okButtonText = "OK", cancelButtonText = "Cancel") {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirmModal");
    const text = document.getElementById("confirmText");
    const cancelBtn = document.getElementById("confirmCancelBtn");
    const okBtn = document.getElementById("confirmOkBtn");

    if (!modal || !text || !cancelBtn || !okBtn) {
      console.error("Confirm modal elements not found in DOM");
      resolve(false);
      return;
    }

    text.textContent = message;
    okBtn.textContent = okButtonText;
    cancelBtn.textContent = cancelButtonText;
    modal.style.display = "flex";

    function cleanup() {
      modal.style.display = "none";
      cancelBtn.removeEventListener("click", onCancel);
      okBtn.removeEventListener("click", onOk);
    }

    function onCancel() {
      cleanup();
      resolve(false);
    }

    function onOk() {
      cleanup();
      resolve(true);
    }

    cancelBtn.addEventListener("click", onCancel);
    okBtn.addEventListener("click", onOk);
  });
}
