// Stand-in for react-hot-toast (needs a DOM at import time); only used while bundling the fixtures.
const noop = () => {};
const toast = Object.assign(noop, { success: noop, error: noop, loading: noop, dismiss: noop });
module.exports = toast; module.exports.default = toast; module.exports.toast = toast; module.exports.Toaster = () => null;
