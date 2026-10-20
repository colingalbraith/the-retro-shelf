"use strict";
// Comparing version numbers the way releases are tagged: 0.3.1 < 0.4.0-beta.1 < 0.4.0-beta.2 < 0.4.0

function parts(v) {
  const s = String(v || "").trim().replace(/^v/, ""), i = s.indexOf("-");
  const nums = (i < 0 ? s : s.slice(0, i)).split(".").map(n => parseInt(n, 10) || 0);
  return { nums: [0, 1, 2].map(k => nums[k] || 0), pre: i < 0 ? [] : s.slice(i + 1).split(".") };
}

/** 1 when a is the later version, -1 when b is, 0 when they're the same */
function compare(a, b) {
  const x = parts(a), y = parts(b);
  for (let k = 0; k < 3; k++) if (x.nums[k] !== y.nums[k]) return x.nums[k] > y.nums[k] ? 1 : -1;
  // a test version comes before the release it leads up to
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let k = 0; k < Math.max(x.pre.length, y.pre.length); k++) {
    const p = x.pre[k], q = y.pre[k];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) { if (+p !== +q) return +p > +q ? 1 : -1; }
    else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p > q ? 1 : -1;
  }
  return 0;
}

/** a test version: 0.4.0-beta.1 */
const isTest = v => parts(v).pre.length > 0;

module.exports = { compare, isTest };
