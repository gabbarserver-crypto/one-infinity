import React, { useState, useEffect, useRef } from "react";

// A simple numeric PIN pad — length 4 or 6, shown as filled/empty dots,
// with an on-screen keypad (works on desktop too via real keyboard input,
// the keypad is just for touch devices).
export default function PinPad({ length = 4, onComplete, error, disabled }) {
  const [digits, setDigits] = useState([]);

  const push = (d) => {
    if (disabled || digits.length >= length) return;
    const next = [...digits, d];
    setDigits(next);
    if (next.length === length) {
      onComplete(next.join(""));
      setTimeout(() => setDigits([]), 400); // clear after the parent's had a chance to check it
    }
  };

  const backspace = () => setDigits((d) => d.slice(0, -1));

  // Real keyboard support (desktop / Bluetooth keyboards): 0-9 (top row and
  // numpad) and Backspace. A ref keeps the listener pointed at the latest
  // push/backspace without re-attaching it on every keystroke.
  const handlersRef = useRef({ push, backspace });
  handlersRef.current = { push, backspace };

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        handlersRef.current.push(e.key);
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        handlersRef.current.backspace();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div>
      <div className="flex justify-center gap-3 mb-6">
        {Array.from({ length }).map((_, i) => (
          <div
            key={i}
            className={`w-4 h-4 rounded-full border-2 ${
              i < digits.length ? "bg-blue-600 border-blue-600" : "border-slate-300"
            } ${error ? "!border-rose-500 !bg-rose-500" : ""}`}
          />
        ))}
      </div>
      {error && <p className="text-rose-500 text-xs text-center mb-4">{error}</p>}
      <div className="grid grid-cols-3 gap-3 max-w-[240px] mx-auto">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => push(d)}
            disabled={disabled}
            className="h-14 rounded-full bg-slate-100 hover:bg-slate-200 text-xl font-semibold text-slate-700 disabled:opacity-40"
          >
            {d}
          </button>
        ))}
        <div />
        <button
          type="button"
          onClick={() => push("0")}
          disabled={disabled}
          className="h-14 rounded-full bg-slate-100 hover:bg-slate-200 text-xl font-semibold text-slate-700 disabled:opacity-40"
        >
          0
        </button>
        <button
          type="button"
          onClick={backspace}
          disabled={disabled}
          className="h-14 rounded-full bg-slate-100 hover:bg-slate-200 text-sm font-semibold text-slate-500 disabled:opacity-40"
        >
          ⌫
        </button>
      </div>
    </div>
  );
}
