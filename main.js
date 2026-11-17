// 每日一句 —— CC GUI Tier-1 插件（单文件 ESM，禁止任何 import / JSX）
// 状态栏最左侧（zone:"start"）展示随机句子；打字机 / 滚动 / 渐隐 / 无 四种动画；
// 自动更新间隔可配：跨天 / 每小时 / 每 30 分钟 / 每 5 分钟 / 每分钟 / 仅手动；
// 数据源可配：内置预设（一言 + 备用接口）或自定义接口地址与返回字段映射。
const DEFAULTS = {
  url: "https://v1.hitokoto.cn/",
  textField: "hitokoto",
  fromField: "from",
  animation: "typewriter",
  interval: "daily",
};
const ANIMATIONS = ["typewriter", "scroll", "fade", "none"];
const MODES = ["off", "daily", "hour", "30min", "5min", "minute"];
const INTERVAL_MS = { minute: 60e3, "5min": 300e3, "30min": 1800e3, hour: 3600e3 };
const MIN_SCHEDULE_WAIT_MS = 1000;

function normalize(v) {
  const o = Object.assign({}, DEFAULTS);
  if (v && typeof v === "object") {
    if (typeof v.url === "string" && v.url.trim()) o.url = v.url.trim();
    if (typeof v.textField === "string" && v.textField.trim()) o.textField = v.textField.trim();
    if (typeof v.fromField === "string") o.fromField = v.fromField.trim();
    if (ANIMATIONS.indexOf(v.animation) >= 0) o.animation = v.animation;
    if (MODES.indexOf(v.interval) >= 0) o.interval = v.interval;
    else if (typeof v.daily === "boolean") o.interval = v.daily ? "daily" : "off";
  }
  return o;
}

function cfgKey(c) { return c.url + "|" + c.textField + "|" + c.fromField; }
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function dayStr(d) {
  const x = d || new Date();
  return x.getFullYear() + "-" + pad2(x.getMonth() + 1) + "-" + pad2(x.getDate());
}

function nextDue(mode, atMs, nowMs) {
  if (mode === "off") return Infinity;
  if (mode === "daily") {
    const due = new Date(nowMs);
    due.setHours(24, 0, 0, 0);
    if (due.getTime() - nowMs < MIN_SCHEDULE_WAIT_MS) due.setHours(24, 0, 0, 0);
    return due.getTime();
  }
  const iv = INTERVAL_MS[mode];
  let due = Math.ceil((Math.max(atMs, nowMs) + 1) / iv) * iv;
  if (due - nowMs < MIN_SCHEDULE_WAIT_MS) due += iv;
  return due;
}

function isFresh(rec, mode, nowMs) {
  if (!rec || typeof rec.at !== "number") return false;
  if (mode === "off") return true;
  if (mode === "daily") return rec.date === dayStr(new Date(nowMs));
  const iv = INTERVAL_MS[mode];
  return nowMs < Math.ceil((rec.at + 1) / iv) * iv;
}

function retryDelay(mode, failCount) {
  const base = 60e3;
  const d = Math.min(base * Math.pow(2, Math.max(0, failCount - 1)), 30 * 60e3);
  if (mode === "off" || mode === "daily") return d;
  return Math.min(d, INTERVAL_MS[mode]);
}

export default function activate(ctx) {
  const { createElement: h, useState, useEffect, useRef, useCallback } = ctx.react;

  const ANIM_LABELS = { typewriter: "打字机", scroll: "滚动", fade: "渐隐", none: "无（静态）" };
  const ANIM_DESCS = {
    typewriter: "逐字浮现，像在敲键盘",
    scroll: "超出宽度时横向滚动",
    fade: "淡入淡出地换句",
    none: "静态显示，不做动画",
  };
  const MODE_LABELS = { off: "不自动更新", daily: "每天一次", hour: "每小时", "30min": "每 30 分钟", "5min": "每 5 分钟", minute: "每分钟" };
  const MODE_DESCS = {
    off: "只在点击状态栏时换句",
    daily: "跨过 0 点后自动换一句",
    hour: "每到整点自动换一句",
    "30min": "每半小时自动换一句",
    "5min": "每 5 分钟自动换一句",
    minute: "每分钟自动换一句",
  };
  // 预设数据源：url + 句子字段 + 来源字段（点路径）。改内置预设等于换数据源。
  const PRESETS = [
    { id: "hitokoto", name: "一言", desc: "官方一言 · 中文语录", url: "https://v1.hitokoto.cn/", textField: "hitokoto", fromField: "from" },
    { id: "hitokoto-anime", name: "一言 · 动漫", desc: "官方一言 · 动漫与漫画台词", url: "https://v1.hitokoto.cn/?c=a&c=b&encode=json", textField: "hitokoto", fromField: "from" },
    { id: "xxapi", name: "备用 · 小小API", desc: "第三方备用接口 · 无来源字段", url: "https://v2.xxapi.cn/api/yiyan?type=hitokoto", textField: "data", fromField: "" },
  ];
  const ALLOWED_HOSTS = ["v1.hitokoto.cn", "v2.xxapi.cn"]; // manifest 里已声明 network: 授权的主机
  const K_CFG = "cfg";
  const K_CACHE = "cache";
  // 宿主只允许 emit/on 自己插件命名空间下的话题（plugin:<pluginId>:*），裸主题会被拒
  const T_CHANGED = "plugin:" + ctx.pluginId + ":cfg-changed";
  const T_CACHE_CHANGED = "plugin:" + ctx.pluginId + ":cache-changed";

  // ---------- 纯工具 ----------
  function fmtClock(ms) {
    const d = new Date(ms);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  function fmtTime(ms) {
    if (!ms) return "—";
    return dayStr(new Date(ms)) + " " + fmtClock(ms);
  }
  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch (e) { return null; }
  }
  function hostTarget(url) {
    try {
      const parsed = new URL(url);
      return parsed.hostname.toLowerCase() + (parsed.port ? ":" + parsed.port : "");
    } catch (e) { return null; }
  }
  function isAllowedUrl(url) {
    let protocol;
    try { protocol = new URL(url).protocol; } catch (e) { return false; }
    if (!/^https?:$/.test(protocol)) return false;
    const host = hostOf(url);
    const target = hostTarget(url);
    return !!host && ALLOWED_HOSTS.some((allowed) => allowed === host || allowed === target);
  }
  function configIssue(url) {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return "接口地址无法解析，请检查 URL"; }
    if (!/^https?:$/.test(parsed.protocol)) return "仅支持 http/https 接口";
    const target = hostTarget(url);
    if (!ALLOWED_HOSTS.some((allowed) => allowed === parsed.hostname.toLowerCase() || allowed === target)) {
      return "接口主机「" + target + "」尚未授权";
    }
    return null;
  }
  // 点路径取值："a.b.0.c"，数字段用于数组下标
  function getPath(obj, path) {
    if (!path) return null;
    let cur = obj;
    const segs = String(path).split(".");
    for (let i = 0; i < segs.length; i++) {
      if (cur == null) return null;
      cur = cur[segs[i]];
    }
    return cur;
  }

  // ---------- 自动更新调度 ----------
  // 缓存是否还在有效期内（决定启动时直接复用，还是重新拉取）
  // 请求失败后的重试延迟：指数退避，封顶 30 分钟；分钟级模式不允许超过用户设定的间隔
  function nextDueLabel(mode, atMs) {
    if (mode === "off") return "不自动更新（点击状态栏换句）";
    const now = Date.now();
    const due = nextDue(mode, atMs, now);
    if (mode === "daily") {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      if (dayStr(new Date(due)) === dayStr(tomorrow)) return "明天 " + fmtClock(due);
      return fmtTime(due);
    }
    return fmtClock(due);
  }

  function retryDescription(mode) {
    if (mode === "off") {
      return "关闭自动更新；没有可显示句子时，失败会按 1 / 2 / 4 / 8 / 16 / 30 分钟重试；已有句子时不会自动重试。";
    }
    if (mode === "minute") return "到点自动拉取新句；请求失败后每 1 分钟重试。";
    if (mode === "5min") return "到点自动拉取新句；请求失败后按 1 / 2 / 4 / 5 分钟退避，之后每 5 分钟重试。";
    return "到点自动拉取新句；请求失败后按 1 / 2 / 4 / 8 / 16 / 30 分钟退避，之后每 30 分钟重试。";
  }

  // 宿主未承诺 plugin_http_request 的超时语义（SDK 只为进程调用定义 timeoutMs），
  // 插件侧自行兜底：悬挂请求不能让状态栏永久停在"更新中"。
  const HTTP_TIMEOUT_MS = 15000;
  function withTimeout(promise, ms) {
    let timer = 0;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("请求超时（" + Math.round(ms / 1000) + " 秒无响应）")), ms);
    });
    return Promise.race([promise, timeout]).then(
      (v) => { clearTimeout(timer); return v; },
      (e) => { clearTimeout(timer); throw e; }
    );
  }

  async function fetchSentence(cfg) {
    const host = hostOf(cfg.url);
    if (!host) throw new Error("接口地址无法解析，请检查 URL");
    if (!/^https?:$/.test(new URL(cfg.url).protocol)) throw new Error("仅支持 http/https 接口");
    if (!isAllowedUrl(cfg.url)) {
      const target = hostTarget(cfg.url);
      throw new Error("接口主机「" + target + "」尚未授权；请在 manifest.json 的 permissions 中添加 network:" + target);
    }
    const res = await withTimeout(
      ctx.bridge.invoke("plugin_http_request", { method: "GET", url: cfg.url }),
      HTTP_TIMEOUT_MS
    );
    if (!res || typeof res.status !== "number") throw new Error("接口无响应");
    if (res.status < 200 || res.status >= 300) throw new Error("HTTP " + res.status);
    let data = res.body;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch (e) { throw new Error("返回不是合法 JSON"); }
    }
    const text = getPath(data, cfg.textField);
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("句子字段「" + cfg.textField + "」在返回中不存在或不是字符串");
    }
    let from = null;
    if (cfg.fromField) {
      const f = getPath(data, cfg.fromField);
      if (typeof f === "string" && f.trim()) from = f.trim();
    }
    return { text: text.trim(), from: from };
  }

  // ---------- 动画子组件（key 绑定句子文本：换句即重挂载、重播动画） ----------
  function Typed(props) {
    const text = props.text;
    const chars = Array.from(text);
    const [n, setN] = useState(0);
    useEffect(() => {
      setN(0);
      let i = 0; // 副作用留在 effect 内，不放进 state updater
      const id = setInterval(() => {
        i += 1;
        if (i >= chars.length) { clearInterval(id); setN(chars.length); return; }
        setN(i);
      }, 45);
      return () => clearInterval(id);
    }, [text]);
    return h("span", null, chars.slice(0, n).join(""), n < chars.length ? "▍" : "");
  }

  function Fader(props) {
    const text = props.text;
    const [shown, setShown] = useState(text);
    const [fadingOut, setFadingOut] = useState(false);
    useEffect(() => {
      if (text === shown) return;
      setFadingOut(true);
      const id = setTimeout(() => {
        setShown(text);
        setFadingOut(false);
      }, 400);
      return () => clearTimeout(id);
    }, [text]);
    return h("span", { style: { opacity: fadingOut ? 0 : 1, transition: "opacity 400ms ease" } }, shown);
  }

  // 滚动：rAF 里直接改 ref 节点的 transform，不进 state —— 避免每帧重渲染整棵子树
  function Scroller(props) {
    const text = props.text;
    const MAXW = 260;
    const innerRef = useRef(null);
    useEffect(() => {
      let pos = 0;
      let raf = 0;
      let measureRaf = 0;
      let last = 0;
      let alive = true;
      let half = 0; // 单份文本宽度（含尾部留白）——由布局与字体加载状态决定
      const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
      const start = () => { if (!raf && alive) { last = 0; raf = requestAnimationFrame(loop); } };
      const measure = () => {
        const el = innerRef.current;
        half = el && el.scrollWidth ? el.scrollWidth / 2 : 0; // 两份副本 → 半宽即一个循环
        if (half > MAXW) start();
        else {
          stop();
          pos = 0;
          if (el) el.style.transform = "none";
        }
        return half;
      };
      const loop = (now) => {
        const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
        last = now;
        pos += 40 * dt; // 40 px/s
        const el = innerRef.current;
        if (el && half > 0) {
          if (pos > half) pos -= half;
          el.style.transform = "translateX(" + (-pos) + "px)";
        }
        raf = requestAnimationFrame(loop);
      };

      measure();
      // 布局第一次返回 0 时下一帧再测；容器宽度或字体之后改变时也会重测。
      measureRaf = requestAnimationFrame(() => { measureRaf = 0; if (alive) measure(); });
      const resizeObserver = typeof ResizeObserver === "function"
        ? new ResizeObserver(() => { if (alive) measure(); })
        : null;
      if (resizeObserver && innerRef.current) resizeObserver.observe(innerRef.current);
      // 字体加载完成可能改变宽度：重测并按需启停。
      if (typeof document === "object" && document.fonts && document.fonts.ready) {
        Promise.resolve(document.fonts.ready).then(() => {
          if (!alive) return;
          measure();
        }).catch(() => {});
      }
      return () => {
        alive = false;
        stop();
        if (measureRaf) cancelAnimationFrame(measureRaf);
        if (resizeObserver) resizeObserver.disconnect();
      };
    }, [text]);
    return h("span", { style: { display: "inline-block", maxWidth: MAXW, overflow: "hidden", verticalAlign: "bottom" } },
      h("span", {
        ref: innerRef,
        style: { display: "inline-flex", whiteSpace: "nowrap", willChange: "transform" }
      },
      h("span", { style: { paddingRight: 48 } }, text),
      h("span", { "aria-hidden": true, style: { paddingRight: 48 } }, text)));
  }

  // 按当前动画渲染句子（状态栏与设置页预览共用）
  function Animated(props) {
    const text = props.text;
    const anim = props.animation;
    const [reducedMotion, setReducedMotion] = useState(() =>
      typeof window === "object" && typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false
    );
    useEffect(() => {
      if (typeof window !== "object" || typeof window.matchMedia !== "function") return;
      const media = window.matchMedia("(prefers-reduced-motion: reduce)");
      const update = (event) => setReducedMotion(event.matches);
      if (typeof media.addEventListener === "function") media.addEventListener("change", update);
      else if (typeof media.addListener === "function") media.addListener(update);
      return () => {
        if (typeof media.removeEventListener === "function") media.removeEventListener("change", update);
        else if (typeof media.removeListener === "function") media.removeListener(update);
      };
    }, []);
    if (reducedMotion) return h("span", null, text);
    if (anim === "typewriter") return h(Typed, { key: text, text: text });
    if (anim === "scroll") return h(Scroller, { key: text, text: text });
    if (anim === "fade") return h(Fader, { text: text });
    return h("span", null, text);
  }

  // ---------- 状态栏 chip ----------
  function StatusChip() {
    const [cfg, setCfg] = useState(null);
    const [entry, setEntry] = useState(null); // { text, from, at }
    const [err, setErr] = useState(null);
    const [busy, setBusy] = useState(false);
    const cfgRef = useRef(null);
    const entryRef = useRef(null);
    const appliedKeyRef = useRef(null);
    const dueRef = useRef(Infinity);  // 下次自动更新时间戳；Infinity = 不自动更新
    const [dueTick, bumpDue] = useState(0); // 调度器重排期的信号位（改 due 时 +1）
    const busyRef = useRef(false);     // 同步闸门：由 refresh 直接维护，不依赖 render 滞后
    const queuedRef = useRef(false);  // busy 期间积压的刷新请求，忙完后补跑
    const failRef = useRef(0);        // 连续失败次数（退避用）

    useEffect(() => { cfgRef.current = cfg; }, [cfg]);
    useEffect(() => { entryRef.current = entry; }, [entry]);

    // 同时写 ref 与 state：ref 给调度器读最新值，state 变化触发调度器重排期
    const setNextDue = useCallback((ms) => {
      dueRef.current = ms;
      bumpDue((n) => n + 1);
    }, []);

    // 读配置 + 订阅设置页变更
    useEffect(() => {
      let alive = true;
      const apply = (raw) => {
        if (!alive) return;
        const c = normalize(raw);
        cfgRef.current = c; // 同步写 ref：不给"状态已变、ref 未变"的滞后窗口留机会
        setCfg(c);
      };
      ctx.storage.get(K_CFG)
        .then((v) => apply(v))
        .catch(() => apply(null));
      const off = ctx.events.on(T_CHANGED, (d) => apply(d));
      return () => { alive = false; off(); };
    }, []);

    const refresh = useCallback(async () => {
      const c = cfgRef.current;
      if (!c) return;
      if (busyRef.current) { queuedRef.current = true; return; } // 忙：先记一笔，忙完按最新配置补跑
      busyRef.current = true;
      setBusy(true);
      const myKey = cfgKey(c); // 发起时的配置指纹
      try {
        const s = await fetchSentence(c);
        const now = cfgRef.current;
        if (now && cfgKey(now) !== myKey) return; // 配置已变：丢弃过期结果（不写缓存、不进 UI）
        const at = Date.now();
        const rec = { text: s.text, from: s.from, date: dayStr(), key: myKey, at: at };
        failRef.current = 0;
        const cur = cfgRef.current || c; // 用当前配置（请求期间可能改过间隔）算下次时间
        setNextDue(nextDue(cur.interval, at, at));
        await ctx.storage.set(K_CACHE, rec);
        ctx.events.emit(T_CACHE_CHANGED, rec);
        setEntry({ text: rec.text, from: rec.from, at: rec.at });
        setErr(null);
      } catch (e) {
        const now = cfgRef.current;
        if (now && cfgKey(now) === myKey) {
          setErr(String((e && e.message) || e));
          failRef.current += 1;
          const mode = now.interval;
          // 手动模式下已有句子就不再自动重试（避免违反"不自动更新"）；其余情况退避后重试
          if (mode !== "off" || !entryRef.current) {
            setNextDue(Date.now() + retryDelay(mode, failRef.current));
          } else {
            setNextDue(Infinity);
          }
        }
      } finally {
        busyRef.current = false;
        setBusy(false);
        if (queuedRef.current) {
          queuedRef.current = false;
          void refresh(); // 补跑：按最新配置重新拉取，保证换源后一定能取到新句
        }
      }
    }, []);

    // 配置就绪 / 数据源或间隔变更后：优先用仍然新鲜的缓存，否则拉新句
    useEffect(() => {
      if (!cfg) return;
      let alive = true;
      (async () => {
        setErr(null);
        const key = cfgKey(cfg);
        if (appliedKeyRef.current !== key) {
          appliedKeyRef.current = key;
          entryRef.current = null;
          setEntry(null);
        }
        let rec = null;
        try {
          const cache = await ctx.storage.get(K_CACHE);
          if (!alive) return;
          if (cache && typeof cache.text === "string" && cache.text) rec = cache;
        } catch (e) { /* 缓存读失败：直接走网络 */ }
        if (!alive) return;
        if (rec) {
          if (rec.key !== key) {
            entryRef.current = null;
            setEntry(null); // 数据源换了：旧句不再代表当前源，先清空等新句
            setErr(null);
          } else if (isFresh(rec, cfg.interval, Date.now())) {
            const cachedEntry = { text: rec.text, from: rec.from || null, at: rec.at || null };
            entryRef.current = cachedEntry;
            setEntry(cachedEntry);
            setNextDue(nextDue(cfg.interval, rec.at || Date.now(), Date.now()));
            failRef.current = 0;
            return;
          }
        }
        await refresh();
      })();
      return () => { alive = false; };
    }, [cfg ? cfgKey(cfg) + "|" + cfg.interval : null]);

    // 自动更新调度器：到点拉新句；空闲时最多 5 分钟醒一次（应对系统休眠/改表）
    useEffect(() => {
      let alive = true;
      let timer = 0;
      const arm = () => {
        if (!alive) return;
        const d = dueRef.current;
        if (!isFinite(d)) return; // 不自动更新
        const wait = Math.max(1000, Math.min(d - Date.now(), 5 * 60e3));
        timer = setTimeout(async () => {
          if (!alive) return;
          if (Date.now() >= dueRef.current) await refresh(); // refresh 内部会重排期
          if (alive) arm();
        }, wait);
      };
      arm();
      return () => { alive = false; clearTimeout(timer); };
    }, [dueTick, refresh]);

    const full = entry ? (entry.from ? entry.text + " —— " + entry.from : entry.text) : null;
    const lines = [];
    if (full) {
      lines.push(full);
      lines.push("更新：" + fmtTime(entry.at) + (busy ? "（更新中…）" : ""));
      lines.push("自动更新：" + (cfg ? MODE_LABELS[cfg.interval] : MODE_LABELS.daily));
      if (err) lines.push("上次刷新失败：" + err);
    } else if (err) {
      lines.push("加载失败：" + err);
    } else {
      lines.push("正在加载…");
    }
    lines.push("点击换一句");

    let body;
    if (!full) {
      body = h("span", { style: { opacity: 0.65 } }, busy ? "每日一句 · 加载中" : (err ? "每日一句 · 点击重试" : "每日一句 · 加载中"));
    } else {
      body = h(Animated, { text: full, animation: cfg ? cfg.animation : "typewriter" });
    }

    return h("button", {
      type: "button",
      title: lines.join("\n"),
      onClick: () => { void refresh(); },
      style: {
        display: "inline-block", maxWidth: 360, overflow: "hidden", whiteSpace: "nowrap",
        textOverflow: "ellipsis", verticalAlign: "middle", background: "transparent",
        border: "none", cursor: "pointer", font: "inherit", color: "inherit",
        padding: "0 8px", opacity: busy ? 0.7 : 1, textAlign: "left"
      }
    }, body);
  }

  // ---------- 设置页小组件 ----------
  function Segmented(props) {
    const opts = props.options || [];
    return h("div", { className: "ds-seg" },
      opts.map((o) => {
        const on = props.value === o.value;
        const cls = "ds-seg-item" + (on ? " is-on" : "") + (o.static ? " is-static" : "");
        const body = [
          h("span", { key: "l", className: "ds-seg-label" }, o.label),
          o.desc ? h("span", { key: "d", className: "ds-seg-desc" }, o.desc) : null,
        ];
        if (o.static) return h("span", { key: o.value, className: cls, title: o.desc || o.label }, body);
        return h("button", {
          key: o.value,
          type: "button",
          className: cls,
          onClick: () => props.onChange(o.value),
          title: o.desc || o.label,
        }, body);
      })
    );
  }

  function Field(props) {
    return h("label", { className: "ds-field" },
      h("span", { className: "ds-field-label" }, props.label),
      props.control,
      props.hint ? h("span", { className: "ds-hint" }, props.hint) : null
    );
  }

  // ---------- 设置页 ----------
  function SettingsSection() {
    const [form, setForm] = useState(null);
    const [note, setNote] = useState(null);  // { kind: "ok" | "err", text }
    const [test, setTest] = useState(null);  // { ok, key, text, from } | { ok: false, msg }
    const [testing, setTesting] = useState(false);
    const [cached, setCached] = useState(null); // { text, from, at, key }

    const updateCached = (c) => {
      if (!c || typeof c.text !== "string" || !c.text) return;
      const next = { text: c.text, from: c.from || null, at: c.at || null, key: c.key || null };
      setCached((prev) => !prev || (next.at || 0) >= (prev.at || 0) ? next : prev);
    };

    useEffect(() => {
      let alive = true;
      ctx.storage.get(K_CFG)
        .then((v) => { if (alive) setForm(normalize(v)); })
        .catch(() => { if (alive) setForm(normalize(null)); });
      ctx.storage.get(K_CACHE).then((c) => { if (alive) updateCached(c); }).catch(() => {});
      const off = ctx.events.on(T_CACHE_CHANGED, (c) => { if (alive) updateCached(c); });
      return () => { alive = false; off(); };
    }, []);

    if (!form) return h("div", { className: "ds-root" }, h("div", { className: "ds-loading" }, "加载中…"));

    const set = (k, v) => {
      setForm(Object.assign({}, form, { [k]: v }));
      setNote(null);
      if (k === "url" || k === "textField" || k === "fromField") setTest(null);
    };
    const target = hostTarget(form.url);
    const hostOk = isAllowedUrl(form.url);
    const issue = configIssue(form.url);
    const activePreset = PRESETS.filter((p) =>
      p.url === form.url && p.textField === form.textField && p.fromField === form.fromField
    )[0] || null;

    const persist = async (cfg) => {
      try {
        await ctx.storage.set(K_CFG, cfg);
        setForm(cfg);
        ctx.events.emit(T_CHANGED, cfg);
        const cfgIssue = configIssue(cfg.url);
        setNote(cfgIssue
          ? { kind: "warn", text: "已保存，但" + cfgIssue + "，状态栏请求会失败" }
          : { kind: "ok", text: "已保存，状态栏即时生效" });
      } catch (e) {
        setNote({ kind: "err", text: "保存失败：" + String((e && e.message) || e) });
      }
    };
    const save = () => { void persist(normalize(form)); };
    const reset = () => { setTest(null); void persist(normalize(null)); };
    const applyPreset = (p) => {
      setForm(Object.assign({}, form, { url: p.url, textField: p.textField, fromField: p.fromField }));
      setNote(null);
      setTest(null);
    };
    const runTest = async () => {
      const cfg = normalize(form);
      const key = cfgKey(cfg);
      setTesting(true); setTest(null);
      try {
        const s = await fetchSentence(cfg);
        setTest({ ok: true, key: key, text: s.text, from: s.from });
      } catch (e) {
        setTest({ ok: false, key: key, msg: String((e && e.message) || e) });
      } finally {
        setTesting(false);
      }
    };

    // 测试结果只用于本次预览；缓存只展示与当前数据源和字段映射一致的句子。
    const currentKey = cfgKey(normalize(form));
    const currentTest = test && test.ok && test.key === currentKey ? test : null;
    const currentResult = test && test.key === currentKey ? test : null;
    const currentCache = cached && cached.key === currentKey ? cached : null;
    const preview = currentTest || currentCache;
    const previewText = preview ? (preview.from ? preview.text + " —— " + preview.from : preview.text) : "";

    return h("div", { className: "ds-root" },
      h("div", { className: "ds-head" },
        h("div", { className: "ds-badge" }, "❝"),
        h("div", null,
          h("h3", { className: "ds-title" }, "每日一句"),
          h("p", { className: "ds-sub" }, "状态栏最左侧展示一句话，点击可立即换句"))),

      // 预览
      h("div", { className: "ds-preview" },
        h("div", { className: "ds-preview-top" },
          h("span", null, "状态栏预览"),
          h("span", null, currentTest ? "· 接口测试（仅预览，不影响状态栏）" : (currentCache ? "· 最近一次缓存" : ""))),
        h("div", { className: "ds-preview-body" },
          previewText
            ? h(Animated, { text: previewText, animation: form.animation })
            : h("span", { className: "ds-preview-empty" }, "点击「测试接口」后在这里预览效果")),
        h("div", { className: "ds-preview-meta" },
          "下次自动更新：" + nextDueLabel(form.interval, currentCache && currentCache.at ? currentCache.at : Date.now()))),

      // 数据源
      h("div", { className: "ds-card" },
        h("h4", { className: "ds-card-title" }, "数据源"),
        h(Segmented, {
          value: activePreset ? activePreset.id : "",
          onChange: (id) => {
            const p = PRESETS.filter((x) => x.id === id)[0];
            if (p) applyPreset(p);
          },
          options: PRESETS.map((p) => ({ value: p.id, label: p.name, desc: p.desc }))
            .concat([{ value: "", label: "自定义", desc: "手动填写接口与字段", static: true }]),
        }),
        h("div", { className: "ds-grid" },
          h(Field, {
            label: "接口地址",
            control: h("input", {
              className: "ds-input is-mono",
              type: "text",
              spellCheck: false,
              value: form.url,
              onChange: (e) => set("url", e.target.value),
            }),
            hint: hostOk
              ? "已授权的主机：" + target
              : null,
          }),
          h(Field, {
            label: "句子字段（必填）",
            control: h("input", {
              className: "ds-input is-mono",
              type: "text",
              spellCheck: false,
              value: form.textField,
              onChange: (e) => set("textField", e.target.value),
            }),
            hint: "点路径，支持 data.content / 0.text",
          }),
          h(Field, {
            label: "from 字段（选填）",
            control: h("input", {
              className: "ds-input is-mono",
              type: "text",
              spellCheck: false,
              value: form.fromField,
              onChange: (e) => set("fromField", e.target.value),
            }),
            hint: "留空则不显示来源",
          })),
        !hostOk && h("div", { className: "ds-warn" },
          issue,
          issue && issue.indexOf("尚未授权") >= 0
            ? ["。请在插件源目录的 manifest.json → permissions 中追加授权，并同步更新 main.js 的 ALLOWED_HOSTS：", h("code", { key: "host-rule" }, ' "network:' + (target || "example.com") + '"'), "，保存后重新「从本地目录安装」本目录（会热重载）。"]
            : null)),

      // 显示
      h("div", { className: "ds-card" },
        h("h4", { className: "ds-card-title" }, "显示"),
        h(Segmented, {
          value: form.animation,
          onChange: (v) => set("animation", v),
          options: ANIMATIONS.map((a) => ({ value: a, label: ANIM_LABELS[a], desc: ANIM_DESCS[a] })),
        })),

      // 自动更新
      h("div", { className: "ds-card" },
        h("h4", { className: "ds-card-title" }, "自动更新"),
        h(Segmented, {
          value: form.interval,
          onChange: (v) => set("interval", v),
          options: MODES.map((m) => ({ value: m, label: MODE_LABELS[m], desc: MODE_DESCS[m] })),
        }),
        h("p", { className: "ds-hint" }, retryDescription(form.interval))),

      // 操作
      h("div", { className: "ds-actions" },
        h("button", { type: "button", className: "ds-btn is-primary", onClick: save }, "保存"),
        h("button", { type: "button", className: "ds-btn", onClick: () => { void runTest(); }, disabled: testing },
          testing ? "测试中…" : "测试接口"),
        h("button", { type: "button", className: "ds-btn is-ghost", onClick: reset }, "恢复默认"),
        note && h("span", { className: "ds-note is-" + note.kind }, note.text)),

      currentResult && (currentResult.ok
        ? h("div", { className: "ds-result is-ok" },
            "✓ 取句成功（仅预览，不影响状态栏）",
            h("div", { className: "ds-result-text" }, currentResult.from ? currentResult.text + " —— " + currentResult.from : currentResult.text))
        : h("div", { className: "ds-result is-bad" }, "✗ " + currentResult.msg)));
  }

  // ---------- 注册 ----------
  ctx.ui.registerStatusBarItem({ key: "daily-sentence-chip", component: StatusChip, zone: "start", order: -100 });
  ctx.ui.registerSettingsSection({ key: "daily-sentence-settings", label: () => "每日一句", component: SettingsSection });
}
