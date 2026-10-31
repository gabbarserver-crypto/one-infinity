// src/lib/backStack.js
//
// One place that decides what the phone's Back button does, so it unwinds in
// order: the topmost open popup/window first, then (in the dealer portal) the
// current tab -> Dashboard, and only then does Back leave/minimize the app.
//
//  - pushBack(fn)      an open popup registers how to close itself (Modal does
//                      this automatically); returns an unregister function.
//  - setBackFallback   the page registers its "nothing is open" behaviour
//                      (e.g. go back to Dashboard). Return true when handled.
//  - handleBack()      called by the Android back button / browser Back.
//                      Returns true when something was handled.
const stack = [];
let fallback = null;

export function pushBack(fn) {
  const entry = { fn };
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

export function setBackFallback(fn) {
  fallback = fn;
  return () => { if (fallback === fn) fallback = null; };
}

export function handleBack() {
  const top = stack[stack.length - 1];
  if (top) {
    top.fn();
    return true;
  }
  return fallback ? Boolean(fallback()) : false;
}
