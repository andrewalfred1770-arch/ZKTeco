// Minimal browser globals so the app's real modules (reportTemplate, SalaryCard, CompactSalarySheet) can be bundled and run under plain Node
// just to build HTML strings. Nothing here touches the network, a database or a device.
globalThis.window = globalThis;
globalThis.window.electron = undefined;
globalThis.location = { href: 'http://localhost/', origin: 'http://localhost', protocol: 'http:', host: 'localhost', hostname: 'localhost' };
globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
globalThis.sessionStorage = globalThis.localStorage;
