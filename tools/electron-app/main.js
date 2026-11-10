// Aura 网页屏保 —— 由我们自己控制的运行时（下载的 Electron）
// 之所以要它：系统浏览器是独立进程，我们够不着它，全屏时用户退不出来。
// 这个窗口是我们自己的，所以注入退出按钮、接管 ESC 都有效。
const { app, BrowserWindow, globalShortcut } = require('electron');
const fs = require('fs');
const pathMod = require('path');

// 管理员/SYSTEM 身份下 Chromium 沙箱起不来，渲染进程会被拒绝，
// 表现就是「窗口在、但一片空白」。希沃管家本身是管理员服务，这条必须关。
try { app.commandLine.appendSwitch('no-sandbox'); } catch (e) { }
try { app.commandLine.appendSwitch('disable-gpu-sandbox'); } catch (e) { }

// 内核自己写日志。同时写两个位置：exe 同级目录（一定存在且可写）+ LOCALAPPDATA。
// 之前只写 LOCALAPPDATA，环境变量拿不到就完全没有日志，排查等于瞎猜。
const LOG_TARGETS = (function () {
  const out = [];
  try { out.push(pathMod.join(pathMod.dirname(process.execPath), 'kernel.log')); } catch (e) { }
  try {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA || '';
    if (base) {
      const d = pathMod.join(base, 'seewo', 'AuraScreensaver', 'logs');
      fs.mkdirSync(d, { recursive: true });
      out.push(pathMod.join(d, 'kernel.log'));
    }
  } catch (e) { }
  return out;
})();

function klog(msg) {
  const line = new Date().toISOString() + '  ' + msg + '\n';
  for (let i = 0; i < LOG_TARGETS.length; i++) {
    try { fs.appendFileSync(LOG_TARGETS[i], line); } catch (e) { }
  }
}
klog('=== kernel start, exe=' + process.execPath);
klog('argv=' + JSON.stringify(process.argv.slice(1)));
klog('resourcesPath=' + process.resourcesPath);
try { klog('appPath=' + app.getAppPath() + ' isPackaged=' + String(app.isPackaged)); } catch (e) { }

function argVal(name) {
  const p = '--' + name + '=';
  const hit = process.argv.find(function (a) { return a.indexOf(p) === 0; });
  return hit ? hit.slice(p.length) : '';
}

const URL_ = argVal('aura-url');
const PID_FILE = argVal('aura-pid');

let win = null;
let quitting = false;
let shown = false;

function quit() {
  if (quitting) { return; }
  quitting = true;
  try { globalShortcut.unregisterAll(); } catch (e) { }
  try { if (PID_FILE) { fs.unlinkSync(PID_FILE); } } catch (e) { }
  try { app.quit(); } catch (e) { }
  setTimeout(function () { process.exit(0); }, 800);
}

function inject() {
  try {
    var js = '(function(){try{' +
      'if(document.getElementById("__aura_exit"))return;' +
      'var d=document.createElement("div");d.id="__aura_exit";' +
      'd.textContent="退出屏保";' +
      'd.style.cssText="position:fixed;right:24px;bottom:24px;z-index:2147483647;padding:12px 22px;' +
      'border-radius:26px;background:rgba(0,0,0,.62);color:#fff;font:16px/1 sans-serif;cursor:pointer;' +
      'border:1px solid rgba(255,255,255,.35);box-shadow:0 4px 16px rgba(0,0,0,.45);user-select:none";' +
      'd.onclick=function(ev){ev.stopPropagation();location.href="aura-close://now";};' +
      '(document.body||document.documentElement).appendChild(d);' +
      '}catch(e){}})()';
    win.webContents.executeJavaScript(js).catch(function () { });
  } catch (e) { }
}

// 出问题时不要留个纯白窗口 —— 把原因直接显示在屏幕上。
function showProblem(title, detail) {
  try {
    const html = '<html><body style="margin:0;background:#111;color:#eee;font:15px/1.8 system-ui,sans-serif;' +
      'display:flex;align-items:center;justify-content:center;height:100vh">' +
      '<div style="max-width:760px;padding:28px">' +
      '<div style="font-size:20px;font-weight:600;color:#ff8a80;margin-bottom:12px">' + title + '</div>' +
      '<div style="white-space:pre-wrap;word-break:break-word;opacity:.85">' + detail + '</div>' +
      '<div style="margin-top:18px;opacity:.6;font-size:13px">按 Esc 或 Ctrl+Alt+Q 退出屏保。详细日志见 kernel.log。</div>' +
      '</div></body></html>';
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  } catch (e) { }
}

function ensureShown() {
  if (shown) { return; }
  shown = true;
  try { win.show(); klog('window shown'); } catch (e) { klog('show 失败: ' + (e && e.message || e)); }
}

app.whenReady().then(function () {
  klog('app ready');
  win = new BrowserWindow({
    fullscreen: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, partition: 'persist:aura' }
  });
  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (e) { }
  var wc = win.webContents;
  try { wc.setUserAgent(wc.getUserAgent().replace(/\sElectron\/[0-9.]+/g, '')); } catch (e) { }

  // 1) 键盘 ESC
  wc.on('before-input-event', function (ev, input) {
    try { if (input && input.key === 'Escape') { quit(); } } catch (e) { }
  });
  // 2) 页面里那个按钮 -> 哨兵地址
  wc.on('will-navigate', function (ev, u) {
    try {
      if (u && u.indexOf('aura-close:') === 0) { ev.preventDefault(); quit(); }
    } catch (e) { }
  });
  // 3) 新窗口一律原地打开
  try {
    wc.setWindowOpenHandler(function (d) {
      try {
        if (d && d.url && d.url !== 'about:blank') {
          setTimeout(function () { try { win.loadURL(d.url); } catch (e) { } }, 0);
        }
      } catch (e) { }
      return { action: 'deny' };
    });
  } catch (e) { }
  // 4) 每次加载完成都补一次按钮（页面内跳转会把它清掉）
  wc.on('did-navigate-in-page', inject);

  wc.on('did-finish-load', function () {
    inject();
    klog('did-finish-load url=' + wc.getURL());
    // 区分「根本没加载」和「加载了但页面是空的」—— 白屏排查的关键信息
    wc.executeJavaScript('JSON.stringify({t:document.title,l:(document.body&&document.body.innerText||"").length,bg:getComputedStyle(document.body||document.documentElement).backgroundColor})')
      .then(function (v) { klog('page state = ' + v); })
      .catch(function (e) { klog('page state 读取失败: ' + (e && e.message || e)); });
  });
  wc.on('did-fail-load', function (ev, code, desc, u, isMain) {
    klog('did-fail-load code=' + code + ' desc=' + desc + ' url=' + u + ' main=' + String(isMain));
    if (isMain === false) { return; }
    showProblem('网页加载失败 (' + code + ')', desc + '\n' + u);
  });
  wc.on('render-process-gone', function (ev, d) {
    klog('render-process-gone ' + JSON.stringify(d));
    showProblem('页面渲染进程异常退出', JSON.stringify(d));
  });
  win.on('closed', function () { quit(); });

  // ready-to-show 在页面不绘制时永远不触发，窗口就一直隐藏，
  // 用户看到的就是「什么都没发生」。加一个超时兜底。
  win.once('ready-to-show', ensureShown);
  setTimeout(ensureShown, 1500);

  klog('target url = ' + (URL_ || '(空)'));
  if (URL_) {
    win.loadURL(URL_).catch(function (e) {
      klog('loadURL 失败: ' + (e && e.message || e));
      showProblem('无法打开网页', String((e && e.message) || e));
    });
  } else {
    klog('[!!] URL_ 为空');
    showProblem('没有收到要显示的网址', '启动参数里缺少 --aura-url=...');
  }

  // 5) 全局快捷键兜底
  try { globalShortcut.register('CommandOrControl+Alt+Q', quit); } catch (e) { }
  try { globalShortcut.register('CommandOrControl+Shift+Q', quit); } catch (e) { }

  if (PID_FILE) { try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch (e) { } }
}).catch(function (e) {
  klog('whenReady 失败: ' + (e && e.stack || e));
  try { showProblem('内核启动失败', String((e && e.stack) || e)); } catch (e2) { }
});

// 原来这里是 uncaughtException -> quit，任何小异常都直接退出，
// 用户看到的就是「闪一下/白屏就没了」。改成只记日志、不退出。
process.on('uncaughtException', function (e) {
  klog('uncaughtException: ' + (e && e.stack || e));
});
process.on('unhandledRejection', function (e) {
  klog('unhandledRejection: ' + (e && (e.stack || e.message) || e));
});
