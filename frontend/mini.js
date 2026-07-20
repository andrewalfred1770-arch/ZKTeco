import { app, BrowserWindow } from 'electron';

console.log("START");

app.whenReady().then(() => {
  console.log("READY");

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: true
  });

  win.loadURL("data:text/html,<h1>Hello</h1>");
});