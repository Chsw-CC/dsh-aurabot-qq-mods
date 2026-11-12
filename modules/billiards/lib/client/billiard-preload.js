// 台球小窗的桥：关窗 + 一次性取球面动画地址。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('billiardBridge', {
  close: () => ipcRenderer.send('billiard:close'),
  // 开机问主进程要一次：anims.json 里的 file:/// 地址数组（没有素材包就是空数组）
  ballAnims: () => ipcRenderer.sendSync('billiards:anims') || [],
})
