export function installProbe({ targets, writerId, text, sampleMs }) {
  const bridge = window.__collabLoadTest;
  const samples = [];
  const keys = [];
  const renders = [];
  const lastText = new Map();
  const startedAt = performance.now();
  let expected = '';
  let lastKeyAt = -Infinity;
  let lastPublishedSample = -Infinity;
  let publishedErrors = 0;
  const publish = (type, data) => {
    window.__recordLoadTest?.({ type, data }).catch(() => {});
  };
  const read = (target) => {
    const fragments = [...document.querySelectorAll('.superdoc-fragment')].filter((element) => element.dataset.blockId === target.blockId);
    const full = fragments.map((element) => element.textContent).join('');
    const start = full.indexOf(target.start);
    const end = full.indexOf(target.end, start + target.start.length);
    return start < 0 || end < 0 ? null : full.slice(start + target.start.length, end);
  };
  const scan = () => {
    const at = performance.now();
    for (const target of targets) {
      const current = read(target);
      if (lastText.get(target.id) === current) continue;
      lastText.set(target.id, current);
      const render = { at, user: target.id, text: current };
      renders.push(render);
      publish('render', render);
    }
  };
  const onKey = (event) => {
    if (!writerId || event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
    if (!event.target.matches('[data-v2-ime-host]')) return;
    const at = performance.now();
    lastKeyAt = at;
    expected += event.key;
    const key = { at, index: keys.length, key: event.key, expected, currentAtKeydown: read(targets.find((target) => target.id === writerId)) };
    keys.push(key);
    publish('key', key);
  };
  const observer = new MutationObserver(scan);
  observer.observe(document.querySelector('.document-pane'), { childList: true, subtree: true, characterData: true });
  document.addEventListener('keydown', onKey, true);
  scan();
  const sample = () => {
    const entry = {
    at: performance.now(),
    connection: bridge.connection,
    connectedUsers: bridge.connectedUsers,
    typing: performance.now() - lastKeyAt < 1000,
    expected,
    current: writerId ? read(targets.find((target) => target.id === writerId)) : undefined,
    };
    samples.push(entry);
    if (entry.at - lastPublishedSample >= 1000) {
      publish('sample', entry);
      lastPublishedSample = entry.at;
    }
    if (bridge.errors.length !== publishedErrors) {
      publish('errors', [...bridge.errors]);
      publishedErrors = bridge.errors.length;
    }
  };
  const timer = setInterval(sample, sampleMs);
  sample();
  window.__typingProbe = {
    startedAt,
    read,
    snapshot: () => ({ keys, renders, samples, final: Object.fromEntries(targets.map((target) => [target.id, read(target)])), errors: [...bridge.errors], intendedText: text }),
    stop() {
      clearInterval(timer);
      observer.disconnect();
      document.removeEventListener('keydown', onKey, true);
      scan();
      sample();
      return this.snapshot();
    },
  };
}

export function locateTargets(userIds) {
  return userIds.map((id) => {
    const start = `[[${id}]] `;
    const end = `[[/${id}]]`;
    const fragment = [...document.querySelectorAll('.superdoc-fragment')].find((element) => element.textContent.includes(start));
    if (!fragment) throw new Error(`Typing target ${id} is not rendered`);
    const blockId = fragment.dataset.blockId;
    const fragments = [...document.querySelectorAll('.superdoc-fragment')].filter((element) => element.dataset.blockId === blockId);
    const full = fragments.map((element) => element.textContent).join('');
    return { id, start, end, blockId, selectionBlockId: fragment.dataset.sourceNodeId, offset: full.indexOf(start) + start.length, page: Number(fragment.closest('.superdoc-page').dataset.pageNumber) };
  });
}

export function applyCaret(target) {
  const point = { kind: 'text', blockId: target.selectionBlockId, offset: target.offset };
  return window.__collabLoadTest.ui.selection.apply({ kind: 'selection', start: point, end: point });
}

export function annotatePage({ pageNumber, users }) {
  const page = document.querySelector(`.superdoc-page[data-page-number="${pageNumber}"]`);
  if (!page) throw new Error(`Page ${pageNumber} is not rendered`);
  const pageRect = page.getBoundingClientRect();
  const paper = page.cloneNode(true);
  paper.style.margin = '0';
  paper.style.boxShadow = 'none';
  const highlights = [];
  for (const user of users) {
    const fragments = [...document.querySelectorAll('.superdoc-fragment')].filter((element) => element.dataset.blockId === user.blockId);
    const full = fragments.map((element) => element.textContent).join('');
    const start = full.indexOf(user.start);
    const end = full.indexOf(user.end, start + user.start.length);
    if (start < 0 || end < 0) continue;
    let fragmentOffset = 0;
    for (const fragment of fragments) {
      const from = start + user.start.length - fragmentOffset;
      const to = end - fragmentOffset;
      fragmentOffset += fragment.textContent.length;
      if (Number(fragment.closest('.superdoc-page').dataset.pageNumber) !== pageNumber) continue;
      const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
      let node;
      let offset = 0;
      while ((node = walker.nextNode())) {
        const length = node.textContent.length;
        if (offset + length > from && offset < to) {
          const range = document.createRange();
          range.setStart(node, Math.max(0, from - offset));
          range.setEnd(node, Math.min(length, to - offset));
          for (const rectangle of range.getClientRects()) {
            if (!rectangle.width || !rectangle.height) continue;
            const rect = { x: rectangle.left - pageRect.left, y: rectangle.top - pageRect.top, width: rectangle.width, height: rectangle.height };
            highlights.push({ user: user.id, page: pageNumber, ...rect });
            const overlay = document.createElement('div');
            overlay.className = 'load-test-highlight';
            overlay.style.cssText = `position:absolute;left:${rect.x - 2}px;top:${rect.y - 2}px;width:${rect.width + 4}px;height:${rect.height + 4}px;border:2px solid ${user.color};background:color-mix(in srgb, ${user.color} 12%, transparent);pointer-events:none;z-index:100;box-sizing:border-box;`;
            paper.append(overlay);
          }
        }
        offset += length;
      }
    }
  }
  const legend = document.createElement('div');
  legend.className = 'load-test-highlight';
  legend.style.cssText = 'margin:12px 30px;padding:12px;background:#fff;border:1px solid #ddd;font:12px Inter,Arial,sans-serif;';
  for (const user of users.filter((candidate) => highlights.some((highlight) => highlight.user === candidate.id))) {
    const row = document.createElement('div');
    row.style.cssText = `border-left:5px solid ${user.color};padding-left:8px;margin:4px 0;`;
    const ms = (value) => value == null ? 'unobserved' : `${value.toFixed(1)} ms`;
    row.textContent = `${user.id} · local p95 ${ms(user.local.p95)} · remote p95 ${ms(user.remote.p95)}`;
    legend.append(row);
  }
  const capture = document.createElement('div');
  capture.className = 'load-test-capture';
  capture.style.cssText = `position:fixed;left:0;top:0;width:${pageRect.width}px;background:#fff;z-index:2147483647;`;
  capture.append(paper, legend);
  document.body.append(capture);
  return highlights;
}

export function findTypingPages(users) {
  const pages = new Set();
  for (const user of users) {
    const fragments = [...document.querySelectorAll('.superdoc-fragment')].filter((element) => element.dataset.blockId === user.blockId);
    const full = fragments.map((element) => element.textContent).join('');
    const start = full.indexOf(user.start);
    const end = full.indexOf(user.end, start + user.start.length);
    if (start < 0 || end < 0) continue;
    let offset = 0;
    for (const fragment of fragments) {
      const length = fragment.textContent.length;
      if (offset + length > start + user.start.length && offset < end) pages.add(Number(fragment.closest('.superdoc-page').dataset.pageNumber));
      offset += length;
    }
  }
  return [...pages].sort((a, b) => a - b);
}
