function finiteScrollOffset(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function captureScrollPositions(root) {
  const positions = new Map();
  if (!root || typeof root.querySelectorAll !== "function") return positions;

  for (const element of root.querySelectorAll("[data-scroll-key]")) {
    const key = element.dataset?.scrollKey;
    if (!key || positions.has(key)) continue;
    positions.set(key, {
      top: finiteScrollOffset(element.scrollTop),
      left: finiteScrollOffset(element.scrollLeft),
    });
  }
  return positions;
}

export function restoreScrollPositions(root, positions) {
  if (!root || typeof root.querySelectorAll !== "function" || !(positions instanceof Map)) return;

  for (const element of root.querySelectorAll("[data-scroll-key]")) {
    const key = element.dataset?.scrollKey;
    const position = key ? positions.get(key) : null;
    if (!position) continue;
    element.scrollTop = position.top;
    element.scrollLeft = position.left;
  }
}
