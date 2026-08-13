/**
 * AsyncLocalStorage so API call logging can attach the active ticker
 * without threading it through every HTTP helper.
 */
const { AsyncLocalStorage } = require("async_hooks");

const store = new AsyncLocalStorage();

function runWithCallContext(ctx, fn) {
  return store.run(ctx && typeof ctx === "object" ? ctx : {}, fn);
}

function getCallContext() {
  return store.getStore() || {};
}

function getCallContextTicker() {
  const t = getCallContext().ticker;
  return t ? String(t).toUpperCase() : null;
}

module.exports = {
  runWithCallContext,
  getCallContext,
  getCallContextTicker,
};
