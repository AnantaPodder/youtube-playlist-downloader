// Front end for the local yt-dlp server: preview playlists, queue downloads, show live progress.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n, width = 2) => String(n).padStart(width, "0");

const ACTIVE = new Set(["queued", "preparing", "running"]);
const PRESET_LABEL = { best: "1080p or higher", strict: "Strict 1080p+", cap: "Up to 1080p" };

// ---------- icons ----------

const svg = (d, cls = "size-4", width = 2) =>
  `<svg class="${cls}" fill="none" viewBox="0 0 24 24" stroke-width="${width}" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="${d}"/></svg>`;

const ICON = {
  check: svg("m4.5 12.75 6 6 9-13.5"),
  checkCircle: svg("M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "size-5", 1.8),
  xCircle: svg("m9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "size-5", 1.8),
  skip: svg("M15 12H9m12 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "size-5", 1.8),
  clock: svg("M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "size-5", 1.8),
  warn: svg("M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z", "size-5", 1.8),
  info: svg("m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z", "size-5", 1.8),
  x: svg("M6 18 18 6M6 6l12 12", "size-4"),
  copy: svg("M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184", "size-3.5"),
};

const spinner = (cls = "size-4") =>
  `<svg class="${cls} animate-spin" viewBox="0 0 24 24" fill="none"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"/></svg>`;

// ---------- helpers ----------

async function api(path, body, { signal } = {}) {
  const res = await fetch(path, body === undefined ? { signal } : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text(); // rejects if aborted mid-body, which callers rely on
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    if (res.ok) throw new Error("The app server sent an unreadable reply.");
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function fmtDuration(sec) {
  if (sec == null || Number.isNaN(sec)) return "";
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtTotal(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${Math.max(1, m)} min`;
}

function fmtBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

const tildify = (path) => (path || "").replace(/^\/home\/[^/]+/, "~");

function setBusy(btn, busy, text) {
  if (busy) {
    btn.dataset.html ??= btn.innerHTML;
    btn.innerHTML = `${spinner("size-4")}<span>${esc(text)}</span>`;
    btn.disabled = true;
  } else if (btn.dataset.html) {
    btn.innerHTML = btn.dataset.html;
    delete btn.dataset.html;
    btn.disabled = false;
  }
}

async function copy(text, what = "Copied to clipboard") {
  try {
    await navigator.clipboard.writeText(text);
    toast(what, "success");
  } catch {
    toast("Couldn't access the clipboard.", "error");
  }
}

function toast(message, kind = "info") {
  const style = {
    success: ["text-emerald-500", ICON.checkCircle],
    error: ["text-red-500", ICON.warn],
    info: ["text-sky-500", ICON.info],
  }[kind];
  const el = document.createElement("div");
  el.className = "pointer-events-auto flex translate-y-2 items-start gap-3 rounded-xl bg-white p-4 text-sm opacity-0 shadow-lg ring-1 ring-zinc-950/10 transition duration-300 dark:bg-zinc-800 dark:ring-white/10";
  el.innerHTML = `<span class="${style[0]}">${style[1]}</span><p class="min-w-0 flex-1 break-words">${esc(message)}</p>`;
  $("#toasts").append(el);
  requestAnimationFrame(() => el.classList.remove("translate-y-2", "opacity-0"));
  setTimeout(() => {
    el.classList.add("opacity-0");
    setTimeout(() => el.remove(), 300);
  }, kind === "error" ? 7000 : 4000);
}

function showModal({ ok, title, text, output }) {
  const icon = $("#modal-icon");
  icon.className = "flex size-10 shrink-0 items-center justify-center rounded-full " + (ok
    ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400"
    : "bg-red-100 text-red-600 dark:bg-red-500/15 dark:text-red-400");
  icon.innerHTML = ok ? ICON.checkCircle : ICON.warn;
  $("#modal-title").textContent = title;
  $("#modal-text").textContent = text || "";
  $("#modal-output").textContent = output || "";
  $("#modal-output").classList.toggle("hidden", !output);
  $("#modal").showModal();
}

// ---------- state ----------

const state = {
  status: null,
  preview: null,          // /api/inspect result for the link in the box
  selected: new Set(),    // playlist indices ticked in the preview
  rev: -1,
  jobs: new Map(),        // id -> latest snapshot
  cards: new Map(),       // id -> card element
  seen: new Map(),        // id -> last status, to notify only on transitions
  open: new Set(),        // ids with Details expanded
  tab: new Map(),         // id -> "items" | "log"
  pollAbort: null,
  lastStatusCheck: 0,
  setupDismissed: false,
};

// ---------- system status & setup ----------

const ytdlpOk = (s) => s.ytdlp.found && s.ytdlp.via !== "apt";
const needsSetup = (s) => !ytdlpOk(s) || !s.ffmpeg.found || !s.deno.found;

async function loadStatus() {
  state.lastStatusCheck = Date.now();
  try {
    state.status = await api("/api/status");
  } catch {
    toast("Can't reach the app server. Is it still running?", "error");
    return;
  }
  const outdir = $("#outdir");
  if (!outdir.value) outdir.value = localStorage.getItem("outdir") || state.status.defaultDir;
  renderDeps();
  const visible = !$("#setup").classList.contains("hidden");
  if (visible || (needsSetup(state.status) && !state.setupDismissed)) renderSetup(true);
  renderSummary();
}

function renderDeps() {
  const s = state.status;
  const pill = (label, tone, title = "") => {
    const tones = {
      ok: ["bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20", "bg-emerald-500"],
      warn: ["bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20", "bg-amber-500"],
      bad: ["bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/20", "bg-red-500"],
    }[tone];
    return `<span class="badge ${tones[0]}" title="${esc(title)}"><span class="size-1.5 rounded-full ${tones[1]}"></span>${esc(label)}</span>`;
  };
  const y = s.ytdlp;
  const ytPill = !y.found ? pill("yt-dlp missing", "bad")
    : y.via === "apt" ? pill(`yt-dlp ${y.version} (apt)`, "warn", "The apt version is outdated. Install with pipx instead.")
    : y.age_days > 60 ? pill(`yt-dlp ${y.version}`, "warn", `${y.age_days} days old. Click "Update yt-dlp".`)
    : pill(`yt-dlp ${y.version}`, "ok", y.path);
  $("#deps").innerHTML = ytPill
    + (s.ffmpeg.found ? pill("ffmpeg", "ok", `ffmpeg ${s.ffmpeg.version}`) : pill("ffmpeg missing", "bad"))
    + (s.deno.found ? pill("deno", "ok", `deno ${s.deno.version}`) : pill("deno missing", "bad"));

  const btn = $("#update-btn");
  if (!btn.disabled) {
    btn.querySelector("span").textContent = y.found ? "Update yt-dlp" : "Install yt-dlp";
    btn.dataset.action = y.found ? "update" : "install";
  }
}

function renderSetup(show) {
  const el = $("#setup");
  el.classList.toggle("hidden", !show);
  if (!show) return;
  const s = state.status;
  const tool = s.pipx.found ? "pipx" : s.uv.found ? "uv" : null;
  const ytInstall = tool === "pipx" ? 'pipx install "yt-dlp[default]"'
    : tool === "uv" ? 'uv tool install "yt-dlp[default]"'
    : 'sudo apt install pipx && pipx ensurepath && pipx install "yt-dlp[default]"';

  const steps = [
    {
      title: "ffmpeg",
      ok: s.ffmpeg.found,
      detail: s.ffmpeg.found ? `Version ${s.ffmpeg.version}` : "Merges the separate 1080p video and audio streams into one MP4.",
      cmd: "sudo apt update && sudo apt install ffmpeg pipx && pipx ensurepath",
    },
    {
      title: "yt-dlp",
      ok: ytdlpOk(s),
      detail: ytdlpOk(s) ? `Version ${s.ytdlp.version} (${s.ytdlp.via})`
        : s.ytdlp.via === "apt" ? "Installed from apt, which lags behind and breaks on YouTube. Replace it with the latest version."
        : "The latest version, with the extras YouTube needs.",
      cmd: s.ytdlp.via === "apt" ? `sudo apt remove yt-dlp && ${ytInstall}` : ytInstall,
      install: tool && !s.ytdlp.found,
    },
    {
      title: "Deno",
      ok: s.deno.found,
      detail: s.deno.found ? `Version ${s.deno.version}`
        : "The JavaScript runtime yt-dlp now needs for YouTube. This app finds ~/.deno/bin by itself.",
      cmd: "curl -fsSL https://deno.land/install.sh | sh",
    },
  ];
  const allOk = steps.every((step) => step.ok);

  const header = allOk
    ? `<div class="flex items-start gap-3 border-b border-emerald-200 bg-emerald-50 px-5 py-4 sm:px-6 dark:border-emerald-500/20 dark:bg-emerald-500/10">
         <span class="text-emerald-600 dark:text-emerald-400">${ICON.checkCircle}</span>
         <div class="flex-1"><h2 class="text-sm font-semibold text-emerald-900 dark:text-emerald-200">All set</h2>
         <p class="text-sm text-emerald-800 dark:text-emerald-200/80">Everything yt-dlp needs is installed.</p></div>
         <button data-close type="button" class="btn btn-ghost btn-sm" aria-label="Close">${ICON.x}</button></div>`
    : `<div class="flex items-start gap-3 border-b border-amber-200 bg-amber-50 px-5 py-4 sm:px-6 dark:border-amber-500/20 dark:bg-amber-500/10">
         <span class="text-amber-600 dark:text-amber-400">${ICON.warn}</span>
         <div class="flex-1"><h2 class="text-sm font-semibold text-amber-900 dark:text-amber-200">Finish setting up</h2>
         <p class="text-sm text-amber-800 dark:text-amber-200/80">Run the missing steps in a terminal (Ctrl+Alt+T). This page re-checks when you come back.</p></div>
         <button data-close type="button" class="btn btn-ghost btn-sm" aria-label="Close">${ICON.x}</button></div>`;

  const rows = steps.map((step, i) => `
    <li class="flex gap-4 px-5 py-4 sm:px-6">
      <span class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${step.ok
        ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400"
        : "bg-zinc-100 text-zinc-600 dark:bg-white/10 dark:text-zinc-300"}">${step.ok ? ICON.check : i + 1}</span>
      <div class="min-w-0 flex-1">
        <p class="text-sm font-medium">${esc(step.title)}${step.ok ? ' <span class="ml-1 text-xs font-normal text-emerald-600 dark:text-emerald-400">Installed</span>' : ""}</p>
        <p class="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">${esc(step.detail)}</p>
        ${step.ok ? "" : `
        <div class="mt-2.5 flex flex-col gap-2 sm:flex-row sm:items-center">
          <code class="min-w-0 flex-1 truncate rounded-lg bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-200 dark:bg-black/40"><span class="text-zinc-500 select-none">$ </span>${esc(step.cmd)}</code>
          <div class="flex gap-2">
            <button data-copy="${esc(step.cmd)}" type="button" class="btn btn-secondary btn-sm">${ICON.copy}Copy</button>
            ${step.install ? `<button data-install type="button" class="btn btn-primary btn-sm">Install for me</button>` : ""}
          </div>
        </div>`}
      </div>
    </li>`).join("");

  el.innerHTML = `${header}
    <ol class="divide-y divide-zinc-100 dark:divide-white/5">${rows}</ol>
    <div class="flex flex-col gap-3 border-t border-zinc-200 bg-zinc-50 px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 dark:border-white/10 dark:bg-white/[0.02]">
      <p class="text-xs text-zinc-500 dark:text-zinc-400">Skip <code class="font-mono">apt install yt-dlp</code>. Ubuntu's repositories lag behind and old versions break on YouTube quickly.</p>
      <button data-recheck type="button" class="btn btn-secondary btn-sm">Re-check</button>
    </div>`;
}

async function maintenance(action, btn) {
  setBusy(btn, true, action === "install" ? "Installing yt-dlp…" : "Updating yt-dlp…");
  try {
    const r = await api("/api/maintenance", { action });
    const verb = action === "install" ? "installed" : "updated";
    showModal({
      ok: r.ok,
      title: r.ok ? `yt-dlp ${verb}${r.ytdlp?.version ? ` (version ${r.ytdlp.version})` : ""}` : `yt-dlp couldn't be ${verb}`,
      text: r.command ? `Ran: ${r.command}` : "",
      output: r.output,
    });
  } catch (e) {
    toast(e.message, "error");
  } finally {
    setBusy(btn, false);
    loadStatus();
  }
}

// ---------- new download form ----------

async function fetchPreview() {
  const url = $("#url").value.trim();
  if (!url) return;
  state.preview = null;
  renderPreview();
  $("#preview-loading").classList.remove("hidden");
  setBusy($("#fetch-btn"), true, "Fetching…");
  try {
    const info = await api("/api/inspect", { url });
    if ($("#url").value.trim() === url) {
      state.preview = info;
      state.selected = new Set(info.entries.filter((e) => e.available).map((e) => e.index));
      $("#pv-filter").value = "";
    }
  } catch (e) {
    toast(e.message, "error");
  } finally {
    $("#preview-loading").classList.add("hidden");
    setBusy($("#fetch-btn"), false);
    renderPreview();
  }
}

function renderPreview() {
  const p = state.preview;
  $("#preview").classList.toggle("hidden", !p);
  if (p) {
    const thumb = $("#pv-thumb");
    const first = p.entries.find((e) => e.thumbnail && e.available);
    thumb.src = first ? first.thumbnail : "";
    thumb.classList.toggle("sm:block", !!first);
    $("#pv-kind").textContent = p.isPlaylist ? "Playlist" : "Video";
    $("#pv-title").textContent = p.title;
    const total = p.entries.reduce((sum, e) => sum + (e.duration || 0), 0);
    $("#pv-meta").textContent = [
      p.uploader,
      p.isPlaylist && `${p.entries.length} video${p.entries.length === 1 ? "" : "s"}`,
      total && (p.isPlaylist ? fmtTotal(total) : fmtDuration(total)),
    ].filter(Boolean).join(" · ");
    $("#pv-list-wrap").classList.toggle("hidden", !p.isPlaylist);
    if (p.isPlaylist) renderEntries();
  }
  renderSummary();
}

function visibleEntries() {
  const q = $("#pv-filter").value.trim().toLowerCase();
  return state.preview.entries.filter((e) => !q || e.title.toLowerCase().includes(q));
}

function renderEntries() {
  const entries = visibleEntries();
  const width = state.preview.entries.length >= 100 ? 3 : 2;
  $("#pv-list").innerHTML = entries.map((e) => `
    <li><label class="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-zinc-50 dark:hover:bg-white/[0.03] ${e.available ? "" : "opacity-50"}">
      <input type="checkbox" class="checkbox" data-index="${e.index}" ${state.selected.has(e.index) ? "checked" : ""}>
      <span class="w-7 shrink-0 text-right text-xs text-zinc-400 tabular-nums">${pad(e.index, width)}</span>
      ${e.thumbnail && e.available
        ? `<img src="${esc(e.thumbnail)}" loading="lazy" alt="" class="aspect-video w-16 shrink-0 rounded bg-zinc-200 object-cover dark:bg-white/10">`
        : `<span class="aspect-video w-16 shrink-0 rounded bg-zinc-200 dark:bg-white/10"></span>`}
      <span class="min-w-0 flex-1 truncate text-sm">${esc(e.title)}</span>
      <span class="shrink-0 text-xs text-zinc-500 tabular-nums dark:text-zinc-400">${e.available ? fmtDuration(e.duration) : "Unavailable"}</span>
    </label></li>`).join("")
    || `<li class="px-3 py-8 text-center text-sm text-zinc-500">No videos match “${esc($("#pv-filter").value)}”.</li>`;
  syncSelection();
}

function syncSelection() {
  const entries = visibleEntries();
  const ticked = entries.filter((e) => state.selected.has(e.index)).length;
  const all = $("#select-all");
  all.checked = entries.length > 0 && ticked === entries.length;
  all.indeterminate = ticked > 0 && ticked < entries.length;
  $("#sel-count").textContent = `${state.selected.size} / ${state.preview.entries.length} selected`;
  renderSummary();
}

function renderSummary() {
  const p = state.preview;
  const url = $("#url").value.trim();
  let text, canStart = !!url;
  if (p?.isPlaylist) {
    const chosen = p.entries.filter((e) => state.selected.has(e.index));
    const dur = chosen.reduce((sum, e) => sum + (e.duration || 0), 0);
    text = `${chosen.length} of ${p.entries.length} videos selected${dur ? ` · ${fmtTotal(dur)}` : ""}`;
    canStart = chosen.length > 0;
  } else if (p) {
    text = `1 video${p.entries[0].duration ? ` · ${fmtDuration(p.entries[0].duration)}` : ""}`;
  } else {
    text = url ? "Everything in the link will be downloaded." : "Paste a link to get started.";
  }
  if (state.status && !state.status.ytdlp.found) {
    text = "Install yt-dlp first (see the setup steps above).";
    canStart = false;
  }
  $("#summary").textContent = text;
  $("#download-btn").disabled = !canStart;
}

async function startDownload() {
  const url = $("#url").value.trim();
  if (!url) return $("#url").focus();
  const p = state.preview?.url === url ? state.preview : null;
  const selected = p?.isPlaylist && state.selected.size < p.entries.length
    ? [...state.selected].sort((a, b) => a - b) : null;
  const preset = $('input[name="preset"]:checked').value;
  const outdir = $("#outdir").value.trim();
  localStorage.setItem("preset", preset);
  localStorage.setItem("outdir", outdir);

  const btn = $("#download-btn");
  setBusy(btn, true, "Adding…");
  try {
    await api("/api/jobs", { url, preset, outdir, selected });
    toast(p ? `Queued “${p.title}”` : "Added to downloads", "success");
    $("#url").value = "";
    state.preview = null;
    renderPreview();
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
    restartPoll();
  } catch (e) {
    toast(e.message, "error");
  } finally {
    setBusy(btn, false);
    renderSummary();
  }
}

// ---------- downloads list ----------

const BADGE = {
  zinc: "bg-zinc-50 text-zinc-600 ring-zinc-500/20 dark:bg-white/5 dark:text-zinc-400 dark:ring-white/10",
  sky: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-400 dark:ring-sky-500/20",
  red: "bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/20",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20",
  amber: "bg-amber-50 text-amber-800 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20",
};

const JOB_STATUS = {
  queued: { label: "Queued", badge: BADGE.zinc, bar: "bg-zinc-400" },
  preparing: { label: "Reading playlist", badge: BADGE.sky, bar: "bg-sky-500 animate-pulse", spin: true },
  running: { label: "Downloading", badge: BADGE.red, bar: "bg-red-600", spin: true },
  done: { label: "Completed", badge: BADGE.green, bar: "bg-emerald-500" },
  partial: { label: "Completed with errors", badge: BADGE.amber, bar: "bg-amber-500" },
  failed: { label: "Failed", badge: BADGE.red, bar: "bg-red-600" },
  cancelled: { label: "Cancelled", badge: BADGE.zinc, bar: "bg-zinc-400" },
};

const ITEM_STATUS = {
  pending: { icon: ICON.clock, cls: "text-zinc-300 dark:text-zinc-600" },
  downloading: { icon: spinner("size-5"), cls: "text-red-600 dark:text-red-500" },
  merging: { icon: spinner("size-5"), cls: "text-sky-500" },
  done: { icon: ICON.checkCircle, cls: "text-emerald-500" },
  skipped: { icon: ICON.skip, cls: "text-zinc-400" },
  failed: { icon: ICON.xCircle, cls: "text-red-500" },
};

function streamText(item) {
  if (item.status === "merging") return "Merging video and audio…";
  const parts = [`${item.stream === "audio" ? "Audio" : "Video"} ${Math.floor(item.percent)}%`];
  if (item.speed) parts.push(`${fmtBytes(item.speed)}/s`);
  if (item.eta != null) parts.push(`${fmtDuration(item.eta)} left`);
  return parts.join(" · ");
}

function itemRow(item, width) {
  const st = ITEM_STATUS[item.status] || ITEM_STATUS.pending;
  const active = item.status === "downloading" || item.status === "merging";
  const detail = active ? streamText(item)
    : item.status === "done" ? (item.file || "").split("/").pop()
    : item.error || "";
  const detailCls = item.status === "failed" ? "text-red-600 dark:text-red-400" : "text-zinc-500 dark:text-zinc-400";
  return `<li class="flex items-center gap-3 px-4 py-2.5 sm:px-5 ${active ? "bg-red-50/40 dark:bg-red-500/[0.04]" : ""}">
    <span class="w-7 shrink-0 text-right text-xs text-zinc-400 tabular-nums">${pad(item.index, width)}</span>
    <span class="${st.cls}">${st.icon}</span>
    <div class="min-w-0 flex-1">
      <p class="truncate text-sm ${item.status === "pending" ? "text-zinc-500 dark:text-zinc-400" : ""}">${esc(item.title)}</p>
      ${detail ? `<p class="truncate text-xs ${detailCls}" title="${esc(detail)}">${esc(detail)}</p>` : ""}
      ${item.status === "downloading" ? `<div class="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-200/70 dark:bg-white/10"><div class="h-full rounded-full bg-red-600" style="width:${item.progress}%"></div></div>` : ""}
    </div>
    <span class="shrink-0 text-xs text-zinc-400 tabular-nums">${fmtDuration(item.duration)}</span>
  </li>`;
}

function createCard(id) {
  const card = $("#tpl-job").content.firstElementChild.cloneNode(true);
  card.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act],[data-tab]");
    if (btn) onCardAction(id, btn);
  });
  return card;
}

async function onCardAction(id, btn) {
  const job = state.jobs.get(id);
  if (btn.dataset.tab) {
    state.tab.set(id, btn.dataset.tab);
    updateCard(state.cards.get(id), job);
    if (btn.dataset.tab === "log") restartPoll();
    return;
  }
  try {
    switch (btn.dataset.act) {
      case "details":
        state.open.has(id) ? state.open.delete(id) : state.open.add(id);
        updateCard(state.cards.get(id), job);
        if (state.open.has(id) && state.tab.get(id) === "log") restartPoll();
        break;
      case "cancel":
        await api(`/api/jobs/${id}/cancel`, {});
        break;
      case "retry":
        await api(`/api/jobs/${id}/retry`, {});
        toast("Queued again. Videos that already finished are skipped.", "info");
        break;
      case "remove":
        await api(`/api/jobs/${id}/remove`, {});
        break;
      case "open":
        await api("/api/open-folder", { path: job.folder });
        break;
      case "update":
        await maintenance("update", btn);
        break;
      case "copy-cmd":
        if (job.command) copy(job.command, "yt-dlp command copied");
        break;
    }
  } catch (e) {
    toast(e.message, "error");
  }
}

function updateCard(card, job) {
  const st = JOB_STATUS[job.status];
  const c = job.counts;
  const finished = c.done + c.skipped + c.failed;
  const width = job.total >= 100 ? 3 : 2;

  const thumb = $("[data-thumb]", card);
  const first = job.items.find((i) => i.thumbnail);
  if (first && thumb.getAttribute("src") !== first.thumbnail) thumb.src = first.thumbnail;
  thumb.classList.toggle("sm:block", !!first);

  $("[data-title]", card).textContent = job.title || job.url;
  $("[data-sub]", card).textContent = [job.uploader, PRESET_LABEL[job.preset], tildify(job.folder)].filter(Boolean).join(" · ");
  const badge = $("[data-badge]", card);
  badge.className = `badge ${st.badge}`;
  badge.innerHTML = `${st.spin ? spinner("size-3") : ""}${st.label}`;

  let count;
  if (job.status === "queued" && !job.total) count = "Waiting for earlier downloads";
  else if (job.status === "preparing") count = "Reading the playlist…";
  else {
    count = `${finished} of ${job.total} video${job.total === 1 ? "" : "s"}`;
    if (c.failed) count += ` · ${c.failed} failed`;
    if (c.skipped) count += ` · ${c.skipped} skipped`;
    if (job.bytesDone) count += ` · ${fmtBytes(job.bytesDone)}`;
  }
  $("[data-count]", card).textContent = count;
  const pct = job.status === "done" ? 100 : Math.floor(job.progress * 100);
  $("[data-percent]", card).textContent = job.status === "preparing" ? "" : `${pct}%`;
  const bar = $("[data-bar]", card);
  bar.className = `h-full rounded-full transition-[width] duration-500 ease-out ${st.bar}`;
  bar.style.width = job.status === "preparing" ? "100%" : `${pct}%`;

  const now = $("[data-now]", card);
  const cur = job.current;
  now.classList.toggle("hidden", !(cur && job.status === "running"));
  if (cur && job.status === "running") {
    now.innerHTML = `<span class="font-medium tabular-nums text-zinc-500 dark:text-zinc-400">#${pad(cur.index, width)}</span> ${esc(cur.title)}
      <span class="text-zinc-500 dark:text-zinc-400"> · ${esc(streamText(cur))}</span>`;
  }

  const msg = $("[data-message]", card);
  const lines = [];
  if (job.message) lines.push(esc(job.message));
  if (job.status === "failed") lines.push("If downloads suddenly start failing, update yt-dlp and retry.");
  if (job.notice) lines.push(esc(job.notice));
  msg.innerHTML = lines.join("<br>");
  msg.className = `mt-3 rounded-lg px-3 py-2 text-sm ${lines.length ? "" : "hidden"} ${
    job.status === "failed" ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300"
    : job.status === "cancelled" ? "bg-zinc-100 text-zinc-600 dark:bg-white/5 dark:text-zinc-400"
    : "bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200"}`;

  const show = (act, visible) => $(`[data-act="${act}"]`, card).classList.toggle("hidden", !visible);
  show("cancel", ACTIVE.has(job.status));
  show("open", !["queued", "preparing"].includes(job.status));
  show("retry", ["failed", "partial", "cancelled"].includes(job.status));
  show("update", ["failed", "partial"].includes(job.status));
  show("remove", !ACTIVE.has(job.status));

  // Details panel
  const open = state.open.has(job.id);
  const tab = state.tab.get(job.id) || "items";
  $("[data-details]", card).classList.toggle("hidden", !open);
  $("[data-chevron]", card).classList.toggle("rotate-180", open);
  if (!open) return;
  for (const t of $$("[data-tab]", card)) {
    t.className = `-mb-px border-b-2 px-3 py-2.5 text-sm font-medium ${t.dataset.tab === tab
      ? "border-red-500 text-zinc-900 dark:text-white"
      : "border-transparent text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"}`;
  }
  $("[data-act='copy-cmd']", card).classList.toggle("hidden", !job.command);
  const itemsEl = $("[data-items]", card), logEl = $("[data-log]", card);
  itemsEl.classList.toggle("hidden", tab !== "items");
  logEl.classList.toggle("hidden", tab !== "log");
  if (tab === "items") {
    itemsEl.innerHTML = job.items.map((i) => itemRow(i, width)).join("")
      || `<li class="px-5 py-8 text-center text-sm text-zinc-500">The video list appears once the playlist has been read.</li>`;
  } else if (job.log) {
    const stick = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40 || !logEl.textContent;
    logEl.textContent = job.log.join("\n") || "No output yet.";
    if (stick) logEl.scrollTop = logEl.scrollHeight;
  }
}

function notifyOnFinish(job) {
  const prev = state.seen.get(job.id);
  state.seen.set(job.id, job.status);
  if (!prev || !ACTIVE.has(prev) || ACTIVE.has(job.status) || job.status === "cancelled") return;
  const title = job.title || "Download";
  const body = job.status === "done" ? `All ${job.total} video${job.total === 1 ? "" : "s"} downloaded.`
    : job.message || "Download failed.";
  toast(`${title}: ${body}`, job.status === "done" ? "success" : "error");
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body, icon: "/favicon.svg" });
  }
}

function renderJobs(jobs) {
  const list = $("#jobs");
  const ids = new Set(jobs.map((j) => j.id));
  for (const [id, card] of state.cards) {
    if (!ids.has(id)) {
      card.remove();
      state.cards.delete(id);
      state.jobs.delete(id);
    }
  }
  jobs.forEach((job, i) => {
    state.jobs.set(job.id, job);
    let card = state.cards.get(job.id);
    if (!card) {
      card = createCard(job.id);
      state.cards.set(job.id, card);
    }
    if (list.children[i] !== card) list.insertBefore(card, list.children[i] || null);
    updateCard(card, job);
    notifyOnFinish(job);
  });
  $("#jobs-empty").classList.toggle("hidden", jobs.length > 0);
  $("#clear-btn").classList.toggle("hidden", !jobs.some((j) => !ACTIVE.has(j.status)));

  const running = jobs.find((j) => j.status === "running");
  document.title = running ? `${Math.floor(running.progress * 100)}% · ${running.title} | Playlist Downloader` : "Playlist Downloader";
}

async function pollLoop() {
  for (;;) {
    state.pollAbort = new AbortController();
    const logs = [...state.open].filter((id) => state.tab.get(id) === "log").join(",");
    try {
      const data = await api(`/api/jobs?rev=${state.rev}&logs=${logs}`, undefined, { signal: state.pollAbort.signal });
      state.rev = data.rev;
      renderJobs(data.jobs);
      await sleep(250);
    } catch (e) {
      if (e.name === "AbortError") continue;
      if (!(e instanceof TypeError && /fetch/i.test(e.message))) console.error(e);
      await sleep(2000); // server restarting: keep trying quietly
    }
  }
}

// Ask for a fresh snapshot right away (e.g. the log tab was just opened).
function restartPoll() {
  state.rev = -1;
  state.pollAbort?.abort();
}

// ---------- wiring ----------

$("#fetch-form").addEventListener("submit", (e) => {
  e.preventDefault();
  fetchPreview();
});
$("#url").addEventListener("paste", () => setTimeout(fetchPreview, 0));
$("#url").addEventListener("input", () => {
  if (state.preview && state.preview.url !== $("#url").value.trim()) {
    state.preview = null;
    renderPreview();
  }
  renderSummary();
});
$("#pv-clear").addEventListener("click", () => {
  state.preview = null;
  $("#url").value = "";
  renderPreview();
  $("#url").focus();
});
$("#pv-filter").addEventListener("input", renderEntries);
$("#pv-list").addEventListener("change", (e) => {
  const index = Number(e.target.dataset.index);
  e.target.checked ? state.selected.add(index) : state.selected.delete(index);
  syncSelection();
});
$("#select-all").addEventListener("change", (e) => {
  for (const entry of visibleEntries()) e.target.checked ? state.selected.add(entry.index) : state.selected.delete(entry.index);
  renderEntries();
});

$("#download-btn").addEventListener("click", startDownload);
$("#browse-btn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  setBusy(btn, true, "Choose…");
  try {
    const { path } = await api("/api/pick-folder", { start: $("#outdir").value });
    if (path) $("#outdir").value = path;
  } catch (err) {
    toast(err.message, "error");
  } finally {
    setBusy(btn, false);
  }
});

$("#update-btn").addEventListener("click", (e) => maintenance(e.currentTarget.dataset.action || "update", e.currentTarget));
$("#deps").addEventListener("click", () => renderSetup($("#setup").classList.contains("hidden")));
$("#setup").addEventListener("click", (e) => {
  const t = e.target.closest("button");
  if (!t) return;
  if (t.dataset.copy) copy(t.dataset.copy, "Command copied. Paste it into a terminal.");
  else if ("close" in t.dataset) {
    state.setupDismissed = true;
    renderSetup(false);
  }
  else if ("recheck" in t.dataset) loadStatus().then(() => !needsSetup(state.status) && toast("Everything is installed.", "success"));
  else if ("install" in t.dataset) maintenance("install", t);
});

$("#clear-btn").addEventListener("click", () => api("/api/clear", {}).catch((e) => toast(e.message, "error")));
$("#theme-btn").addEventListener("click", () => {
  const dark = document.documentElement.classList.toggle("dark");
  localStorage.setItem("theme", dark ? "dark" : "light");
});
$("#modal-close").addEventListener("click", () => $("#modal").close());
$("#modal").addEventListener("click", (e) => e.target === e.currentTarget && e.currentTarget.close());

// Re-check tools when coming back from a terminal.
window.addEventListener("focus", () => Date.now() - state.lastStatusCheck > 5000 && loadStatus());

const savedPreset = localStorage.getItem("preset");
if (savedPreset) $(`input[name="preset"][value="${savedPreset}"]`)?.click();

renderSummary();
loadStatus();
pollLoop();
