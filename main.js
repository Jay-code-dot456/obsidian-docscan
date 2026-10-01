'use strict';

const { Plugin, PluginSettingTab, Setting, Modal, Notice, MarkdownView } = require('obsidian');

const DEFAULT_SETTINGS = {
  captureMode: 'picker',                 // picker=系统选择器(拍照/相册) | camera=直接调相机
  attachmentFolder: 'attachments/scans', // 扫描件存放目录
  workingLongEdge: 2000,                 // 采样用的源图长边上限（控制内存/耗时）
  outputLongEdge: 1600,                  // 输出图长边上限
  jpegQuality: 0.92,                     // JPEG 质量
  contrast: 1.0,                         // 1.0 = 不增强；>1 提高对比度（PPT/彩图建议保持 1.0）
  insetPercent: 12,                      // 初始四角内缩百分比
};

module.exports = class DocScanPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.addSettingTab(new DocScanSettingTab(this.app, this));

    this.addRibbonIcon('scan-line', '扫描文档', () => this.startCapture());
    this.addCommand({
      id: 'docscan-capture',
      name: '扫描：拍照并矫正',
      callback: () => this.startCapture(),
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // 唤起相机 / 相册，拿到图片后进入编辑器
  startCapture() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    // 仅在“直接相机”模式下强制唤起后置摄像头；否则交给系统选择器(拍照/相册/文件)
    if (this.settings.captureMode === 'camera') {
      input.setAttribute('capture', 'environment');
    }
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      try {
        const bitmap = await loadBitmap(file);
        const src = downscaleToCanvas(bitmap, this.settings.workingLongEdge);
        if (bitmap.close) bitmap.close();
        new ScanEditorModal(this.app, this, src).open();
      } catch (e) {
        console.error('[docscan]', e);
        new Notice('加载图片失败：' + (e && e.message ? e.message : e));
      }
    });
    document.body.appendChild(input);
    input.click();
  }
};

/* ---------------- 编辑器 Modal ---------------- */

class ScanEditorModal extends Modal {
  constructor(app, plugin, srcCanvas) {
    super(app);
    this.plugin = plugin;
    this.src = srcCanvas;         // 已降采样的源图 canvas
    this.corners = null;          // 四角坐标（源图像素空间）TL,TR,BR,BL 顺序无所谓，保存前会重排
    this.polygon = null;
    this.circles = [];
  }

  onOpen() {
    this.modalEl.addClass('docscan-modal');
    this.buildAdjust();
  }

  onClose() {
    this.contentEl.empty();
  }

  // 阶段一：手动框选四角
  buildAdjust() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('docscan-content');

    const srcW = this.src.width, srcH = this.src.height;
    const disp = this.fitSize(srcW, srcH);
    this.displayScale = disp.w / srcW;

    const stage = contentEl.createDiv('docscan-stage');
    // 定位容器：尺寸精确等于显示尺寸，让图片与 SVG 叠加共享同一个盒子（避免错位）
    const frame = stage.createDiv('docscan-frame');
    frame.style.width = disp.w + 'px';
    frame.style.height = disp.h + 'px';

    // 源图作为背景（CSS 缩放显示，像素数据不变，供后续采样）
    this.src.classList.add('docscan-img');
    this.src.style.width = disp.w + 'px';
    this.src.style.height = disp.h + 'px';
    frame.appendChild(this.src);

    // 叠加 SVG：viewBox 用源图坐标，句柄直接用源坐标放置
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${srcW} ${srcH}`);
    svg.setAttribute('class', 'docscan-overlay');
    svg.style.width = disp.w + 'px';
    svg.style.height = disp.h + 'px';
    frame.appendChild(svg);
    this.svg = svg;

    const poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('class', 'docscan-poly');
    poly.setAttribute('stroke-width', String(2 / this.displayScale));
    svg.appendChild(poly);
    this.polygon = poly;

    // 初始四角：按内缩比例
    const inset = Math.min(45, Math.max(0, this.plugin.settings.insetPercent)) / 100;
    const mx = srcW * inset, my = srcH * inset;
    this.corners = [
      [mx, my], [srcW - mx, my], [srcW - mx, srcH - my], [mx, srcH - my],
    ];

    const r = 22 / this.displayScale; // 恒定屏幕像素大小
    this.circles = [];
    for (let i = 0; i < 4; i++) {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('class', 'docscan-handle');
      c.setAttribute('r', String(r));
      c.setAttribute('stroke-width', String(2 / this.displayScale));
      svg.appendChild(c);
      this.circles.push(c);
      this.bindHandle(c, i, srcW, srcH);
    }
    this.redraw();

    const bar = contentEl.createDiv('docscan-toolbar');
    const hint = bar.createSpan('docscan-hint');
    hint.setText('拖动四角对齐文档边缘');
    const spacer = bar.createDiv('docscan-spacer');
    const cancel = bar.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
    const next = bar.createEl('button', { text: '矫正', cls: 'mod-cta' });
    next.addEventListener('click', () => this.doWarp());
  }

  bindHandle(circle, index, srcW, srcH) {
    let dragging = false;
    const toSrc = (e) => {
      const rect = this.svg.getBoundingClientRect();
      let x = (e.clientX - rect.left) / rect.width * srcW;
      let y = (e.clientY - rect.top) / rect.height * srcH;
      return [clamp(x, 0, srcW), clamp(y, 0, srcH)];
    };
    circle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      circle.setPointerCapture(e.pointerId);
      circle.classList.add('active');
    });
    circle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.corners[index] = toSrc(e);
      this.redraw();
    });
    const end = (e) => {
      dragging = false;
      circle.classList.remove('active');
      try { circle.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    circle.addEventListener('pointerup', end);
    circle.addEventListener('pointercancel', end);
  }

  redraw() {
    this.polygon.setAttribute('points', this.corners.map((p) => p[0] + ',' + p[1]).join(' '));
    for (let i = 0; i < 4; i++) {
      this.circles[i].setAttribute('cx', String(this.corners[i][0]));
      this.circles[i].setAttribute('cy', String(this.corners[i][1]));
    }
  }

  // 计算适配窗口的显示尺寸
  fitSize(w, h) {
    const maxW = Math.min(window.innerWidth - 40, 1000);
    const maxH = window.innerHeight - 150;
    const s = Math.min(maxW / w, maxH / h, 1);
    return { w: Math.round(w * s), h: Math.round(h * s) };
  }

  // 阶段二：透视矫正 + 预览
  doWarp() {
    const notice = new Notice('处理中…', 0);
    // 让 Notice 先渲染，再跑同步的重活
    requestAnimationFrame(() => requestAnimationFrame(() => {
      let out;
      try {
        out = warpDocument(this.src, this.corners, {
          outputLongEdge: this.plugin.settings.outputLongEdge,
          contrast: this.plugin.settings.contrast,
        });
      } catch (e) {
        notice.hide();
        console.error('[docscan]', e);
        new Notice('矫正失败：' + (e && e.message ? e.message : e));
        return;
      }
      notice.hide();
      this.buildPreview(out);
    }));
  }

  buildPreview(outCanvas) {
    const { contentEl } = this;
    contentEl.empty();

    const disp = this.fitSize(outCanvas.width, outCanvas.height);
    const stage = contentEl.createDiv('docscan-stage');
    stage.style.width = disp.w + 'px';
    stage.style.height = disp.h + 'px';
    outCanvas.classList.add('docscan-img');
    outCanvas.style.width = disp.w + 'px';
    outCanvas.style.height = disp.h + 'px';
    stage.appendChild(outCanvas);

    const bar = contentEl.createDiv('docscan-toolbar');
    const hint = bar.createSpan('docscan-hint');
    hint.setText(`${outCanvas.width}×${outCanvas.height}`);
    bar.createDiv('docscan-spacer');
    const back = bar.createEl('button', { text: '返回调整' });
    back.addEventListener('click', () => this.buildAdjust());
    const save = bar.createEl('button', { text: '保存', cls: 'mod-cta' });
    save.addEventListener('click', () => this.save(outCanvas));
  }

  async save(outCanvas) {
    try {
      const blob = await new Promise((res) =>
        outCanvas.toBlob(res, 'image/jpeg', this.plugin.settings.jpegQuality));
      if (!blob) throw new Error('导出图片失败');
      const buf = await blob.arrayBuffer();

      const folder = (this.plugin.settings.attachmentFolder || '').replace(/^\/+|\/+$/g, '');
      await ensureFolder(this.app, folder);
      const name = `scan-${timestamp()}.jpg`;
      const path = folder ? `${folder}/${name}` : name;
      await this.app.vault.createBinary(path, buf);

      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view && view.editor) {
        view.editor.replaceSelection(`![[${path}]]\n`);
        new Notice('已插入扫描件');
      } else {
        new Notice('已保存：' + path);
      }
      this.close();
    } catch (e) {
      console.error('[docscan]', e);
      new Notice('保存失败：' + (e && e.message ? e.message : e));
    }
  }
}

/* ---------------- 图像处理 ---------------- */

// 尽量按 EXIF 方向解码，避免手机竖拍变横
async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch (_) { /* 回退 */ }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('图片解码失败'));
      img.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

function downscaleToCanvas(bitmap, longEdge) {
  const w0 = bitmap.width, h0 = bitmap.height;
  const s = Math.min(1, longEdge / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * s));
  const h = Math.max(1, Math.round(h0 * s));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  return canvas;
}

// 四角重排为 TL,TR,BR,BL
function orderCorners(pts) {
  const bySum = pts.slice().sort((p, q) => (p[0] + p[1]) - (q[0] + q[1]));
  const tl = bySum[0], br = bySum[3];
  const byDiff = pts.slice().sort((p, q) => (p[1] - p[0]) - (q[1] - q[0]));
  const tr = byDiff[0], bl = byDiff[3];
  return [tl, tr, br, bl];
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function warpDocument(srcCanvas, corners, opts) {
  const [tl, tr, br, bl] = orderCorners(corners);
  let W = Math.round(Math.max(dist(tl, tr), dist(bl, br)));
  let H = Math.round(Math.max(dist(tl, bl), dist(tr, br)));
  if (W < 1 || H < 1) throw new Error('框选区域过小');

  const cap = Math.min(1, opts.outputLongEdge / Math.max(W, H));
  W = Math.max(1, Math.round(W * cap));
  H = Math.max(1, Math.round(H * cap));

  // 目标矩形 -> 源图 的单应矩阵（逆映射采样）
  const dstRect = [[0, 0], [W, 0], [W, H], [0, H]];
  const Hm = solveHomography(dstRect, [tl, tr, br, bl]);

  const sctx = srcCanvas.getContext('2d');
  const sImg = sctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const octx = out.getContext('2d');
  const oImg = octx.createImageData(W, H);
  warpSample(sImg, oImg, Hm, opts.contrast);
  octx.putImageData(oImg, 0, 0);
  return out;
}

// 逐像素逆映射 + 双线性采样
function warpSample(sImg, oImg, Hm, contrast) {
  const sw = sImg.width, sh = sImg.height, sd = sImg.data;
  const ow = oImg.width, oh = oImg.height, od = oImg.data;
  const a = Hm[0], b = Hm[1], c = Hm[2], d = Hm[3], e = Hm[4], f = Hm[5], g = Hm[6], h8 = Hm[7];
  const cf = contrast || 1.0;
  const applyContrast = Math.abs(cf - 1.0) > 1e-3;

  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const denom = g * x + h8 * y + 1;
      const sx = (a * x + b * y + c) / denom;
      const sy = (d * x + e * y + f) / denom;
      const oi = (y * ow + x) * 4;

      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) {
        od[oi] = od[oi + 1] = od[oi + 2] = 255;
        od[oi + 3] = 255;
        continue;
      }
      const x0 = sx | 0, y0 = sy | 0;
      const x1 = x0 + 1 < sw ? x0 + 1 : x0;
      const y1 = y0 + 1 < sh ? y0 + 1 : y0;
      const fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;

      for (let ch = 0; ch < 3; ch++) {
        const top = sd[i00 + ch] * (1 - fx) + sd[i10 + ch] * fx;
        const bot = sd[i01 + ch] * (1 - fx) + sd[i11 + ch] * fx;
        let v = top * (1 - fy) + bot * fy;
        if (applyContrast) {
          v = (v - 128) * cf + 128;
          v = v < 0 ? 0 : v > 255 ? 255 : v;
        }
        od[oi + ch] = v;
      }
      od[oi + 3] = 255;
    }
  }
}

// 由 4 组对应点解 3x3 单应矩阵（h33=1），返回长度 8 的数组 [a..h8]
function solveHomography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const x = from[i][0], y = from[i][1];
    const u = to[i][0], v = to[i][1];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  return gaussSolve(A, b);
}

// 8x8 高斯消元（列主元）
function gaussSolve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => row.concat(b[i]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-9) throw new Error('四角退化，无法矫正');
    const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;
    const pivVal = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= pivVal;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

/* ---------------- 工具 ---------------- */

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function ensureFolder(app, folder) {
  if (!folder) return;
  const parts = folder.split('/');
  let cur = '';
  for (const part of parts) {
    if (!part) continue;
    cur = cur ? `${cur}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(cur)) {
      try { await app.vault.createFolder(cur); } catch (_) {}
    }
  }
}

/* ---------------- 设置面板 ---------------- */

class DocScanSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('采集方式')
      .setDesc('系统选择器：弹出菜单可选拍照或相册（推荐，兼容性最好）；直接相机：一键唤起后置摄像头')
      .addDropdown((d) => d
        .addOption('picker', '系统选择器（拍照/相册）')
        .addOption('camera', '直接相机')
        .setValue(this.plugin.settings.captureMode)
        .onChange(async (v) => { this.plugin.settings.captureMode = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('存放目录')
      .setDesc('扫描件保存到的库内路径')
      .addText((t) => t
        .setPlaceholder('attachments/scans')
        .setValue(this.plugin.settings.attachmentFolder)
        .onChange(async (v) => { this.plugin.settings.attachmentFolder = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('输出长边（像素）')
      .setDesc('矫正后图片的长边上限，越大越清晰也越占空间')
      .addText((t) => t
        .setValue(String(this.plugin.settings.outputLongEdge))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n >= 300) { this.plugin.settings.outputLongEdge = n; await this.plugin.saveSettings(); }
        }));

    new Setting(containerEl)
      .setName('JPEG 质量')
      .setDesc('0.5 ~ 1.0')
      .addText((t) => t
        .setValue(String(this.plugin.settings.jpegQuality))
        .onChange(async (v) => {
          const n = parseFloat(v);
          if (!isNaN(n) && n > 0 && n <= 1) { this.plugin.settings.jpegQuality = n; await this.plugin.saveSettings(); }
        }));

    new Setting(containerEl)
      .setName('对比度增强')
      .setDesc('1.0 = 关闭（PPT / 彩色图表建议保持）；纯文字纸质可调到 1.2~1.5')
      .addText((t) => t
        .setValue(String(this.plugin.settings.contrast))
        .onChange(async (v) => {
          const n = parseFloat(v);
          if (!isNaN(n) && n >= 0.5 && n <= 3) { this.plugin.settings.contrast = n; await this.plugin.saveSettings(); }
        }));
  }
}
