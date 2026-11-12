// 台球客户端主进程：只开窗，不做规则。规则与画面都在 billiard.html / arena.html 里。
// 由 billiards 模块以 `electron main.js` 分离进程启动；模式走环境变量 BILLIARDS_MODE。
const { app, BrowserWindow, screen, ipcMain } = require('electron')
const fs = require('fs')
const path = require('path')

const ANIMS_FILE = path.join(__dirname, 'anims.json')
const MODE = process.env.BILLIARDS_MODE === 'arena' ? 'arena' : 'small'

// 先给自己一个独立身份，再谈开窗。不写这两行的话 app name 就是默认的 "Electron"，
// userData 落到 %APPDATA%\Electron —— 桌宠那份 app/ 里没有 package.json，名字一模一样，
// 于是两边抢同一把单实例锁：台球进程 requestSingleInstanceLock() 拿不到 → app.quit()，
// 窗都开不出来（面板还会以为起来了），顺带把桌宠的 second-instance 触发得它自己弹一下。
app.setName('aurabot-billiards')
app.setPath('userData', path.join(app.getPath('appData'), 'aurabot-billiards'))

/** 球面动画地址：模块侧每次启动前重写 anims.json，这里只读，不做任何网络请求。 */
function ballAnims() {
  try {
    const j = JSON.parse(fs.readFileSync(ANIMS_FILE, 'utf8'))
    return Array.isArray(j.urls) ? j.urls.filter((u) => typeof u === 'string' && u) : []
  } catch {
    return [] // 没素材包 / 文件读不了：普通球面，照样能打
  }
}

const win = { small: null, arena: null }
const alive = (k) => Boolean(win[k] && !win[k].isDestroyed())

// F12 开/关 devtools：页面里 __autoGame() / __dump() 这两个钩子靠它取证。
// 只给小窗绑——桌面球桌是 focusable:false，键盘事件根本进不去那个窗口。
function bindDevtools(w) {
  w.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F12') return
    if (w.webContents.isDevToolsOpened()) w.webContents.closeDevTools()
    else w.webContents.openDevTools({ mode: 'detach' })
  })
}

// 桌面台球：球桌之外的地方一律点穿（窗口初始就是穿透的，页面把命中态报回来才吃鼠标）
ipcMain.on('arena:hit', (_e, hit) => {
  if (!alive('arena')) return
  try { win.arena.setIgnoreMouseEvents(!hit, { forward: true }) } catch {}
})
ipcMain.on('arena:exit', () => { if (alive('arena')) win.arena.close() })
ipcMain.on('billiard:close', () => { if (alive('small')) win.small.close() })
ipcMain.on('billiards:anims', (e) => { e.returnValue = ballAnims() })

function openSmall() {
  if (alive('small')) { win.small.show(); win.small.focus(); return }
  const area = screen.getPrimaryDisplay().workArea
  const width = Math.min(780, Math.round(area.width * 0.46))
  const height = Math.min(560, Math.round(area.height * 0.52))
  win.small = new BrowserWindow({
    width, height, useContentSize: true, title: '肥鱼台球',
    x: Math.round(area.x + area.width - width - 24), y: area.y + 24,
    backgroundColor: '#14301f', show: false, autoHideMenuBar: true,
    acceptFirstMouse: true, resizable: false, minWidth: 600, minHeight: 440,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, spellcheck: false,
      preload: path.join(__dirname, 'billiard-preload.js'),
    },
  })
  // 浮在别的窗口之上：球桌被工作窗盖住就没法玩了
  try { win.small.setAlwaysOnTop(true, 'floating') } catch {}
  // 后台节流必须关：窗口一旦被挡住，Chromium 把 rAF 降到 1fps，台球物理变慢动作
  try { win.small.webContents.setBackgroundThrottling(false) } catch {}
  win.small.once('ready-to-show', () => { try { win.small.show() } catch {} })
  win.small.on('closed', () => { win.small = null })
  bindDevtools(win.small)
  win.small.loadFile(path.join(__dirname, 'billiard.html'))
    .catch((e) => console.error('台球页加载失败：', e && e.message))
}

function openArena() {
  if (alive('arena')) { win.arena.show(); return }
  const area = screen.getPrimaryDisplay().workArea
  win.arena = new BrowserWindow({
    x: area.x, y: area.y, width: area.width, height: area.height,
    transparent: true, frame: false, hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: false, focusable: false,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'arena-preload.js'),
    },
  })
  win.arena.setAlwaysOnTop(true, 'screen-saver')
  try { win.arena.setIgnoreMouseEvents(true, { forward: true }) } catch {}
  try { win.arena.webContents.setBackgroundThrottling(false) } catch {}
  win.arena.once('ready-to-show', () => { try { win.arena.show() } catch {} })
  win.arena.on('closed', () => { win.arena = null })
  win.arena.loadFile(path.join(__dirname, 'arena.html'))
    .catch((e) => console.error('桌面台球加载失败：', e && e.message))
}

// 面板连点两次「打开」应该聚焦已有窗口，而不是再起一个 Electron（两副球桌会打起来）
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (MODE === 'arena') openArena(); else openSmall() })
  app.whenReady().then(() => { if (MODE === 'arena') openArena(); else openSmall() })
}
app.on('window-all-closed', () => app.quit())
