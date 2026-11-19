// 知识图谱：笔记是节点，引用是边。自写力导向，没有第三方依赖。
// 三种力同时作用：边像弹簧把两端拉近，节点之间互斥避免重叠，同一团簇再被拉向自己的重心。
export const PALETTE = ['#6f8fd0', '#5ea693', '#c98098', '#bf9a55', '#8f7fc4', '#5fa3bd', '#b8796b', '#8a9b5f'];
const FALLBACK_COLOR = '#7d8aa5';

const SPRING = 0.06;        // 边弹簧强度
const REST_LENGTH = 72;     // 知识点与主题之间的边长度，固定不变
const REPULSION = 2400;     // 同一团簇内的互斥强度
const BUILD_GAP = 4;        // 生成布局时团簇互相让开的力度
const CLUSTER_GAP = 7500;   // 团簇之间斥力作用在重心上的强度
const CENTER_PULL = 0.0018; // 整体向画布中心的弱力
const CLUSTER_PULL = 0.008; // 同团簇向重心的力
const NODE_MIN = 0.6;       // 节点大小滑块下限
const NODE_MAX = 1.6;       // 上限
const DAMPING = 0.86;
const MAX_SPEED = 16;
const ALPHA_MIN = 0.004;

export function createKnowledgeGraph(canvas, options = {}) {
  const ctx = canvas.getContext('2d');
  const tip = options.tip || null;
  const onOpen = typeof options.onOpen === 'function' ? options.onOpen : () => {};
  const onSelect = typeof options.onSelect === 'function' ? options.onSelect : () => {};

  let width = 0, height = 0, dpr = 1;
  let nodes = [], edges = [], byId = new Map(), adjacency = new Map();
  let alpha = 0, frame = 0, view = { x: 0, y: 0, k: 1 };
  let hoverId = null, selectedId = null, drag = null, pan = null, moved = false;
  let empty = true;
  let building = false;       // 只有生成布局那一小段才跑团簇之间的推挤
  let nodeScale = 1;          // 节点半径倍数
  let mutualOnly = false;
  let payload = { nodes: [], links: [] };
  const colorMap = new Map();

  const colorOf = node => colorMap.get(node.folder) || FALLBACK_COLOR;
  const radiusOf = node => Math.min(22, 5.5 + Math.sqrt(node.degree) * 2.6) * nodeScale;

  function size() {
    const box = canvas.getBoundingClientRect();
    dpr = Math.min(2, window.devicePixelRatio || 1);
    width = Math.max(1, Math.round(box.width));
    height = Math.max(1, Math.round(box.height));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }

  // 先按黄金角铺成螺旋：节点再多也不会一开始就叠在一点，收敛更快也更稳定。
  function seed() {
    const total = nodes.length;
    const spread = 26 * Math.sqrt(total) + 60;
    nodes.forEach((node, index) => {
      const angle = index * 2.399963229728653;
      const radius = total > 1 ? spread * Math.sqrt((index + 0.5) / total) : 0;
      node.x = Math.cos(angle) * radius;
      node.y = Math.sin(angle) * radius;
      node.vx = 0; node.vy = 0;
    });
  }

  // 团簇：优先用后台标好的「一块知识」（一个主题导读 + 它的知识点），
  // 这样拉开间距时，分开的就是用户眼里那一块一块的知识。
  // 还没归到主题里的笔记，按连通块自己凑一块，免得散成一地孤点。
  function detectClusters() {
    const index = new Map(nodes.map((node, i) => [node.id, i]));
    const adj = nodes.map(() => []);
    for (const edge of edges) {
      const a = index.get(edge.source), b = index.get(edge.target);
      if (a === undefined || b === undefined) continue;
      adj[a].push(b); adj[b].push(a);
    }
    if (nodes.some(node => node.group)) {
      for (const node of nodes) if (node.group) node.cluster = `g${node.group}`;
      const loose = nodes.filter(node => !node.group);
      const looseIndex = new Map(loose.map((node, i) => [node.id, i]));
      const looseAdj = loose.map(() => []);
      for (const edge of edges) {
        const a = looseIndex.get(edge.source), b = looseIndex.get(edge.target);
        if (a === undefined || b === undefined) continue;
        looseAdj[a].push(b); looseAdj[b].push(a);
      }
      const seen = new Array(loose.length).fill(false);
      let count = 0;
      for (let i = 0; i < loose.length; i++) {
        if (seen[i]) continue;
        const members = [];
        const stack = [i]; seen[i] = true;
        while (stack.length) {
          const current = stack.pop(); members.push(current);
          for (const next of looseAdj[current]) if (!seen[next]) { seen[next] = true; stack.push(next); }
        }
        // 孤点没有自己的重心，单独标记，不参与团簇之间的推挤。
        const key = members.length > 1 ? `s${count++}` : `z${loose[members[0]].id}`;
        for (const member of members) loose[member].cluster = key;
      }
      return;
    }
    const component = new Array(nodes.length).fill(-1);
    let count = 0;
    for (let i = 0; i < nodes.length; i++) {
      if (component[i] >= 0) continue;
      const stack = [i]; component[i] = count;
      while (stack.length) {
        const current = stack.pop();
        for (const next of adj[current]) if (component[next] < 0) { component[next] = count; stack.push(next); }
      }
      count++;
    }
    const sizes = new Map();
    for (const id of component) sizes.set(id, (sizes.get(id) || 0) + 1);
    const largest = Math.max(0, ...sizes.values());
    if (nodes.length <= 12 || largest <= nodes.length * 0.6) {
      nodes.forEach((node, i) => { node.cluster = `c${component[i]}`; });
      return;
    }
    const labels = nodes.map((_, i) => i);
    for (let round = 0; round < 16; round++) {
      let changed = false;
      for (let i = 0; i < nodes.length; i++) {
        const tally = new Map();
        for (const next of adj[i]) tally.set(labels[next], (tally.get(labels[next]) || 0) + 1);
        let best = labels[i], bestCount = tally.get(best) || 0;
        for (const [label, tallyCount] of tally) if (tallyCount > bestCount) { best = label; bestCount = tallyCount; }
        if (best !== labels[i]) { labels[i] = best; changed = true; }
      }
      if (!changed) break;
    }
    nodes.forEach((node, i) => { node.cluster = `c${labels[i]}`; });
  }

  function simulate() {
    const total = nodes.length;
    if (!total) return;
    // 互斥与硬碰撞：距离太近时直接分开，避免节点叠成一团。
    for (let i = 0; i < total; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < total; j++) {
        const b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let distance2 = dx * dx + dy * dy;
        if (distance2 < 0.01) {
          dx = ((i % 7) - 3) * 0.6 + 0.2;
          dy = ((j % 5) - 2) * 0.6 + 0.2;
          distance2 = dx * dx + dy * dy;
        }
        const distance = Math.sqrt(distance2);
        // 引用多的枢纽本身占地方，让它推得更用力，枢纽之间才不会挤成一坨。
        const push = REPULSION * (1 + (a.degree + b.degree) * 0.06) / distance2;
        const fx = (dx / distance) * push, fy = (dy / distance) * push;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
        const spacing = a.r + b.r + 14;
        if (distance < spacing) {
          const overlap = (spacing - distance) / distance * 0.5;
          const ox = dx * overlap, oy = dy * overlap;
          if (a.fixed && b.fixed) continue;
          if (a.fixed) { b.x += ox * 2; b.y += oy * 2; }
          else if (b.fixed) { a.x -= ox * 2; a.y -= oy * 2; }
          else { a.x -= ox; a.y -= oy; b.x += ox; b.y += oy; }
        }
      }
    }
    // 边像弹簧：长了就收紧，短了也会推开一点，避免两端粘死。
    for (const edge of edges) {
      const a = byId.get(edge.source), b = byId.get(edge.target);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 0.01;
      const force = (distance - REST_LENGTH) * SPRING;
      const fx = (dx / distance) * force, fy = (dy / distance) * force;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
    // 团簇重心：互相引用的一圈节点被拉到一起，和别的圈子自然分开。
    const centers = new Map();
    for (const node of nodes) {
      const center = centers.get(node.cluster) || { x: 0, y: 0, n: 0 };
      center.x += node.x; center.y += node.y; center.n++; centers.set(node.cluster, center);
    }
    for (const center of centers.values()) { center.x /= center.n; center.y /= center.n; }

    // 团簇之间的斥力只作用在重心上：整簇一起平移，簇内的边一个像素都不变。
    // 只在生成布局时跑（之后位置已经稳定，再推会慢慢飘出去）。
    const pushes = new Map();
    if (building) {
      // 只有成块的（两个以上笔记）才当成一块知识互相推，孤点跟着整体走就行。
      const list = [...centers.entries()].filter(([, center]) => center.n > 1);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const [keyA, a] = list[i], [keyB, b] = list[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const distance2 = Math.max(1, dx * dx + dy * dy);
          const distance = Math.sqrt(distance2);
          const push = CLUSTER_GAP * (BUILD_GAP - 1) / distance2;
          const fx = (dx / distance) * push, fy = (dy / distance) * push;
          const pa = pushes.get(keyA) || { x: 0, y: 0 };
          const pb = pushes.get(keyB) || { x: 0, y: 0 };
          // 整簇同一个加速度：大小块受的推力一样，小块不会被弹到画布外面去。
          pa.x -= fx; pa.y -= fy;
          pb.x += fx; pb.y += fy;
          pushes.set(keyA, pa); pushes.set(keyB, pb);
        }
      }
    }

    for (const node of nodes) {
      const center = centers.get(node.cluster);
      node.vx += (center.x - node.x) * CLUSTER_PULL;
      node.vy += (center.y - node.y) * CLUSTER_PULL;
      const extra = pushes.get(node.cluster);
      if (extra) { node.vx += extra.x; node.vy += extra.y; }
      node.vx -= node.x * CENTER_PULL;
      node.vy -= node.y * CENTER_PULL;
      if (node.fixed) { node.vx = 0; node.vy = 0; continue; }
      node.vx = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, (node.vx) * DAMPING));
      node.vy = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, (node.vy) * DAMPING));
      node.x += node.vx * alpha;
      node.y += node.vy * alpha;
    }
    alpha *= 0.985;
  }

  function screenToWorld(px, py) {
    return { x: (px - width / 2 - view.x) / view.k, y: (py - height / 2 - view.y) / view.k };
  }

  function nodeAt(px, py) {
    const point = screenToWorld(px, py);
    let found = null, best = Infinity;
    for (const node of nodes) {
      const distance = Math.hypot(node.x - point.x, node.y - point.y);
      if (distance <= node.r + 6 / view.k && distance < best) { best = distance; found = node; }
    }
    return found;
  }

  function neighborsOf(id) {
    const set = new Set([id]);
    for (const other of adjacency.get(id) || []) set.add(other);
    return set;
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.translate(width / 2 + view.x, height / 2 + view.y);
    ctx.scale(view.k, view.k);
    // 只有单击选中的节点才高亮它和它的邻居；鼠标悬浮只给一个悬停反馈，不带走整片高亮。
    const highlight = selectedId ? neighborsOf(selectedId) : null;
    ctx.lineCap = 'round';
    for (const edge of edges) {
      const a = byId.get(edge.source), b = byId.get(edge.target);
      if (!a || !b) continue;
      const active = highlight && highlight.has(a.id) && highlight.has(b.id);
      ctx.strokeStyle = active ? 'rgba(76,107,204,.55)' : 'rgba(150,165,196,.26)';
      ctx.lineWidth = (active ? 1.6 : 1) / view.k;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for (const node of nodes) {
      const dim = highlight && !highlight.has(node.id);
      const radius = node.r;
      ctx.beginPath(); ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = dim ? 'rgba(190,199,216,.45)' : colorOf(node);
      ctx.fill();
      if (node.id === selectedId) {
        ctx.lineWidth = 2.4 / view.k; ctx.strokeStyle = '#303d5c';
        ctx.stroke();
      } else if (node.id === hoverId) {
        ctx.lineWidth = 2 / view.k; ctx.strokeStyle = 'rgba(48,61,92,.5)';
        ctx.stroke();
      }
      if (node.degree === 0) {
        ctx.beginPath(); ctx.arc(node.x, node.y, radius + 2.5, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(150,160,186,.55)'; ctx.lineWidth = 1 / view.k; ctx.stroke();
      }
    }
    // 标签：放大后全部显示；未放大时只显示选中的、悬停的、它们的邻居，以及引用较多的枢纽。
    const visible = new Set();
    if (highlight) for (const id of highlight) visible.add(id);
    if (hoverId) visible.add(hoverId);
    if (view.k >= 1.7) for (const node of nodes) visible.add(node.id);
    else for (const node of nodes) if (node.degree >= 8) visible.add(node.id);
    const fontSize = Math.max(9, 11.5 / view.k);
    ctx.font = `${fontSize}px Inter, "Segoe UI", "Microsoft YaHei UI", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    // 标签避开别的标签和节点圆：压在一起就换到上方，再挤就干脆不画，宁可少也不要糊。
    const placed = [];
    const order = [...nodes].filter(node => visible.has(node.id) && !(highlight && !highlight.has(node.id)))
      .sort((a, b) => b.degree - a.degree);
    for (const node of order) {
      const label = node.title.length > 16 ? `${node.title.slice(0, 15)}…` : node.title;
      const textWidth = ctx.measureText(label).width;
      const height = fontSize * 1.25;
      const gap = 5 / view.k;
      const spots = [
        { cx: node.x, top: node.y + node.r + gap },
        { cx: node.x, top: node.y - node.r - height - gap },
        { cx: node.x + node.r + gap + textWidth / 2, top: node.y - height / 2 },
        { cx: node.x - node.r - gap - textWidth / 2, top: node.y - height / 2 },
      ];
      let chosen = null;
      for (const spot of spots) {
        const box = { cx: spot.cx, left: spot.cx - textWidth / 2, right: spot.cx + textWidth / 2, top: spot.top, bottom: spot.top + height };
        const hitsLabel = placed.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top);
        const hitsNode = hitsLabel ? true : nodes.some(other => other !== node
          && Math.hypot(other.x - Math.min(Math.max(other.x, box.left), box.right), other.y - Math.min(Math.max(other.y, box.top), box.bottom)) < other.r + 2);
        if (!hitsLabel && !hitsNode) { chosen = box; break; }
      }
      if (!chosen) continue;
      placed.push(chosen);
      ctx.lineWidth = 3 / view.k; ctx.strokeStyle = 'rgba(255,255,255,.92)';
      ctx.strokeText(label, chosen.cx, chosen.top);
      ctx.fillStyle = node.id === selectedId ? '#303d5c' : '#4c5773';
      ctx.fillText(label, chosen.cx, chosen.top);
    }
  }

  function loop() {
    frame = requestAnimationFrame(loop);
    if (alpha > ALPHA_MIN) simulate();
    draw();
    if (alpha <= ALPHA_MIN) { cancelAnimationFrame(frame); frame = 0; }
  }

  function fit() {
    if (!nodes.length) return;
    // 按真实范围取景：边上的笔记也完整露出来，不切掉任何一点。
    const xs = nodes.map(node => node.x).sort((a, b) => a - b);
    const ys = nodes.map(node => node.y).sort((a, b) => a - b);
    const pad = 28;
    const minX = xs[0] - pad, maxX = xs[xs.length - 1] + pad;
    const minY = ys[0] - pad, maxY = ys[ys.length - 1] + pad;
    const boxWidth = Math.max(1, maxX - minX), boxHeight = Math.max(1, maxY - minY);
    const k = Math.min(1.9, Math.max(0.25, Math.min((width - 60) / boxWidth, (height - 60) / boxHeight)));
    view = { x: -((minX + maxX) / 2) * k, y: -((minY + maxY) / 2) * k, k };
    draw();
  }

  function focusNode(id) {
    const node = nodes.find(item => item.id === id) || nodes.find(item => item.path === id);
    if (!node) return false;
    selectedId = node.id;
    view.x = -node.x * view.k; view.y = -node.y * view.k;
    draw();
    return true;
  }

  function requestDraw() {
    if (!frame) frame = requestAnimationFrame(loop);
    draw();
  }

  function showTip(node, px, py) {
    if (!tip) return;
    if (!node) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.replaceChildren();
    const title = document.createElement('strong'); title.textContent = node.title;
    const meta = document.createElement('span');
    meta.textContent = `${node.folder || '未分类'} · ${node.degree} 条引用${node.summary ? ` · ${node.summary}` : ''}`;
    tip.append(title, meta);
    const box = canvas.getBoundingClientRect();
    const left = Math.min(box.width - 200, Math.max(8, px + 14));
    const top = Math.min(box.height - 60, Math.max(8, py + 14));
    tip.style.transform = `translate(${left}px, ${top}px)`;
  }

  // 按「是否只看双向」重建节点与边。过滤后重新布局：结构变了，硬留旧坐标只会挤在一起。
  function build() {
    const rawNodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
    const rawLinks = (Array.isArray(payload?.links) ? payload.links : []).filter(link => link && (!mutualOnly || link.mutual));
    const used = new Set();
    for (const link of rawLinks) { used.add(String(link.source)); used.add(String(link.target)); }
    // 只看双向时，没有互相引用的笔记会变成孤点，留着只会把画布撑满，直接不显示。
    nodes = rawNodes.filter(item => !mutualOnly || used.has(String(item.id))).map(item => ({
      id: String(item.id), path: String(item.path || ''), title: String(item.title || ''),
      folder: String(item.folder || ''), summary: String(item.summary || ''), group: String(item.group || ''),
      degree: 0, x: 0, y: 0, vx: 0, vy: 0, fixed: false,
    }));
    byId = new Map(nodes.map(node => [node.id, node]));
    const known = new Set(nodes.map(node => node.id));
    edges = rawLinks.filter(edge => known.has(String(edge.source)) && known.has(String(edge.target)))
      .map(edge => ({ source: String(edge.source), target: String(edge.target), relation: edge.relation || '', mutual: !!edge.mutual }));
    adjacency = new Map(nodes.map(node => [node.id, []]));
    for (const edge of edges) { adjacency.get(edge.source).push(edge.target); adjacency.get(edge.target).push(edge.source); }
    for (const node of nodes) node.degree = adjacency.get(node.id).length;
    for (const node of nodes) node.r = radiusOf(node);
    empty = !nodes.length;
    selectedId = null; hoverId = null;
    // 目录按名字排序后依次取色：同一份数据每次颜色都一样，新目录也不会撞色。
    colorMap.clear();
    [...new Set(nodes.map(node => node.folder).filter(Boolean))].sort()
      .forEach((folder, index) => colorMap.set(folder, PALETTE[index % PALETTE.length]));
    if (empty) { draw(); return; }
    detectClusters();
    seed();
    // 先跑一段让布局成形，再按内容范围取景，避免打开时看到一堆重叠的点。
    building = true;
    alpha = 1;
    for (let i = 0; i < 260; i++) simulate();
    building = false;
    alpha = 0;
    fit();
  }

  function setData(next) {
    payload = { nodes: Array.isArray(next?.nodes) ? next.nodes : [], links: Array.isArray(next?.links) ? next.links : [] };
    build();
  }

  function setMutualOnly(value) {
    const next = !!value;
    if (next === mutualOnly) return;
    mutualOnly = next;
    if (!payload.nodes.length) return;
    build();
  }

  // 半径变了可能压到邻居，做几轮只解重叠的推挤：不动弹簧、不动团簇重心，
  // 所以布局不会被重新拉走，只是把叠在一起的节点推开。
  function separate() {
    for (let round = 0; round < 12; round++) {
      let hit = false;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          const dx = b.x - a.x, dy = b.y - a.y;
          const distance = Math.hypot(dx, dy) || 0.01;
          const spacing = a.r + b.r + 14;
          if (distance >= spacing) continue;
          hit = true;
          const push = (spacing - distance) / distance * 0.5;
          a.x -= dx * push; a.y -= dy * push;
          b.x += dx * push; b.y += dy * push;
        }
      }
      if (!hit) break;
    }
  }

  // 节点大小：只改半径，再解一次重叠，然后重新取景。
  function setNodeScale(value) {
    const next = Math.max(NODE_MIN, Math.min(NODE_MAX, (Number(value) || 100) / 100));
    if (Math.abs(next - nodeScale) < 0.005) return;
    nodeScale = next;
    for (const node of nodes) node.r = radiusOf(node);
    if (!nodes.length) { draw(); return; }
    separate();
    fit();
  }

  function resize() { size(); if (!empty) { fit(); } else { draw(); } }

  function pointerPosition(event) {
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }

  canvas.addEventListener('pointerdown', event => {
    const point = pointerPosition(event);
    const node = nodeAt(point.x, point.y);
    moved = false;
    canvas.setPointerCapture(event.pointerId);
    if (node) {
      drag = { node, offsetX: point.x, offsetY: point.y, x0: node.x, y0: node.y };
      node.fixed = true;
      const world = screenToWorld(point.x, point.y);
      drag.dx = node.x - world.x; drag.dy = node.y - world.y;
    } else {
      pan = { ox: point.x, oy: point.y, vx: view.x, vy: view.y };
      canvas.style.cursor = 'grabbing';
    }
  });

  canvas.addEventListener('pointermove', event => {
    const point = pointerPosition(event);
    if (drag) {
      const world = screenToWorld(point.x, point.y);
      drag.node.x = world.x + drag.dx; drag.node.y = world.y + drag.dy;
      drag.node.vx = drag.node.vy = 0;
      // 拖动就重新点着力学：被拖的节点钉在原地，相连的笔记被弹簧带过来，
      // 周围的点也被挤开，整张图跟着重新收敛。
      alpha = Math.max(alpha, 0.45);
      moved = true;
      requestDraw();
      return;
    }
    if (pan) {
      view.x = pan.vx + (point.x - pan.ox);
      view.y = pan.vy + (point.y - pan.oy);
      moved = true;
      requestDraw();
      return;
    }
    const node = nodeAt(point.x, point.y);
    const next = node?.id || null;
    if (next !== hoverId) { hoverId = next; canvas.style.cursor = next ? 'pointer' : 'grab'; requestDraw(); }
    showTip(node, point.x, point.y);
  });

  canvas.addEventListener('pointerup', event => {
    if (drag) {
      drag.node.fixed = false;
      if (!moved) {
        selectedId = selectedId === drag.node.id ? null : drag.node.id;
        onSelect(selectedId ? byId.get(selectedId) : null);
      } else {
        alpha = Math.max(alpha, 0.2); // 松手别突然僵住，让邻居把位置收干净
      }
      drag = null;
      requestDraw();
    } else if (pan && !moved && selectedId) {
      // 点空白处 = escape：取消选中，整片高亮一起收掉。
      selectedId = null;
      onSelect(null);
      requestDraw();
    }
    pan = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  });

  canvas.addEventListener('pointerleave', () => { hoverId = null; showTip(null); canvas.style.cursor = 'grab'; requestDraw(); });

  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const point = pointerPosition(event);
    const before = screenToWorld(point.x, point.y);
    const factor = Math.exp(-event.deltaY * 0.0016);
    view.k = Math.min(4, Math.max(0.18, view.k * factor));
    const after = screenToWorld(point.x, point.y);
    view.x += (after.x - before.x) * view.k;
    view.y += (after.y - before.y) * view.k;
    requestDraw();
  }, { passive: false });

  canvas.addEventListener('dblclick', event => {
    const point = pointerPosition(event);
    const node = nodeAt(point.x, point.y);
    if (node) onOpen(node);
  });

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  observer?.observe(canvas);
  size();

  return {
    setData, fit, focus: focusNode, resize, redraw: draw, setNodeScale, setMutualOnly,
    colorOf: folder => colorMap.get(folder) || FALLBACK_COLOR,
    get nodes() { return nodes; },
    get stats() { return { nodes: nodes.length, edges: edges.length, mutualOnly, nodeScale }; },
  };
}
