import { app, BrowserWindow, protocol, nativeImage } from 'electron';
// Synthetic pixels exercise the controlled protocol; no user screen is captured.
protocol.registerSchemesAsPrivileged([{ scheme: 'one-room-evidence', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.whenReady().then(async () => {
  const pixels = Buffer.alloc(320 * 200 * 4);
  for (let y = 0; y < 200; y++) for (let x = 0; x < 320; x++) {
    const index = (y * 320 + x) * 4, accent = x > 40 && x < 280 && y > 40 && y < 160;
    pixels[index] = accent ? 85 : 230; pixels[index + 1] = accent ? 125 : 235;
    pixels[index + 2] = accent ? 65 : 240; pixels[index + 3] = 255;
  }
  const png = nativeImage.createFromBitmap(pixels, { width: 320, height: 200 }).toPNG();
  for (let index = 0; index < pixels.length; index += 4) pixels[index] = 180;
  const alternate = nativeImage.createFromBitmap(pixels, { width: 320, height: 200 }).toPNG();
  const captures = new Map();
  protocol.handle('one-room-evidence', request => {
    if (!captures.has(request.url)) captures.set(request.url, captures.size % 2 ? alternate : png);
    return new globalThis.Response(captures.get(request.url), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
  });
  const window = new BrowserWindow({ width: 1440, height: 1000, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  await window.loadURL(process.env.ONE_ROOM_FIXTURE_URL);
});
app.on('window-all-closed', () => app.quit());
