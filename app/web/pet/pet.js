const spine = window.spine || null;

const $ = (selector) => document.querySelector(selector);

const elements = {
  shell: $(".pet-shell"),
  bubble: $("#bubble"),
  canvas: $("#petCanvas"),
  spineMount: $("#spineMount"),
  petHitbox: $("#petHitbox"),
  petMenu: $("#petMenu"),
  openPanel: $("#openPanel"),
  closePanel: $("#closePanel"),
  wavePet: $("#wavePet"),
  sleepPet: $("#sleepPet"),
  chatLog: $("#chatLog"),
  composer: $("#composer"),
  messageInput: $("#messageInput"),
  profileSelect: $("#profileSelect"),
  animationSelect: $("#animationSelect"),
  scaleInput: $("#scaleInput"),
  manualToggle: $("#manualToggle"),
  transparentToggle: $("#transparentToggle"),
  agentWorkspaceInput: $("#agentWorkspaceInput"),
  agentModelInput: $("#agentModelInput"),
  agentSafetyMode: $("#agentSafetyMode"),
  agentStreamToggle: $("#agentStreamToggle"),
  indexWorkspace: $("#indexWorkspace"),
};

const launchParams = new URLSearchParams(window.location.search);
const isLayerMode = launchParams.has("layer") || launchParams.get("mode") === "layer";
const isPanelMode = launchParams.get("mode") === "panel" || launchParams.get("panel") === "open";
const isDebugMode = launchParams.has("debug");
document.documentElement.classList.toggle("layer-mode", isLayerMode);
document.documentElement.classList.toggle("panel-mode", isPanelMode);
document.body.classList.toggle("layer-mode", isLayerMode);
document.body.classList.toggle("panel-mode", isPanelMode);
elements.shell.classList.toggle("is-layer", isLayerMode);
elements.shell.classList.toggle("is-panel-window", isPanelMode);
const debugPanel = isDebugMode ? document.body.appendChild(document.createElement("pre")) : null;
if (debugPanel) {
  debugPanel.id = "petDebug";
}

function setDebugInfo(value) {
  window.__petRenderDebug = value;
  if (debugPanel) {
    debugPanel.textContent = JSON.stringify(value, null, 2);
  }
}

function drawRoundRectPath(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, width, height, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

async function configureNativeWindow(options = {}) {
  const api = await waitForNativeApi();
  if (!api) {
    return;
  }
  try {
    if (typeof api.apply_transparency === "function") {
      await api.apply_transparency();
    }
    if (typeof api.set_click_through === "function" && typeof options.clickThrough === "boolean") {
      await api.set_click_through(options.clickThrough);
    }
  } catch (error) {
    console.warn("Native desktop pet window configuration failed.", error);
  }
}

async function waitForNativeApi(timeoutMs = 3000) {
  const started = performance.now();
  if (window.pywebview?.api) {
    return window.pywebview.api;
  }
  await new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };
    const timer = window.setTimeout(finish, timeoutMs);
    window.addEventListener(
      "pywebviewready",
      () => {
        window.clearTimeout(timer);
        finish();
      },
      { once: true },
    );
    const tick = () => {
      if (window.pywebview?.api || performance.now() - started > timeoutMs) {
        window.clearTimeout(timer);
        finish();
        return;
      }
      window.setTimeout(tick, 60);
    };
    tick();
  });
  return window.pywebview?.api || null;
}

async function openNativePanelWindow() {
  const api = window.pywebview?.api || null;
  if (!api || typeof api.open_panel_window !== "function") {
    window.open("/desktop-pet/chat.html?mode=quick", "lka-pet-quick", "width=430,height=680");
    return false;
  }
  try {
    await api.open_panel_window();
    return true;
  } catch (error) {
    console.warn("Native desktop pet panel failed to open.", error);
    window.open("/desktop-pet/chat.html?mode=quick", "lka-pet-quick", "width=430,height=680");
    return false;
  }
}

class PetApi {
  async request(path, options = {}) {
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail || data));
    }
    return data;
  }

  manifest() {
    return this.request("/pet/manifest");
  }

  patchState(patch) {
    return this.request("/pet/state", { method: "PUT", body: JSON.stringify(patch) });
  }

  action(action, payload = {}) {
    return this.request("/pet/action", { method: "POST", body: JSON.stringify({ action, payload }) });
  }

  chat(message, conversationId) {
    return this.request("/pet/chat", { method: "POST", body: JSON.stringify({ message, conversation_id: conversationId, mode: "wait" }) });
  }

  async streamAgent(message, conversationId, options, onEvent) {
    const llm = { response_mode: "stream" };
    if (options.model) llm.model = options.model;
    const response = await fetch("/agent/turn/stream", { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify({ session_id: conversationId, user_input: message, llm }) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    const consume = (block) => { let event = "message"; const data = []; block.split(/\r?\n/).forEach((line) => { if (line.startsWith("event:")) event = line.slice(6).trim(); else if (line.startsWith("data:")) data.push(line.slice(5).trim()); }); if (data.length) { try { onEvent(event, JSON.parse(data.join("\n"))); } catch (error) { console.warn("Invalid agent event", error); } } };
    while (true) { const part = await reader.read(); if (part.done) break; buffer += decoder.decode(part.value, { stream: true }); const blocks = buffer.split(/\r?\n\r?\n/); buffer = blocks.pop() || ""; blocks.forEach(consume); }
    if (buffer.trim()) consume(buffer);
  }

  approveShell(approvalId) {
    return this.request(`/shell/approvals/${encodeURIComponent(approvalId)}/approve`, {
      method: "POST",
    });
  }

  rejectShell(approvalId) {
    return this.request(`/shell/approvals/${encodeURIComponent(approvalId)}/reject`, {
      method: "POST",
    });
  }
}

class CanvasPetRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.animation = "idle";
    this.mood = "idle";
    this.scale = 1;
    this.accent = "#3f7f6b";
    this.startedAt = performance.now();
    this.frame = 0;
    this.running = false;
  }

  mount() {
    this.running = true;
    requestAnimationFrame((now) => this.draw(now));
  }

  setState(state, profile) {
    this.animation = state.animation || "idle";
    this.mood = state.mood || "idle";
    this.scale = state.scale || 1;
    this.accent = profile?.accent || "#3f7f6b";
  }

  draw(now) {
    if (!this.running) {
      return;
    }
    this.frame = (now - this.startedAt) / 1000;
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    const t = this.frame;
    const bob = Math.sin(t * 2.2) * 5;
    const wave = this.animation === "wave" ? Math.sin(t * 11) * 18 : 0;
    const poke = this.animation === "poke" ? Math.sin(t * 18) * 8 : 0;
    const sleep = this.animation === "sleep";
    const think = this.animation === "think";
    const work = this.animation === "work";
    const bodyY = 210 + bob + poke;
    const centerX = w / 2;
    const scale = this.scale;

    ctx.save();
    ctx.translate(centerX, bodyY);
    ctx.scale(scale, scale);
    ctx.translate(-centerX, -bodyY);

    this.shadow(ctx, centerX, 316, 74, 16);
    this.body(ctx, centerX, bodyY, sleep);
    this.head(ctx, centerX, bodyY - 86, sleep, think, work);
    this.arms(ctx, centerX, bodyY - 24, wave, work);
    this.accessory(ctx, centerX, bodyY - 142, think, work);

    ctx.restore();
    requestAnimationFrame((next) => this.draw(next));
  }

  shadow(ctx, x, y, rx, ry) {
    ctx.save();
    ctx.fillStyle = "rgba(19, 33, 29, 0.14)";
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  body(ctx, x, y, sleep) {
    ctx.save();
    ctx.fillStyle = "#f7fbfa";
    ctx.strokeStyle = "rgba(19, 33, 29, 0.22)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    drawRoundRectPath(ctx, x - 48, y - 74, 96, 132, 28);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = this.accent;
    ctx.beginPath();
    drawRoundRectPath(ctx, x - 28, y - 52, 56, 76, 16);
    ctx.fill();

    ctx.fillStyle = sleep ? "#6d7d78" : "#dfece8";
    ctx.fillRect(x - 22, y + 40, 18, 44);
    ctx.fillRect(x + 4, y + 40, 18, 44);
    ctx.restore();
  }

  head(ctx, x, y, sleep, think, work) {
    ctx.save();
    ctx.fillStyle = "#fff8ef";
    ctx.strokeStyle = "rgba(19, 33, 29, 0.22)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    drawRoundRectPath(ctx, x - 56, y - 48, 112, 92, 34);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#3b2f2a";
    ctx.beginPath();
    ctx.arc(x - 28, y - 8, 5, 0, Math.PI * 2);
    ctx.arc(x + 28, y - 8, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#3b2f2a";
    ctx.lineWidth = 3;
    ctx.beginPath();
    if (sleep) {
      ctx.moveTo(x - 36, y - 8);
      ctx.quadraticCurveTo(x - 28, y - 2, x - 20, y - 8);
      ctx.moveTo(x + 20, y - 8);
      ctx.quadraticCurveTo(x + 28, y - 2, x + 36, y - 8);
    } else if (work) {
      ctx.moveTo(x - 34, y - 16);
      ctx.lineTo(x - 20, y - 12);
      ctx.moveTo(x + 20, y - 12);
      ctx.lineTo(x + 34, y - 16);
    } else {
      ctx.arc(x, y + 10, think ? 10 : 14, 0.15 * Math.PI, 0.85 * Math.PI);
    }
    ctx.stroke();

    ctx.fillStyle = this.accent;
    ctx.beginPath();
    drawRoundRectPath(ctx, x - 46, y - 58, 92, 28, 14);
    ctx.fill();
    ctx.restore();
  }

  arms(ctx, x, y, wave, work) {
    ctx.save();
    ctx.strokeStyle = "#fff8ef";
    ctx.lineWidth = 18;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x - 46, y);
    ctx.lineTo(x - 82, y + 38);
    ctx.moveTo(x + 46, y);
    if (work) {
      ctx.lineTo(x + 86, y + 14);
    } else {
      ctx.lineTo(x + 82, y + 38 - wave);
    }
    ctx.stroke();
    ctx.restore();
  }

  accessory(ctx, x, y, think, work) {
    ctx.save();
    ctx.fillStyle = think ? "#6b73c8" : this.accent;
    ctx.globalAlpha = 0.92;
    if (think) {
      ctx.beginPath();
      ctx.arc(x + 74, y + 18, 8, 0, Math.PI * 2);
      ctx.arc(x + 96, y + 2, 6, 0, Math.PI * 2);
      ctx.arc(x + 116, y - 16, 4, 0, Math.PI * 2);
      ctx.fill();
    } else if (work) {
      ctx.beginPath();
      drawRoundRectPath(ctx, x + 62, y + 48, 46, 30, 7);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(x - 50, y + 46);
      ctx.lineTo(x - 78, y + 10);
      ctx.lineTo(x - 32, y + 26);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
}

class SpinePetRenderer {
  constructor(mount, canvasRenderer) {
    this.mount = mount;
    this.canvasRenderer = canvasRenderer;
    this.canvas = document.createElement("canvas");
    this.canvas.className = "spine-canvas";
    this.gl = null;
    this.shader = null;
    this.batcher = null;
    this.mvp = null;
    this.assetManager = null;
    this.skeletonRenderer = null;
    this.skeleton = null;
    this.skeletonData = null;
    this.animationState = null;
    this.animationStateData = null;
    this.profile = null;
    this.loadedKey = "";
    this.currentAnimation = "";
    this.lastFrame = 0;
    this.frameRequest = 0;
    this.debugFrames = 0;
    this.boundsOffset = null;
    this.boundsSize = null;
    this.boundsTemp = [];
    this.stateScale = 1;
    this.pixelRatio = window.devicePixelRatio || 1;
    this.resourceNames = null;
    this.active = false;
  }

  async tryMount(profile, state) {
    if (!spine?.webgl) {
      this.deactivate();
      return false;
    }
    const config = profile?.spine;
    if (config?.runtime !== "spine-webgl" || !config?.skeleton_url || !config?.atlas_url || !config?.texture_url) {
      this.deactivate();
      return false;
    }

    try {
      const key = `${config.skeleton_url}|${config.atlas_url}|${config.texture_url}`;
      if (!this.active || this.loadedKey !== key) {
        await this.loadProfile(profile, key);
      }
      this.setState(state, profile);
      return true;
    } catch (error) {
      console.warn("Spine renderer failed, falling back to canvas renderer.", error);
      this.deactivate();
      setDebugInfo({ stage: "error", message: error?.message || String(error), stack: error?.stack || "" });
      return false;
    }
  }

  async loadProfile(profile, key) {
    this.disposeScene();
    this.profile = profile;
    this.loadedKey = key;
    this.currentAnimation = "";
    this.mount.replaceChildren(this.canvas);
    this.mount.classList.add("is-active");
    this.canvasRenderer.canvas.style.display = "none";

    this.mvp = new spine.webgl.Matrix4();
    this.boundsOffset = new spine.Vector2();
    this.boundsSize = new spine.Vector2();

    this.resizeCanvas();
    this.gl = this.canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
    });
    if (!this.gl) {
      throw new Error("当前窗口不支持 WebGL，已回退到 Canvas 小人。");
    }

    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
    this.shader = spine.webgl.Shader.newTwoColoredTextured(this.gl);
    this.batcher = new spine.webgl.PolygonBatcher(this.gl, true);
    this.skeletonRenderer = new spine.webgl.SkeletonRenderer(new spine.webgl.ManagedWebGLRenderingContext(this.gl), true);
    this.assetManager = new spine.webgl.AssetManager(this.gl);
    this.resourceNames = await this.queueAssets(profile.spine);

    await this.waitForAssets();

    const atlas = this.assetManager.get(this.resourceNames.atlas);
    const binary = new spine.SkeletonBinary(new spine.AtlasAttachmentLoader(atlas));
    binary.scale = Number(profile.spine.skeleton_scale || 0.5) * this.pixelRatio;
    this.skeletonData = binary.readSkeletonData(this.assetManager.get(this.resourceNames.skeleton));
    this.skeleton = new spine.Skeleton(this.skeletonData);
    this.skeleton.setToSetupPose();
    this.positionSkeleton();

    this.animationStateData = new spine.AnimationStateData(this.skeletonData);
    this.animationStateData.defaultMix = 0.18;
    this.configureMixes(profile);
    this.animationState = new spine.AnimationState(this.animationStateData);
    this.writeDebug("loaded");

    this.active = true;
    this.lastFrame = performance.now();
    this.frameRequest = requestAnimationFrame((now) => this.render(now));
  }

  async queueAssets(config) {
    if (typeof this.assetManager.loadBinary === "function" && typeof this.assetManager.setRawDataURI === "function") {
      const names = await this.loadAssetDataUris(config);
      this.assetManager.loadBinary(names.skeleton);
      this.assetManager.loadTextureAtlas(names.atlas);
      return names;
    }

    const names = {
      skeleton: config.skeleton_url,
      atlas: config.atlas_url,
      texture: config.texture_url,
    };
    if (typeof this.assetManager.loadData === "function") {
      this.assetManager.loadData(names.skeleton);
    } else {
      throw new Error("当前 Spine runtime 不支持二进制 skel 加载。");
    }
    this.assetManager.loadTextureAtlas(names.atlas);
    return names;
  }

  async loadAssetDataUris(config) {
    const names = {
      skeleton: this.fileName(config.skeleton_url),
      atlas: this.fileName(config.atlas_url),
      texture: this.fileName(config.texture_url),
    };
    const entries = [
      [names.skeleton, config.skeleton_url],
      [names.atlas, config.atlas_url],
      [names.texture, config.texture_url],
    ];
    const dataUris = await Promise.all(entries.map(([, url]) => this.fetchAsDataUri(url)));
    entries.forEach(([name], index) => {
      this.assetManager.setRawDataURI(name, dataUris[index]);
    });
    return names;
  }

  fileName(url) {
    const path = new URL(url, window.location.href).pathname;
    return decodeURIComponent(path.substring(path.lastIndexOf("/") + 1));
  }

  async fetchAsDataUri(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Spine 资源加载失败：${url}`);
    }
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error(`无法读取资源：${url}`));
      reader.readAsDataURL(blob);
    });
  }

  waitForAssets() {
    const startedAt = performance.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (!this.assetManager) {
          reject(new Error("Spine asset manager was disposed."));
          return;
        }
        if (this.assetManager.hasErrors()) {
          reject(new Error(JSON.stringify(this.assetManager.getErrors())));
          return;
        }
        if (this.assetManager.isLoadingComplete()) {
          resolve();
          return;
        }
        if (performance.now() - startedAt > 15000) {
          reject(new Error("Spine 资源加载超时。"));
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  configureMixes(profile) {
    const names = new Set(Object.values(profile?.spine?.animation_map || {}));
    for (const from of names) {
      for (const to of names) {
        if (from !== to && this.hasAnimation(from) && this.hasAnimation(to)) {
          this.animationStateData.setMix(from, to, 0.18);
        }
      }
    }
  }

  setState(state, profile) {
    if (!this.active || !this.animationState) {
      return;
    }
    this.profile = profile || this.profile;
    this.stateScale = Number(state?.scale || 1);
    this.setAnimation(state?.animation || profile?.default_animation || "idle");
  }

  setAnimation(animation) {
    if (!this.active || !this.animationState) {
      return;
    }
    const resolved = this.resolveAnimation(animation);
    const oneShot = animation === "poke" || animation === "wave";
    if (!resolved || (!oneShot && resolved === this.currentAnimation)) {
      return;
    }

    this.animationState.setAnimation(0, resolved, !oneShot);
    if (oneShot) {
      const idle = this.resolveAnimation("idle");
      if (idle && idle !== resolved) {
        this.animationState.addAnimation(0, idle, true, 0);
      }
      this.currentAnimation = idle || resolved;
      return;
    }
    this.currentAnimation = resolved;
  }

  resolveAnimation(animation) {
    const profile = this.profile;
    const map = profile?.spine?.animation_map || {};
    const candidates = [
      map[animation],
      animation,
      map[profile?.default_animation],
      map.idle,
      profile?.default_animation,
      "Relax",
      "Default",
      "Idle",
    ].filter(Boolean);
    return candidates.find((name) => this.hasAnimation(name)) || this.skeletonData?.animations?.[0]?.name || "";
  }

  hasAnimation(name) {
    return Boolean(name && this.skeletonData?.findAnimation(name));
  }

  render(now) {
    if (!this.active || !this.gl || !this.shader || !this.batcher || !this.skeletonRenderer || !this.skeleton || !this.animationState) {
      return;
    }

    const delta = Math.min((now - this.lastFrame) / 1000, 0.08);
    this.lastFrame = now;

    this.resizeCanvas();
    this.gl.clearColor(0, 0, 0, 0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);

    this.animationState.update(delta);
    this.animationState.apply(this.skeleton);
    this.positionSkeleton();

    this.shader.bind();
    this.shader.setUniformi(spine.webgl.Shader.SAMPLER, 0);
    this.shader.setUniform4x4f(spine.webgl.Shader.MVP_MATRIX, this.mvp.values);
    this.batcher.begin(this.shader);
    this.skeletonRenderer.premultipliedAlpha = Boolean(this.profile?.spine?.premultiplied_alpha);
    this.skeletonRenderer.draw(this.batcher, this.skeleton);
    this.batcher.end();
    this.shader.unbind();

    this.debugFrames += 1;
    if (this.debugFrames % 30 === 0) {
      this.writeDebug("render");
    }

    this.frameRequest = requestAnimationFrame((next) => this.render(next));
  }

  writeDebug(stage) {
    const info = {
      stage,
      active: this.active,
      loadedKey: this.loadedKey,
      canvas: {
        width: this.canvas.width,
        height: this.canvas.height,
        rect: this.canvas.getBoundingClientRect().toJSON?.(),
      },
      animations: this.skeletonData?.animations?.map((item) => item.name) || [],
      currentAnimation: this.currentAnimation,
      bounds: {
        x: this.boundsOffset.x,
        y: this.boundsOffset.y,
        width: this.boundsSize.x,
        height: this.boundsSize.y,
      },
      skeleton: this.skeleton
        ? { x: this.skeleton.x, y: this.skeleton.y, scaleX: this.skeleton.scaleX, scaleY: this.skeleton.scaleY }
        : null,
    };
    setDebugInfo(info);
  }

  resizeCanvas() {
    const rect = this.mount.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.round(rect.width || this.canvas.clientWidth || 320));
    const cssHeight = Math.max(1, Math.round(rect.height || this.canvas.clientHeight || 360));
    this.pixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(cssWidth * this.pixelRatio));
    const height = Math.max(1, Math.round(cssHeight * this.pixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      if (this.gl) {
        this.gl.viewport(0, 0, width, height);
      }
      this.mvp.ortho2d(0, 0, width, height);
    }
  }

  positionSkeleton() {
    const config = this.profile?.spine || {};
    this.skeleton.scaleX = this.stateScale;
    this.skeleton.scaleY = this.stateScale;
    this.skeleton.x = 0;
    this.skeleton.y = 0;
    this.skeleton.updateWorldTransform();
    this.skeleton.getBounds(this.boundsOffset, this.boundsSize, this.boundsTemp);

    const hasBounds = [this.boundsOffset.x, this.boundsOffset.y, this.boundsSize.x, this.boundsSize.y].every(Number.isFinite)
      && this.boundsSize.x > 0
      && this.boundsSize.y > 0;
    const xOffset = Number(config.x_offset || 0) * this.pixelRatio;
    const floorOffset = Number(config.floor_offset ?? 24) * this.pixelRatio;

    if (hasBounds) {
      this.skeleton.x = this.canvas.width / 2 - this.boundsOffset.x - this.boundsSize.x / 2 + xOffset;
      this.skeleton.y = floorOffset - this.boundsOffset.y;
    } else {
      this.skeleton.x = this.canvas.width / 2 + xOffset;
      this.skeleton.y = floorOffset;
    }
    this.skeleton.updateWorldTransform();
  }

  deactivate() {
    this.disposeScene();
    this.active = false;
    this.loadedKey = "";
    this.currentAnimation = "";
    this.profile = null;
    this.mount.replaceChildren();
    this.mount.classList.remove("is-active");
    this.canvasRenderer.canvas.style.display = "block";
  }

  disposeScene() {
    if (this.frameRequest) {
      cancelAnimationFrame(this.frameRequest);
      this.frameRequest = 0;
    }
    if (this.assetManager) {
      this.assetManager.removeAll();
      this.assetManager = null;
    }
    if (this.batcher) {
      this.batcher.dispose();
      this.batcher = null;
    }
    if (this.shader) {
      this.shader.dispose();
      this.shader = null;
    }
    this.gl = null;
    this.skeletonRenderer = null;
    this.skeleton = null;
    this.skeletonData = null;
    this.animationState = null;
    this.animationStateData = null;
    this.resourceNames = null;
    setDebugInfo({ stage: "inactive" });
  }
}

class PetApp {
  constructor() {
    this.api = new PetApi();
    this.manifest = null;
    this.state = null;
    this.conversationId = `pet-${crypto.randomUUID?.() || Date.now()}`;
    this.canvasRenderer = isPanelMode ? null : new CanvasPetRenderer(elements.canvas);
    this.spineRenderer = isPanelMode ? null : new SpinePetRenderer(elements.spineMount, this.canvasRenderer);
    this.dragStart = null;
    this.wasDragged = false;
    this.agentApprovalCard = null;
    this.agentApprovalSubmitting = false;
  }

  async start() {
    this.bindEvents();
    if (this.canvasRenderer) {
      this.canvasRenderer.mount();
    }
    if (isLayerMode) {
      await configureNativeWindow({ clickThrough: false });
    }
    await this.refreshManifest();
    this.addMessage("pet", "你好，我可以从这里打开交互面板，也可以直接把问题交给后端 Agent。");
    this.refreshAgentApprovalQueue().catch(() => {});
    window.setInterval(() => {
      if (!document.hidden) this.refreshAgentApprovalQueue().catch(() => {});
    }, 20000);
  }

  bindEvents() {
    if (!isPanelMode) {
      elements.petHitbox.addEventListener("mousedown", (event) => this.beginPetDrag(event));
      elements.petHitbox.addEventListener("click", (event) => this.togglePetMenu(event));
      elements.petHitbox.addEventListener("contextmenu", (event) => this.openPetMenu(event));
    }
    elements.petMenu.addEventListener("click", (event) => this.handlePetMenu(event));
    document.addEventListener("click", (event) => {
      if (!elements.petMenu.contains(event.target) && !elements.petHitbox.contains(event.target)) {
        this.closePetMenu();
      }
    });
    window.addEventListener("resize", () => this.closePetMenu());
    elements.openPanel.addEventListener("click", () => this.openInteractionPanel());
    elements.closePanel.addEventListener("click", () => {
      if (isPanelMode) {
        window.close();
        return;
      }
      this.runAction("close_interaction");
    });
    elements.wavePet.addEventListener("click", () => this.runAction("wave"));
    elements.sleepPet.addEventListener("click", () => this.runAction("sleep"));
    elements.profileSelect.addEventListener("change", (event) => {
      this.runAction("switch_profile", { profile_id: event.target.value });
    });
    elements.animationSelect.addEventListener("change", (event) => {
      this.runAction("set_animation", { animation: event.target.value });
    });
    elements.scaleInput.addEventListener("input", (event) => {
      this.patchState({ scale: Number(event.target.value) });
    });
    elements.manualToggle.addEventListener("change", (event) => {
      this.runAction("toggle_manual", { enabled: event.target.checked });
    });
    elements.transparentToggle.addEventListener("change", (event) => {
      this.runAction("toggle_transparent", { enabled: event.target.checked });
    });
    elements.composer.addEventListener("submit", (event) => {
      event.preventDefault();
      this.sendMessage();
    });
  }

  beginPetDrag(event) {
    if (event.button !== 0) {
      return;
    }
    this.dragStart = { x: event.screenX, y: event.screenY };
    this.wasDragged = false;

    const trackDrag = (moveEvent) => {
      if (!this.dragStart) {
        return;
      }
      const movedX = Math.abs(moveEvent.screenX - this.dragStart.x);
      const movedY = Math.abs(moveEvent.screenY - this.dragStart.y);
      if (movedX > 4 || movedY > 4) {
        this.wasDragged = true;
      }
    };
    const endDrag = () => {
      window.removeEventListener("mousemove", trackDrag);
      window.removeEventListener("mouseup", endDrag);
      this.dragStart = null;
    };

    window.addEventListener("mousemove", trackDrag);
    window.addEventListener("mouseup", endDrag);
  }

  togglePetMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    if (this.wasDragged) {
      this.wasDragged = false;
      return;
    }
    if (elements.petMenu.hidden) {
      this.openPetMenu(event);
    } else {
      this.closePetMenu();
    }
  }

  openPetMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 190;
    const menuHeight = 228;
    const left = Math.min(window.innerWidth - menuWidth - 10, event.clientX + 10);
    const top = Math.min(window.innerHeight - menuHeight - 10, event.clientY + 8);
    elements.petMenu.style.left = `${Math.max(10, left)}px`;
    elements.petMenu.style.top = `${Math.max(10, top)}px`;
    elements.petMenu.hidden = false;
  }

  closePetMenu() {
    elements.petMenu.hidden = true;
  }

  handlePetMenu(event) {
    const button = event.target.closest("[data-menu-action]");
    if (!button) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.closePetMenu();
    const action = button.dataset.menuAction;
    if (action === "set_animation") {
      this.runAction(action, { animation: button.dataset.animation || "idle" });
      return;
    }
    if (action === "open_interaction") {
      this.openInteractionPanel();
      return;
    }
    if (action === "open_workbench") {
      window.open("/desktop-pet/chat.html?mode=work", "lka-workbench", "width=1320,height=840");
      return;
    }
    this.runAction(action);
  }

  async refreshManifest() {
    this.manifest = await this.api.manifest();
    if (isPanelMode && !this.manifest.state?.panel_open) {
      const response = await this.api.action("open_interaction");
      this.manifest.state = response.state;
    } else if (isLayerMode && this.manifest.state?.panel_open) {
      const response = await this.api.action("close_interaction");
      this.manifest.state = response.state;
    }
    this.applyState(this.manifest.state);
    this.populateProfileSelect();
    this.populateAnimationSelect();
  }

  currentProfile() {
    return this.manifest?.profiles?.find((profile) => profile.id === this.state?.active_profile_id);
  }

  populateProfileSelect() {
    elements.profileSelect.innerHTML = "";
    for (const profile of this.manifest.profiles) {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = profile.name;
      elements.profileSelect.appendChild(option);
    }
    elements.profileSelect.value = this.state.active_profile_id;
  }

  populateAnimationSelect() {
    const profile = this.currentProfile();
    elements.animationSelect.innerHTML = "";
    for (const animation of profile?.animations || ["idle"]) {
      const option = document.createElement("option");
      option.value = animation;
      option.textContent = animation;
      elements.animationSelect.appendChild(option);
    }
    elements.animationSelect.value = this.state.animation;
  }

  async applyState(state) {
    this.state = state;
    const profile = this.currentProfile();
    elements.shell.dataset.panel = isPanelMode || (!isLayerMode && state.panel_open) ? "open" : "closed";
    elements.shell.style.setProperty("--accent", profile?.accent || "#3f7f6b");
    elements.bubble.textContent = state.bubble || "";
    elements.profileSelect.value = state.active_profile_id;
    elements.animationSelect.value = state.animation;
    elements.scaleInput.value = String(state.scale);
    elements.manualToggle.checked = state.manual_mode;
    elements.transparentToggle.checked = state.transparent_mode;
    configureNativeWindow({ clickThrough: false });
    if (isLayerMode) {
      window.setTimeout(() => configureNativeWindow({ clickThrough: false }), 250);
      window.setTimeout(() => configureNativeWindow({ clickThrough: false }), 900);
    }
    if (this.canvasRenderer) {
      this.canvasRenderer.setState(state, profile);
    }
    const mountedSpine = this.spineRenderer ? await this.spineRenderer.tryMount(profile, state) : false;
    if (mountedSpine && this.spineRenderer) {
      this.spineRenderer.setAnimation(state.animation);
    }
    this.populateAnimationSelect();
  }

  async runAction(action, payload = {}) {
    try {
      const response = await this.api.action(action, payload);
      await this.applyState(response.state);
    } catch (error) {
      this.reportError(error);
    }
  }

  async openInteractionPanel() {
    await openNativePanelWindow();
    await this.runAction("wave");
  }

  async patchState(patch) {
    try {
      const state = await this.api.patchState(patch);
      await this.applyState(state);
    } catch (error) {
      this.reportError(error);
    }
  }

  async sendMessage() {
    const message = elements.messageInput.value.trim();
    if (!message) {
      return;
    }
    elements.messageInput.value = "";
    this.addMessage("user", message);
    const options = { model: elements.agentModelInput?.value.trim() || "", stream: elements.agentStreamToggle?.checked !== false, workspace: elements.agentWorkspaceInput?.value.trim() || "", safetyMode: elements.agentSafetyMode?.value || "backend" };
    try { localStorage.setItem("agentic-rag-pet-agent-settings", JSON.stringify(options)); } catch (ignored) {}
    await this.patchState({ animation: "think", mood: "thinking", bubble: "正在思考。", panel_open: true });

    try {
      if (!options.stream) {
        const response = await this.api.chat(message, this.conversationId); await this.applyState(response.state);
        const pendingApproval = response.result?.pending_approval || null; const answer = response.result?.answer || response.result?.grounded_answer || "已完成。";
        if (pendingApproval?.approval_id) this.addApprovalMessage(pendingApproval); else this.addMessage("pet", answer);
      } else {
        const answerNode = this.addMessage("pet", "正在连接 Agent…"); let answer = "";
        await this.api.streamAgent(message, this.conversationId, options, (event, data) => {
          const payload = data?.payload || {};
          if (event === "llm_delta" && payload.display_target === "assistant_answer") { answer = payload.content_snapshot || (answer + (payload.delta || "")); window.PetMarkdown.schedule(answerNode, answer); this.scrollChat(); }
          else if (event === "safety_review_required") this.addSafetyReviewMessage(payload.safety_review || payload.review || payload);
          else if (event === "llm_started") window.PetMarkdown.render(answerNode, `LLM 正在${data.stage || "处理"}…`);
          else if (event === "tool_started") window.PetMarkdown.render(answerNode, `正在调用 ${data.tool_name || "工具"}…`);
          else if (event === "final_answer" && (payload.metadata?.answer || data?.message)) { answer = payload.metadata?.answer || data.message; window.PetMarkdown.render(answerNode, answer); }
          else if (event === "run_completed") window.PetMarkdown.render(answerNode, answer || "本轮完成。");
        });
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  addMessage(kind, text) {
    const item = document.createElement("div");
    item.className = `message ${kind}` + (kind === "pet" ? " markdown-body" : "");
    if (kind === "pet") window.PetMarkdown.render(item, text);
    else item.textContent = text;
    elements.chatLog.appendChild(item);
    elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
    return item;
  }

  scrollChat() { elements.chatLog.scrollTop = elements.chatLog.scrollHeight; }

  addSafetyReviewMessage(review) {
    if (!review?.review_id) return;
    this.refreshAgentApprovalQueue().catch((error) => {
      this.addMessage("pet", `安全审批队列暂不可用：${error.message || error}`);
    });
  }

  async refreshAgentApprovalQueue() {
    const response = await fetch("/agent/safety-reviews", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const reviews = Array.isArray(payload?.reviews) ? payload.reviews : [];
    const head = reviews[0];
    if (!head?.review_id) {
      this.agentApprovalCard?.remove();
      this.agentApprovalCard = null;
      return;
    }
    const item = this.agentApprovalCard?.isConnected
      ? this.agentApprovalCard : this.addMessage("pet approval", "");
    this.agentApprovalCard = item;
    item.textContent = `安全审批队列：第 1 项 / 共 ${reviews.length} 项 · ${head.tool_name || "工具调用"}（${head.tool_risk || "medium"}）`;
    ["approve", "reject"].forEach((decision) => {
      const button = document.createElement("button");
      button.textContent = decision === "approve" ? "允许当前项" : "拒绝当前项";
      button.className = "approval-button";
      button.disabled = this.agentApprovalSubmitting;
      button.onclick = async () => {
        if (this.agentApprovalSubmitting) return;
        this.agentApprovalSubmitting = true;
        item.querySelectorAll("button").forEach((control) => { control.disabled = true; });
        try {
          const latest = await fetch("/agent/safety-reviews", { headers: { Accept: "application/json" } });
          if (!latest.ok) throw new Error(`HTTP ${latest.status}`);
          const current = await latest.json();
          if (current?.reviews?.[0]?.review_id !== head.review_id) {
            item.textContent = "审批队列顺序已变化，正在刷新…";
            return;
          }
          const decided = await fetch(`/agent/safety-reviews/${encodeURIComponent(head.review_id)}/decision`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ decision, reason: "用户通过桌宠审批队列决定", decided_by: "user" })
          });
          if (decided.status === 409) {
            item.textContent = "审批队列顺序已变化，正在刷新…";
            return;
          }
          if (!decided.ok) throw new Error(`HTTP ${decided.status}`);
        } catch (error) {
          item.textContent = `审批提交失败：${error.message || error}`;
        } finally {
          this.agentApprovalSubmitting = false;
          this.refreshAgentApprovalQueue().catch(() => {});
        }
      };
      item.appendChild(button);
    });
  }

  addApprovalMessage(approval) {
    const approvalId = String(approval?.approval_id || "").trim();
    if (!approvalId) {
      return;
    }
    const command = String(approval?.command || "").trim();
    const risk = String(approval?.risk_level || "medium").trim();
    const reason = String(approval?.reason || "").trim();

    const item = document.createElement("div");
    item.className = "message pet approval";

    const title = document.createElement("div");
    title.className = "approval-title";
    title.textContent = `审批待确认 | risk=${risk} | id=${approvalId}`;
    item.appendChild(title);

    if (reason) {
      const reasonNode = document.createElement("div");
      reasonNode.className = "approval-reason";
      reasonNode.textContent = reason;
      item.appendChild(reasonNode);
    }

    if (command) {
      const commandNode = document.createElement("pre");
      commandNode.className = "approval-command";
      commandNode.textContent = command;
      item.appendChild(commandNode);
    }

    const actions = document.createElement("div");
    actions.className = "approval-actions";
    const approveButton = document.createElement("button");
    approveButton.type = "button";
    approveButton.className = "approval-button approve";
    approveButton.textContent = "Approve";
    const rejectButton = document.createElement("button");
    rejectButton.type = "button";
    rejectButton.className = "approval-button reject";
    rejectButton.textContent = "Reject";
    actions.appendChild(approveButton);
    actions.appendChild(rejectButton);
    item.appendChild(actions);

    approveButton.addEventListener("click", async () => {
      approveButton.disabled = true;
      rejectButton.disabled = true;
      try {
        const payload = await this.api.approveShell(approvalId);
        const result = payload?.result || {};
        const assistantMessage = String(payload?.assistant_message || "").trim();
        const message = assistantMessage || (() => {
          const finalCommand = String(result.command || command || "").trim();
          const exitCode = String(result.exit_code ?? "");
          if (!finalCommand) {
            return exitCode === "0"
              ? "好的，命令已经执行完成。"
              : `我已执行命令，但执行结果不是成功状态（exit_code=${exitCode}）。`;
          }
          return `命令执行完成：${finalCommand} (exit_code=${exitCode})`;
        })();
        this.addMessage("pet", message);
      } catch (error) {
        this.addMessage("pet", `审批执行失败：${error?.message || String(error)}`);
      }
    });

    rejectButton.addEventListener("click", async () => {
      approveButton.disabled = true;
      rejectButton.disabled = true;
      try {
        await this.api.rejectShell(approvalId);
        this.addMessage("pet", "已拒绝该命令审批。");
      } catch (error) {
        this.addMessage("pet", `审批拒绝失败：${error?.message || String(error)}`);
      }
    });

    elements.chatLog.appendChild(item);
    elements.chatLog.scrollTop = elements.chatLog.scrollHeight;
  }

  reportError(error) {
    const message = error?.message || String(error);
    elements.bubble.textContent = message;
    this.addMessage("pet", `接口调用失败：${message}`);
  }
}

const app = new PetApp();
window.__petApp = app;
try {
  const savedAgentSettings = JSON.parse(localStorage.getItem("agentic-rag-pet-agent-settings") || "{}");
  if (elements.agentWorkspaceInput) elements.agentWorkspaceInput.value = savedAgentSettings.workspace || "";
  if (elements.agentModelInput) elements.agentModelInput.value = savedAgentSettings.model || "";
  if (elements.agentStreamToggle) elements.agentStreamToggle.checked = savedAgentSettings.stream !== false;
  if (elements.agentSafetyMode) elements.agentSafetyMode.value = savedAgentSettings.safetyMode || "backend";
} catch (ignored) {}
if (elements.indexWorkspace) {
  elements.indexWorkspace.addEventListener("click", async () => {
    const workspace = elements.agentWorkspaceInput?.value.trim() || "";
    if (!workspace) { elements.bubble.textContent = "请先填写 workspace 路径。"; return; }
    elements.indexWorkspace.disabled = true;
    try {
      const response = await fetch("/workspaces/index", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspace, source_frontend: "windows-pet", options: { recursive: true, skip_hidden: true } }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || `HTTP ${response.status}`);
      elements.bubble.textContent = `Workspace 已索引：${data.indexed_files || 0} 个文件。`;
    } catch (error) { elements.bubble.textContent = `Workspace 索引失败：${error.message || error}`; }
    finally { elements.indexWorkspace.disabled = false; }
  });
}
app.start().catch((error) => {
  elements.bubble.textContent = `桌宠入口启动失败：${error.message || error}`;
});
