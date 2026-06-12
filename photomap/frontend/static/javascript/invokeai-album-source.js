// invokeai-album-source.js
//
// Helpers for the "An InvokeAI Image Gallery Board" album source in the
// album manager: probing a (possibly unsaved) backend URL, fetching its
// board list, and rendering/reading the board multi-select checklist.
import { fetchJson } from "./utils.js";

// Probe an explicit InvokeAI URL. Returns {reachable, version?, detail?}.
export async function probeInvokeAI(url) {
  return await fetchJson("invokeai/probe_status", { json: { url } });
}

// Fetch the board list for explicit connection values. `albumKey` lets the
// backend fall back to the album's stored password when the edit form
// leaves the password field blank.
export async function fetchInvokeAIBoards({ url, username, password, albumKey }) {
  const body = { url };
  if (username) {
    body.username = username;
  }
  if (password) {
    body.password = password;
  }
  if (albumKey) {
    body.album_key = albumKey;
  }
  return await fetchJson("invokeai/probe_boards", { json: body });
}

// Render one checkbox per board into `container`, prepending InvokeAI's
// implicit "Uncategorized" bucket (board_id "none"). `selectedIds` marks
// boxes as checked.
export function renderBoardChecklist(container, boards, selectedIds = []) {
  if (!container) {
    return;
  }
  container.innerHTML = "";
  const selected = new Set(selectedIds);
  const allBoards = [{ board_id: "none", board_name: "Uncategorized" }, ...(boards || [])];
  allBoards.forEach((board) => {
    const label = document.createElement("label");
    label.className = "board-checkbox-label";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "board-checkbox";
    checkbox.value = board.board_id;
    checkbox.checked = selected.has(board.board_id);

    label.appendChild(checkbox);
    label.appendChild(document.createTextNode(board.board_name));
    container.appendChild(label);
  });
}

// Read the checked board ids back out of a checklist container.
export function collectSelectedBoardIds(container) {
  if (!container) {
    return [];
  }
  return Array.from(container.querySelectorAll(".board-checkbox:checked")).map((checkbox) => checkbox.value);
}
